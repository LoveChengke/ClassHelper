import type { Prisma } from '../generated/prisma/client.js';
import { randomUUID } from 'node:crypto';
import { currentAcademicYearStart, SOCKET_EVENTS, type StudentLifecycleKind } from '@classhelper/shared';
import { prisma } from './db.js';
import { ApiError } from './http.js';
import { assertCanManageRoster } from './access.js';
import type { TokenPayload } from './jwt.js';
import { toStudentTransferDto } from './mappers.js';
import { emitToClass } from '../realtime/bus.js';

export function notifyStudentClasses(ids: (string | null)[]) {
  for (const classId of new Set(ids.filter((id): id is string => Boolean(id))))
    emitToClass(classId, SOCKET_EVENTS.classUpdated, { classId, action: 'updated' });
}

/** 生命周期写入只有此入口；数据、班级快照与历史在同一事务提交。 */
export async function changeStudentLifecycle(
  user: TokenPayload,
  input: {
    studentIds: string[];
    kind: StudentLifecycleKind;
    toClassId?: string | null;
    note?: string;
    fromSchool?: string;
    toSchool?: string;
    allowGradeChange?: boolean;
    newStudent?: {
      studentNo: string;
      name: string;
      gender?: string;
      guardianPhone?: string;
      status?: 'active' | 'inactive';
    };
  },
  transaction?: Prisma.TransactionClient,
) {
  const batchId = randomUUID();
  const ids = [...new Set(input.studentIds)];
  const existing = ids.length
    ? await (transaction ?? prisma).student.findMany({ where: { id: { in: ids } } })
    : [];
  if (existing.length !== ids.length) throw ApiError.notFound('部分学生不存在，请刷新后重试');
  for (const cls of new Set(existing.map((student) => student.classId)))
    await assertCanManageRoster(user, cls ?? undefined, transaction);
  if (input.toClassId) await assertCanManageRoster(user, input.toClassId, transaction);
  else if (!existing.length) await assertCanManageRoster(user, undefined, transaction);
  const changedClasses: (string | null)[] = [];
  const work = async (tx: Prisma.TransactionClient) => {
    const target = input.toClassId ? await tx.class.findUnique({ where: { id: input.toClassId } }) : null;
    if (input.toClassId && !target) throw ApiError.badRequest('目标班级不存在');
    if (target?.archivedYearId) throw ApiError.conflict('目标班级已归档，不能调入');
    if (['transfer-in', 'restore'].includes(input.kind) && !target)
      throw ApiError.badRequest('请指定在读班级');
    const students = ids.length
      ? await tx.student.findMany({ where: { id: { in: ids } }, include: { class: true } })
      : [];
    if (input.newStudent) {
      if (await tx.student.findUnique({ where: { studentNo: input.newStudent.studentNo } }))
        throw ApiError.conflict('学号已被占用，请使用转入或复学入口');
      const created = await tx.student.create({
        data: { ...input.newStudent, classId: target?.id ?? null },
        include: { class: true },
      });
      students.push(created);
    }
    if (!students.length) throw ApiError.badRequest('请至少选择一名学生');
    const records = [];
    for (const student of students) {
      const isNew = Boolean(input.newStudent);
      const prior = existing.find((item) => item.id === student.id);
      if (
        prior &&
        (prior.classId !== student.classId ||
          prior.status !== student.status ||
          prior.archivedYearId !== student.archivedYearId)
      )
        throw ApiError.conflict('学生状态已变化，请刷新后重试');
      // 撤回转出是唯一允许将归档转出记录迁入其他在读班的路径。
      if (
        student.status === 'graduated' ||
        (!isNew &&
          (student.archivedYearId || student.class?.archivedYearId) &&
          !(student.status === 'transferred' && input.kind === 'restore'))
      )
        throw ApiError.conflict('该生已毕业或已归档，请先在归档页撤销归档');
      if (!isNew) {
        const allowed: Record<StudentLifecycleKind, string[]> = {
          'class-change': ['active'],
          unassign: ['active'],
          'transfer-out': ['active', 'inactive'],
          'transfer-in': ['transferred', 'inactive'],
          restore: ['transferred', 'inactive'],
          deactivate: ['active'],
        };
        if (!allowed[input.kind].includes(student.status))
          throw ApiError.conflict('当前学生状态不允许此操作，请刷新名单并使用对应生命周期入口');
      }
      const from = isNew ? null : student.class;
      if (!isNew && input.kind === 'class-change' && student.classId === target?.id) continue;
      if (
        input.kind === 'class-change' &&
        from &&
        target &&
        from.grade !== target.grade &&
        !(user.role === 'ADMIN' && input.allowGradeChange && input.note?.trim())
      )
        throw ApiError.conflict('跨年级调班需要管理员勾选允许跨年级并填写备注');
      const keepClass = ['transfer-out', 'deactivate'].includes(input.kind);
      const nextClassId = keepClass ? student.classId : (target?.id ?? null);
      const nextStatus =
        input.kind === 'transfer-out'
          ? 'transferred'
          : input.kind === 'deactivate'
            ? 'inactive'
            : isNew
              ? student.status
              : 'active';
      await tx.student.update({
        where: { id: student.id },
        data: {
          classId: nextClassId,
          status: nextStatus,
          ...(input.kind === 'transfer-out'
            ? { transferredAt: new Date(), transferNote: input.note ?? '' }
            : {}),
          ...(['transfer-in', 'restore'].includes(input.kind)
            ? { transferredAt: null, archivedYearId: null, archivedAt: null }
            : {}),
        },
      });
      records.push(
        await tx.studentClassTransfer.create({
          data: {
            studentId: student.id,
            studentNo: student.studentNo,
            studentName: student.name,
            kind: input.kind,
            batchId,
            academicYear: currentAcademicYearStart(),
            fromClassId: from?.id ?? null,
            fromClassName: from?.name ?? '',
            fromGrade: from?.grade ?? '',
            toClassId: keepClass ? null : (target?.id ?? null),
            toClassName:
              input.kind === 'transfer-out'
                ? '转出本校'
                : input.kind === 'deactivate'
                  ? '停用'
                  : (target?.name ?? '未分班'),
            toGrade: keepClass ? '' : (target?.grade ?? ''),
            fromSchool: input.fromSchool ?? '',
            toSchool: input.toSchool ?? '',
            operatorId: user.sub,
            operatorName: user.name,
            note: input.note ?? '',
          },
        }),
      );
      changedClasses.push(from?.id ?? null, nextClassId);
    }
    return {
      batchId,
      count: records.length,
      transfers: records.map(toStudentTransferDto),
      studentId: students[0].id,
    };
  };
  const result = transaction ? await work(transaction) : await prisma.$transaction(work);
  if (!transaction) notifyStudentClasses(changedClasses);
  return result;
}
