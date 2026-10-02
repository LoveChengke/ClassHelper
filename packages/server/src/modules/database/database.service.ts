import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { env } from '../../config/env.js';
import { createPrismaClient, prisma, type DatabaseProvider } from '../../lib/db.js';
import { logger } from '../../lib/logger.js';
import {
  assertValidSnapshot,
  exportSnapshot,
  restoreSnapshot,
  SNAPSHOT_TABLES,
  type DatabaseSnapshot,
} from '../../lib/snapshot.js';
import { ApiError } from '../../lib/http.js';
import type {
  BackupScheduleInput,
  TargetConnectionInput,
} from './database.schemas.js';

/**
 * 数据库管理服务：状态检测 / 连接测试 / 备份恢复 / 导入导出 / 定时备份 / 一键切换。
 *
 * 所有实现都基于 `lib/snapshot.ts` 的 JSON 快照：与 provider 无关，
 * 因此备份可以恢复回任意一种受支持的数据库（备份即迁移的载体）。
 */

/* ================================================================ 路径 */

/** 数据目录：SQLite = 数据文件所在目录；MySQL = 安装根的 data 目录（与部署约定一致） */
function dataDir(): string {
  if (env.databaseProvider === 'sqlite' && env.sqliteFilePath) {
    return path.dirname(env.sqliteFilePath);
  }
  return path.join(env.serverRoot, '..', 'data');
}

function backupDir(): string {
  return path.join(dataDir(), 'backups');
}

function settingsFilePath(): string {
  return path.join(dataDir(), 'database-settings.json');
}

function ensureBackupDir(): string {
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/* ================================================================ 定时备份配置 */

interface BackupSchedule {
  enabled: boolean;
  intervalHours: number;
  keepCount: number;
  lastAutoBackupAt: string | null;
}

const DEFAULT_SCHEDULE: BackupSchedule = {
  enabled: false,
  intervalHours: 24,
  keepCount: 7,
  lastAutoBackupAt: null,
};

function readSchedule(): BackupSchedule {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFilePath(), 'utf8')) as Partial<BackupSchedule>;
    return {
      enabled: raw.enabled === true,
      intervalHours:
        typeof raw.intervalHours === 'number' && raw.intervalHours >= 1 ? Math.floor(raw.intervalHours) : DEFAULT_SCHEDULE.intervalHours,
      keepCount: typeof raw.keepCount === 'number' && raw.keepCount >= 1 ? Math.floor(raw.keepCount) : DEFAULT_SCHEDULE.keepCount,
      lastAutoBackupAt: typeof raw.lastAutoBackupAt === 'string' ? raw.lastAutoBackupAt : null,
    };
  } catch {
    return { ...DEFAULT_SCHEDULE };
  }
}

function writeSchedule(schedule: BackupSchedule): void {
  ensureBackupDir();
  fs.writeFileSync(settingsFilePath(), `${JSON.stringify(schedule, null, 2)}\n`, 'utf8');
}

/** 读取定时备份配置（GET /backup-schedule） */
export function getBackupSchedule(): BackupSchedule {
  return readSchedule();
}

/** 更新定时备份配置（PUT /backup-schedule），写盘后立即生效 */
export function saveSchedulePatch(patch: BackupScheduleInput): BackupSchedule {
  const next: BackupSchedule = { ...readSchedule(), ...patch };
  writeSchedule(next);
  return next;
}

let schedulerTimer: NodeJS.Timeout | null = null;

/**
 * 定时备份调度：每 10 分钟检查一次，到点自动备份并清理旧备份。
 * 依赖服务端进程常驻（进程不运行不会补跑）；lastAutoBackupAt 持久化在配置文件里，
 * 重启后不会立刻重复备份。
 */
export function startBackupScheduler(): void {
  if (schedulerTimer) return;
  const tick = async (): Promise<void> => {
    if (isSwitchRunning()) return;
    const schedule = readSchedule();
    if (!schedule.enabled) return;
    const last = schedule.lastAutoBackupAt ? Date.parse(schedule.lastAutoBackupAt) : 0;
    const dueAt = (Number.isFinite(last) ? last : 0) + schedule.intervalHours * 3_600_000;
    if (Date.now() < dueAt) return;
    try {
      await createBackup('auto');
      writeSchedule({ ...schedule, lastAutoBackupAt: new Date().toISOString() });
      logger.info('定时备份完成');
    } catch (error) {
      logger.error('定时备份失败', error);
    }
  };
  schedulerTimer = setInterval(() => void tick(), 10 * 60_000);
  schedulerTimer.unref();
  logger.info('定时备份调度已启动（每 10 分钟检查一次到点任务）');
}

