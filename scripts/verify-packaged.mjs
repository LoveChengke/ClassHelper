/**
 * 打包版冒烟验证：对**已打包**的客户端 EXE 跑一遍与 `pnpm verify:desktop` 相同的自检。
 *
 * 为什么需要单独一条：开发产物（`dist/`）通过不代表打包产物通过 —— asar 打包后
 * 资源路径、Electron 版本、`app.isPackaged` 都可能不同。交付前应实测 `packaged: true`。
 *
 * 用法：
 *   node scripts/verify-packaged.mjs
 *   node scripts/verify-packaged.mjs --exe "D:\class\@classhelperdesktop-client\班级小助手.exe"
 *   node scripts/verify-packaged.mjs --offline
 *   node scripts/verify-packaged.mjs --code G101 --password 123456
 *
 * 联网用例需要后端在 http://127.0.0.1:4000（默认自动探测；探测不到时退化为离线用例）。
 * 退出码：0 = 两次启动都全绿且 `packaged: true`。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveElectronEnv } from './lib/electron-env.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

// 默认取 releases/client/<版本>/免安装/（dist-win 的产物落点，见 AGENTS.md §4）
const clientVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
const defaultExe = path.join(repoRoot, 'releases', 'client', clientVersion, '免安装', '班级小助手.exe');

const exe = path.resolve(argOf('--exe') ?? defaultExe);
const classCode = argOf('--code') ?? process.env.ELECTRON_SMOKE_CLASS_CODE ?? 'G101';
const classPassword = argOf('--password') ?? process.env.ELECTRON_SMOKE_CLASS_PASSWORD ?? '123456';
const forceOffline = argv.includes('--offline');

if (!fs.existsSync(exe)) {
  console.error(`[packaged-smoke] 找不到打包后的 EXE：${exe}`);
  console.error('[packaged-smoke] 先执行 pnpm dist:win，或用 --exe 指定已安装的客户端路径');
  process.exit(2);
}

let online = forceOffline ? '0' : null;
if (online === null) {
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
}

// 独立 userData：用户开着客户端也能跑验证（不抢单实例锁）
const profileDir = path.join(repoRoot, '.cache', `packaged-smoke-profile-${process.pid}`);
const resultFile = path.join(repoRoot, '.cache', `packaged-smoke-${process.pid}.json`);
fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 });

console.log(`[packaged-smoke] EXE：${exe}`);
console.log(`[packaged-smoke] 联网用例：${online === '1' ? '启用' : '关闭'}`);
console.log(`[packaged-smoke] 独立配置目录：${profileDir}\n`);

/** 启动一次打包版冒烟（stdio 继承：EXE 是 GUI 进程，输出直接透传到终端） */
function launch(extraEnv) {
  return new Promise((resolve) => {
    const child = spawn(exe, [], {
      cwd: path.dirname(exe),
      stdio: 'inherit',
      env: resolveElectronEnv({
        ELECTRON_SMOKE_TEST: '1',
        ELECTRON_SMOKE_PROFILE: profileDir,
        ELECTRON_SMOKE_ONLINE: online,
        ELECTRON_SMOKE_CLASS_CODE: classCode,
        ELECTRON_SMOKE_CLASS_PASSWORD: classPassword,
        // 教师凭据：打包版的主进程从环境变量读（安装包里不留口令字面量）
        ELECTRON_SMOKE_USER: process.env.ELECTRON_SMOKE_USER ?? 'teacher1',
        ELECTRON_SMOKE_PASSWORD: process.env.ELECTRON_SMOKE_PASSWORD ?? 'teacher123',
        ...extraEnv,
      }),
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

const readResult = () => {
  try {
    return JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  } catch {
    return null;
  }
};

fs.rmSync(resultFile, { force: true });
const firstCode = await launch({ ELECTRON_SMOKE_RESULT: resultFile });
const first = readResult();
const firstPassed = first?.passed ?? -1;
const firstTotal = first?.total ?? -1;

// 退出后再启动一次：证明单实例锁与文件句柄都已释放（与开发版冒烟同一套判据）
let lockReleased = true;
try {
  fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 });
} catch (error) {
  lockReleased = false;
  console.error(`[packaged-smoke] [FAIL] 退出后配置文件锁未释放：${error?.message ?? error}`);
}
console.log('\n[packaged-smoke] 二次启动校验（单实例锁 / 句柄是否已释放）...');
fs.rmSync(resultFile, { force: true });
const secondCode = await launch({ ELECTRON_SMOKE_ONLINE: '0', ELECTRON_SMOKE_RESULT: resultFile });
const second = readResult();

const ok =
  firstCode === 0 &&
  first?.ok === true &&
  first?.packaged === true &&
  firstPassed === firstTotal &&
  lockReleased &&
  secondCode === 0 &&
  second?.ok === true &&
  second?.packaged === true;

console.log(
  `\n[packaged-smoke] 首次启动：${firstPassed}/${firstTotal} packaged=${first?.packaged === true} code=${firstCode}`,
);
console.log(
  `[packaged-smoke] 二次启动：${second?.passed ?? -1}/${second?.total ?? -1} ` +
    `packaged=${second?.packaged === true} code=${secondCode} 文件锁已释放=${lockReleased}`,
);
console.log(ok ? '[packaged-smoke] [PASS] 打包版全绿' : '[packaged-smoke] [FAIL] 打包版未全绿');

try {
  fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 });
} catch {
  // 清理失败不影响结论（第一次删除已证明锁已释放）
}

process.exit(ok ? 0 : 1);
