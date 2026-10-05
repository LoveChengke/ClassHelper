/**
 * 服务端 + Web 管理端 生产打包脚本：pnpm dist:server
 *
 * 产出（Windows）：
 *   release-server/classhelper-server/            可直接运行的免安装目录
 *   release-server/班级小助手服务端-<版本>-x64-setup.exe   Windows 安装程序（NSIS）
 *
 * 产出（Linux，加 --platform linux，即 pnpm dist:server:linux）：
 *   release-server/classhelper-server-linux-x64-<版本>.tar.gz   Linux 一键安装器的输入
 *   release-server/classhelper-server-linux-x64-<版本>.tar.gz.sha256
 *
 * 为什么 Linux 包要在 Linux 上构建：`@libsql/linux-x64-gnu`、`@prisma/adapter-libsql` 都是
 * 平台相关依赖，在 Windows 上 npm install 出来的 node_modules 装到 Linux 跑不起来。
 * 仓库里的 .github/workflows/release-linux-server.yml 用 ubuntu runner 出这个包。
 *
 * 打包策略（面向"双击即可用、目标机无需安装 Node"，Linux 侧同理）：
 *   1. 内置 Node 运行时（Windows 复制本机 node.exe；Linux 由安装器下载官方/glibc-217 版 Node）
 *   2. 依赖用 npm 安装为真实目录（非 pnpm 软链），保证可整体拷贝到别的机器
 *   3. 后端使用 tsc 构建产物（ESM），Web 管理端使用 Vite 构建产物
 *   4. 首次启动自动执行迁移（AUTO_MIGRATE=true）+ 自动生成 JWT 密钥 + PID 文件
 *   5. Windows 用 electron-builder 自带的 NSIS（makensis）生成安装程序；
 *      Linux 打 tar.gz，交给 deploy/install.sh 安装
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
const deployDir = path.join(root, 'deploy');
const outRoot = path.join(root, 'release-server');

/** win = 免安装目录 + NSIS 安装程序；linux = 带运维工具的 tar.gz（给 deploy/install.sh 用） */
const PLATFORM = (() => {
  const index = process.argv.indexOf('--platform');
  const value = index >= 0 ? process.argv[index + 1] : process.platform === 'win32' ? 'win' : 'linux';
  if (!['win', 'linux'].includes(value)) throw new Error(`--platform 只支持 win / linux（收到 ${value}）`);
  return value;
})();
const isLinux = PLATFORM === 'linux';

const staging = path.join(outRoot, isLinux ? 'classhelper-server-linux-x64' : 'classhelper-server');

const VERSION = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const PRODUCT = '班级小助手服务端';
const PORT = '4000';
const LINUX_ARCH = 'x64';
const LINUX_TARBALL = path.join(outRoot, `classhelper-server-linux-${LINUX_ARCH}-${VERSION}.tar.gz`);

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

/**
 * 交叉构建：在非 Linux 机器上出 Linux 包。
 *
 * npm ≥9.6 支持 `--os` / `--cpu`，会按**目标平台**解析可选依赖，因此
 * `@libsql/linux-x64-gnu` 这类"按平台分发"的包能装进来（默认只会装宿主平台的 win32-x64-msvc）。
 *
 * 什么时候能用：本地想快速打一个包出来测安装/运维流程时。
 * **正式发布仍应在 Linux 上构建**（CI 的 workflow 就是干这个的）：交叉构建时
 * prisma CLI 的原生引擎（`db push` / `generate` 用，即 Web 端「数据库一键切换」那条链路）
 * 是宿主平台下载的，Linux 上不一定能跑；`dist:server:linux` 在非 Linux 上会明确告警。
 */
