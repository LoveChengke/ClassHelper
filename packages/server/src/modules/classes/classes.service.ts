import type {
  ClassDetailDto,
  ClassDto,
  ClassIslandNotificationChannel,
  StudentDto,
  SubjectTeacherDto,
} from '@classhelper/shared';
import { SOCKET_EVENTS, formatClassName } from '@classhelper/shared';
import { env } from '../../config/env.js';
import {
  assertCanAssignTeachers,
  assertCanManageClasses,
  assertCanManageRoster,
  assertClassAccess,
  classScopeIdFilter,
  isClassDevice,
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
import type {
  AddStudentInput,
  AssignSubjectTeachersInput,
  CreateClassInput,
  UpdateClassInput,
  UpdateNotificationChannelInput,
  UpdateStudentGradeQueryInput,
} from './classes.schemas.js';
import { attachIntegrationFlag } from '../integrations/integrations.service.js';
import { logger } from '../../lib/logger.js';

const countSelect = {
  students: true,
  courses: true,
  homeworks: true,
  notifications: true,
} as const;

const teacherBriefSelect = { select: { id: true, name: true, username: true } } as const;

/**
 * 说明：班级码 code 与班级密码哈希 passwordHash 是 Class 的标量字段，
 * 使用 include 查询时会默认返回，无需（也不能）写进 include 里。
 * 是否把它们放进 DTO 由 canSeeClassAccount() 决定，哈希永不外泄。
 */

/**
 * 是否可以看到该班级的班级账号信息：
 * 管理员（管理全部班级）或该班级的班主任（要发给学生用，只读展示）。
 * 科任老师与 ClassHelper 班级端都看不到别人班的班级码。
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

/**
 * 班级列表（按权限过滤）。
 *
 * **默认只列在读班级**（`archivedYearId IS NULL`）：毕业归档的班级属于「归档管理」页，
 * 混在常规列表里会让老师误以为那届还在上课。需要看归档班级请用 `/api/archives`。
 */
export async function listClasses(user: TokenPayload, keyword?: string): Promise<ClassDto[]> {
  const scope = await resolveClassScope(user);
  // Class 表按主键 id 过滤（classScopeWhere 针对的是带 classId 字段的子表）
  const where = {
    ...classScopeIdFilter(scope),
    archivedYearId: null,
    ...(keyword ? { OR: [{ name: { contains: keyword } }, { grade: { contains: keyword } }] } : {}),
  };

  const classes = await prisma.class.findMany({
    where,
    include: {
      teacher: teacherBriefSelect,
      _count: { select: countSelect },
    },
    orderBy: [{ enrollmentYear: 'desc' }, { classIndex: 'asc' }, { grade: 'asc' }],
  });

  // 附上「是否已接入 ClassIsland」徽标：Web 端班级列表/课表页据此提示
  return attachIntegrationFlag(classes.map((item) => toClassDtoWithAccount(user, item)));
}

/** 班级详情：学生名单 + 课程 + 班主任 + 各科任课老师 */
export async function getClassDetail(user: TokenPayload, classId: string): Promise<ClassDetailDto> {
  await assertClassAccess(user, classId);

  const item = await prisma.class.findUnique({
    where: { id: classId },
    include: {
      teacher: teacherBriefSelect,
      _count: { select: countSelect },
      students: { orderBy: { studentNo: 'asc' } },
      courses: {
        orderBy: { name: 'asc' },
        include: { teacher: teacherBriefSelect },
      },
    },
  });
  if (!item) throw ApiError.notFound('班级不存在');

  const base = toClassDtoWithAccount(user, item);
  return {
    ...base,
    students: item.students.map(toStudentDto),
    courses: item.courses.map(toCourseDto),
    headTeacher: item.teacher ? toTeacherBrief(item.teacher) : null,
    subjectTeachers: item.courses.map((course) => ({
      courseId: course.id,
      subjectName: course.name,
      teacherId: course.teacherId,
      teacherName: course.teacher?.name ?? '',
    })),
  };
}

/**
 * 班级的任课老师表（班级 + 科目 + 教师）。
 * 与 `getClassDetail` 分开，是因为「ClassHelper 在线状态」等页面只需要这一小块。
 */
export async function listSubjectTeachers(
  user: TokenPayload,
  classId: string,
): Promise<{ headTeacher: SubjectTeacherDto | null; subjectTeachers: SubjectTeacherDto[] }> {
  await assertClassAccess(user, classId);
  const item = await prisma.class.findUnique({
    where: { id: classId },
    include: {
      teacher: teacherBriefSelect,
      courses: { orderBy: { name: 'asc' }, include: { teacher: teacherBriefSelect } },
    },
  });
  if (!item) throw ApiError.notFound('班级不存在');
  return {
    headTeacher: null,
    subjectTeachers: item.courses.map((course) => ({
      courseId: course.id,
      subjectName: course.name,
      teacherId: course.teacherId,
      teacherName: course.teacher?.name ?? '',
    })),
  };
}

/** 创建班级 */
export async function createClass(user: TokenPayload, input: CreateClassInput): Promise<ClassDto> {
  assertCanManageClasses(user);
  let teacherId = user.sub;
  if (input.teacherId && user.role === 'ADMIN') {
    teacherId = await requireTeacher(input.teacherId, '指定的班主任不存在或角色不是教师');
  }

  // 班级账号：自动生成班级码（也可由管理员指定）+ 默认班级密码
  const account = await buildClassAccountCreateData(env.defaultClassPassword, input.code);

  // 称呼一律由「入学年份 + 班号」生成：名字与届别必须一致，
  // 否则会出现"名字是高一(1)班、届别却写 2026 级"这种自相矛盾的数据
  const name = formatClassName(input.enrollmentYear, input.classIndex);

  const created = await prisma.class.create({
    data: {
      name,
      grade: input.grade,
      enrollmentYear: input.enrollmentYear,
      classIndex: input.classIndex,
      teacherId,
      code: account.code,
      passwordHash: account.passwordHash,
      ...(input.termWeeks !== undefined ? { termWeeks: input.termWeeks } : {}),
    },
    include: {
      teacher: teacherBriefSelect,
      _count: { select: countSelect },
    },
  });

  return toClassDtoWithAccount(user, created);
}

/**
 * 设置 / 更改班主任（仅管理员）。
 *
 * 班主任决定了"谁能管这个班的学生名单与课表"，所以更换时要保证目标账号确实是教师/管理员。
 * 科任关系**不受影响** —— 它在 `Course` 上，是独立的一条条记录；
 * 同一位老师可以同时是班主任与某科科任，系统里只有一个账号，权限在 resolveClassRole 里合并。
 */
export async function updateHeadTeacher(
  user: TokenPayload,
  classId: string,
  teacherId: string,
): Promise<ClassDto> {
  assertCanAssignTeachers(user);
  const targetId = await requireTeacher(teacherId, '指定的班主任不存在或角色不是教师');

  const updated = await prisma.class.update({
    where: { id: classId },
    data: { teacherId: targetId },
    include: {
      teacher: teacherBriefSelect,
      _count: { select: countSelect },
    },
  });

  emitToClass(classId, SOCKET_EVENTS.classUpdated, { classId, action: 'head-teacher-changed' });
  return toClassDtoWithAccount(user, updated);
}

/**
 * 批量设置各科科任老师（仅管理员）。
 *
 * 入参里每条是「某班某科的任课老师」：
 * - 给了 `courseId` 就改那门课；
 * - 只给 `subjectName` 时按名字找，找不到就**自动建课**（复用全校统一科目目录的习惯做法）；
 * - `teacherId` 留空表示**解除**该科的任课老师（课程本身保留，作业与成绩仍挂在它上面）。
 *
 * 班主任同时是科任老师时，这里指向的还是同一个 `User` —— 不重复建号、不产生权限冲突。
 */
export async function assignSubjectTeachers(
  user: TokenPayload,
  classId: string,
  input: AssignSubjectTeachersInput,
): Promise<SubjectTeacherDto[]> {
  assertCanAssignTeachers(user);
  const targetClass = await prisma.class.findUnique({ where: { id: classId }, select: { id: true } });
  if (!targetClass) throw ApiError.notFound('班级不存在');

  for (const assignment of input.assignments) {
    const teacherId = assignment.teacherId
      ? await requireTeacher(assignment.teacherId, `「${assignment.subjectName}」的任课老师不存在或不是教师`)
      : // 解除任课关系时把课程挂回班主任，Course.teacherId 是必填列
        (await prisma.class.findUniqueOrThrow({ where: { id: classId }, select: { teacherId: true } }))
          .teacherId;

    const existing = assignment.courseId
      ? await prisma.course.findUnique({ where: { id: assignment.courseId }, select: { id: true, classId: true } })
      : await prisma.course.findUnique({
          where: { classId_name: { classId, name: assignment.subjectName } },
          select: { id: true, classId: true },
        });

    if (existing && existing.classId !== classId) {
      throw ApiError.badRequest(`课程「${assignment.subjectName}」不属于该班级`);
    }

    if (existing) {
      await prisma.course.update({ where: { id: existing.id }, data: { teacherId } });
    } else {
      await prisma.course.create({ data: { name: assignment.subjectName, classId, teacherId } });
    }
  }

  emitToClass(classId, SOCKET_EVENTS.classUpdated, { classId, action: 'updated' });
  const refreshed = await prisma.class.findUniqueOrThrow({
    where: { id: classId },
    include: { courses: { orderBy: { name: 'asc' }, include: { teacher: teacherBriefSelect } } },
  });
  return refreshed.courses.map((course) => ({
    courseId: course.id,
    subjectName: course.name,
    teacherId: course.teacherId,
    teacherName: course.teacher?.name ?? '',
  }));
}

/** 设置 / 重置班级账号（班级码 + 班级密码）：仅管理员 */
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
      teacher: teacherBriefSelect,
      _count: { select: countSelect },
    },
  });
  if (!updated) throw ApiError.notFound('班级不存在');
  return toClassDtoWithAccount(user, updated);
}

