import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  dayKeyLocal,
  formatClassName,
  isDayKey,
  defaultPromotionPlan,
  SOCKET_EVENTS,
  type PromotionPlan,
} from '@classhelper/shared';
import { prisma } from '../../lib/db.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { TokenPayload } from '../../lib/jwt.js';
import { env } from '../../config/env.js';
import { ApiError } from '../../lib/http.js';
import { assertGlobalPermission } from '../../lib/access.js';
import { exportSnapshot } from '../../lib/snapshot.js';
import { SETTING_KEYS } from '../../lib/settings.js';
import { getMaxTermWeeks } from '../../lib/term.js';
import { hashPassword } from '../../lib/password.js';
import { logger } from '../../lib/logger.js';
import { emitToClass } from '../../realtime/bus.js';
import { notifyScheduleChanged } from '../class-plans/class-plans.service.js';

export const promotionPlanSchema = z
  .object({
    tracks: z
      .array(
        z.object({
          id: z.string().regex(/^[a-z][a-z0-9-]{0,19}$/),
          name: z.string().trim().min(1).max(40),
          entryClassCount: z.number().int().min(0).max(99),
          stages: z
            .array(z.object({ grade: z.string().trim().min(1).max(32), terminal: z.boolean().optional() }))
            .min(1)
            .max(20),
        }),
      )
      .min(1)
      .max(20),
    termStartDate: z.string().refine(isDayKey, '学期开始日期无效').nullable().default(null),
    resetTermWeeks: z.boolean().default(true),
  })
  .superRefine((plan, ctx) => {
    const grades = new Set<string>(),
      tracks = new Set<string>();
    for (const [index, track] of plan.tracks.entries()) {
      if (tracks.has(track.id))
        ctx.addIssue({ code: 'custom', path: ['tracks', index, 'id'], message: '轨道标识不能重复' });
      tracks.add(track.id);
      for (const [i, stage] of track.stages.entries()) {
        if (grades.has(stage.grade))
          ctx.addIssue({
            code: 'custom',
            path: ['tracks', index, 'stages', i],
            message: '每个年级只能出现一次',
          });
        grades.add(stage.grade);
        if (Boolean(stage.terminal) !== (i === track.stages.length - 1))
          ctx.addIssue({
            code: 'custom',
            path: ['tracks', index, 'stages', i],
            message: '仅最后一个学段必须标记为毕业学段',
          });
      }
    }
  });
export const promotionConfigSchema = z
  .object({
    month: z.number().int().min(1).max(12),
    day: z.number().int().min(1).max(31),
    hour: z.number().int().min(0).max(23),
    classCount: z.number().int().min(0).max(99).optional(),
    plan: promotionPlanSchema.optional(),
  })
  .refine((config) => config.day <= new Date(2000, config.month, 0).getDate(), '该月份没有所选日期');

type Db = Prisma.TransactionClient;
async function loadConfig(db: Db = prisma) {
  const settings = await db.appSetting.findMany({
    where: { key: { in: [SETTING_KEYS.promotionAt, SETTING_KEYS.promotionPlan] } },
  });
  const raw = settings.find((setting) => setting.key === SETTING_KEYS.promotionAt)?.value;
  const config = raw
    ? promotionConfigSchema.parse(JSON.parse(raw))
    : { month: 8, day: 1, hour: 0, classCount: 1 };
  const rawPlan = settings.find((setting) => setting.key === SETTING_KEYS.promotionPlan)?.value;
  const plan = rawPlan
    ? promotionPlanSchema.parse(JSON.parse(rawPlan))
    : defaultPromotionPlan(config.classCount ?? 1);
  return {
    config: {
      month: config.month,
      day: config.day,
      hour: config.hour,
      classCount: plan.tracks[0].entryClassCount,
    },
    plan,
  };
}
export async function loadPromotionPlan(): Promise<PromotionPlan> {
  return (await loadConfig()).plan;
}
function dueYear(config: { month: number; day: number; hour: number }, now: Date) {
  const due = new Date(
    now.getFullYear(),
    config.month - 1,
    Math.min(config.day, new Date(now.getFullYear(), config.month, 0).getDate()),
    config.hour,
  );
  return now < due ? now.getFullYear() - 1 : now.getFullYear();
}
export async function promotionStatus(now = new Date()) {
  const { config, plan } = await loadConfig();
  const year = dueYear(config, now);
  const run = await prisma.promotionRun.findUnique({ where: { year } });
  return {
    config,
    plan,
    year,
    pending: run?.status !== 'done',
    runs: await prisma.promotionRun.findMany({ orderBy: { year: 'desc' }, take: 30 }),
    today: dayKeyLocal(now),
  };
}
export async function configurePromotion(input: z.infer<typeof promotionConfigSchema>, actor?: TokenPayload) {
  if (actor) await assertGlobalPermission(actor, 'promotion:manage');
  const parsed = promotionConfigSchema.parse(input);
  const current = await loadConfig();
  const plan =
    parsed.plan ??
    (parsed.classCount === undefined
      ? current.plan
      : {
          ...current.plan,
          tracks: current.plan.tracks.map((track, i) =>
            i ? track : { ...track, entryClassCount: parsed.classCount! },
          ),
        });
  await prisma.$transaction(async (tx) => {
    for (const [key, value] of [
      [
        SETTING_KEYS.promotionAt,
        JSON.stringify({
          month: parsed.month,
          day: parsed.day,
          hour: parsed.hour,
          classCount: plan.tracks[0].entryClassCount,
        }),
      ],
      [SETTING_KEYS.promotionPlan, JSON.stringify(plan)],
    ])
      await tx.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
  });
  return promotionStatus();
}

