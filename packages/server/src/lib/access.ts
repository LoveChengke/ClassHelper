import { prisma } from './db.js';
import { ApiError } from './http.js';
import type { TokenPayload } from './jwt.js';

/**
 * 权限（RBAC）规则：
 * - ADMIN   ：可访问全部班级
 * - TEACHER ：仅可访问自己创建（teacherId）或被分配（ClassTeacher）的班级
 * - STUDENT ：仅可查看自己所在班级的数据，且无任何写权限
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
