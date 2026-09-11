import { createServer } from 'node:http';
import { API_PREFIX } from '@classhelper/shared';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { disconnectPrisma, pingDatabase } from './lib/db.js';
import { logger } from './lib/logger.js';
import { initRealtime } from './realtime/socket.js';

const app = createApp();
const httpServer = createServer(app);
const io = initRealtime(httpServer);

if (!(await pingDatabase())) {
  logger.warn('数据库连接失败：请先执行 pnpm db:migrate 与 pnpm db:seed');
}

httpServer.listen(env.port, () => {
  logger.info(`班级小助手后端已启动：http://127.0.0.1:${env.port}${API_PREFIX}`);
  logger.info(`健康检查：http://127.0.0.1:${env.port}${API_PREFIX}/health`);
  logger.info(`WebSocket：ws://127.0.0.1:${env.port}/socket.io`);
  logger.info(`运行环境：${env.nodeEnv}，数据库：${env.databaseProvider}`);
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`收到 ${signal}，正在优雅关闭...`);

  await new Promise<void>((resolve) => io.close(() => resolve()));
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await disconnectPrisma();
  logger.info('已关闭所有连接');
  process.exit(0);
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.on('unhandledRejection', (reason) => {
  logger.error('未处理的 Promise 拒绝', reason);
});
