/**
 * 主进程与渲染进程之间的桥接契约（preload 通过 contextBridge 暴露）。
 * 渲染进程只依赖这个最小 API，不接触 Node.js。
 */

export interface DesktopStoredConfig {
  /** 后端服务地址，例如 http://127.0.0.1:4000 */
  serverUrl: string;
  /** 上次登录的用户名（便于自动填充） */
  username: string;
  /** 登录令牌（主进程用 safeStorage 加密后落盘，读回时自动解密） */
  token: string | null;
}

export interface DesktopAppInfo {
  appVersion: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  userDataPath: string;
  /** 是否处于冒烟验证模式（由 ELECTRON_SMOKE_TEST=1 触发） */
  smokeTest: boolean;
}

export interface DesktopBridge {
  /** 是否处于冒烟验证模式（由 ELECTRON_SMOKE_TEST=1 触发），同步可读 */
  smokeTest: boolean;
  getConfig(): Promise<DesktopStoredConfig>;
  saveConfig(patch: Partial<DesktopStoredConfig>): Promise<DesktopStoredConfig>;
  clearConfig(): Promise<DesktopStoredConfig>;
  getAppInfo(): Promise<DesktopAppInfo>;
  openExternal(url: string): Promise<boolean>;
}

declare global {
  interface Window {
    /** 仅在 Electron 中注入；浏览器里为 undefined（渲染进程做了降级处理） */
    desktop?: DesktopBridge;
    /** 冒烟验证钩子，仅在 ELECTRON_SMOKE_TEST=1 时由渲染进程注册 */
    __classhelperSmoke__?: {
      cacheSelfTest(): Promise<{ ok: boolean; detail: string }>;
      offlineScenario(): Promise<{ ok: boolean; detail: string }>;
      onlineScenario(): Promise<{ ok: boolean; detail: string }>;
    };
  }
}

export {};
