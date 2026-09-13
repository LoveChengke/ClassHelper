import type { DashboardSummary, HomeworkDto, NotificationDto } from '@classhelper/shared';
import {
  classScopeIdFilter,
  classScopeWhere,
  isStudent,
  resolveClassScope,
  requireStudentClassId,
} from '../../lib/access.js';
import { prisma } from '../../lib/db.js';
import { MAX_TERM_WEEK } from '../../lib/term.js';
import type { TokenPayload } from '../../lib/jwt.js';
import { toHomeworkDto, toNotificationDto } from '../../lib/mappers.js';
import { personalIdWhere, resolvePersonalIds } from '../../lib/session.js';

const courseSelect = { select: { id: true, name: true } } as const;
const creatorSelect = { select: { id: true, name: true, username: true } } as const;

/**
 * 仪表盘汇总。
 * 教师/管理员看到的是"自己管理的班级"的汇总；学生看到自己班级的汇总。
 */
/**
 * 本班教学周数（班主任可调，默认 20）。
 * - 学生 / 班级会话：固定为自己所在班级；
 * - 教师 / 管理员：优先用显式 classId（越权查不到时回退默认值）；
 * - 都不传：全局默认（MAX_TERM_WEEK 兜底）。
 */
export async function resolveTermWeeks(user: TokenPayload, classId?: string): Promise<number> {
  const targetClassId = classId ?? (isStudent(user) ? requireStudentClassId(user) : undefined);
  if (!targetClassId) return MAX_TERM_WEEK;
  const record = await prisma.class.findUnique({
    where: { id: targetClassId },
    select: { termWeeks: true },
  });
  return record?.termWeeks && record.termWeeks > 0 ? record.termWeeks : MAX_TERM_WEEK;
}
export async function getDashboardSummary(user: TokenPayload): Promise<DashboardSummary> {
  const student = isStudent(user);
  // 学生强制限定在自己班级，避免越权统计
  const scope = await resolveClassScope(user, student ? requireStudentClassId(user) : undefined);
  // 子表按 classId 过滤；Class 表本身按主键 id 过滤
  const where = classScopeWhere(scope);
  const classWhere = classScopeIdFilter(scope);
  // 班级账号（班级设备）以全班学生为范围；普通学生即自己
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
    prisma.class.count({ where: classWhere }),
    prisma.user.count({ where: { ...where, role: 'STUDENT' } }),
    prisma.course.count({ where }),
    prisma.schedule.count({ where }),
    prisma.homework.count({ where }),
    prisma.notification.count({ where }),
    prisma.grade.count({ where }),
    prisma.notification.count({ where: { ...where, reads: { none: personalWhere } } }),
    student
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
        statuses: student ? { where: personalWhere } : true,
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
      toNotificationDto(item, { userIds: personalIds }),
    ),
    recentHomeworks: recentHomeworks.map((item): HomeworkDto =>
      toHomeworkDto(item, { userIds: student ? personalIds : [], withStatus: !student }),
    ),
  };
}
