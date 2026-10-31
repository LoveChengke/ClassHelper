import type { Prisma } from '../../generated/prisma/client.js';
import { PERMISSION_LABELS, type PermissionKey } from '@classhelper/shared';
import { prisma } from '../db.js';
import { ApiError } from '../http.js';
import type { TokenPayload } from '../jwt.js';
import { loadAuthPrincipal } from './principal.js';
import { assertClassInScope, hasOrganizationalGrant } from './scope.js';
import { classDeviceClassId, isHead, isTeaching } from './relations.js';

export function assertAdmin(user: TokenPayload): void {
  if (user.role !== 'ADMIN' || user.classSession) throw ApiError.forbidden('此操作仅限管理员');
}
export async function assertPermission(user: TokenPayload, key: PermissionKey): Promise<void> {
  if (!(await loadAuthPrincipal(user)).permissions.has(key))
    throw ApiError.forbidden(`缺少「${PERMISSION_LABELS[key]}」权限`);
}
export async function assertAnyPermission(user: TokenPayload, keys: PermissionKey[]): Promise<void> {
  const auth = await loadAuthPrincipal(user);
  if (!keys.some((key) => auth.permissions.has(key))) throw ApiError.forbidden('缺少此操作所需权限');
}
export function assertClassDevice(user: TokenPayload, classId: string): void {
  if (classDeviceClassId(user) !== classId) throw ApiError.forbidden('仅限绑定本班的班级端会话');
}
export async function assertPermissionOrClassDevice(user: TokenPayload, key: PermissionKey): Promise<void> {
  if (user.role !== 'CLASS_DEVICE') await assertPermission(user, key);
}
export async function assertClassRead(
  user: TokenPayload,
  key: PermissionKey,
  classId: string,
  options: { allowClassDevice?: boolean; db?: Prisma.TransactionClient } = {},
): Promise<void> {
  if (user.role === 'CLASS_DEVICE' && options.allowClassDevice) {
    assertClassDevice(user, classId);
    return;
  }
  await assertPermission(user, key);
  await assertClassInScope(user, key, classId, options.db);
}
export async function assertHeadOnly(
  user: TokenPayload,
  key: PermissionKey,
  classId: string,
  db: Prisma.TransactionClient = prisma,
): Promise<void> {
  await assertClassRead(user, key, classId, { db });
  if (user.role !== 'ADMIN' && !(await isHead(user, classId, db)))
    throw ApiError.forbidden('此操作仅限本班班主任或管理员');
}
export async function assertManage(
  user: TokenPayload,
  key: PermissionKey,
  classId: string,
  db: Prisma.TransactionClient = prisma,
): Promise<void> {
  await assertClassRead(user, key, classId, { db });
  if (
    user.role !== 'ADMIN' &&
    !(await isHead(user, classId, db)) &&
    !(await hasOrganizationalGrant(user, key, classId, db))
  )
    throw ApiError.forbidden('此操作需要班主任关系或该功能的年级、部、全校范围');
}
export async function assertContentWrite(
  user: TokenPayload,
  key: PermissionKey,
  classId: string,
  courseId: string | null | undefined,
  action: string,
  options: { allowClassDevice?: boolean; db?: Prisma.TransactionClient } = {},
): Promise<void> {
  await assertClassRead(user, key, classId, options);
  if (courseId) {
    const course = await (options.db ?? prisma).course.findUnique({ where: { id: courseId } });
    if (!course || course.classId !== classId) throw ApiError.badRequest('课程不属于目标班级');
    if (
      user.role === 'ADMIN' ||
      (user.role === 'CLASS_DEVICE' && options.allowClassDevice) ||
      course.teacherId === user.sub
    )
      return;
  } else if (
    user.role === 'ADMIN' ||
    (user.role === 'CLASS_DEVICE' && options.allowClassDevice) ||
    (await isHead(user, classId, options.db))
  )
    return;
  throw ApiError.forbidden(`只能${action}本人任教科目或班主任班未指定科目的内容`);
}
export async function assertPublish(
  user: TokenPayload,
  key: PermissionKey,
  classId: string,
  options: { allowClassDevice?: boolean; db?: Prisma.TransactionClient } = {},
): Promise<void> {
  await assertClassRead(user, key, classId, options);
  if (
    user.role === 'ADMIN' ||
    (user.role === 'CLASS_DEVICE' && options.allowClassDevice) ||
    (await isTeaching(user, classId, options.db))
  )
    return;
  throw ApiError.forbidden('只有班主任或本班任课老师可以发布');
}
