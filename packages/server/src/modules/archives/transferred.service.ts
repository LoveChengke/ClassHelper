import { prisma } from '../../lib/db.js';
import { assertGlobalPermission } from '../../lib/access.js';
import { restoreStudent } from '../students/students.service.js';
import type { TokenPayload } from '../../lib/jwt.js';
export async function listTransferred(user: TokenPayload) {
  await assertGlobalPermission(user, 'archive:manage');
  return prisma.student.findMany({
    where: { status: 'transferred' },
    select: {
      id: true,
      name: true,
      studentNo: true,
      classId: true,
      transferNote: true,
      transferredAt: true,
      class: { select: { name: true } },
    },
    orderBy: { transferredAt: 'desc' },
  });
}
export async function restoreTransferred(
  user: TokenPayload,
  id: string,
  input: { toClassId?: string; note?: string } = {},
) {
  await restoreStudent(user, id, input);
  return { id, restored: true };
}
