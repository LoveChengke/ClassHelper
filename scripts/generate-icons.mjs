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

child.on('exit', (code) => {
  if (code === 0) {
    // 托盘图标需要一张 PNG 随 renderer 一起打包（Vite 会把 public/ 复制到 dist/renderer）
    try {
      const source = path.join(root, 'packages', 'desktop-client', 'build', 'icon.png');
      const targetDir = path.join(root, 'packages', 'desktop-client', 'public');
      fs.mkdirSync(targetDir, { recursive: true });
      fs.copyFileSync(source, path.join(targetDir, 'tray.png'));
      console.log('[icons] 托盘图标已同步：packages/desktop-client/public/tray.png');
    } catch (error) {
      console.warn('[icons] 同步托盘图标失败（不影响构建）', error);
    }
  }
  process.exit(code ?? 1);
});
