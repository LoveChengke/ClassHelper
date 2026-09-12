/**
 * 服务端 + Web 管理端 生产打包脚本：pnpm dist:server
 *
 * 产出：
 *   release-server/classhelper-server/            可直接运行的免安装目录
 *   release-server/班级小助手服务端-<版本>-x64-setup.exe   Windows 安装程序（NSIS）
 *
 * 打包策略（面向"双击即可用、目标机无需安装 Node"）：
 *   1. 内置 Node 运行时（复制本机 node.exe）—— 目标机无需安装 Node.js
 *   2. 依赖用 npm 安装为真实目录（非 pnpm 软链），保证可整体拷贝到别的机器
 *   3. 后端使用 tsc 构建产物（ESM），Web 管理端使用 Vite 构建产物
 *   4. 首次启动自动执行迁移（AUTO_MIGRATE=true）+ 自动生成 JWT 密钥 + PID 文件
 *   5. 用 electron-builder 自带的 NSIS（makensis）生成安装程序
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveNodeRuntime } from './lib/node-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverDir = path.join(root, 'packages', 'server');
const webDir = path.join(root, 'packages', 'web-admin');
const outRoot = path.join(root, 'release-server');
const staging = path.join(outRoot, 'classhelper-server');

const VERSION = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const PRODUCT = '班级小助手服务端';
const PORT = '4000';

const log = (message) => console.log(`[dist:server] ${message}`);

const run = (command, args, options = {}) => {
  // Windows 下 .cmd 必须通过 cmd.exe 启动（Node 20+ 不再允许直接 spawn .cmd）
  const needsShell = process.platform === 'win32' && command.toLowerCase().endsWith('.cmd');
  const result = spawnSync(command, args, { stdio: 'inherit', shell: needsShell, ...options });
  if (result.error) {
    throw new Error(`命令启动失败：${command} ${args.join(' ')} -> ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`命令失败（${result.status}）：${command} ${args.join(' ')}`);
  }
};

/* ------------------------------------------------------------ 1. 前置构建 */

function ensureBuilds() {
  const serverEntry = path.join(serverDir, 'dist', 'index.js');
  const webEntry = path.join(webDir, 'dist', 'index.html');
  const sharedEntry = path.join(root, 'packages', 'shared', 'dist', 'index.js');
  const missing = [];
  if (!fs.existsSync(sharedEntry)) missing.push('packages/shared/dist（请先 pnpm build:shared）');
  if (!fs.existsSync(serverEntry))
    missing.push('packages/server/dist（请先 pnpm --filter @classhelper/server build）');
  if (!fs.existsSync(webEntry))
    missing.push('packages/web-admin/dist（请先 pnpm --filter @classhelper/web-admin build）');
  if (missing.length > 0) {
    throw new Error(`缺少构建产物：\n  - ${missing.join('\n  - ')}\n建议直接执行：pnpm dist:server`);
  }

  // 新鲜度校验：曾出现过"改动只重新构建了 server，却把旧的 shared/dist 打进安装包"，
  // 结果安装后服务启动即报 "does not provide an export named ..."。这里直接拦住。
  const newestSource = (dir) => {
    let newest = 0;
    const walk = (current) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else newest = Math.max(newest, fs.statSync(full).mtimeMs);
      }
    };
    if (fs.existsSync(dir)) walk(dir);
    return newest;
  };

  const stale = [];
  const sharedSourceTime = newestSource(path.join(root, 'packages', 'shared', 'src'));
  const sharedBuildTime = fs.statSync(path.join(root, 'packages', 'shared', 'dist', 'index.js')).mtimeMs;
  if (sharedSourceTime > sharedBuildTime) stale.push('packages/shared（src 比 dist 新）');

  const serverSourceTime = newestSource(path.join(serverDir, 'src'));
  const serverBuildTime = fs.statSync(serverEntry).mtimeMs;
  if (serverSourceTime > serverBuildTime) stale.push('packages/server（src 比 dist 新）');

  const webSourceTime = newestSource(path.join(webDir, 'src'));
  const webBuildTime = fs.statSync(webEntry).mtimeMs;
  if (webSourceTime > webBuildTime) stale.push('packages/web-admin（src 比 dist 新）');

  if (stale.length > 0) {
    throw new Error(
      `构建产物已过期：\n  - ${stale.join('\n  - ')}\n请重新构建（推荐直接执行：pnpm dist:server）`,
    );
  }
}

