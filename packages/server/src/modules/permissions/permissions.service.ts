import {
  PERMISSION_CATEGORIES,
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
import {
  parsePermissionScope,
  defaultPromotionPlan,
  type PermissionScope,
  type PromotionPlan,
} from '@classhelper/shared';
import { assertPermission } from '../../lib/permissions.js';
import { getSetting } from '../../lib/settings.js';
import {
  ADMIN_UNREMOVABLE_PERMISSIONS,
  ensureDefaultGroups,
  loadEffectivePermissions,
} from '../../lib/permissions.js';

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
  defaultRole: true,
  scope: true,
  scopeValue: true,
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
  defaultRole: string | null;
  scope: string;
  scopeValue: string;
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
    scope: row.scope as PermissionGroupDto['scope'],
    scopeValue: row.scopeValue,
    scopeLabel: scopeLabel(row),
    name: row.name,
    description: row.description,
    builtin: row.builtin,
    defaultRole: row.defaultRole as UserRole | null,
    keys: row.items
      .map((item) => item.key)
      .filter(knownKey)
      .sort(byCatalogOrder),
    memberCount: row._count.users,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function scopeLabel(group: { scope: string; scopeValue: string }) {
  try {
    return parsePermissionScope(group.scope as PermissionScope, group.scopeValue).scopeLabel;
  } catch {
    return '未配置范围（无班级访问权）';
  }
}

export async function scopeOptions() {
  const classes = await prisma.class.findMany({ distinct: ['grade'], select: { grade: true } });
  const raw = await getSetting('term.promotionPlan');
  const plan: PromotionPlan = raw ? JSON.parse(raw) : defaultPromotionPlan();
  const planGrades = plan.tracks.flatMap((track) => track.stages.map((stage) => stage.grade));
  return {
    grades: [...new Set([...classes.map((cls) => cls.grade), ...planGrades])].sort(),
    planGrades,
    divisions: plan.tracks.map((track) => ({
      name: track.name,
      grades: track.stages.map((stage) => stage.grade),
    })),
  };
}

async function validateScope(input: { scope?: PermissionScope; scopeValue?: string }) {
  try {
    return parsePermissionScope(
      input.scope ?? 'SELF_CLASS',
      input.scopeValue ?? '',
      (await scopeOptions()).grades,
    );
  } catch (error) {
    throw ApiError.badRequest(String(error instanceof Error ? error.message : error));
  }
}

async function assertGrant(
  actor: TokenPayload,
  group: { scope: string; defaultRole?: string | null; keys: readonly string[] },
) {
  await assertPermission(actor, 'permission:manage');
  if (actor.role === 'ADMIN') return;
  if (group.defaultRole) throw ApiError.forbidden('只有管理员可以管理角色默认组');
  if (group.scope !== 'SELF_CLASS') throw ApiError.forbidden('只有管理员可以管理年级、部或全校范围组');
  const own = await loadEffectivePermissions(actor);
  if (group.keys.some((key) => !own.has(key as PermissionKey)))
    throw ApiError.forbidden('不能授予或管理超出自己生效权限的组');
}

function auditData(
  actor: TokenPayload,
  action: string,
  targetType: string,
  targetId: string,
  before: unknown,
  after: unknown,
) {
  return {
    actorId: actor.sub,
    actorName: actor.name,
    action,
    targetType,
    targetId,
    beforeJson: JSON.stringify(before),
    afterJson: JSON.stringify(after),
  };
}

export async function createGroup(
  actor: TokenPayload,
  input: CreatePermissionGroupRequest,
): Promise<PermissionGroupDto> {
  const scope = await validateScope(input);
  const keys = normalizeKeys(input.keys);
  await assertGrant(actor, { ...scope, keys });
  if (await prisma.permissionGroup.findUnique({ where: { name: input.name.trim() } }))
    throw ApiError.conflict('权限组名称已存在');
  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.permissionGroup.create({
      data: {
        name: input.name.trim(),
        description: input.description?.trim() ?? '',
        scope: scope.scope,
        scopeValue: scope.scopeValue,
        items: { create: keys.map((key) => ({ key })) },
      },
      select: GROUP_SELECT,
    });
    await tx.permissionAudit.create({
      data: auditData(actor, 'create', 'group', row.id, null, toGroupDto(row)),
    });
    return row;
  });
  return toGroupDto(created);
}

