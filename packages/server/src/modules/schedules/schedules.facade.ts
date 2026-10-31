import { getMaxTermWeeks as normalizeMaxWeeks } from '@classhelper/shared';
import { randomUUID } from 'node:crypto';
import {
  buildScheduleWeekView,
  dayKeyLocal,
  shiftDayKey,
  type ScheduleDto,
  type ClassStatusDto,
  type ScheduleWeekView,
} from '@classhelper/shared';
import { prisma } from '../../lib/db.js';
import {
  assertClassAccess,
  assertCanManageSchedule,
  getAccessibleClassIds,
  isClassDevice,
  requireClassDeviceClassId,
} from '../../lib/access.js';
import {
  loadDefaultCourseMap,
  loadPlans,
  planInclude,
  projectPlan,
  resolveActiveClassPlan,
  type PlanRow,
} from '../../lib/class-plan.js';
import { loadTermContext, resolveCurrentWeek, getMaxTermWeeks } from '../../lib/term.js';
import { ApiError } from '../../lib/http.js';
import type { TokenPayload } from '../../lib/jwt.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { CreateScheduleInput, UpdateScheduleInput } from './schedules.schemas.js';
import { notifyScheduleChanged } from '../class-plans/class-plans.service.js';
export interface ListScheduleOptions {
  classId?: string;
  week?: number;
  dayOfWeek?: number;
}
/** 兼容门面只投影/写入新模型；旧 Schedule 保留作迁移审计来源，避免两份业务真值。 */
export async function listSchedules(
  user: TokenPayload,
  options: ListScheduleOptions,
): Promise<ScheduleDto[]> {
  if (options.classId) await assertClassAccess(user, options.classId, 'schedule:read');
  const classIds = options.classId ? [options.classId] : await getAccessibleClassIds(user, 'schedule:read');
  const result: ScheduleDto[] = [];
  for (const classId of classIds) {
    if (options.week) {
      if (options.week > (await loadTermContext(classId)).maxWeek) continue;
      const dates = await datesForWeek(classId, options.week);
      for (const date of dates) {
        const weekday = date.getDay() || 7;
        if (options.dayOfWeek && options.dayOfWeek !== weekday) continue;
        result.push(...(await resolveActiveClassPlan(classId, date)).schedules);
      }
    } else {
      const plans = await loadPlans(classId);
      const defaults = await loadDefaultCourseMap(plans.flatMap((plan) => plan.layout.points));
      for (const plan of plans)
        if (!plan.isOverlay && (!options.dayOfWeek || plan.weekday === options.dayOfWeek))
          result.push(...projectPlan(plan, defaults));
    }
  }
  const byId = new Map<string, ScheduleDto>();
  for (const row of result) {
    const previous = byId.get(row.id);
    if (previous) {
      previous.weekStart = Math.min(previous.weekStart, row.weekStart);
      previous.weekEnd = Math.max(previous.weekEnd, row.weekEnd);
    } else byId.set(row.id, { ...row });
  }
  const metadata = await prisma.appSetting.findMany({
    where: { key: { in: [...byId.keys()].map((id) => 'schedule.compat.' + id) } },
  });
  for (const row of metadata) {
    try {
      const item = byId.get(row.key.replace('schedule.compat.', ''));
      if (item) Object.assign(item, JSON.parse(row.value));
    } catch {
      /* 损坏的兼容元数据不影响新模型 */
    }
  }
  return [...byId.values()].sort(
    (a, b) => a.dayOfWeek - b.dayOfWeek || a.startTime.localeCompare(b.startTime),
  );
}
async function datesForWeek(classId: string, week: number) {
  const context = await loadTermContext(classId);
  const first =
    context.weeks.find((w) => w.weekNumber === week)?.startDate ||
    shiftDayKey(context.termStartDate, (week - 1) * 7);
  const date = new Date(`${first}T12:00:00`);
  const monday = shiftDayKey(dayKeyLocal(date), -((date.getDay() || 7) - 1));
  return Array.from({ length: 7 }, (_, i) => new Date(`${shiftDayKey(monday, i)}T12:00:00`));
}
export async function getActiveScheduleWeek(
  user: TokenPayload,
  options: { classId?: string; week?: number },
) {
  const classId = isClassDevice(user) ? requireClassDeviceClassId(user) : options.classId;
  if (!classId) throw ApiError.badRequest('请指定班级');
  await assertClassAccess(user, classId, 'schedule:read');
  const context = await loadTermContext(classId),
    week = options.week ?? resolveCurrentWeek(new Date(), context);
  if (week > context.maxWeek) throw ApiError.badRequest('周次超过本班教学周数');
  const days = [];
  for (const date of await datesForWeek(classId, week))
    days.push({
      weekday: date.getDay() || 7,
      date: dayKeyLocal(date),
      ...(await resolveActiveClassPlan(classId, date)),
    });
  return { classId, week, days };
}
export async function getScheduleGrid(
  user: TokenPayload,
  options: { classId?: string; week?: number },
): Promise<ScheduleWeekView> {
  const week = options.week ?? resolveCurrentWeek(new Date(), await loadTermContext(options.classId));
  return buildScheduleWeekView(await listSchedules(user, { ...options, week }), week);
}
export async function computeClassStatus(classId: string, at = new Date()): Promise<ClassStatusDto> {
  return { ...(await resolveActiveClassPlan(classId, at)), classId, serverTime: at.toISOString() };
}
export async function getClassStatus(user: TokenPayload, options: { classId?: string; at?: Date } = {}) {
  const classId = isClassDevice(user) ? requireClassDeviceClassId(user) : options.classId;
  if (!classId) throw ApiError.badRequest('请指定班级');
  await assertClassAccess(user, classId, 'schedule:read');
  return computeClassStatus(classId, options.at);
}

