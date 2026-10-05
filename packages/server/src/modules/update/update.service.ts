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
import { logger } from '../../lib/logger.js';
import { APP_VERSION } from '../../lib/version.js';

/**
 * 更新检查：问 GitHub 上最新的 Release 是不是比本机新。
 *
 * 三个设计约束：
 * 1. **失败是常态，不是异常**：学校的服务器常常在只有内网的机房网络里，
 *    因此离线 / 限流 / 超时一律收敛成 `ok:false` + 一句人话，绝不抛给路由层（否则管理员看到的会是 500）。
 * 2. **必须带 User-Agent**：GitHub API 对没有 UA 的请求直接 403。
 * 3. **必须有缓存**：匿名调用限流是 60 次/小时/IP，而 Web 管理端每次打开弹窗都会问一次。
 *
 * 这里用 Node 内置的 `fetch`（Node 20+ / Electron 同源），不引入任何 HTTP 依赖 ——
 * 这也是本服务端**唯一**的出网请求。
 */

/** GitHub Releases API 里我们真正用到的字段（其余忽略，避免把整个响应建模一遍） */
interface GithubReleasePayload {
  tag_name?: unknown;
  name?: unknown;
  published_at?: unknown;
  body?: unknown;
  html_url?: unknown;
  assets?: unknown;
}

let cache: { at: number; info: UpdateInfo } | null = null;

/** 失败的统一出口：结构完整，界面不必做 null 判断 */
function failure(error: string): UpdateInfo {
  return {
    ok: false,
    error,
    currentVersion: APP_VERSION,
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

function toInfo(payload: GithubReleasePayload): UpdateInfo {
  const latestVersion = normalizeVersion(typeof payload.tag_name === 'string' ? payload.tag_name : '');
  // 拿不到版本号就当"查不到"，不要伪造一个 latestVersion 出来
  if (!latestVersion) {
    logger.warn('更新检查：GitHub 返回的 Release 里没有可识别的 tag_name');
    return failure('GitHub 返回的版本号无法识别');
  }

  return {
    ok: true,
    error: null,
    currentVersion: APP_VERSION,
    latestVersion,
    hasUpdate: isNewerVersion(APP_VERSION, latestVersion),
    // 优先用 Release 自己的 html_url，拿不到才回落到列表页
    releaseUrl:
      typeof payload.html_url === 'string' && payload.html_url ? payload.html_url : GITHUB_RELEASES_PAGE,
    releaseName: typeof payload.name === 'string' ? payload.name : null,
    publishedAt: typeof payload.published_at === 'string' ? payload.published_at : null,
    notes: typeof payload.body === 'string' ? payload.body : null,
    assets: toAssets(payload.assets),
    checkedAt: new Date().toISOString(),
  };
}

/** 把各种失败翻译成一句管理员能看懂的话 */
function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && error.name === 'TimeoutError') {
    return `连接 GitHub 超时（${UPDATE_CHECK_TIMEOUT_MS / 1000} 秒），本机可能没有外网`;
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|certificate/i.test(message)) {
    return '无法连接 GitHub，本机可能没有外网';
  }
  return `检查更新失败：${message}`;
}

/**
 * 检查更新（结果带缓存）。
 *
 * @param options.force 绕过缓存（由路由层限定为管理员才能生效）
 */
export async function checkForUpdates(options: { force?: boolean } = {}): Promise<UpdateInfo> {
  const now = Date.now();
  if (!options.force && cache && now - cache.at < UPDATE_CHECK_CACHE_TTL_MS) {
    return cache.info;
  }

  let info: UpdateInfo;
  try {
    const response = await fetch(GITHUB_RELEASES_LATEST_API, {
      headers: {
        'User-Agent': UPDATE_CHECK_USER_AGENT,
        Accept: 'application/vnd.github+json',
      },
      signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS),
    });

    if (!response.ok) {
      // 403 / 429 基本都是匿名限流（60 次/小时/IP）—— 给出可操作的提示而不是原始状态码
      info =
        response.status === 403 || response.status === 429
          ? failure('GitHub 暂时拒绝了请求（匿名查询次数过多），请过一会儿再试')
          : failure(`GitHub 返回 HTTP ${response.status}`);
      logger.warn(`更新检查失败：HTTP ${response.status}（本机版本 ${APP_VERSION}）`);
    } else {
      info = toInfo((await response.json()) as GithubReleasePayload);
      logger.info(
        `更新检查：本机 ${APP_VERSION} / 最新 ${info.latestVersion ?? '-'}` +
          `${info.hasUpdate ? '（有新版本）' : '（已是最新）'}`,
      );
    }
  } catch (error) {
    info = failure(describeFailure(error));
    logger.warn(`更新检查失败：${info.error}（本机版本 ${APP_VERSION}）`);
  }

  // 失败结果**也缓存**：否则机房断网时，管理员每点一次按钮都要白等一个超时。
  cache = { at: now, info };
  return info;
}
