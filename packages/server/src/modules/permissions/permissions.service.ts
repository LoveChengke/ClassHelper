import {
  PERMISSION_CATEGORIES,
  PERMISSION_DEFAULT_ROLES,
  PERMISSION_KEYS,
  PERMISSION_LABELS,
  ROLE_DEFAULT_PERMISSIONS,
  type AssignUserGroupsRequest,
  type CreatePermissionGroupRequest,
  type MyPermissionsDto,
  type PermissionCatalogDto,
  type PermissionGroupDto,
  type PermissionKey,
  type PermissionMemberDto,
  type UpdatePermissionGroupRequest,
  type UserRole,
} from '@classhelper/shared';
import { prisma } from '../../lib/db.js';
import { ApiError } from '../../lib/http.js';
import type { TokenPayload } from '../../lib/jwt.js';
import { logger } from '../../lib/logger.js';
import { ADMIN_UNREMOVABLE_PERMISSIONS, loadEffectivePermissions } from '../../lib/permissions.js';

/**
 * 权限组服务：组 / 键 / 成员三件事的全部读写都收在这里。
 *
 * 生效权限的计算**不在本文件**，而在 `lib/permissions.ts` 的 `loadEffectivePermissions`
 * （鉴权中间件每请求调用一次）；本文件只负责"编辑这些组"，两者共用同一份 shared 常量。
 */

const GROUP_SELECT = {
  id: true,
  name: true,
  description: true,
  builtin: true,
  createdAt: true,
  updatedAt: true,
  items: { select: { key: true } },
  _count: { select: { users: true } },
} as const;

type GroupRow = {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
  createdAt: Date;
  updatedAt: Date;
  items: { key: string }[];
  _count: { users: number };
};

const MEMBER_SELECT = {
  id: true,
  username: true,
  name: true,
  role: true,
  permissionGroups: { select: { groupId: true } },
} as const;

type MemberRow = {
  id: string;
  username: string;
  name: string;
  role: string;
  permissionGroups: { groupId: string }[];
};

/** 目录顺序（key → 序号）：组的键与"我的权限"都按它排序，前端渲染才稳定 */
const KEY_ORDER = new Map<string, number>(PERMISSION_KEYS.map((key, index) => [key, index]));

function knownKey(key: string): key is PermissionKey {
  return KEY_ORDER.has(key);
}

function byCatalogOrder(a: string, b: string): number {
  return (KEY_ORDER.get(a) ?? Number.MAX_SAFE_INTEGER) - (KEY_ORDER.get(b) ?? Number.MAX_SAFE_INTEGER);
}

/** 去重 + 丢掉已下线的键 + 按目录顺序排序 */
function normalizeKeys(keys: readonly string[] | undefined): PermissionKey[] {
  const unique = new Set<PermissionKey>();
  for (const key of keys ?? []) if (knownKey(key)) unique.add(key);
  return [...unique].sort(byCatalogOrder);
}

function toGroupDto(row: GroupRow): PermissionGroupDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    builtin: row.builtin,
    keys: row.items.map((item) => item.key).filter(knownKey).sort(byCatalogOrder),
    memberCount: row._count.users,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** GET /api/permissions/catalog - 权限键目录（权限页整棵勾选树都按它渲染） */
export function permissionCatalog(): PermissionCatalogDto {
  const roles = Object.keys(ROLE_DEFAULT_PERMISSIONS) as UserRole[];
  return {
    keys: [...PERMISSION_KEYS],
    labels: { ...PERMISSION_LABELS },
    categories: PERMISSION_CATEGORIES.map((category) => ({
      title: category.title,
      keys: [...category.keys],
    })),
    defaultRoles: Object.fromEntries(
      PERMISSION_KEYS.map((key) => [key, [...PERMISSION_DEFAULT_ROLES[key]]]),
    ) as Record<PermissionKey, UserRole[]>,
    roleDefaults: Object.fromEntries(
      roles.map((role) => [role, [...ROLE_DEFAULT_PERMISSIONS[role]]]),
    ) as Record<UserRole, PermissionKey[]>,
    unremovable: [...ADMIN_UNREMOVABLE_PERMISSIONS],
  };
}

