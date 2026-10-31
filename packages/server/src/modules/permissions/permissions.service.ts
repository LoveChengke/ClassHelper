import { disconnectUserSessions } from '../../realtime/bus.js';
import {
  PERMISSION_KEYS,
  PERMISSION_META,
  PERMISSION_LABELS,
  PERMISSION_CATEGORIES,
  ROLE_DEFAULT_PERMISSIONS,
  parsePermissionScope,
  defaultPromotionPlan,
  type PermissionKey,
  type PermissionScope,
  type PermissionGroupDto,
  type PermissionMemberDto,
  type PermissionCatalogDto,
  type EffectivePermissionsDto,
  type AssignUserGroupsRequest,
  type CreatePermissionGroupRequest,
  type UpdatePermissionGroupRequest,
  type PromotionPlan,
} from '@classhelper/shared';
import { prisma } from '../../lib/db.js';
import { ApiError } from '../../lib/http.js';
import type { TokenPayload } from '../../lib/jwt.js';
import { ensureDefaultGroups } from '../../lib/permissions.js';
import {
  assertAdmin,
  invalidateAuthPrincipals,
  loadAuthPrincipal,
  principalForAssignments,
  classIdsFor,
  manageClassIdsFor,
  actionScopesFor,
  type AssignmentRow,
} from '../../lib/authz/index.js';
import { getSetting } from '../../lib/settings.js';

const include = { items: true, _count: { select: { users: true } } } as const;
type Group = Awaited<ReturnType<typeof prisma.permissionGroup.findMany<{ include: typeof include }>>>[number];
const known = (key: string): key is PermissionKey => (PERMISSION_KEYS as readonly string[]).includes(key);
const keysFor = (group: { items: { key: string }[] }) => group.items.map((i) => i.key).filter(known);
const activeKeys = (group: { items: { key: string }[] }) =>
  keysFor(group).filter((key) => PERMISSION_META[key].kind !== 'admin');
