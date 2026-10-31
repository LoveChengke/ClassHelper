import { assertAdmin, assertHeadOnly, assertPermissionOrClassDevice } from '../../lib/authz/index.js';
import { SOCKET_EVENTS } from '@classhelper/shared';
import { prisma } from '../../lib/db.js';
import { assertCanManageSchedule, assertClassAccess, getAccessibleClassIds } from '../../lib/access.js';
import { getMaxTermWeeks } from '../../lib/term.js';
import { ApiError } from '../../lib/http.js';
import type { TokenPayload } from '../../lib/jwt.js';
import { emitToClass } from '../../realtime/bus.js';
import { decorateLayout, planInclude } from '../../lib/class-plan.js';
import type { z } from 'zod';
import type {
  planSchema,
  layoutSchema,
  entriesSchema,
  groupSchema,
  datedPlanSchema,
} from './class-plans.schemas.js';

export async function notifyScheduleChanged(classId?: string | null) {
  const ids = classId
    ? [classId]
    : (await prisma.class.findMany({ where: { archivedYearId: null }, select: { id: true } })).map(
        (c) => c.id,
      );
  for (const id of ids) emitToClass(id, SOCKET_EVENTS.scheduleUpdated, { classId: id, action: 'updated' });
}
export async function listLayouts(user: TokenPayload, classId?: string) {
  await assertPermissionOrClassDevice(user, 'schedule:read');
  if (classId) await assertClassAccess(user, classId, 'schedule:read');
  const ids = classId ? [classId] : await getAccessibleClassIds(user, 'schedule:read');
  const rows = await prisma.timeLayout.findMany({
    where: { OR: [{ classId: null }, { classId: { in: ids } }] },
    include: { points: { orderBy: { position: 'asc' } } },
  });
  return Promise.all(rows.map((row) => decorateLayout(row)));
}
export async function saveLayout(user: TokenPayload, input: z.infer<typeof layoutSchema>, id?: string) {
  const existing = id
    ? await prisma.timeLayout.findUnique({ where: { id }, select: { classId: true } })
    : null;
  if (id && !existing) throw ApiError.notFound('时间表不存在');
  const layoutClassId = existing ? existing.classId : (input.classId ?? null);
  await assertLayoutWrite(user, layoutClassId, id);
  if (existing && input.classId !== undefined && input.classId !== existing.classId)
    throw ApiError.forbidden('不能移动时间表到其他班级');
  // 默认课程属于具体班级：全校时间表不保留默认课程，非上课时间点也不保留。
  const points = input.points.map((point) => ({
    ...point,
    defaultClassId: point.timeType === 'LESSON' && layoutClassId ? (point.defaultClassId ?? null) : null,
  }));
  const defaultIds = [...new Set(points.flatMap((p) => (p.defaultClassId ? [p.defaultClassId] : [])))];
  if (defaultIds.length && layoutClassId) {
    const count = await prisma.course.count({
      where: { id: { in: defaultIds }, classId: layoutClassId },
    });
    if (count !== defaultIds.length) throw ApiError.badRequest('默认课程不属于该班级');
  }
  const pointIds = points.flatMap((p) => (p.id ? [p.id] : []));
  if (new Set(pointIds).size !== pointIds.length) throw ApiError.badRequest('时间点不能重复');
  const result = await prisma.$transaction(async (tx) => {
    const layout = id
      ? await tx.timeLayout.update({ where: { id }, data: { name: input.name } })
      : await tx.timeLayout.create({
          data: { name: input.name, classId: input.classId ?? null, source: 'manual' },
        });
    const owned = await tx.timeLayoutItem.findMany({
      where: { timeLayoutId: layout.id },
      select: { id: true },
    });
    if (pointIds.some((p) => !owned.some((o) => o.id === p)))
      throw ApiError.badRequest('时间点不属于这份时间表');
    await tx.timeLayoutItem.deleteMany({ where: { timeLayoutId: layout.id, id: { notIn: pointIds } } });
    for (const [position, point] of points.entries()) {
      const { id: pointId, ...data } = point;
      if (pointId) await tx.timeLayoutItem.update({ where: { id: pointId }, data: { ...data, position } });
      else await tx.timeLayoutItem.create({ data: { ...data, position, timeLayoutId: layout.id } });
    }
    return tx.timeLayout.findUniqueOrThrow({
      where: { id: layout.id },
      include: { points: { orderBy: { position: 'asc' } } },
    });
  });
  await notifyScheduleChanged();
  return decorateLayout(result);
}

/**
 * 把时间点的默认课程写入所有引用该时间表的日课表（ClassIsland 的「覆盖现有课程」）。
 * 只处理班级时间表：全校时间表的默认课程没有归属班级。
 */
