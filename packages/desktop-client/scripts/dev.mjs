/**
 * 开发模式：先构建主进程/preload，再启动 Vite 渲染进程开发服务器，
 * 等端口就绪后用 Electron 打开开发地址（支持热更新）。
 *
 * 说明：子进程统一使用 stdio: 'inherit'，在受限沙箱中也能正常启动。
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveElectronEnv, resolveElectronExecutable } from '../../../scripts/lib/electron-env.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronPath = resolveElectronExecutable(path.join(root, 'node_modules', 'electron'));
const HOST = '127.0.0.1';
const PORT = 5174;
const DEV_URL = `http://${HOST}:${PORT}`;

const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');

const vite = spawn(process.execPath, [viteBin, '--host', HOST, '--port', String(PORT), '--strictPort'], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});

let electron = null;

function cleanup(code = 0) {
  if (electron && !electron.killed) electron.kill();
  if (!vite.killed) vite.kill();
  process.exit(code);
}

function waitForPort(attempt = 0) {
  const socket = net.connect({ host: HOST, port: PORT });
  socket.once('connect', () => {
    socket.destroy();
    startElectron();
  });
  socket.once('error', () => {
    socket.destroy();
    if (attempt > 120) {
      console.error('[dev] 等待 Vite 开发服务器超时');
      cleanup(1);
      return;
    }
    setTimeout(() => waitForPort(attempt + 1), 250);
  });
}

function startElectron() {
  console.log(`[dev] Vite 已就绪，启动 Electron -> ${DEV_URL}`);
  electron = spawn(electronPath, ['.'], {
    cwd: root,
    stdio: 'inherit',
    env: resolveElectronEnv({ VITE_DEV_SERVER_URL: DEV_URL }),
  });
  electron.on('exit', (code) => cleanup(code ?? 0));
}

vite.on('exit', (code) => {
  if (code !== 0) console.error(`[dev] Vite 退出，code=${code}`);
});
process.on('SIGINT', () => cleanup(0));
process.on('SIGTERM', () => cleanup(0));

waitForPort();