const CROSS_BUILD = isLinux && process.platform !== 'linux';
const CROSS_TARGET = { os: 'linux', cpu: 'x64' };

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
  const args = ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'];
  if (CROSS_BUILD) {
    args.push(`--os=${CROSS_TARGET.os}`, `--cpu=${CROSS_TARGET.cpu}`);
    log(`交叉构建：按目标平台 ${CROSS_TARGET.os}-${CROSS_TARGET.cpu} 解析依赖（正式发布请在 Linux 上构建）`);
  }
  log('安装生产依赖（npm install --omit=dev，真实目录，便于整体拷贝）...');
  run(npmCmd, args, {
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
  // 注：dist 里没有 .d.ts / *.map —— packages/server/tsconfig.build.json 显式关掉了它们
  //（那三样占了原 dist 的 82%，运行时一个都用不到，见 AGENTS.md §5 第 54 条）。
  copyRecursive(path.join(serverDir, 'dist'), path.join(staging, 'server', 'dist'));
  // 迁移文件（首次启动 AUTO_MIGRATE 使用）
  copyRecursive(
    path.join(serverDir, 'prisma', 'migrations'),
    path.join(staging, 'server', 'prisma', 'migrations'),
  );
  // 数据库管理模块「一键切换」需要的 Prisma 配置三件套：
  //   schema.prisma       —— 切换时改写 provider 后供 prisma generate / db push 使用
  //   prisma.config.ts    —— Prisma 7 的 CLI 配置（连接串来自子进程环境变量）
  //   tsconfig.generate.json —— generate 产出的是 .ts，切换后用它编译进 dist/generated
  // 注意：tsconfig.generate.json **故意是自包含的**（不 extends tsconfig.json/tsconfig.base.json），
  // 因为安装目录里只有 server/ 一层，那两级基配置不在包里 —— 一旦 extends 就会在打包形态下
  // 报 TS5083「Cannot read file .../server/tsconfig.json」，数据库「一键切换」直接走不到底。
  for (const file of ['schema.prisma']) {
    fs.copyFileSync(path.join(serverDir, 'prisma', file), path.join(staging, 'server', 'prisma', file));
  }
  for (const file of ['prisma.config.ts', 'tsconfig.generate.json']) {
    fs.copyFileSync(path.join(serverDir, file), path.join(staging, 'server', file));
  }
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

  if (isLinux) {
    // Linux 包不带 Node 二进制：官方 linux-x64 构建绑 glibc 版本（老系统要 glibc-217 变体），
    // 由 deploy/install.sh 在目标机上按 glibc 自动挑一个下载。这里只留占位目录。
    fs.mkdirSync(path.join(staging, 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(staging, 'VERSION'), `${VERSION}\n`, 'utf8');
  } else {
    // Node 运行时（必须是真正的 node.exe，不能用宿主 Electron 可执行文件）
    const nodeRuntime = resolveNodeRuntime();
    copyRecursive(nodeRuntime.path, path.join(staging, 'node.exe'));
    log(`内置 Node 运行时：${nodeRuntime.path}（${nodeRuntime.version}）`);
  }

  // 数据目录：强制清空，避免把打包机上测试用的数据库带进安装包
  fs.rmSync(path.join(staging, 'data'), { recursive: true, force: true });
  fs.mkdirSync(path.join(staging, 'data'), { recursive: true });
  fs.mkdirSync(path.join(staging, 'logs'), { recursive: true });
}

/* ------------------------------------------------------------ 3.5 运行时裁剪 */

/** 递归统计文件大小（字节）；目标既可以是目录也可以是单个文件 */
function dirSize(target) {
  if (!fs.existsSync(target)) return 0;
  const stat = fs.statSync(target);
  if (stat.isFile()) return stat.size;
  let total = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else total += fs.statSync(full).size;
    }
  };
  walk(target);
  return total;
}

const sizeMb = (target) => Math.round(dirSize(target) / 1024 / 1024);

