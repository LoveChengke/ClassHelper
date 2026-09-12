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
  islandSetAppearance: (appearance): void => {
    ipcRenderer.send('island:set-appearance', appearance);
  },
  islandGetAppearance: () => ipcRenderer.invoke('island:get-appearance'),
  /** 灵动岛点了"标为已读"：主进程转交渲染进程同步通知中心 */
  onIslandMarkRead: (handler: (id: string) => void): void => {
    ipcRenderer.on('island:mark-read', (_event, id: string) => handler(id));
  },
};

contextBridge.exposeInMainWorld('desktop', bridge);
