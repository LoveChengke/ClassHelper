#!/usr/bin/env node
/**
 * 文档站构建脚本 —— `pnpm docs:build`。
 *
 * 为什么不用直接跑 `docfx docs/docfx.json`：
 *   1) 站点版本号取自根 package.json（单一来源），DocFX 的配置文件是静态 JSON、读不了文件，
 *      只能用 CLI 的 `--metadata` 传进去（模板里以 `{{_chVersion}}` 引用）；
 *   2) GitHub Pages 的项目页挂在 /<仓库名>/ 子路径下，404 页里的相对链接必须相对**站点根**
 *      而不是相对被请求的那个不存在的路径，因此 404 页的 `<base>` 由这里注入（DOCS_BASE 控制）。
 *
 * 用法：
 *   node docs/build.mjs                 # 构建到 docs/_site
 *   DOCS_BASE=/classhelper/ node docs/build.mjs
 *   node docs/build.mjs --check         # 构建并把 docfx 的警告当成错误（CI / 交付前用）
 *   node docs/build.mjs --serve         # 构建完起本地预览（等价于再跑 docs/serve.mjs）
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const siteDir = path.join(here, '_site');

/** 站点根路径。CI 里按仓库名传进来；本地预览用 './'。 */
const BASE = process.env.DOCS_BASE ?? './';

function readVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  return pkg.version;
}

/** 找不到 docfx 时给出可照抄的安装命令，而不是一句 spawn ENOENT */
function ensureDocfx() {
  const probe = spawnSync('docfx', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
  if (probe.status === 0) return probe.stdout.trim();

  console.error('[docs] 找不到 docfx。docfx 是 .NET 工具，安装方式：');
  console.error('');
  console.error('  dotnet tool install --global docfx');
  console.error('');
  console.error('  需要 .NET SDK 8（判据是 `dotnet --list-sdks` 有输出）。');
  console.error('  想把工具装进仓库内（不污染全局）：');
  console.error('    DOTNET_CLI_HOME=./.cache/dotnet-home NUGET_PACKAGES=./.cache/nuget \\');
  console.error('      dotnet tool install --global docfx');
  process.exit(2);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: process.platform === 'win32', ...options });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} 退出码 ${code}`))));
  });
}

/**
 * 清空上一轮的产物。docfx 不负责清理，旧文件（改过名 / 删掉的页面）会一直留着，
 * 而 GitHub Pages 上传的是整个目录 —— 不清就会把已下线的页面继续挂在线上。
 */
function cleanSite() {
  const sleep = (ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      /* 同步等待：这是构建脚本，不值得为几毫秒引入异步 */
    }
  };
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      fs.rmSync(siteDir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 5) {
        throw new Error(
          `清不掉 ${path.relative(root, siteDir)}（${error.code ?? error.message}）。` +
            ' 多半是预览服务或编辑器正占用它 —— 关掉再试。',
        );
      }
      sleep(250 * attempt);
    }
  }
}

/**
 * 生成 404 页。
 * GitHub Pages 对项目页的未知路径返回站点根的 404.html，而浏览器是**按请求的路径**解析相对链接的，
 * 所以页面里的 <base> 必须显式指向站点根，否则 /classhelper/get-started/typo 会去解析
 * /classhelper/get-started/ 下的链接。本地预览时 BASE 为 './'，正好等价于同目录。
 */
function writeNotFound() {
  const template = fs.readFileSync(path.join(here, '404.html'), 'utf8');
  const html = template.replaceAll('{{BASE}}', BASE);
  fs.writeFileSync(path.join(siteDir, '404.html'), html, 'utf8');
  console.log(`[docs] 404.html（base = ${BASE}）`);
}

async function main() {
  const version = readVersion();
  const docfxVersion = ensureDocfx();
  console.log(`[docs] docfx ${docfxVersion} · 站点版本 ${version}`);

  // --check：把警告当错误。最常见的警告是"某个 .md 没被任何 toc.yml 引用"，
  // 那种页面会被构建出来但没有侧边栏，属于必须修掉的疏漏。
  const check = process.argv.includes('--check');
  const args = ['build', 'docfx.json', '--metadata', `_chVersion=${version}`];
  if (check) args.push('--warningsAsErrors');

  // docfx 只覆盖、不清理：删掉或改名的页面会以旧文件的形式留在 _site 里，
  // 而 GitHub Pages 上传的是整个目录 —— 不清理就会把已经下线的页面继续挂在线上。
  // Windows 上目录偶尔会被瞬时占用（编辑器 / 索引 / 预览进程），所以重试几次再放弃。
  cleanSite();

  await run('docfx', args, { cwd: here });

  writeNotFound();
  console.log(`[docs] 完成：${path.relative(root, siteDir)}`);

  if (process.argv.includes('--serve')) {
    await run(process.execPath, [path.join(here, 'serve.mjs')]);
  }
}

main().catch((error) => {
  console.error('[docs] 失败：', error.message);
  process.exit(1);
});
