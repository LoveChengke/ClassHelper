import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../main/ipc.js';
import type { DesktopAppInfo, DesktopBridge, DesktopStoredConfig } from '../types/desktop.js';

/**
 * 预加载脚本：在开启了 contextIsolation + sandbox 的前提下，
 * 只向渲染进程暴露一组最小的、显式声明的能力（不暴露 ipcRenderer 本体）。
 */
const bridge: DesktopBridge = {
  smokeTest: process.env.ELECTRON_SMOKE_TEST === '1',
  getConfig: (): Promise<DesktopStoredConfig> => ipcRenderer.invoke(IPC_CHANNELS.getConfig),
  saveConfig: (patch: Partial<DesktopStoredConfig>): Promise<DesktopStoredConfig> =>
    ipcRenderer.invoke(IPC_CHANNELS.saveConfig, patch),
  clearConfig: (): Promise<DesktopStoredConfig> => ipcRenderer.invoke(IPC_CHANNELS.clearConfig),
  getAppInfo: (): Promise<DesktopAppInfo> => ipcRenderer.invoke(IPC_CHANNELS.appInfo),
  openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.openExternal, url),
};

contextBridge.exposeInMainWorld('desktop', bridge);
