import type { ReleaseProgressDto as ContractReleaseProgressDto } from '@classhelper/shared';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { BrowserWindow, app } from 'electron';
import {
  isNewerVersion,
  CLIENT_UPDATE_IDLE_MS,
  type ClientHeartbeatResponse,
  type ClientUpdateInfoDto,
} from '@classhelper/shared';
import { getConfig, saveConfig } from './config.js';
import { island } from './island.js';
import { logger } from './logger.js';

/**
 * 服务端统一下发的自动更新（下载 + 空闲时静默安装）。
 *
 * 设计要点（都是"教室机器"这个使用场景逼出来的）：
 * 1. **下载随时进行，按下发策略安装**：立即安装；放学后到指定时刻且不在上课时安装；
 *    空闲安装要求不在上课且主窗口隐藏满五分钟；
 * 2. **下完先校验 sha256**：服务端给的哈希对不上就删掉文件、记 error，**不做任何信任放行**
 *    （宁可这次更新失败，也不能把一个来源不明的 exe 装到教室里）；
 * 3. **安装脚本脱离本进程**：PowerShell 等旧进程退出、安装器完成后重新拉起应用，
 *    本进程随即走既有退出路径退出（重启应用这件事交给安装脚本，而不是自己 `relaunch`，
 *    否则会与"安装器正在覆盖自己"撞车 —— Windows 上正在运行的程序文件是删不掉的）。
 */

let policy: Pick<ClientHeartbeatResponse, 'updateTargetVersion' | 'updateMode' | 'updateNotBefore'> | null =
  null;
function policyPath(): string {
  return path.join(pendingUpdateDir(), 'policy.json');
}
function loadPolicy(): typeof policy {
  if (policy) return policy;
  try {
    policy = JSON.parse(fs.readFileSync(policyPath(), 'utf8'));
  } catch {
    /* 尚无下发策略 */
  }
  return policy;
}

/** 更新包只来自专用目录；清理与执行均不得接受目录外的配置路径。 */
function isManagedInstaller(file: string): boolean {
  return path.dirname(path.resolve(file)) === path.resolve(pendingUpdateDir()) && /\.exe$/i.test(file);
}
function removeManagedInstaller(file: string): void {
  if (!file || !isManagedInstaller(file)) return;
  try {
    fs.rmSync(file, { force: true });
  } catch (error) {
    logger.warn(`清理旧更新包失败：${String(error)}`);
  }
}

/** 每次成功心跳先同步策略；取消或更换目标后旧包不得自行安装。 */
export function syncUpdatePolicy(next: ClientHeartbeatResponse): void {
  policy = {
    updateTargetVersion: next.updateTargetVersion,
    updateMode: next.updateMode ?? 'idle',
    updateNotBefore: next.updateNotBefore ?? null,
  };
  fs.mkdirSync(pendingUpdateDir(), { recursive: true });
  fs.writeFileSync(policyPath(), JSON.stringify(policy), 'utf8');
  if (getConfig().pendingUpdateVersion !== (next.updateTargetVersion ?? '')) {
    removeManagedInstaller(getConfig().pendingUpdateFile);
    saveConfig({ pendingUpdateVersion: '', pendingUpdateFile: '' });
  }
}

/** 单个安装包的下载超时：教室机网络慢，给足 10 分钟 */
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

/** 下载文件名的合法性（服务端给的 fileName 会拼进本地路径，必须挡住路径穿越） */
const SAFE_FILE_NAME = /^[A-Za-z0-9._-]+$/;

/** 待安装更新的目录：`<userData>/updates`（放在 userData 下，随配置一起被卸载/重置清掉） */
export function pendingUpdateDir(): string {
  return path.join(app.getPath('userData'), 'updates');
}

