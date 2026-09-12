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
import { resolveElectronEnv, resolveElectronExecutable } from '../../../scripts/lib/electron-env.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(root, '..', '..');
const electronPath = resolveElectronExecutable(path.join(root, 'node_modules', 'electron'));
const required = [path.join(root, 'dist/main/index.js'), path.join(root, 'dist/renderer/index.html')];
const missing = required.filter((file) => !fs.existsSync(file));

if (missing.length > 0) {
  console.error('[smoke] 缺少构建产物，请先执行构建：');
  console.error('  pnpm --filter @classhelper/desktop-client build');
  for (const file of missing) console.error(`  缺失: ${path.relative(root, file)}`);
  process.exit(2);
}

console.log('[smoke] 启动 Electron 冒烟验证...\n');

// 独立的 userData：避免与用户正在运行的客户端抢单实例锁（否则新进程会静默退出）。
// 目录按进程号区分：上一次冒烟若被强杀，目录可能仍被句柄占用（rmSync 会 ENOTEMPTY），
// 用独立目录可以彻底避免互相干扰。
const profileDir = path.join(repoRoot, '.cache', `desktop-smoke-profile-${process.pid}`);
try {
  fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
} catch (error) {
  console.warn(`[smoke] 复用/清理配置目录失败（忽略）：${error?.message ?? error}`);
}
console.log(`[smoke] 独立配置目录：${profileDir}`);

// 未显式指定时自动探测后端：可达则启用联网集成 + 侧边栏点击测试
let online = process.env.ELECTRON_SMOKE_ONLINE;
if (online === undefined) {
  online = '0';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    const response = await fetch('http://127.0.0.1:4000/api/health', { signal: controller.signal });
    clearTimeout(timer);
    online = response.ok ? '1' : '0';
  } catch {
    online = '0';
  }
  console.log(
    online === '1'
      ? '[smoke] 检测到后端在线，将执行联网集成与侧边栏点击测试'
      : '[smoke] 后端未在线，仅执行本地检查（离线缓存/界面渲染）；如需联网测试请先启动 pnpm dev:server',
  );
}

const child = spawn(electronPath, ['.'], {
  cwd: root,
  stdio: 'inherit',
  env: resolveElectronEnv({
    ELECTRON_SMOKE_TEST: '1',
    ELECTRON_SMOKE_ONLINE: online,
    ELECTRON_SMOKE_PROFILE: profileDir,
  }),
});

child.on('exit', (code) => {
  console.log(`\n[smoke] Electron 退出，code=${code ?? 1}`);
  process.exit(code ?? 1);
});