/* ------------------------------------------------------------ 2. 依赖安装 */

function serverProdDependencies() {
  const pkg = JSON.parse(fs.readFileSync(path.join(serverDir, 'package.json'), 'utf8'));
  const deps = { ...pkg.dependencies };
  // 工作区内部包用拷贝的方式提供，不走 npm
  delete deps['@classhelper/shared'];
  return deps;
}

/** 运行时依赖清单（同时供安装包与 Docker 运行时镜像使用，单一事实来源） */
function writeRuntimeManifest() {
  const manifest = {
    name: 'classhelper-server-runtime',
    version: VERSION,
    private: true,
    type: 'module',
    description: '班级小助手服务端运行时（安装包 / 容器内置）',
    dependencies: serverProdDependencies(),
  };
  fs.writeFileSync(path.join(staging, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const deployDir = path.join(root, 'deploy');
  fs.mkdirSync(deployDir, { recursive: true });
  fs.writeFileSync(
    path.join(deployDir, 'package.runtime.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  return manifest;
}

function installDependencies() {
  writeRuntimeManifest();

  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  log('安装生产依赖（npm install --omit=dev，真实目录，便于整体拷贝）...');
  run(npmCmd, ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: staging,
    env: {
      ...process.env,
      npm_config_cache: path.join(root, '.cache', 'npm-cache'),
      NODE_OPTIONS: process.env.NODE_OPTIONS ?? '--use-system-ca',
    },
  });
}

/* ------------------------------------------------------------ 3. 组装运行时 */

function copyRecursive(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true, dereference: true });
}

function buildRuntime() {
  // 后端代码：保留 dist 层级，保证代码里 serverRoot 的计算（../..）与开发环境一致
  copyRecursive(path.join(serverDir, 'dist'), path.join(staging, 'server', 'dist'));
  // 迁移文件（首次启动 AUTO_MIGRATE 使用）
  copyRecursive(
    path.join(serverDir, 'prisma', 'migrations'),
    path.join(staging, 'server', 'prisma', 'migrations'),
  );
  // 工作区共享包（tsc 产物）
  const sharedTarget = path.join(staging, 'node_modules', '@classhelper', 'shared');
  fs.mkdirSync(sharedTarget, { recursive: true });
  copyRecursive(path.join(root, 'packages', 'shared', 'dist'), path.join(sharedTarget, 'dist'));
  fs.writeFileSync(
    path.join(sharedTarget, 'package.json'),
    JSON.stringify(
      {
        name: '@classhelper/shared',
        version: VERSION,
        private: true,
        type: 'module',
        main: './dist/index.js',
        types: './dist/index.d.ts',
        exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
      },
      null,
      2,
    ),
    'utf8',
  );

  // Web 管理端
  copyRecursive(path.join(webDir, 'dist'), path.join(staging, 'web'));

  // Node 运行时（必须是真正的 node.exe，不能用宿主 Electron 可执行文件）
  const nodeRuntime = resolveNodeRuntime();
  copyRecursive(nodeRuntime.path, path.join(staging, 'node.exe'));
  log(`内置 Node 运行时：${nodeRuntime.path}（${nodeRuntime.version}）`);

  // 数据目录：强制清空，避免把打包机上测试用的数据库带进安装包
  fs.rmSync(path.join(staging, 'data'), { recursive: true, force: true });
  fs.mkdirSync(path.join(staging, 'data'), { recursive: true });
  fs.mkdirSync(path.join(staging, 'logs'), { recursive: true });
}

/* ------------------------------------------------------------ 4. 配置与脚本 */

function writeEnvironmentFile() {
  const jwtSecret = crypto.randomBytes(48).toString('hex');
  const content = `# 班级小助手服务端（安装程序生成，请妥善保管）
# 修改后需重启服务生效（开始菜单 → 班级小助手服务端 → 重启服务）

NODE_ENV=production
HOST=0.0.0.0
PORT=${PORT}

# 数据库：SQLite 文件位于安装目录的 data 子目录
DATABASE_PROVIDER=sqlite
DATABASE_URL="file:../data/classhelper.db"
# 首次启动时自动建表（数据库为空时执行随包的迁移 SQL）
AUTO_MIGRATE=true

# 登录令牌签名密钥（首次安装随机生成，请勿泄露/更换，更换后所有用户需重新登录）
JWT_SECRET=${jwtSecret}
JWT_EXPIRES_IN=7d

# 允许跨域来源：* 表示全部允许；若通过域名访问建议改成具体来源，例如 https://class.example.com
CORS_ORIGIN=*

# 反代场景请设为 1，保证限流按真实客户端 IP 统计
TRUST_PROXY=0
# 安全与运维
RATE_LIMIT_ENABLED=true
STARTUP_DB_CHECK=true
PID_FILE=../data/server.pid
LOG_LEVEL=info

# 可选项
BCRYPT_ROUNDS=10
DEFAULT_STUDENT_PASSWORD=123456
TERM_START_DATE=
`;
  fs.writeFileSync(path.join(staging, '.env'), content, 'utf8');
}

function writeRuntimeScripts() {
  // 注意：.cmd 内容保持 ASCII，避免 cmd.exe 按 OEM 代码页（GBK）解析 UTF-8 中文出错；
  //       中文说明放在 README.txt 与安装向导里。
  //       启动采用 PowerShell Start-Process 分离进程 + 输出重定向到日志文件，
  //       避免 `start` 在管道/非交互环境下让子进程继承句柄而卡住调用方。
  const startCmd = `@echo off
setlocal
cd /d "%~dp0"

set "PID="
if exist "data\\server.pid" set /p PID=<"data\\server.pid"

if defined PID (
  tasklist /FI "PID eq %PID%" 2>nul | find "%PID%" >nul
  if not errorlevel 1 (
    echo [ClassHelper] Server is already running ^(PID %PID%^).
    echo [ClassHelper] Admin UI: http://127.0.0.1:${PORT}/
    exit /b 0
  )
)

if not exist "logs" mkdir "logs"
echo [ClassHelper] Starting server...

powershell -NoLogo -NoProfile -NonInteractive -Command ^
  "Start-Process -FilePath '%~dp0node.exe' -ArgumentList '%~dp0server\\dist\\index.js' -WorkingDirectory '%~dp0' -WindowStyle Hidden -RedirectStandardOutput '%~dp0logs\\server.log' -RedirectStandardError '%~dp0logs\\server.error.log'"

echo [ClassHelper] Waiting for service to become ready...
for /l %%i in (1,1,30) do (
  powershell -NoLogo -NoProfile -NonInteractive -Command "try { $null = Invoke-WebRequest -Uri 'http://127.0.0.1:${PORT}/healthz' -UseBasicParsing -TimeoutSec 2; exit 0 } catch { exit 1 }" >nul 2>&1
  if not errorlevel 1 (
    echo [ClassHelper] Ready: http://127.0.0.1:${PORT}/
    exit /b 0
  )
  ping -n 2 127.0.0.1 >nul
)

echo [ClassHelper] Start timed out. Check logs\\server.error.log for details.
exit /b 1
`;

  const stopCmd = `@echo off
setlocal
cd /d "%~dp0"

if not exist "data\\server.pid" (
  echo [ClassHelper] No PID file found - server is not running.
  exit /b 0
)

set /p PID=<"data\\server.pid"
echo [ClassHelper] Stopping server ^(PID %PID%^)...
powershell -NoLogo -NoProfile -NonInteractive -Command "try { Stop-Process -Id %PID% -Force -ErrorAction Stop; exit 0 } catch { exit 1 }" >nul 2>&1
if errorlevel 1 taskkill /PID %PID% /T /F >nul 2>&1
del /q "data\\server.pid" >nul 2>&1
echo [ClassHelper] Stopped.
`;

  const restartCmd = `@echo off
call "%~dp0stop.cmd"
ping -n 2 127.0.0.1 >nul
call "%~dp0start.cmd"
`;

  const statusCmd = `@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

if exist "data\\server.pid" (
  set /p PID=<"data\\server.pid"
  powershell -NoLogo -NoProfile -NonInteractive -Command "if (Get-Process -Id !PID! -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>&1
  if not errorlevel 1 (
    echo [ClassHelper] Running ^(PID !PID!^)
    powershell -NoLogo -NoProfile -NonInteractive -Command "try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:${PORT}/api/health' -UseBasicParsing -TimeoutSec 3; Write-Host '  HTTP:' $r.StatusCode } catch { Write-Host '  HTTP: unreachable' }"
    echo [ClassHelper] Admin UI: http://127.0.0.1:${PORT}/
    exit /b 0
  )
)
echo [ClassHelper] Not running.
exit /b 1
`;

  const serviceCmd = `@echo off
setlocal
cd /d "%~dp0"

net session >nul 2>&1
if errorlevel 1 (
  echo [ClassHelper] Administrator privileges are required. Right-click and run as administrator.
  pause
  exit /b 1
)

echo [ClassHelper] Registering scheduled task (auto start at boot)...
schtasks /Create /TN "ClassHelperServer" /TR "\\"%~dp0node.exe\\" \\"%~dp0server\\dist\\index.js\\"" /SC ONSTART /RL HIGHEST /F
schtasks /Run /TN "ClassHelperServer"
echo [ClassHelper] Done.
echo   start : schtasks /Run /TN ClassHelperServer
echo   stop  : schtasks /End /TN ClassHelperServer
echo   remove: schtasks /Delete /TN ClassHelperServer /F
pause
`;

  const unserviceCmd = `@echo off
setlocal
net session >nul 2>&1
if errorlevel 1 (
  echo [ClassHelper] Administrator privileges are required.
  pause
  exit /b 1
)
schtasks /End /TN "ClassHelperServer" >nul 2>&1
schtasks /Delete /TN "ClassHelperServer" /F
echo [ClassHelper] Scheduled task removed.
pause
`;

  const files = {
    'start.cmd': startCmd,
    'stop.cmd': stopCmd,
    'restart.cmd': restartCmd,
    'status.cmd': statusCmd,
    'install-service.cmd': serviceCmd,
    'uninstall-service.cmd': unserviceCmd,
  };

  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(staging, name), content.replace(/\r?\n/g, '\r\n'), 'utf8');
  }
}

