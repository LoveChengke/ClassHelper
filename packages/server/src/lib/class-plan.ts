import {
  dayKeyLocal,
  resolveClassStatus,
  type CourseBrief,
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

/** 时间点的默认课程映射（defaultClassId → 课程摘要）。 */
export type DefaultCourseMap = Map<string, CourseBrief>;

/**
 * 一次性取出时间表里所有默认课程。
 *
 * 刻意不在 Prisma 里给 `TimeLayoutItem.defaultClassId` 加关系：该字段早已存在，
 * 加外键要重建表；这里按 id 查一次课程即可，SQLite/MySQL 都通用。
 */
export async function loadDefaultCourseMap(
  points: ReadonlyArray<{ defaultClassId: string | null }>,
): Promise<DefaultCourseMap> {
  const ids = [...new Set(points.flatMap((p) => (p.defaultClassId ? [p.defaultClassId] : [])))];
  if (!ids.length) return new Map();
  const courses = await prisma.course.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true },
  });
  return new Map(courses.map((course) => [course.id, course]));
}

/** 给时间表时间点附加默认课程，供 Web 编辑器与客户端读取。 */
export async function decorateLayout<
  T extends { classId: string | null; points: Array<{ defaultClassId: string | null }> },
>(
  layout: T,
): Promise<
  Omit<T, 'points'> & { points: Array<T['points'][number] & { defaultCourse: CourseBrief | null }> }
> {
  const defaults = await loadDefaultCourseMap(layout.points);
  return {
    ...layout,
    points: layout.points.map((point) => ({
      ...point,
      // 全校时间表不能携带默认课程。
      defaultCourse:
        layout.classId && point.defaultClassId ? (defaults.get(point.defaultClassId) ?? null) : null,
    })),
  };
}

/**
 * 日课表投影。
 *
 * 按**时间表的 LESSON 时间点**遍历，而不是只遍历已保存的条目：
 * - 有条目：以条目为准（停用则整节不出现，课程为空则是显式空课，不回退）；
 * - 没有条目：回退时间点的默认课程。
 * 默认课程的回退项没有 `ClassPlanEntry`，用 `default:<planId>:<pointId>` 作为稳定 id，
 * 仅供读取展示；旧 `/schedules` 写接口不会命中它。
 */
export function projectPlan(plan: PlanRow, defaults: DefaultCourseMap = new Map()): ScheduleDto[] {
  const entryOf = new Map(plan.entries.map((entry) => [entry.timeLayoutItemId, entry]));
  return plan.layout.points
    .filter((point) => point.timeType === 'LESSON')
    .flatMap<ScheduleDto>((point) => {
      const entry = entryOf.get(point.id);
      if (entry && !entry.isEnabled) return [];
      // 全校时间表不能携带默认课程：旧数据即使残留 DefaultClassId 也不参与回退，
      // 否则会把这门课泄漏到别的班级。
      const fallback =
        !entry && point.defaultClassId && plan.layout.classId
          ? (defaults.get(point.defaultClassId) ?? null)
          : null;
      const course = entry ? (entry.course ?? null) : fallback;
      if (!course) return [];
      return [
        {
          id: entry?.legacyScheduleId || entry?.id || `default:${plan.id}:${point.id}`,
          classId: plan.classId,
          courseId: course.id,
          course,
          dayOfWeek: plan.weekday || 1,
          startTime: point.startTime,
          endTime: point.endTime,
          location: entry?.location ?? null,
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
        },
      ];
    })
    .sort((a, b) => a.startTime.localeCompare(b.startTime));
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
  const defaults = plan ? await loadDefaultCourseMap(plan.layout.points) : new Map<string, CourseBrief>();
  const schedules = plan
    ? projectPlan(plan, defaults).map((s) => ({
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
            defaultCourse:
              plan.layout.classId && p.defaultClassId ? (defaults.get(p.defaultClassId) ?? null) : null,
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
