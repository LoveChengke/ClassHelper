/**
 * IPC 通道名集中管理（主进程与 preload 共用同一份字符串）。
 *
 * **为什么单独一个文件、而且这里一个 import 都不能有**：preload 需要这些字符串，
 * 但 preload 在 `sandbox: true` 下运行 —— 沙箱化 preload **不能 require `node:fs` /
 * `node:path` / `node:crypto` 这类内建模块**。而 esbuild 会把 preload 的**运行时 import**
 * 整条依赖链打进同一个产物：preload 一旦 `import { IPC_CHANNELS } from './ipc.js'`，
 * 就会把 `ipc.js` → `client-agent.js` / `config.js` / `logger.js` / `auto-update.js`
 * 一起拉进来（它们都要 `node:fs`），于是 preload 在沙箱里**加载即失败**，
 * 表现是渲染进程里 `window.desktop === undefined`（冒烟断言「preload contextBridge 注入」直接红，
 * 后续所有 `window.desktop.*` 调用抛 `Cannot read properties of undefined`）。
 *
 * 所以这个文件是**叶子模块**：只有字符串常量，没有任何 import、没有任何副作用。
 * 新增通道时加在这里，`main/ipc.ts` 与 `preload/index.ts` 各自 import 它。
 */
export const IPC_CHANNELS = {
  getConfig: 'classhelper:config:get',
  saveConfig: 'classhelper:config:save',
  clearConfig: 'classhelper:config:clear',
  appInfo: 'classhelper:app:info',
  openExternal: 'classhelper:shell:open-external',
  updateCheck: 'classhelper:update:check',
  updateIgnore: 'classhelper:update:ignore',
  getAutoLaunch: 'classhelper:app:get-autolaunch',
  setAutoLaunch: 'classhelper:app:set-autolaunch',
  openLogDir: 'classhelper:app:open-log-dir',
  openDevTools: 'classhelper:app:open-devtools',
  clientStatus: 'classhelper:client:status',
  clientBeatNow: 'classhelper:client:beat-now',
} as const;

/** 主进程 → 渲染进程的单向推送：有可用更新（同理，供 preload 与主进程共用） */
export const UPDATE_AVAILABLE_CHANNEL = 'classhelper:update:available';
