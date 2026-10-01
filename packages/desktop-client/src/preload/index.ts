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
 *
 * 注意：contextBridge 在参数跨越"主世界 → 隔离世界"时就做结构化克隆，
 * 因此**桥接层无法替调用方兜底**：传 Vue 响应式对象（Proxy）会在进入这里的函数体
 * 之前就抛 `An object could not be cloned.`。调用方必须传纯数据，见 desktop.d.ts。
 */
const bridge: DesktopBridge = {
  smokeTest: process.env.ELECTRON_SMOKE_TEST === '1',
  // 冒烟凭据：只在冒烟模式下透传，供渲染进程的冒烟钩子构造测试数据用。
  // **不走代码字面量**——本文件与渲染产物都会进 app.asar，写死账号等于随安装包把教师口令发出去。
  smokeCredentials:
    process.env.ELECTRON_SMOKE_TEST === '1'
      ? {
          username: process.env.ELECTRON_SMOKE_USER ?? '',
          password: process.env.ELECTRON_SMOKE_PASSWORD ?? '',
          classCode: process.env.ELECTRON_SMOKE_CLASS_CODE ?? '',
          classPassword: process.env.ELECTRON_SMOKE_CLASS_PASSWORD ?? '',
        }
      : undefined,
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
  /** 灵动岛点了"标为已读"（多条通知的整批）：一次同步这一批 */
  onIslandMarkAllRead: (handler: (ids: string[]) => void): void => {
    ipcRenderer.on('island:mark-all-read', (_event, ids: string[]) => handler(ids ?? []));
  },
};

contextBridge.exposeInMainWorld('desktop', bridge);