/* ================================================================ 备份 / 恢复 */

export interface BackupMeta {
  name: string;
  kind: 'manual' | 'auto';
  sizeBytes: number;
  createdAt: string;
}

function isBackupName(name: string): boolean {
  return /^backup-(manual|auto)-\d{8}-\d{6}\.json\.gz$/.test(name);
}

function backupPath(name: string): string {
  if (!isBackupName(name)) {
    throw ApiError.badRequest('备份文件名不合法');
  }
  const target = path.join(backupDir(), name);
  if (path.dirname(target) !== backupDir()) {
    throw ApiError.badRequest('备份文件名不合法');
  }
  return target;
}

function timestampSlug(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

/** 创建一份备份（gzip 压缩的 JSON 快照）。kind 决定文件名前缀与自动清理策略。 */
export async function createBackup(kind: 'manual' | 'auto'): Promise<BackupMeta> {
  assertNotSwitching();
  const dir = ensureBackupDir();
  const snapshot = await exportSnapshot(prisma, env.databaseProvider);
  const payload = zlib.gzipSync(Buffer.from(JSON.stringify(snapshot), 'utf8'));
  const name = `backup-${kind}-${timestampSlug()}.json.gz`;
  fs.writeFileSync(path.join(dir, name), payload);
  if (kind === 'auto') pruneAutoBackups();
  const meta: BackupMeta = { name, kind, sizeBytes: payload.length, createdAt: snapshot.createdAt };
  logger.info(`已创建${kind === 'auto' ? '定时' : '手动'}备份：${name}`);
  return meta;
}

/** 自动备份按 keepCount 清理最旧的（手动备份不受影响） */
function pruneAutoBackups(): void {
  const schedule = readSchedule();
  const autos = listBackups()
    .filter((item) => item.kind === 'auto')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const stale of autos.slice(0, Math.max(0, autos.length - schedule.keepCount))) {
    try {
      fs.unlinkSync(path.join(backupDir(), stale.name));
    } catch {
      // 清理失败不影响本次备份
    }
  }
}

