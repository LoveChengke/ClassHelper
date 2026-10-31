import type { PermissionKey } from '@classhelper/shared';
import { classIdsFor, loadAuthPrincipal } from '../../lib/authz/index.js';
import { activeStudentWhere } from '../../lib/students.js';
import type { DashboardSummary, HomeworkDto, NotificationDto } from '@classhelper/shared';
import {
  assertClassAccess,
  isClassDevice,
  resolveClassScope,
  requireClassDeviceClassId,
} from '../../lib/access.js';
import { prisma } from '../../lib/db.js';
import { getMaxTermWeeks } from '../../lib/term.js';
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
 * - 都不传：全局默认（getMaxTermWeeks 兜底）。
 */
export async function resolveTermWeeks(user: TokenPayload, classId?: string): Promise<number> {
  if (classId) await assertClassAccess(user, classId, 'term:read');
  const targetClassId = classId ?? (isClassDevice(user) ? requireClassDeviceClassId(user) : undefined);
  if (!targetClassId) return getMaxTermWeeks();
  const record = await prisma.class.findUnique({
    where: { id: targetClassId },
    select: { termWeeks: true },
  });
  return record?.termWeeks && record.termWeeks > 0 ? record.termWeeks : await getMaxTermWeeks();
}

/**
 * 仪表盘汇总。
 * 教师/管理员看到的是"自己管理的班级"的汇总；ClassHelper 班级端看到自己绑定班级的汇总。
 */
export async function getDashboardSummary(user: TokenPayload): Promise<DashboardSummary> {
  const device = isClassDevice(user);
  // 班级端强制限定在自己班级，避免越权统计
  const scope = await resolveClassScope(
    user,
    device ? requireClassDeviceClassId(user) : undefined,
    'dashboard:read',
  );
  // 子表按 classId 过滤；Class 表本身按主键 id 过滤
  const allowed = scope.mode === 'in' ? scope.classIds : await classIdsFor(user, 'dashboard:read');
  const auth = await loadAuthPrincipal(user);
  async function segment(key: PermissionKey) {
    const ids = device ? allowed : (await classIdsFor(user, key)).filter((id) => allowed.includes(id));
    return { classId: { in: ids } };
  }
  const [classes, students, courses, schedules, homeworks, notifications, grades] = await Promise.all(
    [
      'class:read',
      'roster:read',
      'schedule:read',
      'schedule:read',
      'homework:read',
      'notification:read',
      'grade:read',
    ].map((key) => segment(key as PermissionKey)),
  );
  const sections = {
    classes: device || auth.permissions.has('class:read'),
    students: device || auth.permissions.has('roster:read'),
    courses: device || auth.permissions.has('schedule:read'),
    schedules: device || auth.permissions.has('schedule:read'),
    homeworks: device || auth.permissions.has('homework:read'),
    notifications: device || auth.permissions.has('notification:read'),
    grades: device || auth.permissions.has('grade:read'),
  };
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
    prisma.class.count({ where: { id: classes.classId } }),
    prisma.student.count({ where: { ...students, ...activeStudentWhere(), archivedYearId: null } }),
    prisma.course.count({ where: courses }),
    prisma.classPlan.count({ where: schedules }),
    prisma.homework.count({ where: homeworks }),
    prisma.notification.count({ where: notifications }),
    prisma.grade.count({ where: { ...grades, student: activeStudentWhere() } }),
    prisma.notification.count({ where: { ...notifications, reads: { none: personalWhere } } }),
    device
      ? prisma.homework.count({
          where: { ...homeworks, statuses: { none: { ...personalWhere, completed: true } } },
        })
      : prisma.homework.count({ where: homeworks }),
    prisma.notification.findMany({
      where: notifications,
      include: { creator: creatorSelect, reads: { where: personalWhere } },
      orderBy: { createdAt: 'desc' },
      take: 5,
    }),
    prisma.homework.findMany({
      where: homeworks,
      include: {
        course: courseSelect,
        creator: creatorSelect,
        statuses: { where: device ? personalWhere : { student: activeStudentWhere() } },
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
    }),
  ]);

  return {
    sections,
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