/** GET /api/permissions/groups - 权限组列表（内置组排在最前，其余按创建时间） */
export async function listGroups(): Promise<PermissionGroupDto[]> {
  const rows = await prisma.permissionGroup.findMany({
    select: GROUP_SELECT,
    orderBy: [{ builtin: 'desc' }, { createdAt: 'asc' }],
  });
  return (rows as GroupRow[]).map(toGroupDto);
}

export async function createGroup(input: CreatePermissionGroupRequest): Promise<PermissionGroupDto> {
  const name = input.name.trim();
  const sameName = await prisma.permissionGroup.findUnique({ where: { name }, select: { id: true } });
  if (sameName) throw ApiError.conflict(`已存在名为「${name}」的权限组`);

  const keys = normalizeKeys(input.keys);
  const created = await prisma.permissionGroup.create({
    data: {
      name,
      description: input.description?.trim() ?? '',
      items: { create: keys.map((key) => ({ key })) },
    },
    select: GROUP_SELECT,
  });
  logger.info(`新建权限组「${name}」（${keys.length} 个权限键）`);
  return toGroupDto(created as GroupRow);
}

export async function updateGroup(
  groupId: string,
  input: UpdatePermissionGroupRequest,
): Promise<PermissionGroupDto> {
  const current = await prisma.permissionGroup.findUnique({
    where: { id: groupId },
    select: { id: true, name: true },
  });
  if (!current) throw ApiError.notFound('权限组不存在');

  const name = input.name?.trim();
  if (name && name !== current.name) {
    const sameName = await prisma.permissionGroup.findUnique({ where: { name }, select: { id: true } });
    if (sameName) throw ApiError.conflict(`已存在名为「${name}」的权限组`);
  }

  const keys = input.keys ? normalizeKeys(input.keys) : null;

  await prisma.$transaction(async (tx) => {
    await tx.permissionGroup.update({
      where: { id: groupId },
      data: {
        ...(name ? { name } : {}),
        ...(input.description !== undefined ? { description: input.description.trim() } : {}),
      },
    });
    // 键是整体替换：先清后建。漏传某个键就等于"取消勾选"，不会留下幽灵权限。
    if (keys) {
      await tx.permissionGroupItem.deleteMany({ where: { groupId } });
      if (keys.length > 0) {
        await tx.permissionGroupItem.createMany({ data: keys.map((key) => ({ groupId, key })) });
      }
    }
  });

  const updated = await prisma.permissionGroup.findUniqueOrThrow({
    where: { id: groupId },
    select: GROUP_SELECT,
  });
  logger.info(
    `更新权限组「${(updated as GroupRow).name}」（${keys ? `权限键 ${keys.length} 个` : '未改权限键'}）`,
  );
  return toGroupDto(updated as GroupRow);
}

export async function deleteGroup(groupId: string): Promise<{ id: string }> {
  const current = await prisma.permissionGroup.findUnique({
    where: { id: groupId },
    select: { id: true, name: true, builtin: true, _count: { select: { users: true } } },
  });
  if (!current) throw ApiError.notFound('权限组不存在');
  if (current.builtin) {
    throw ApiError.badRequest(`「${current.name}」是内置权限组，不能删除（可以改名或调整里面的权限）`);
  }

  // 键与成员关系都是 onDelete: Cascade，直接删组即可；
  // 组内成员随后"没有任何分组"，会回落角色默认模板（不会变成空权限）。
  await prisma.permissionGroup.delete({ where: { id: groupId } });
  logger.info(
    `删除权限组「${current.name}」（原成员 ${current._count.users} 个，已回到角色默认权限）`,
  );
  return { id: groupId };
}