export async function applyDefaultCourse(user: TokenPayload, layoutId: string, pointId: string) {
  const layout = await prisma.timeLayout.findUnique({
    where: { id: layoutId },
    include: { points: true },
  });
  if (!layout) throw ApiError.notFound('时间表不存在');
  await assertLayoutWrite(user, layout.classId, layout.id);
  if (!layout.classId) throw ApiError.badRequest('全校时间表不能覆盖默认课程');
  const point = layout.points.find((p) => p.id === pointId);
  if (!point || point.timeType !== 'LESSON') throw ApiError.badRequest('时间点不是上课时间点');
  if (!point.defaultClassId) throw ApiError.badRequest('请先设置默认课程');
  const course = await prisma.course.findFirst({
    where: { id: point.defaultClassId, classId: layout.classId },
    select: { id: true },
  });
  if (!course) throw ApiError.badRequest('默认课程不属于该班级');
  const plans = await prisma.classPlan.findMany({
    where: { timeLayoutId: layout.id, classId: layout.classId },
    select: { id: true },
  });
  const courseId = point.defaultClassId;
  await prisma.$transaction(
    plans.map((plan) =>
      prisma.classPlanEntry.upsert({
        where: { classPlanId_timeLayoutItemId: { classPlanId: plan.id, timeLayoutItemId: point.id } },
        create: {
          classPlanId: plan.id,
          timeLayoutItemId: point.id,
          courseId,
          isEnabled: true,
        },
        update: { courseId, isEnabled: true },
      }),
    ),
  );
  await notifyScheduleChanged(layout.classId);
  return { plans: plans.length };
}
export async function listPlans(user: TokenPayload, classId?: string, week?: number) {
  await assertPermissionOrClassDevice(user, 'schedule:read');
  if (classId) await assertClassAccess(user, classId, 'schedule:read');
  return prisma.classPlan.findMany({
    where: {
      classId: { in: classId ? [classId] : await getAccessibleClassIds(user, 'schedule:read') },
      ...(week ? { weekStart: { lte: week }, weekEnd: { gte: week } } : {}),
    },
    include: planInclude,
    orderBy: [{ weekday: 'asc' }, { name: 'asc' }],
  });
}
export async function requirePlan(user: TokenPayload, id: string, write = true) {
  const p = await prisma.classPlan.findUnique({ where: { id }, include: planInclude });
  if (!p) throw ApiError.notFound('课表不存在');
  if (write) await assertCanManageSchedule(user, p.classId);
  else await assertClassAccess(user, p.classId, 'schedule:read');
  return p;
}
export async function savePlan(user: TokenPayload, input: z.infer<typeof planSchema>, id?: string) {
  await assertCanManageSchedule(user, input.classId);
  const maxWeek = await getMaxTermWeeks();
  if (input.weekStart > maxWeek) throw ApiError.badRequest('起始周超过全校上限');
  input = { ...input, weekEnd: Math.min(input.weekEnd, maxWeek) };
  if (id && (await requirePlan(user, id)).classId !== input.classId)
    throw ApiError.badRequest('不能移动课表到另一班');
  const layout = await prisma.timeLayout.findUnique({ where: { id: input.timeLayoutId } });
  if (!layout || (layout.classId && layout.classId !== input.classId))
    throw ApiError.badRequest('时间表不属于本班或全校');
  if (input.associatedGroup) {
    const group = await prisma.classPlanGroup.findUnique({ where: { id: input.associatedGroup } });
    if (group?.classId !== input.classId) throw ApiError.badRequest('课表群组不属于本班');
  }
  const result = id
    ? await prisma.classPlan.update({ where: { id }, data: input })
    : await prisma.classPlan.create({ data: input });
  await notifyScheduleChanged(input.classId);
  return result;
}
export async function saveEntries(user: TokenPayload, id: string, input: z.infer<typeof entriesSchema>) {
  const plan = await requirePlan(user, id);
  const ids = input.entries.map((e) => e.timeLayoutItemId);
  if (
    new Set(ids).size !== ids.length ||
    ids.some((id) => !plan.layout.points.some((p) => p.id === id && p.timeType === 'LESSON'))
  )
    throw ApiError.badRequest('时间点必须唯一且为本时间表的上课时间点');
  const courseIds = [...new Set(input.entries.flatMap((e) => (e.courseId ? [e.courseId] : [])))];
  const count = await prisma.course.count({ where: { id: { in: courseIds }, classId: plan.classId } });
  if (count !== courseIds.length) throw ApiError.badRequest('不能使用其他班级的课程');
  await prisma.$transaction(async (tx) => {
    await tx.classPlanEntry.deleteMany({ where: { classPlanId: id } });
    for (const e of input.entries) await tx.classPlanEntry.create({ data: { ...e, classPlanId: id } });
  });
  await notifyScheduleChanged(plan.classId);
  return requirePlan(user, id);
}
export async function clonePlan(user: TokenPayload, id: string, name?: string, overlayDate?: string) {
  const p = await requirePlan(user, id);
  const {
    id: _id,
    entries,
    layout: _layout,
    group: _group,
    createdAt: _created,
    updatedAt: _updated,
    scheduled: _scheduled,
    ...data
  } = { ...p, scheduled: undefined };
  const cloned = await prisma.classPlan.create({
    data: {
      ...data,
      name: name || `${p.name} 副本`,
      isEnabled: Boolean(overlayDate),
      isOverlay: Boolean(overlayDate),
      overlaySourceId: overlayDate ? id : null,
      overlayDate: overlayDate ?? null,
      entries: {
        create: entries.map((e) => ({
          timeLayoutItemId: e.timeLayoutItemId,
          courseId: e.courseId,
          location: e.location,
          isEnabled: e.isEnabled,
          isChangedClass: e.isChangedClass,
        })),
      },
    },
  });
  await notifyScheduleChanged(p.classId);
  return cloned;
}
export async function saveGroup(user: TokenPayload, input: z.infer<typeof groupSchema>, id?: string) {
  await assertCanManageSchedule(user, input.classId);
  if (id) {
    const current = await prisma.classPlanGroup.findUnique({ where: { id } });
    if (current?.classId !== input.classId) throw ApiError.forbidden('无权修改该群组');
  }
  const result = await prisma.$transaction(async (tx) => {
    if (input.isDefault)
      await tx.classPlanGroup.updateMany({ where: { classId: input.classId }, data: { isDefault: false } });
    return id
      ? tx.classPlanGroup.update({ where: { id }, data: input })
      : tx.classPlanGroup.create({ data: input });
  });
  await notifyScheduleChanged(input.classId);
  return result;
}
export async function schedulePlan(user: TokenPayload, input: z.infer<typeof datedPlanSchema>) {
  const p = await requirePlan(user, input.classPlanId);
  if (p.classId !== input.classId) throw ApiError.badRequest('课表不属于本班');
  const result = await prisma.scheduledClassPlan.upsert({
    where: { classId_date: { classId: input.classId, date: input.date } },
    create: { classId: input.classId, classPlanId: input.classPlanId, date: input.date },
    update: { classPlanId: input.classPlanId },
  });
  await notifyScheduleChanged(input.classId);
  return result;
}

