import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { dayKeyLocal, formatClassName } from '@classhelper/shared';
import { prisma } from '../../lib/db.js';
import { env } from '../../config/env.js';
import { ApiError } from '../../lib/http.js';
import { exportSnapshot } from '../../lib/snapshot.js';
import { getSetting, setSetting, SETTING_KEYS } from '../../lib/settings.js';
import { getMaxTermWeeks } from '../../lib/term.js';
import { hashPassword } from '../../lib/password.js';
import { logger } from '../../lib/logger.js';
import { notifyScheduleChanged } from '../class-plans/class-plans.service.js';

export const promotionConfigSchema = z.object({
  month: z.number().int().min(1).max(12),
  day: z.number().int().min(1).max(31),
  hour: z.number().int().min(0).max(23),
  classCount: z.number().int().min(1).max(99).default(1),
});
export async function promotionStatus(now = new Date()) {
  const raw = await getSetting(SETTING_KEYS.promotionAt);
  let config = { month: 8, day: 1, hour: 0, classCount: 1 };
  if (raw) {
    const parsed = promotionConfigSchema.safeParse(JSON.parse(raw));
    if (parsed.success) config = parsed.data;
  }
  const due = new Date(
    now.getFullYear(),
    config.month - 1,
    Math.min(config.day, new Date(now.getFullYear(), config.month, 0).getDate()),
    config.hour,
  );
  const year = now < due ? now.getFullYear() - 1 : now.getFullYear();
  const run = await prisma.promotionRun.findUnique({ where: { year } });
  return {
    config,
    year,
    pending: !run || run.status !== 'done',
    runs: await prisma.promotionRun.findMany({ orderBy: { year: 'desc' }, take: 20 }),
    today: dayKeyLocal(now),
  };
}
export async function configurePromotion(input: z.infer<typeof promotionConfigSchema>) {
  await setSetting(SETTING_KEYS.promotionAt, JSON.stringify(input));
  return promotionStatus();
}

/** 一年一个事务幂等键；快照失败不得升级。启动遗漏只提示补跑，不擅自改演示库。 */
export async function runPromotion(year: number, dryRun = false) {
  const existing = await prisma.promotionRun.findUnique({ where: { year } });
  if (existing?.status === 'done') return existing;
  const classes = await prisma.class.findMany({
    where: { archivedYearId: null, grade: { in: ['高一', '高二', '高三'] } },
  });
  const classIds = classes.map((c) => c.id);
  const studentCount = await prisma.student.count({ where: { classId: { in: classIds }, status: 'active' } });
  if (dryRun)
    return { year, classCount: classes.length, studentCount, status: 'dry-run', snapshotRequired: true };
  const dir = path.resolve(
    env.sqliteFilePath ? path.dirname(env.sqliteFilePath) : path.resolve(env.serverRoot, '..', 'data'),
    'promotion-snapshots',
  );
  await fs.mkdir(dir, { recursive: true });
  const snapshotPath = path.join(dir, `${year}-${Date.now()}.json`);
  await fs.writeFile(snapshotPath, JSON.stringify(await exportSnapshot(prisma, env.databaseProvider)), {
    flag: 'wx',
  });
  const { config } = await promotionStatus();
  const passwordHash = await hashPassword(env.defaultClassPassword);
  const maxWeeks = await getMaxTermWeeks();
  try {
    await prisma.$transaction(
      async (tx) => {
        // 唯一键在事务里争抢，重入/多进程都只能有一个提交成功。
        if (existing) await tx.promotionRun.deleteMany({ where: { year, status: { not: 'done' } } });
        await tx.promotionRun.create({
          data: { year, status: 'running', snapshotPath, classCount: classes.length, studentCount },
        });
        const graduating = classes.filter((c) => c.grade === '高三');
        const cohorts = [...new Set(graduating.map((c) => c.enrollmentYear ?? year - 3))];
        for (const enrollmentYear of cohorts) {
          const ids = graduating
            .filter((c) => (c.enrollmentYear ?? year - 3) === enrollmentYear)
            .map((c) => c.id);
          const archived = await tx.archivedYear.create({
            data: {
              enrollmentYear,
              graduationYear: year,
              name: `${enrollmentYear} 级`,
              operatorName: '学年自动升级',
              classCount: ids.length,
              studentCount: await tx.student.count({ where: { classId: { in: ids }, status: 'active' } }),
            },
          });
          await tx.class.updateMany({
            where: { id: { in: ids } },
            data: { archivedYearId: archived.id, archivedAt: new Date() },
          });
          await tx.student.updateMany({
            where: { classId: { in: ids }, status: 'active' },
            data: { status: 'graduated', archivedYearId: archived.id, archivedAt: new Date() },
          });
        }
        for (const cls of classes.filter((c) => c.grade !== '高三'))
          await tx.class.update({
            where: { id: cls.id },
            data: {
              grade: cls.grade === '高一' ? '高二' : '高三',
              termStartDate: null,
              termWeeks: Math.min(cls.termWeeks, maxWeeks),
            },
          });
        for (let i = 1; i <= config.classCount; i++) {
          if (
            await tx.class.findFirst({ where: { enrollmentYear: year, classIndex: i, archivedYearId: null } })
          )
            continue;
          await tx.class.create({
            data: {
              name: formatClassName(year, i),
              enrollmentYear: year,
              classIndex: i,
              grade: '高一',
              teacherId: null,
              code: `N${year}${String(i).padStart(2, '0')}`,
              passwordHash,
              termWeeks: Math.min(20, maxWeeks),
            },
          });
        }
        await tx.termWeek.deleteMany();
        await tx.appSetting.upsert({
          where: { key: SETTING_KEYS.termStartDate },
          create: { key: SETTING_KEYS.termStartDate, value: `${year}-09-01` },
          update: { value: `${year}-09-01` },
        });
        await tx.promotionRun.update({
          where: { year },
          data: {
            status: 'done',
            message: '已升级、归档并建立无班主任/任课关系的新班骨架',
            finishedAt: new Date(),
          },
        });
      },
      { timeout: 30000 },
    );
  } catch (error) {
    if ((await prisma.promotionRun.findUnique({ where: { year } }))?.status === 'done')
      return prisma.promotionRun.findUniqueOrThrow({ where: { year } });
    await prisma.promotionRun.upsert({
      where: { year },
      create: { year, status: 'failed', snapshotPath, message: String(error) },
      update: { status: 'failed', message: String(error), snapshotPath },
    });
    throw ApiError.internal(`学年升级失败，事务已回滚：${String(error)}`);
  }
  await notifyScheduleChanged();
  return prisma.promotionRun.findUniqueOrThrow({ where: { year } });
}

let timer: ReturnType<typeof setInterval> | null = null;
export async function startPromotionScheduler() {
  if (timer) return;
  let observed = new Date();
  if ((await promotionStatus(observed)).pending)
    logger.warn('有遗漏的学年升级，请管理员在学期周次页查看预览与快照说明后补跑');
  timer = setInterval(() => {
    void (async () => {
      const now = new Date();
      const { config } = await promotionStatus(now);
      const due = new Date(
        now.getFullYear(),
        config.month - 1,
        Math.min(config.day, new Date(now.getFullYear(), config.month, 0).getDate()),
        config.hour,
      );
      if (observed < due && now >= due) await runPromotion(now.getFullYear());
      observed = now;
    })().catch((e) => logger.error(`自动升级失败：${String(e)}`));
  }, 30_000);
  timer.unref();
}
