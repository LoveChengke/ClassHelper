/**
 * 打包版冒烟验证：对**已打包**的客户端 EXE 跑一遍与 `pnpm verify:desktop` 相同的自检。
 *
 * 为什么需要单独一条：开发产物（`dist/`）通过不代表打包产物通过 —— asar 打包后
 * 资源路径、Electron 版本、`app.isPackaged` 都可能不同。交付前应实测 `packaged: true`。
 *
 * 用法：
 *   node scripts/verify-packaged.mjs --exe "releases/client/<版本>/安装包/ClassHelper-<版本>-x64-portable.exe" --offline
 *   显式 --visual 才进行桌面视觉验收，显式 --online 才探测并启用联网。
 *   联网前由调用方准备隔离服务、临时教师和班级，并显式传入测试凭据；本脚本不自动创建它们。
 * 默认后台快速、离线，两次启动均成功且 packaged=true 才返回 0。
 */
import { spawn, spawnSync } from 'node:child_process';
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

// 默认取「装好的客户端」：打包产物里已经没有解包目录（见 dist-win.mjs 文件头），
// 所以默认值只能是安装后的落点，其余情况一律用 --exe 显式指定。
const installedExe = path.join(
  process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Local'),
  'Programs',
  'ClassHelper',
  'ClassHelper.exe',
);

const exe = path.resolve(argOf('--exe') ?? installedExe);
const classCode = argOf('--code') ?? process.env.ELECTRON_SMOKE_CLASS_CODE ?? 'G101';
const classPassword = argOf('--password') ?? process.env.ELECTRON_SMOKE_CLASS_PASSWORD ?? '123456';
const mode = argv.includes('--visual') ? 'visual' : 'quick';
const forceOffline = !argv.includes('--online') || argv.includes('--offline');

if (!fs.existsSync(exe)) {
  console.error(`[packaged-smoke] 找不到打包后的 EXE：${exe}`);
  console.error(
    '[packaged-smoke] 用 --exe 指定：装好的客户端（默认 %LOCALAPPDATA%\\Programs\\ClassHelper\\' +
      'ClassHelper.exe）、或解压后的便携版所在目录',
  );
  process.exit(2);
}
if (mode === 'quick') {
  const backgroundMarker = Buffer.from('ELECTRON_SMOKE_MODE');
  const candidates = [
    path.join(path.dirname(exe), 'resources/app.asar'),
    path.join(path.dirname(exe), 'resources/app/dist/main/index.js'),
  ];
  let supportsBackground = candidates.some(
    (file) => fs.existsSync(file) && fs.readFileSync(file).includes(Buffer.from('ELECTRON_SMOKE_MODE')),
  );

  // electron-builder 的 portable 目标把整个 app 放在 7z 自解压文件里，EXE 旁边没有 resources/。
  // 从本仓库打包缓存里的 7za 只读取 app.asar 到内存，确认本次便携包也包含后台模式标记。
  if (!supportsBackground && /-portable\.exe$/i.test(exe)) {
    try {
      const cacheDir = path.join(repoRoot, '.cache', 'electron-builder');
      const sevenZip = fs
        .readdirSync(cacheDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('7zip@'))
        .flatMap((entry) => {
          const packageDir = path.join(cacheDir, entry.name);
          return fs
            .readdirSync(packageDir, { withFileTypes: true })
            .filter((child) => child.isDirectory())
            .map((child) => path.join(packageDir, child.name, 'bin', '7za.exe'));
        })
        .find((file) => fs.existsSync(file));

      if (sevenZip) {
        const payload = spawnSync(sevenZip, ['e', '-so', exe, 'resources/app.asar'], {
          encoding: null,
          maxBuffer: 32 * 1024 * 1024,
          windowsHide: true,
        });
        supportsBackground = payload.status === 0 && payload.stdout?.includes(backgroundMarker);
      }
    } catch {
      // 下方的提示会说明该产物未确认支持后台模式。
    }
  }

  if (!supportsBackground) {
    console.error(
      '[packaged-smoke] 无法确认这个产物支持后台快速模式。请验证新构建的产物，或显式 --visual 执行桌面验收。',
    );
    process.exit(2);
  }
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
      windowsHide: true,
      env: resolveElectronEnv({
        ELECTRON_SMOKE_TEST: '1',
        ELECTRON_SMOKE_MODE: mode,
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
const secondCode = await launch({
  ELECTRON_SMOKE_ONLINE: '0',
  ELECTRON_SMOKE_MODE: 'quick',
  ELECTRON_SMOKE_RESULT: resultFile,
});
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