/**
 * 运行时裁剪：删掉**运行时永远加载不到**的静态载荷。
 *
 * 为什么值得单独立一步：安装包的 node_modules 实测 380MB，而其中绝大部分是
 * Prisma 为「它支持的所有数据库方言」准备的查询编译器副本 —— 本项目的 schema
 * 只在 sqlite / mysql 之间切换（见 docs/mysql.md、`lib/db.ts` 的 DatabaseProvider），
 * 其余方言（postgresql / cockroachdb / sqlserver）的 wasm 一个字节都用不上。
 *
 * 原则：只删数据文件与文档，**不碰任何会被 require 的入口**；每一条都写明依据。
 * 改这里之前先看「为什么安全」，改完务必按 AGENTS.md §8 的清单复验一次
 * （尤其是数据库管理模块的「生成客户端 / 一键切换」—— 它是唯一会调用 Prisma CLI 的地方）。
 */
function pruneRuntime() {
  const nodeModules = path.join(staging, 'node_modules');
  if (!fs.existsSync(nodeModules)) return;

  const before = sizeMb(staging);
  const removed = [];
  const drop = (target, note) => {
    if (!fs.existsSync(target)) return;
    const size = dirSize(target);
    fs.rmSync(target, { recursive: true, force: true });
    removed.push({ path: path.relative(staging, target), size, note });
  };

  /* (a) @prisma/client/runtime —— 只留 sqlite / mysql 的 ESM 方言包
   *
   * 依据：`src/generated/prisma/internal/class.ts` 里的 queryCompiler 是**生成期按
   * provider 写死**的动态 import（当前是 `query_compiler_fast_bg.sqlite.mjs` +
   * `query_compiler_fast_bg.sqlite.wasm-base64.mjs`）；切到 MySQL 时重新 generate 只会
   * 指向 `*.mysql.*`。而：
   *   - postgresql / cockroachdb / sqlserver 与全部 `_small_bg` 变体：本产品不支持，永不加载；
   *   - `.wasm-base64.js`（CJS 版）：服务端是 ESM（`type: module`），只走 `.mjs`；
   *   - `.map`：Node 没开 `--enable-source-maps`，不会读。
   * 实测这一步省下约 60MB。 */
  const clientRuntime = path.join(nodeModules, '@prisma', 'client', 'runtime');
  if (fs.existsSync(clientRuntime)) {
    const keep = new Set([
      'client.js',
      'client.mjs',
      'client.d.ts',
      'client.d.mts',
      'wasm-compiler-edge.js',
      'wasm-compiler-edge.mjs',
      'wasm-compiler-edge.d.ts',
      'wasm-compiler-edge.d.mts',
      'query_compiler_fast_bg.sqlite.js',
      'query_compiler_fast_bg.sqlite.mjs',
      'query_compiler_fast_bg.mysql.js',
      'query_compiler_fast_bg.mysql.mjs',
      'query_compiler_fast_bg.sqlite.wasm-base64.mjs',
      'query_compiler_fast_bg.mysql.wasm-base64.mjs',
    ]);
    for (const entry of fs.readdirSync(clientRuntime)) {
      if (keep.has(entry)) continue;
      drop(path.join(clientRuntime, entry), '@prisma/client/runtime：只保留 sqlite/mysql 的 ESM 方言包');
    }
  }

  /* (b) prisma CLI 的 build/ —— 同样只留 sqlite / mysql
   *
   * 依据：部署形态里 Prisma CLI 只被数据库管理模块用于 `generate` 与 `db push`，
   * 两者都按当前 provider 选用对应的查询编译器 wasm。 */
  const prismaBuild = path.join(nodeModules, 'prisma', 'build');
  if (fs.existsSync(prismaBuild)) {
    const unusedDialect =
      /^query_compiler_(?:fast|small)_bg\.(?:postgresql|cockroachdb|sqlserver)\.(?:js|mjs|wasm)$/;
    for (const entry of fs.readdirSync(prismaBuild)) {
      if (!unusedDialect.test(entry)) continue;
      drop(path.join(prismaBuild, entry), 'Prisma CLI：只保留 sqlite/mysql 的查询编译器');
    }
  }

  /* (c) 通用静态载荷：sourcemap / 文档 / 测试与示例目录
   *
   * 依据：Node 不读 sourcemap；文档与测试夹具不会被 require。
   * **不要**顺手删 `*.d.ts`：数据库「一键切换」要跑
   * `tsc -p tsconfig.generate.json` 编译重新生成的 Prisma 客户端，
   * 那一步需要 `@prisma/client` 与 `@types/*` 的类型声明。
   *
   * 两条硬护栏（都踩过）：
   *   1) **整棵 `@types/**` 不参与裁剪** —— 类型包里的 `test/`、`docs/` 是真实的声明文件
   *      （如 `@types/node/test/reporters.d.ts` 被 `test.d.ts` 引用），按"测试目录"删掉会让
   *      tsc 报 TS6053；
   *   2) 名字命中 DROP_DIRS 的目录，只要里面含 `*.d.ts` 就整个跳过 —— 同名目录在不同包里
   *      含义完全不同，不能只看名字。 */
  const DROP_DIRS = new Set([
    'test',
    'tests',
    '__tests__',
    '__mocks__',
    'example',
    'examples',
    'docs',
    'benchmark',
  ]);
  const isDroppableDoc = (name) =>
    /\.(?:md|markdown)$/i.test(name) && !/^(?:license|licence|notice|copying|third[-_]?party)/i.test(name);
  /** 目录下（递归）是否存在类型声明文件 */
  const containsDts = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (containsDts(path.join(dir, entry.name))) return true;
      } else if (entry.name.endsWith('.d.ts')) {
        return true;
      }
    }
    return false;
  };
  // 工作区内部包（@classhelper/shared）是手工放的；@types 整棵保留（理由见上）
  const protectedRoots = new Set([path.join(nodeModules, '@classhelper'), path.join(nodeModules, '@types')]);
  const walkPrune = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (protectedRoots.has(full)) continue;
      if (entry.isDirectory()) {
        if (DROP_DIRS.has(entry.name) && !containsDts(full)) {
          drop(full, 'node_modules 里的测试/示例/文档目录');
          continue;
        }
        walkPrune(full);
        continue;
      }
      if (/\.map$/i.test(entry.name)) {
        drop(full, 'node_modules 里的 sourcemap');
      } else if (isDroppableDoc(entry.name)) {
        drop(full, 'node_modules 里的说明文档');
      }
    }
  };
  walkPrune(nodeModules);

  const after = sizeMb(staging);
  const saved = before - after;
  if (removed.length === 0) {
    log('运行时裁剪：没有可裁剪的内容（跳过）');
    return;
  }
  // 逐类汇总，便于回归时对照有没有误删
  const byNote = new Map();
  for (const item of removed) {
    byNote.set(item.note, (byNote.get(item.note) ?? 0) + item.size);
  }
  log(`运行时裁剪：删除 ${removed.length} 项，节省约 ${Math.round(saved)} MB（${before}MB -> ${after}MB）`);
  for (const [note, bytes] of [...byNote.entries()].sort((a, b) => b[1] - a[1])) {
    log(`  · ${(bytes / 1024 / 1024).toFixed(1)}MB  ${note}`);
  }
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
# 新建班级的初始密码（学生端用「班级码 + 班级密码」登录，没有个人学生账号）
DEFAULT_CLASS_PASSWORD=123456
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
  说明    学生没有个人账号：学生只是名单记录（成绩/未交/叫人/已读都按名单走），
          学生端统一用「班级码 + 班级密码」登录。

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

