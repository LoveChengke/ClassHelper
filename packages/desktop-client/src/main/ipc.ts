import { app, BrowserWindow, ipcMain, shell } from 'electron';
import type { UpdateInfo } from '@classhelper/shared';
import { IPC_CHANNELS } from './channels.js';
import { beatNow, getClientAgentStatus } from './client-agent.js';
import { clearConfig, getConfig, getConfigPath, saveConfig } from './config.js';
import { logger } from './logger.js';
import { checkForUpdates, ignoreUpdateVersion } from './update.js';
import type { DesktopAppInfo, DesktopStoredConfig } from '../types/desktop.js';

// 通道名定义搬到了叶子模块 `channels.ts`（原因见那里的注释：preload 在沙箱里不能碰 node 内建模块）；
// 这里原样再导出，保持既有 `import { IPC_CHANNELS } from './ipc.js'` 的调用点不变。
export { IPC_CHANNELS };

export function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.getConfig, (): DesktopStoredConfig => getConfig());

  ipcMain.handle(
    IPC_CHANNELS.saveConfig,
    (_event, patch: Partial<DesktopStoredConfig>): DesktopStoredConfig => {
      // 更新安装记录只允许主进程内部写入，渲染进程不得借配置通道指定可执行文件。
      const allowed = { ...patch };
      delete allowed.pendingUpdateFile;
      delete allowed.pendingUpdateVersion;
      return saveConfig(allowed);
    },
  );

  ipcMain.handle(IPC_CHANNELS.clearConfig, (): DesktopStoredConfig => clearConfig());

  ipcMain.handle(IPC_CHANNELS.appInfo, (): DesktopAppInfo => ({
    appVersion: app.getVersion(),
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node ?? '',
    platform: `${process.platform} ${process.arch}`,
    userDataPath: app.getPath('userData'),
    configPath: getConfigPath(),
    smokeTest: process.env.ELECTRON_SMOKE_TEST === '1',
  }));

  ipcMain.handle(IPC_CHANNELS.openExternal, async (_event, url: string): Promise<boolean> => {
    if (!/^https?:\/\//i.test(url)) return false;
    await shell.openExternal(url);
    return true;
  });

  /**
   * 检查更新（走主进程直连 GitHub，见 main/update.ts 的说明）。
   *
   * `force` 为 true 时绕过主进程缓存 —— 对应「关于」页里用户主动点的那次检查；
   * 启动自动检查一律用缓存（避免同一分钟内重复请求打满匿名限流）。
   */
  ipcMain.handle(IPC_CHANNELS.updateCheck, (_event, force?: boolean): Promise<UpdateInfo> => {
    return checkForUpdates(force === true);
  });

  /** 忽略某个版本的更新提示（记入 config.json，启动自动检查不再提示它） */
  ipcMain.handle(IPC_CHANNELS.updateIgnore, (_event, version: string): void => {
    if (typeof version === 'string') ignoreUpdateVersion(version);
  });

  /** 开机自启：读的是系统登录项，不是配置文件里的值（两者可能被外部改过） */
  ipcMain.handle(IPC_CHANNELS.getAutoLaunch, (): boolean => {
    try {
      return app.getLoginItemSettings().openAtLogin === true;
    } catch {
      return getConfig().autoLaunch === true;
    }
  });

  /**
   * 开机自启：写配置 + 同步系统登录项。
   *
   * 与 `main/index.ts` 的 `applyAutoLaunch()` 同一套参数（`--hidden` 是"登录后不弹主窗口"的实现方式，
   * 因为 Electron 44 在 Windows 上没有 `openAsHidden`），返回**系统实际生效**的值。
   */
  ipcMain.handle(IPC_CHANNELS.setAutoLaunch, (_event, enabled: boolean): boolean => {
    const wanted = enabled === true;
    saveConfig({ autoLaunch: wanted });
    try {
      app.setLoginItemSettings({
        openAtLogin: wanted,
        path: process.execPath,
        args: wanted ? ['--hidden'] : [],
      });
      return app.getLoginItemSettings().openAtLogin === true;
    } catch (error) {
      logger.warn(
        `写入开机自启失败（配置已保存，下次启动会重试）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return wanted;
    }
  });

  /** 打开日志目录（设置页「打开日志目录」；日志文件是 main.log，见 main/logger.ts） */
  ipcMain.handle(IPC_CHANNELS.openLogDir, async (): Promise<boolean> => {
    try {
      const message = await shell.openPath(app.getPath('logs'));
      if (message) {
        logger.warn(`打开日志目录失败：${message}`);
        return false;
      }
      return true;
    } catch (error) {
      logger.warn(`打开日志目录失败：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  });

  /**
   * 打开开发者工具（「开发者」页的按钮；detached 独立窗口）。
   *
   * 两处刻意的限制：
   * - **冒烟模式下直接拒绝**。冒烟验证会给窗口注入合成事件、测量侧栏几何、整屏截图取样；
   *   多出一个 DevTools 窗口会抢焦点、并且 detached 窗口会改变 `capturePage()` 的取样范围，
   *   把既有断言打乱。返回 false 让页面提示"冒烟模式下不可用"。
   * - 窗口取自 `event.sender` 而不是模块级变量：IPC 只可能由主窗口（或无关的岛窗口）发起，
   *   按发送方取窗口既不需要在 ipc.ts 里持有 mainWindow 引用（避免与 main/index.ts 循环依赖），
   *   也保证打开的是**发起调用的那个窗口**的 DevTools。
   */
  ipcMain.handle(IPC_CHANNELS.openDevTools, (event): boolean => {
    if (process.env.ELECTRON_SMOKE_TEST === '1') {
      logger.warn('冒烟验证模式下不允许打开开发者工具（会打乱焦点与截图断言）');
      return false;
    }
    const target = BrowserWindow.fromWebContents(event.sender);
    if (!target || target.isDestroyed()) return false;
    target.webContents.openDevTools({ mode: 'detach' });
    return true;
  });

  /** 服务端联动状态（纯数据：跨 contextBridge 只能传普通对象，见 AGENTS.md §5 第 9 条） */
  ipcMain.handle(IPC_CHANNELS.clientStatus, () => getClientAgentStatus());

  /** 立即上报一次（设置页「立即上报」按钮） */
  ipcMain.handle(IPC_CHANNELS.clientBeatNow, () => beatNow());
}

export function getDiagnostics(): { configPath: string; config: DesktopStoredConfig } {
  return { configPath: getConfigPath(), config: getConfig() };
}
