import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { API_PREFIX } from '@classhelper/shared';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { disconnectPrisma, pingDatabase } from './lib/db.js';
import { ensureInitialAdmin, ensureSchema } from './lib/db-bootstrap.js';
import { logger } from './lib/logger.js';
import { resolveWebDistDir } from './lib/web-static.js';
import { initRealtime } from './realtime/socket.js';

/** 数据库自检与可选的首次初始化 */
async function prepareDatabase(): Promise<void> {
  // SQLite：确保数据文件所在目录存在，否则 libsql 会以 SQLITE_CANTOPEN(14) 失败
  if (env.sqliteFilePath) {
    try {
      fs.mkdirSync(path.dirname(env.sqliteFilePath), { recursive: true });
    } catch (error) {
      logger.warn(`创建数据目录失败：${path.dirname(env.sqliteFilePath)}`, error);
    }
  }

  if (env.autoMigrate) {
    try {
      const result = await ensureSchema();
      logger.info(`数据库初始化：${result.detail}`);
      const admin = await ensureInitialAdmin();
      if (admin.created) logger.info('可使用该账号登录 Web 管理端，并立即修改密码');
    } catch (error) {
      logger.error('数据库初始化失败', error);
    }
  }

  if (!env.startupDbCheck) return;

  if (await pingDatabase()) {
    logger.info('数据库连接正常');
    return;
  }

  logger.error(
    '数据库连接失败：请检查 DATABASE_URL，并确认已执行迁移（pnpm db:migrate / prisma migrate deploy）',
  );
  if (env.isProduction) {
    logger.error('生产环境启动中止：数据库不可用时不应对外提供服务');
    process.exit(1);
  }
}

await prepareDatabase();

const app = createApp();
const httpServer = createServer(app);
const io = initRealtime(httpServer);

/** 写入 PID 文件（安装包的 start.cmd / stop.cmd 依赖它精确控制进程） */
function writePidFile(): void {
  if (!env.pidFile) return;
  try {
    fs.mkdirSync(path.dirname(env.pidFile), { recursive: true });
    fs.writeFileSync(env.pidFile, String(process.pid), 'utf8');
  } catch (error) {
    logger.warn('写入 PID 文件失败', error);
  }
}

function removePidFile(): void {
  if (!env.pidFile) return;
  try {
    if (fs.existsSync(env.pidFile)) fs.unlinkSync(env.pidFile);
  } catch {
    // 忽略清理失败
  }
}

httpServer.listen(env.port, env.host, () => {
  writePidFile();
  const displayHost = env.host === '0.0.0.0' ? '127.0.0.1' : env.host;
  const webDir = resolveWebDistDir();
  logger.info(`班级小助手后端已启动：http://${displayHost}:${env.port}${API_PREFIX}`);
  logger.info(`运行环境：${env.nodeEnv} · 监听：${env.host}:${env.port} · 数据库：${env.databaseProvider}`);
  if (webDir) {
    logger.info(`Web 管理端：http://${displayHost}:${env.port}/（静态目录 ${webDir}）`);
  }
  logger.info(`探针：/healthz（存活） · /readyz（就绪） · ${API_PREFIX}/health（详情）`);
  logger.info(`WebSocket：ws://${displayHost}:${env.port}/socket.io`);
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`收到 ${signal}，正在优雅关闭...`);

  // 停止接收新连接，并给在途请求 5 秒收尾时间
  const forceExit = setTimeout(() => {
    logger.warn('关闭超时，强制退出');
    process.exit(1);
  }, 5000);
  forceExit.unref();

  await new Promise<void>((resolve) => io.close(() => resolve()));
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await disconnectPrisma();
  removePidFile();
  clearTimeout(forceExit);
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
process.on('uncaughtException', (error) => {
  logger.error('未捕获异常，进程即将退出', error);
  void shutdown('uncaughtException');
});
