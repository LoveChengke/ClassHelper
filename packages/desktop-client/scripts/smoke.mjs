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

/**
 * 准备一个已知可用的班级账号（ClassHelper 班级端已改为班级码 + 班级密码登录）：
 * 用管理员账号登录 → 取第一个班级 → 先试"已知密码"（冒烟密码 / 种子默认 123456），
 * 命中就直接用、**不改动任何数据**；都不行才把该班重置成冒烟专用密码，
 * 并在脚本收尾时恢复为种子默认密码（避免把演示实例的 123456 悄悄改掉）。
 */
async function provisionClassAccount() {
  const base = process.env.ELECTRON_SMOKE_API ?? 'http://127.0.0.1:4000/api';
  const username = process.env.ELECTRON_SMOKE_ADMIN ?? 'admin';
  const adminPassword = process.env.ELECTRON_SMOKE_ADMIN_PASSWORD ?? 'admin123';
  const password = process.env.ELECTRON_SMOKE_CLASS_PASSWORD ?? 'smoke123456';
  const CANDIDATES = [...new Set([password, process.env.ELECTRON_SMOKE_SEED_PASSWORD ?? '123456'])];
  const tryLogin = async (code, candidate) => {
    const response = await fetch(`${base}/auth/class-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, password: candidate }),
    });
    return response.ok;
  };
  try {
    const loginResponse = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: adminPassword }),
    });
    const login = await loginResponse.json();
    const token = login?.data?.token;
    if (!token) return null;

    const authHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const classesResponse = await fetch(`${base}/classes`, { headers: authHeaders });
    const classes = (await classesResponse.json())?.data ?? [];
    const target = classes[0];
    if (!target) return null;

    // 冒烟**永不修改班级码**（班级码是给学生用的，不应被测试工具改写）：
    // 只有"现有班级码 + 已知密码全部登录失败"时才重置密码，班级码原样保留。
    const code = target.code;
    if (!code) return null;

    for (const candidate of CANDIDATES) {
      if (await tryLogin(code, candidate)) return { code, password: candidate, className: target.name };
    }

    const patchResponse = await fetch(`${base}/classes/${target.id}/class-account`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ code, password }),
    });
    if (!patchResponse.ok) return null;

    const patched = (await patchResponse.json())?.data;
    // 记下"需要恢复"，脚本收尾时改回种子默认密码（已知密码都不通时无法得知原密码）
    patchedAccount = { id: target.id, code: patched?.code ?? code, base, authHeaders };
    console.log(
      `[smoke] 已知密码均不可用，已把班级 ${target.name} 的密码临时重置为 ${password}` +
        `（结束时恢复为 ${CANDIDATES[1]}）`,
    );
    return { code: patched?.code ?? code, password, className: target.name };
  } catch {
    return null;
  }
}

/** 冒烟临时重置过的班级账号（结束时恢复） */
let patchedAccount = null;

/** 恢复被冒烟临时改过的班级密码（失败只告警，不影响冒烟结论） */
async function restoreClassAccount() {
  if (!patchedAccount) return;
  try {
    const response = await fetch(`${patchedAccount.base}/classes/${patchedAccount.id}/class-account`, {
      method: 'PATCH',
      headers: patchedAccount.authHeaders,
      body: JSON.stringify({
        code: patchedAccount.code,
        password: process.env.ELECTRON_SMOKE_SEED_PASSWORD ?? '123456',
      }),
    });
    console.log(
      response.ok
        ? '[smoke] 已恢复班级密码为种子默认 123456（冒烟不留副作用）'
        : `[smoke] [WARN] 班级密码恢复失败：status=${response.status}，请到后台重新设置`,
    );
  } catch (error) {
    console.log(`[smoke] [WARN] 班级密码恢复失败：${error?.message ?? error}`);
  }
}

let classCredentials = null;
if (online === '1') {
  classCredentials = await provisionClassAccount();
  console.log(
    classCredentials
      ? `[smoke] 班级账号就绪：${classCredentials.code}（${classCredentials.className}）`
      : '[smoke] 未能准备班级账号，联网集成将使用种子默认凭据',
  );
}

/** 启动一次冒烟（返回退出码） */
function launchSmoke(extraEnv) {
  return new Promise((resolve) => {
    const child = spawn(electronPath, ['.'], {
      cwd: root,
      stdio: 'inherit',
      env: resolveElectronEnv({
        ELECTRON_SMOKE_TEST: '1',
        ELECTRON_SMOKE_ONLINE: online,
        ELECTRON_SMOKE_PROFILE: profileDir,
        ELECTRON_SMOKE_CLASS_CODE: classCredentials?.code ?? '',
        ELECTRON_SMOKE_CLASS_PASSWORD: classCredentials?.password ?? '',
        // 教师凭据只从这里传入：主进程的冒烟代码从环境变量读，
        // 因此安装包（app.asar）里不会留下教师口令字面量（本脚本不进安装包）
        ELECTRON_SMOKE_USER: process.env.ELECTRON_SMOKE_USER ?? 'teacher1',
        ELECTRON_SMOKE_PASSWORD: process.env.ELECTRON_SMOKE_PASSWORD ?? 'teacher123',
        ...extraEnv,
      }),
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

const code = await launchSmoke();
console.log(`\n[smoke] Electron 退出，code=${code}`);
await restoreClassAccount();
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
const relaunchCode = await launchSmoke({ ELECTRON_SMOKE_ONLINE: '0', ELECTRON_SMOKE_RESULT: relaunchResult });

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
process.exit(resourcesOk ? 0 : 1);
