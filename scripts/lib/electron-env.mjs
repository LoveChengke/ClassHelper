/**
 * 启动 Electron 应用时的公共辅助：环境变量清理 + 可执行文件定位。
 *
 * 背景（本机真实踩过的两个坑，都发生在"宿主终端本身就是 Electron"的场景，
 * 例如 DSH 桌面端内置终端 / VS Code 扩展宿主）：
 *
 * 1. 宿主会带着 `ELECTRON_RUN_AS_NODE=1` 运行子进程（本机的 `pnpm` 运行在
 *    Electron 内置 Node 上，因此经过 `pnpm run` 的脚本都会带着它）。
 *    该变量会一路继承到我们用 `spawn` 拉起的 Electron 上，使其**退化成纯 Node**：
 *    `process.versions.electron` 仍在，但 `require('electron')` 抛 MODULE_NOT_FOUND，
 *    表现为"冒烟测试/开发模式一启动就报 Cannot find module 'electron'"。
 * 2. 同样因为 `process.versions.electron` 存在，`require('electron')` / `import electronPath
 *    from 'electron'` 返回的是 **API 对象而不是可执行文件路径**，直接 spawn 会报
 *    `ERR_INVALID_ARG_TYPE: The "file" argument must be of type string`。
 *
 * 因此：启动 Electron 一律用 `resolveElectronEnv()` + `resolveElectronExecutable()`，
 * 不要直接 import 'electron'。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 清掉会让 Electron 退化成纯 Node 的继承变量，可附加自定义变量 */
export function resolveElectronEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  return env;
}

/**
 * 由 `node_modules/electron` 目录定位真正的 Electron 可执行文件。
 * @param {string} electronDir `node_modules/electron` 的绝对路径
 */
export function resolveElectronExecutable(electronDir) {
  const pathFile = path.join(electronDir, 'path.txt');
  const binaryName = fs.existsSync(pathFile)
    ? fs.readFileSync(pathFile, 'utf8').trim()
    : process.platform === 'win32'
      ? 'electron.exe'
      : 'electron';
  return path.join(electronDir, 'dist', binaryName);
}