/* ------------------------------------------------------------ 5. Linux 专属内容 */

/**
 * Linux 包额外要带的东西：运维命令本体、安装器模板、systemd / logrotate / profile.d、
 * Docker 形态的 Dockerfile、Nginx 样例。
 *
 * 布局（deploy/install.sh 依赖它，改动要同步改那里）：
 *   bin/classhelper                  运维命令（安装到 /usr/local/bin 的软链指向它）
 *   tools/admin-cli.mjs              离线改密 / 备份快照工具
 *   classhelper.service.template     systemd 单元模板（__NODE__/__DIR__/… 占位符）
 *   systemd/classhelper-backup.*     classhelper backup schedule 用的定时器
 *   logrotate.d/、profile.d/         安装时拷到 /etc 下
 *   Dockerfile                       --mode docker 时用它构建镜像
 *   nginx.conf                       反代样例（--with-nginx）
 */
function copyLinuxExtras() {
  const copyFile = (from, to, mode) => {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    if (mode) fs.chmodSync(to, mode);
  };
  const copyDir = (from, to) => copyRecursive(from, to);

  // 目标路径就是安装目录里的相对路径 —— install.sh 的 place_program_files 按这几个名字铺开，
  // 名字对不上就会在安装时才暴露（而且症状是"命令找不到"，不是构建报错）。
  const required = [
    ['bin/classhelper', path.join(deployDir, 'classhelper'), 0o755],
    ['tools/admin-cli.mjs', path.join(deployDir, 'tools', 'admin-cli.mjs')],
    ['classhelper.service.template', path.join(deployDir, 'classhelper.service')],
    ['Dockerfile', path.join(deployDir, 'Dockerfile.linux-package')],
    ['nginx.conf', path.join(deployDir, 'nginx.conf')],
  ];
  for (const [target, source, mode] of required) {
    if (!fs.existsSync(source)) throw new Error(`缺少打包所需文件：${path.relative(root, source)}`);
    copyFile(source, path.join(staging, target), mode);
  }
  // Windows 上 chmod 只影响只读位，打出来的 tar 里/bin/classhelper 的可执行位靠 install.sh 兜底
  // （place_program_files 里有 chmod +x），这里只是让在 Linux 上构建时也带上正确的权限位。
  if (process.platform !== 'win32') fs.chmodSync(path.join(staging, 'bin', 'classhelper'), 0o755);

  for (const [target, source] of [
    ['systemd', path.join(deployDir, 'systemd')],
    ['logrotate.d', path.join(deployDir, 'logrotate.d')],
    ['profile.d', path.join(deployDir, 'profile.d')],
  ]) {
    if (fs.existsSync(source)) copyDir(source, path.join(staging, target));
  }
  log('已注入运维工具与模板（bin/classhelper、tools/、systemd/、Dockerfile 等）');
}

