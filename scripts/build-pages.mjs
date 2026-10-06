#!/usr/bin/env node
/**
 * 组装 GitHub Pages 站点 —— `pnpm pages:build`，CI 里由 .github/workflows/pages.yml 调用。
 *
 * ## 为什么需要它
 *
 * **一个仓库在 GitHub Pages 上只有一个站点**，但我们要发布两个东西：
 * 产品官网（`website/`，纯静态、无构建步骤）与文档站（`docs/`，docfx 构建出来）。
 * 于是把两者拼成一个站点，按这个布局：
 *
 *   <站点根>/            官网（website/ 的内容）
 *   <站点根>/docs/       文档站（docs/_site 的内容）
 *
 * 官网在根、文档站在 `/docs/` 下 —— 产品页的地址最短最好分享，文档站多一层路径没有代价。
 *
 * ## 三件容易忽略的事
 *
 * ① **404 页要注入站点根**。Pages 对任何未知路径都返回**站点根**的 404.html，
 *    而浏览器是按**被请求的那个路径**解析页面里的相对链接的 —— 不钉 `<base>`，
 *    访问 `/ClassHelper/docs/typo` 时页面上所有链接都会指到 `/ClassHelper/docs/` 下面去。
 *    （文档站自己那份 `docs/404.html` 只在「文档站被单独托管」时才用得上，合并站点里备而不用。）
 * ② **官网目录里那两个开发用的东西不能发出去**：`serve.mjs`（本地预览服务器）与
 *    `tools/`（实机截图采集脚本，会真的开 Electron 窗口）。它们对静态托管没有意义。
 * ③ **`.nojekyll`**：现在走的是 `actions/upload-pages-artifact`，不经过 Jekyll，
 *    但留着这个文件不花任何代价，万一哪天切回分支发布也不会因为 `_` 开头的目录被吞掉。
 *
 * 用法：
 *   node scripts/build-pages.mjs                      # 输出到 .cache/pages/
 *   SITE_BASE=/ClassHelper/ node scripts/build-pages.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const websiteDir = path.join(root, 'website');
const docsDir = path.join(root, 'docs', '_site');
const outDir = path.join(root, '.cache', 'pages');

/** 站点根路径。CI 里按仓库名传（项目页挂在 /<仓库名>/ 下），本地预览用 './'。 */
const BASE = process.env.SITE_BASE ?? './';

/** 官网目录里不发出去的东西（开发用） */
const SKIP = new Set(['serve.mjs', '404.html']); // 404.html 要注入 base，单独处理
const SKIP_DIRS = new Set(['tools']);

function copyWebsite() {
  for (const entry of fs.readdirSync(websiteDir, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    if (entry.isFile() && SKIP.has(entry.name)) continue;
    fs.cpSync(path.join(websiteDir, entry.name), path.join(outDir, entry.name), { recursive: true });
  }
}

function main() {
  if (!fs.existsSync(path.join(docsDir, 'index.html'))) {
    console.error('[pages] 找不到 docs/_site —— 先跑 `pnpm docs:build`。');
    process.exit(1);
  }

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(outDir, 'docs'), { recursive: true });

  copyWebsite();
  fs.cpSync(docsDir, path.join(outDir, 'docs'), { recursive: true });

  // 站点根的 404：把 {{BASE}} 换成站点根路径
  const notFound = fs.readFileSync(path.join(websiteDir, '404.html'), 'utf8').replaceAll('{{BASE}}', BASE);
  fs.writeFileSync(path.join(outDir, '404.html'), notFound, 'utf8');

  // 见文件头 ③
  fs.writeFileSync(path.join(outDir, '.nojekyll'), '', 'utf8');

  const count = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).reduce((sum, entry) => {
      if (entry.isDirectory()) return sum + count(path.join(dir, entry.name));
      return sum + 1;
    }, 0);

  console.log(`[pages] 站点已组装到 ${path.relative(root, outDir)}（base = ${BASE}）`);
  console.log(`[pages]   根   ← website/        ${count(outDir) - count(path.join(outDir, 'docs'))} 个文件`);
  console.log(`[pages]   docs/ ← docs/_site/    ${count(path.join(outDir, 'docs'))} 个文件`);
}

try {
  main();
} catch (error) {
  console.error('[pages] 失败：', error.message);
  process.exit(1);
}
