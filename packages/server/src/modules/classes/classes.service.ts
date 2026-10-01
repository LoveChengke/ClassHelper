import type {
  ClassDetailDto,
  ClassDto,
  ClassIslandNotificationChannel,
  StudentDto,
} from '@classhelper/shared';
import { env } from '../../config/env.js';
import {
  assertClassAccess,
  assertCanAssignTeachers,
  assertCanManageClasses,
  assertCanManageRoster,
  classScopeIdFilter,
  isStaff,
  resolveClassScope,
} from '../../lib/access.js';
import {
  buildClassAccountCreateData,
  updateClassAccount as updateClassAccountRecord,
} from '../../lib/class-account.js';
import { prisma } from '../../lib/db.js';
import { ApiError } from '../../lib/http.js';
import type { TokenPayload } from '../../lib/jwt.js';
import {
  toClassDto,
  toCourseDto,
  toNotificationChannel,
  toStudentDto,
  toTeacherBrief,
} from '../../lib/mappers.js';
import { emitToClass } from '../../realtime/bus.js';
import { SOCKET_EVENTS } from '@classhelper/shared';
import type {
  AddStudentInput,
  CreateClassInput,
  UpdateClassInput,
  UpdateNotificationChannelInput,
} from './classes.schemas.js';
import { attachIntegrationFlag } from '../integrations/integrations.service.js';
import { logger } from '../../lib/logger.js';
import { isClassSession } from '../../lib/session.js';

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

  // 附上「是否已接入 ClassIsland」徽标：Web 端班级列表/课表页据此提示
  return attachIntegrationFlag(classes.map((item) => toClassDtoWithAccount(user, item)));
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
      // 新建时就能指定学期周数（之前只有编辑接口支持，Web 端表单里填了也会被丢弃）
      ...(input.termWeeks !== undefined ? { termWeeks: input.termWeeks } : {}),
    },
    include: {
      teacher: { select: { id: true, name: true, username: true } },
      _count: { select: countSelect },
    },
  });

  return toClassDtoWithAccount(user, created);
}

/**
 * 设置 / 更改班主任（仅管理员）。
 *
 * 班主任决定了"谁能管这个班的课表与成绩"，所以更换时要保证目标账号确实是教师/管理员；
 * 原班主任保留在协作教师名单里（`ClassTeacher`）不变，避免换人后丢掉历史协作关系。
 */
export async function updateHeadTeacher(
  user: TokenPayload,
  classId: string,
  teacherId: string,
): Promise<ClassDto> {
  assertCanAssignTeachers(user);

  const target = await prisma.user.findUnique({ where: { id: teacherId } });
  if (!target || (target.role !== 'TEACHER' && target.role !== 'ADMIN')) {
    throw ApiError.badRequest('指定的班主任不存在或角色不是教师');
  }

  const updated = await prisma.class.update({
    where: { id: classId },
    data: { teacherId: target.id },
    include: {
      teacher: { select: { id: true, name: true, username: true } },
      _count: { select: countSelect },
    },
  });

  emitToClass(classId, SOCKET_EVENTS.classUpdated, { classId, action: 'head-teacher-changed' });
  return toClassDtoWithAccount(user, updated);
}

/** 设置 / 重置班级账号（班级码 + 班级密码）：仅管理员。
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
      // 教学周数（仅管理员可调，见 assertCanManageClasses）：课表周次选择与默认 weekEnd 都用它
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
 * 添加学生到班级（名单实体）。
 * 已存在的学生直接转入本班（同时维护 Enrollment，保证"一个学生一个主班级"）。
 * 学生没有账号属性：不设密码、不能登录，学生端统一用班级码 + 班级密码。
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
        // 空串占位：User.passwordHash 必填，但学生的 403 登录判定在密码校验之前，永远用不到
        passwordHash: '',
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

/* ---------------------------------------------------------------- ClassIsland 联动状态 */

/**
 * 本班的 ClassIsland 联动状态（教室客户端的「ClassIsland 联动」面板展示）。
 *
 * 为什么单独开一个接口：设备列表（/integrations/devices）是管理面，只对教师/管理员开放；
 * 而教室机器（班级账号）需要知道"本班接没接 ClassIsland、最后什么时候上报的"，
 * 才能给出准确的提示（例如没接就别选"只在 ClassIsland 上弹"）。
 */
export async function getClassIslandStatus(
  user: TokenPayload,
  classId: string,
): Promise<{
  connected: boolean;
  deviceName: string | null;
  deviceCount: number;
  lastSeenAt: string | null;
  pluginVersion: string | null;
  classIslandVersion: string | null;
}> {
  await assertClassAccess(user, classId);
  const devices = await prisma.integrationDevice.findMany({
    where: { classId, enabled: true, mode: 'plugin' },
    select: { name: true, lastSeenAt: true, pluginVersion: true, classIslandVersion: true },
    orderBy: { lastSeenAt: 'desc' },
  });

  const latest = devices[0];
  return {
    connected: devices.length > 0,
    deviceName: latest?.name ?? null,
    deviceCount: devices.length,
    lastSeenAt: latest?.lastSeenAt ? latest.lastSeenAt.toISOString() : null,
    pluginVersion: latest?.pluginVersion ?? null,
    classIslandVersion: latest?.classIslandVersion ?? null,
  };
}

/* ---------------------------------------------------------------- 通知显示位置 */

/**
 * 读取班级的通知显示位置（both / client / classisland）。
 *
 * 这是**教室客户端**要读的值：客户端登录后拉一次，把自己的弹窗行为对齐到同一个选择。
 * 学生也能读自己班的（只读），便于排查"为什么教室没弹"。
 */
export async function getNotificationChannel(
  user: TokenPayload,
  classId: string,
): Promise<{ notificationChannel: ClassIslandNotificationChannel }> {
  await assertClassAccess(user, classId);
  const record = await prisma.class.findUnique({
    where: { id: classId },
    select: { notificationChannel: true },
  });
  return { notificationChannel: toNotificationChannel(record?.notificationChannel) };
}

/**
 * 设置班级的通知显示位置。
 *
 * 允许两类人改：**该班的班级账号**（教室机器的客户端 —— 需求就是"由客户端自己选"）
 * 与教师 / 管理员（Web 端也能改，便于老师统一要求）。
 * 普通学生账号不允许：否则"教室里到底弹哪个端"会变成任意学生都能改的开关。
 */
export async function updateNotificationChannel(
  user: TokenPayload,
  classId: string,
  input: UpdateNotificationChannelInput,
): Promise<{ notificationChannel: ClassIslandNotificationChannel }> {
  await assertClassAccess(user, classId);
  if (!isClassSession(user) && !isStaff(user)) {
    throw ApiError.forbidden('只有班级账号或教师/管理员可以修改通知显示位置');
  }

  const channel = toNotificationChannel(input.notificationChannel);
  await prisma.class.update({ where: { id: classId }, data: { notificationChannel: channel } });
  // 广播出去：其他端（Web 列表 / 同班客户端）能立刻看到这个选择变了
  emitToClass(classId, SOCKET_EVENTS.classUpdated, { classId, action: 'updated' });
  logger.info(`班级通知显示位置已更新：classId=${classId} channel=${channel} by=${user.sub}`);
  return { notificationChannel: channel };
}
