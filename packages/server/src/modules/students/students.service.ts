import type { PaginatedResult, StudentDto, StudentTransferDto } from '@classhelper/shared';
import { normalizeStudentNo } from '@classhelper/shared';
import {
  assertCanManageRoster,
  classScopeWhere,
  isAdmin,
  resolveClassScope,
} from '../../lib/access.js';
import { prisma } from '../../lib/db.js';
import { ApiError } from '../../lib/http.js';
import type { TokenPayload } from '../../lib/jwt.js';
import { toStudentDto, toStudentTransferDto } from '../../lib/mappers.js';
import { SOCKET_EVENTS } from '@classhelper/shared';
import { emitToClass } from '../../realtime/bus.js';
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
export async function listStudents(
  user: TokenPayload,
  options: ListStudentsQuery,
): Promise<StudentDto[]> {
  const scope = await resolveClassScope(user, options.classId);

  const students = await prisma.student.findMany({
    where: {
      ...classScopeWhere(scope),
      ...(options.status ? { status: options.status } : {}),
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
    where: { studentNo: normalizeStudentNo(studentNo), ...(classId ? { classId } : {}) },
    include: withClass,
  });
  return record ? toStudentDto(record) : null;
}

/** 新建学生（名单记录，可选直接分班）。学生不设密码、没有账号属性 */
export async function createStudent(user: TokenPayload, input: CreateStudentInput): Promise<StudentDto> {
  await assertCanManageRoster(user, input.classId ?? undefined);
  await assertStudentNoFree(input.studentNo);
  if (input.classId) await assertClassExists(input.classId);

  const created = await prisma.student.create({
    data: {
      studentNo: input.studentNo,
      name: input.name,
      classId: input.classId ?? null,
      gender: input.gender ?? '',
      guardianPhone: input.guardianPhone ?? '',
      status: input.status ?? 'active',
    },
    include: withClass,
  });

  if (created.classId) {
    emitToClass(created.classId, SOCKET_EVENTS.classUpdated, {
      classId: created.classId,
      action: 'updated',
    });
  }
  return toStudentDto(created);
}

/** 修改学生信息（含调班；走本接口的单个调班同样会记入调班历史） */
export async function updateStudent(
  user: TokenPayload,
  studentId: string,
  input: UpdateStudentInput,
): Promise<StudentDto> {
  const student = await prisma.student.findUnique({ where: { id: studentId } });
  if (!student) throw ApiError.notFound('学生不存在');

  await assertCanManageRoster(user, student.classId ?? undefined);
  if (input.studentNo && input.studentNo !== student.studentNo) {
    await assertStudentNoFree(input.studentNo, studentId);
  }

  const nextClassId = input.classId === undefined ? student.classId : (input.classId ?? null);
  const classChanged = nextClassId !== student.classId;
  if (classChanged) await assertCanManageRoster(user, nextClassId ?? undefined);

  const updated = await prisma.student.update({
    where: { id: studentId },
    data: {
      ...(input.studentNo ? { studentNo: input.studentNo } : {}),
      ...(input.name ? { name: input.name } : {}),
      ...(input.gender !== undefined ? { gender: input.gender } : {}),
      ...(input.guardianPhone !== undefined ? { guardianPhone: input.guardianPhone } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      classId: nextClassId,
    },
    include: withClass,
  });

  // 换班要留痕（单个调班与批量调班都写同一种历史）
  if (classChanged) {
    await recordTransfer(user, [updated], student.classId, nextClassId, 'single', '');
  }

  return toStudentDto(updated);
}

/** 删除学生记录（级联删除其作业状态、成绩、已读记录与调班历史） */
export async function deleteStudent(user: TokenPayload, studentId: string): Promise<void> {
  const student = await prisma.student.findUnique({ where: { id: studentId } });
  if (!student) throw ApiError.notFound('学生不存在');
  await assertCanManageRoster(user, student.classId ?? undefined);

  await prisma.student.delete({ where: { id: studentId } });
}

/* ---------------------------------------------------------------- 调班 / 转出 */

/**
 * 调班：单个与批量共用（传一个 id 就是单个）。
 *
 * 规则（需求「管理员调班」）：
 * - 只改学生**当前班级**，学号不变、不创建任何账号；
 * - 原班级、新班级、操作人、时间写入 `StudentClassTransfer`，历史可查；
 * - 历史作业与成绩保留原归属（它们挂在各自的 `classId` 上，不随学生走）。
 */
export async function transferStudents(
  user: TokenPayload,
  input: TransferStudentsInput,
): Promise<{ moved: number; transfers: StudentTransferDto[] }> {
  if (!isAdmin(user)) throw ApiError.forbidden('只有管理员可以调班');

  const students = await prisma.student.findMany({ where: { id: { in: input.studentIds } } });
  if (students.length !== input.studentIds.length) {
    throw ApiError.badRequest('部分学生不存在，请刷新后重试');
  }
  if (input.toClassId) await assertClassExists(input.toClassId);

  const movable = students.filter((item) => item.classId !== input.toClassId);
  if (movable.length === 0) {
    throw ApiError.badRequest('所选学生已经全部在这个班级里');
  }

  await prisma.$transaction(
    movable.map((item) =>
      prisma.student.update({ where: { id: item.id }, data: { classId: input.toClassId } }),
    ),
  );

  const mode = movable.length > 1 ? 'batch' : 'single';
  // 注意传的是**调班前**的 movable（classId 还是原班级）：历史里的"原班级"要按每条自己的来
  const transfers = await recordTransfer(user, movable, null, input.toClassId, mode, input.note ?? '');

  notifyClassChange(movable.map((item) => item.classId), input.toClassId);
  return { moved: movable.length, transfers };
}

/**
 * 学生转出：学籍离开本校（**不是调班**）。
 *
 * 班级归属保留作历史（成绩/作业/已读都还在），状态置为 `transferred`，
 * 并写一条 `mode = 'transfer-out'` 的历史，归档页据此统计"当年转出的学生"。
 */
export async function transferOutStudents(
  user: TokenPayload,
  input: TransferOutStudentsInput,
): Promise<{ transferred: number; transfers: StudentTransferDto[] }> {
  if (!isAdmin(user)) throw ApiError.forbidden('只有管理员可以办理学生转出');

  const students = await prisma.student.findMany({ where: { id: { in: input.studentIds } } });
  if (students.length !== input.studentIds.length) {
    throw ApiError.badRequest('部分学生不存在，请刷新后重试');
  }
  const pending = students.filter((item) => item.status !== 'transferred');
  if (pending.length === 0) throw ApiError.badRequest('所选学生都已经转出');

  const now = new Date();
  await prisma.$transaction(
    pending.map((item) =>
      prisma.student.update({
        where: { id: item.id },
        data: { status: 'transferred', transferredAt: now, transferNote: input.note ?? '' },
      }),
    ),
  );

  // 班级名快照：转出时把学生"离开的那个班"记下来，之后班级改名也不影响历史
  const classNames = await loadClassNames(pending.map((item) => item.classId));
  await prisma.studentClassTransfer.createMany({
    data: pending.map((item) => ({
      studentId: item.id,
      studentNo: item.studentNo,
      studentName: item.name,
      fromClassId: item.classId,
      fromClassName: item.classId ? (classNames.get(item.classId) ?? '') : '',
      toClassId: null,
      toClassName: '转出本校',
      operatorId: user.sub,
      operatorName: user.name,
      mode: 'transfer-out',
      note: input.note ?? '',
    })),
  });

  notifyClassChange(pending.map((item) => item.classId), null);

  const created = await prisma.studentClassTransfer.findMany({
    where: { studentId: { in: pending.map((item) => item.id) }, mode: 'transfer-out' },
    orderBy: { createdAt: 'desc' },
    take: pending.length,
  });
  return { transferred: pending.length, transfers: created.map(toStudentTransferDto) };
}

/** 调班 / 转出历史（单个学生或某个班级，管理员看全部） */
export async function listTransfers(
  user: TokenPayload,
  options: ListTransfersQuery,
): Promise<PaginatedResult<StudentTransferDto>> {
  if (!isAdmin(user) && !options.classId && !options.studentId) {
    throw ApiError.forbidden('查看全部调班历史需要管理员权限');
  }

  const where = {
    ...(options.studentId ? { studentId: options.studentId } : {}),
    ...(options.classId
      ? { OR: [{ fromClassId: options.classId }, { toClassId: options.classId }] }
      : {}),
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

/* ---------------------------------------------------------------- 内部工具 */

/**
 * 写入调班历史。
 *
 * - `fromOverride` 非空时，所有条目都用它作为"原班级"（单个调班场景）；
 * - 为空时逐条取**该学生自己的 classId** 作为"原班级"（批量调班场景，
 *   各人的来源班可能不同）。
 */
async function recordTransfer(
  user: TokenPayload,
  students: { id: string; studentNo: string; name: string; classId: string | null }[],
  fromOverride: string | null,
  toClassId: string | null,
  mode: 'single' | 'batch',
  note: string,
): Promise<StudentTransferDto[]> {
  const fromIds = students.map((item) => fromOverride ?? item.classId);
  const classNames = await loadClassNames([...fromIds, toClassId]);

  await prisma.studentClassTransfer.createMany({
    data: students.map((item, index) => {
      const fromClassId = fromIds[index] ?? null;
      return {
        studentId: item.id,
        studentNo: item.studentNo,
        studentName: item.name,
        fromClassId,
        fromClassName: fromClassId ? (classNames.get(fromClassId) ?? '') : '',
        toClassId,
        toClassName: toClassId ? (classNames.get(toClassId) ?? '') : '未分班',
        operatorId: user.sub,
        operatorName: user.name,
        mode,
        note,
      };
    }),
  });

  const created = await prisma.studentClassTransfer.findMany({
    where: { studentId: { in: students.map((item) => item.id) } },
    orderBy: { createdAt: 'desc' },
    take: students.length,
  });
  return created.map(toStudentTransferDto);
}

async function loadClassNames(classIds: (string | null)[]): Promise<Map<string, string>> {
  const ids = [...new Set(classIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return new Map();
  const classes = await prisma.class.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  return new Map(classes.map((item) => [item.id, item.name]));
}

/** 调班后让相关班级的前端刷新名单（旧班与新班都要收到） */
function notifyClassChange(fromClassIds: (string | null)[], toClassId: string | null): void {
  const targets = new Set([...fromClassIds, toClassId].filter((id): id is string => Boolean(id)));
  for (const classId of targets) {
    emitToClass(classId, SOCKET_EVENTS.classUpdated, { classId, action: 'updated' });
  }
}

async function assertClassExists(classId: string): Promise<void> {
  const record = await prisma.class.findUnique({ where: { id: classId }, select: { id: true } });
  if (!record) throw ApiError.badRequest('班级不存在');
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
