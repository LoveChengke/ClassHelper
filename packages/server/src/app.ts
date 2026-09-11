import express, { type Express, type Request, type Response } from 'express';
import cors from 'cors';
import { API_PREFIX } from '@classhelper/shared';
import { env } from './config/env.js';
import { pingDatabase } from './lib/db.js';
import { sendOk } from './lib/http.js';
import { logger } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { apiModules } from './modules/registry.js';

async function healthHandler(_req: Request, res: Response): Promise<void> {
  sendOk(
    res,
    {
      status: 'ok',
      version: '0.1.0',
      uptimeSeconds: Math.round(process.uptime()),
      database: {
        provider: env.databaseProvider,
        connected: await pingDatabase(),
      },
      modules: apiModules.map((module) => module.name),
    },
    '服务运行正常',
  );
}

/**
 * 根路径落地页。
 * API 全部挂在 /api 下，根路径本身不是接口；这里给出一个可读的服务首页，
 * 避免浏览器直接访问 4000 端口时看到 404 JSON 而误以为服务没起来。
 */
function renderLandingPage(): string {
  const moduleRows = apiModules
    .map((module) => `<li><code>${API_PREFIX}${module.basePath}</code> <span>${module.name}</span></li>`)
    .join('');
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>班级小助手 · 后端服务</title>
    <style>
      body { margin: 0; padding: 40px; font-family: 'PingFang SC', 'Microsoft YaHei', sans-serif; background: #f5f7fa; color: #303133; }
      .card { max-width: 720px; margin: 0 auto; background: #fff; border: 1px solid #e4e7ed; border-radius: 12px; padding: 28px 32px; }
      h1 { margin: 0 0 6px; font-size: 20px; }
      p.sub { margin: 0 0 20px; color: #909399; font-size: 13px; }
      .ok { display: inline-block; padding: 2px 10px; border-radius: 999px; background: #f0f9eb; color: #67c23a; font-size: 12px; }
      ul { columns: 2; padding-left: 18px; margin: 12px 0 0; }
      li { margin: 6px 0; font-size: 13px; }
      li span { color: #c0c4cc; }
      code { background: #f5f7fa; padding: 1px 6px; border-radius: 4px; font-size: 12px; }
      a { color: #409eff; text-decoration: none; }
      .hint { margin-top: 22px; padding-top: 16px; border-top: 1px dashed #e4e7ed; font-size: 13px; color: #606266; line-height: 1.9; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>班级小助手 · 后端服务 <span class="ok">running</span></h1>
      <p class="sub">版本 0.1.0 · 运行环境 ${env.nodeEnv} · 数据库 ${env.databaseProvider}</p>
      <p class="sub">
        健康检查：<a href="${API_PREFIX}/health">${API_PREFIX}/health</a> ·
        管理端开发地址：<a href="http://127.0.0.1:5173">http://127.0.0.1:5173</a>
      </p>
      <strong>已挂载模块（${apiModules.length} 个）</strong>
      <ul>${moduleRows}</ul>
      <div class="hint">
        提示：本服务只提供 REST API 与 WebSocket，没有网页界面。<br />
        网页界面请访问 Web 管理端 <code>http://127.0.0.1:5173</code>（pnpm dev:web），
        WebSocket 端点为 <code>ws://127.0.0.1:${env.port}/socket.io</code>。
      </div>
    </div>
  </body>
</html>`;
}

/** 组装 Express 应用：中间件 -> 健康检查 -> 模块路由 -> 404 -> 统一错误处理 */
export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(cors({ origin: env.corsOrigins, credentials: true }));
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.use((req, _res, next) => {
    logger.debug(`${req.method} ${req.originalUrl}`);
    next();
  });

  // 服务首页（浏览器可读）；如果客户端显式要 JSON，则返回结构化信息
  app.get('/', (req, res) => {
    if (req.accepts(['html', 'json']) === 'json') {
      sendOk(
        res,
        {
          service: 'class-helper-server',
          version: '0.1.0',
          apiPrefix: API_PREFIX,
          webAdmin: 'http://127.0.0.1:5173',
          socket: `/socket.io`,
          modules: apiModules.map((module) => `${API_PREFIX}${module.basePath}`),
        },
        '服务运行正常，API 前缀为 /api',
      );
      return;
    }
    res.type('html').send(renderLandingPage());
  });

  // 浏览器会自动请求 favicon，直接返回 204，避免污染日志
  app.get('/favicon.ico', (_req, res) => {
    res.status(204).end();
  });

  // 健康检查（同时暴露已挂载模块列表，便于确认模块化装配结果）
  app.get(`${API_PREFIX}/health`, healthHandler);
  app.get('/health', healthHandler);

  // 模块化装配：注册表里的每个模块挂载到 /api<basePath>
  for (const module of apiModules) {
    const mountPath = `${API_PREFIX}${module.basePath}`;
    app.use(mountPath, module.router);
    logger.info(`已挂载模块 ${module.name.padEnd(14)} -> ${mountPath}`);
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
