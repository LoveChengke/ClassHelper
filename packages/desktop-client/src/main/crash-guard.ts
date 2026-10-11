import { app, type BrowserWindow, type RenderProcessGoneDetails } from 'electron';
import { logger } from './logger.js';

/**
 * 崩溃自愈（主窗口）。
 *
 * 教室机的运行环境很不友好：显卡驱动老旧、长期不重启、内存被其它教学软件挤占 ——
 * 渲染进程偶发崩溃与无响应是常态。原先这种情况表现为"窗口还在、一片空白、点哪都没反应"，
 * 只能人工去重启，因此这里补三条自愈路径：
 *
 * 1. `render-process-gone` —— 渲染进程没了（崩溃 / 被杀），**静默重建窗口**；
 * 2. `unresponsive` —— 界面卡住超过 10 秒还没缓过来，同样重建；期间恢复（`responsive`）就取消；
 * 3. `uncaughtException` / `unhandledRejection` —— 主进程的未捕获错误，
 *    记完整堆栈，并且**只有在本机确认空闲时**才重启自己。
 *
 * 两条限流（照抄灵动岛 supervisor 的口径，避免"崩溃 → 重建 → 立刻又崩"死循环刷日志）：
 * **10 分钟内最多 3 次**，超了只记日志、停下来等人工处理。
 * 另外**冒烟模式下绝不 `app.relaunch()`**：验证实例重启自己会让父进程拿到一个莫名其妙的子进程。
 */

/** 限流：窗口内最多几次 */
const RECOVER_MAX_TIMES = 3;
/** 限流窗口：10 分钟 */
const RECOVER_WINDOW_MS = 10 * 60_000;
/** 界面无响应多久算卡死（Electron 的 `unresponsive` 事件不会再给第二次机会） */
const UNRESPONSIVE_GRACE_MS = 10_000;

export interface CrashGuardOptions {
  /** 销毁并重建主窗口（index.ts 里复用原有的"建窗 + 载入界面"逻辑） */
  recoverMainWindow: () => void;
  /** 本机是否空闲（不在上课且主窗口不可见）—— 决定主进程崩溃后能不能自动重启 */
  isIdle: () => boolean;
  /** 退出应用（复用既有的退出路径，保证配置落盘） */
  quitApp: () => void;
}

const windowRecoverAt: number[] = [];
const restartAt: number[] = [];
let unresponsiveTimer: ReturnType<typeof setTimeout> | null = null;
/** 正在重建：重建过程中窗口又会发 `closed` / `destroyed`，不能再触发一次 */
let recovering = false;
/** 当前主窗口（重建后会换成新实例） */
let mainWindow: BrowserWindow | null = null;
/** install 时拿到的回调集合（事件回调里复用） */
let options: CrashGuardOptions | null = null;

/**
 * 安装崩溃自愈（在 `app.whenReady()` 里、主窗口建好之后调用一次）。
 */
export function installCrashGuard(guard: CrashGuardOptions): void {
  options = guard;

  app.on('render-process-gone', (_event, contents, details: RenderProcessGoneDetails) => {
    // 灵动岛窗口有自己的 supervisor（island.ts），这里只管主窗口
    if (!isMainWindowContents(contents.id)) return;
    logger.error(
      `主窗口渲染进程异常退出：reason=${details.reason} exitCode=${details.exitCode}（准备重建窗口）`,
    );
    recoverWindow(`渲染进程退出（${details.reason}）`);
  });

  app.on('child-process-gone', (_event, details) => {
    logger.error(
      `子进程异常退出：type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`,
    );
  });

  process.on('uncaughtException', (error) => {
    logger.error('主进程未捕获异常：', error);
    restartIfIdle('uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('主进程未处理的 Promise 拒绝：', reason);
    restartIfIdle('unhandledRejection');
  });
}

/**
 * 记录当前主窗口并挂上无响应监听。
 * `createWindow()` 之后调用；窗口重建后要重新调用一次（新实例、新监听）。
 */
export function watchMainWindow(win: BrowserWindow): void {
  mainWindow = win;
  win.on('unresponsive', () => {
    logger.error('主窗口界面无响应（10 秒内未恢复将重建窗口）');
    armUnresponsiveTimer();
  });
  win.on('responsive', () => {
    if (unresponsiveTimer !== null) {
      clearTimeout(unresponsiveTimer);
      unresponsiveTimer = null;
      logger.info('主窗口界面已恢复响应，取消重建');
    }
  });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
    if (unresponsiveTimer !== null) {
      clearTimeout(unresponsiveTimer);
      unresponsiveTimer = null;
    }
  });
}

