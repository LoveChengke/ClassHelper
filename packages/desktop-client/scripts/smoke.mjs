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
import { provisionSmokeClass } from '../../../scripts/lib/smoke-class.mjs';
import { resolveElectronEnv, resolveElectronExecutable } from '../../../scripts/lib/electron-env.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(root, '..', '..');
const startedAt = Date.now();
const mode = process.argv.includes('--visual') ? 'visual' : (process.env.ELECTRON_SMOKE_MODE ?? 'quick');
if (!['quick', 'visual'].includes(mode)) throw new Error('冒烟模式只能是 quick 或 visual');
const resultFile =
  process.env.ELECTRON_SMOKE_RESULT ?? path.join(repoRoot, '.cache', 'desktop-smoke-result.json');
console.log(`[smoke] 模式：${mode === 'visual' ? '视觉验收（会使用桌面）' : '后台快速检查（不占用前台）'}`);
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

// 联网验收必须显式指定，避免自动碰到用户正在使用的实例。
const online = process.argv.includes('--online') ? '1' : (process.env.ELECTRON_SMOKE_ONLINE ?? '0');
let classCredentials = null;
if (online === '1') {
  classCredentials = await provisionSmokeClass();
  if (!classCredentials) throw new Error('无法建立独立验证班级，请检查测试服务端与管理员凭据');
  console.log('[smoke] 已建立独立验证班级：' + classCredentials.code);
}

/** 启动一次冒烟（返回退出码） */
function launchSmoke(extraEnv) {
  return new Promise((resolve) => {
    const child = spawn(electronPath, ['.'], {
      cwd: root,
      stdio: 'inherit',
      windowsHide: true,
      env: resolveElectronEnv({
        ELECTRON_SMOKE_TEST: '1',
        ELECTRON_SMOKE_MODE: mode,
        ELECTRON_SMOKE_RESULT: resultFile,
        ELECTRON_SMOKE_ONLINE: online,
        ELECTRON_SMOKE_PROFILE: profileDir,
        ELECTRON_SMOKE_CLASS_CODE: classCredentials?.code ?? '',
        ELECTRON_SMOKE_CLASS_PASSWORD: classCredentials?.password ?? '',
        // 教师凭据只从这里传入：主进程的冒烟代码从环境变量读，
        // 因此安装包（app.asar）里不会留下教师口令字面量（本脚本不进安装包）
        ELECTRON_SMOKE_USER:
          classCredentials?.teacherUsername ?? process.env.ELECTRON_SMOKE_USER ?? 'teacher1',
        ELECTRON_SMOKE_PASSWORD:
          classCredentials?.teacherPassword ?? process.env.ELECTRON_SMOKE_PASSWORD ?? 'teacher123',
        ELECTRON_SMOKE_CLASS_ID: classCredentials?.classId ?? '',
        ...extraEnv,
      }),
    });
    const deadline = setTimeout(
      () => {
        console.error('[smoke] 超时，结束验证进程');
        child.kill();
        resolve(124);
      },
      // 快速套件已包含本地 HTTP、校验下载和布局编辑；保留冷启动余量，单项断言不放宽。
      mode === 'visual' ? 360_000 : 90_000,
    );
    child.once('exit', (code) => {
      clearTimeout(deadline);
      resolve(code ?? 1);
    });
    child.once('error', (error) => {
      clearTimeout(deadline);
      console.error(error);
      resolve(1);
    });
  });
}

const code = await launchSmoke();
console.log(`\n[smoke] Electron 退出，code=${code}`);
await classCredentials?.cleanup();
if (code !== 0) process.exit(code);

/**
 * 需求 5 的"退出不留残留"实测（在进程真正退出之后做，才有意义）：
 *   1) 配置目录（含 Chromium 的 SingletonLock / IndexedDB 文件锁）必须能被删除
 *      —— 删不掉说明还有句柄被占用，即存在残留进程；
 *   2) 用同一个配置目录再启动一次：单实例锁与端口/句柄都已释放才会真正跑起来
 *      （若还有残留进程占着锁，第二次启动会静默退出且不产出结果文件）。
 */
let lockReleased = true;
try {
  fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 });
} catch (error) {
  lockReleased = false;
  console.error(`[smoke] [FAIL] 退出后配置文件锁未释放：${error?.message ?? error}`);
}

const relaunchResult = path.join(repoRoot, '.cache', `desktop-smoke-relaunch-${process.pid}.json`);
try {
  fs.rmSync(relaunchResult, { force: true });
} catch {
  // 忽略
}

console.log('\n[smoke] 二次启动校验（单实例锁 / 句柄是否已释放）...');
const relaunchCode = await launchSmoke({
  ELECTRON_SMOKE_ONLINE: '0',
  ELECTRON_SMOKE_MODE: 'quick',
  ELECTRON_SMOKE_RESULT: relaunchResult,
});

let relaunchPassed = 0;
let relaunchTotal = 0;
try {
  const payload = JSON.parse(fs.readFileSync(relaunchResult, 'utf8'));
  relaunchPassed = payload.passed ?? 0;
  relaunchTotal = payload.total ?? 0;
} catch {
  relaunchPassed = -1;
}

const resourcesOk =
  lockReleased && relaunchCode === 0 && relaunchTotal > 0 && relaunchPassed === relaunchTotal;
console.log(
  resourcesOk
    ? `[smoke] [PASS] 退出后无残留：配置文件锁已释放，二次启动成功（${relaunchPassed}/${relaunchTotal}）`
    : `[smoke] [FAIL] 退出后可能仍有残留：文件锁释放=${lockReleased} 二次启动 code=${relaunchCode} 结果=${relaunchPassed}/${relaunchTotal}`,
);
try {
  fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 });
} catch {
  // 二次启动可能又建了目录，删除失败不影响结论（首次删除已证明锁已释放）
}
console.log('[smoke] 总耗时：' + ((Date.now() - startedAt) / 1000).toFixed(1) + ' 秒');
process.exit(resourcesOk ? 0 : 1);