/** 编辑班级（年级 / 教学周数 / 届别） */
export async function updateClass(
  user: TokenPayload,
  classId: string,
  input: UpdateClassInput,
): Promise<ClassDto> {
  assertCanManageClasses(user);

  const current = await prisma.class.findUnique({
    where: { id: classId },
    select: { enrollmentYear: true, classIndex: true },
  });
  if (!current) throw ApiError.notFound('班级不存在');

  const enrollmentYear = input.enrollmentYear ?? current.enrollmentYear;
  const classIndex = input.classIndex ?? current.classIndex;

  const updated = await prisma.class.update({
    where: { id: classId },
    data: {
      ...(input.grade ? { grade: input.grade } : {}),
      ...(input.termWeeks !== undefined ? { termWeeks: input.termWeeks } : {}),
      // 学期开始日期：空串/null 都表示"回落到全局配置"（如 .env 的 TERM_START_DATE）
      ...(input.termStartDate !== undefined
        ? { termStartDate: input.termStartDate ? input.termStartDate : null }
        : {}),
      ...(input.enrollmentYear !== undefined ? { enrollmentYear } : {}),
      ...(input.classIndex !== undefined ? { classIndex } : {}),
      // 届别齐了就把称呼重算一遍：班级称呼的唯一来源是「入学年份 + 班号」
      ...(enrollmentYear && classIndex ? { name: formatClassName(enrollmentYear, classIndex) } : {}),
    },
    include: {
      teacher: teacherBriefSelect,
      _count: { select: countSelect },
    },
  });

  emitToClass(classId, SOCKET_EVENTS.classUpdated, { classId, action: 'updated' });
  return toClassDto(updated);
}

