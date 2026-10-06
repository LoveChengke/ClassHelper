/**
 * ClassIsland 联动插件构建脚本：`pnpm build:classisland-plugin` / `pnpm dist:classisland-plugin`
 *
 * 用法：
 *   node scripts/build.mjs              # Release 构建，产物在 packages/classisland-plugin/bin/Release
 *   node scripts/build.mjs --cipx       # 追加打包 .cipx 并归集到 releases/classisland-plugin/<版本>/
 *   额外参数会原样透传给 `dotnet build`（例如 `-p:ClassIslandPluginSdkVersion=2.1.1.1`）
 *
 * 为什么需要这层包装（本机踩过的坑，写在这里免得换台机器又踩一遍）：
 *   1. `dotnet` 默认把 NuGet 缓存与临时文件写在 C 盘（`%USERPROFILE%\.nuget`、`%TEMP%`），
 *      本机 C 盘紧张时会直接构建失败。这里统一改到仓库内 `.cache/`（已 gitignore）。
 *   2. 插件包（.cipx）的最后一步要调 PowerShell 生成哈希清单，SDK 默认用 `pwsh`；
 *      没有 pwsh 的机器会失败，因此这里探测一次并显式传给 MSBuild。
 *   3. 构建完顺手校验"清单 / 程序集 / 版本号"三者一致，避免打出装不上的包。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(pluginDir, '..', '..');
const cacheDir = path.join(repoRoot, '.cache');
const releasesRoot = path.join(repoRoot, 'releases', 'classisland-plugin');

const argv = process.argv.slice(2);
const withCipx = argv.includes('--cipx');
/** `--` 之后的参数原样透传给 dotnet build；其余以 - 开头的参数同样透传 */
const passthrough = argv.filter((item) => item !== '--cipx' && item !== '--');

const log = (message) => console.log(`[classisland-plugin] ${message}`);

/* ------------------------------------------------------------ 1. 环境准备 */

const env = { ...process.env };
for (const sub of ['nuget', 'tmp', 'dotnet-home']) {
  fs.mkdirSync(path.join(cacheDir, sub), { recursive: true });
}
const setDefault = (key, value) => {
  if (!env[key]) env[key] = value;
};
setDefault('NUGET_PACKAGES', path.join(cacheDir, 'nuget'));
setDefault('TEMP', path.join(cacheDir, 'tmp'));
setDefault('TMP', env.TEMP);
setDefault('DOTNET_CLI_HOME', path.join(cacheDir, 'dotnet-home'));
env.DOTNET_NOLOGO = '1';
env.DOTNET_CLI_TELEMETRY_OPTOUT = '1';

/** 可执行文件探测：先看显式配置，再问 PATH，最后试常见安装路径 */
function resolveExecutable(envKey, names, fallbacks) {
  const candidates = [];
  if (env[envKey]) candidates.push(env[envKey]);
  const finder = process.platform === 'win32' ? 'where' : 'which';
  for (const name of names) {
    const found = spawnSync(finder, [name], { encoding: 'utf8', env });
    if (found.status === 0) {
      for (const line of String(found.stdout ?? '').split(/\r?\n/)) candidates.push(line.trim());
    }
  }
  candidates.push(...fallbacks);
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* 继续试下一个 */
    }
  }
  return null;
}

const dotnet = resolveExecutable(
  'DOTNET_EXE',
  ['dotnet'],
  process.platform === 'win32'
    ? [path.join(env.ProgramFiles ?? 'C:\\Program Files', 'dotnet', 'dotnet.exe')]
    : ['/usr/local/bin/dotnet', '/usr/bin/dotnet'],
);
if (!dotnet) {
  throw new Error('未找到 dotnet SDK（需要 .NET 8 SDK）。安装后用 DOTNET_EXE 指定完整路径。');
}

