import { prisma } from './db.js';
import type { TokenPayload } from './jwt.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { PermissionKey } from '@classhelper/shared';

/** 范围与功能键正交；显式分组覆盖角色默认，不在范围内一律不放行。 */
export async function teacherScopeWhere(
  user: TokenPayload,
  permission?: PermissionKey,
): Promise<Prisma.ClassWhereInput> {
  const assignments = await prisma.userPermissionGroup.findMany({
    where: { userId: user.sub },
    include: { group: { include: { items: true } } },
  });
  const own = { OR: [{ teacherId: user.sub }, { courses: { some: { teacherId: user.sub } } }] };
  if (!assignments.length) return own;
  const alternatives: Prisma.ClassWhereInput[] = [];
  for (const { group } of assignments) {
    if (permission && !group.items.some((item) => item.key === permission)) continue;
    if (group.scope === 'ALL') return {};
    if (group.scope === 'SELF_CLASS')
      alternatives.push(group.scopeValue === 'HEAD' ? { teacherId: user.sub } : own);
    if (group.scope === 'GRADE' || group.scope === 'DIVISION') {
      const grades = group.scopeValue
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (grades.length) alternatives.push({ grade: { in: grades } });
    }
  }
  return { OR: alternatives };
}