/** 临时层、换课及预定在同一事务发布，客户端不会先收到尚未换完的中间课表。 */
export async function createOverlay(
  user: TokenPayload,
  id: string,
  date: string,
  swap?: { first: string; second: string },
) {
  const source = await requirePlan(user, id);
  const a = source.entries.find((e) => e.timeLayoutItemId === swap?.first),
    b = source.entries.find((e) => e.timeLayoutItemId === swap?.second);
  if (swap && (!a || !b || a.id === b.id)) throw ApiError.badRequest('请选择两节不同的课');
  const result = await prisma.$transaction(async (tx) => {
    const p = await tx.classPlan.create({
      data: {
        classId: source.classId,
        name: `${source.name} 临时层`,
        timeLayoutId: source.timeLayoutId,
        weekday: source.weekday,
        weekCountDiv: source.weekCountDiv,
        weekCountDivTotal: source.weekCountDivTotal,
        weekStart: source.weekStart,
        weekEnd: source.weekEnd,
        associatedGroup: source.associatedGroup,
        isOverlay: true,
        isEnabled: true,
        overlaySourceId: source.id,
        overlayDate: date,
        entries: {
          create: source.entries.map((e) => ({
            timeLayoutItemId: e.timeLayoutItemId,
            courseId:
              swap && e.id === a?.id ? b!.courseId : swap && e.id === b?.id ? a!.courseId : e.courseId,
            isEnabled: e.isEnabled,
            isChangedClass: Boolean(swap && (e.id === a?.id || e.id === b?.id)),
            location: e.location,
          })),
        },
      },
    });
    return tx.scheduledClassPlan.upsert({
      where: { classId_date: { classId: source.classId, date } },
      create: { classId: source.classId, date, classPlanId: p.id },
      update: { classPlanId: p.id },
    });
  });
  await notifyScheduleChanged(source.classId);
  return result;
}

export async function assertLayoutWrite(user: TokenPayload, classId: string | null, layoutId?: string) {
  if (classId) await assertHeadOnly(user, 'schedule:write', classId);
  else assertAdmin(user);
  if (layoutId) {
    const refs = await prisma.classPlan.findMany({
      where: { timeLayoutId: layoutId },
      select: { classId: true },
    });
    for (const id of new Set(refs.map((p) => p.classId))) await assertHeadOnly(user, 'schedule:write', id);
  }
}
export async function deleteLayout(user: TokenPayload, id: string) {
  const layout = await prisma.timeLayout.findUnique({ where: { id } });
  if (!layout) throw ApiError.notFound('时间表不存在');
  await assertLayoutWrite(user, layout.classId, id);
  if (await prisma.classPlan.count({ where: { timeLayoutId: id } }))
    throw ApiError.conflict('仍有课表使用该时间表');
  await prisma.timeLayout.delete({ where: { id } });
  await notifyScheduleChanged(layout.classId);
}