export async function updateGroup(
  actor: TokenPayload,
  groupId: string,
  input: UpdatePermissionGroupRequest,
): Promise<PermissionGroupDto> {
  const current = await prisma.permissionGroup.findUnique({ where: { id: groupId }, select: GROUP_SELECT });
  if (!current) throw ApiError.notFound('权限组不存在');
  const before = toGroupDto(current);
  await assertGrant(actor, { ...current, keys: before.keys });
  const scope = await validateScope({
    scope: input.scope ?? before.scope,
    scopeValue: input.scopeValue ?? before.scopeValue,
  });
  const keys = normalizeKeys(input.keys ?? before.keys);
  await assertGrant(actor, { ...scope, defaultRole: current.defaultRole, keys });
  const updated = await prisma.$transaction(async (tx) => {
    await tx.permissionGroupItem.deleteMany({ where: { groupId } });
    const row = await tx.permissionGroup.update({
      where: { id: groupId },
      data: {
        name: input.name?.trim(),
        description: input.description?.trim(),
        scope: scope.scope,
        scopeValue: scope.scopeValue,
        items: { create: keys.map((key) => ({ key })) },
      },
      select: GROUP_SELECT,
    });
    await tx.permissionAudit.create({
      data: auditData(
        actor,
        current.defaultRole ? 'update-default' : 'update',
        'group',
        groupId,
        before,
        toGroupDto(row),
      ),
    });
    return row;
  });
  return toGroupDto(updated);
}

export async function deleteGroup(actor: TokenPayload, groupId: string) {
  const current = await prisma.permissionGroup.findUnique({ where: { id: groupId }, select: GROUP_SELECT });
  if (!current) throw ApiError.notFound('权限组不存在');
  await assertGrant(actor, { ...current, keys: current.items.map((item) => item.key) });
  if (current.builtin) throw ApiError.badRequest('内置权限组不可删除');
  // 删除最后一组会回落默认组；非管理员不能借删除制造额外授权。
  if (actor.role !== 'ADMIN') throw ApiError.forbidden('删除组会改变成员默认权限，仅管理员可执行');
  await prisma.$transaction(async (tx) => {
    await tx.permissionGroup.delete({ where: { id: groupId } });
    await tx.permissionAudit.create({
      data: auditData(actor, 'delete', 'group', groupId, toGroupDto(current), null),
    });
  });
  return { id: groupId };
}

/** 组和成员各预取一次，账号数增长不会增加权限查询次数。 */
export async function listMembers(): Promise<PermissionMemberDto[]> {
  await ensureDefaultGroups();
  const [rows, groups] = await Promise.all([
    prisma.user.findMany({
      where: { role: { in: ['ADMIN', 'TEACHER'] } },
      select: MEMBER_SELECT,
      orderBy: [{ role: 'asc' }, { name: 'asc' }],
    }),
    prisma.permissionGroup.findMany({ include: { items: true } }),
  ]);
  return rows.map((row) => {
    const groupIds = row.permissionGroups.map((link) => link.groupId);
    const effective = groups.filter((group) =>
      groupIds.length ? groupIds.includes(group.id) : group.defaultRole === row.role,
    );
    const permissions = normalizeKeys([
      ...effective.flatMap((group) => group.items.map((item) => item.key)),
      ...(row.role === 'ADMIN' ? ADMIN_UNREMOVABLE_PERMISSIONS : []),
    ]);
    return {
      id: row.id,
      username: row.username,
      name: row.name,
      role: row.role as UserRole,
      groupIds,
      permissions,
      permissionCount: permissions.length,
      scopeLabels: [...new Set(effective.map(scopeLabel))],
    };
  });
}

export async function groupMembers(groupId: string) {
  const group = await prisma.permissionGroup.findUnique({ where: { id: groupId } });
  if (!group) throw ApiError.notFound('权限组不存在');
  return (await listMembers()).filter((member) =>
    member.groupIds.length ? member.groupIds.includes(groupId) : member.role === group.defaultRole,
  );
}

