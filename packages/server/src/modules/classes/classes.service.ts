import type { ClassDetailDto, ClassDto, StudentDto } from '@classhelper/shared';
import { env } from '../../config/env.js';
import {
  assertClassAccess,
  assertClassWritable,
  classScopeIdFilter,
  resolveClassScope,
} from '../../lib/access.js';
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

  return classes.map(toClassDto);
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
    ...toClassDto(item),
    students: item.students.map((student) => toStudentDto(student)),
    courses: item.courses.map(toCourseDto),
    teachers: item.teachers.map((assignment) => toTeacherBrief(assignment.teacher)),
  };
}

/** 创建班级 */
export async function createClass(user: TokenPayload, input: CreateClassInput): Promise<ClassDto> {
  let teacherId = user.sub;
  if (input.teacherId && user.role === 'ADMIN') {
    const teacher = await prisma.user.findUnique({ where: { id: input.teacherId } });
    if (!teacher || (teacher.role !== 'TEACHER' && teacher.role !== 'ADMIN')) {
      throw ApiError.badRequest('指定的班主任不存在或角色不是教师');
    }
    teacherId = teacher.id;
  }

  const created = await prisma.class.create({
    data: { name: input.name, grade: input.grade, teacherId },
    include: {
      teacher: { select: { id: true, name: true, username: true } },
      _count: { select: countSelect },
    },
  });

  return toClassDto(created);
}

/** 编辑班级 */
export async function updateClass(
  user: TokenPayload,
  classId: string,
  input: UpdateClassInput,
): Promise<ClassDto> {
  await assertClassWritable(user, classId);

  const updated = await prisma.class.update({
    where: { id: classId },
    data: { ...(input.name ? { name: input.name } : {}), ...(input.grade ? { grade: input.grade } : {}) },
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
  await assertClassWritable(user, classId);
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
  await assertClassWritable(user, classId);

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
  await assertClassWritable(user, classId);

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
  await assertClassWritable(user, classId);

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
  await assertClassWritable(user, classId);

  const target = await prisma.class.findUnique({ where: { id: classId }, select: { teacherId: true } });
  if (target?.teacherId === teacherId) throw ApiError.badRequest('班主任不能被移除，请先转移班级');

  await prisma.classTeacher.deleteMany({ where: { classId, teacherId } });
}
