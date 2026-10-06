/**
 * 文档站本地预览用的最小静态服务器（构建产物 docs/_site）。
 * 正式发布走 GitHub Pages（.github/workflows/pages.yml：官网在根、文档站在 /docs/），不需要这个文件。
 *
 *   node docs/build.mjs --serve     → 构建后直接预览（推荐）
 *   node docs/serve.mjs             → http://127.0.0.1:5181（要求已经构建过）
 *   PORT=8080 node docs/serve.mjs
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('_site/', import.meta.url)));
const PORT = Number(process.env.PORT ?? 5181);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const requested = decodeURIComponent(url.pathname);
  const target = normalize(join(ROOT, requested === '/' ? 'index.html' : requested));

  // 目录穿越防护：解析结果必须仍在 ROOT 里
  if (target !== ROOT && !target.startsWith(ROOT + sep)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const info = await stat(target);
    const file = info.isDirectory() ? join(target, 'index.html') : target;
    const body = await readFile(file);
    response.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    response.end(body);
  } catch {
    // 与 GitHub Pages 行为对齐：未知路径给站点根的 404.html
    const fallback = join(ROOT, '404.html');
    if (existsSync(fallback)) {
      response.writeHead(404, { 'content-type': MIME['.html'] }).end(await readFile(fallback));
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  if (!existsSync(ROOT)) {
    console.warn('还没有构建产物，先跑 `node docs/build.mjs`');
  }
  console.log(`文档站预览：http://127.0.0.1:${PORT}`);
});