/**
 * 学年升级（仅管理员）：把若干班级的年级改掉，**不归档、数据沿用**。
 *
 * 这是「未毕业而升级的班级不归档」这条例则的操作入口 —— 高一 → 高二 只动 `grade`，
 * 班级记录、学生名单、学号、作业与成绩全部原样。归档只在毕业时由归档页显式执行。
 */
export async function promoteClasses(
  user: TokenPayload,
  input: { classIds: string[]; grade: string },
): Promise<{ promoted: number }> {
  assertCanManageClasses(user);
  const result = await prisma.class.updateMany({
    where: { id: { in: input.classIds }, archivedYearId: null },
    data: { grade: input.grade },
  });
  for (const classId of input.classIds) {
    emitToClass(classId, SOCKET_EVENTS.classUpdated, { classId, action: 'updated' });
  }
  return { promoted: result.count };
}

/** 删除班级（级联删除课表/作业/通知/成绩；学生记录保留但解除班级归属） */
export async function deleteClass(user: TokenPayload, classId: string): Promise<void> {
  assertCanManageClasses(user);
  emitToClass(classId, SOCKET_EVENTS.classUpdated, { classId, action: 'deleted' });
  await prisma.class.delete({ where: { id: classId } });
}

/** 班级学生名单 */
export async function listClassStudents(user: TokenPayload, classId: string): Promise<StudentDto[]> {
  await assertClassAccess(user, classId);
  const students = await prisma.student.findMany({
    where: { classId, archivedYearId: null },
    include: { class: { select: { name: true, grade: true } } },
    orderBy: { studentNo: 'asc' },
  });
  return students.map(toStudentDto);
}