type Tx = Prisma.TransactionClient;
async function privateLayout(tx: Tx, plan: PlanRow) {
  const layout = await tx.timeLayout.create({
    data: { classId: plan.classId, name: `${plan.name} 作息`, source: 'manual' },
  });
  const mapping = new Map<string, string>();
  for (const p of plan.layout.points) {
    const { id: _id, timeLayoutId: _layout, ...data } = p;
    const point = await tx.timeLayoutItem.create({ data: { ...data, timeLayoutId: layout.id } });
    mapping.set(p.id, point.id);
  }
  return { layout, mapping };
}
function matches(p: PlanRow, day: number, week: number) {
  return (
    p.isEnabled &&
    !p.isOverlay &&
    (p.weekday === day || p.weekday === 0) &&
    week >= p.weekStart &&
    week <= p.weekEnd &&
    (p.weekCountDiv === 0 || ((week - 1) % p.weekCountDivTotal) + 1 === p.weekCountDiv)
  );
}
async function assertCourse(courseId: string, classId: string, db: Tx = prisma) {
  if (!(await db.course.findFirst({ where: { id: courseId, classId } })))
    throw ApiError.badRequest('课程不属于本班');
}
export async function createSchedule(
  user: TokenPayload,
  input: CreateScheduleInput,
  transaction?: Tx,
  identity?: string,
): Promise<ScheduleDto> {
  await assertCanManageSchedule(user, input.classId, transaction);
  await assertCourse(input.courseId, input.classId, transaction);
  const cls = await (transaction ?? prisma).class.findUniqueOrThrow({ where: { id: input.classId } }),
    max = transaction
      ? normalizeMaxWeeks(
          (await transaction.appSetting.findUnique({ where: { key: 'term.maxWeeks' } }))?.value,
        )
      : await getMaxTermWeeks();
  const start = input.weekStart ?? 1,
    end = input.weekEnd ?? Math.min(cls.termWeeks, max);
  if (start > end || end > max) throw ApiError.badRequest('课表周次范围超过全校上限');
  const legacyId = identity || randomUUID(),
    plans = transaction
      ? await transaction.classPlan.findMany({
          where: { classId: input.classId },
          include: planInclude,
          orderBy: { updatedAt: 'desc' },
        })
      : await loadPlans(input.classId);
  let result: ScheduleDto | undefined;
  const write = async (tx: Tx) => {
    const key = 'schedule.compat.' + legacyId,
      value = JSON.stringify({ weekStart: start, weekEnd: end, weekParity: input.weekParity ?? 'ALL' });
    await tx.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
    for (let week = start; week <= end; week++) {
      if (input.weekParity && input.weekParity !== 'ALL' && input.weekParity !== (week % 2 ? 'ODD' : 'EVEN'))
        continue;
      const source =
        plans.find((p) => matches(p, input.dayOfWeek, week) && p.group?.isDefault) ??
        plans.find((p) => matches(p, input.dayOfWeek, week) && !p.associatedGroup) ??
        plans.find((p) => matches(p, input.dayOfWeek, week) && p.group?.isGlobal);
      const privateData = source
        ? await privateLayout(tx, source)
        : {
            layout: await tx.timeLayout.create({
              data: {
                classId: input.classId,
                name: `第${week}周星期${input.dayOfWeek}作息`,
                source: 'manual',
              },
            }),
            mapping: new Map<string, string>(),
          };
      const target = await tx.classPlan.create({
        data: {
          classId: input.classId,
          name: `第${week}周星期${input.dayOfWeek}`,
          timeLayoutId: privateData.layout.id,
          associatedGroup: source?.associatedGroup,
          weekday: input.dayOfWeek,
          weekStart: week,
          weekEnd: week,
        },
      });
      if (source)
        for (const e of source.entries)
          await tx.classPlanEntry.create({
            data: {
              classPlanId: target.id,
              timeLayoutItemId: privateData.mapping.get(e.timeLayoutItemId)!,
              courseId: e.courseId,
              isEnabled: e.isEnabled,
              isChangedClass: e.isChangedClass,
              location: e.location,
              legacyScheduleId: e.legacyScheduleId,
            },
          });
      let point = await tx.timeLayoutItem.findFirst({
        where: {
          timeLayoutId: privateData.layout.id,
          startTime: input.startTime,
          endTime: input.endTime,
          timeType: 'LESSON',
        },
      });
      if (!point)
        point = await tx.timeLayoutItem.create({
          data: {
            timeLayoutId: privateData.layout.id,
            position: source?.layout.points.length || 0,
            startTime: input.startTime,
            endTime: input.endTime,
          },
        });
      await tx.classPlanEntry.upsert({
        where: { classPlanId_timeLayoutItemId: { classPlanId: target.id, timeLayoutItemId: point.id } },
        create: {
          classPlanId: target.id,
          timeLayoutItemId: point.id,
          courseId: input.courseId,
          location: input.location,
          legacyScheduleId: legacyId,
        },
        update: { courseId: input.courseId, location: input.location, legacyScheduleId: legacyId },
      });
      const full = await tx.classPlan.findUniqueOrThrow({ where: { id: target.id }, include: planInclude });
      result = projectPlan(full).find((e) => e.id === legacyId);
    }
  };
  if (transaction) await write(transaction);
  else await prisma.$transaction(write, { timeout: 30000 });
  if (!result) throw ApiError.badRequest('所选范围没有符合单双周的教学周');
  if (!transaction) await notifyScheduleChanged(input.classId);
  return { ...result, weekStart: start, weekEnd: end, weekParity: input.weekParity ?? 'ALL' };
}
export async function updateSchedule(
  user: TokenPayload,
  id: string,
  input: UpdateScheduleInput,
): Promise<ScheduleDto> {
  const entries = await prisma.classPlanEntry.findMany({
    where: { OR: [{ id }, { legacyScheduleId: id }] },
    include: { plan: { include: planInclude } },
  });
  if (!entries.length) throw ApiError.notFound('课表记录不存在');
  const stored = await prisma.appSetting.findUnique({ where: { key: 'schedule.compat.' + id } });
  const rule: Partial<{ weekStart: number; weekEnd: number; weekParity: 'ALL' | 'ODD' | 'EVEN' }> = stored
    ? JSON.parse(stored.value)
    : {};
  for (const targetClassId of new Set(entries.map((e) => e.plan.classId)))
    await assertCanManageSchedule(user, targetClassId);
  const classId = entries[0]!.plan.classId;
  await assertCanManageSchedule(user, classId);
  if (input.courseId) await assertCourse(input.courseId, classId);
  if (
    input.dayOfWeek !== undefined ||
    input.weekStart !== undefined ||
    input.weekEnd !== undefined ||
    input.weekParity !== undefined
  ) {
    const first = entries[0]!,
      point = first.plan.layout.points.find((p) => p.id === first.timeLayoutItemId)!;
    if (!first.courseId && !input.courseId) throw ApiError.badRequest('请选择科目');
    const weeks = entries.map((e) => e.plan.weekStart).sort((a, b) => a - b);
    const parity =
      weeks.length > 1 && weeks.every((w, i) => i === 0 || w - weeks[i - 1] === 2)
        ? weeks[0]! % 2
          ? 'ODD'
          : 'EVEN'
        : 'ALL';
    const value: CreateScheduleInput = {
      classId,
      courseId: input.courseId || first.courseId!,
      dayOfWeek: input.dayOfWeek ?? first.plan.weekday,
      startTime: input.startTime ?? point.startTime,
      endTime: input.endTime ?? point.endTime,
      weekStart: input.weekStart ?? rule.weekStart ?? Math.min(...weeks),
      weekEnd: input.weekEnd ?? rule.weekEnd ?? Math.max(...entries.map((e) => e.plan.weekEnd)),
      weekParity: input.weekParity ?? rule.weekParity ?? parity,
      location: input.location === undefined ? first.location : input.location,
    };
    const result = await prisma.$transaction(
      async (tx) => {
        await tx.classPlanEntry.deleteMany({ where: { id: { in: entries.map((e) => e.id) } } });
        return createSchedule(user, value, tx, id);
      },
      { timeout: 30000 },
    );
    await notifyScheduleChanged(classId);
    return result;
  }
  const max = await getMaxTermWeeks();
  if ((input.weekEnd ?? 1) > max) throw ApiError.badRequest('周次超过全校上限');
  let result: ScheduleDto | undefined;
  await prisma.$transaction(
    async (tx) => {
      for (const row of entries) {
        const oldPoint = row.plan.layout.points.find((p) => p.id === row.timeLayoutItemId)!;
        const startTime = input.startTime ?? oldPoint.startTime,
          endTime = input.endTime ?? oldPoint.endTime;
        if (startTime >= endTime) throw ApiError.badRequest('结束时间必须晚于开始时间');
        const copy = await privateLayout(tx, row.plan);
        for (const e of row.plan.entries)
          await tx.classPlanEntry.update({
            where: { id: e.id },
            data: { timeLayoutItemId: copy.mapping.get(e.timeLayoutItemId)! },
          });
        await tx.classPlan.update({
          where: { id: row.plan.id },
          data: {
            timeLayoutId: copy.layout.id,
            ...(input.dayOfWeek ? { weekday: input.dayOfWeek } : {}),
            ...(input.weekStart ? { weekStart: input.weekStart } : {}),
            ...(input.weekEnd ? { weekEnd: input.weekEnd } : {}),
            ...(input.weekParity
              ? {
                  weekCountDiv: input.weekParity === 'ALL' ? 0 : input.weekParity === 'ODD' ? 1 : 2,
                  weekCountDivTotal: 2,
                }
              : {}),
          },
        });
        await tx.timeLayoutItem.update({
          where: { id: copy.mapping.get(row.timeLayoutItemId)! },
          data: { startTime, endTime },
        });
        await tx.classPlanEntry.update({
          where: { id: row.id },
          data: {
            ...(input.courseId ? { courseId: input.courseId } : {}),
            ...(input.location !== undefined ? { location: input.location } : {}),
          },
        });
        result = projectPlan(
          await tx.classPlan.findUniqueOrThrow({ where: { id: row.plan.id }, include: planInclude }),
        ).find((e) => e.id === id);
      }
    },
    { timeout: 30000 },
  );
  await notifyScheduleChanged(classId);
  if (!result) throw ApiError.notFound('课表记录不存在');
  return { ...result, ...rule };
}
export async function deleteSchedule(user: TokenPayload, id: string) {
  const entries = await prisma.classPlanEntry.findMany({
    where: { OR: [{ id }, { legacyScheduleId: id }] },
    select: { id: true, plan: { select: { classId: true } } },
  });
  if (!entries.length) throw ApiError.notFound('课表记录不存在');
  for (const classId of new Set(entries.map((e) => e.plan.classId)))
    await assertCanManageSchedule(user, classId);
  await prisma.classPlanEntry.deleteMany({ where: { id: { in: entries.map((e) => e.id) } } });
  for (const classId of new Set(entries.map((e) => e.plan.classId))) await notifyScheduleChanged(classId);
}
