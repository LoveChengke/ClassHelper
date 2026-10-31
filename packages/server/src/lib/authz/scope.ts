import { PERMISSION_META, parsePermissionScope, type PermissionKey } from '@classhelper/shared';
import type { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../db.js';
import { ApiError } from '../http.js';
import type { TokenPayload } from '../jwt.js';
import { loadAuthPrincipal, type AuthPrincipal } from './principal.js';

/** 返回 Class 表过滤条件；无键、无授权、组织只读键均不产生班级集合。 */
export async function classWhere(
  user: TokenPayload,
  key: PermissionKey,
  principal?: AuthPrincipal,
): Promise<Prisma.ClassWhereInput> {
  if (!key) return { id: { in: [] } };
  const auth = principal ?? (await loadAuthPrincipal(user));
  if (!auth.permissions.has(key)) return { id: { in: [] } };
  if (user.role === 'ADMIN') return {};
  if (PERMISSION_META[key].kind !== 'class') return { id: { in: [] } };
  const alternatives: Prisma.ClassWhereInput[] = [];
  for (const grant of auth.grants.get(key) ?? []) {
    if (grant.scope === 'ALL') return PERMISSION_META[key].relation === 'head' ? { teacherId: user.sub } : {};
    if (grant.scope === 'HEAD') alternatives.push({ teacherId: user.sub });
    else if (grant.scope === 'TEACHING')
      alternatives.push({ OR: [{ teacherId: user.sub }, { courses: { some: { teacherId: user.sub } } }] });
    else alternatives.push({ grade: { in: parsePermissionScope(grant.scope, grant.scopeValue).grades } });
  }
  // 班主任专属键仍须满足分配范围与关系的交集。
  if (PERMISSION_META[key].relation === 'head') {
    return { AND: [{ OR: alternatives }, { teacherId: user.sub }] };
  }
  return { OR: alternatives };
}

export async function classIdsFor(
  user: TokenPayload,
  key: PermissionKey,
  principal?: AuthPrincipal,
  db: Prisma.TransactionClient = prisma,
): Promise<string[]> {
  const rows = await db.class.findMany({
    where: await classWhere(user, key, principal),
    select: { id: true },
  });
  return rows.map((row) => row.id);
}
/** 名单、日课表、导入及考试配置的班级管理范围，供界面准确显示操作入口。 */
export async function manageClassIdsFor(
  user: TokenPayload,
  key: PermissionKey,
  principal: AuthPrincipal,
): Promise<string[]> {
  if (user.role === 'ADMIN') return classIdsFor(user, key, principal);
  const grants = (principal.grants.get(key) ?? []).filter((g) =>
    ['GRADE', 'DIVISION', 'ALL'].includes(g.scope),
  );
  const broad = await classWhere(user, key, { ...principal, grants: new Map([[key, grants]]) });
  const rows = await prisma.class.findMany({
    where: { AND: [await classWhere(user, key, principal), { OR: [{ teacherId: user.sub }, broad] }] },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}
/** 每项输入都携带权限键；关系一次读取，输出仍逐键与各自授权范围求交。 */
export async function actionScopesFor(
  user: TokenPayload,
  scopes: ReadonlyArray<readonly [PermissionKey, readonly string[]]>,
  management: ReadonlyArray<readonly [PermissionKey, readonly string[]]>,
): Promise<Partial<Record<PermissionKey, readonly string[]>>> {
  const result = { ...Object.fromEntries(scopes), ...Object.fromEntries(management) };
  const related = scopes.filter(([key]) =>
    ['subject', 'publish', 'creator'].includes(PERMISSION_META[key].relation),
  );
  if (user.role === 'ADMIN' || !related.length) return result;
  const rows = await prisma.class.findMany({
    where: { id: { in: [...new Set(related.flatMap(([, ids]) => [...ids]))] } },
    select: {
      id: true,
      teacherId: true,
      courses: { where: { teacherId: user.sub }, select: { id: true }, take: 1 },
      notifications: { where: { createdBy: user.sub }, select: { id: true }, take: 1 },
    },
  });
  const relations = new Map(rows.map((row) => [row.id, row]));
  for (const [key, ids] of related) {
    const allowed = ids.filter((id) => {
      const row = relations.get(id);
      return (
        row &&
        (row.teacherId === user.sub ||
          (PERMISSION_META[key].relation === 'creator'
            ? row.notifications.length > 0
            : row.courses.length > 0))
      );
    });
    // 成绩页还包含考试口径/查询开关，显式组织范围可维护这些配置。
    result[key] =
      key === 'grade:write'
        ? [...new Set([...allowed, ...(management.find(([k]) => k === key)?.[1] ?? [])])]
        : allowed;
  }
  return result;
}
export async function assertClassInScope(
  user: TokenPayload,
  key: PermissionKey,
  classId: string,
  db: Prisma.TransactionClient = prisma,
): Promise<void> {
  if (!(await db.class.count({ where: { AND: [{ id: classId }, await classWhere(user, key)] } })))
    throw ApiError.forbidden('目标班级不在此功能的授权范围内');
}
/** 管理动作只有显式年级/部/全校分配可越过班主任关系。 */
export async function hasOrganizationalGrant(
  user: TokenPayload,
  key: PermissionKey,
  classId?: string,
  db: Prisma.TransactionClient = prisma,
): Promise<boolean> {
  if (user.role === 'ADMIN') return true;
  const auth = await loadAuthPrincipal(user);
  const grants = (auth.grants.get(key) ?? []).filter((g) => ['GRADE', 'DIVISION', 'ALL'].includes(g.scope));
  if (!classId) return grants.some((g) => g.scope === 'ALL');
  return (await classIdsFor(user, key, { ...auth, grants: new Map([[key, grants]]) }, db)).includes(classId);
}
