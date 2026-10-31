import type { PaginatedResult, StudentDto, StudentTransferDto } from '@classhelper/shared';
import { normalizeStudentNo } from '@classhelper/shared';
import {
  assertCanManageRoster,
  assertClassAccess,
  classScopeWhere,
  isAdmin,
  getAccessibleClassIds,
  resolveClassScope,
} from '../../lib/access.js';
import { assertPermissionOrClassDevice, assertPermission } from '../../lib/permissions.js';
import { changeStudentLifecycle, notifyStudentClasses } from '../../lib/student-lifecycle.js';
import { activeStudentWhere } from '../../lib/students.js';
import { prisma } from '../../lib/db.js';
import { hasOrganizationalGrant } from '../../lib/authz/index.js';
import { ApiError } from '../../lib/http.js';
import type { TokenPayload } from '../../lib/jwt.js';
import { toStudentDto, toStudentTransferDto } from '../../lib/mappers.js';
import type {
  CreateStudentInput,
  ListStudentsQuery,
  ListTransfersQuery,
  TransferOutStudentsInput,
  TransferStudentsInput,
  UpdateStudentInput,
} from './students.schemas.js';

/**
 * 学生是**班级名单里的记录**，不是账号：
 * 没有密码、不能登录、没有个人入口。`studentNo`（学号）是唯一标识与查询键。
 *
 * 本模块负责名单的增删改与**调班 / 转出**；学生的个人数据（作业完成、通知已读、成绩）
 * 挂在 `studentId` 上，因此调班只改 `Student.classId` ——
 * 历史作业与成绩保留原归属，后续数据按新班级生成。
 */

const withClass = { class: { select: { name: true, grade: true } } } as const;

/** 学生名单（按班级权限过滤） */
export async function listStudents(user: TokenPayload, options: ListStudentsQuery): Promise<StudentDto[]> {
  await assertPermissionOrClassDevice(user, 'roster:read');
  const scope = await resolveClassScope(user, options.classId, 'roster:read');

  const students = await prisma.student.findMany({
    where: {
      ...classScopeWhere(scope),
      status: options.status ?? 'active',
      // 默认不显示已归档（毕业 / 转出）的学生：他们属于归档页，不该混在在读名单里
      ...(options.includeArchived ? {} : { archivedYearId: null }),
      ...(options.keyword
        ? { OR: [{ name: { contains: options.keyword } }, { studentNo: { contains: options.keyword } }] }
        : {}),
    },
    include: withClass,
    orderBy: [{ classId: 'asc' }, { studentNo: 'asc' }],
    take: 1000,
  });

  return students.map(toStudentDto);
}

/** 按学号取学生（学生没账号，因此没有"按 id 取自己"的入口） */
export async function findStudentByNo(studentNo: string, classId?: string): Promise<StudentDto | null> {
  const record = await prisma.student.findFirst({
    where: {
      ...activeStudentWhere(),
      studentNo: normalizeStudentNo(studentNo),
      ...(classId ? { classId } : {}),
    },
    include: withClass,
  });
  return record ? toStudentDto(record) : null;
}

/** 新建学生（名单记录，可选直接分班）。学生不设密码、没有账号属性 */
export async function createStudent(user: TokenPayload, input: CreateStudentInput): Promise<StudentDto> {
  await assertCanManageRoster(user, input.classId ?? undefined);
  await assertStudentNoFree(input.studentNo);

  const result = await changeStudentLifecycle(user, {
    studentIds: [],
    kind: 'class-change',
    toClassId: input.classId,
    newStudent: {
      studentNo: input.studentNo,
      name: input.name,
      gender: input.gender,
      guardianPhone: input.guardianPhone,
      status: input.status,
    },
  });
  const created = await prisma.student.findUniqueOrThrow({
    where: { id: result.studentId },
    include: withClass,
  });
  return toStudentDto(created);
}

/** 资料修改不承担状态或班级迁移；旧请求明确报错。 */
export async function updateStudent(
  user: TokenPayload,
  studentId: string,
  input: UpdateStudentInput,
): Promise<StudentDto> {
  if ('classId' in input || 'status' in input)
    throw ApiError.badRequest('班级和状态请使用调班、转出或复学接口修改');
  const student = await prisma.student.findUnique({ where: { id: studentId } });
  if (!student) throw ApiError.notFound('学生不存在');
  if (student.archivedYearId || !['active', 'inactive'].includes(student.status))
    throw ApiError.conflict('历史学生资料只读，请先办理转入或撤销归档');
  await assertCanManageRoster(user, student.classId ?? undefined);
  if (input.studentNo) await assertStudentNoFree(input.studentNo, studentId);
  const updated = await prisma.student.update({ where: { id: studentId }, data: input, include: withClass });
  notifyStudentClasses([student.classId]);
  return toStudentDto(updated);
}