function writeReadme() {
  const content = `${PRODUCT} v${VERSION}
========================================

一、启动与访问
  1. 双击「start.cmd」（或开始菜单 → 班级小助手服务端 → 启动服务）
  2. 浏览器打开 http://127.0.0.1:${PORT}/ 即可进入 Web 管理端
  3. 安装程序已把本服务加入当前用户的开机自启项，重启电脑后无需手动启动

二、默认账号（首次安装后请立即修改密码）
  管理员  admin / admin123
  教师    teacher1 / teacher123、teacher2 / teacher123
  班级    班级码 G101/G102/G203 + 班级密码 123456（学生端桌面客户端使用）
  个人    student01 ~ student15 / student123（个人学生账号，接口向后兼容）

三、目录说明
  server\\        后端程序（server\\dist\\index.js 为入口）
  web\\           Web 管理端（由后端直接托管）
  data\\          数据库文件与 PID 文件（备份时复制此目录即可）
  logs\\          预留日志目录
  .env           全部配置项（端口、数据库、密钥、跨域等）
  node.exe        内置 Node 运行时（无需在系统中安装 Node.js）

四、常用操作
  start.cmd              启动服务并等待就绪
  stop.cmd               停止服务
  restart.cmd            重启服务
  status.cmd             查看运行状态
  install-service.cmd    注册为开机启动的计划任务（需管理员身份运行）
  uninstall-service.cmd  移除计划任务（需管理员身份运行）

五、升级
  1. 先执行 stop.cmd 停止服务
  2. 备份 data 目录
  3. 运行新版本安装程序覆盖安装（.env 会被保留，不会重置密钥与数据库）
  4. 执行 start.cmd

六、安全建议
  - 修改 admin / teacher 的默认密码
  - 如需通过公网访问，请在前面加 Nginx/Caddy 反向代理并启用 HTTPS（见 docs/production.md）
  - 定期备份 data 目录；更换 JWT_SECRET 会导致所有用户需要重新登录
`;
  fs.writeFileSync(path.join(staging, 'README.txt'), content.replace(/\r?\n/g, '\r\n'), 'utf8');

  // 许可证/说明文件（安装向导的许可页读取它）
  const license = `${PRODUCT} v${VERSION} 使用许可与说明

1. 用途
   本程序用于班级信息管理（班级、课表、作业、通知、成绩），由后端服务与 Web 管理端组成。

2. 运行方式
   安装后将在本机启动一个 HTTP 服务（默认端口 ${PORT}），并把 Web 管理端一并托管。
   该服务默认监听 0.0.0.0，同一局域网内的设备可通过本机 IP 访问；
   若需公网访问，请务必在反向代理上启用 HTTPS 并修改默认密码。

3. 数据与备份
   全部数据保存在安装目录的 data 目录（SQLite 文件）。定期复制该目录即为完整备份。

4. 卸载
   卸载程序会停止服务并删除程序文件，但会把 data 目录重命名为 data.backup 保留，
   如需彻底删除请手动删除该目录。

5. 免责
   本程序按"现状"提供，请在使用前自行评估并做好数据备份。
`;
  fs.writeFileSync(path.join(staging, 'LICENSE.txt'), license.replace(/\r?\n/g, '\r\n'), 'utf8');
}

