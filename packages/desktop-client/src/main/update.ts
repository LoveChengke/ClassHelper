import { app, type BrowserWindow } from 'electron';
import {
  GITHUB_RELEASES_LATEST_API,
  GITHUB_RELEASES_PAGE,
  UPDATE_CHECK_CACHE_TTL_MS,
  UPDATE_CHECK_TIMEOUT_MS,
  UPDATE_CHECK_USER_AGENT,
  isNewerVersion,
  normalizeVersion,
  type UpdateAssetDto,
  type UpdateInfo,
} from '@classhelper/shared';
import { getConfig, saveConfig } from './config.js';
import { logger } from './logger.js';

/**
 * 更新检查（桌面客户端）。
 *
 * **为什么在主进程做**：渲染进程通过 preload 能拿到 `getConfig()` 的明文 token（代表全班身份），
 * 它的 CSP 与导航防线是整个安全模型里最要紧的一层；让它额外去连一个外部域名、
 * 解析外部 JSON，等于把"外部数据"请进最有价值的那一侧。主进程本来就在做网络与文件，
 * 放这里也顺带复用 Node 的 fetch（无需额外依赖）。
 *
 * 与 Web 管理端的差别：Web 端受服务端 CSP 的 `connect-src` 限制，只能走 `/api/update/check` 转发；
 * 客户端没有这个限制，按用户选择**直连 GitHub**。两边归一化出的 `UpdateInfo` 结构一致。
 */

/** 主进程 → 渲染进程：发现新版本（渲染进程据此弹一次性提示） */
export const UPDATE_AVAILABLE_CHANNEL = 'classhelper:update:available';

/** 启动后多久自动查一次：等窗口与登录流程就绪，也不跟首屏请求抢带宽 */
const STARTUP_DELAY_MS = 5_000;

interface GithubReleasePayload {
  tag_name?: unknown;
  name?: unknown;
  published_at?: unknown;
  body?: unknown;
  html_url?: unknown;
  assets?: unknown;
}

let cache: { at: number; info: UpdateInfo } | null = null;
let startupTimer: ReturnType<typeof setTimeout> | null = null;
/** 冒烟断言用：启动自动检查是否被跳过（冒烟模式下必须是 true） */
let startupCheckSkipped = false;

/** 失败的统一出口：结构完整，界面不必做 null 判断 */
function failure(error: string): UpdateInfo {
  return {
    ok: false,
    error,
    currentVersion: app.getVersion(),
    latestVersion: null,
    hasUpdate: false,
    releaseUrl: GITHUB_RELEASES_PAGE,
    releaseName: null,
    publishedAt: null,
    notes: null,
    assets: [],
    checkedAt: new Date().toISOString(),
  };
}

function toAssets(raw: unknown): UpdateAssetDto[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => item as { name?: unknown; browser_download_url?: unknown; size?: unknown })
    .filter(
      (item): item is { name: string; browser_download_url: string; size?: unknown } =>
        typeof item.name === 'string' && typeof item.browser_download_url === 'string',
    )
    .map((item) => ({
      name: item.name,
      downloadUrl: item.browser_download_url,
      size: typeof item.size === 'number' && Number.isFinite(item.size) ? item.size : 0,
    }));
}

function toInfo(payload: GithubReleasePayload, currentVersion: string): UpdateInfo {
  const latestVersion = normalizeVersion(typeof payload.tag_name === 'string' ? payload.tag_name : '');
  if (!latestVersion) {
    logger.warn('更新检查：GitHub 返回的 Release 里没有可识别的 tag_name');
    return failure('GitHub 返回的版本号无法识别');
  }

  return {
    ok: true,
    error: null,
    currentVersion,
    latestVersion,
    hasUpdate: isNewerVersion(currentVersion, latestVersion),
    releaseUrl:
      typeof payload.html_url === 'string' && payload.html_url ? payload.html_url : GITHUB_RELEASES_PAGE,
    releaseName: typeof payload.name === 'string' ? payload.name : null,
    publishedAt: typeof payload.published_at === 'string' ? payload.published_at : null,
    notes: typeof payload.body === 'string' ? payload.body : null,
    assets: toAssets(payload.assets),
    checkedAt: new Date().toISOString(),
  };
}

/** 把各种失败翻译成一句用户能看懂的话（教室里最常见的就是"这台机器没有外网"） */
function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && error.name === 'TimeoutError') {
    return `连接 GitHub 超时（${UPDATE_CHECK_TIMEOUT_MS / 1000} 秒），本机可能没有外网`;
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|certificate|net::/i.test(message)) {
    return '无法连接 GitHub，本机可能没有外网';
  }
  return `检查更新失败：${message}`;
}

