import {
  dayKeyLocal,
  resolveClassStatus,
  type ScheduleDto,
  type ActiveClassPlanDto,
} from '@classhelper/shared';
import { prisma } from './db.js';
import { loadTermContext, resolveCurrentWeek } from './term.js';

export const planInclude = {
  entries: { include: { course: { select: { id: true, name: true } }, timePoint: true } },
  layout: { include: { points: { orderBy: { position: 'asc' as const } } } },
  group: true,
} as const;
export type PlanRow = NonNullable<Awaited<ReturnType<typeof loadPlans>>>[number];
export async function loadPlans(classId: string) {
  return prisma.classPlan.findMany({
    where: { classId },
    include: planInclude,
    orderBy: { updatedAt: 'desc' },
  });
}
export function projectPlan(plan: PlanRow): ScheduleDto[] {
  return plan.entries
    .filter((e) => e.isEnabled && e.course && e.timePoint.timeType === 'LESSON')
    .map((e) => ({
      id: e.legacyScheduleId || e.id,
      classId: plan.classId,
      courseId: e.courseId!,
      course: e.course!,
      dayOfWeek: plan.weekday || 1,
      startTime: e.timePoint.startTime,
      endTime: e.timePoint.endTime,
      location: e.location,
      weekStart: plan.weekStart,
      weekEnd: plan.weekEnd,
      weekParity:
        plan.weekCountDivTotal === 2 && plan.weekCountDiv
          ? plan.weekCountDiv === 1
            ? 'ODD'
            : 'EVEN'
          : 'ALL',
      source: 'manual',
      createdAt: plan.createdAt.toISOString(),
      updatedAt: plan.updatedAt.toISOString(),
    }));
}

/**
 * 唯一日课表解析器。按现场上游 LessonsService.GetClassPlanByDate：
 * 预定（含预定临时层）→临时课表→有效临时群/选定群的 TimeRule→全局群→无群默认。
 * 上游现在把临时层也作为预定课表；本地 overlayDate 保留同日临时层兼容。
 * IsActivated 是运行态，不落库；周次只用 loadTermContext/resolveCurrentWeek。
 */
export async function resolveActiveClassPlan(
  classId: string,
  date: Date = new Date(),
): Promise<ActiveClassPlanDto> {
  const day = dayKeyLocal(date);
  const weekday = date.getDay() || 7;
  const week = resolveCurrentWeek(date, await loadTermContext(classId));
  const [plans, scheduled, setting] = await Promise.all([
    loadPlans(classId),
    prisma.scheduledClassPlan.findUnique({ where: { classId_date: { classId, date: day } } }),
    prisma.appSetting.findUnique({ where: { key: `schedule.group.${classId}` } }),
  ]);
  let groupId: string | null = null;
  let temporaryPlanId: string | null = null;
  if (setting) {
    try {
      const value = JSON.parse(setting.value) as {
        selected?: string;
        temporary?: string;
        expireTime?: string;
        temporaryPlan?: string;
        temporaryPlanDate?: string;
      };
      temporaryPlanId = value.temporaryPlanDate === day ? value.temporaryPlan || null : null;
      groupId =
        value.temporary && value.expireTime && new Date(value.expireTime) >= date
          ? value.temporary
          : value.selected || null;
    } catch {
      /* 非法/旧设置回到默认群 */
    }
  }
  const matches = (p: PlanRow) =>
    p.isEnabled &&
    !p.isOverlay &&
    (p.weekday === 0 || p.weekday === weekday) &&
    week >= p.weekStart &&
    week <= p.weekEnd &&
    (p.weekCountDiv === 0 || ((week - 1) % p.weekCountDivTotal) + 1 === p.weekCountDiv);
  const candidates = plans.filter(matches);
  const plan =
    plans.find((p) => p.id === scheduled?.classPlanId) ??
    plans.find((p) => p.id === temporaryPlanId) ??
    plans.find((p) => p.isOverlay && p.overlayDate === day && p.isEnabled) ??
    candidates.find(
      (p) => p.associatedGroup && (groupId ? p.associatedGroup === groupId : p.group?.isDefault),
    ) ??
    candidates.find((p) => p.group?.isGlobal) ??
    candidates.find((p) => !p.associatedGroup) ??
    null;
  const schedules = plan
    ? projectPlan(plan).map((s) => ({
        ...s,
        dayOfWeek: weekday,
        weekStart: week,
        weekEnd: week,
      }))
    : [];
  const status = resolveClassStatus(schedules, date, week);
  return {
    classPlan: plan,
    timeLayout: plan
      ? {
          ...plan.layout,
          points: plan.layout.points.map((p) => ({
            ...p,
            timeType: p.timeType as 'LESSON' | 'BREAK' | 'DIVIDER' | 'ACTION',
          })),
        }
      : null,
    schedules,
    week,
    current: status.current,
    next: status.next,
    inClass: status.inClass,
  };
}