export function listBackups(): BackupMeta[] {
  const dir = backupDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(isBackupName)
    .map((name) => {
      const stat = fs.statSync(path.join(dir, name));
      return {
        name,
        kind: name.includes('-manual-') ? ('manual' as const) : ('auto' as const),
        sizeBytes: stat.size,
        createdAt: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function readBackupSnapshot(name: string): DatabaseSnapshot {
  const file = backupPath(name);
  if (!fs.existsSync(file)) {
    throw ApiError.notFound('备份不存在（可能已被删除）');
  }
  const snapshot = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')) as DatabaseSnapshot;
  assertValidSnapshot(snapshot);
  return snapshot;
}

/** 从备份恢复（整库覆盖：先清空现有数据再写入备份内容） */
export async function restoreBackup(name: string): Promise<{ counts: Record<string, number> }> {
  assertNotSwitching();
  const snapshot = readBackupSnapshot(name);
  return restoreSnapshot(prisma, env.databaseProvider, snapshot);
}

export function deleteBackup(name: string): void {
  const file = backupPath(name);
  if (!fs.existsSync(file)) {
    throw ApiError.notFound('备份不存在（可能已被删除）');
  }
  fs.unlinkSync(file);
}

/* ================================================================ 导入 / 导出 */

/** 导出当前库的快照 JSON（未压缩，供下载与跨库迁移使用） */
export async function exportSnapshotJson(): Promise<string> {
  assertNotSwitching();
  return JSON.stringify(await exportSnapshot(prisma, env.databaseProvider));
}

/** 从 base64 快照导入（整库覆盖）。用于"快捷导入"。 */
export async function importSnapshotBase64(data: string): Promise<{ counts: Record<string, number> }> {
  assertNotSwitching();
  let snapshot: DatabaseSnapshot;
  try {
    const json = Buffer.from(data, 'base64').toString('utf8');
    snapshot = JSON.parse(json) as DatabaseSnapshot;
  } catch {
    throw ApiError.badRequest('快照内容不是合法的 base64 JSON');
  }
  return restoreSnapshot(prisma, env.databaseProvider, snapshot);
}

/** SQLite 数据文件下载（仅 SQLite 模式提供；MySQL 无"单文件"概念） */
export function sqliteFilePathForDownload(): string {
  if (env.databaseProvider !== 'sqlite' || !env.sqliteFilePath || !fs.existsSync(env.sqliteFilePath)) {
    throw ApiError.badRequest('当前不是 SQLite 数据库或数据文件不存在');
  }
  return env.sqliteFilePath;
}

/* ================================================================ 状态 / 连接测试 */

export interface TableCount {
  name: string;
  count: number;
}

async function databaseVersion(provider: DatabaseProvider, client: typeof prisma): Promise<string> {
  if (provider === 'mysql') {
    const rows = (await client.$queryRawUnsafe('SELECT VERSION() AS version')) as { version?: string }[];
    return rows[0]?.version ?? 'unknown';
  }
  const rows = (await client.$queryRawUnsafe('SELECT sqlite_version() AS version')) as {
    version?: string;
  }[];
  return rows[0]?.version ?? 'unknown';
}

async function databaseSizeBytes(provider: DatabaseProvider, client: typeof prisma): Promise<number | null> {
  if (provider === 'sqlite') {
    return env.sqliteFilePath && fs.existsSync(env.sqliteFilePath) ? fs.statSync(env.sqliteFilePath).size : 0;
  }
  const rows = (await client.$queryRawUnsafe(
    'SELECT COALESCE(SUM(data_length + index_length), 0) AS size FROM information_schema.tables WHERE table_schema = DATABASE()',
  )) as { size?: bigint | number }[];
  const size = rows[0]?.size;
  return size === undefined ? null : Number(size);
}

export interface DatabaseStatus {
  provider: DatabaseProvider;
  connected: boolean;
  latencyMs: number | null;
  version: string | null;
  sizeBytes: number | null;
  /** 当前连接串的脱敏展示（MySQL 隐藏密码） */
  databaseUrlMasked: string;
  /** SQLite 数据文件绝对路径（MySQL 为空） */
  sqliteFilePath: string;
  dataDir: string;
  backupDir: string;
  tables: TableCount[];
  backups: ReturnType<typeof listBackups>;
  schedule: BackupSchedule;
  /** 是否有正在进行的切换任务（期间禁止备份/导入/恢复） */
  switchRunning: boolean;
}

/** 连接串脱敏：mysql://user:password@host → mysql://user:***@host */
function maskDatabaseUrl(provider: DatabaseProvider, url: string): string {
  if (provider !== 'mysql') return url;
  return url.replace(/(\/\/[^:/@]+:)[^@]*(@)/, '$1***$2');
}

export async function getDatabaseStatus(): Promise<DatabaseStatus> {
  const startedAt = Date.now();
  let connected = false;
  let version: string | null = null;
  try {
    version = await databaseVersion(env.databaseProvider, prisma);
    connected = true;
  } catch {
    connected = false;
  }
  const latencyMs = connected ? Date.now() - startedAt : null;
  const delegates = prisma as unknown as Record<
    (typeof SNAPSHOT_TABLES)[number],
    { count(): Promise<number> }
  >;
  const tables: TableCount[] = connected
    ? await Promise.all(
        SNAPSHOT_TABLES.map(async (name): Promise<TableCount> => {
          try {
            return { name, count: await delegates[name].count() };
          } catch {
            return { name, count: -1 };
          }
        }),
      )
    : [];
  return {
    provider: env.databaseProvider,
    connected,
    latencyMs,
    version,
    sizeBytes: connected ? await databaseSizeBytes(env.databaseProvider, prisma).catch(() => null) : null,
    databaseUrlMasked: maskDatabaseUrl(env.databaseProvider, env.databaseUrl),
    sqliteFilePath: env.sqliteFilePath,
    dataDir: dataDir(),
    backupDir: backupDir(),
    tables,
    backups: listBackups(),
    schedule: readSchedule(),
    switchRunning: isSwitchRunning(),
  };
}

export interface ConnectionTestResult {
  ok: boolean;
  provider: DatabaseProvider;
  latencyMs: number | null;
  version: string | null;
  /** 新建 SQLite 库时目标文件还不存在，属于正常情况（切换时会自动建库） */
  note?: string;
  error?: string;
}

/** 测试任意目标库的连通性（发起切换前的第一步） */
export async function testConnection(target: TargetConnectionInput): Promise<ConnectionTestResult> {
  const startedAt = Date.now();
  let note: string | undefined;
  let url = target.url.trim();
  if (target.provider === 'sqlite') {
    // 与 env.resolveSqliteUrl 同口径：相对路径以 serverRoot 为基准解析为绝对路径
    const rawPath = url.slice('file:'.length).replace(/\//g, path.sep);
    const absolute = path.isAbsolute(rawPath) ? rawPath : path.resolve(env.serverRoot, rawPath);
    if (!fs.existsSync(absolute)) {
      const parent = path.dirname(absolute);
      if (!fs.existsSync(parent)) {
        return { ok: false, provider: target.provider, latencyMs: null, version: null, error: `目录不存在：${parent}` };
      }
      note = '目标文件不存在，属新库（切换时会自动建表）';
    }
    url = `file:${absolute.replace(/\\/g, '/')}`;
  }
  let client: Awaited<ReturnType<typeof createPrismaClient>> | null = null;
  try {
    client = await createPrismaClient(target.provider, url);
    const version = await databaseVersion(target.provider, client);
    return { ok: true, provider: target.provider, latencyMs: Date.now() - startedAt, version, note };
  } catch (error) {
    return {
      ok: false,
      provider: target.provider,
      latencyMs: null,
      version: null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await client?.$disconnect().catch(() => undefined);
  }
}

/* ================================================================ 一键切换 */

export interface SwitchStep {
  name: string;
  status: 'running' | 'done' | 'error';
  detail?: string;
}

export interface SwitchJob {
  id: string;
  status: 'running' | 'done' | 'error';
  target: { provider: DatabaseProvider; url: string };
  steps: SwitchStep[];
  error?: string;
  /** 完成后必填：需要重启服务端才能让新数据库生效 */
  restartRequired: boolean;
  counts?: Record<string, number>;
  backupName?: string;
  startedAt: string;
  finishedAt?: string;
}

const switchJobs = new Map<string, SwitchJob>();

function isSwitchRunning(): boolean {
  for (const job of switchJobs.values()) {
    if (job.status === 'running') return true;
  }
  return false;
}

function assertNotSwitching(): void {
  if (isSwitchRunning()) {
    throw ApiError.conflict('正在执行数据库切换，请等待完成后再进行备份/导入/恢复');
  }
}

/** 防止路径穿越：任务 id 只由本服务生成（时间戳 + 随机数） */
function newJobId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function getSwitchJob(id: string): SwitchJob | null {
  return switchJobs.get(id) ?? null;
}

function stepOf(job: SwitchJob, name: string): SwitchStep {
  let step = job.steps.find((item) => item.name === name);
  if (!step) {
    step = { name, status: 'running' };
    job.steps.push(step);
  }
  return step;
}

function finishStep(job: SwitchJob, name: string, detail?: string): void {
  const step = stepOf(job, name);
  step.status = 'done';
  if (detail) step.detail = detail;
}

function appendDetail(job: SwitchJob, name: string, detail: string): void {
  const step = stepOf(job, name);
  step.detail = `${step.detail ? `${step.detail}\n` : ''}${detail}`.slice(-4000);
}

/** 校验目标库必须是空库（防误覆盖）：有表即拒绝 */
async function assertTargetEmpty(target: TargetConnectionInput): Promise<string> {
  let url = target.url.trim();
  let sqliteAbsolute: string | null = null;
  if (target.provider === 'sqlite') {
    const rawPath = url.slice('file:'.length).replace(/\//g, path.sep);
    const absolute = path.isAbsolute(rawPath) ? rawPath : path.resolve(env.serverRoot, rawPath);
    sqliteAbsolute = absolute;
    url = `file:${absolute.replace(/\\/g, '/')}`;
  }
  const client = await createPrismaClient(target.provider, url);
  try {
    const rows =
      target.provider === 'sqlite'
        ? (await client.$queryRawUnsafe(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
          )) as { count?: bigint | number }[]
        : (await client.$queryRawUnsafe(
            'SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = DATABASE()',
          )) as { count?: bigint | number }[];
    const tableCount = Number(rows[0]?.count ?? 0);
    if (tableCount > 0) {
      throw ApiError.badRequest(
        `目标数据库不是空库（已有 ${tableCount} 张表）。为防误覆盖，只允许迁移到空库；` +
          '如需重用已有库，请先备份并清空它。',
      );
    }
    return target.provider === 'sqlite' ? `目标文件：${sqliteAbsolute}` : '目标 MySQL 库为空';
  } finally {
    await client.$disconnect().catch(() => undefined);
  }
}

const SCHEMA_FILE = path.join(env.serverRoot, 'prisma', 'schema.prisma');

function rewriteSchemaProvider(provider: DatabaseProvider): string {
  const original = fs.readFileSync(SCHEMA_FILE, 'utf8');
  const updated = original.replace(/provider\s*=\s*"(sqlite|mysql)"/, `provider = "${provider}"`);
  if (updated === original) {
    throw new Error('未能改写 schema.prisma 的 provider（未匹配到 provider 声明）');
  }
  fs.writeFileSync(SCHEMA_FILE, updated, 'utf8');
  return original;
}

/** 子进程运行 Prisma CLI（generate / db push）。连接串通过环境变量显式传入，不依赖 .env。 */
function runPrismaCli(
  job: SwitchJob,
  stepName: string,
  args: string[],
  target: TargetConnectionInput,
): Promise<void> {
  const candidates = [
    path.join(env.serverRoot, 'node_modules', 'prisma', 'build', 'index.js'),
    path.join(env.serverRoot, '..', 'node_modules', 'prisma', 'build', 'index.js'),
  ];
  const cli = candidates.find((file) => fs.existsSync(file));
  if (!cli) {
    throw new Error('未找到 Prisma CLI（node_modules/prisma）。安装版请确认安装包完整。');
  }
  return runNodeTool(job, stepName, [cli, ...args], {
    ...process.env,
    DATABASE_PROVIDER: target.provider,
    DATABASE_URL: target.url.trim(),
  });
}

/** 编译新生成的 Prisma 客户端（仅生产打包形态需要：dist 里跑的是编译产物） */
async function compileGeneratedClient(job: SwitchJob): Promise<void> {
  // 开发模式（tsx 直接跑 src）不需要编译；打包形态（存在 dist/index.js）才需要
  if (!fs.existsSync(path.join(env.serverRoot, 'dist', 'index.js'))) return;
  const candidates = [
    path.join(env.serverRoot, 'node_modules', 'typescript', 'lib', 'tsc.js'),
    path.join(env.serverRoot, '..', 'node_modules', 'typescript', 'lib', 'tsc.js'),
  ];
  const tsc = candidates.find((file) => fs.existsSync(file));
  if (!tsc) {
    throw new Error('未找到 TypeScript 编译器（node_modules/typescript）。安装包请确认完整。');
  }
  await runNodeTool(job, '编译新生成的 Prisma 客户端', [tsc, '-p', 'tsconfig.generate.json'], process.env);
}

/** 跨库迁移的数据写入走独立子进程：运行中的服务进程缓存的是旧方言的 Prisma Client */
function runApplySnapshotTool(job: SwitchJob, target: TargetConnectionInput, snapshotFile: string): Promise<Record<string, number>> {
  const distTool = path.join(env.serverRoot, 'dist', 'tools', 'apply-snapshot.js');
  const srcTool = path.join(env.serverRoot, 'src', 'tools', 'apply-snapshot.ts');
  const tsxCli = path.join(env.serverRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  let args: string[];
  if (fs.existsSync(distTool)) {
    args = [distTool];
  } else if (fs.existsSync(tsxCli) && fs.existsSync(srcTool)) {
    args = [tsxCli, srcTool];
  } else {
    throw new Error('未找到快照导入工具（dist/tools/apply-snapshot.js），请先构建服务端');
  }
  args.push('--provider', target.provider, '--url', target.url.trim(), '--file', snapshotFile);
  const capture: { text: string } = { text: '' };
  return runNodeTool(job, '迁移数据到目标库', args, process.env, capture).then(() => {
    const lines = capture.text.trim().split(/\r?\n/).filter(Boolean);
    const last = lines[lines.length - 1] ?? '';
    try {
      const parsed = JSON.parse(last) as { ok?: boolean; counts?: Record<string, number>; error?: string };
      if (!parsed.ok) throw new Error(parsed.error ?? '快照导入工具返回失败');
      return parsed.counts ?? {};
    } catch (error) {
      throw new Error(
        `无法解析快照导入工具的输出：${error instanceof Error ? error.message : String(error)}（输出尾部：${last.slice(0, 400)}）`,
      );
    }
  });
}

function runNodeTool(
  job: SwitchJob,
  stepName: string,
  args: string[],
  nodeEnv: NodeJS.ProcessEnv,
  capture?: { text: string },
  timeoutMs = 10 * 60_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: env.serverRoot,
      env: nodeEnv,
      windowsHide: true,
    });
    let output = '';
    const collect = (chunk: Buffer | string): void => {
      output += String(chunk);
      if (output.length > 20_000) output = output.slice(-20_000);
      if (capture) capture.text = output;
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${stepName} 超时（${Math.round(timeoutMs / 60_000)} 分钟）`));
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`${stepName} 启动失败：${error.message}`));
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        appendDetail(job, stepName, output.trim().split(/\r?\n/).slice(-6).join('\n'));
        resolve();
        return;
      }
      const tail = output.trim().split(/\r?\n/).slice(-10).join('\n');
      reject(new Error(`${stepName} 失败（exit ${code ?? 'signal'}）：${tail || '无输出'}`));
    });
  });
}

/** 切换完成后改写 .env（DATABASE_PROVIDER / DATABASE_URL 两行） */
function updateEnvFiles(target: TargetConnectionInput): string {
  const candidates = [path.join(env.serverRoot, '.env'), path.join(env.serverRoot, '..', '.env')];
  const existing = candidates.filter((file) => fs.existsSync(file));
  const files = existing.length > 0 ? existing : [candidates[0]];
  const updated: string[] = [];
  for (const file of files) {
    let content = fs.readFileSync(file, 'utf8');
    const providerLine = `DATABASE_PROVIDER=${target.provider}`;
    const urlLine = `DATABASE_URL="${target.url.trim()}"`;
    if (/^DATABASE_PROVIDER=.*$/m.test(content)) {
      content = content.replace(/^DATABASE_PROVIDER=.*$/m, providerLine);
    } else {
      content = `${content.trimEnd()}\n${providerLine}\n`;
    }
    if (/^DATABASE_URL=.*$/m.test(content)) {
      content = content.replace(/^DATABASE_URL=.*$/m, urlLine);
    } else {
      content = `${content.trimEnd()}\n${urlLine}\n`;
    }
    fs.writeFileSync(file, content, 'utf8');
    updated.push(file);
  }
  return updated.join(' , ');
}

/**
 * 发起一键切换（异步任务）。流程与失败语义见模块注释：
 * 数据写入全部成功后才改写 .env；中途失败回滚 schema.prisma，现有库不受影响。
 */
export function startSwitch(target: TargetConnectionInput): SwitchJob {
  if (isSwitchRunning()) {
    throw ApiError.conflict('已有切换任务正在进行，请等待完成');
  }
  if (target.provider === env.databaseProvider && target.url.trim() === env.databaseUrl) {
    throw ApiError.badRequest('目标数据库与当前使用的数据库相同');
  }
  const job: SwitchJob = {
    id: newJobId(),
    status: 'running',
    target: { provider: target.provider, url: target.url.trim() },
    steps: [],
    restartRequired: false,
    startedAt: new Date().toISOString(),
  };
  switchJobs.set(job.id, job);
  // 不 await：HTTP 立即返回 jobId，前端轮询 GET /switch/jobs/:id
  void runSwitch(job, target).catch(() => undefined);
  return job;
}

async function runSwitch(job: SwitchJob, target: TargetConnectionInput): Promise<void> {
  let schemaOriginal: string | null = null;
  let snapshotFile: string | null = null;
  try {
    // 1. 先备份当前库（切换失败时的兜底）
    stepOf(job, '备份当前数据库');
    const backup = await createBackup('manual');
    job.backupName = backup.name;
    finishStep(job, '备份当前数据库', `备份文件 ${backup.name}`);

    // 2. 导出快照到临时文件（供子进程写入目标库）
    stepOf(job, '导出当前数据');
    fs.mkdirSync(backupDir(), { recursive: true });
    snapshotFile = path.join(backupDir(), `switch-${job.id}.json`);
    fs.writeFileSync(snapshotFile, await exportSnapshotJson(), 'utf8');
    finishStep(job, '导出当前数据');

    // 3. 测试目标连接
    stepOf(job, '测试目标库连接');
    const test = await testConnection(target);
    if (!test.ok) {
      throw new Error(test.error ?? '目标库连接失败');
    }
    finishStep(job, '测试目标库连接', test.note ?? `连接正常（${test.latencyMs ?? '-'}ms，${test.version ?? '-'}）`);

    // 4. 目标库必须为空
    stepOf(job, '检查目标库为空');
    finishStep(job, '检查目标库为空', await assertTargetEmpty(target));

    // 5. 改写 schema.prisma 的 provider（失败时回滚）
    stepOf(job, '改写 schema.prisma');
    schemaOriginal = rewriteSchemaProvider(target.provider);
    finishStep(job, '改写 schema.prisma', `provider → ${target.provider}`);

    // 6. 生成新方言的 Prisma 客户端
    stepOf(job, '生成 Prisma 客户端');
    await runPrismaCli(job, '生成 Prisma 客户端', ['generate'], target);
    finishStep(job, '生成 Prisma 客户端');

    // 7. 生产形态：把生成出来的 .ts 客户端编译进 dist（dev 由 tsx 直接跑 src，跳过）
    await compileGeneratedClient(job);

    // 8. 目标库建表（Prisma 7 的 db push 不再自动生成客户端，generate 是独立步骤 6）
    stepOf(job, '在目标库建表');
    await runPrismaCli(job, '在目标库建表', ['db', 'push', '--accept-data-loss'], target);
    finishStep(job, '在目标库建表');

    // 9. 迁移数据（独立子进程加载新方言客户端）
    stepOf(job, '迁移数据到目标库');
    const counts = await runApplySnapshotTool(job, target, snapshotFile);
    job.counts = counts;
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    finishStep(job, '迁移数据到目标库', `共写入 ${total} 行`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 失败发生在哪一步，就把那一步标成 error（UI 上能直接看到卡在哪）
    const running = [...job.steps].reverse().find((item) => item.status === 'running');
    if (running) {
      running.status = 'error';
      running.detail = message.slice(0, 1000);
    }
    job.error = message;
    job.status = 'error';
    job.finishedAt = new Date().toISOString();
    // 回滚 schema（.env 尚未改写，现有库不受影响）
    if (schemaOriginal !== null) {
      try {
        fs.writeFileSync(SCHEMA_FILE, schemaOriginal, 'utf8');
      } catch (rollbackError) {
        logger.error('回滚 schema.prisma 失败，请手工核对 provider 设置', rollbackError);
      }
    }
    logger.error(`数据库切换失败（job=${job.id}）：${message}`);
    return;
  } finally {
    if (snapshotFile) fs.rmSync(snapshotFile, { force: true });
  }

  // 10. 全部成功后才切换 .env（失败已在上面的 catch 里返回）
  try {
    stepOf(job, '写入 .env 配置');
    const files = updateEnvFiles(target);
    finishStep(job, '写入 .env 配置', files);
    job.status = 'done';
    job.restartRequired = true;
    job.finishedAt = new Date().toISOString();
    logger.info(`数据库切换任务完成（job=${job.id}）→ ${target.provider}，重启服务端后生效`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    job.error = `数据已迁移到目标库，但写入 .env 失败：${message}（请手工修改 .env 的 DATABASE_PROVIDER / DATABASE_URL 后重启）`;
    job.status = 'error';
    job.finishedAt = new Date().toISOString();
  }
}
