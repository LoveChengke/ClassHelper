import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { env } from '../config/env.js';
import { prisma } from './db.js';
import { logger } from './logger.js';
import { hashPassword } from './password.js';

/**
 * 首次启动时的数据库初始化（SQLite/libSQL）。
 *
 * 场景：安装程序首次运行、Docker 挂载了空数据卷、用户手动删除了数据库文件。
 * 做法：若目标库中还没有业务表，就把随包发布的 Prisma 迁移 SQL 依次执行一遍。
 *
 * 说明：
 * - 只处理 SQLite（本项目打包安装的默认形态）；
 *   MySQL 请在部署流程中执行 `prisma migrate deploy`（Docker 镜像已内置该步骤）。
 * - 迁移文件按目录名（时间戳）升序执行，与 Prisma 的行为一致。
 */

/** 迁移文件所在目录（打包后随 server 一起发布） */
function migrationsRoot(): string {
  const candidates = [
    env.isProduction ? path.resolve(env.serverRoot, 'prisma', 'migrations') : '',
    path.resolve(env.serverRoot, 'prisma', 'migrations'),
    path.resolve(env.serverRoot, '..', 'prisma', 'migrations'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.resolve(env.serverRoot, 'prisma', 'migrations');
}

/** 收集迁移 SQL 文件（按目录名升序） */
export function listMigrationFiles(): string[] {
  const root = migrationsRoot();
  if (!fs.existsSync(root)) return [];

  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => path.join(root, name, 'migration.sql'))
    .filter((file) => fs.existsSync(file));
}

/** 业务表是否已存在（用 User 表作为探针） */
async function schemaExists(): Promise<boolean> {
  try {
    const rows = await prisma.$queryRaw<Array<{ name: string }>>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'User'
    `;
    return rows.length > 0;
  } catch {
    return false;
  }
}

export interface BootstrapResult {
  applied: number;
  skipped: boolean;
  detail: string;
}

/**
 * 初始化管理员账号。
 *
 * 全新安装的数据库是空的，没有任何账号可登录，因此首次启动（AUTO_MIGRATE=true）
 * 会创建一个管理员账号；如果使用的是默认密码，会在日志中给出醒目提示。
 */
export async function ensureInitialAdmin(): Promise<{ created: boolean; username: string }> {
  const existing = await prisma.user.count({ where: { role: 'ADMIN' } });
  if (existing > 0) return { created: false, username: env.initialAdminUsername };

  await prisma.user.create({
    data: {
      username: env.initialAdminUsername,
      name: '系统管理员',
      role: 'ADMIN',
      passwordHash: await hashPassword(env.initialAdminPassword),
    },
  });

  if (env.initialAdminPassword === 'admin123') {
    logger.warn(
      `已创建初始管理员 ${env.initialAdminUsername} / ${env.initialAdminPassword}（默认密码），请登录后立即在「修改密码」中更换`,
    );
  } else {
    logger.info(`已创建初始管理员账号：${env.initialAdminUsername}`);
  }

  return { created: true, username: env.initialAdminUsername };
}

/**
 * 确保数据库结构存在。
 * 仅在 AUTO_MIGRATE=true 时由启动流程调用。
 */
export async function ensureSchema(): Promise<BootstrapResult> {
  if (env.databaseProvider !== 'sqlite') {
    return {
      applied: 0,
      skipped: true,
      detail: '非 SQLite 数据库：请在部署流程中执行 prisma migrate deploy',
    };
  }

  if (await schemaExists()) {
    return { applied: 0, skipped: true, detail: '数据库结构已存在，跳过初始化' };
  }

  const files = listMigrationFiles();
  if (files.length === 0) {
    return { applied: 0, skipped: true, detail: '未找到迁移文件，请手动执行 pnpm db:migrate' };
  }

  const client = createClient({ url: env.databaseUrl });
  let applied = 0;
  try {
    for (const file of files) {
      const sql = fs.readFileSync(file, 'utf8');
      await client.executeMultiple(sql);
      applied += 1;
      logger.info(`已应用迁移：${path.basename(path.dirname(file))}`);
    }
  } finally {
    client.close();
  }

  return { applied, skipped: false, detail: `已应用 ${applied} 个迁移文件` };
}
