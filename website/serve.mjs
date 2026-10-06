/**
 * 官网本地预览用的最小静态服务器 —— 只是为了 `node serve.mjs` 能直接看页面。
 * 正式发布时把 website/ 整个目录丢给任意静态托管 / Nginx 即可，不需要这个文件。
 *
 *   node website/serve.mjs          → http://127.0.0.1:5180
 *   PORT=8080 node website/serve.mjs
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.env.PORT ?? 5180);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
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
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`官网预览：http://127.0.0.1:${PORT}`);
});
