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
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(root, '..', '..');
const args = process.argv.slice(2);
const dirOnly = args.includes('--dir');
const passthrough = args.filter((item) => item !== '--dir');

const env = {
  ...process.env,
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

const child = spawn(process.execPath, cliArgs, { cwd: root, stdio: 'inherit', env });

child.on('exit', (code) => {
  if (code === 0) {
    const output = path.join(root, 'release');
    console.log('\n[dist] 打包完成，产物目录：', output);
  }
  process.exit(code ?? 1);
});