export async function assignUserGroups(
  actor: TokenPayload,
  userId: string,
  input: AssignUserGroupsRequest,
): Promise<PermissionMemberDto> {
  await assertPermission(actor, 'permission:manage');
  const user = await prisma.user.findUnique({ where: { id: userId }, select: MEMBER_SELECT });
  if (!user || !['ADMIN', 'TEACHER'].includes(user.role)) throw ApiError.notFound('员工账号不存在');
  const ids = [...new Set(input.groupIds)];
  const groups = await prisma.permissionGroup.findMany({
    where: ids.length ? { id: { in: ids } } : { defaultRole: user.role },
    include: { items: true },
  });
  if (ids.length && groups.length !== ids.length) throw ApiError.badRequest('部分权限组不存在');
  for (const group of groups) {
    if (group.defaultRole && group.defaultRole !== user.role)
      throw ApiError.forbidden('默认组只能分配给同角色账号');
    // 同角色默认组可显式选中，但仍检查范围与键的授权能力。
    await assertGrant(actor, { ...group, defaultRole: null, keys: group.items.map((item) => item.key) });
  }
  if (actor.role !== 'ADMIN' && user.role === 'ADMIN') throw ApiError.forbidden('非管理员不能更改管理员分组');
  const before = (await listMembers()).find((member) => member.id === userId)!;
  await prisma.$transaction(async (tx) => {
    await tx.userPermissionGroup.deleteMany({ where: { userId } });
    if (ids.length)
      await tx.userPermissionGroup.createMany({ data: ids.map((groupId) => ({ userId, groupId })) });
    await tx.permissionAudit.create({
      data: auditData(actor, 'assign', 'user', userId, before, {
        groupIds: ids,
        permissions: normalizeKeys([
          ...groups.flatMap((group) => group.items.map((item) => item.key)),
          ...(user.role === 'ADMIN' ? ADMIN_UNREMOVABLE_PERMISSIONS : []),
        ]),
      }),
    });
  });
  return (await listMembers()).find((member) => member.id === userId)!;
}

export async function listAudits(page = 1, pageSize = 30) {
  const [items, total] = await Promise.all([
    prisma.permissionAudit.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.permissionAudit.count(),
  ]);
  return { items, total, page, pageSize };
}

/** GET /api/permissions/catalog - 权限键目录（权限页整棵勾选树都按它渲染） */
export async function permissionCatalog(): Promise<PermissionCatalogDto> {
  await ensureDefaultGroups();
  const defaults = await prisma.permissionGroup.findMany({
    where: { defaultRole: { not: null } },
    include: { items: true },
  });
  const roles = Object.keys(ROLE_DEFAULT_PERMISSIONS) as UserRole[];
  const keysForRole = (role: UserRole): PermissionKey[] => {
    const keys =
      defaults.find((group) => group.defaultRole === role)?.items.map((item) => item.key) ??
      ROLE_DEFAULT_PERMISSIONS[role];
    return normalizeKeys(role === 'ADMIN' ? [...keys, ...ADMIN_UNREMOVABLE_PERMISSIONS] : keys);
  };
  return {
    keys: [...PERMISSION_KEYS],
    labels: { ...PERMISSION_LABELS },
    categories: PERMISSION_CATEGORIES.map((category) => ({
      title: category.title,
      keys: [...category.keys],
    })),
    defaultRoles: Object.fromEntries(
      PERMISSION_KEYS.map((key) => [key, roles.filter((role) => keysForRole(role).includes(key))]),
    ) as Record<PermissionKey, UserRole[]>,
    roleDefaults: Object.fromEntries(roles.map((role) => [role, keysForRole(role)])) as Record<
      UserRole,
      PermissionKey[]
    >,
    unremovable: [...ADMIN_UNREMOVABLE_PERMISSIONS],
  };
}

/** GET /api/permissions/groups - 权限组列表（内置组排在最前，其余按创建时间） */
export async function listGroups(): Promise<PermissionGroupDto[]> {
  await ensureDefaultGroups();
  const rows = await prisma.permissionGroup.findMany({
    select: GROUP_SELECT,
    orderBy: [{ builtin: 'desc' }, { createdAt: 'asc' }],
  });
  const members = await listMembers();
  return (rows as GroupRow[]).map((row) => ({
    ...toGroupDto(row),
    memberCount: members.filter((m) =>
      m.groupIds.length ? m.groupIds.includes(row.id) : row.defaultRole === m.role,
    ).length,
  }));
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
    user.classSession || user.role === 'CLASS_DEVICE'
      ? false
      : (await prisma.userPermissionGroup.count({ where: { userId: user.sub } })) > 0;

  return {
    role: user.role,
    permissions: [...permissions].sort(byCatalogOrder),
    fromGroups,
  };
}
