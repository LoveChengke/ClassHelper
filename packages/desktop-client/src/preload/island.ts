import { contextBridge, ipcRenderer } from 'electron';
import type { IslandState } from '@classhelper/shared';

/**
 * 灵动岛窗口的预加载脚本。
 * 只暴露「订阅状态」与「发送用户操作」两件事，渲染进程不接触任何 Node 能力。
 */
export interface IslandBridge {
  onState(handler: (state: IslandState) => void): void;
  sendAction(action: 'expand' | 'collapse' | 'dismiss' | 'mark-read' | 'open-app', id?: string): void;
  getState(): Promise<IslandState>;
}

const bridge: IslandBridge = {
  onState: (handler) => {
    ipcRenderer.on('island:state', (_event, state: IslandState) => handler(state));
  },
  sendAction: (action, id) => {
    ipcRenderer.send('island:action', { action, id });
  },
  getState: () => ipcRenderer.invoke('island:get-state'),
};

contextBridge.exposeInMainWorld('island', bridge);
