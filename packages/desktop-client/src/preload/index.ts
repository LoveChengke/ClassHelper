import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../main/ipc.js';
import type {
  DesktopAppInfo,
  DesktopBridge,
  DesktopStoredConfig,
  IslandClassStatePayload,
  IslandPushContext,
} from '../types/desktop.js';
import type { IslandNotification } from '@classhelper/shared';

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

  islandPush: (payload: { notification: IslandNotification; context?: IslandPushContext }): void => {
    ipcRenderer.send('island:push', payload);
  },
  islandSetClassState: (payload: IslandClassStatePayload): void => {
    ipcRenderer.send('island:class-state', payload);
  },
  islandGetState: () => ipcRenderer.invoke('island:get-state'),
};

contextBridge.exposeInMainWorld('desktop', bridge);
