import type { Prisma } from '../generated/prisma/client.js';
import type { PermissionKey, ClassRole } from '@classhelper/shared';
import { resolveClassRole } from '@classhelper/shared';
import { prisma } from './db.js';
import { ApiError } from './http.js';
import type { TokenPayload } from './jwt.js';
import {
  assertAdmin,
  assertPermission,
  assertClassRead,
  assertManage,
  classIdsFor,
  classWhere,
  classDeviceClassId,
  isHead,
  hasOrganizationalGrant,
} from './authz/index.js';
export { classDeviceClassId } from './authz/relations.js';
export const isAdmin = (user: TokenPayload) => user.role === 'ADMIN';
export const isTeacher = (user: TokenPayload) => user.role === 'TEACHER';
export const isStaff = (user: TokenPayload) => user.role === 'ADMIN' || user.role === 'TEACHER';
export const isClassDevice = (user: TokenPayload) => user.role === 'CLASS_DEVICE';
export async function resolveContentCreator(user: TokenPayload, classId: string) {
  if (!isClassDevice(user)) return user.sub;
  const record = await prisma.class.findUnique({ where: { id: classId }, select: { teacherId: true } });
  if (!record?.teacherId) throw ApiError.conflict('请先为班级配置班主任');
  return record.teacherId;
}
export function requireClassDeviceClassId(user: TokenPayload): string {
  const id = classDeviceClassId(user);
  if (!id) throw ApiError.forbidden('当前会话未绑定班级');
  return id;
}
export const getAccessibleClassIds = classIdsFor;
export async function canAccessClass(
  user: TokenPayload,
  classId: string,
  key: PermissionKey,
): Promise<boolean> {
  if (isClassDevice(user)) return classDeviceClassId(user) === classId;
  return !!(await prisma.class.count({ where: { AND: [{ id: classId }, await classWhere(user, key)] } }));
}
/** 兼容窄封装，键必须由调用点显式提供。 */
export async function assertClassAccess(
  user: TokenPayload,
  classId: string,
  key: PermissionKey,
): Promise<void> {
  await assertClassRead(user, key, classId, { allowClassDevice: true });
}
export async function resolveUserClassRole(user: TokenPayload, classId: string): Promise<ClassRole> {
  if (isAdmin(user)) return 'ADMIN';
  if (isClassDevice(user)) return classDeviceClassId(user) === classId ? 'CLASS_DEVICE' : 'NONE';
  return resolveClassRole({
    role: user.role,
    isHeadTeacher: await isHead(user, classId),
    teachesSubjects: !!(await prisma.course.count({ where: { classId, teacherId: user.sub } })),
  });
}
export async function assertCanManageClasses(user: TokenPayload, classId?: string) {
  assertAdmin(user);
  if (classId && (await prisma.class.findUnique({ where: { id: classId } }))?.archivedYearId)
    throw ApiError.conflict('该班级已归档');
}
export const assertCanAssignTeachers = assertCanManageClasses;
export async function assertGlobalPermission(user: TokenPayload, key: PermissionKey) {
  assertAdmin(user);
  await assertPermission(user, key);
}
export async function assertClassInScope(user: TokenPayload, classId: string, key: PermissionKey) {
  await assertClassRead(user, key, classId);
}
export async function assertClassesInScope(user: TokenPayload, ids: string[], key: PermissionKey) {
  for (const id of new Set(ids)) await assertClassInScope(user, id, key);
}
export async function assertCanManageRoster(
  user: TokenPayload,
  classId?: string,
  db: Prisma.TransactionClient = prisma,
) {
  if (!classId) {
    await assertPermission(user, 'roster:manage');
    if (!(await hasOrganizationalGrant(user, 'roster:manage')))
      throw ApiError.forbidden('未分班学生需要全校名单范围');
    return;
  }
  await assertManage(user, 'roster:manage', classId, db);
}
export async function assertCanManageSchedule(
  user: TokenPayload,
  classId: string,
  db: Prisma.TransactionClient = prisma,
) {
  await assertManage(user, 'schedule:write', classId, db);
}
export async function assertCanImportSchedule(user: TokenPayload, classId: string) {
  await assertManage(user, 'import:schedule', classId);
  await assertCanManageSchedule(user, classId);
}
export type ClassScope = { mode: 'all' } | { mode: 'in'; classIds: string[] };
export async function resolveClassScope(
  user: TokenPayload,
  requestedClassId: string | undefined,
  key: PermissionKey,
): Promise<ClassScope> {
  if (requestedClassId) {
    await assertClassAccess(user, requestedClassId, key);
    return { mode: 'in', classIds: [requestedClassId] };
  }
  if (isClassDevice(user)) return { mode: 'in', classIds: [requireClassDeviceClassId(user)] };
  await assertPermission(user, key);
  if (Object.keys(await classWhere(user, key)).length === 0) return { mode: 'all' };
  // 其余范围显式枚举班级，避免空集合被下游当成全量。
  return { mode: 'in', classIds: await classIdsFor(user, key) };
}
export function classScopeWhere(scope: ClassScope): { classId?: { in: string[] } } {
  return scope.mode === 'all' ? {} : { classId: { in: scope.classIds } };
}
export function classScopeIdFilter(scope: ClassScope): { id?: { in: string[] } } {
  return scope.mode === 'all' ? {} : { id: { in: scope.classIds } };
}
export function resolveEffectiveClassId(user: TokenPayload, requestedClassId?: string): string | undefined {
  if (isClassDevice(user)) {
    const id = requireClassDeviceClassId(user);
    if (requestedClassId && requestedClassId !== id) throw ApiError.forbidden('不能访问其他班级');
    return id;
  }
  return requestedClassId;
}
