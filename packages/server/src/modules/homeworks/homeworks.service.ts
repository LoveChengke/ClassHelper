import { SOCKET_EVENTS, type HomeworkDto, type HomeworkStatusDto } from '@classhelper/shared';
import {
  assertCanPublishContent,
  assertClassAccess,
  classScopeWhere,
  isStudent,
  resolveClassScope,
} from '../../lib/access.js';
import { prisma } from '../../lib/db.js';
import { ApiError } from '../../lib/http.js';
import type { TokenPayload } from '../../lib/jwt.js';
import { toHomeworkDto, toHomeworkStatusDto } from '../../lib/mappers.js';
import { parseOptionalDate } from '../../lib/schemas.js';
import { personalIdWhere, resolvePersonalIds } from '../../lib/session.js';
import { emitToClass } from '../../realtime/bus.js';
import type {
  CreateHomeworkInput,
  UpdateHomeworkInput,
  UpdateHomeworkStatusInput,
} from './homeworks.schemas.js';

const courseSelect = { select: { id: true, name: true } } as const;
const creatorSelect = { select: { id: true, name: true, username: true } } as const;

export interface ListHomeworkOptions {
  classId?: string;
  courseId?: string;
  pendingOnly?: boolean;
  keyword?: string;
}

/**
 * 作业列表。
 * - 学生：附带自己的完成状态，可通过 pendingOnly 只看未完成
 * - 教师/管理员：附带完成人数统计
 */
export async function listHomeworks(
  user: TokenPayload,
  options: ListHomeworkOptions,
): Promise<HomeworkDto[]> {
  const scope = await resolveClassScope(user, options.classId);
  const student = isStudent(user);
  // 班级账号（班级设备）以全班学生为范围；普通学生即自己
  const personalIds = student ? await resolvePersonalIds(user) : [];
  const personalWhere = personalIdWhere(personalIds);

  const homeworks = await prisma.homework.findMany({
    where: {
      ...classScopeWhere(scope),
      ...(options.courseId ? { courseId: options.courseId } : {}),
      ...(options.keyword
        ? { OR: [{ title: { contains: options.keyword } }, { content: { contains: options.keyword } }] }
        : {}),
      ...(student && options.pendingOnly
        ? { statuses: { none: { ...personalWhere, completed: true } } }
        : {}),
    },
    include: {
      course: courseSelect,
      creator: creatorSelect,
      statuses: student ? { where: personalWhere } : true,
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });

  return homeworks.map((item) =>
    toHomeworkDto(item, { userIds: student ? personalIds : [], withStatus: !student }),
  );
}

export async function getHomework(user: TokenPayload, homeworkId: string): Promise<HomeworkDto> {
  const student = isStudent(user);
  const personalIds = student ? await resolvePersonalIds(user) : [];
  const homework = await prisma.homework.findUnique({
    where: { id: homeworkId },
    include: {
      course: courseSelect,
      creator: creatorSelect,
      statuses: student ? { where: personalIdWhere(personalIds) } : true,
    },
  });
  if (!homework) throw ApiError.notFound('作业不存在');
  await assertClassAccess(user, homework.classId);

  return toHomeworkDto(homework, {
    userIds: student ? personalIds : [],
    withStatus: !student,
  });
}

/** 发布作业并实时推送到班级房间 */
export async function createHomework(user: TokenPayload, input: CreateHomeworkInput): Promise<HomeworkDto> {
  await assertCanPublishContent(user, input.classId);
  if (input.courseId) await assertCourseInClass(input.courseId, input.classId);

  const created = await prisma.homework.create({
    data: {
      classId: input.classId,
      courseId: input.courseId ?? null,
      title: input.title,
      content: input.content,
      attachmentUrl: input.attachmentUrl ?? null,
      dueAt: parseOptionalDate(input.dueAt),
      createdBy: user.sub,
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
  await assertCanPublishContent(user, current.classId);

  if (input.courseId) await assertCourseInClass(input.courseId, current.classId);

  const updated = await prisma.homework.update({
    where: { id: homeworkId },
    data: {
      ...(input.title ? { title: input.title } : {}),
      ...(input.content ? { content: input.content } : {}),
      ...(input.courseId !== undefined ? { courseId: input.courseId ?? null } : {}),
      ...(input.attachmentUrl !== undefined ? { attachmentUrl: input.attachmentUrl ?? null } : {}),
      ...(input.dueAt !== undefined ? { dueAt: parseOptionalDate(input.dueAt) } : {}),
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
  await assertCanPublishContent(user, current.classId);

  await prisma.homework.delete({ where: { id: homeworkId } });
  emitToClass(current.classId, SOCKET_EVENTS.homeworkUpdated, {
    ...toHomeworkDto(current),
    deleted: true,
  });
}

/**
 * 标记完成 / 取消完成。
 * - 普通学生：标记自己；
 * - 班级账号（班级设备）：为全班学生写入完成状态（代全班操作）；
 * - 教师 / 管理员：可代指定学生标记。
 */
export async function updateHomeworkStatus(
  user: TokenPayload,
  homeworkId: string,
  input: UpdateHomeworkStatusInput,
): Promise<HomeworkStatusDto> {
  const homework = await prisma.homework.findUnique({ where: { id: homeworkId } });
  if (!homework) throw ApiError.notFound('作业不存在');

  await assertClassAccess(user, homework.classId);

  if (isStudent(user)) {
    const personalIds = await resolvePersonalIds(user);
    let result: {
      id: string;
      homeworkId: string;
      userId: string;
      completed: boolean;
      updatedAt: Date;
    } | null = null;

    for (const userId of personalIds) {
      const status = await prisma.homeworkStatus.upsert({
        where: { homeworkId_userId: { homeworkId, userId } },
        create: { homeworkId, userId, completed: input.completed },
        update: { completed: input.completed },
      });
      result ??= status;
    }

    if (!result) throw ApiError.forbidden('当前班级还没有学生账号，无法标记作业完成状态');

    const dto = toHomeworkStatusDto(result);
    emitToClass(homework.classId, SOCKET_EVENTS.homeworkStatus, { ...dto, classId: homework.classId });
    return dto;
  }

  const targetUserId = input.userId ?? user.sub;
  if (input.userId) {
    const target = await prisma.user.findUnique({ where: { id: targetUserId }, select: { classId: true } });
    if (!target || target.classId !== homework.classId) {
      throw ApiError.badRequest('目标学生不属于该作业所在班级');
    }
  }

  const status = await prisma.homeworkStatus.upsert({
    where: { homeworkId_userId: { homeworkId, userId: targetUserId } },
    create: { homeworkId, userId: targetUserId, completed: input.completed },
    update: { completed: input.completed },
  });

  const dto = toHomeworkStatusDto(status);
  emitToClass(homework.classId, SOCKET_EVENTS.homeworkStatus, { ...dto, classId: homework.classId });
  return dto;
}

async function assertCourseInClass(courseId: string, classId: string): Promise<void> {
  const course = await prisma.course.findUnique({ where: { id: courseId }, select: { classId: true } });
  if (!course) throw ApiError.badRequest('课程不存在');
  if (course.classId !== classId) throw ApiError.badRequest('该课程不属于所选班级');
}
