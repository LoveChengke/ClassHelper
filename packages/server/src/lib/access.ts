import {
  canAssignTeachers,
  canManageClasses,
  canManageGrades,
  canManageRoster,
  canManageSchedule,
  canManageSubjectContent,
  canPublishNotification,
  resolveClassRole,
  type ClassRole,
} from '@classhelper/shared';
import { prisma } from './db.js';
import { ApiError } from './http.js';
import type { TokenPayload } from './jwt.js';

/**
 * 权限（RBAC）规则。
 *
 * | 角色 | 范围 | 能做什么 |
 * | ---- | ---- | -------- |
 * | ADMIN         | 全局 | 班级/教师/学生名单/调班/归档/全部科目的作业与成绩 |
 * | HEAD 班主任    | 本班 | 本班学生名单、课表、本班汇总；**作业与成绩仍按科目收口** |
 * | SUBJECT 科任    | 班级 + 科目 | 只能发布/修改/删除**自己任教科目**的作业与成绩 |
 * | CLASS_DEVICE  | 绑定班级 | ClassHelper 班级端：代本班读写个人数据、按开关查成绩明细 |
 * | 学生           | 无账号 | 仅作为 `Student` 名单记录，不登录、无权限 |
 *
 * 三条铁律（都是这次重构的落点）：
 * 1. **任课关系的唯一来源是 `Course`**（班级 + 科目 + 教师），没有第二张关系表；
 * 2. **班主任不自动拥有本班所有科目的作业成绩编辑权** —— 只有同时是该科科任老师时才有；
 * 3. **所有权限都在后端判**，前端只做展示控制。
 *
 * 判定逻辑与前端共用 `@classhelper/shared/permissions`，避免前后端口径漂移。
 */

export function isAdmin(user: TokenPayload): boolean {
  return user.role === 'ADMIN';
}

export function isTeacher(user: TokenPayload): boolean {
  return user.role === 'TEACHER';
}

/** 教师与管理员（staff）：能以自己的身份操作班级内容 */
export function isStaff(user: TokenPayload): boolean {
  return user.role === 'ADMIN' || user.role === 'TEACHER';
}

/**
 * 是否是 ClassHelper 班级端（教室机器上那台绑定到某个班的客户端）。
 * 它代全班读写个人数据（作业完成、通知已读），也能按开关查本班学生成绩明细。
 */
export function isClassDevice(user: TokenPayload): boolean {
  return user.role === 'CLASS_DEVICE';
}

/** ClassHelper 班级端绑定的班级 id；不是班级端会话时返回 null */
export function classDeviceClassId(user: TokenPayload): string | null {
  return isClassDevice(user) ? (user.classId ?? user.sub) : null;
}

/**
 * 班级访问的判定条件：班主任，**或在该班有任课关系**（`Course.teacherId`）。
 *
 * 这里就是「科任老师」的判定源 —— 以前查的是没有科目的 `ClassTeacher` 协作表，
 * 现在查 `Course`，于是"能不能进这个班"与"能不能改这一科的作业成绩"用的是同一份事实。
 */
function classMembershipWhere(teacherId: string) {
  return {
    OR: [{ teacherId }, { courses: { some: { teacherId } } }],
  };
}

/** 当前用户可访问的全部班级 id */
export async function getAccessibleClassIds(user: TokenPayload): Promise<string[]> {
  if (isAdmin(user)) {
    const classes = await prisma.class.findMany({ select: { id: true } });
    return classes.map((item) => item.id);
  }

  if (isTeacher(user)) {
    const classes = await prisma.class.findMany({
      where: classMembershipWhere(user.sub),
      select: { id: true },
    });
    return classes.map((item) => item.id);
  }

  const classId = classDeviceClassId(user);
  return classId ? [classId] : [];
}

export async function canAccessClass(user: TokenPayload, classId: string): Promise<boolean> {
  if (isAdmin(user)) return true;
  if (isTeacher(user)) {
    const count = await prisma.class.count({ where: { id: classId, ...classMembershipWhere(user.sub) } });
    return count > 0;
  }
  return classDeviceClassId(user) === classId;
}

/** 读权限断言 */
export async function assertClassAccess(user: TokenPayload, classId: string): Promise<void> {
  const exists = await prisma.class.findUnique({ where: { id: classId }, select: { id: true } });
  if (!exists) throw ApiError.notFound('班级不存在');
  if (!(await canAccessClass(user, classId))) throw ApiError.forbidden('无权访问该班级的数据');
}