/** 主窗口"已隐藏多久"的起点（null = 窗口当前可见或还没建） */
let mainWindowHiddenAt: number | null = null;
/** 本进程是否已经发起过安装（防止心跳与 hide 事件重复触发） */
let installing = false;
let updateProgress: ContractReleaseProgressDto = {
  version: '',
  stage: 'idle',
  downloadedBytes: 0,
  totalBytes: 0,
  percent: null,
  error: '',
};
export function getUpdateProgress() {
  return { ...updateProgress };
}
let progressPublishedAt = 0;
function publishProgress(patch: Partial<typeof updateProgress>) {
  const previousStage = updateProgress.stage;
  updateProgress = { ...updateProgress, ...patch };
  updateProgress.percent = updateProgress.totalBytes
    ? Math.min(100, Math.round((updateProgress.downloadedBytes / updateProgress.totalBytes) * 100))
    : null;
  if (previousStage === updateProgress.stage && Date.now() - progressPublishedAt < 250) return;
  progressPublishedAt = Date.now();
  for (const win of BrowserWindow.getAllWindows())
    if (!win.isDestroyed()) win.webContents.send('client:update-progress', getUpdateProgress());
}
/**
 * 退出本进程的回调（由 index.ts 注册成既有的 `quitApp()`）。
 *
 * 为什么用注册而不是直接 `import { quitApp } from './index.js'`：那会形成
 * index.ts ⇄ auto-update.ts 的循环导入，ESM 下 `quitApp` 的绑定在求值顺序变化时会变成未初始化引用。
 */
let quitHandler: (() => void) | null = null;

/** 注册"安装前退出本进程"的回调（index.ts 启动时调用一次） */
export function setQuitHandler(handler: () => void): void {
  quitHandler = handler;
}
/** 正在下载的版本（同一版本不并发下载） */
const downloading = new Set<string>();

/** 这次运行的主窗口（安装判定要看它可见性；窗口重建后重新挂一遍） */
let hookedWindow: BrowserWindow | null = null;

/**
 * 挂主窗口的显示/隐藏监听（index.ts 在 `createWindow()` 之后调用）。
 *
 * 为什么要"记时间戳"而不是每次现算：`BrowserWindow` 没有"隐藏了多久"这种查询，
 * 而「窗口隐藏满 5 分钟」是本功能的核心判据，只能在 hide/show 事件上自己打点。
 */
export function watchMainWindow(win: BrowserWindow): void {
  if (hookedWindow === win) return;
  hookedWindow = win;
  win.on('hide', () => {
    if (mainWindowHiddenAt === null) mainWindowHiddenAt = Date.now();
    // 刚隐藏正是最合适的安装时机（人已经走了），立即判一次
    void maybeInstallPendingUpdate();
  });
  win.on('show', () => {
    mainWindowHiddenAt = null;
  });
  win.on('closed', () => {
    mainWindowHiddenAt = null;
    if (hookedWindow === win) hookedWindow = null;
  });
  mainWindowHiddenAt = win.isVisible() ? null : Date.now();
}

/** 主窗口是否已经隐藏满 `CLIENT_UPDATE_IDLE_MS` */
function mainWindowIdleLongEnough(): boolean {
  if (mainWindowHiddenAt === null) return false;
  return Date.now() - mainWindowHiddenAt >= CLIENT_UPDATE_IDLE_MS;
}

/** 主窗口是否可见（空闲判定的一部分：可见 ⇒ 有人在用，绝不重启） */
function mainWindowVisible(): boolean {
  if (hookedWindow && !hookedWindow.isDestroyed()) return hookedWindow.isVisible();
  return BrowserWindow.getAllWindows().some((win) => !win.isDestroyed() && win.isVisible());
}

/** 服务端是否要求升级 / 本机是否确实更旧 */
export function shouldConsider(version: string): boolean {
  return getConfig().autoUpdate !== false && !!version.trim();
}

/**
 * 处理一次服务端下发的更新信息：该下就下、下好了就写进待安装配置。
 *
 * - `autoUpdate === false`：用户/管理员关掉了自动更新，直接返回（设置页会显示服务端的目标版本，由人工处理）；
 * - 同一版本已经下载过（`pendingUpdateVersion` 命中且文件还在）：跳过下载，直接尝试安装。
 */
