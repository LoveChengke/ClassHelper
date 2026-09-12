/**
 * 图标生成启动器：pnpm icons
 * 复用 desktop-client 的 Electron 运行时渲染 SVG 并导出 PNG/ICO。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveElectronEnv, resolveElectronExecutable } from './lib/electron-env.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronDir = path.join(root, 'packages', 'desktop-client', 'node_modules', 'electron');

if (!fs.existsSync(electronDir)) {
  console.error('[icons] 未找到 Electron，请先执行 pnpm install');
  process.exit(2);
}

const executable = resolveElectronExecutable(electronDir);

const child = spawn(executable, [path.join(root, 'scripts', 'icons', 'render.cjs')], {
  cwd: root,
  stdio: 'inherit',
  env: resolveElectronEnv(),
});

child.on('exit', (code) => process.exit(code ?? 1));
