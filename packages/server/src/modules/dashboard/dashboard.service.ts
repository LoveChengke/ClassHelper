import type { DashboardSummary, HomeworkDto, NotificationDto } from '@classhelper/shared';
import {
  assertClassAccess,
  classScopeIdFilter,
  classScopeWhere,
  isClassDevice,
  resolveClassScope,
  requireClassDeviceClassId,
} from '../../lib/access.js';
import { prisma } from '../../lib/db.js';
import { MAX_TERM_WEEK } from '../../lib/term.js';
import type { TokenPayload } from '../../lib/jwt.js';
import { toHomeworkDto, toNotificationDto } from '../../lib/mappers.js';
import { personalIdWhere, resolvePersonalIds } from '../../lib/session.js';

const courseSelect = { select: { id: true, name: true } } as const;
const creatorSelect = { select: { id: true, name: true, username: true } } as const;

/**
 * 本班教学周数（默认 20）。
 * - ClassHelper 班级端：固定为自己绑定的班级；
 * - 教师 / 管理员：优先用显式 classId，**并且必须通过班级访问校验**（与其他接口同口径，
 *   否则任意登录用户都能拿 classId 探测别班的教学周数）；
 * - 都不传：全局默认（MAX_TERM_WEEK 兜底）。
 */
export async function resolveTermWeeks(user: TokenPayload, classId?: string): Promise<number> {
  if (classId) await assertClassAccess(user, classId);
  const targetClassId = classId ?? (isClassDevice(user) ? requireClassDeviceClassId(user) : undefined);
  if (!targetClassId) return MAX_TERM_WEEK;
  const record = await prisma.class.findUnique({
    where: { id: targetClassId },
    select: { termWeeks: true },
  });
  return record?.termWeeks && record.termWeeks > 0 ? record.termWeeks : MAX_TERM_WEEK;
}

/**
 * 仪表盘汇总。
 * 教师/管理员看到的是"自己管理的班级"的汇总；ClassHelper 班级端看到自己绑定班级的汇总。
 */
export async function getDashboardSummary(user: TokenPayload): Promise<DashboardSummary> {
  const device = isClassDevice(user);
  // 班级端强制限定在自己班级，避免越权统计
  const scope = await resolveClassScope(user, device ? requireClassDeviceClassId(user) : undefined);
  // 子表按 classId 过滤；Class 表本身按主键 id 过滤
  const where = classScopeWhere(scope);
  const classWhere = classScopeIdFilter(scope);
  // ClassHelper 班级端以全班学生为范围
  const personalIds = await resolvePersonalIds(user);
  const personalWhere = personalIdWhere(personalIds);

  const [
    classCount,
    studentCount,
    courseCount,
    scheduleCount,
    homeworkCount,
    notificationCount,
    gradeCount,
    unreadNotificationCount,
    pendingHomeworkCount,
    recentNotifications,
    recentHomeworks,
  ] = await Promise.all([
    // 学生数只算在读的：已毕业/转出的学生不属于"本班现在有多少人"
    prisma.class.count({ where: classWhere }),
    prisma.student.count({ where: { ...where, status: 'active', archivedYearId: null } }),
    prisma.course.count({ where }),
    prisma.schedule.count({ where }),
    prisma.homework.count({ where }),
    prisma.notification.count({ where }),
    prisma.grade.count({ where }),
    prisma.notification.count({ where: { ...where, reads: { none: personalWhere } } }),
    device
      ? prisma.homework.count({
          where: { ...where, statuses: { none: { ...personalWhere, completed: true } } },
        })
      : prisma.homework.count({ where }),
    prisma.notification.findMany({
      where,
      include: { creator: creatorSelect, reads: { where: personalWhere } },
      orderBy: { createdAt: 'desc' },
      take: 5,
    }),
    prisma.homework.findMany({
      where,
      include: {
        course: courseSelect,
        creator: creatorSelect,
        statuses: device ? { where: personalWhere } : true,
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
    }),
  ]);

  return {
    classCount,
    studentCount,
    courseCount,
    scheduleCount,
    homeworkCount,
    notificationCount,
    gradeCount,
    unreadNotificationCount,
    pendingHomeworkCount,
    recentNotifications: recentNotifications.map((item): NotificationDto =>
      toNotificationDto(item, { studentIds: personalIds }),
    ),
    recentHomeworks: recentHomeworks.map((item): HomeworkDto =>
      toHomeworkDto(item, { studentIds: device ? personalIds : [], withStatus: !device }),
    ),
  };
}
