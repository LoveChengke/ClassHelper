/**
 * 图标生成启动器：pnpm icons
 *
 * 真正的活儿在 `scripts/icons/render.cjs`（跑在 Electron 里，用 Chromium 的 canvas
 * 把 `build/classhelper.png` 重采样成各端要的尺寸）。这里只负责把 Electron 拉起来。
 *
 * 图形源是**手工放入的设计导出**，不从任何 SVG 渲染 —— 改图标请换
 * `build/classhelper.{png,ico}` 这两个文件，别改这个脚本。
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

for (const source of ['classhelper.png', 'classhelper.ico']) {
  const file = path.join(root, 'build', source);
  if (!fs.existsSync(file)) {
    console.error(`[icons] 缺少图形源 build/${source}（设计导出，需手工放入）`);
    process.exit(2);
  }
}

const executable = resolveElectronExecutable(electronDir);

const child = spawn(executable, [path.join(root, 'scripts', 'icons', 'render.cjs')], {
  cwd: root,
  stdio: 'inherit',
  env: resolveElectronEnv(),
});

child.on('exit', (code) => {
  process.exit(code ?? 1);
});