function armUnresponsiveTimer(): void {
  if (unresponsiveTimer !== null) clearTimeout(unresponsiveTimer);
  unresponsiveTimer = setTimeout(() => {
    unresponsiveTimer = null;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    recoverWindow('界面无响应超过 10 秒');
  }, UNRESPONSIVE_GRACE_MS);
}

function isMainWindowContents(id: number): boolean {
  // 主窗口引用还没建立（启动早期）时按"就是它"处理，避免漏掉重建
  if (!mainWindow || mainWindow.isDestroyed()) return true;
  return mainWindow.webContents.id === id;
}

/** 静默重建主窗口（限流） */
function recoverWindow(reason: string): void {
  const recover = options?.recoverMainWindow;
  if (recovering) return;
  if (!recover) {
    logger.error(`主窗口需要重建（${reason}），但没有可用的重建回调`);
    return;
  }
  const now = Date.now();
  while (windowRecoverAt.length > 0 && now - windowRecoverAt[0] > RECOVER_WINDOW_MS) {
    windowRecoverAt.shift();
  }
  if (windowRecoverAt.length >= RECOVER_MAX_TIMES) {
    logger.error(
      `主窗口在 ${RECOVER_WINDOW_MS / 60_000} 分钟内已重建 ${RECOVER_MAX_TIMES} 次，停止自动重建（${reason}）` +
        '：请检查显卡驱动或教学软件冲突后手动重启应用',
    );
    return;
  }
  windowRecoverAt.push(now);
  recovering = true;
  try {
    const win = mainWindow;
    if (win && !win.isDestroyed()) {
      // 先隐藏再销毁：跟灵动岛的 supervisor 一样，避免留住一帧残影/白屏
      win.hide();
    }
    logger.warn(`开始重建主窗口（${reason}，本窗口期第 ${windowRecoverAt.length} 次）`);
    recover();
  } catch (error) {
    logger.error(`重建主窗口失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    recovering = false;
  }
}

/** 主进程崩溃后按需重启自己（限流 + 空闲判定 + 冒烟豁免） */
function restartIfIdle(reason: string): void {
  if (process.env.ELECTRON_SMOKE_TEST === '1') {
    // 冒烟模式只记日志：验证实例重启自己会污染验证结果
    logger.warn(`冒烟模式：不因 ${reason} 重启应用（仅记录日志）`);
    return;
  }
  let idle = false;
  try {
    idle = options?.isIdle() === true;
  } catch (error) {
    logger.error(`判断本机是否空闲时出错：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!idle) {
    logger.warn(`本机正在使用中（${reason}），不自动重启应用，以免打断课堂`);
    return;
  }
  const now = Date.now();
  while (restartAt.length > 0 && now - restartAt[0] > RECOVER_WINDOW_MS) {
    restartAt.shift();
  }
  if (restartAt.length >= RECOVER_MAX_TIMES) {
    logger.error(
      `应用在 ${RECOVER_WINDOW_MS / 60_000} 分钟内已自动重启 ${RECOVER_MAX_TIMES} 次，停止自动重启（${reason}）`,
    );
    return;
  }
  restartAt.push(now);
  logger.warn(`本机空闲，因 ${reason} 自动重启应用（本窗口期第 ${restartAt.length} 次）`);
  app.relaunch();
  options?.quitApp();
}