/**
 * 添加学生到班级（名单记录）。
 *
 * 已存在的学生（按学号）直接转入本班，并记一条调班历史；
 * 学生没有账号属性：不设密码、不能登录，教室机器用班级码 + 班级密码。
 */
export async function addStudent(
  user: TokenPayload,
  classId: string,
  input: AddStudentInput,
): Promise<StudentDto> {
  await assertCanManageRoster(user, classId);
  await assertClassAccess(user, classId);

  const existing = await prisma.student.findUnique({ where: { studentNo: input.studentNo } });
  let studentId: string;

  if (existing) {
    studentId = existing.id;
    if (existing.classId !== classId) {
      await prisma.studentClassTransfer.create({
        data: {
          studentId: existing.id,
          studentNo: existing.studentNo,
          studentName: input.name || existing.name,
          fromClassId: existing.classId,
          fromClassName: await classLabel(existing.classId),
          toClassId: classId,
          toClassName: await classLabel(classId),
          operatorId: user.sub,
          operatorName: user.name,
          mode: 'single',
          note: '在班级名单里直接加入',
        },
      });
    }
    await prisma.student.update({
      where: { id: existing.id },
      data: { classId, name: input.name, status: 'active' },
    });
  } else {
    const created = await prisma.student.create({
      data: {
        studentNo: input.studentNo,
        name: input.name,
        classId,
        gender: input.gender ?? '',
        guardianPhone: input.guardianPhone ?? '',
      },
    });
    studentId = created.id;
  }

  const student = await prisma.student.findUniqueOrThrow({
    where: { id: studentId },
    include: { class: { select: { name: true, grade: true } } },
  });

  emitToClass(classId, SOCKET_EVENTS.classUpdated, { classId, action: 'updated' });
  return toStudentDto(student);
}

/** 将学生移出班级（保留名单记录，回到「未分班」） */
export async function removeStudent(user: TokenPayload, classId: string, studentId: string): Promise<void> {
  await assertCanManageRoster(user, classId);

  const student = await prisma.student.findUnique({ where: { id: studentId } });
  if (!student) throw ApiError.notFound('学生不存在');
  if (student.classId !== classId) throw ApiError.badRequest('该学生不属于此班级');

  await prisma.student.update({ where: { id: studentId }, data: { classId: null } });
  await prisma.studentClassTransfer.create({
    data: {
      studentId: student.id,
      studentNo: student.studentNo,
      studentName: student.name,
      fromClassId: classId,
      fromClassName: await classLabel(classId),
      toClassId: null,
      toClassName: '未分班',
      operatorId: user.sub,
      operatorName: user.name,
      mode: 'single',
      note: '从班级名单里移出',
    },
  });

  emitToClass(classId, SOCKET_EVENTS.classUpdated, { classId, action: 'updated' });
}

/* ---------------------------------------------------------------- ClassHelper 班级端状态 */

/**
 * 本班的 ClassHelper 联动状态（教室机器上的「联动」面板展示）。
 *
 * 为什么单独开一个接口：设备列表（/integrations/devices）是管理面，只对教师/管理员开放；
 * 而教室机器（ClassHelper 班级端）需要知道"本班接没接 ClassIsland、最后什么时候上报的"，
 * 才能给出准确的提示（例如没接就别选"只在 ClassIsland 上弹"）。
 */
export async function getClassIslandStatus(
  user: TokenPayload,
  classId: string,
): Promise<{
  connected: boolean;
  deviceName: string | null;
  deviceCount: number;
  onlineCount: number;
  lastSeenAt: string | null;
  lastHeartbeatAt: string | null;
  pluginVersion: string | null;
  classIslandVersion: string | null;
}> {
  await assertClassAccess(user, classId);
  const devices = await prisma.integrationDevice.findMany({
    where: { classId, enabled: true, mode: 'plugin' },
    select: {
      name: true,
      lastSeenAt: true,
      lastHeartbeatAt: true,
      pluginVersion: true,
      classIslandVersion: true,
    },
    orderBy: { lastHeartbeatAt: 'desc' },
  });

  const latest = devices[0];
  const window = 60_000;
  return {
    connected: devices.length > 0,
    deviceName: latest?.name ?? null,
    deviceCount: devices.length,
    onlineCount: devices.filter(
      (item) => item.lastHeartbeatAt && Date.now() - item.lastHeartbeatAt.getTime() < window,
    ).length,
    lastSeenAt: latest?.lastSeenAt ? latest.lastSeenAt.toISOString() : null,
    lastHeartbeatAt: latest?.lastHeartbeatAt ? latest.lastHeartbeatAt.toISOString() : null,
    pluginVersion: latest?.pluginVersion ?? null,
    classIslandVersion: latest?.classIslandVersion ?? null,
  };
}

