import express, { type Express, type Request, type Response } from 'express';
import compression from 'compression';
import cors from 'cors';
import { API_PREFIX } from '@classhelper/shared';
import { env } from './config/env.js';
import { pingDatabase } from './lib/db.js';
import { sendOk } from './lib/http.js';
import { logger } from './lib/logger.js';
import { mountWebAdmin, resolveWebDistDir } from './lib/web-static.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { apiRateLimiter, loginRateLimiter, requestLogger, securityHeaders } from './middleware/security.js';
import { apiModules } from './modules/registry.js';

/** 存活探针：进程活着即 200（供容器 livenessProbe / 守护进程使用） */
function livenessHandler(_req: Request, res: Response): void {
  res.status(200).json({
    success: true,
    data: { status: 'alive', uptimeSeconds: Math.round(process.uptime()) },
    message: 'ok',
  });
}

/** 就绪探针：数据库可连才 200，否则 503（供负载均衡摘流 / 安装程序自检） */
async function readinessHandler(_req: Request, res: Response): Promise<void> {
  const connected = await pingDatabase();
  if (!connected) {
    res
      .status(503)
      .json({ success: false, data: { database: false }, message: '数据库不可用', code: 'NOT_READY' });
    return;
  }
  res.status(200).json({ success: true, data: { database: true }, message: 'ready' });
}

async function healthHandler(_req: Request, res: Response): Promise<void> {
  sendOk(
    res,
    {
      status: 'ok',
      version: '0.1.0',
      env: env.nodeEnv,
      uptimeSeconds: Math.round(process.uptime()),
      database: {
        provider: env.databaseProvider,
        connected: await pingDatabase(),
      },
      modules: apiModules.map((module) => module.name),
      webAdmin: env.webDistDir ? 'configured' : 'auto',
    },
    '服务运行正常',
  );
}

/**
 * 根路径。
 * - 已托管 Web 管理端且客户端接受 HTML：交给静态资源与 SPA 回退处理（即打开管理端首页）
 * - 否则返回服务信息页（浏览器）或 JSON（API 客户端）
 */
function createRootHandler(webDistDir: string | null) {
  return (req: Request, res: Response, next: express.NextFunction): void => {
    if (webDistDir && req.accepts(['html', 'json']) === 'html') {
      next();
      return;
    }

    if (req.accepts(['html', 'json']) === 'json') {
      sendOk(
        res,
        {
          service: 'class-helper-server',
          version: '0.1.0',
          environment: env.nodeEnv,
          apiPrefix: API_PREFIX,
          socket: '/socket.io',
          webAdmin: webDistDir ? '/' : 'http://127.0.0.1:5173',
          health: `${API_PREFIX}/health`,
          liveness: '/healthz',
          readiness: '/readyz',
          modules: apiModules.map((module) => `${API_PREFIX}${module.basePath}`),
        },
        '服务运行正常，API 前缀为 /api',
      );
      return;
    }

    res.type('html').send(renderLandingPage(Boolean(webDistDir)));
  };
}

function renderLandingPage(webAdminServed: boolean): string {
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
      .card { max-width: 760px; margin: 0 auto; background: #fff; border: 1px solid #e4e7ed; border-radius: 12px; padding: 28px 32px; }
      h1 { margin: 0 0 6px; font-size: 20px; }
      p.sub { margin: 0 0 8px; color: #909399; font-size: 13px; }
      .ok { display: inline-block; padding: 2px 10px; border-radius: 999px; background: #f0f9eb; color: #67c23a; font-size: 12px; }
      ul { columns: 2; padding-left: 18px; margin: 12px 0 0; }
      li { margin: 6px 0; font-size: 13px; }
      li span { color: #c0c4cc; }
      code { background: #f5f7fa; padding: 1px 6px; border-radius: 4px; font-size: 12px; }
      a { color: #409eff; text-decoration: none; }
      .hint { margin-top: 22px; padding-top: 16px; border-top: 1px dashed #e4e7ed; font-size: 13px; color: #606266; line-height: 1.9; }
      .btn { display: inline-block; margin-top: 4px; padding: 8px 16px; background: #409eff; color: #fff !important; border-radius: 6px; font-size: 13px; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>班级小助手 · 后端服务 <span class="ok">running</span></h1>
      <p class="sub">版本 0.1.0 · 运行环境 ${env.nodeEnv} · 数据库 ${env.databaseProvider}</p>
      <p class="sub">
        健康检查 <a href="${API_PREFIX}/health">${API_PREFIX}/health</a> ·
        存活 /healthz · 就绪 /readyz
      </p>
      ${webAdminServed ? '<a class="btn" href="/">打开 Web 管理端</a>' : '<p class="sub">Web 管理端未随本服务托管，请单独启动（pnpm dev:web → http://127.0.0.1:5173）。</p>'}
      <strong>已挂载模块（${apiModules.length} 个）</strong>
      <ul>${moduleRows}</ul>
      <div class="hint">
        WebSocket 端点：<code>ws://${env.host === '0.0.0.0' ? '本机地址' : env.host}:${env.port}/socket.io</code><br />
        本服务只提供 REST API 与 WebSocket；学生端请使用「班级小助手」桌面客户端。
      </div>
    </div>
  </body>
</html>`;
}

/** 组装 Express 应用：安全中间件 -> 健康检查 -> 模块路由 -> Web 静态托管 -> 404 -> 统一错误处理 */
export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');

  // 反向代理场景下正确识别客户端 IP（限流、日志依赖）
  app.set('trust proxy', env.trustProxy);

  const webDistDir = resolveWebDistDir();

  app.use(securityHeaders());
  app.use(compression());
  app.use(cors({ origin: env.corsOrigins, credentials: true }));
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(requestLogger());

  // 探针（不参与限流）
  app.get('/healthz', livenessHandler);
  app.get('/readyz', (req, res) => {
    void readinessHandler(req, res);
  });
  app.get(`${API_PREFIX}/health`, (req, res) => {
    void healthHandler(req, res);
  });
  app.get('/health', (req, res) => {
    void healthHandler(req, res);
  });

  // 根路径信息页（Web 管理端托管时让位给前端首页）
  app.get('/', createRootHandler(webDistDir));

  // 浏览器会自动请求 favicon；有前端产物时交给静态托管处理
  if (!webDistDir) {
    app.get('/favicon.ico', (_req, res) => {
      res.status(204).end();
    });
  }

  // 限流：先挂通用限流，再挂更严格的登录限流（后挂者决定响应头里的策略，便于观察暴力破解防护）
  app.use(API_PREFIX, apiRateLimiter());
  app.use(`${API_PREFIX}/auth/login`, loginRateLimiter());

  // 模块化装配：注册表里的每个模块挂载到 /api<basePath>
  for (const module of apiModules) {
    const mountPath = `${API_PREFIX}${module.basePath}`;
    app.use(mountPath, module.router);
    logger.info(`已挂载模块 ${module.name.padEnd(14)} -> ${mountPath}`);
  }

  // Web 管理端静态资源 + SPA 回退（必须放在 API 之后）
  mountWebAdmin(app);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
