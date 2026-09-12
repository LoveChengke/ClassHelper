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
 * 场景：安装程序首次运行、覆盖安装升级、Docker 挂载了空数据卷、用户手动删除了数据库文件。
 * 做法：以 `_ch_migrations` 账本表记录已执行的迁移；启动时按时间戳顺序补跑未记录的迁移。
 *      全新库会跑全部迁移，旧库只补跑新增迁移（已存在的表/索引自动跳过）。
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

/**
 * 迁移账本表名。
 *
 * 老版本安装（1.0 之前）只区分「空库 / 非空库」，因此升级安装时不会补建新表。
 * 现在用一张账本表记录已执行过的迁移目录名，启动时只补跑未记录的迁移，
 * 这样「覆盖安装升级」也能自动获得新表/新索引。
 */
const MIGRATION_LEDGER = '_ch_migrations';

/** 这些错误表示对象已存在，属于「旧版本已经建过」的正常情况，可安全忽略 */
const IGNORABLE_SQL_ERROR = /already exists|duplicate column name|duplicate index/i;

/** 拆分 migration.sql 为独立语句（去掉注释行，过滤空语句） */
function splitStatements(sql: string): string[] {
  return sql
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/** 确保账本表存在，返回已记录的迁移名 */
async function loadAppliedMigrations(client: {
  execute: (sql: string) => Promise<unknown>;
}): Promise<Set<string>> {
  await client.execute(
    `CREATE TABLE IF NOT EXISTS "${MIGRATION_LEDGER}" ("name" TEXT NOT NULL PRIMARY KEY, "appliedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  );

  const rows = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT name FROM "${MIGRATION_LEDGER}"`,
  );
  return new Set(rows.map((row) => row.name));
}

interface MigrationOutcome {
  file: string;
  applied: number;
  skipped: number;
}

/** 执行单个迁移文件：逐条语句执行，已存在的对象跳过，其余错误上抛 */
async function applyMigration(
  client: { execute: (sql: string) => Promise<unknown> },
  file: string,
): Promise<MigrationOutcome> {
  const sql = fs.readFileSync(file, 'utf8');
  const outcome: MigrationOutcome = { file, applied: 0, skipped: 0 };

  for (const statement of splitStatements(sql)) {
    try {
      await client.execute(statement);
      outcome.applied += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (IGNORABLE_SQL_ERROR.test(message)) {
        outcome.skipped += 1;
        continue;
      }
      throw new Error(
        `迁移 ${path.basename(path.dirname(file))} 执行失败：${message}\nSQL: ${statement.slice(0, 200)}`,
      );
    }
  }

  await client.execute({
    // libsql 的 execute 支持参数化对象形式
    sql: `INSERT OR REPLACE INTO "${MIGRATION_LEDGER}" ("name", "appliedAt") VALUES (?, CURRENT_TIMESTAMP)`,
    args: [path.basename(path.dirname(file))],
  } as never);

  return outcome;
}

/** 计算待执行的迁移文件 */
export async function listPendingMigrations(): Promise<string[]> {
  const files = listMigrationFiles();
  if (files.length === 0) return [];

  const client = createClient({ url: env.databaseUrl });
  try {
    const applied = await loadAppliedMigrations(
      client as unknown as {
        execute: (sql: string) => Promise<unknown>;
      },
    );
    return files.filter((file) => !applied.has(path.basename(path.dirname(file))));
  } catch (error) {
    logger.warn('读取迁移账本失败，按全部待执行处理', error);
    return files;
  } finally {
    client.close();
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
 * 确保数据库结构存在（增量迁移）。
 * 仅在 AUTO_MIGRATE=true 时由启动流程调用。
 *
 * - 全新数据库：依次执行全部迁移；
 * - 旧版本升级：只补跑账本里没有记录的迁移（已存在的对象自动跳过）；
 * - 已是最新：直接返回，不做任何写操作。
 */
export async function ensureSchema(): Promise<BootstrapResult> {
  if (env.databaseProvider !== 'sqlite') {
    return {
      applied: 0,
      skipped: true,
      detail: '非 SQLite 数据库：请在部署流程中执行 prisma migrate deploy',
    };
  }

  const files = listMigrationFiles();
  if (files.length === 0) {
    return { applied: 0, skipped: true, detail: '未找到迁移文件，请手动执行 pnpm db:migrate' };
  }

  const freshInstall = !(await schemaExists());
  const client = createClient({ url: env.databaseUrl });

  try {
    const applied = await loadAppliedMigrations(
      client as unknown as {
        execute: (sql: string) => Promise<unknown>;
      },
    );
    const pending = files.filter((file) => !applied.has(path.basename(path.dirname(file))));

    if (pending.length === 0) {
      return { applied: 0, skipped: true, detail: '数据库结构已是最新，无需迁移' };
    }

    let reused = 0;
    for (const file of pending) {
      const outcome = await applyMigration(
        client as unknown as { execute: (sql: string) => Promise<unknown> },
        file,
      );
      reused += outcome.skipped;
      logger.info(
        `已应用迁移：${path.basename(path.dirname(file))}` +
          (outcome.skipped > 0 ? `（跳过 ${outcome.skipped} 个已存在对象）` : ''),
      );
    }

    const mode = freshInstall ? '全新安装' : '升级安装';
    return {
      applied: pending.length,
      skipped: false,
      detail: `${mode}：已应用 ${pending.length} 个迁移文件${reused > 0 ? `，跳过 ${reused} 个已存在对象` : ''}`,
    };
  } finally {
    client.close();
  }
}