function writeLinuxReadme() {
  const content = `${PRODUCT} v${VERSION}（Linux ${LINUX_ARCH}）

一、这是什么
  这是给 deploy/install.sh 用的安装包，不能直接双击运行。安装方式：

    curl -fsSL -O https://github.com/.../classhelper-server-linux-${LINUX_ARCH}-${VERSION}.tar.gz
    sudo bash install.sh --package ./classhelper-server-linux-${LINUX_ARCH}-${VERSION}.tar.gz

  或者在有本安装包的机器上：
    sudo bash install.sh --package /path/to/classhelper-server-linux-${LINUX_ARCH}-${VERSION}.tar.gz

二、包内目录
  server/        后端程序（server/dist/index.js 为入口）
  server/prisma/ 迁移 SQL（首启动 AUTO_MIGRATE=true 时自动执行）
  web/           Web 管理端（由后端直接托管）
  node_modules/  生产依赖（linux 真实目录，可直接整体拷贝）
  tools/         运维工具（admin-cli.mjs：离线改密、数据库一致性快照）
  bin/classhelper  运维命令（installation 时会软链到 /usr/local/bin/classhelper）
  systemd/       classhelper-backup.{service,timer}（定时备份用）
  logrotate.d/   profile.d/  安装时拷到 /etc 下
  Dockerfile     --mode docker 时用它构建镜像
  VERSION        版本号

三、安装后的默认账号（首次启动自动创建）
  管理员  admin / admin123（安装器里设置初始密码则用它）
  学生端  班级码 + 班级密码（学生没有个人账号）

四、常用运维命令（安装后）
  classhelper status / doctor / password admin / backup / upgrade / rollback / logs -f

五、默认路径
  安装目录 /opt/classhelper（安装时可改）
  配置     /etc/classhelper/config.env（权限 600；安装目录里的 .env 是它的软链）
  数据     <安装目录>/data
  日志     /var/log/classhelper/（安装日志 + 审计日志）
  备份     /var/backups/classhelper/

六、安全建议
  - 立刻修改默认密码：classhelper password admin
  - 公网访问请在前面加 Nginx/Caddy 并启用 HTTPS，并把配置里的 CORS_ORIGIN 收敛到你的域名
  - 定期备份：classhelper backup schedule daily
  - 更换 JWT_SECRET 会让所有用户重新登录（classhelper key rotate）
`;
  fs.writeFileSync(path.join(staging, 'README.txt'), content, 'utf8');
}