/* ------------------------------------------------------------ 5. NSIS 安装程序 */

function findMakensis() {
  const cacheRoot = path.join(root, '.cache', 'electron-builder');
  const candidates = [];
  const walk = (dir, depth = 0) => {
    if (depth > 3 || !fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name.toLowerCase() === 'makensis.exe') candidates.push(full);
    }
  };
  walk(cacheRoot);
  return candidates[0] ?? null;
}

function buildInstaller() {
  const makensis = findMakensis();
  if (!makensis) {
    log('未找到 makensis（NSIS），跳过安装程序生成。');
    log('可执行一次 pnpm dist:win 让 electron-builder 下载 NSIS，或手动安装 NSIS 后重试。');
    return null;
  }

  const outFile = path.join(outRoot, `${PRODUCT}-${VERSION}-x64-setup.exe`);
  const templatePath = path.join(root, 'scripts', 'nsis', 'server-installer.nsi');
  const script = fs
    .readFileSync(templatePath, 'utf8')
    .replaceAll('@PRODUCT@', PRODUCT)
    .replaceAll('@VERSION@', VERSION)
    .replaceAll('@STAGING@', staging)
    .replaceAll('@OUTFILE@', outFile)
    .replaceAll('@ICON@', path.join(root, 'build', 'icon.ico'))
    .replaceAll('@PORT@', PORT);

  const generatedScript = path.join(outRoot, 'server-installer.generated.nsi');
  // NSIS 通过 BOM 识别 UTF-8，脚本含中文必须写入 BOM，否则报 "Bad text encoding"
  fs.writeFileSync(generatedScript, `\uFEFF${script}`, 'utf8');

  // 防御：若上一次的产物仍被占用（例如同时还开着安装程序），先尝试删除并给出明确提示
  if (fs.existsSync(outFile)) {
    try {
      fs.rmSync(outFile, { force: true });
    } catch {
      throw new Error(
        `无法覆盖已有安装程序（可能仍在运行/被杀毒软件占用）：${outFile}\n请关闭该安装程序后重试。`,
      );
    }
  }

  log(`生成安装程序：${path.relative(root, outFile)}`);
  run(makensis, ['/V2', generatedScript], { cwd: outRoot });
  return outFile;
}

