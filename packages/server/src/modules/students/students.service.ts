import type { StudentDto } from '@classhelper/shared';
import { assertCanManageRoster, classScopeWhere, isAdmin, resolveClassScope } from '../../lib/access.js';
import { prisma } from '../../lib/db.js';
import { ApiError } from '../../lib/http.js';
import type { TokenPayload } from '../../lib/jwt.js';
import { toStudentDto } from '../../lib/mappers.js';
import type { CreateStudentInput, UpdateStudentInput } from './students.schemas.js';

export interface ListStudentOptions {
  classId?: string;
  keyword?: string;
}

/** 学生名单（按班级权限过滤） */
export async function listStudents(user: TokenPayload, options: ListStudentOptions): Promise<StudentDto[]> {
  const scope = await resolveClassScope(user, options.classId);

  const students = await prisma.user.findMany({
    where: {
      role: 'STUDENT',
      ...classScopeWhere(scope),
      ...(options.keyword
        ? {
            OR: [{ name: { contains: options.keyword } }, { username: { contains: options.keyword } }],
          }
        : {}),
    },
    include: { class: { select: { name: true, grade: true } } },
    orderBy: [{ classId: 'asc' }, { username: 'asc' }],
    take: 500,
  });

  return students.map(toStudentDto);
}

/** 新建学生（名单实体，可选直接分班）。学生不设密码：登录一律走班级账号，见 createStudentSchema 的说明 */
export async function createStudent(user: TokenPayload, input: CreateStudentInput): Promise<StudentDto> {
  if (input.classId) assertCanManageRoster(user);

  const created = await prisma.user.create({
    data: {
      username: input.username,
      name: input.name,
      role: 'STUDENT',
      classId: input.classId ?? null,
      // User.passwordHash 是必填列，学生用空串占位（登录的 STUDENT 403 判定在密码校验之前，永远不会用到它）
      passwordHash: '',
    },
  });

  if (input.classId) {
    await prisma.enrollment.upsert({
      where: { userId_classId: { userId: created.id, classId: input.classId } },
      create: { userId: created.id, classId: input.classId },
      update: {},
    });
  }

  const student = await prisma.user.findUniqueOrThrow({
    where: { id: created.id },
    include: { class: { select: { name: true, grade: true } } },
  });
  return toStudentDto(student);
}

/** 修改学生信息 / 调班 */
export async function updateStudent(
  user: TokenPayload,
  studentId: string,
  input: UpdateStudentInput,
): Promise<StudentDto> {
  const student = await prisma.user.findUnique({ where: { id: studentId } });
  if (!student || student.role !== 'STUDENT') throw ApiError.notFound('学生不存在');

  if (student.classId) {
    assertCanManageRoster(user);
  } else if (!isAdmin(user)) {
    throw ApiError.forbidden('该学生尚未分班，仅管理员可以直接修改');
  }

  const nextClassId = input.classId === undefined ? student.classId : (input.classId ?? null);
  if (nextClassId && nextClassId !== student.classId) {
    assertCanManageRoster(user);
  }

  const updated = await prisma.user.update({
    where: { id: studentId },
    data: {
      ...(input.name ? { name: input.name } : {}),
      ...(input.username ? { username: input.username } : {}),
      classId: nextClassId,
    },
  });

  // 同步 Enrollment：换班时清理旧记录
  if (nextClassId) {
    await prisma.enrollment.deleteMany({ where: { userId: studentId, classId: { not: nextClassId } } });
    await prisma.enrollment.upsert({
      where: { userId_classId: { userId: studentId, classId: nextClassId } },
      create: { userId: studentId, classId: nextClassId },
      update: {},
    });
  } else {
    await prisma.enrollment.deleteMany({ where: { userId: studentId } });
  }

  const result = await prisma.user.findUniqueOrThrow({
    where: { id: updated.id },
    include: { class: { select: { name: true, grade: true } } },
  });
  return toStudentDto(result);
}

/** 删除学生账号（级联删除其作业状态、成绩、已读记录） */
export async function deleteStudent(user: TokenPayload, studentId: string): Promise<void> {
  const student = await prisma.user.findUnique({ where: { id: studentId } });
  if (!student || student.role !== 'STUDENT') throw ApiError.notFound('学生不存在');

  if (student.classId) {
    assertCanManageRoster(user);
  } else if (!isAdmin(user)) {
    throw ApiError.forbidden('该学生尚未分班，仅管理员可以删除');
  }

  await prisma.user.delete({ where: { id: studentId } });
}
