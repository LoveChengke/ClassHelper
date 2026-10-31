import {
  PERMISSION_KEYS,
  PERMISSION_META,
  parsePermissionScope,
  type PermissionKey,
  type PermissionScope,
} from '@classhelper/shared';
import { prisma } from '../db.js';
import type { TokenPayload } from '../jwt.js';
import { ensureDefaultGroups } from '../permissions.js';

export interface Grant {
  scope: PermissionScope;
  scopeValue: string;
  groupId: string;
}
export interface AuthPrincipal {
  permissions: ReadonlySet<PermissionKey>;
  grants: ReadonlyMap<PermissionKey, readonly Grant[]>;
  fromGroups: boolean;
}
export interface AssignmentRow {
  groupId: string;
  scope: string;
  scopeValue: string;
  group: { defaultRole: string | null; items: { key: string }[] };
}
let requests = new WeakMap<TokenPayload, Promise<AuthPrincipal>>();

export function invalidateAuthPrincipals() {
  requests = new WeakMap();
}

/** 缓存仅附着于一个请求的主体；没有可变的“当前权限键”。 */
export function loadAuthPrincipal(user: TokenPayload): Promise<AuthPrincipal> {
  let principal = requests.get(user);
  if (!principal) {
    principal = load(user);
    requests.set(user, principal);
  }
  return principal;
}

async function load(user: TokenPayload): Promise<AuthPrincipal> {
  if (user.role !== 'TEACHER') return principalForAssignments(user, []);
  await ensureDefaultGroups();
  const assignments = await prisma.userPermissionGroup.findMany({
    where: { userId: user.sub },
    include: { group: { include: { items: true } } },
  });
  return principalForAssignments(user, assignments);
}

/** 分配预览与运行时共用求值，不写数据库。 */
export async function principalForAssignments(
  user: TokenPayload,
  assignments: AssignmentRow[],
  defaultGroup?: AssignmentRow['group'] & { id: string },
): Promise<AuthPrincipal> {
  const permissions = new Set<PermissionKey>();
  const grants = new Map<PermissionKey, Grant[]>();
  if (user.role === 'CLASS_DEVICE' || user.classSession) return { permissions, grants, fromGroups: false };
  if (user.role === 'ADMIN') {
    for (const key of PERMISSION_KEYS) {
      permissions.add(key);
      grants.set(key, [{ scope: 'ALL', scopeValue: '', groupId: '' }]);
    }
    return { permissions, grants, fromGroups: false };
  }
  const fromGroups = assignments.length > 0;
  if (!fromGroups) {
    const group =
      defaultGroup ??
      (await prisma.permissionGroup.findUnique({
        where: { defaultRole: 'TEACHER' },
        include: { items: true },
      }));
    assignments = group ? [{ groupId: group.id, scope: 'TEACHING', scopeValue: '', group }] : [];
  }
  for (const assignment of assignments) {
    if (assignment.group.defaultRole === 'ADMIN') continue;
    for (const { key: raw } of assignment.group.items) {
      if (!(PERMISSION_KEYS as readonly string[]).includes(raw)) continue;
      const key = raw as PermissionKey;
      if (PERMISSION_META[key].kind === 'admin') continue;
      permissions.add(key);
      try {
        const parsed = parsePermissionScope(assignment.scope as PermissionScope, assignment.scopeValue);
        grants.set(key, [
          ...(grants.get(key) ?? []),
          { scope: parsed.scope, scopeValue: parsed.scopeValue, groupId: assignment.groupId },
        ]);
      } catch {
        /* 非法旧分配不授予班级。 */
      }
    }
  }
  return { permissions, grants, fromGroups };
}
