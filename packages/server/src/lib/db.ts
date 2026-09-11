import { PrismaLibSql } from '@prisma/adapter-libsql';
import { PrismaClient } from '../generated/prisma/client.js';
import { env } from '../config/env.js';
import { logger } from './logger.js';

/**
 * Prisma 7 要求所有数据库都通过 driver adapter 接入：
 *  - SQLite -> @prisma/adapter-libsql（libSQL 内嵌模式，npm 预编译二进制，无需本地编译）
 *  - MySQL  -> @prisma/adapter-mariadb（切换数据库时安装，见 docs/mysql.md）
 *
 * MySQL 分支使用「非字面量模块名」动态导入，这样未安装 mariadb 适配器时
 * 也不会影响类型检查与 SQLite 模式的运行。
 */
async function createAdapter(): Promise<unknown> {
  if (env.databaseProvider === 'mysql') {
    const adapterModule = '@prisma/adapter-mariadb';
    const mod = (await import(adapterModule)) as { PrismaMariaDb: new (url: string) => unknown };
    logger.info('已加载 MySQL/MariaDB 驱动适配器');
    return new mod.PrismaMariaDb(env.databaseUrl);
  }
  return new PrismaLibSql({ url: env.databaseUrl });
}

const adapter = await createAdapter();

export const prisma = new PrismaClient({ adapter: adapter as never });

logger.info(`Prisma 客户端已初始化（provider=${env.databaseProvider}）`);

/** 进程退出时释放连接 */
export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}

/** 供健康检查使用：确认数据库可连通 */
export async function pingDatabase(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (error) {
    logger.error('数据库连接检查失败', error);
    return false;
  }
}
