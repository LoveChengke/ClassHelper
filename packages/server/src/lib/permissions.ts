import {
  BUILTIN_TEACHER_GROUPS,
  PERMISSION_LABELS,
  ROLE_DEFAULT_PERMISSIONS,
  type PermissionKey,
} from '@classhelper/shared';
import { prisma } from './db.js';
import type { TokenPayload } from './jwt.js';

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
  for (const role of ['TEACHER'] as const) {
    if (await prisma.permissionGroup.findUnique({ where: { defaultRole: role }, select: { id: true } }))
      continue;
    const baseName = '教师默认权限';
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
        scope: 'TEACHING',
        description: '未显式分配时使用此模板与固定任教班级范围。',
        items: { create: ROLE_DEFAULT_PERMISSIONS[role].map((key) => ({ key })) },
      },
    });
  }
}

/** 把权限键翻译成中文提示（403 文案与权限页共用） */
export function permissionLabel(key: PermissionKey): string {
  return PERMISSION_LABELS[key];
}

export { loadAuthPrincipal } from './authz/principal.js';
export { assertPermission, assertAnyPermission, assertPermissionOrClassDevice } from './authz/assert.js';
import { loadAuthPrincipal } from './authz/principal.js';
export async function hasEffectivePermission(user: TokenPayload, key: PermissionKey) {
  return (await loadAuthPrincipal(user)).permissions.has(key);
}
