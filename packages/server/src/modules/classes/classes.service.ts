import type { ClassDetailDto, ClassDto, StudentDto } from '@classhelper/shared';
import { env } from '../../config/env.js';
import {
  assertClassAccess,
  assertCanAssignTeachers,
  assertCanManageClasses,
  assertCanManageRoster,
  classScopeIdFilter,
  resolveClassScope,
} from '../../lib/access.js';
import {
  buildClassAccountCreateData,
  updateClassAccount as updateClassAccountRecord,
} from '../../lib/class-account.js';
import { prisma } from '../../lib/db.js';
import { ApiError } from '../../lib/http.js';
import type { TokenPayload } from '../../lib/jwt.js';
import { toClassDto, toCourseDto, toStudentDto, toTeacherBrief } from '../../lib/mappers.js';
import { hashPassword } from '../../lib/password.js';
import { emitToClass } from '../../realtime/bus.js';
import { SOCKET_EVENTS } from '@classhelper/shared';
import type { AddStudentInput, CreateClassInput, UpdateClassInput } from './classes.schemas.js';

const countSelect = {
  students: true,
  courses: true,
  homeworks: true,
  notifications: true,
} as const;

/**
 * 说明：班级码 code 与班级密码哈希 passwordHash 是 Class 的标量字段，
 * 使用 include 查询时会默认返回，无需（也不能）写进 include 里。
 * 是否把它们放进 DTO 由 canSeeClassAccount() 决定，哈希永不外泄。
 */

/**
 * 是否可以看到该班级的班级账号信息：
 * 管理员（管理全部班级）或该班级的班主任（要发给学生用，只读展示）。
 * 科任老师与学生都看不到班级码。
 */
function canSeeClassAccount(user: TokenPayload, item: { teacherId: string }): boolean {
  if (user.role === 'ADMIN') return true;
  return user.role === 'TEACHER' && item.teacherId === user.sub;
}

/** 把班级记录转换为 DTO，并按权限附带班级码 */
function toClassDtoWithAccount(
  user: TokenPayload,
  item: Parameters<typeof toClassDto>[0] & { code?: string; passwordHash?: string | null },
): ClassDto {
  const dto = toClassDto(item);
  if (!canSeeClassAccount(user, item)) return dto;
  return {
    ...dto,
    code: item.code,
    hasPassword: Boolean(item.passwordHash),
  };
}

/** 班级列表（按权限过滤） */
export async function listClasses(user: TokenPayload, keyword?: string): Promise<ClassDto[]> {
  const scope = await resolveClassScope(user);
  // Class 表按主键 id 过滤（classScopeWhere 针对的是带 classId 字段的子表）
  const where = {
    ...classScopeIdFilter(scope),
    ...(keyword ? { OR: [{ name: { contains: keyword } }, { grade: { contains: keyword } }] } : {}),
  };

  const classes = await prisma.class.findMany({
    where,
    include: {
      teacher: { select: { id: true, name: true, username: true } },
      _count: { select: countSelect },
    },
    orderBy: [{ grade: 'asc' }, { name: 'asc' }],
  });

  return classes.map((item) => toClassDtoWithAccount(user, item));
}