/** 写权限断言：无账号的学生不在会话里，因此这里只放行 staff 与 ClassHelper 班级端 */
export async function assertClassWritable(user: TokenPayload, classId: string): Promise<void> {
  if (!isStaff(user) && !isClassDevice(user)) throw ApiError.forbidden('当前身份没有管理权限');
  await assertClassAccess(user, classId);
}

/* ---------------------------------------------------------------- 班级内角色 */

/** 解析当前用户在某班级里的角色（ADMIN / HEAD / SUBJECT / CLASS_DEVICE / NONE） */
export async function resolveUserClassRole(user: TokenPayload, classId: string): Promise<ClassRole> {
  if (user.role === 'ADMIN') return 'ADMIN';
  if (user.role === 'CLASS_DEVICE') return (await canAccessClass(user, classId)) ? 'CLASS_DEVICE' : 'NONE';

  const record = await prisma.class.findUnique({
    where: { id: classId },
    select: {
      teacherId: true,
      courses: { where: { teacherId: user.sub }, select: { id: true } },
    },
  });
  if (!record) return 'NONE';
  return resolveClassRole({
    role: user.role,
    isHeadTeacher: record.teacherId === user.sub,
    teachesSubjects: record.courses.length > 0,
  });
}

/** 班级本身（增删改）与人员分配：仅管理员 */
export function assertCanManageClasses(user: TokenPayload): void {
  if (!canManageClasses(user.role)) {
    throw ApiError.forbidden('只有管理员可以创建、修改或删除班级');
  }
}

/** 班主任 / 各科科任老师的分配：仅管理员 */
export function assertCanAssignTeachers(user: TokenPayload): void {
  if (!canAssignTeachers(user.role)) {
    throw ApiError.forbidden('只有管理员可以分配班主任与各科科任老师');
  }
}

/**
 * 学生名单（增删学生 / 导入名单 / 调班）：管理员，或**本班班主任**。
 *
 * @param classId 目标班级；不传表示"全局名单操作"（例如未分班的学生），此时仅管理员
 */
export async function assertCanManageRoster(user: TokenPayload, classId?: string): Promise<void> {
  if (!classId) {
    if (!isAdmin(user)) throw ApiError.forbidden('该操作需要指定班级，只有管理员可以全局执行');
    return;
  }
  const classRole = await resolveUserClassRole(user, classId);
  if (!canManageRoster(classRole)) {
    throw ApiError.forbidden(
      classRole === 'SUBJECT'
        ? '科任老师不能管理学生名单，请联系班主任或管理员'
        : '只能管理自己担任班主任的班级的学生名单',
    );
  }
}

/** 课表管理（含时间配置导入）：管理员或本班班主任 */
export async function assertCanManageSchedule(user: TokenPayload, classId: string): Promise<void> {
  const classRole = await resolveUserClassRole(user, classId);
  if (!canManageSchedule(classRole)) {
    throw ApiError.forbidden(
      classRole === 'SUBJECT' || classRole === 'CLASS_DEVICE'
        ? '科任老师与班级端不能管理课表，请联系班主任或管理员'
        : '无权管理该班级的课表',
    );
  }
}

/** 通知 / 叫人：管理员、班主任、科任老师、ClassHelper 班级端（面向全班，不分科目） */
export async function assertCanPublishNotification(user: TokenPayload, classId: string): Promise<void> {
  await assertClassAccess(user, classId);
  const classRole = await resolveUserClassRole(user, classId);
  if (!canPublishNotification(classRole)) {
    throw ApiError.forbidden('当前账号没有发布通知或叫人的权限');
  }
}

/**
 * 成绩录入 / 修改 / 导入的**班级维度**准入：管理员，或本班班主任。
 *
 * @param classId 目标成绩所属班级；不传时按"全局"判定（仅管理员可用，例如空白模板下载）
 *
 * 这只是第一道门：具体某一条成绩能不能动，还要过 `assertCanManageSubjectContent` 的**科目**那道门。
 */
export async function assertCanManageGrades(user: TokenPayload, classId?: string): Promise<void> {
  if (!classId) {
    if (!isAdmin(user)) throw ApiError.forbidden('该操作需要指定班级，只有管理员可以全局执行');
    return;
  }

  const classRole = await resolveUserClassRole(user, classId);
  if (canManageGrades(classRole)) return;

  throw ApiError.forbidden(
    classRole === 'SUBJECT' || classRole === 'CLASS_DEVICE'
      ? '科任老师与班级端不能代录全班成绩，请在自己的科目里录入'
      : '只能录入自己担任班主任的班级的成绩',
  );
}

