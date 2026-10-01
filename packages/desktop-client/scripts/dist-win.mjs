/**
 * Windows 打包入口（等价于 electron-builder --win，但做了三件工程化处理）：
 *
 * 1) 复用本地已解压的 Electron：node_modules/electron/dist 存在时通过
 *    --config.electronDist 直接使用，避免再下载 150MB+ 发行包（受网络影响最大的步骤）。
 * 2) 默认使用国内镜像（可用环境变量覆盖）：
 *      ELECTRON_MIRROR                   Electron 发行包
 *      ELECTRON_BUILDER_BINARIES_MIRROR  nsis / winCodeSign 等构建工具
 * 3) 缓存固定到仓库内的 .cache 目录，便于清理与迁移，不污染用户全局目录。
 *
 * 用法：
 *   node scripts/dist-win.mjs            # nsis 安装包 + portable 单文件
 *   node scripts/dist-win.mjs --dir      # 仅生成免安装目录 release/win-unpacked
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveNodeRuntime } from '../../../scripts/lib/node-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(root, '..', '..');
const args = process.argv.slice(2);
const dirOnly = args.includes('--dir');
const passthrough = args.filter((item) => item !== '--dir');

// makensis 会在 %TEMP% 所在位置建临时文件：Git Bash 里 TEMP=/tmp 是 MSYS 路径，
// 原生程序会把它当成「当前盘根下的 tmp」（D:\tmp，不存在）而报
// `!tempfile: Unable to create temporary file!`，NSIS 那一步就失败（磁盘并不紧张）。
// 统一指到仓库内的真实目录，避开宿主终端带来的环境差异。
const tmpDir = path.join(repoRoot, '.cache', 'tmp');
fs.mkdirSync(tmpDir, { recursive: true });

const env = {
  ...process.env,
  TEMP: tmpDir,
  TMP: tmpDir,
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR ?? 'https://cdn.npmmirror.com/binaries/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR:
    process.env.ELECTRON_BUILDER_BINARIES_MIRROR ??
    'https://npmmirror.com/mirrors/electron-builder-binaries/',
  ELECTRON_BUILDER_CACHE:
    process.env.ELECTRON_BUILDER_CACHE ?? path.join(repoRoot, '.cache', 'electron-builder'),
  ELECTRON_CACHE: process.env.ELECTRON_CACHE ?? path.join(repoRoot, '.cache', 'electron'),
};

const localElectronDist = path.join(root, 'node_modules', 'electron', 'dist');
const overrides = [];
if (fs.existsSync(path.join(localElectronDist, 'electron.exe'))) {
  overrides.push(`--config.electronDist=${localElectronDist}`);
  console.log('[dist] 复用本地已解压的 Electron：', localElectronDist);
} else {
  console.log('[dist] 未找到本地 Electron，将由 electron-builder 下载（镜像：' + env.ELECTRON_MIRROR + '）');
}

const cli = path.join(root, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
if (!fs.existsSync(cli)) {
  console.error('[dist] 未找到 electron-builder，请先执行 pnpm install');
  process.exit(2);
}

const cliArgs = [cli, '--win', ...(dirOnly ? ['--dir'] : []), ...overrides, ...passthrough];
console.log('[dist] electron-builder', cliArgs.slice(1).join(' '));

// 必须用真正的 node 执行 electron-builder CLI：
// 若宿主终端是 Electron（本机 pnpm 即如此），process.execPath 会指向 Electron，
// 直接 spawn 会让 Electron 把 cli.js 当成应用入口，多出一个位置参数，
// electron-builder 报 `Unknown argument: .../cli.js`。
const runtime = resolveNodeRuntime();
console.log(`[dist] Node 运行时：${runtime.path}（${runtime.version}）`);

// 清理上一轮产物：本仓库目录树带沙箱 ACL（含 Everyone 的 DENY(delete child)），
// 已存在的产物会被工具（makensis / 7za）判为"Can't open output file / 拒绝访问"而失败，
// 手动删掉再打包即可 —— 顺手也保证产物集合确定，不会残留上一轮的旧安装包。
const outputDir = path.join(root, 'release');
if (fs.existsSync(outputDir)) {
  for (const name of fs.readdirSync(outputDir)) {
    if (!/\.(exe|7z|blockmap|yml)$/i.test(name)) continue;
    try {
      fs.rmSync(path.join(outputDir, name), { force: true });
    } catch (error) {
      console.warn(`[dist] 无法清理旧产物 ${name}：${error.message}`);
    }
  }
  console.log('[dist] 已清理上一轮的安装包 / 归档');
}

const child = spawn(runtime.path, cliArgs, { cwd: root, stdio: 'inherit', env });

/**
 * 把交付产物的完整性标签修正为 Medium（Windows）。
 *
 * 背景（踩过一次，代价是"客户端装不上、便捷版也双击没反应"）：
 *   本仓库目录树被宿主沙箱打上了 `Low Mandatory Level` 标签（可继承），
 *   因此在仓库内构建出的 exe 自身也带 Low 标签。Windows 会把这类进程降到 Low 完整性，
 *   于是 setup.exe 写不进 `%LOCALAPPDATA%`（报"拒绝访问"→ 装不上）、
 *   便捷版解不出 `%TEMP%`（→ 起不来）；即使装上了，Low 标签的应用文件也会让
 *   Chromium 的 AppContainer 子进程读不到（0x80000003 秒崩）。
 *
 *   要点：**只有交付物自身的标签要紧**。归档内部的载荷标签不会被还原
 *   （装到正常位置得到的是默认 Medium 文件），所以打包完成后再统一修正即可 ——
 *   反过来说，不能在打包前把 appOutDir 改成 Medium：那样 7za（自身 Low）
 *   会因"不能向上读/写"而无法生成归档。
 */
function normalizeIntegrityLabel(dir) {
  if (process.platform !== 'win32') return;
  const run = (args) => execFileSync('icacls', args, { stdio: 'pipe', windowsHide: true });
  try {
    run([dir, '/setintegritylevel', 'Medium', '/T', '/C']);
    // 目录自身恢复为"继承父目录的 Low"，保证下次构建时 Low 的 7za 仍能写入归档
    run([dir, '/setintegritylevel', '(OI)(CI)Low']);
    console.log('[dist] 已修正交付物完整性标签为 Medium，目录恢复继承：', dir);
  } catch (error) {
    console.warn('[dist] 完整性标签修正跳过：', error.message);
  }
}

child.on('exit', (code) => {
  if (code === 0) {
    const output = path.join(root, 'release');
    normalizeIntegrityLabel(output);
    console.log('\n[dist] 打包完成，产物目录：', output);
  }
  process.exit(code ?? 1);
});
