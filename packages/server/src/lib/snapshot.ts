import type { PrismaClient } from '../generated/prisma/client.js';
import type { DatabaseProvider } from './db.js';

/**
 * 全库 JSON 快照：备份 / 恢复 / 导入导出 / 跨库迁移共用这一种格式。
 *
 * 为什么不用「复制数据库文件」或 mysqldump：
 * - 文件级备份只对 SQLite 有意义，跨库迁移根本用不上；
 * - JSON 快照与 provider 无关，一份实现同时服务备份、导入导出和 SQLite⇄MySQL 迁移。
 *
 * 外键注意：`Class.teacherId → User` 与 `Student.classId → Class` 构成一条链，
 * 而 `Class.archivedYearId` / `Student.archivedYearId → ArchivedYear` 又是另一条；
 * 恢复时必须**临时关闭外键检查**再按序写入，否则任何排序都会被其中一侧卡死。
 * - SQLite：PRAGMA foreign_keys=OFF（libsql 连接级，进程内安全）
 * - MySQL：SET FOREIGN_KEY_CHECKS=0/1（会话级，连接池下同一客户端实例内生效）
 */

export const SNAPSHOT_FORMAT = 'classhelper-snapshot';
export const SNAPSHOT_VERSION = 1;

/**
 * 导出与恢复顺序（外键关闭后顺序不再影响写入，但保持拓扑序便于人工阅读与排查）。
 *
 * **学生不是账号**：`Student` 是独立的一张表（没有密码、没有 role），
 * `Grade` / `HomeworkStatus` / `NotificationRead` 都按 `studentId` 指向它；
 * `StudentClassTransfer` 存调班与转出历史；`ArchivedYear` 是毕业归档的届别档案。
 * 历史上那两张 `ClassTeacher`（无科目的协作关系）与 `Enrollment`（与 Student.classId 双写）
 * 已随 2026-10-06 的重构删除。
 */
export const SNAPSHOT_TABLES = [
  'User',
  'ArchivedYear',
  'Class',
  'Student',
  'Course',
  'StudentClassTransfer',
  'Schedule',
  'TimeLayout',
  'Homework',
  'HomeworkStatus',
  'Notification',
  'NotificationRead',
  'Grade',
  'IntegrationDevice',
  'ClassIslandPush',
] as const;

export type SnapshotTable = (typeof SNAPSHOT_TABLES)[number];

export interface DatabaseSnapshot {
  format: string;
  version: number;
  createdAt: string;
  source: { provider: string };
  /** 每张表的行数（导出时统计，恢复时校验总量用） */
  counts: Record<string, number>;
  /** 表名 → 行数组（DateTime 已是 ISO 字符串，Prisma 接受 ISO 字符串作为 DateTime 输入） */
  data: Record<SnapshotTable, Record<string, unknown>[]>;
}

/** 模型代理的最小接口（避免 any：Prisma 各模型的 delegate 形状一致） */
interface ModelDelegate {
  findMany(): Promise<Record<string, unknown>[]>;
  count(): Promise<number>;
  createMany(args: { data: Record<string, unknown>[] }): Promise<unknown>;
  deleteMany(): Promise<unknown>;
}

function delegatesOf(prisma: PrismaClient): Record<SnapshotTable, ModelDelegate> {
  return prisma as unknown as Record<SnapshotTable, ModelDelegate>;
}

/** 单次 createMany 的批量大小（班级规模数据量小，小批次足够且省内存） */
const CHUNK_SIZE = 200;

/** 导出全库快照（行内 DateTime 为 Date 对象，JSON.stringify 时自动转 ISO） */
export async function exportSnapshot(
  prisma: PrismaClient,
  provider: DatabaseProvider,
): Promise<DatabaseSnapshot> {
  const delegates = delegatesOf(prisma);
  const data = {} as Record<SnapshotTable, Record<string, unknown>[]>;
  const counts: Record<string, number> = {};
  for (const table of SNAPSHOT_TABLES) {
    const rows = await delegates[table].findMany();
    data[table] = rows;
    counts[table] = rows.length;
  }
  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    createdAt: new Date().toISOString(),
    source: { provider },
    counts,
    data,
  };
}

/** 快照结构校验：给出可读的失败原因（"为什么恢复失败"比失败本身重要） */
export function assertValidSnapshot(value: unknown): asserts value is DatabaseSnapshot {
  if (typeof value !== 'object' || value === null) {
    throw new Error('快照内容不是合法的 JSON 对象');
  }
  const snapshot = value as Partial<DatabaseSnapshot>;
  if (snapshot.format !== SNAPSHOT_FORMAT) {
    throw new Error(`快照格式不正确（期望 ${SNAPSHOT_FORMAT}，收到 ${String(snapshot.format ?? '未知')}）`);
  }
  if (snapshot.version !== SNAPSHOT_VERSION) {
    throw new Error(`快照版本不兼容（期望 v${SNAPSHOT_VERSION}，收到 v${String(snapshot.version)}）`);
  }
  if (typeof snapshot.data !== 'object' || snapshot.data === null) {
    throw new Error('快照缺少 data 字段');
  }
  for (const table of SNAPSHOT_TABLES) {
    const rows = (snapshot.data as Record<string, unknown>)[table];
    if (!Array.isArray(rows)) {
      throw new Error(`快照缺少表 ${table} 的数据`);
    }
  }
}

async function setForeignKeys(prisma: PrismaClient, provider: DatabaseProvider, enabled: boolean): Promise<void> {
  const sql =
    provider === 'mysql'
      ? `SET FOREIGN_KEY_CHECKS=${enabled ? 1 : 0}`
      : `PRAGMA foreign_keys=${enabled ? 'ON' : 'OFF'}`;
  await prisma.$executeRawUnsafe(sql);
}

/**
 * 把快照写入目标库（先清空再写入）。
 * 用于：备份恢复、快照导入、跨库迁移的子进程。
 */
export async function restoreSnapshot(
  prisma: PrismaClient,
  provider: DatabaseProvider,
  snapshot: DatabaseSnapshot,
  options: { clean?: boolean } = {},
): Promise<{ counts: Record<string, number> }> {
  assertValidSnapshot(snapshot);
  const delegates = delegatesOf(prisma);
  const clean = options.clean !== false;
  const counts: Record<string, number> = {};

  await setForeignKeys(prisma, provider, false);
  try {
    if (clean) {
      // 反向清空，保证被引用的表最后清（外键关闭后只是防御性的，保持确定性）
      for (const table of [...SNAPSHOT_TABLES].reverse()) {
        await delegates[table].deleteMany();
      }
    }
    for (const table of SNAPSHOT_TABLES) {
      const rows = snapshot.data[table];
      for (let index = 0; index < rows.length; index += CHUNK_SIZE) {
        await delegates[table].createMany({ data: rows.slice(index, index + CHUNK_SIZE) });
      }
      counts[table] = rows.length;
    }
  } finally {
    await setForeignKeys(prisma, provider, true).catch(() => undefined);
  }
  return { counts };
}

/** 汇总快照总行数（列表展示 / 切换任务结果用） */
export function snapshotTotalRows(snapshot: DatabaseSnapshot): number {
  return Object.values(snapshot.counts).reduce((sum, count) => sum + count, 0);
}
