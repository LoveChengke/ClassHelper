import {
  SOCKET_EVENTS,
  dayKeyLocal,
  shiftDayKey,
  type HomeworkDaysDto,
  type HomeworkDto,
  type HomeworkStatusDto,
  type HomeworkSubmissionDto,
  type HomeworkSubmissionsDto,
} from '@classhelper/shared';
import {
  assertCanManageSubjectContent,
  assertClassAccess,
  classScopeWhere,
  isClassDevice,
  resolveClassScope,
} from '../../lib/access.js';
import { prisma } from '../../lib/db.js';
import { ApiError } from '../../lib/http.js';
import type { TokenPayload } from '../../lib/jwt.js';
import { toHomeworkDto, toHomeworkStatusDto } from '../../lib/mappers.js';
import { personalIdWhere, resolvePersonalIds } from '../../lib/session.js';
import { emitToClass } from '../../realtime/bus.js';
import type {
  CreateHomeworkInput,
  UpdateHomeworkInput,
  UpdateHomeworkStatusInput,
  UpdateHomeworkSubmissionsInput,
} from './homeworks.schemas.js';

const courseSelect = { select: { id: true, name: true } } as const;
const creatorSelect = { select: { id: true, name: true, username: true } } as const;

export interface ListHomeworkOptions {
  classId?: string;
  courseId?: string;
  pendingOnly?: boolean;
  keyword?: string;
  /** 只看某一天（Homework.assignDate，YYYY-MM-DD） */
  date?: string;
}

/**
 * 作业列表。
 * - ClassHelper 班级端：附带本班的完成情况，可通过 pendingOnly 只看未完成
 * - 教师/管理员：附带完成人数统计
 */
export async function listHomeworks(
  user: TokenPayload,
  options: ListHomeworkOptions,
): Promise<HomeworkDto[]> {
  const scope = await resolveClassScope(user, options.classId);
  const device = isClassDevice(user);
  // ClassHelper 班级端以全班学生为范围；教师/管理员没有"自己的完成状态"
  const personalIds = device ? await resolvePersonalIds(user) : [];
  const personalWhere = personalIdWhere(personalIds);

  const homeworks = await prisma.homework.findMany({
    where: {
      ...classScopeWhere(scope),
      ...(options.courseId ? { courseId: options.courseId } : {}),
      ...(options.keyword
        ? { OR: [{ title: { contains: options.keyword } }, { content: { contains: options.keyword } }] }
        : {}),
      ...(device && options.pendingOnly
        ? { statuses: { none: { ...personalWhere, completed: true } } }
        : {}),
      // 按天查看：作业「属于哪一天」看 assignDate（本地日期），不是 createdAt
      ...(options.date ? { assignDate: options.date } : {}),
    },
    include: {
      course: courseSelect,
      creator: creatorSelect,
      statuses: device ? { where: personalWhere } : true,
    },
    orderBy: [{ assignDate: 'desc' }, { createdAt: 'desc' }],
    take: 200,
  });

  return homeworks.map((item) =>
    toHomeworkDto(item, { studentIds: device ? personalIds : [], withStatus: !device }),
  );
}

/**
 * 按天查看：查一段时间内「哪些天有作业」（日期选择器高亮用）。
 *
 * 只回有作业的日期（稀疏），避免把整月日历塞回前端；不传区间时默认回看 60 天。
 */