const powerShell = resolveExecutable(
  'POWERSHELL_EXE',
  ['pwsh', 'powershell'],
  process.platform === 'win32'
    ? [path.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')]
    : [],
);

/* ------------------------------------------------------------ 2. 构建 */

const buildArgs = ['build', '-c', 'Release'];
if (withCipx) {
  buildArgs.push('-p:CreateCipx=true');
  // SDK 的 cipx 目标默认调 pwsh；这里按探测结果显式指定，避免"没有 pwsh 就打包失败"
  if (powerShell) buildArgs.push(`-p:PowershellBinaryName=${powerShell}`);
}
buildArgs.push(...passthrough);

log(`dotnet build（缓存目录 ${path.relative(repoRoot, cacheDir)}）`);
const build = spawnSync(dotnet, buildArgs, { cwd: pluginDir, stdio: 'inherit', env });
if (build.error) throw new Error(`无法启动 dotnet：${build.error.message}`);
if (build.status !== 0) throw new Error(`dotnet build 失败（退出码 ${build.status}）`);

/* ------------------------------------------------------------ 3. 产物自检 */

const outputDir = path.join(pluginDir, 'bin', 'Release');
const manifestPath = path.join(outputDir, 'manifest.yml');
const assemblyPath = path.join(outputDir, 'ClassHelper.ClassIslandPlugin.dll');

for (const required of [manifestPath, assemblyPath, path.join(outputDir, 'icon.png')]) {
  if (!fs.existsSync(required)) {
    throw new Error(`构建产物缺少 ${path.relative(pluginDir, required)}，ClassIsland 会加载失败`);
  }
}

const manifest = fs.readFileSync(manifestPath, 'utf8');
// prettier 会把 YAML 字符串统一成单引号，因此两种引号都要能剥掉
const entrance = /^entranceAssembly:\s*(.+?)\s*$/m.exec(manifest)?.[1]?.replace(/^['"]|['"]$/g, '');
if (entrance !== path.basename(assemblyPath)) {
  throw new Error(
    `manifest.yml 的 entranceAssembly（${entrance}）与程序集（${path.basename(assemblyPath)}）不一致`,
  );
}
const manifestVersion = /^version:\s*([\d.]+)/m.exec(manifest)?.[1];
const bridgeSource = fs.readFileSync(path.join(pluginDir, 'src', 'Services', 'BridgeService.cs'), 'utf8');
const codeVersion = /PluginVersion = "([\d.]+)"/.exec(bridgeSource)?.[1];
if (!manifestVersion || manifestVersion !== codeVersion) {
  throw new Error(
    `版本号不一致：manifest.yml=${manifestVersion ?? '缺失'}，BridgeService.cs=${codeVersion ?? '缺失'}`,
  );
}
log(`产物自检通过（版本 ${manifestVersion}，入口程序集 ${entrance}）`);

/* ------------------------------------------------------------ 4. 打包归集 */

if (!withCipx) {
  log('完成。加 --cipx 可同时打包成 ClassIsland 插件包（.cipx）');
  process.exit(0);
}

const cipxDir = path.join(pluginDir, 'cipx');
const cipxFile = path.join(cipxDir, 'ClassHelper.ClassIslandPlugin.cipx');
if (!fs.existsSync(cipxFile)) {
  throw new Error(`未生成插件包：${path.relative(pluginDir, cipxFile)}`);
}

// 归集到 releases/classisland-plugin/<版本>/（与客户端、服务端交付产物同一约定；releases/ 不入库）。
// 只清理**当前版本**目录，历史版本原样保留 —— 原先这里是 rmSync 整个组件目录，重打一次就把
// 上一版的留档抹掉了（插件版本是四段 <产品版本>.0，目录名取前三段与产品版本对齐）。
const pluginVersion = manifestVersion.split('.').slice(0, 3).join('.');
const versionDir = path.join(releasesRoot, pluginVersion);
const installerDir = path.join(versionDir, '安装包');
const portableDir = path.join(versionDir, '免安装', 'ClassHelper.ClassIslandPlugin');
fs.rmSync(installerDir, { recursive: true, force: true });
fs.rmSync(path.dirname(portableDir), { recursive: true, force: true });
fs.mkdirSync(installerDir, { recursive: true });
fs.mkdirSync(portableDir, { recursive: true });

// 免安装目录：解压即用，直接放进 ClassIsland 的 Plugins 目录也能加载
for (const name of fs.readdirSync(outputDir)) {
  const from = path.join(outputDir, name);
  if (!fs.statSync(from).isFile()) continue;
  // 依赖清单与调试符号对加载没影响，但会让老师误以为"要装一堆东西"，因此只带最小集合
  if (!['ClassHelper.ClassIslandPlugin.dll', 'manifest.yml', 'icon.png', 'README.md'].includes(name)) {
    continue;
  }
  fs.copyFileSync(from, path.join(portableDir, name));
}

for (const file of fs.readdirSync(cipxDir)) {
  // .cipx 是插件包本体，校验清单跟着版本目录走
  const to = file.toLowerCase().endsWith('.cipx') ? installerDir : versionDir;
  fs.copyFileSync(path.join(cipxDir, file), path.join(to, file));
}

log(`插件包已归集到 ${path.relative(repoRoot, versionDir)}`);
for (const file of fs.readdirSync(installerDir)) log(`  安装包/${file}`);
for (const file of fs.readdirSync(portableDir)) log(`  免安装/ClassHelper.ClassIslandPlugin/${file}`);