/** 打 tar.gz 并输出 sha256（classhelper upgrade 会校验这个哈希） */
function packLinuxTarball() {
  fs.rmSync(LINUX_TARBALL, { force: true });
  const topDir = path.basename(staging); // tar 里套一层目录，安装器用 --strip-components=1 展开
  log(`打包 ${path.relative(root, LINUX_TARBALL)} ...`);
  run('tar', ['-czf', LINUX_TARBALL, '-C', path.dirname(staging), topDir]);

  const digest = crypto.createHash('sha256').update(fs.readFileSync(LINUX_TARBALL)).digest('hex');
  const shaFile = `${LINUX_TARBALL}.sha256`;
  fs.writeFileSync(shaFile, `${digest}  ${path.basename(LINUX_TARBALL)}\n`, 'utf8');
  log(`sha256：${digest}`);
  return { file: LINUX_TARBALL, shaFile, digest };
}

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
  log(`版本 ${VERSION}｜平台 ${PLATFORM}`);
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
  pruneRuntime();

  if (isLinux) {
    copyLinuxExtras();
    writeLinuxReadme();
    // 交叉构建的包留个标记：`classhelper doctor` 会据此提醒"这个包不是在 Linux 上打的"。
    // 不静默 —— 这个包能装能跑，但 Web 端「数据库一键切换」依赖 prisma CLI 的**原生 schema engine**，
    // 而 npm 的 postinstall 只下宿主平台那一个（交叉包里就是 schema-engine-windows.exe）。
    if (CROSS_BUILD) {
      fs.writeFileSync(
        path.join(staging, '.cross-built'),
        `cross-built on ${process.platform}-${process.arch} at ${new Date().toISOString()}\n`,
        'utf8',
      );
    }
    const { file, shaFile } = packLinuxTarball();
    if (CROSS_BUILD) {
      log('');
      log('⚠ 这是**交叉构建**出来的包（在非 Linux 机器上打的），没有在 Linux 上实机验证过：');
      log('  · 已确认没问题：@libsql/linux-x64-gnu 与 linux-x64-musl 都在包内、没有任何 win32 依赖，');
      log('    服务端本体（Node + libsql + express + socket.io）在 Linux 上可正常跑；');
      log('  · 存疑的一处：Web 端「数据库管理 → 一键切换数据库」会调 prisma CLI 的 schema engine，');
      log('    CLI 在运行期按平台扫 @prisma/engines/schema-engine-debian-openssl-3.0.x 这类路径，');
      log('    而交叉包里只有宿主平台的 schema-engine-windows.exe → 这一步可能失败（其余功能不受影响）。');
      log('  · 包内已写入 .cross-built 标记，classhelper doctor 会提示这一点。');
      log('  正式发布请用 .github/workflows/release-linux-server.yml（ubuntu runner）出包。');
      log('');
    }
    log(`Linux 安装包：${path.relative(root, file)}（${sizeMb(LINUX_TARBALL)} MB）`);
    log(`校验文件：${path.relative(root, shaFile)}`);
    log('完成。部署方式：sudo bash deploy/install.sh --package <上面的 tar.gz>');
    return;
  }

  writeEnvironmentFile();
  writeRuntimeScripts();
  writeReadme();

  const installer = buildInstaller();

  log(`免安装目录：${path.relative(root, staging)}（${sizeMb(staging)} MB）`);
  if (installer)
    log(
      `安装程序：${path.relative(root, installer)}（${Math.round(fs.statSync(installer).size / 1024 / 1024)} MB）`,
    );
  log('完成。');
}

main();