export async function listHomeworkDays(
  user: TokenPayload,
  options: { classId?: string; from?: string; to?: string; days?: number },
): Promise<HomeworkDaysDto> {
  const scope = await resolveClassScope(user, options.classId);
  const today = dayKeyLocal(new Date());
  const to = options.to ?? today;
  const from = options.from ?? shiftDayKey(to, -(options.days ?? 60) + 1);

  const rows = await prisma.homework.findMany({
    where: { ...classScopeWhere(scope), assignDate: { gte: from, lte: to } },
    select: { assignDate: true },
  });

  const counter = new Map<string, number>();
  for (const row of rows) {
    if (!row.assignDate) continue;
    counter.set(row.assignDate, (counter.get(row.assignDate) ?? 0) + 1);
  }

  return {
    days: [...counter.entries()]
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
}

export async function getHomework(user: TokenPayload, homeworkId: string): Promise<HomeworkDto> {
  const device = isClassDevice(user);
  const personalIds = device ? await resolvePersonalIds(user) : [];
  const homework = await prisma.homework.findUnique({
    where: { id: homeworkId },
    include: {
      course: courseSelect,
      creator: creatorSelect,
      statuses: device ? { where: personalIdWhere(personalIds) } : true,
    },
  });
  if (!homework) throw ApiError.notFound('作业不存在');
  await assertClassAccess(user, homework.classId);

  return toHomeworkDto(homework, {
    studentIds: device ? personalIds : [],
    withStatus: !device,
  });
}

/* ------------------------------------------------------------------ 发布 / 修改 / 删除 */

/**
 * 发布作业并实时推送到班级房间。
 *
 * 权限走 `assertCanManageSubjectContent`（`allowClassDevice: true`）：
 * - **选了科目** → 必须是该科的任课老师（班主任不教这一科也发不了）；
 * - **没选科目** → 本班班主任或管理员；
 * - **ClassHelper 班级端** → 可以录（老师在教室电脑上顺手记一条是常见需求，
 *   见 AGENTS.md §5 第 20 条），班级端录入的作业归属该班班主任。
 */
export async function createHomework(user: TokenPayload, input: CreateHomeworkInput): Promise<HomeworkDto> {
  await assertCanManageSubjectContent(user, input.classId, input.courseId ?? null, '布置作业', {
    allowClassDevice: true,
  });
  if (input.courseId) await assertCourseInClass(input.courseId, input.classId);

  // ClassHelper 班级端的 sub 是**班级 id**（不是账号 id），直接写 createdBy 会撞外键；
  // 教室机器录入的作业归属该班班主任，Web 端看到的作者才是真人。
  let createdBy = user.sub;
  if (isClassDevice(user)) {
    const owner = await prisma.class.findUnique({
      where: { id: input.classId },
      select: { teacherId: true },
    });
    if (!owner) throw ApiError.notFound('班级不存在');
    createdBy = owner.teacherId;
  }

  const created = await prisma.homework.create({
    data: {
      classId: input.classId,
      courseId: input.courseId ?? null,
      title: input.title,
      content: input.content,
      attachmentUrl: input.attachmentUrl ?? null,
      // 不传日期就记成「服务器当天」；教室在 UTC+8，用本地日期而不是 UTC 日期
      assignDate: input.assignDate ?? dayKeyLocal(new Date()),
      createdBy,
    },
    include: { course: courseSelect, creator: creatorSelect, statuses: true },
  });

  const dto = toHomeworkDto(created, { withStatus: true });
  emitToClass(created.classId, SOCKET_EVENTS.homeworkNew, dto);
  return dto;
}

export async function updateHomework(
  user: TokenPayload,
  homeworkId: string,
  input: UpdateHomeworkInput,
): Promise<HomeworkDto> {
  const current = await prisma.homework.findUnique({ where: { id: homeworkId } });
  if (!current) throw ApiError.notFound('作业不存在');

  // 改科目等于把这条作业挪到另一个科目的权限域下，两端都要判
  const nextCourseId = input.courseId === undefined ? current.courseId : (input.courseId ?? null);
  await assertCanManageSubjectContent(user, current.classId, nextCourseId, '修改作业', {
    allowClassDevice: true,
  });
  if (nextCourseId) await assertCourseInClass(nextCourseId, current.classId);

  const updated = await prisma.homework.update({
    where: { id: homeworkId },
    data: {
      ...(input.title ? { title: input.title } : {}),
      ...(input.content ? { content: input.content } : {}),
      ...(input.courseId !== undefined ? { courseId: nextCourseId } : {}),
      ...(input.attachmentUrl !== undefined ? { attachmentUrl: input.attachmentUrl ?? null } : {}),
      ...(input.assignDate !== undefined ? { assignDate: input.assignDate } : {}),
    },
    include: { course: courseSelect, creator: creatorSelect, statuses: true },
  });

  const dto = toHomeworkDto(updated, { withStatus: true });
  emitToClass(updated.classId, SOCKET_EVENTS.homeworkUpdated, dto);
  return dto;
}

export async function deleteHomework(user: TokenPayload, homeworkId: string): Promise<void> {
  const current = await prisma.homework.findUnique({
    where: { id: homeworkId },
    include: { course: courseSelect, creator: creatorSelect },
  });
  if (!current) throw ApiError.notFound('作业不存在');
  await assertCanManageSubjectContent(user, current.classId, current.courseId, '删除作业', {
    allowClassDevice: true,
  });

  await prisma.homework.delete({ where: { id: homeworkId } });
  emitToClass(current.classId, SOCKET_EVENTS.homeworkUpdated, {
    ...toHomeworkDto(current),
    deleted: true,
  });
}

/* ------------------------------------------------------------------ 完成状态 */

/**
 * 标记完成 / 取消完成。
 * - ClassHelper 班级端：为**全班学生**写入完成状态（代全班操作，因此教师端的完成人数依然准确）；
 * - 教师 / 管理员：必须显式指定该班的学生（学生不是账号，不能落到操作者自己身上）。
 */
export async function updateHomeworkStatus(
  user: TokenPayload,
  homeworkId: string,
  input: UpdateHomeworkStatusInput,
): Promise<HomeworkStatusDto> {
  const homework = await prisma.homework.findUnique({ where: { id: homeworkId } });
  if (!homework) throw ApiError.notFound('作业不存在');

  await assertClassAccess(user, homework.classId);

  if (isClassDevice(user)) {
    const studentIds = await resolvePersonalIds(user);
    let result: HomeworkStatusDto | null = null;

    for (const studentId of studentIds) {
      const status = await prisma.homeworkStatus.upsert({
        where: { homeworkId_studentId: { homeworkId, studentId } },
        create: { homeworkId, studentId, completed: input.completed },
        update: { completed: input.completed },
      });
      result ??= toHomeworkStatusDto(status);
    }

    if (!result) throw ApiError.badRequest('当前班级还没有学生，请先在名单里添加学生');

    emitToClass(homework.classId, SOCKET_EVENTS.homeworkStatus, {
      ...result,
      classId: homework.classId,
    });
    return result;
  }

  // 教师 / 管理员分支：必须落到**该班学生**身上。旧实现允许不传 id 并默默写到操作者自己的账号上
  // （教师时 sub 就是教师 id），那条记录既不在学生名单里、又会被 completedCount 计入，
  // 导致"完成人数 > 班级人数"。
  if (!input.studentId) {
    throw ApiError.badRequest('请指定该作业所在班级的学生（studentId）');
  }
  const target = await prisma.student.findUnique({
    where: { id: input.studentId },
    select: { classId: true },
  });
  if (!target || target.classId !== homework.classId) {
    throw ApiError.badRequest('请指定该作业所在班级的学生（studentId）');
  }

  const status = await prisma.homeworkStatus.upsert({
    where: { homeworkId_studentId: { homeworkId, studentId: input.studentId } },
    create: { homeworkId, studentId: input.studentId, completed: input.completed },
    update: { completed: input.completed },
  });

  const dto = toHomeworkStatusDto(status);
  emitToClass(homework.classId, SOCKET_EVENTS.homeworkStatus, { ...dto, classId: homework.classId });
  return dto;
}

/* ------------------------------------------------------------------ 未交名单 */

/** 组装某次作业的全班提交名单（未交名单 = completed=false 的那些），按学号排序 */
async function buildSubmissions(classId: string, homeworkId: string): Promise<HomeworkSubmissionsDto> {
  const [students, statuses] = await Promise.all([
    prisma.student.findMany({
      where: { classId, archivedYearId: null },
      select: { id: true, name: true, studentNo: true },
      orderBy: { studentNo: 'asc' },
    }),
    prisma.homeworkStatus.findMany({ where: { homeworkId }, select: { studentId: true, completed: true } }),
  ]);
  const completedBy = new Map(statuses.map((item) => [item.studentId, item.completed]));
  const list: HomeworkSubmissionDto[] = students.map((item) => ({
    studentId: item.id,
    studentNo: item.studentNo,
    name: item.name || item.studentNo,
    completed: completedBy.get(item.id) === true,
  }));
  return {
    homeworkId,
    classId,
    total: list.length,
    completedCount: list.filter((item) => item.completed).length,
    notSubmitted: list.filter((item) => !item.completed),
    students: list,
  };
}

/** 只有教师 / 管理员 / ClassHelper 班级端可以维护"未交名单" */
function assertCanManageSubmissions(user: TokenPayload): void {
  if (user.role === 'ADMIN' || user.role === 'TEACHER') return;
  if (isClassDevice(user)) return;
  throw ApiError.forbidden('只有教师或 ClassHelper 班级端可以维护未交名单');
}

/** 读取作业提交名单（教师 / 班级端） */
export async function listHomeworkSubmissions(
  user: TokenPayload,
  homeworkId: string,
): Promise<HomeworkSubmissionsDto> {
  const homework = await prisma.homework.findUnique({
    where: { id: homeworkId },
    select: { id: true, classId: true },
  });
  if (!homework) throw ApiError.notFound('作业不存在');
  await assertClassAccess(user, homework.classId);
  assertCanManageSubmissions(user);
  return buildSubmissions(homework.classId, homeworkId);
}

/**
 * 保存"未交名单"：勾选的学生标记未完成，其余学生一律标记完成。
 * 这样教室机器的操作语义是"点名谁没交"，比逐个勾"谁交了"更省事。
 */
export async function updateHomeworkSubmissions(
  user: TokenPayload,
  homeworkId: string,
  input: UpdateHomeworkSubmissionsInput,
): Promise<HomeworkSubmissionsDto> {
  const homework = await prisma.homework.findUnique({
    where: { id: homeworkId },
    select: { id: true, classId: true },
  });
  if (!homework) throw ApiError.notFound('作业不存在');
  await assertClassAccess(user, homework.classId);
  assertCanManageSubmissions(user);

  const students = await prisma.student.findMany({
    where: { classId: homework.classId, archivedYearId: null },
    select: { id: true },
  });
  if (students.length === 0) throw ApiError.badRequest('当前班级还没有学生，请先在名单里添加学生');

  const notSubmitted = new Set(input.notSubmittedStudentIds);
  const studentIds = new Set(students.map((item) => item.id));
  const outsiders = [...notSubmitted].filter((id) => !studentIds.has(id));
  if (outsiders.length > 0) throw ApiError.badRequest('未交名单里包含非本班学生');

  await prisma.$transaction(
    students.map((item) =>
      prisma.homeworkStatus.upsert({
        where: { homeworkId_studentId: { homeworkId, studentId: item.id } },
        create: { homeworkId, studentId: item.id, completed: !notSubmitted.has(item.id) },
        update: { completed: !notSubmitted.has(item.id) },
      }),
    ),
  );

  const result = await buildSubmissions(homework.classId, homeworkId);
  // 实时刷新教师端/班级端的完成情况
  emitToClass(homework.classId, SOCKET_EVENTS.homeworkStatus, {
    homeworkId,
    classId: homework.classId,
    completedCount: result.completedCount,
    total: result.total,
  });
  return result;
}

async function assertCourseInClass(courseId: string, classId: string): Promise<void> {
  const course = await prisma.course.findUnique({ where: { id: courseId }, select: { classId: true } });
  if (!course) throw ApiError.badRequest('课程不存在');
  if (course.classId !== classId) throw ApiError.badRequest('该课程不属于所选班级');
}
