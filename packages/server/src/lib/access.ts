import {
  canManageGrades,
  canManageSchedule,
  canPublishContent,
  canManageClasses,
  canAssignTeachers,
  canManageRoster,
  resolveClassRole,
  type ClassRole,
} from '@classhelper/shared';
import { prisma } from './db.js';
import { ApiError } from './http.js';
import type { TokenPayload } from './jwt.js';

/**
 * 权限（RBAC）规则：
 * - ADMIN   ：全部班级；班级增删改、人员分配、成绩、课表
 * - HEAD    ：班主任（Class.teacherId）—— 本班课表 + 作业/通知/叫人
 * - SUBJECT ：科任老师（ClassTeacher）—— 仅作业/通知/叫人
 * - STUDENT ：只读；班级账号（classSession）以班级为单位读写自己的数据
 *
 * 判定逻辑与前端共用 `@classhelper/shared/permissions`，避免前后端口径漂移。
 */

export function isAdmin(user: TokenPayload): boolean {
  return user.role === 'ADMIN';
}

export function isTeacher(user: TokenPayload): boolean {
  return user.role === 'TEACHER';
}

export function isStudent(user: TokenPayload): boolean {
  return user.role === 'STUDENT';
}

export function isStaff(user: TokenPayload): boolean {
  return user.role === 'ADMIN' || user.role === 'TEACHER';
}

/** 当前用户可访问的全部班级 id */
export async function getAccessibleClassIds(user: TokenPayload): Promise<string[]> {
  if (isAdmin(user)) {
    const classes = await prisma.class.findMany({ select: { id: true } });
    return classes.map((item) => item.id);
  }

  if (isTeacher(user)) {
    const classes = await prisma.class.findMany({
      where: { OR: [{ teacherId: user.sub }, { teachers: { some: { teacherId: user.sub } } }] },
      select: { id: true },
    });
    return classes.map((item) => item.id);
  }

  const ids = new Set<string>();
  if (user.classId) ids.add(user.classId);
  const enrollments = await prisma.enrollment.findMany({
    where: { userId: user.sub },
    select: { classId: true },
  });
  for (const item of enrollments) ids.add(item.classId);
  return [...ids];
}

export async function canAccessClass(user: TokenPayload, classId: string): Promise<boolean> {
  if (isAdmin(user)) return true;
  if (isTeacher(user)) {
    const count = await prisma.class.count({
      where: {
        id: classId,
        OR: [{ teacherId: user.sub }, { teachers: { some: { teacherId: user.sub } } }],
      },
    });
    return count > 0;
  }
  if (user.classId === classId) return true;
  const enrollment = await prisma.enrollment.findFirst({
    where: { userId: user.sub, classId },
    select: { id: true },
  });
  return enrollment !== null;
}

/** 读权限断言 */
export async function assertClassAccess(user: TokenPayload, classId: string): Promise<void> {
  const exists = await prisma.class.findUnique({ where: { id: classId }, select: { id: true } });
  if (!exists) throw ApiError.notFound('班级不存在');
  if (!(await canAccessClass(user, classId))) throw ApiError.forbidden('无权访问该班级的数据');
}

/** 写权限断言：学生一律拒绝 */
export async function assertClassWritable(user: TokenPayload, classId: string): Promise<void> {
  if (!isStaff(user)) throw ApiError.forbidden('学生账号没有管理权限');
  await assertClassAccess(user, classId);
}

/* ---------------------------------------------------------------- 班级内角色 */

/** 解析当前用户在某班级里的角色（ADMIN / HEAD / SUBJECT / STUDENT / NONE） */
export async function resolveUserClassRole(user: TokenPayload, classId: string): Promise<ClassRole> {
  if (user.role === 'ADMIN') return 'ADMIN';
  if (user.role === 'STUDENT') return canAccessClass(user, classId).then((ok) => (ok ? 'STUDENT' : 'NONE'));

  const record = await prisma.class.findUnique({
    where: { id: classId },
    select: {
      teacherId: true,
      teachers: { where: { teacherId: user.sub }, select: { id: true } },
    },
  });
  if (!record) return 'NONE';
  return resolveClassRole({
    role: user.role,
    isHeadTeacher: record.teacherId === user.sub,
    isSubjectTeacher: record.teachers.length > 0,
  });
}