export async function considerUpdate(info: ClientUpdateInfoDto, targetVersion: string): Promise<void> {
  const version = targetVersion.trim() || info.version.trim();
  if (!shouldConsider(version)) {
    logger.info(`忽略服务端下发的更新 ${version || '（未指定版本）'}：自动更新已在设置中关闭`);
    return;
  }
  if (downloading.has(version)) {
    logger.debug(`更新 ${version} 正在下载中，跳过重复请求`);
    return;
  }

  const config = getConfig();
  if (config.pendingUpdateVersion === version) {
    const existing = config.pendingUpdateFile;
    if (existing && fs.existsSync(existing)) {
      logger.info(`更新 ${version} 早已下载完成，直接尝试安装`);
      await maybeInstallPendingUpdate();
      return;
    }
    logger.warn(`更新 ${version} 的安装包已不在磁盘上（${existing || '未记录路径'}），重新下载`);
  }

  if (!SAFE_FILE_NAME.test(info.fileName)) {
    logger.error(`拒绝下载更新：服务端给的文件名不合法（${info.fileName}）`);
    return;
  }

  const dir = pendingUpdateDir();
  const target = path.join(dir, info.fileName);
  const temp = `${target}.part`;
  const token = config.token?.trim() ?? '';
  if (!token) {
    logger.warn(`暂不下载更新 ${version}：尚未登录（没有可用的下载令牌）`);
    return;
  }

  downloading.add(version);
  publishProgress({ version, stage: 'downloading', downloadedBytes: 0, totalBytes: info.size, error: '' });
  const startedAt = Date.now();
  try {
    fs.mkdirSync(dir, { recursive: true });
    // 先删掉上次中断留下的临时文件
    await fsp.rm(temp, { force: true });

    const url = `${config.serverUrl}${info.url}`;
    logger.info(`开始下载更新 ${version}（${info.fileName}，${formatSize(info.size)}）`);
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`下载失败：HTTP ${response.status}`);
    }
    if (!response.body) {
      throw new Error('下载失败：响应没有内容');
    }

    // 流式写盘：教室机的安装包几十 MB，不能整个读进内存
    const handle = await fsp.open(temp, 'w');
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        await handle.write(chunk);
        publishProgress({ downloadedBytes: updateProgress.downloadedBytes + chunk.byteLength });
      }
    } finally {
      await handle.close();
    }

    publishProgress({ stage: 'verifying' });
    const digest = await sha256File(temp);
    const expected = info.sha256.trim().toLowerCase();
    if (!expected) {
      // 服务端没给哈希就没法校验：宁可不装，也不留一个来源不明的安装包在磁盘上
      await fsp.rm(temp, { force: true });
      publishProgress({ stage: 'failed', error: '服务端未提供 sha256，拒绝更新' });
      logger.error(`更新 ${version} 的安装包没有提供 sha256，已删除（不做信任放行）`);
      return;
    }
    if (digest !== expected) {
      publishProgress({ stage: 'failed', error: '安装包 sha256 校验失败' });
      await fsp.rm(temp, { force: true });
      logger.error(
        `更新 ${version} 的安装包校验失败（sha256 不符），已删除：期望 ${expected}，实际 ${digest}`,
      );
      return;
    }

    await fsp.rm(target, { force: true });
    await fsp.rename(temp, target);
    publishProgress({ stage: 'waiting' });
    if (loadPolicy()?.updateTargetVersion !== version) {
      removeManagedInstaller(target);
      return;
    }
    saveConfig({ pendingUpdateVersion: version, pendingUpdateFile: target });
    logger.info(
      `更新 ${version} 已下载并校验通过（${formatSize(fs.statSync(target).size)}，耗时 ${Math.round(
        (Date.now() - startedAt) / 1000,
      )} 秒），将按服务端指定的时机安装`,
    );
    await maybeInstallPendingUpdate();
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => undefined);
    publishProgress({ stage: 'failed', error: String(error) });
    logger.error(`下载更新 ${version} 失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    downloading.delete(version);
  }
}

/** 文件的 sha256（十六进制小写） */
async function sha256File(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const handle = await fsp.open(file, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 256);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead <= 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

/** 人类可读的字节数（日志与界面提示用） */
function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '大小未知';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 如果条件全部满足就装更新。
 *
 * 非冒烟模式、有有效目标与安装包且自动更新开启；其余条件按安装策略判断。
 * 每次心跳后与主窗口隐藏后都会调用。
 */
export async function maybeInstallPendingUpdate(): Promise<void> {
  const courseware = island.getCoursewareTransfer();
  if (courseware && ['downloading', 'verifying'].includes(courseware.stage)) return;
  if (installing) return;
  if (process.env.ELECTRON_SMOKE_TEST === '1') return;

  const config = getConfig();
  const version = config.pendingUpdateVersion?.trim() ?? '';
  const installer = config.pendingUpdateFile?.trim() ?? '';
  if (!version || !installer || config.autoUpdate === false || !config.token) return;
  if (!isNewerVersion(app.getVersion(), version)) {
    removeManagedInstaller(installer);
    saveConfig({ pendingUpdateVersion: '', pendingUpdateFile: '' });
    return;
  }
  const active = loadPolicy();
  if (!active || active.updateTargetVersion !== version) return;
  if (active.updateMode === 'after-school') {
    const at = Date.parse(active.updateNotBefore ?? '');
    if (!Number.isFinite(at) || Date.now() < at) return;
  }
  if (!fs.existsSync(installer)) {
    logger.warn(`待安装的更新 ${version} 已不存在（${installer}），清除待安装记录`);
    saveConfig({ pendingUpdateVersion: '', pendingUpdateFile: '' });
    return;
  }
  if (
    !isManagedInstaller(installer) ||
    path.dirname(fs.realpathSync(installer)) !== fs.realpathSync(pendingUpdateDir())
  ) {
    logger.error('拒绝执行更新目录之外的安装文件');
    saveConfig({ pendingUpdateVersion: '', pendingUpdateFile: '' });
    return;
  }
  if (active.updateMode !== 'immediate' && island.getState().inClass) {
    logger.info(`更新 ${version} 已就绪，但正在上课，暂不安装`);
    return;
  }
  if (active.updateMode === 'idle' && mainWindowVisible()) {
    logger.debug(`更新 ${version} 已就绪，但主窗口可见（人正在用），暂不安装`);
    return;
  }
  if (active.updateMode === 'idle' && !mainWindowIdleLongEnough()) {
    const waited = mainWindowHiddenAt === null ? 0 : Math.round((Date.now() - mainWindowHiddenAt) / 1000);
    logger.debug(
      `更新 ${version} 已就绪，但主窗口隐藏仅 ${waited} 秒` +
        `（需满 ${Math.round(CLIENT_UPDATE_IDLE_MS / 1000)} 秒），暂不安装`,
    );
    return;
  }

  if (process.platform !== 'win32') {
    // 本项目客户端只发 Windows 版；其它平台（开发机上跑 Linux/macOS）只记日志
    logger.warn(
      `更新 ${version} 已就绪，但当前平台（${process.platform}）不支持静默安装，请手动运行：${installer}`,
    );
    return;
  }

  installing = true;
  publishProgress({ stage: 'installing' });
  logger.info(`开始静默安装更新 ${version}：${installer}`);
  try {
    const exe = app.getPath('exe');
    const quote = (value: string): string => "'" + value.replaceAll("'", "''") + "'";
    const script =
      `$ErrorActionPreference = 'Stop'; Wait-Process -Id ${process.pid} -ErrorAction SilentlyContinue; ` +
      `$installer = Start-Process -FilePath ${quote(installer)} -ArgumentList '/S','--updated','--force-run' -Wait -PassThru; ` +
      `if ($installer.ExitCode -ne 0 -and (Test-Path -LiteralPath ${quote(exe)})) { Start-Process -FilePath ${quote(exe)} }`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
      {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
    // 安装器从实际安装目录启动新版；免安装版的旧 exe 可能随退出消失，只在安装失败时尝试恢复它。
    if (quitHandler) {
      quitHandler();
    } else {
      logger.warn('没有注册退出回调，改为自行退出（配置会在退出前同步落盘）');
      app.quit();
    }
  } catch (error) {
    installing = false;
    logger.error(
      `启动更新安装失败（将在下次满足安装条件时重试）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** 仅供冒烟/自检使用：当前是否处于"窗口已隐藏满 5 分钟"状态 */
export function isMainWindowIdleLongEnough(): boolean {
  return mainWindowIdleLongEnough();
}
