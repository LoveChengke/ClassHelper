/**
 * Electron 冒烟验证：以 ELECTRON_SMOKE_TEST=1 启动应用（不弹窗），
 * 主进程会依次校验 preload 桥接、渲染进程挂载、登录页 DOM、
 * IPC 往返、IndexedDB 缓存读写、断网回退缓存，然后自动退出。
 *
 * 前置条件：已执行 npm run build（需要 dist/main 与 dist/renderer）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const required = [path.join(root, 'dist/main/index.js'), path.join(root, 'dist/renderer/index.html')];
const missing = required.filter((file) => !fs.existsSync(file));

if (missing.length > 0) {
  console.error('[smoke] 缺少构建产物，请先执行构建：');
  console.error('  pnpm --filter @classhelper/desktop-client build');
  for (const file of missing) console.error(`  缺失: ${path.relative(root, file)}`);
  process.exit(2);
}

console.log('[smoke] 启动 Electron 冒烟验证...\n');
const child = spawn(electronPath, ['.'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_SMOKE_TEST: '1' },
});

child.on('exit', (code) => {
  console.log(`\n[smoke] Electron 退出，code=${code ?? 1}`);
  process.exit(code ?? 1);
});
