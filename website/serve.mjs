/**
 * 官网本地预览用的最小静态服务器 —— 只是为了 `node serve.mjs` 能直接看页面。
 * 正式发布时把 website/ 与 docs/_site/ 一起交给静态托管即可，不需要这个文件。
 *
 *   node website/serve.mjs          → http://127.0.0.1:5180
 *   PORT=8080 node website/serve.mjs
 *
 * 线上两者是同一个 GitHub Pages 站点：官网在根，文档站在 /docs/ 下（见 .github/workflows/pages.yml）。
 * 这里把 docs/_site 挂到 /docs/ 就是为了让本地与线上同形 —— 否则页脚那几个「文档站」链接
 * 在本地全是 404。文档站没构建过时 /docs/ 会 404，先跑一次 `pnpm docs:build`。
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const DOCS_ROOT = resolve(ROOT, '..', 'docs', '_site');
const PORT = Number(process.env.PORT ?? 5180);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const requested = decodeURIComponent(url.pathname);

  // 文档站挂在 /docs/ 下（线上也是这样）
  const underDocs = requested === '/docs' || requested.startsWith('/docs/');
  const base = underDocs ? DOCS_ROOT : ROOT;
  const relative = underDocs ? requested.replace(/^\/docs\/?/, '/') : requested;
  const target = normalize(join(base, relative === '/' ? 'index.html' : relative));

  // 目录穿越防护：解析结果必须仍在它所属的根里
  if (target !== base && !target.startsWith(base + sep)) {
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
    if (underDocs) {
      response
        .writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
        .end(
          '<p style="font:16px/1.7 system-ui;padding:40px">文档站还没构建。先跑一次 <code>pnpm docs:build</code>。</p>',
        );
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`官网预览：http://127.0.0.1:${PORT}（文档站在 /docs/）`);
});
