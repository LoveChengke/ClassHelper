import { app, ipcMain, shell } from 'electron';
import { clearConfig, getConfig, getConfigPath, saveConfig } from './config.js';
import type { DesktopAppInfo, DesktopStoredConfig } from '../types/desktop.js';

/** IPC 通道名集中管理，preload 与主进程共用同一份字符串 */
export const IPC_CHANNELS = {
  getConfig: 'classhelper:config:get',
  saveConfig: 'classhelper:config:save',
  clearConfig: 'classhelper:config:clear',
  appInfo: 'classhelper:app:info',
  openExternal: 'classhelper:shell:open-external',
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
    smokeTest: process.env.ELECTRON_SMOKE_TEST === '1',
  }));

  ipcMain.handle(IPC_CHANNELS.openExternal, async (_event, url: string): Promise<boolean> => {
    if (!/^https?:\/\//i.test(url)) return false;
    await shell.openExternal(url);
    return true;
  });
}

export function getDiagnostics(): { configPath: string; config: DesktopStoredConfig } {
  return { configPath: getConfigPath(), config: getConfig() };
}
