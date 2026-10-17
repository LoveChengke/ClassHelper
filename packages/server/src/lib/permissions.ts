import {
  BUILTIN_TEACHER_GROUPS,
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
 * - `ADMIN`：按权限组计算，另外**永远**保留 {@link ADMIN_UNREMOVABLE_PERMISSIONS}，避免管理员
 *   把自己（或最后一个管理员）锁在权限页之外；
 * - `CLASS_DEVICE`（ClassHelper 班级端）：**空集，且不受权限组影响** —— 班级端的会话主体是
 *   班级而非账号，它的能力由班级维度断言（`canManageSubjectContent(..., { allowClassDevice })`
 *   等）决定，给某个班级端"分配权限组"没有意义；
 * - 其他账号：**有分组**时取这些组的键并集（因此可以比默认更少 ⇒ 也能用来收回权限）；
 *   **没有任何分组**时使用数据库中可编辑的角色默认组（逐条镜像权限组上线前各路由的 `requireRole`）。
 *
 * 每次请求实时查询（不缓存）：权限改动**立即生效**，代价是每请求多一条 `findMany`
 * （账号规模很小，这个代价换"改了立刻生效"是值的）。
 */
export async function loadEffectivePermissions(user: TokenPayload): Promise<Set<PermissionKey>> {
  const permissions = new Set<PermissionKey>();

  if (user.classSession || user.role === 'CLASS_DEVICE') return permissions;

  await ensureDefaultGroups();

  const assignments = await prisma.userPermissionGroup.findMany({
    where: { userId: user.sub },
    select: { group: { select: { items: { select: { key: true } } } } },
  });

  if (assignments.length === 0) {
    const group = await prisma.permissionGroup.findUnique({
      where: { defaultRole: user.role },
      include: { items: true },
    });
    for (const key of group ? group.items.map((item) => item.key) : defaultPermissionsForRole(user.role)) {
      if ((PERMISSION_KEYS as readonly string[]).includes(key)) permissions.add(key as PermissionKey);
    }
    if (user.role === 'ADMIN') for (const key of ADMIN_UNREMOVABLE_PERMISSIONS) permissions.add(key);
    return permissions;
  }

  const known = new Set<string>(PERMISSION_KEYS);
  for (const assignment of assignments) {
    for (const item of assignment.group.items) {
      // 库里可能留着已下线的键（旧版本写入的），这里静默忽略，避免整账号权限异常
      if (known.has(item.key)) permissions.add(item.key as PermissionKey);
    }
  }
  if (user.role === 'ADMIN') for (const key of ADMIN_UNREMOVABLE_PERMISSIONS) permissions.add(key);
  return permissions;
}

/** 首次升级创建默认组；后续启动保留管理员的编辑结果（包括空权限组）。 */
let defaultGroupsReady: Promise<void> | null = null;
export function ensureDefaultGroups(): Promise<void> {
  if (!defaultGroupsReady)
    defaultGroupsReady = createDefaultGroups().finally(() => {
      defaultGroupsReady = null;
    });
  return defaultGroupsReady;
}
async function createDefaultGroups(): Promise<void> {
  for (const group of BUILTIN_TEACHER_GROUPS) {
    await prisma.permissionGroup.upsert({
      where: { id: group.id },
      update: {},
      create: {
        id: group.id,
        name: group.name,
        builtin: true,
        scope: group.scope,
        scopeValue: group.scopeValue,
        items: { create: group.keys.map((key) => ({ key })) },
      },
    });
  }
  for (const role of ['ADMIN', 'TEACHER'] as const) {
    if (await prisma.permissionGroup.findUnique({ where: { defaultRole: role }, select: { id: true } }))
      continue;
    const baseName = `${role === 'ADMIN' ? '管理员' : '教师'}默认权限`;
    let name = baseName;
    let suffix = 1;
    // 旧库可能已有同名自定义组，保留它并为角色默认组选一个不冲突的名称。
    while (await prisma.permissionGroup.findUnique({ where: { name }, select: { id: true } })) {
      name = `${baseName}（系统 ${suffix++}）`;
    }
    await prisma.permissionGroup.upsert({
      where: { defaultRole: role },
      update: {},
      create: {
        id: `default-permission-${role.toLowerCase()}`,
        defaultRole: role,
        name,
        builtin: true,
        scope: role === 'ADMIN' ? 'ALL' : 'SELF_CLASS',
        description: '未分配其他权限组时自动生效；可调整权限。管理员始终保留权限与系统管理入口。',
        items: { create: ROLE_DEFAULT_PERMISSIONS[role].map((key) => ({ key })) },
      },
    });
  }
}

/** 管理员不可被剥夺的权限键（防锁死） */
export const ADMIN_UNREMOVABLE_PERMISSIONS: readonly PermissionKey[] = ['permission:manage', 'system:manage'];

/** 把权限键翻译成中文提示（403 文案与权限页共用） */
export function permissionLabel(key: PermissionKey): string {
  return PERMISSION_LABELS[key];
}