/**
 * **科目维度的写权限**（作业与成绩共用的那道细门）—— 本次重构的核心规则。
 *
 * | 情形 | 谁可以写 |
 * | ---- | -------- |
 * | 管理员 | 全部 |
 * | ClassHelper 班级端 | 仅当 `allowClassDevice`（作业允许、成绩不允许） |
 * | 挂了科目（courseId 有值） | **该科的任课老师**（`Course.teacherId`） |
 * | 没挂科目（courseId 为空） | 本班**班主任** |
 *
 * 于是：班主任若不教这一科，就改不了这一科的作业与成绩 —— 这正是需求
 * 「班主任不自动拥有所有科目作业成绩编辑权，只有同时是该科科任老师时才有该科权限」。
 *
 * @param courseId 目标内容挂在哪门课（科目）上；null/undefined 表示"不指定科目"
 * @param action 给用户看的动作名，例如「布置作业」「录入成绩」
 * @param options.allowClassDevice 是否允许教室机器代写（作业为 true，成绩为 false）
 */
export async function assertCanManageSubjectContent(
  user: TokenPayload,
  classId: string,
  courseId: string | null | undefined,
  action: string,
  options: { allowClassDevice?: boolean } = {},
): Promise<void> {
  await assertClassAccess(user, classId);
  const classRole = await resolveUserClassRole(user, classId);
  const allowClassDevice = options.allowClassDevice === true;

  // 管理员不受科目限制，提前返回省掉一次课程查询
  if (classRole === 'ADMIN') return;
  if (classRole === 'CLASS_DEVICE') {
    if (allowClassDevice) return;
    throw ApiError.forbidden(`ClassHelper 班级端不能${action}，请由任课老师在 Web 端操作`);
  }

  let isSubjectTeacherOfCourse = false;
  let courseName = '';
  if (courseId) {
    const course = await prisma.course.findUnique({
      where: { id: courseId },
      select: { classId: true, teacherId: true, name: true },
    });
    if (!course) throw ApiError.badRequest('课程不存在');
    if (course.classId !== classId) throw ApiError.badRequest('该课程不属于所选班级');
    courseName = course.name;
    isSubjectTeacherOfCourse = course.teacherId === user.sub;
  }

  const allowed = canManageSubjectContent({
    classRole,
    hasSubject: Boolean(courseId),
    isSubjectTeacherOfCourse,
    allowClassDevice,
  });
  if (allowed) return;

  throw ApiError.forbidden(
    courseId
      ? `「${courseName}」不是你任教的科目，不能${action}该科目的内容`
      : `未指定科目的内容只有班主任或管理员可以${action}`,
  );
}

/** 学生的主班级（ClassHelper 班级端会话）；未绑定班级时抛 403 */
export function requireClassDeviceClassId(user: TokenPayload): string {
  const classId = classDeviceClassId(user);
  if (!classId) throw ApiError.forbidden('当前会话未绑定班级，请联系管理员');
  return classId;
}

/**
 * 查询范围解析：
 * - 传入 classId：校验后只查该班级
 * - 未传：教师只能查自己可访问的班级；管理员不加限制
 */
export type ClassScope = { mode: 'all' } | { mode: 'in'; classIds: string[] };

export async function resolveClassScope(user: TokenPayload, requestedClassId?: string): Promise<ClassScope> {
  if (requestedClassId) {
    await assertClassAccess(user, requestedClassId);
    return { mode: 'in', classIds: [requestedClassId] };
  }
  if (isAdmin(user)) return { mode: 'all' };

  const classIds = await getAccessibleClassIds(user);
  // 没有任何班级时不抛错，返回空集合让列表接口给出空数组，避免新教师首次登录报错
  return { mode: 'in', classIds };
}

/** 把 ClassScope 转换成 Prisma 的 where 片段（子表：classId 字段） */
export function classScopeWhere(scope: ClassScope): { classId?: { in: string[] } } {
  return scope.mode === 'all' ? {} : { classId: { in: scope.classIds } };
}

/** Class 表自身的范围过滤：注意这里过滤的是主键 id，而不是子表的 classId */
export function classScopeIdFilter(scope: ClassScope): { id?: { in: string[] } } {
  return scope.mode === 'all' ? {} : { id: { in: scope.classIds } };
}

/** 单班级场景：班级端强制取自己绑定的班级，其他角色沿用请求参数 */
export function resolveEffectiveClassId(user: TokenPayload, requestedClassId?: string): string | undefined {
  if (isClassDevice(user)) return requireClassDeviceClassId(user);
  return requestedClassId;
}