/** 班级详情：学生名单 + 课程 + 协作教师 */
export async function getClassDetail(user: TokenPayload, classId: string): Promise<ClassDetailDto> {
  await assertClassAccess(user, classId);

  const item = await prisma.class.findUnique({
    where: { id: classId },
    include: {
      teacher: { select: { id: true, name: true, username: true } },
      _count: { select: countSelect },
      students: { orderBy: { username: 'asc' } },
      courses: {
        orderBy: { name: 'asc' },
        include: { teacher: { select: { id: true, name: true, username: true } } },
      },
      teachers: {
        include: { teacher: { select: { id: true, name: true, username: true } } },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  if (!item) throw ApiError.notFound('班级不存在');

  return {
    ...toClassDtoWithAccount(user, item),
    students: item.students.map((student) => toStudentDto(student)),
    courses: item.courses.map(toCourseDto),
    teachers: item.teachers.map((assignment) => toTeacherBrief(assignment.teacher)),
  };
}

/** 创建班级 */
export async function createClass(user: TokenPayload, input: CreateClassInput): Promise<ClassDto> {
  assertCanManageClasses(user);
  let teacherId = user.sub;
  if (input.teacherId && user.role === 'ADMIN') {
    const teacher = await prisma.user.findUnique({ where: { id: input.teacherId } });
    if (!teacher || (teacher.role !== 'TEACHER' && teacher.role !== 'ADMIN')) {
      throw ApiError.badRequest('指定的班主任不存在或角色不是教师');
    }
    teacherId = teacher.id;
  }

  // 班级账号：自动生成班级码（也可由管理员指定）+ 默认班级密码
  const account = await buildClassAccountCreateData(env.defaultClassPassword, input.code);

  const created = await prisma.class.create({
    data: {
      name: input.name,
      grade: input.grade,
      teacherId,
      code: account.code,
      passwordHash: account.passwordHash,
    },
    include: {
      teacher: { select: { id: true, name: true, username: true } },
      _count: { select: countSelect },
    },
  });

  return toClassDtoWithAccount(user, created);
}

/**
 * 设置 / 重置班级账号（班级码 + 班级密码）：仅管理员。
 * 班级码即学生端"班级登录"的账号；密码留空表示不修改。
 */
export async function updateClassAccount(
  user: TokenPayload,
  classId: string,
  input: { code?: string; password?: string },
): Promise<ClassDto> {
  assertCanManageClasses(user);
  await updateClassAccountRecord(classId, input);

  const updated = await prisma.class.findUnique({
    where: { id: classId },
    include: {
      teacher: { select: { id: true, name: true, username: true } },
      _count: { select: countSelect },
    },
  });
  if (!updated) throw ApiError.notFound('班级不存在');
  return toClassDtoWithAccount(user, updated);
}

/** 编辑班级 */
export async function updateClass(
  user: TokenPayload,
  classId: string,
  input: UpdateClassInput,
): Promise<ClassDto> {
  assertCanManageClasses(user);

  const updated = await prisma.class.update({
    where: { id: classId },
    data: {
      ...(input.name ? { name: input.name } : {}),
      ...(input.grade ? { grade: input.grade } : {}),
      // 教学周数（班主任可调）：课表周次选择与默认 weekEnd 都用它
      ...(input.termWeeks !== undefined ? { termWeeks: input.termWeeks } : {}),
    },
    include: {
      teacher: { select: { id: true, name: true, username: true } },
      _count: { select: countSelect },
    },
  });

  emitToClass(classId, SOCKET_EVENTS.classUpdated, { classId, action: 'updated' });
  return toClassDto(updated);
}

/** 删除班级（级联删除课表/作业/通知/成绩） */
export async function deleteClass(user: TokenPayload, classId: string): Promise<void> {
  assertCanManageClasses(user);
  emitToClass(classId, SOCKET_EVENTS.classUpdated, { classId, action: 'deleted' });
  await prisma.class.delete({ where: { id: classId } });
}

/** 班级学生名单 */
export async function listClassStudents(user: TokenPayload, classId: string): Promise<StudentDto[]> {
  await assertClassAccess(user, classId);
  const students = await prisma.user.findMany({
    where: { classId, role: 'STUDENT' },
    include: { class: { select: { name: true, grade: true } } },
    orderBy: { username: 'asc' },
  });
  return students.map(toStudentDto);
}

/**
 * 添加学生到班级。
 * 已存在的学生账号直接转入本班（同时维护 Enrollment，保证"一个学生一个主班级"）。
 * 新账号使用 DEFAULT_STUDENT_PASSWORD 作为初始密码。
 */
export async function addStudent(
  user: TokenPayload,
  classId: string,
  input: AddStudentInput,
): Promise<StudentDto> {
  assertCanManageRoster(user);

  const existing = await prisma.user.findUnique({ where: { username: input.username } });
  let studentId: string;

  if (existing) {
    if (existing.role !== 'STUDENT') {
      throw ApiError.conflict(`用户名 ${input.username} 已被教师/管理员账号占用`);
    }
    studentId = existing.id;
    // 换班：清理其他班级的选课记录
    await prisma.enrollment.deleteMany({ where: { userId: existing.id, classId: { not: classId } } });
    await prisma.user.update({
      where: { id: existing.id },
      data: { classId, name: input.name },
    });
  } else {
    const created = await prisma.user.create({
      data: {
        username: input.username,
        name: input.name,
        role: 'STUDENT',
        classId,
        passwordHash: await hashPassword(input.password ?? env.defaultStudentPassword),
      },
    });
    studentId = created.id;
  }

  await prisma.enrollment.upsert({
    where: { userId_classId: { userId: studentId, classId } },
    create: { userId: studentId, classId },
    update: {},
  });

  const student = await prisma.user.findUniqueOrThrow({
    where: { id: studentId },
    include: { class: { select: { name: true, grade: true } } },
  });

  emitToClass(classId, SOCKET_EVENTS.classUpdated, { classId, action: 'updated' });
  return toStudentDto(student);
}

/** 将学生移出班级（保留账号） */
export async function removeStudent(user: TokenPayload, classId: string, studentId: string): Promise<void> {
  assertCanManageRoster(user);

  const student = await prisma.user.findUnique({ where: { id: studentId } });
  if (!student || student.role !== 'STUDENT') throw ApiError.notFound('学生不存在');
  if (student.classId !== classId) throw ApiError.badRequest('该学生不属于此班级');

  await prisma.$transaction([
    prisma.user.update({ where: { id: studentId }, data: { classId: null } }),
    prisma.enrollment.deleteMany({ where: { userId: studentId, classId } }),
  ]);

  emitToClass(classId, SOCKET_EVENTS.classUpdated, { classId, action: 'updated' });
}

/** 分配协作教师 */
export async function assignTeacher(user: TokenPayload, classId: string, teacherId: string): Promise<void> {
  assertCanAssignTeachers(user);

  const teacher = await prisma.user.findUnique({ where: { id: teacherId } });
  if (!teacher || (teacher.role !== 'TEACHER' && teacher.role !== 'ADMIN')) {
    throw ApiError.badRequest('目标账号不存在或角色不是教师');
  }

  await prisma.classTeacher.upsert({
    where: { classId_teacherId: { classId, teacherId } },
    create: { classId, teacherId },
    update: {},
  });
}

/** 取消协作教师（班主任不可被移除） */
export async function removeTeacher(user: TokenPayload, classId: string, teacherId: string): Promise<void> {
  assertCanAssignTeachers(user);

  const target = await prisma.class.findUnique({ where: { id: classId }, select: { teacherId: true } });
  if (target?.teacherId === teacherId) throw ApiError.badRequest('班主任不能被移除，请先转移班级');

  await prisma.classTeacher.deleteMany({ where: { classId, teacherId } });
}
