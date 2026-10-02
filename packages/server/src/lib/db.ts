import { PrismaLibSql } from '@prisma/adapter-libsql';
import { PrismaClient } from '../generated/prisma/client.js';
import { env } from '../config/env.js';
import { logger } from './logger.js';

/** 本项目支持的主数据库类型（Redis 等键值库不是 Prisma 支持的主库，不在范围内） */
export type DatabaseProvider = 'sqlite' | 'mysql';

/**
 * Prisma 7 要求所有数据库都通过 driver adapter 接入：
 *  - SQLite -> @prisma/adapter-libsql（libSQL 内嵌模式，npm 预编译二进制，无需本地编译）
 *  - MySQL  -> @prisma/adapter-mariadb（依赖里常驻，切换数据库时直接可用）
 *
 * MySQL 分支使用「非字面量模块名」动态导入，这样未安装 mariadb 适配器时
 * 也不会影响类型检查与 SQLite 模式的运行。
 *
 * 该工厂独立于进程级单例：数据库管理模块的「连接测试」与跨库迁移的工具进程
 * 都需要按任意 provider/url 构建临时客户端，而不是读 env 单例。
 */
export async function createPrismaClient(
  provider: DatabaseProvider,
  url: string,
): Promise<PrismaClient> {
  if (provider === 'mysql') {
    const adapterModule = '@prisma/adapter-mariadb';
    const mod = (await import(adapterModule)) as { PrismaMariaDb: new (url: string) => unknown };
    return new PrismaClient({ adapter: new mod.PrismaMariaDb(url) as never });
  }
  return new PrismaClient({ adapter: new PrismaLibSql({ url }) as never });
}

export const prisma = await createPrismaClient(env.databaseProvider, env.databaseUrl);

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