/* ---------------------------------------------------------------- 班级端设置 */

/**
 * 读取班级的通知显示位置（both / client / classisland）。
 * 这是**教室机器**要读的值：登录后拉一次，把自己的弹窗行为对齐到同一个选择。
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
 * 允许两类人改：**该班的 ClassHelper 班级端**（需求就是"由教室机器自己选"）
 * 与教师 / 管理员（Web 端也能改，便于老师统一要求）。
 */
export async function updateNotificationChannel(
  user: TokenPayload,
  classId: string,
  input: UpdateNotificationChannelInput,
): Promise<{ notificationChannel: ClassIslandNotificationChannel }> {
  await assertClassAccess(user, classId);
  if (!isClassDevice(user) && !isStaff(user)) {
    throw ApiError.forbidden('只有 ClassHelper 班级端或教师/管理员可以修改通知显示位置');
  }

  const channel = toNotificationChannel(input.notificationChannel);
  await prisma.class.update({ where: { id: classId }, data: { notificationChannel: channel } });
  emitToClass(classId, SOCKET_EVENTS.classUpdated, { classId, action: 'updated' });
  logger.info(`班级通知显示位置已更新：classId=${classId} channel=${channel} by=${user.sub}`);
  return { notificationChannel: channel };
}

/**
 * 读取「是否允许 ClassHelper 班级端按学号查询本班学生成绩明细」。
 * 班级端设置页用它渲染开关的当前状态。
 */
export async function getStudentGradeQuery(
  user: TokenPayload,
  classId: string,
): Promise<{ studentGradeQueryEnabled: boolean }> {
  await assertClassAccess(user, classId);
  const record = await prisma.class.findUnique({
    where: { id: classId },
    select: { studentGradeQueryEnabled: true },
  });
  if (!record) throw ApiError.notFound('班级不存在');
  // 老库补列时的默认值也是 true，两边保持一致
  return { studentGradeQueryEnabled: record.studentGradeQueryEnabled ?? true };
}

/**
 * 设置「是否允许 ClassHelper 班级端按学号查询本班学生成绩明细」。
 *
 * 与通知显示位置同一套模式：**班级端自己改**（教室里老师最清楚要不要给学生看），
 * 教师 / 管理员在 Web 端也能改。关闭后班级端查成绩一律 403，教师端不受影响。
 */
export async function updateStudentGradeQuery(
  user: TokenPayload,
  classId: string,
  input: UpdateStudentGradeQueryInput,
): Promise<{ studentGradeQueryEnabled: boolean }> {
  await assertClassAccess(user, classId);
  if (!isClassDevice(user) && !isStaff(user)) {
    throw ApiError.forbidden('只有 ClassHelper 班级端或教师/管理员可以修改成绩查询开关');
  }

  await prisma.class.update({
    where: { id: classId },
    data: { studentGradeQueryEnabled: input.enabled },
  });
  emitToClass(classId, SOCKET_EVENTS.classUpdated, { classId, action: 'updated' });
  logger.info(`班级端成绩查询开关：classId=${classId} enabled=${input.enabled} by=${user.sub}`);
  return { studentGradeQueryEnabled: input.enabled };
}

/* ---------------------------------------------------------------- 内部工具 */

/** 校验目标账号确实是教师/管理员，返回其 id */
async function requireTeacher(teacherId: string, message: string): Promise<string> {
  const teacher = await prisma.user.findUnique({
    where: { id: teacherId },
    select: { id: true, role: true },
  });
  if (!teacher || (teacher.role !== 'TEACHER' && teacher.role !== 'ADMIN')) {
    throw ApiError.badRequest(message);
  }
  return teacher.id;
}

/** 班级名（写调班历史快照用）；班级不存在时返回空串 */
async function classLabel(classId: string | null): Promise<string> {
  if (!classId) return '';
  const record = await prisma.class.findUnique({ where: { id: classId }, select: { name: true } });
  return record?.name ?? '';
}
