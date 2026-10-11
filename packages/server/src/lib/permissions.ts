import {
  PERMISSION_KEYS,
  PERMISSION_LABELS,
  ROLE_DEFAULT_PERMISSIONS,
  defaultPermissionsForRole,
  type PermissionKey,
} from '@classhelper/shared';
import { prisma } from './db.js';
import type { TokenPayload } from './jwt.js';

/**
 * 生效权限集合的**唯一加载入口**（权限组功能的全部运行时逻辑都收在这里）。
 *
 * 语义（与 shared 的 `PERMISSION_DEFAULT_ROLES` 一一对应）：
 * - `ADMIN`：全集。另外**永远**保留 {@link ADMIN_UNREMOVABLE_PERMISSIONS}，避免管理员
 *   把自己（或最后一个管理员）锁在权限页之外；
 * - `CLASS_DEVICE`（ClassHelper 班级端）：**空集，且不受权限组影响** —— 班级端的会话主体是
 *   班级而非账号，它的能力由班级维度断言（`canManageSubjectContent(..., { allowClassDevice })`
 *   等）决定，给某个班级端"分配权限组"没有意义；
 * - 其他账号：**有分组**时取这些组的键并集（因此可以比默认更少 ⇒ 也能用来收回权限）；
 *   **没有任何分组**时回落角色默认模板（逐条镜像权限组上线前各路由的 `requireRole`）。
 *
 * 每次请求实时查询（不缓存）：权限改动**立即生效**，代价是每请求多一条 `findMany`
 * （账号规模很小，这个代价换"改了立刻生效"是值的）。
 */
export async function loadEffectivePermissions(user: TokenPayload): Promise<Set<PermissionKey>> {
  const permissions = new Set<PermissionKey>();

  if (user.classSession || user.role === 'CLASS_DEVICE') return permissions;

  if (user.role === 'ADMIN') {
    for (const key of PERMISSION_KEYS) permissions.add(key);
    return permissions;
  }

  const assignments = await prisma.userPermissionGroup.findMany({
    where: { userId: user.sub },
    select: { group: { select: { items: { select: { key: true } } } } },
  });

  if (assignments.length === 0) {
    for (const key of defaultPermissionsForRole(user.role)) permissions.add(key);
    return permissions;
  }

  const known = new Set<string>(PERMISSION_KEYS);
  for (const assignment of assignments) {
    for (const item of assignment.group.items) {
      // 库里可能留着已下线的键（旧版本写入的），这里静默忽略，避免整账号权限异常
      if (known.has(item.key)) permissions.add(item.key as PermissionKey);
    }
  }
  return permissions;
}

/** 管理员不可被剥夺的权限键（防锁死） */
export const ADMIN_UNREMOVABLE_PERMISSIONS: readonly PermissionKey[] = ['permission:manage', 'system:manage'];

/** 角色默认模板（供权限页展示"没分组时会是什么"） */
export function roleDefaultPermissions(role: TokenPayload['role']): readonly PermissionKey[] {
  return ROLE_DEFAULT_PERMISSIONS[role];
}

/** 把权限键翻译成中文提示（403 文案与权限页共用） */
export function permissionLabel(key: PermissionKey): string {
  return PERMISSION_LABELS[key];
}
