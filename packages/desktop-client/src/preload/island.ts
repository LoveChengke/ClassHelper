import { contextBridge, ipcRenderer } from 'electron';
import type { IslandAppearance, IslandState } from '@classhelper/shared';

/**
 * 灵动岛窗口的预加载脚本。
 * 只暴露「订阅状态/外观」与「发送用户操作」两件事，渲染进程不接触任何 Node 能力。
 */
export interface IslandBridge {
  onState(handler: (state: IslandState) => void): void;
  sendAction(action: 'expand' | 'collapse' | 'dismiss' | 'mark-read' | 'open-app', id?: string): void;
  getState(): Promise<IslandState>;
  /** 订阅个性化外观（设置页改动后实时生效） */
  onAppearance(handler: (appearance: IslandAppearance) => void): void;
  getAppearance(): Promise<IslandAppearance>;
  /** 命中提示：指针在岛上 → 让窗口接收鼠标（只上报 true，关闭由主进程轮询决定） */
  setInteractive(interactive: boolean): void;
  /** 上报岛体矩形（窗口内 CSS px）：主进程据此按光标位置兜底校正命中 */
  setHitRect(rect: { x: number; y: number; width: number; height: number } | null): void;
}

const bridge: IslandBridge = {
  onState: (handler) => {
    ipcRenderer.on('island:state', (_event, state: IslandState) => handler(state));
  },
  sendAction: (action, id) => {
    ipcRenderer.send('island:action', { action, id });
  },
  getState: () => ipcRenderer.invoke('island:get-state'),
  onAppearance: (handler) => {
    ipcRenderer.on('island:appearance', (_event, appearance: IslandAppearance) => handler(appearance));
  },
  getAppearance: () => ipcRenderer.invoke('island:get-appearance'),
  setInteractive: (interactive) => {
    ipcRenderer.send('island:set-interactive', interactive);
  },
  setHitRect: (rect) => {
    ipcRenderer.send('island:set-hit-rect', rect);
  },
};

contextBridge.exposeInMainWorld('island', bridge);
