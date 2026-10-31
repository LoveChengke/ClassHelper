import { disconnectUserSessions, refreshClassSubscriptions } from '../../realtime/bus.js';
import { assertHeadOnly, assertManage } from '../../lib/authz/index.js';
import { auditData } from '../permissions/permissions.service.js';
import type { ClassDetailDto, ClassDto, StudentDto, SubjectTeacherDto } from '@classhelper/shared';
import { SOCKET_EVENTS, formatClassName } from '@classhelper/shared';
import { env } from '../../config/env.js';
import {
  assertCanAssignTeachers,
  assertCanManageClasses,
  assertClassAccess,
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
import { toClassDto, toCourseDto, toStudentDto, toTeacherBrief } from '../../lib/mappers.js';
import { emitToClass } from '../../realtime/bus.js';
import type {
  AddStudentInput,
  AssignSubjectTeachersInput,
  CreateClassInput,
  UpdateClassInput,
  UpdateClassSettingsInput,
  UpdateStudentGradeQueryInput,
} from './classes.schemas.js';
import { loadPromotionPlan } from '../term/promotion.service.js';
import { assertClassInScope, canAccessClass } from '../../lib/access.js';
import { changeStudentLifecycle } from '../../lib/student-lifecycle.js';
import {
  assertPermissionOrClassDevice,
  assertPermission,
  hasEffectivePermission,
} from '../../lib/permissions.js';
import { activeStudentWhere } from '../../lib/students.js';
import { getMaxTermWeeks } from '../../lib/term.js';
import { logger } from '../../lib/logger.js';

const countSelect = {
  students: { where: activeStudentWhere() },
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
function canSeeClassAccount(user: TokenPayload, item: { teacherId: string | null }): boolean {
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
  await assertPermissionOrClassDevice(user, 'class:read');
  const scope = await resolveClassScope(user, undefined, 'class:read');
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

  return classes.map((item) => toClassDtoWithAccount(user, item));
}

/** 班级详情：学生名单 + 课程 + 班主任 + 各科任课老师 */
export async function getClassDetail(user: TokenPayload, classId: string): Promise<ClassDetailDto> {
  await assertPermissionOrClassDevice(user, 'class:read');
  await assertClassAccess(user, classId, 'class:read');

  const item = await prisma.class.findUnique({
    where: { id: classId },
    include: {
      teacher: teacherBriefSelect,
      _count: { select: countSelect },
      students: { where: activeStudentWhere(), orderBy: { studentNo: 'asc' } },
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
    students:
      user.role === 'CLASS_DEVICE' ||
      ((await hasEffectivePermission(user, 'roster:read')) &&
        (await canAccessClass(user, classId, 'roster:read')))
        ? item.students.map(toStudentDto)
        : [],
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
  await assertClassAccess(user, classId, 'class:read');
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
  await assertCanManageClasses(user);
  if (
    'termWeeks' in input &&
    typeof input.termWeeks === 'number' &&
    input.termWeeks > (await getMaxTermWeeks())
  )
    throw ApiError.badRequest('班级周数不能超过全校上限');

  let teacherId: string | null = null;
  if (input.teacherId) {
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

  await prisma.permissionAudit.create({
    data: auditData(user, 'class-create', 'class', created.id, null, {
      name: created.name,
      teacherId: created.teacherId,
    }),
  });
  refreshClassSubscriptions();
  return toClassDtoWithAccount(user, created);
}

/**
 * 设置 / 更改班主任（按班级管理权限与范围）。
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
  await assertCanAssignTeachers(user, classId);
  const before = await prisma.class.findUniqueOrThrow({
    where: { id: classId },
    select: { teacherId: true },
  });
  const targetId = await requireTeacher(teacherId, '指定的班主任不存在或角色不是教师');

  const updated = await prisma.class.update({
    where: { id: classId },
    data: { teacherId: targetId },
    include: {
      teacher: teacherBriefSelect,
      _count: { select: countSelect },
    },
  });

  await prisma.permissionAudit.create({
    data: auditData(user, 'class-head', 'class', classId, before, { teacherId: targetId }),
  });
  disconnectUserSessions([before.teacherId, targetId].filter((id): id is string => !!id));
  emitToClass(classId, SOCKET_EVENTS.classUpdated, { classId, action: 'head-teacher-changed' });
  return toClassDtoWithAccount(user, updated);
}

/**
 * 批量设置各科科任老师（按班级管理权限与范围）。
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
  await assertCanAssignTeachers(user, classId);
  const targetClass = await prisma.class.findUnique({ where: { id: classId }, select: { id: true } });
  if (!targetClass) throw ApiError.notFound('班级不存在');

  const before = await prisma.course.findMany({
    where: { classId },
    select: { id: true, name: true, teacherId: true },
  });
  for (const assignment of input.assignments) {
    const teacherId = assignment.teacherId
      ? await requireTeacher(assignment.teacherId, `「${assignment.subjectName}」的任课老师不存在或不是教师`)
      : // 解除任课关系时把课程挂回班主任，Course.teacherId 是必填列
        (await prisma.class.findUniqueOrThrow({ where: { id: classId }, select: { teacherId: true } }))
          .teacherId;

    if (!teacherId) throw ApiError.badRequest('请先指定班主任或为该科指定任课老师');
    const existing = assignment.courseId
      ? await prisma.course.findUnique({
          where: { id: assignment.courseId },
          select: { id: true, classId: true },
        })
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
  await prisma.permissionAudit.create({
    data: auditData(
      user,
      'class-subjects',
      'class',
      classId,
      before,
      refreshed.courses.map((c) => ({ id: c.id, name: c.name, teacherId: c.teacherId })),
    ),
  });
  disconnectUserSessions([...new Set([...before, ...refreshed.courses].map((c) => c.teacherId))]);
  return refreshed.courses.map((course) => ({
    courseId: course.id,
    subjectName: course.name,
    teacherId: course.teacherId,
    teacherName: course.teacher?.name ?? '',
  }));
}

/** 设置 / 重置班级账号（班级码 + 班级密码）：按班级管理权限与范围 */
export async function updateClassAccount(
  user: TokenPayload,
  classId: string,
  input: { code?: string; password?: string },
): Promise<ClassDto> {
  await assertHeadOnly(user, 'class:account', classId);
  const before = await prisma.class.findUniqueOrThrow({ where: { id: classId }, select: { code: true } });
  if (
    'termWeeks' in input &&
    typeof input.termWeeks === 'number' &&
    input.termWeeks > (await getMaxTermWeeks())
  )
    throw ApiError.badRequest('班级周数不能超过全校上限');

  await updateClassAccountRecord(classId, input);

  const updated = await prisma.class.findUnique({
    where: { id: classId },
    include: {
      teacher: teacherBriefSelect,
      _count: { select: countSelect },
    },
  });
  if (!updated) throw ApiError.notFound('班级不存在');
  await prisma.permissionAudit.create({
    data: auditData(user, 'class-account', 'class', classId, before, {
      code: updated.code,
      passwordChanged: input.password !== undefined,
    }),
  });
  return toClassDtoWithAccount(user, updated);
}

/** 编辑班级资料；年级只能通过升级计划修改。 */
export async function updateClass(
  user: TokenPayload,
  classId: string,
  input: UpdateClassInput,
): Promise<ClassDto> {
  await assertCanManageClasses(user, classId);

  const current = await prisma.class.findUnique({
    where: { id: classId },
    select: { enrollmentYear: true, classIndex: true },
  });
  if (!current) throw ApiError.notFound('班级不存在');

  if ('grade' in input) throw ApiError.badRequest('修改年级请使用学年升级入口');
  const enrollmentYear = input.enrollmentYear ?? current.enrollmentYear;
  const classIndex = input.classIndex ?? current.classIndex;

  const updated = await prisma.class.update({
    where: { id: classId },
    data: {
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

  await prisma.permissionAudit.create({
    data: auditData(user, 'class-update', 'class', classId, current, {
      enrollmentYear: updated.enrollmentYear,
      classIndex: updated.classIndex,
      name: updated.name,
    }),
  });
  emitToClass(classId, SOCKET_EVENTS.classUpdated, { classId, action: 'updated' });
  return toClassDto(updated);
}

export async function updateClassSettings(
  user: TokenPayload,
  classId: string,
  input: UpdateClassSettingsInput,
): Promise<ClassDto> {
  await assertHeadOnly(user, 'class:settings', classId);
  if (input.termWeeks !== undefined && input.termWeeks > (await getMaxTermWeeks()))
    throw ApiError.badRequest('班级周数不能超过全校上限');
  const before = await prisma.class.findUniqueOrThrow({
    where: { id: classId },
    select: { termWeeks: true, termStartDate: true },
  });
  const updated = await prisma.class.update({
    where: { id: classId },
    data: {
      termWeeks: input.termWeeks,
      ...(input.termStartDate !== undefined ? { termStartDate: input.termStartDate || null } : {}),
    },
  });
  await prisma.permissionAudit.create({
    data: auditData(user, 'class-settings', 'class', classId, before, {
      termWeeks: updated.termWeeks,
      termStartDate: updated.termStartDate,
    }),
  });
  emitToClass(classId, SOCKET_EVENTS.classUpdated, { classId, action: 'updated' });
  return toClassDto(updated);
}
/**
 * 学年升级（按升级权限与班级范围）：把若干班级的年级改掉，**不归档、数据沿用**。
 *
 * 从已保存计划推导下一学段；毕业学段必须走年度升级归档。保留班级业务数据。
 */
export async function promoteClasses(
  user: TokenPayload,
  input: { classIds: string[] },
): Promise<{ promoted: number }> {
  await assertPermission(user, 'promotion:manage');
  const plan = await loadPromotionPlan();
  const ids = [...new Set(input.classIds)];
  for (const id of ids) await assertClassInScope(user, id, 'promotion:manage');
  await prisma.$transaction(async (tx) => {
    const classes = await tx.class.findMany({ where: { id: { in: ids }, archivedYearId: null } });
    if (classes.length !== ids.length) throw ApiError.conflict('部分班级不存在或已归档');
    for (const cls of classes) {
      const track = plan.tracks.find((track) => track.stages.some((stage) => stage.grade === cls.grade));
      const index = track?.stages.findIndex((stage) => stage.grade === cls.grade) ?? -1;
      if (!track || index < 0) throw ApiError.conflict('班级年级不在升级计划内');
      if (track.stages[index].terminal) throw ApiError.conflict('毕业学段请通过年度升级进行归档');
      const nextGrade = track.stages[index + 1].grade;
      await tx.class.update({ where: { id: cls.id }, data: { grade: nextGrade, termStartDate: null } });
      await tx.permissionAudit.create({
        data: {
          actorId: user.sub,
          actorName: user.name,
          action: 'promote-class',
          targetType: 'class',
          targetId: cls.id,
          beforeJson: JSON.stringify({ grade: cls.grade }),
          afterJson: JSON.stringify({ grade: nextGrade }),
        },
      });
    }
  });
  for (const classId of ids) emitToClass(classId, SOCKET_EVENTS.classUpdated, { classId, action: 'updated' });
  refreshClassSubscriptions();
  return { promoted: ids.length };
}

/** 删除班级（级联删除课表/作业/通知/成绩；学生记录保留但解除班级归属） */
export async function deleteClass(user: TokenPayload, classId: string): Promise<void> {
  await assertCanManageClasses(user);
  if (await prisma.student.count({ where: { classId } }))
    throw ApiError.conflict('班级仍有学生，请先通过名单生命周期入口移出或归档，不能级联清除归属');
  emitToClass(classId, SOCKET_EVENTS.classUpdated, { classId, action: 'deleted' });
  const before = await prisma.class.findUniqueOrThrow({
    where: { id: classId },
    select: { id: true, name: true, grade: true },
  });
  await prisma.class.delete({ where: { id: classId } });
  refreshClassSubscriptions();
  await prisma.permissionAudit.create({
    data: auditData(user, 'class-delete', 'class', classId, before, null),
  });
}

/** 班级学生名单 */
export async function listClassStudents(user: TokenPayload, classId: string): Promise<StudentDto[]> {
  await assertPermissionOrClassDevice(user, 'roster:read');
  await assertClassAccess(user, classId, 'roster:read');
  const students = await prisma.student.findMany({
    where: { classId, ...activeStudentWhere() },
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
  const existing = await prisma.student.findUnique({ where: { studentNo: input.studentNo } });
  if (existing && (existing.archivedYearId || existing.status !== 'active'))
    throw ApiError.conflict('学号已被历史学生占用，请使用转入、复学或撤销归档入口');
  const result = await changeStudentLifecycle(user, {
    studentIds: existing ? [existing.id] : [],
    kind: 'class-change',
    toClassId: classId,
    note: '班级名单添加',
    ...(!existing ? { newStudent: input } : {}),
  });
  return toStudentDto(
    await prisma.student.findUniqueOrThrow({
      where: { id: result.studentId },
      include: { class: { select: { name: true, grade: true } } },
    }),
  );
}

export async function removeStudent(user: TokenPayload, classId: string, studentId: string): Promise<void> {
  const student = await prisma.student.findUnique({ where: { id: studentId } });
  if (!student || student.classId !== classId) throw ApiError.badRequest('学生不属于此班级');
  await changeStudentLifecycle(user, { studentIds: [studentId], kind: 'unassign', note: '移出班级' });
}

/**
 * 读取「是否允许 ClassHelper 班级端按学号查询本班学生成绩明细」。
 * 班级端设置页用它渲染开关的当前状态。
 */
export async function getStudentGradeQuery(
  user: TokenPayload,
  classId: string,
): Promise<{ studentGradeQueryEnabled: boolean }> {
  await assertClassAccess(user, classId, 'class:read');
  const record = await prisma.class.findUnique({
    where: { id: classId },
    select: { studentGradeQueryEnabled: true },
  });
  if (!record) throw ApiError.notFound('班级不存在');
  // 老库补列时的默认值也是 true，两边保持一致
  return { studentGradeQueryEnabled: record.studentGradeQueryEnabled ?? true };
}

/**
 * 设置「是否允许 ClassHelper 班级端查看本班成绩与排名」。
 *
 * **只有教师 / 管理员能改**（需求：「成绩查询由服务端控制，客户端只读」）。
 * 关闭后班级端查成绩一律 403，教师端不受影响。
 */
export async function updateStudentGradeQuery(
  user: TokenPayload,
  classId: string,
  input: UpdateStudentGradeQueryInput,
): Promise<{ studentGradeQueryEnabled: boolean }> {
  await assertManage(user, 'grade:write', classId);
  if (!isStaff(user)) {
    throw ApiError.forbidden('成绩查询开关由教师/管理员在 Web 端设置，班级端只读');
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