/** 默认停用且保留业务；硬删除须管理员确认并证明没有任何历史。 */
export async function deleteStudent(
  user: TokenPayload,
  studentId: string,
  options: { hard?: boolean; confirm?: boolean } = {},
): Promise<void> {
  const student = await prisma.student.findUnique({ where: { id: studentId } });
  if (!student) throw ApiError.notFound('学生不存在');
  await assertCanManageRoster(user, student.classId ?? undefined);
  if (!options.hard) {
    await changeStudentLifecycle(user, {
      studentIds: [studentId],
      kind: 'deactivate',
      note: '名单停用，保留全部业务历史',
    });
    return;
  }
  if (!isAdmin(user) || !options.confirm) throw ApiError.forbidden('硬删除需要管理员二次确认');
  await prisma.$transaction(async (tx) => {
    const current = await tx.student.findUniqueOrThrow({
      where: { id: studentId },
      include: {
        _count: {
          select: { grades: true, homeworkStatuses: true, notificationReads: true, transfers: true },
        },
      },
    });
    if (
      current.archivedYearId ||
      !['active', 'inactive'].includes(current.status) ||
      Object.values(current._count).some(Boolean)
    )
      throw ApiError.conflict('该生有成绩、作业、已读或生命周期历史，不能硬删除；请停用保留记录');
    await tx.student.delete({ where: { id: studentId } });
  });
  notifyStudentClasses([student.classId]);
}

export async function transferStudents(user: TokenPayload, input: TransferStudentsInput) {
  const result = await changeStudentLifecycle(user, {
    ...input,
    kind: input.toClassId ? 'class-change' : 'unassign',
  });
  return { ...result, moved: result.count };
}
export async function transferOutStudents(user: TokenPayload, input: TransferOutStudentsInput) {
  const result = await changeStudentLifecycle(user, { ...input, kind: 'transfer-out' });
  return { ...result, transferred: result.count };
}
export async function transferInStudent(
  user: TokenPayload,
  input: {
    studentId?: string;
    studentNo?: string;
    name?: string;
    toClassId: string;
    gender?: string;
    guardianPhone?: string;
    fromSchool?: string;
    note?: string;
  },
) {
  if (!input.studentId && (!input.studentNo || !input.name))
    throw ApiError.badRequest('新转入学生必须填写学号与姓名');
  const result = await changeStudentLifecycle(user, {
    ...input,
    kind: 'transfer-in',
    studentIds: input.studentId ? [input.studentId] : [],
    ...(!input.studentId
      ? {
          newStudent: {
            studentNo: input.studentNo!,
            name: input.name!,
            gender: input.gender,
            guardianPhone: input.guardianPhone,
          },
        }
      : {}),
  });
  return toStudentDto(
    await prisma.student.findUniqueOrThrow({ where: { id: result.studentId }, include: withClass }),
  );
}
export async function restoreStudent(
  user: TokenPayload,
  id: string,
  input: { toClassId?: string; note?: string } = {},
) {
  const student = await prisma.student.findUnique({ where: { id } });
  if (!student) throw ApiError.notFound('学生不存在');
  return changeStudentLifecycle(user, {
    studentIds: [id],
    kind: 'restore',
    toClassId: input.toClassId ?? student.classId,
    note: input.note ?? '撤回转出或复学，保留原历史',
  });
}

/** 调班 / 转出历史（单个学生或某个班级，管理员看全部） */
export async function listTransfers(
  user: TokenPayload,
  options: ListTransfersQuery,
): Promise<PaginatedResult<StudentTransferDto>> {
  await assertPermission(user, 'roster:read');
  const hasGlobalRosterScope = isAdmin(user) || (await hasOrganizationalGrant(user, 'roster:read'));

  if (options.classId) await assertClassAccess(user, options.classId, 'roster:read');
  if (options.studentId) {
    const student = await prisma.student.findUnique({
      where: { id: options.studentId },
      select: { classId: true },
    });
    if (!student) throw ApiError.notFound('学生不存在');
    if (student.classId) await assertClassAccess(user, student.classId, 'roster:read');
    else if (!hasGlobalRosterScope) throw ApiError.forbidden('无权查看未分班学生的调班历史');
  }

  const accessible = hasGlobalRosterScope ? null : await getAccessibleClassIds(user, 'roster:read');
  const where = {
    ...(options.batchId ? { batchId: options.batchId } : {}),
    ...(options.academicYear ? { academicYear: options.academicYear } : {}),
    ...(accessible
      ? { AND: [{ OR: [{ fromClassId: { in: accessible } }, { toClassId: { in: accessible } }] }] }
      : {}),
    ...(options.studentId ? { studentId: options.studentId } : {}),
    ...(options.classId ? { OR: [{ fromClassId: options.classId }, { toClassId: options.classId }] } : {}),
  };

  const page = options.page ?? 1;
  const pageSize = options.pageSize ?? 50;
  const [items, total] = await Promise.all([
    prisma.studentClassTransfer.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.studentClassTransfer.count({ where }),
  ]);

  return { items: items.map(toStudentTransferDto), total, page, pageSize };
}

/** 学号唯一：`Student.studentNo` 上已有唯一约束，这里给出一句人话的 409 */
async function assertStudentNoFree(studentNo: string, exceptId?: string): Promise<void> {
  const existing = await prisma.student.findUnique({
    where: { studentNo },
    select: { id: true, name: true, classId: true },
  });
  if (existing && existing.id !== exceptId) {
    throw ApiError.conflict(`学号 ${studentNo} 已被学生「${existing.name}」占用`);
  }
}
