import { prisma } from '../../lib/db.js';
import { assertClassAccess } from '../../lib/access.js';
import type { TokenPayload } from '../../lib/jwt.js';

/** 按时间点外键生成完整档案，空课、停用课程与非上课时间点均保留。 */
export async function exportProfile(user: TokenPayload, classId: string) {
  await assertClassAccess(user, classId);
  const [cls, layouts, plans, subjects, groups, scheduled, setting] = await Promise.all([
    prisma.class.findUniqueOrThrow({ where: { id: classId } }),
    prisma.timeLayout.findMany({
      where: { OR: [{ classId }, { classId: null }] },
      include: { points: { orderBy: { position: 'asc' } } },
    }),
    prisma.classPlan.findMany({ where: { classId }, include: { entries: true } }),
    prisma.course.findMany({ where: { classId } }),
    prisma.classPlanGroup.findMany({ where: { classId } }),
    prisma.scheduledClassPlan.findMany({ where: { classId } }),
    prisma.appSetting.findUnique({ where: { key: `schedule.group.${classId}` } }),
  ]);
  let selection: {
    selected?: string;
    temporary?: string;
    expireTime?: string;
    temporaryPlan?: string;
    temporaryPlanDate?: string;
  } = {};
  try {
    selection = JSON.parse(setting?.value || '{}');
  } catch {
    /* 使用默认群组 */
  }
  const types = ['LESSON', 'BREAK', 'DIVIDER', 'ACTION'];
  const actions = (value: string) => {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  };
  return {
    Name: cls.name,
    Subjects: Object.fromEntries(
      subjects.map((s) => [s.id, { Name: s.name, Initial: s.initial, IsOutDoor: s.isOutDoor }]),
    ),
    TimeLayouts: Object.fromEntries(
      layouts.map((l) => [
        l.id,
        {
          Name: l.name,
          IsOverlay: l.isOverlay,
          OverlaySourceId: l.overlaySourceId,
          Layouts: l.points.map((p) => ({
            Name: p.name,
            StartTime: p.startTime,
            EndTime: p.endTime,
            TimeType: types.indexOf(p.timeType),
            IsHideDefault: p.isHideDefault,
            DefaultClassId: p.defaultClassId,
            BreakName: p.breakName,
            ActionSet: actions(p.actionSet),
          })),
        },
      ]),
    ),
    ClassPlans: Object.fromEntries(
      plans.map((p) => [
        p.id,
        {
          Name: p.name,
          TimeLayoutId: p.timeLayoutId,
          AssociatedGroup: p.associatedGroup,
          TimeRule: {
            WeekDay: p.weekday,
            WeekCountDiv: p.weekCountDiv,
            WeekCountDivTotal: p.weekCountDivTotal,
          },
          WeekStart: p.weekStart,
          WeekEnd: p.weekEnd,
          IsEnabled: p.isEnabled,
          IsOverlay: p.isOverlay,
          OverlaySourceId: p.overlaySourceId,
          OverlayDate: p.overlayDate,
          Classes: (layouts.find((l) => l.id === p.timeLayoutId)?.points || [])
            .filter((point) => point.timeType === 'LESSON')
            .map((point) => {
              const e = p.entries.find((entry) => entry.timeLayoutItemId === point.id);
              return {
                SubjectId: e?.courseId || '',
                IsEnabled: e?.isEnabled ?? true,
                IsChangedClass: e?.isChangedClass ?? false,
                Location: e?.location || '',
              };
            }),
        },
      ]),
    ),
    ClassPlanGroups: Object.fromEntries(groups.map((g) => [g.id, { Name: g.name, IsGlobal: g.isGlobal }])),
    SelectedClassPlanGroupId: selection.selected || groups.find((g) => g.isDefault)?.id || '',
    TempClassPlanGroupId: selection.temporary || '',
    IsTempClassPlanGroupEnabled: !!selection.temporary,
    TempClassPlanGroupExpireTime: selection.expireTime,
    TempClassPlanId: selection.temporaryPlan,
    TempClassPlanSetupTime: selection.temporaryPlanDate,
    OrderedSchedules: Object.fromEntries(scheduled.map((s) => [s.date, { ClassPlanId: s.classPlanId }])),
  };
}
