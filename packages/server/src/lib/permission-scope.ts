import { prisma } from './db.js';
import type { TokenPayload } from './jwt.js';
import type { Prisma } from '../generated/prisma/client.js';
import { parsePermissionScope, type PermissionScope, type PermissionKey } from '@classhelper/shared';
import { currentRequestPermission } from './permissions.js';

/** 范围与功能键正交；显式分组覆盖角色默认，不在范围内一律不放行。 */
export async function teacherScopeWhere(
  user: TokenPayload,
  permission?: PermissionKey,
): Promise<Prisma.ClassWhereInput> {
  permission ??= currentRequestPermission(user);
  const assignments = await prisma.userPermissionGroup.findMany({
    where: { userId: user.sub },
    include: { group: { include: { items: true } } },
  });
  const own = { OR: [{ teacherId: user.sub }, { courses: { some: { teacherId: user.sub } } }] };
  const groups = assignments.length
    ? assignments.map(({ group }) => group)
    : await prisma.permissionGroup.findMany({ where: { defaultRole: user.role }, include: { items: true } });
  const alternatives: Prisma.ClassWhereInput[] = [];
  for (const group of groups) {
    if (permission && !group.items.some((item) => item.key === permission)) continue;
    try {
      const parsed = parsePermissionScope(group.scope as PermissionScope, group.scopeValue);
      if (parsed.scope === 'ALL') return {};
      if (parsed.scope === 'SELF_CLASS')
        alternatives.push(parsed.scopeValue === 'HEAD' ? { teacherId: user.sub } : own);
      else alternatives.push({ grade: { in: parsed.grades } });
    } catch {
      /* 旧岗位组未配置或范围非法时不授予任何班级。 */
    }
  }
  return { OR: alternatives };
}

export async function hasAllScope(user: TokenPayload, permission: PermissionKey) {
  if (user.role === 'ADMIN') return true;
  const links = await prisma.userPermissionGroup.findMany({
    where: { userId: user.sub },
    select: { groupId: true },
  });
  return (
    (await prisma.permissionGroup.count({
      where: {
        ...(links.length ? { id: { in: links.map((link) => link.groupId) } } : { defaultRole: user.role }),
        scope: 'ALL',
        items: { some: { key: permission } },
      },
    })) > 0
  );
}