/**
 * 检查 GitHub 上有没有比本机新的版本（结果带缓存）。
 *
 * 缓存的意义：匿名调用 GitHub API 的限流是 60 次/小时/IP，而「关于」页的按钮可以随便点。
 * 失败结果同样进缓存 —— 否则离线时每点一次都要白等一个超时。
 */
export async function checkForUpdates(force = false): Promise<UpdateInfo> {
  const currentVersion = app.getVersion();
  const now = Date.now();
  if (!force && cache && now - cache.at < UPDATE_CHECK_CACHE_TTL_MS) {
    return cache.info;
  }

  let info: UpdateInfo;
  try {
    const response = await fetch(GITHUB_RELEASES_LATEST_API, {
      headers: {
        // GitHub API 强制要求 User-Agent，不带会直接 403
        'User-Agent': UPDATE_CHECK_USER_AGENT,
        Accept: 'application/vnd.github+json',
      },
      signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS),
    });

    if (!response.ok) {
      info =
        response.status === 403 || response.status === 429
          ? failure('GitHub 暂时拒绝了请求（匿名查询次数过多），请过一会儿再试')
          : failure(`GitHub 返回 HTTP ${response.status}`);
      logger.warn(`更新检查失败：HTTP ${response.status}（本机版本 ${currentVersion}）`);
    } else {
      info = toInfo((await response.json()) as GithubReleasePayload, currentVersion);
      logger.info(
        `更新检查：本机 ${currentVersion} / 最新 ${info.latestVersion ?? '-'}` +
          `${info.hasUpdate ? '（有新版本）' : '（已是最新）'}`,
      );
    }
  } catch (error) {
    info = failure(describeFailure(error));
    logger.warn(`更新检查失败：${info.error}（本机版本 ${currentVersion}）`);
  }

  cache = { at: now, info };
  return info;
}

/** 「知道了 / 忽略此版本」：记到配置里，同一个版本不再重复弹提示 */
export function ignoreUpdateVersion(version: string): void {
  const normalized = normalizeVersion(version);
  if (!normalized) return;
  saveConfig({ ignoredUpdateVersion: normalized });
  logger.info(`已忽略版本 ${normalized} 的更新提示`);
}

/** 该版本是否已被用户忽略 */
export function isUpdateIgnored(version: string): boolean {
  return normalizeVersion(getConfig().ignoredUpdateVersion) === normalizeVersion(version);
}

/**
 * 启动后的自动检查：延迟 `STARTUP_DELAY_MS` 查一次，有新版本（且没被忽略）就通知渲染进程弹提示。
 *
 * **冒烟模式直接跳过**：自动化验证不该每次都发真实网络请求（既抖动又依赖外网），
 * 而且凭空多出来的提示条会撞坏既有 UI 断言。冒烟用例改为直接调 IPC 验证返回结构。
 */
export function scheduleStartupUpdateCheck(getWindow: () => BrowserWindow | null): void {
  if (process.env.ELECTRON_SMOKE_TEST === '1') {
    startupCheckSkipped = true;
    logger.info('更新检查：冒烟模式下跳过启动自动检查');
    return;
  }
  if (startupTimer) clearTimeout(startupTimer);

  startupTimer = setTimeout(() => {
    startupTimer = null;
    void (async () => {
      try {
        const info = await checkForUpdates();
        if (!info.ok || !info.hasUpdate || !info.latestVersion) return;
        if (isUpdateIgnored(info.latestVersion)) {
          logger.info(`更新检查：${info.latestVersion} 已被用户忽略，本次不提示`);
          return;
        }
        const win = getWindow();
        if (!win || win.isDestroyed()) return;
        win.webContents.send(UPDATE_AVAILABLE_CHANNEL, info);
        logger.info(`更新检查：已提示新版本 ${info.latestVersion}`);
      } catch (error) {
        // 自动检查失败不该打扰用户（手动检查才需要看到原因）
        logger.warn(`启动自动检查更新失败：${error instanceof Error ? error.message : error}`);
      }
    })();
  }, STARTUP_DELAY_MS);
  // 不阻止进程退出：这个定时器只是"顺便查一下"
  startupTimer.unref?.();
}

/** 冒烟断言用：启动自动检查是否被跳过（冒烟模式下应为 true —— 否则每次验证都会发真实网络请求） */
export function wasStartupCheckSkipped(): boolean {
  return startupCheckSkipped;
}