function label(scope: string, scopeValue: string) {
  try {
    return parsePermissionScope(scope as PermissionScope, scopeValue).scopeLabel;
  } catch {
    return '未配置范围（无班级访问权）';
  }
}
function dto(group: Group): PermissionGroupDto {
  const inactiveKeys = keysFor(group).filter((k) => PERMISSION_META[k].kind === 'admin');
  return {
    ...group,
    keys: activeKeys(group),
    scope: group.scope as PermissionScope,
    scopeLabel: label(group.scope, group.scopeValue),
    defaultScope: group.scope as PermissionScope,
    defaultScopeValue: group.scopeValue,
    defaultScopeLabel: label(group.scope, group.scopeValue),
    defaultRole: group.defaultRole === 'TEACHER' ? 'TEACHER' : null,
    kind: group.defaultRole ? 'default' : group.builtin ? 'builtin' : 'custom',
    inactiveKeys,
    warnings: inactiveKeys.length ? ['旧管理员专用键已停用，仅管理员固定拥有'] : [],
    memberCount: group._count.users,
    createdAt: group.createdAt.toISOString(),
    updatedAt: group.updatedAt.toISOString(),
  };
}
export function auditData(
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
export async function scopeOptions() {
  const classes = await prisma.class.findMany({ distinct: ['grade'], select: { grade: true } });
  const raw = await getSetting('term.promotionPlan');
  const plan: PromotionPlan = raw ? JSON.parse(raw) : defaultPromotionPlan();
  const planGrades = plan.tracks.flatMap((t) => t.stages.map((s) => s.grade));
  return {
    grades: [...new Set([...classes.map((c) => c.grade), ...planGrades])].sort(),
    planGrades,
    divisions: plan.tracks.map((t) => ({ name: t.name, grades: t.stages.map((s) => s.grade) })),
  };
}
async function validateScope(scope: PermissionScope = 'TEACHING', scopeValue = '') {
  try {
    return parsePermissionScope(scope, scopeValue, (await scopeOptions()).grades);
  } catch (error) {
    throw ApiError.badRequest(error instanceof Error ? error.message : String(error));
  }
}
function validateKeys(keys: readonly string[]) {
  if (keys.some((k) => !known(k) || PERMISSION_META[k].kind === 'admin'))
    throw ApiError.badRequest('教师模板不能包含管理员专用键或未知键');
  return [...new Set(keys)] as PermissionKey[];
}
export async function createGroup(actor: TokenPayload, input: CreatePermissionGroupRequest) {
  assertAdmin(actor);
  const scope = await validateScope(input.scope, input.scopeValue);
  const keys = validateKeys(input.keys ?? []);
  return prisma.$transaction(async (tx) => {
    const row = await tx.permissionGroup.create({
      data: {
        name: input.name.trim(),
        description: input.description?.trim() ?? '',
        scope: scope.scope,
        scopeValue: scope.scopeValue,
        items: { create: keys.map((key) => ({ key })) },
      },
      include,
    });
    await tx.permissionAudit.create({ data: auditData(actor, 'create', 'group', row.id, null, dto(row)) });
    invalidateAuthPrincipals();
    return dto(row);
  });
}
export async function updateGroup(actor: TokenPayload, id: string, input: UpdatePermissionGroupRequest) {
  assertAdmin(actor);
  const current = await prisma.permissionGroup.findUnique({ where: { id }, include });
  if (!current || current.defaultRole === 'ADMIN') throw ApiError.notFound('模板不存在');
  const scope = await validateScope(
    input.scope ?? (current.scope as PermissionScope),
    input.scopeValue ?? current.scopeValue,
  );
  if (current.defaultRole === 'TEACHER' && scope.scope !== 'TEACHING')
    throw ApiError.badRequest('教师默认模板固定使用任教班级范围');
  // 旧管理员键仅停用；编辑可分配能力时保留它们，不能通过写入口重新授予。
  const inactiveKeys = keysFor(current).filter((key) => PERMISSION_META[key].kind === 'admin');
  const keys =
    input.keys === undefined
      ? current.items.map((i) => i.key)
      : [...new Set([...validateKeys(input.keys), ...inactiveKeys])];
  let affected: string[] = [];
  const result = await prisma.$transaction(async (tx) => {
    await tx.permissionGroupItem.deleteMany({ where: { groupId: id } });
    const row = await tx.permissionGroup.update({
      where: { id },
      data: {
        name: input.name?.trim(),
        description: input.description?.trim(),
        scope: scope.scope,
        scopeValue: scope.scopeValue,
        items: { create: keys.map((key) => ({ key })) },
      },
      include,
    });
    await tx.permissionAudit.create({
      data: auditData(actor, 'update', 'group', id, dto(current), dto(row)),
    });
    const members =
      current.defaultRole === 'TEACHER'
        ? await tx.user.findMany({ where: { role: 'TEACHER' }, select: { id: true } })
        : await tx.userPermissionGroup
            .findMany({ where: { groupId: id }, select: { userId: true } })
            .then((rows) => rows.map((r) => ({ id: r.userId })));
    affected = members.map((u) => u.id);
    return dto(row);
  });
  invalidateAuthPrincipals();
  disconnectUserSessions(affected);
  return result;
}
export async function deleteGroup(actor: TokenPayload, id: string) {
  assertAdmin(actor);
  const group = await prisma.permissionGroup.findUnique({ where: { id }, include });
  if (!group) throw ApiError.notFound('模板不存在');
  if (group.builtin || group.defaultRole) throw ApiError.badRequest('内置或默认模板不可删除');
  const members = await prisma.userPermissionGroup.findMany({
    where: { groupId: id },
    select: { userId: true },
  });
  await prisma.$transaction(async (tx) => {
    await tx.permissionGroup.delete({ where: { id } });
    await tx.permissionAudit.create({ data: auditData(actor, 'delete', 'group', id, dto(group), null) });
  });
  invalidateAuthPrincipals();
  disconnectUserSessions(members.map((m) => m.userId));
  return { id };
}
export async function listMembers(actor: TokenPayload): Promise<PermissionMemberDto[]> {
  assertAdmin(actor);
  await ensureDefaultGroups();
  const defaultGroup = await prisma.permissionGroup.findUniqueOrThrow({
    where: { defaultRole: 'TEACHER' },
    include: { items: true },
  });
  const users = await prisma.user.findMany({
    where: { role: { in: ['ADMIN', 'TEACHER'] } },
    include: { permissionGroups: { include: { group: { include: { items: true } } } } },
    orderBy: { name: 'asc' },
  });
  return Promise.all(
    users.map(async (u) => {
      const user: TokenPayload = {
        sub: u.id,
        role: u.role as TokenPayload['role'],
        username: u.username,
        name: u.name,
        classId: null,
      };
      const auth = await principalForAssignments(user, u.permissionGroups, defaultGroup);
      const assignments =
        u.role === 'ADMIN'
          ? []
          : u.permissionGroups.map((a) => ({
              groupId: a.groupId,
              groupName: a.group.name,
              scope: a.scope as PermissionScope,
              scopeValue: a.scopeValue,
              scopeLabel: label(a.scope, a.scopeValue),
            }));
      return {
        id: u.id,
        username: u.username,
        name: u.name,
        role: user.role,
        fixed: u.role === 'ADMIN',
        assignments,
        groupIds: [...new Set(assignments.map((a) => a.groupId))],
        permissions: [...auth.permissions],
        permissionCount: auth.permissions.size,
        scopeLabels: assignments.length
          ? [...new Set(assignments.map((a) => a.scopeLabel))]
          : [u.role === 'ADMIN' ? '固定全部权限' : '默认模板 · 任教班级'],
      };
    }),
  );
}
export async function groupMembers(actor: TokenPayload, id: string) {
  assertAdmin(actor);
  const group = await prisma.permissionGroup.findUnique({ where: { id } });
  if (!group || group.defaultRole === 'ADMIN') throw ApiError.notFound('模板不存在');
  return (await listMembers(actor)).filter(
    (u) =>
      !u.fixed && (u.groupIds.includes(id) || (group.defaultRole === 'TEACHER' && !u.assignments.length)),
  );
}
async function assignmentRows(input: AssignUserGroupsRequest): Promise<AssignmentRow[]> {
  const ids = input.assignments?.map((a) => a.groupId) ?? input.groupIds ?? [];
  const groups = await prisma.permissionGroup.findMany({
    where: { id: { in: ids } },
    include: { items: true },
  });
  if (new Set(ids).size !== groups.length || groups.some((g) => g.defaultRole === 'ADMIN'))
    throw ApiError.badRequest('模板不存在或已停用');
  const assignments =
    input.assignments ??
    ids.map((groupId) => {
      const g = groups.find((g) => g.id === groupId)!;
      return { groupId, scope: g.scope as PermissionScope, scopeValue: g.scopeValue };
    });
  const rows: AssignmentRow[] = [];
  for (const assignment of assignments) {
    const group = groups.find((g) => g.id === assignment.groupId)!;
    const scope = await validateScope(assignment.scope, assignment.scopeValue);
    if (group.defaultRole === 'TEACHER' && scope.scope !== 'TEACHING')
      throw ApiError.badRequest('教师默认模板只允许任教班级范围');
    if (
      activeKeys(group).some(
        (k) => PERMISSION_META[k].kind === 'class' && !PERMISSION_META[k].allowedScopes.includes(scope.scope),
      )
    )
      throw ApiError.badRequest('分配范围不适用于模板能力');
    rows.push({ groupId: group.id, scope: scope.scope, scopeValue: scope.scopeValue, group });
  }
  return [...new Map(rows.map((a) => [`${a.groupId}:${a.scope}:${a.scopeValue}`, a])).values()];
}
export async function effectivePermissions(
  actor: TokenPayload,
  id: string,
  preview?: AssignUserGroupsRequest,
): Promise<EffectivePermissionsDto> {
  assertAdmin(actor);
  await ensureDefaultGroups();
  const u = await prisma.user.findUnique({
    where: { id },
    include: { permissionGroups: { include: { group: { include: { items: true } } } } },
  });
  if (!u) throw ApiError.notFound('账号不存在');
  const user: TokenPayload = {
    sub: id,
    name: u.name,
    username: u.username,
    role: u.role as TokenPayload['role'],
    classId: null,
  };
  if (preview && u.role === 'ADMIN') throw ApiError.badRequest('管理员固定全部权限，不接受分配');
  const auth = await principalForAssignments(
    user,
    preview ? await assignmentRows(preview) : u.permissionGroups,
  );
  const classes = await prisma.class.findMany({ select: { id: true, name: true } });
  const entries = await Promise.all(
    [...auth.permissions].map(async (key) => {
      const ids = await classIdsFor(user, key, auth);
      return {
        key,
        scopes: [...new Set((auth.grants.get(key) ?? []).map((g) => label(g.scope, g.scopeValue)))],
        classes: classes.filter((c) => ids.includes(c.id)),
        classCount: ids.length,
      };
    }),
  );
  return {
    permissions: [...auth.permissions],
    entries,
    conflicts: entries
      .filter((e) => e.scopes.length > 1)
      .map((e) => `${PERMISSION_LABELS[e.key]}：实际合并范围 ${e.scopes.join(' ∪ ')}；较窄分配可能被覆盖`),
    headOnlyKeys: [...auth.permissions].filter((k) => PERMISSION_META[k].relation === 'head'),
  };
}
export async function assignUserGroups(actor: TokenPayload, userId: string, input: AssignUserGroupsRequest) {
  assertAdmin(actor);
  const u = await prisma.user.findUnique({ where: { id: userId } });
  if (!u) throw ApiError.notFound('账号不存在');
  if (u.role !== 'TEACHER') throw ApiError.badRequest('管理员固定全部权限，不能分配模板');
  const rows = await assignmentRows(input);
  const before = (await listMembers(actor)).find((m) => m.id === userId)!;
  await prisma.$transaction(async (tx) => {
    await tx.userPermissionGroup.deleteMany({ where: { userId } });
    if (rows.length)
      await tx.userPermissionGroup.createMany({
        data: rows.map(({ groupId, scope, scopeValue }) => ({ userId, groupId, scope, scopeValue })),
      });
    await tx.permissionAudit.create({
      data: auditData(
        actor,
        'assign',
        'user',
        userId,
        before.assignments,
        rows.map(({ groupId, scope, scopeValue }) => ({ groupId, scope, scopeValue })),
      ),
    });
  });
  invalidateAuthPrincipals();
  disconnectUserSessions([userId]);
  return (await listMembers(actor)).find((m) => m.id === userId)!;
}
export async function listAudits(actor: TokenPayload, page = 1, pageSize = 30) {
  assertAdmin(actor);
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
export async function permissionCatalog(actor: TokenPayload): Promise<PermissionCatalogDto> {
  assertAdmin(actor);
  await ensureDefaultGroups();
  const group = await prisma.permissionGroup.findUniqueOrThrow({
    where: { defaultRole: 'TEACHER' },
    include: { items: true },
  });
  return {
    keys: [...PERMISSION_KEYS],
    meta: PERMISSION_META,
    labels: PERMISSION_LABELS,
    categories: PERMISSION_CATEGORIES.map((c) => ({ title: c.title, keys: [...c.keys] })),
    defaultRoles: Object.fromEntries(
      PERMISSION_KEYS.map((k) => [k, [...PERMISSION_META[k].defaultRoles]]),
    ) as PermissionCatalogDto['defaultRoles'],
    roleDefaults: {
      ...ROLE_DEFAULT_PERMISSIONS,
      ADMIN: [...PERMISSION_KEYS],
      TEACHER: activeKeys(group),
      CLASS_DEVICE: [],
    },
    unremovable: [...PERMISSION_KEYS],
  };
}
export async function listGroups(actor: TokenPayload): Promise<PermissionGroupDto[]> {
  assertAdmin(actor);
  await ensureDefaultGroups();
  const members = await listMembers(actor);
  return (
    await prisma.permissionGroup.findMany({
      where: { OR: [{ defaultRole: null }, { defaultRole: 'TEACHER' }] },
      include,
      orderBy: [{ builtin: 'desc' }, { createdAt: 'asc' }],
    })
  ).map((group) => ({
    ...dto(group),
    memberCount: members.filter(
      (m) =>
        !m.fixed &&
        (m.groupIds.includes(group.id) || (group.defaultRole === 'TEACHER' && !m.assignments.length)),
    ).length,
  }));
}
export async function myPermissions(user: TokenPayload) {
  const auth = await loadAuthPrincipal(user);
  const classKeys = [...auth.permissions].filter((key) => PERMISSION_META[key].kind === 'class');
  const managementKeys = classKeys.filter((key) =>
    ['roster:manage', 'schedule:write', 'import:students', 'import:schedule', 'grade:write'].includes(key),
  );
  const [scopes, management] = await Promise.all([
    Promise.all(classKeys.map(async (key) => [key, await classIdsFor(user, key, auth)] as const)),
    Promise.all(managementKeys.map(async (key) => [key, await manageClassIdsFor(user, key, auth)] as const)),
  ]);
  return {
    role: user.role,
    permissions: [...auth.permissions],
    fromGroups: auth.fromGroups,
    classScopes: Object.fromEntries(scopes),
    manageScopes: Object.fromEntries(management),
    actionScopes: await actionScopesFor(user, scopes, management),
    allScopeKeys: [...auth.grants]
      .filter(([, grants]) => grants.some((g) => g.scope === 'ALL'))
      .map(([key]) => key),
  };
}
