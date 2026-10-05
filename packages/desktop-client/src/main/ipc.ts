import { app, ipcMain, shell } from 'electron';
import type { UpdateInfo } from '@classhelper/shared';
import { clearConfig, getConfig, getConfigPath, saveConfig } from './config.js';
import { checkForUpdates, ignoreUpdateVersion } from './update.js';
import type { DesktopAppInfo, DesktopStoredConfig } from '../types/desktop.js';

/** IPC 通道名集中管理，preload 与主进程共用同一份字符串 */
export const IPC_CHANNELS = {
  getConfig: 'classhelper:config:get',
  saveConfig: 'classhelper:config:save',
  clearConfig: 'classhelper:config:clear',
  appInfo: 'classhelper:app:info',
  openExternal: 'classhelper:shell:open-external',
  updateCheck: 'classhelper:update:check',
  updateIgnore: 'classhelper:update:ignore',
} as const;

export function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.getConfig, (): DesktopStoredConfig => getConfig());

  ipcMain.handle(
    IPC_CHANNELS.saveConfig,
    (_event, patch: Partial<DesktopStoredConfig>): DesktopStoredConfig => {
      return saveConfig(patch ?? {});
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
}

export function getDiagnostics(): { configPath: string; config: DesktopStoredConfig } {
  return { configPath: getConfigPath(), config: getConfig() };
}
