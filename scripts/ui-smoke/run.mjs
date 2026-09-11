/**
 * Web 管理端 UI 冒烟测试启动器。
 *
 * 复用 desktop-client 里已安装的 Electron 运行时（无需额外依赖），
 * 以「真实浏览器内核 + 真实点击」的方式验证 Web 管理端。
 *
 * 用法：
 *   1) 启动后端（同时托管 Web 管理端）：pnpm dev:server 或生产模式 node dist/index.js
 *   2) pnpm verify:web
 *
 * 环境变量：
 *   UI_SMOKE_URL     默认 http://127.0.0.1:4000/
 *   UI_SMOKE_USER    默认 teacher1
 *   UI_SMOKE_PASS    默认 teacher123
 *   UI_SMOKE_RESULT  结果 JSON 输出路径（可选）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronDir = path.join(root, 'packages', 'desktop-client', 'node_modules', 'electron');

if (!fs.existsSync(electronDir)) {
  console.error('[ui-smoke] 未找到 Electron（packages/desktop-client/node_modules/electron）');
  console.error('  请先执行：pnpm install');
  process.exit(2);
}

const pathFile = path.join(electronDir, 'path.txt');
const executable = fs.existsSync(pathFile)
  ? path.join(electronDir, 'dist', fs.readFileSync(pathFile, 'utf8').trim())
  : path.join(electronDir, 'dist', 'electron.exe');

if (!fs.existsSync(executable)) {
  console.error(`[ui-smoke] Electron 可执行文件不存在：${executable}`);
  console.error('  请执行：node packages/desktop-client/node_modules/electron/install.js');
  process.exit(2);
}

const entry = path.join(root, 'scripts', 'ui-smoke', 'main.cjs');
const target = process.env.UI_SMOKE_URL ?? 'http://127.0.0.1:4000/';
const resultFile = process.env.UI_SMOKE_RESULT ?? path.join(root, '.cache', 'ui-smoke-result.json');
const profileDir = path.join(root, '.cache', 'ui-smoke-profile');

// 每次运行前清空浏览器配置目录，避免 Service Worker / 缓存影响结果
fs.rmSync(profileDir, { recursive: true, force: true });

console.log(`[ui-smoke] 目标：${target}`);
console.log(`[ui-smoke] Electron：${executable}`);

const child = spawn(executable, [entry], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    UI_SMOKE_URL: target,
    UI_SMOKE_RESULT: resultFile,
    UI_SMOKE_PROFILE: profileDir,
  },
});

child.on('exit', (code) => {
  if (code === 0) {
    console.log(`[ui-smoke] 全部通过，结果文件：${resultFile}`);
  }
  process.exit(code ?? 1);
});