/* ------------------------------------------------------------ 主流程 */

function main() {
  log(`版本 ${VERSION}`);
  ensureBuilds();

  // 迭代打包时可加 --reuse-deps 复用已安装的 node_modules，跳过 2 分钟的 npm install
  const reuseDeps = process.argv.includes('--reuse-deps');
  const hasDeps = fs.existsSync(path.join(staging, 'node_modules'));

  if (!(reuseDeps && hasDeps)) {
    fs.rmSync(staging, { recursive: true, force: true });
  } else {
    log('复用已安装的 node_modules（--reuse-deps）');
    // 只保留依赖安装结果，其余目录重新生成，避免残留上一次打包的文件
    for (const dir of ['server', 'web', 'logs']) {
      fs.rmSync(path.join(staging, dir), { recursive: true, force: true });
    }
  }
  fs.mkdirSync(staging, { recursive: true });

  log('组装运行时...');
  writeRuntimeManifest();
  if (reuseDeps && hasDeps) {
    log('跳过依赖安装');
  } else {
    installDependencies();
  }
  buildRuntime();
  writeEnvironmentFile();
  writeRuntimeScripts();
  writeReadme();

  const installer = buildInstaller();

  const sizeMb = (target) => {
    let total = 0;
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else total += fs.statSync(full).size;
      }
    };
    walk(target);
    return Math.round(total / 1024 / 1024);
  };

  log(`免安装目录：${path.relative(root, staging)}（${sizeMb(staging)} MB）`);
  if (installer)
    log(
      `安装程序：${path.relative(root, installer)}（${Math.round(fs.statSync(installer).size / 1024 / 1024)} MB）`,
    );
  log('完成。');
}

main();
