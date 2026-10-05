import fs from 'node:fs';
import path from 'node:path';
import express, { type Express } from 'express';
import { env } from '../config/env.js';
import { logger } from './logger.js';

/**
 * Web 管理端静态托管（生产模式）。
 *
 * 部署形态：后端同时充当 Web 管理端的静态服务器 —— 单端口即可访问
 * `http://<host>:4000/` 打开管理端，`/api` 与 `/socket.io` 走同一端口，
 * 因此不再需要额外的 Nginx/Vite 进程（需要 HTTPS/域名时在前面加反向代理）。
 *
 * 目录探测顺序：
 *   1) 环境变量 WEB_DIST_DIR
 *   2) Monorepo 开发布局：<serverRoot>/../web-admin/dist
 *   3) 安装包布局：<serverRoot>/web
 */
export function resolveWebDistDir(): string | null {
  const candidates = [
    env.webDistDir,
    path.resolve(env.serverRoot, '..', 'web-admin', 'dist'),
    path.resolve(env.serverRoot, 'web'),
    path.resolve(env.serverRoot, '..', 'web'),
  ].filter((item): item is string => Boolean(item));

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'index.html'))) return candidate;
  }
  return null;
}

/**
 * 挂载静态资源与 SPA 回退。
 * 仅在探测到构建产物时生效；否则保持纯 API 服务（开发模式下 Web 端由 Vite 提供）。
 */
export function mountWebAdmin(app: Express): string | null {
  const distDir = resolveWebDistDir();
  if (!distDir) {
    logger.info('未检测到 Web 管理端构建产物，跳过静态托管（仅提供 API 与 WebSocket）');
    return null;
  }

  // 带内容哈希的构建产物：长缓存
  // dotfiles: 'allow' —— 安装/部署目录路径里可能含点号目录（如 .cache、/opt/.apps），
  // 默认的 'ignore' 会让 express.static / res.sendFile 直接 404（进而 500）
  app.use(
    '/assets',
    express.static(path.join(distDir, 'assets'), {
      immutable: true,
      maxAge: '1y',
      fallthrough: true,
      index: false,
      dotfiles: 'allow',
    }),
  );

  // 其余静态文件（favicon、manifest、service worker 等）：短缓存
  app.use(
    express.static(distDir, {
      maxAge: '1h',
      etag: true,
      index: false,
      dotfiles: 'allow',
      setHeaders: (res, filePath) => {
        // Service Worker 与 index.html 不能被长缓存，否则更新不生效
        if (filePath.endsWith('sw.js') || filePath.endsWith('index.html')) {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    }),
  );

  const indexHtml = path.join(distDir, 'index.html');

  /**
   * SPA 回退：非 /api、非 /socket.io、且接受 HTML 的 GET 请求统一返回 index.html，
   * 保证前端路由（/grades、/classes/xxx 等）刷新后仍可用。
   */
  app.get(/^\/(?!api\/|socket\.io\/|healthz$|readyz$).*/, (req, res, next) => {
    if (!req.accepts('html')) {
      next();
      return;
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(indexHtml, { dotfiles: 'allow' }, (error) => {
      if (!error) return;
      logger.error(`返回 Web 管理端首页失败：${indexHtml}`, error);
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          data: null,
          message: 'Web 管理端资源不可用，请检查构建产物是否完整',
          code: 'WEB_DIST_UNAVAILABLE',
        });
      }
    });
  });

  logger.info(`Web 管理端已挂载：${distDir}`);
  return distDir;
}