/** 班级本身（增删改）与人员分配：仅管理员 */
export function assertCanManageClasses(user: TokenPayload): void {
  if (!canManageClasses(user.role)) {
    throw ApiError.forbidden('只有管理员可以创建、修改或删除班级');
  }
}

/** 班主任 / 科任老师分配：仅管理员 */
export function assertCanAssignTeachers(user: TokenPayload): void {
  if (!canAssignTeachers(user.role)) {
    throw ApiError.forbidden('只有管理员可以分配班主任与科任老师');
  }
}

/** 学生名单管理：仅管理员 */
export function assertCanManageRoster(user: TokenPayload): void {
  if (!canManageRoster(user.role)) {
    throw ApiError.forbidden('只有管理员可以管理学生名单与账号');
  }
}

/** 课表管理（含时间配置导入）：管理员或本班班主任 */
export async function assertCanManageSchedule(user: TokenPayload, classId: string): Promise<void> {
  const classRole = await resolveUserClassRole(user, classId);
  if (!canManageSchedule(classRole)) {
    throw ApiError.forbidden(
      classRole === 'SUBJECT' ? '科任老师不能管理课表，请联系班主任或管理员' : '无权管理该班级的课表',
    );
  }
}

/** 作业 / 通知 / 叫人：管理员、班主任、科任老师 */
export async function assertCanPublishContent(user: TokenPayload, classId: string): Promise<void> {
  await assertClassAccess(user, classId);
  const classRole = await resolveUserClassRole(user, classId);
  if (!canPublishContent(classRole)) {
    throw ApiError.forbidden('当前账号没有发布作业/通知或叫人的权限');
  }
}

/** 成绩录入 / 修改 / 导入：仅管理员 */
export function assertCanManageGrades(user: TokenPayload): void {
  if (!canManageGrades(user.role)) {
    throw ApiError.forbidden('只有管理员可以录入、修改或导入成绩');
  }
}

/** 学生的主班级，未分配班级时抛 403 */
export function requireStudentClassId(user: TokenPayload): string {
  if (!user.classId) throw ApiError.forbidden('当前账号尚未被分配到任何班级，请联系班主任');
  return user.classId;
}

/**
 * 查询范围解析：
 * - 传入 classId：校验后只查该班级
 * - 未传：教师/学生只能查自己可访问的班级；管理员不加限制
 */
export type ClassScope = { mode: 'all' } | { mode: 'in'; classIds: string[] };

export async function resolveClassScope(user: TokenPayload, requestedClassId?: string): Promise<ClassScope> {
  if (requestedClassId) {
    await assertClassAccess(user, requestedClassId);
    return { mode: 'in', classIds: [requestedClassId] };
  }
  if (isAdmin(user)) return { mode: 'all' };

  const classIds = await getAccessibleClassIds(user);
  // 没有任何班级时不抛错，返回空集合让列表接口给出空数组，避免新教师首次登录报错
  return { mode: 'in', classIds };
}

/** 把 ClassScope 转换成 Prisma 的 where 片段（子表：classId 字段） */
export function classScopeWhere(scope: ClassScope): { classId?: { in: string[] } } {
  return scope.mode === 'all' ? {} : { classId: { in: scope.classIds } };
}

/** Class 表自身的范围过滤：注意这里过滤的是主键 id，而不是子表的 classId */
export function classScopeIdFilter(scope: ClassScope): { id?: { in: string[] } } {
  return scope.mode === 'all' ? {} : { id: { in: scope.classIds } };
}

/** 单班级场景：学生强制取自己班级，其他角色沿用请求参数 */
export function resolveEffectiveClassId(user: TokenPayload, requestedClassId?: string): string | undefined {
  if (isStudent(user)) return requireStudentClassId(user);
  return requestedClassId;
}