/** 只读预览与执行校验共用同一查询，哈希覆盖配置、学生、班级和周次。 */
async function buildPreview(year: number, db: Db = prisma) {
  const { config, plan } = await loadConfig(db);
  const [allClasses, students, weeks, archives] = await Promise.all([
    db.class.findMany({ orderBy: { id: 'asc' } }),
    db.student.findMany({
      orderBy: { id: 'asc' },
      select: { id: true, classId: true, status: true, archivedYearId: true, updatedAt: true },
    }),
    db.termWeek.findMany({ orderBy: { id: 'asc' } }),
    db.archivedYear.findMany({ orderBy: { id: 'asc' } }),
  ]);
  const classes = allClasses.filter((cls) => !cls.archivedYearId);
  const blockers: { code: string; message: string; classId?: string }[] = [];
  const warnings = ['新建班级只有骨架，没有班主任或任课关系，请随后分配。'];
  const grades = new Set(plan.tracks.flatMap((track) => track.stages.map((stage) => stage.grade)));
  for (const cls of classes) {
    if (!grades.has(cls.grade))
      blockers.push({
        code: 'UNKNOWN_GRADE',
        classId: cls.id,
        message: `${cls.name} 的年级「${cls.grade}」不在升级计划内`,
      });
    if (!cls.enrollmentYear || !cls.classIndex)
      blockers.push({ code: 'MISSING_COHORT', classId: cls.id, message: `${cls.name} 缺少入学年份或班号` });
    if (
      students.some(
        (student) => student.classId === cls.id && (student.archivedYearId || student.status === 'graduated'),
      )
    )
      blockers.push({
        code: 'INCONSISTENT_STUDENT',
        classId: cls.id,
        message: `${cls.name} 含已归档或已毕业学生，请先处理数据一致性`,
      });
  }
  const tracks = plan.tracks.map((track, ti) => {
    const relevant = classes.filter((cls) => track.stages.some((stage) => stage.grade === cls.grade));
    const seen = new Set<string>();
    const affected = relevant.map((cls) => {
      const key = `${cls.enrollmentYear}:${cls.classIndex}`;
      if (seen.has(key))
        blockers.push({
          code: 'DUPLICATE_INDEX',
          classId: cls.id,
          message: `${track.name} 同届存在重复班号：${cls.name}`,
        });
      seen.add(key);
      const index = track.stages.findIndex((stage) => stage.grade === cls.grade);
      const terminal = Boolean(track.stages[index].terminal);
      if (terminal && archives.some((archive) => archive.enrollmentYear === cls.enrollmentYear))
        blockers.push({
          code: 'ARCHIVE_EXISTS',
          classId: cls.id,
          message: `${cls.enrollmentYear} 届已存在档案`,
        });
      const members = students.filter((student) => student.classId === cls.id);
      return {
        id: cls.id,
        name: cls.name,
        grade: cls.grade,
        enrollmentYear: cls.enrollmentYear,
        classIndex: cls.classIndex,
        nextGrade: terminal ? '毕业归档' : track.stages[index + 1].grade,
        terminal,
        active: members.filter((student) => student.status === 'active').length,
        inactive: members.filter((student) => student.status === 'inactive').length,
        transferred: members.filter((student) => student.status === 'transferred').length,
      };
    });
    const newClasses = [];
    for (let i = 1; i <= track.entryClassCount; i++) {
      if (
        relevant.some(
          (cls) => cls.enrollmentYear === year && cls.classIndex === i && cls.grade === track.stages[0].grade,
        )
      )
        continue;
      const code =
        ti === 0 ? `N${year}${String(i).padStart(2, '0')}` : `T${ti}${year}${String(i).padStart(2, '0')}`;
      if (allClasses.some((cls) => cls.code === code))
        blockers.push({ code: 'CODE_CONFLICT', message: `新班级码 ${code} 已被占用，请先修改冲突班级码` });
      newClasses.push({
        name: formatClassName(year, i),
        grade: track.stages[0].grade,
        code,
        classIndex: i,
        enrollmentYear: year,
      });
    }
    return { id: track.id, name: track.name, classes: affected, newClasses };
  });
  warnings.push(
    plan.resetTermWeeks
      ? `将删除 ${weeks.length} 条全校及班级周次区间。`
      : '保留原有周次区间，它们会继续覆盖新学年日期。',
  );
  const planHash = createHash('sha256')
    .update(JSON.stringify({ year, config, plan, allClasses, students, weeks, archives }))
    .digest('hex');
  return {
    year,
    classCount: classes.length,
    studentCount: students.filter(
      (student) => student.status === 'active' && classes.some((cls) => cls.id === student.classId),
    ).length,
    status: 'dry-run',
    snapshotRequired: true,
    plan,
    tracks,
    blockers,
    warnings,
    termWeekDeleteCount: plan.resetTermWeeks ? weeks.length : 0,
    termStartDate: plan.termStartDate ?? `${year}-09-01`,
    planHash,
  };
}
export async function previewPromotion(year: number) {
  return buildPreview(year);
}
function assertExecutable(preview: Awaited<ReturnType<typeof buildPreview>>, hash?: string) {
  if (hash && hash !== preview.planHash)
    throw new ApiError(409, 'CONFLICT', '预览已过期，配置或业务数据已变化，请重新预览', {
      code: 'PLAN_CHANGED',
    });
  if (preview.blockers.length)
    throw new ApiError(409, 'CONFLICT', '升级存在阻断项，请修正后重新预览', preview.blockers);
}
type RunOptions = {
  dryRun?: boolean;
  actor?: TokenPayload;
  planHash?: string;
  confirm?: boolean;
  catchUp?: boolean;
};
const running = new Map<number, Promise<Awaited<ReturnType<typeof executePromotion>>>>();
export async function runPromotion(year: number, dryRunOrOptions: boolean | RunOptions = false) {
  const options = typeof dryRunOrOptions === 'boolean' ? { dryRun: dryRunOrOptions } : dryRunOrOptions;
  if (options.actor) {
    await assertGlobalPermission(options.actor, 'promotion:manage');
    const status = await promotionStatus();
    if (year > status.year) throw ApiError.badRequest('不能执行尚未到期的未来学年');
    if (year < status.year && !(options.actor.role === 'ADMIN' && options.catchUp))
      throw ApiError.forbidden('过去学年仅管理员明确补跑');
    if (!options.dryRun && (!options.confirm || !options.planHash))
      throw ApiError.badRequest('执行必须确认学年并提供本次预览哈希');
  }
  if (options.dryRun) return buildPreview(year);
  const prior = running.get(year);
  if (prior) {
    if (options.planHash && (await prisma.promotionRun.findUnique({ where: { year } }))?.status !== 'done')
      assertExecutable(await buildPreview(year), options.planHash);
    return prior;
  }
  const task = executePromotion(year, options);
  running.set(year, task);
  try {
    return await task;
  } finally {
    running.delete(year);
  }
}
async function executePromotion(year: number, options: RunOptions) {
  const existing = await prisma.promotionRun.findUnique({ where: { year } });
  if (existing?.status === 'done') return { ...existing, alreadyDone: true };
  const preview = await buildPreview(year);
  assertExecutable(preview, options.planHash);
  const dir = path.resolve(
    env.sqliteFilePath ? path.dirname(env.sqliteFilePath) : path.resolve(env.serverRoot, '..', 'data'),
    'promotion-snapshots',
  );
  const snapshotPath = path.join(dir, `${year}-${Date.now()}-${randomUUID()}.json`);
  let snapshotSha256 = '';
  const actor = options.actor;
  try {
    await fs.mkdir(dir, { recursive: true });
    const content = JSON.stringify(await exportSnapshot(prisma, env.databaseProvider));
    await fs.writeFile(snapshotPath, content, { flag: 'wx' });
    snapshotSha256 = createHash('sha256').update(content).digest('hex');
    const passwordHash = await hashPassword(env.defaultClassPassword);
    const maxWeeks = await getMaxTermWeeks();
    await prisma.$transaction(
      async (tx) => {
        const fresh = await buildPreview(year, tx);
        assertExecutable(fresh, preview.planHash);
        const current = await tx.promotionRun.findUnique({ where: { year } });
        if (current?.status === 'done') return;
        await tx.promotionRun.deleteMany({ where: { year, status: { not: 'done' } } });
        await tx.promotionRun.create({
          data: {
            year,
            status: 'running',
            snapshotPath,
            snapshotSha256,
            operatorId: actor?.sub,
            operatorName: actor?.name ?? '学年自动升级',
            detailsJson: JSON.stringify(fresh),
            classCount: fresh.classCount,
            studentCount: fresh.studentCount,
          },
        });
        const graduating = fresh.tracks.flatMap((track) => track.classes.filter((cls) => cls.terminal));
        for (const enrollmentYear of new Set(graduating.map((cls) => cls.enrollmentYear!))) {
          const ids = graduating.filter((cls) => cls.enrollmentYear === enrollmentYear).map((cls) => cls.id);
          const counts = graduating.filter((cls) => ids.includes(cls.id));
          const archive = await tx.archivedYear.create({
            data: {
              enrollmentYear,
              graduationYear: year,
              name: `${enrollmentYear} 级`,
              operatorId: actor?.sub,
              operatorName: actor?.name ?? '学年自动升级',
              classCount: ids.length,
              studentCount: counts.reduce((n, cls) => n + cls.active, 0),
              transferredCount: counts.reduce((n, cls) => n + cls.transferred, 0),
              inactiveCount: counts.reduce((n, cls) => n + cls.inactive, 0),
              homeworkCount: await tx.homework.count({ where: { classId: { in: ids } } }),
              notificationCount: await tx.notification.count({ where: { classId: { in: ids } } }),
            },
          });
          await tx.class.updateMany({
            where: { id: { in: ids } },
            data: { archivedYearId: archive.id, archivedAt: new Date() },
          });
          await tx.student.updateMany({
            where: { classId: { in: ids }, status: 'active' },
            data: { status: 'graduated' },
          });
          await tx.student.updateMany({
            where: { classId: { in: ids } },
            data: { archivedYearId: archive.id, archivedAt: new Date() },
          });
        }
        for (const track of fresh.tracks) {
          for (const cls of track.classes.filter((cls) => !cls.terminal))
            await tx.class.update({
              where: { id: cls.id },
              data: { grade: cls.nextGrade, termStartDate: null },
            });
          for (const cls of track.newClasses)
            await tx.class.create({
              data: {
                ...cls,
                teacherId: null,
                passwordHash,
                termWeeks: Math.min(20, maxWeeks),
                termStartDate: null,
              },
            });
        }
        if (fresh.plan.resetTermWeeks) await tx.termWeek.deleteMany();
        await tx.appSetting.upsert({
          where: { key: SETTING_KEYS.termStartDate },
          create: { key: SETTING_KEYS.termStartDate, value: fresh.termStartDate },
          update: { value: fresh.termStartDate },
        });
        await tx.promotionRun.update({
          where: { year },
          data: { status: 'done', message: '已按计划升级、归档并建立新班骨架', finishedAt: new Date() },
        });
      },
      { timeout: 30000 },
    );
  } catch (error) {
    const completed = await prisma.promotionRun.findUnique({ where: { year } });
    if (completed?.status === 'done') return { ...completed, alreadyDone: true };
    const failure = {
      status: 'failed',
      snapshotPath,
      snapshotSha256,
      operatorId: actor?.sub,
      operatorName: actor?.name ?? '学年自动升级',
      detailsJson: JSON.stringify(preview),
      error: String(error),
      message: '升级失败，业务事务未提交',
      finishedAt: new Date(),
    };
    await prisma.promotionRun.upsert({ where: { year }, create: { year, ...failure }, update: failure });
    if (error instanceof ApiError) throw error;
    throw ApiError.internal(`学年升级失败，事务已回滚：${String(error)}`);
  }
  for (const track of preview.tracks)
    for (const cls of track.classes)
      emitToClass(cls.id, SOCKET_EVENTS.classUpdated, { classId: cls.id, action: 'updated' });
  await notifyScheduleChanged();
  return { ...(await prisma.promotionRun.findUniqueOrThrow({ where: { year } })), alreadyDone: false };
}

let timer: ReturnType<typeof setInterval> | null = null;
export async function startPromotionScheduler() {
  if (timer) return;
  let observed = new Date();
  if ((await promotionStatus(observed)).pending) logger.warn('有遗漏的学年升级，请在学年升级页预览后补跑');
  timer = setInterval(() => {
    void (async () => {
      const now = new Date();
      const { config } = await loadConfig();
      if (dueYear(config, now) > dueYear(config, observed)) await runPromotion(now.getFullYear());
      observed = now;
    })().catch((error) => logger.error(`自动升级失败：${String(error)}`));
  }, 30000);
  timer.unref();
}
