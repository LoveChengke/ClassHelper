import { prisma } from '../../lib/db.js';
import { assertCanManageClasses } from '../../lib/access.js';
import type { TokenPayload } from '../../lib/jwt.js';
import { ApiError } from '../../lib/http.js';
import { notifyScheduleChanged } from '../class-plans/class-plans.service.js';
export async function listTransferred(user: TokenPayload) {
  assertCanManageClasses(user);
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
export async function restoreTransferred(user: TokenPayload, id: string) {
  assertCanManageClasses(user);
  const student = await prisma.student.findUnique({ where: { id }, include: { class: true } });
  if (student?.status !== 'transferred' || !student.classId || student.class?.archivedYearId)
    throw ApiError.badRequest('只能撤回原班仍在读的转出记录');
  await prisma.$transaction([
    prisma.student.update({
      where: { id },
      data: { status: 'active', transferredAt: null, archivedAt: null, archivedYearId: null },
    }),
    prisma.studentClassTransfer.create({
      data: {
        studentId: id,
        studentNo: student.studentNo,
        studentName: student.name,
        fromClassId: null,
        toClassId: student.classId,
        toClassName: student.class?.name ?? '',
        operatorId: user.sub,
        operatorName: user.name,
        mode: 'restore-transfer',
        note: '撤回转出，保留原转出记录',
      },
    }),
  ]);
  await notifyScheduleChanged(student.classId);
  return { id, restored: true };
}