/** 把一行 User（含分组关联）转成权限页用的成员 DTO */
function toMemberDto(
  row: MemberRow,
  keysOfGroup: Map<string, PermissionKey[]>,
): PermissionMemberDto {
  const groupIds = row.permissionGroups.map((link) => link.groupId);
  const union = new Set<PermissionKey>();
  for (const groupId of groupIds) for (const key of keysOfGroup.get(groupId) ?? []) union.add(key);

  const role = row.role as UserRole;
  const permissionCount =
    role === 'ADMIN'
      ? PERMISSION_KEYS.length
      : groupIds.length === 0
        ? ROLE_DEFAULT_PERMISSIONS[role].length
        : union.size;

  return {
    id: row.id,
    username: row.username,
    name: row.name,
    role,
    groupIds,
    permissionCount,
    fixed: role === 'ADMIN',
  };
}

/** GET /api/permissions/users - 成员列表（管理员/教师账号；班级端账号不参与权限组） */
export async function listMembers(): Promise<PermissionMemberDto[]> {
  const [rows, groups] = await Promise.all([
    prisma.user.findMany({
      where: { role: { in: ['ADMIN', 'TEACHER'] } },
      select: MEMBER_SELECT,
      orderBy: [{ role: 'asc' }, { name: 'asc' }],
    }),
    prisma.permissionGroup.findMany({ select: { id: true, items: { select: { key: true } } } }),
  ]);

  const keysOfGroup = new Map<string, PermissionKey[]>(
    groups.map((group) => [
      group.id,
      group.items.map((item) => item.key).filter(knownKey).sort(byCatalogOrder),
    ]),
  );

  return (rows as MemberRow[]).map((row) => toMemberDto(row, keysOfGroup));
}

/** PUT /api/permissions/users/:id/groups - 整体替换某账号的权限组 */
export async function assignUserGroups(
  userId: string,
  input: AssignUserGroupsRequest,
): Promise<PermissionMemberDto> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: MEMBER_SELECT });
  if (!user) throw ApiError.notFound('账号不存在');

  const row = user as MemberRow;
  if (row.role === 'ADMIN') {
    throw ApiError.badRequest('管理员固定拥有全部权限，不需要（也不能）分配权限组');
  }
  if (row.role === 'CLASS_DEVICE') {
    throw ApiError.badRequest(
      'ClassHelper 班级端账号的能力由"班级内角色"决定（见权限矩阵），不参与权限组分配',
    );
  }

  const groupIds = [...new Set(input.groupIds)];
  if (groupIds.length > 0) {
    const found = await prisma.permissionGroup.count({ where: { id: { in: groupIds } } });
    if (found !== groupIds.length) throw ApiError.badRequest('有权限组不存在，请刷新后重试');
  }

  await prisma.$transaction(async (tx) => {
    await tx.userPermissionGroup.deleteMany({ where: { userId } });
    if (groupIds.length > 0) {
      await tx.userPermissionGroup.createMany({
        data: groupIds.map((groupId) => ({ userId, groupId })),
      });
    }
  });

  logger.info(
    `分配权限组：${row.username} → ${groupIds.length > 0 ? `${groupIds.length} 个组` : '角色默认模板'}`,
  );

  const groups = await prisma.permissionGroup.findMany({
    select: { id: true, items: { select: { key: true } } },
  });
  const keysOfGroup = new Map<string, PermissionKey[]>(
    groups.map((group) => [
      group.id,
      group.items.map((item) => item.key).filter(knownKey).sort(byCatalogOrder),
    ]),
  );
  return toMemberDto({ ...row, permissionGroups: groupIds.map((groupId) => ({ groupId })) }, keysOfGroup);
}

/**
 * GET /api/permissions/me - 当前账号的生效权限。
 *
 * 两端按它决定"入口显不显示"（真正的拦截始终在服务端）。
 * 班级端会话恒为空集：它的能力由班级维度断言决定。
 */
export async function myPermissions(user: TokenPayload): Promise<MyPermissionsDto> {
  const permissions = await loadEffectivePermissions(user);
  const fromGroups =
    user.classSession || user.role === 'CLASS_DEVICE' || user.role === 'ADMIN'
      ? false
      : (await prisma.userPermissionGroup.count({ where: { userId: user.sub } })) > 0;

  return {
    role: user.role,
    permissions: [...permissions].sort(byCatalogOrder),
    fromGroups,
  };
}
