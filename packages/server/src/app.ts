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
