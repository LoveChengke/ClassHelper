import {
  SOCKET_EVENTS,
  dayKeyLocal,
  type BulkCreateNotificationRequest,
  type BulkPublishClassResult,
  type BulkPublishResult,
  type NotificationCreatorSummary,
  type NotificationCreatorsDto,
  type NotificationDaysDto,
  type NotificationDto,
} from '@classhelper/shared';
import { normalizeBulkClassIds, summarizeBulk, toBulkFailure } from '../../lib/bulk.js';
import {
  assertClassAccess,
  assertCanPublishNotification,
  classScopeWhere,
  resolveClassScope,
} from '../../lib/access.js';
import { prisma } from '../../lib/db.js';
import { ApiError } from '../../lib/http.js';
import type { TokenPayload } from '../../lib/jwt.js';
import { logger } from '../../lib/logger.js';
import { toNotificationDto } from '../../lib/mappers.js';
import { personalIdWhere, resolvePersonalIds } from '../../lib/session.js';
import { emitToClass } from '../../realtime/bus.js';
import { computeClassStatus } from '../schedules/schedules.service.js';
import type { CreateNotificationInput } from './notifications.schemas.js';

const creatorSelect = { select: { id: true, name: true, username: true } } as const;

export interface ListNotificationOptions {
  classId?: string;
  priority?: string;
  unreadOnly?: boolean;
  keyword?: string;
  date?: string;
  from?: string;
  to?: string;
  createdBy?: string;
}

/** 归档筛选条件：按天 / 日期区间 / 发布人 / 优先级（assignDate 是本地日期字符串，字典序即时间序） */
function archiveWhere(options: {
  priority?: string;
  createdBy?: string;
  date?: string;
  from?: string;
  to?: string;
}): Record<string, unknown> {
  if (options.date) {
    return {
      ...(options.priority ? { priority: options.priority } : {}),
      ...(options.createdBy ? { createdBy: options.createdBy } : {}),
      assignDate: options.date,
    };
  }

  const range = {
    ...(options.from ? { gte: options.from } : {}),
    ...(options.to ? { lte: options.to } : {}),
  };
  return {
    ...(options.priority ? { priority: options.priority } : {}),
    ...(options.createdBy ? { createdBy: options.createdBy } : {}),
    ...(Object.keys(range).length > 0 ? { assignDate: range } : {}),
  };
}

export async function listNotifications(
  user: TokenPayload,
  options: ListNotificationOptions,
): Promise<NotificationDto[]> {
  const scope = await resolveClassScope(user, options.classId);
  const isStaff = user.role === 'ADMIN' || user.role === 'TEACHER';
  // 班级账号（班级设备）以全班学生为"个人范围"，普通学生就是自己
  const personalIds = await resolvePersonalIds(user);
  const personalWhere = personalIdWhere(personalIds);

  const notifications = await prisma.notification.findMany({
    where: {
      ...classScopeWhere(scope),
      ...archiveWhere(options),
      ...(options.keyword
        ? { OR: [{ title: { contains: options.keyword } }, { content: { contains: options.keyword } }] }
        : {}),
      ...(options.unreadOnly ? { reads: { none: personalWhere } } : {}),
    },
    include: {
      creator: creatorSelect,
      reads: isStaff ? true : { where: personalWhere },
    },
    orderBy: [{ createdAt: 'desc' }],
    take: 200,
  });

  return notifications.map((item) =>
    toNotificationDto(item, { studentIds: personalIds, withStatus: isStaff }),
  );
}

/**
 * 按天归档：列出「有通知的日期 + 当天条数」，供 Web 端左侧日期栏使用。
 *
 * 用 `assignDate`（本地日期）而不是 `createdAt`：晚上发的通知不该被算到第二天。
 * 传了 `date` 也刻意忽略 —— 日期栏是"归档索引"，不该被当前选中的那天过滤掉。
 */
export async function listNotificationDays(
  user: TokenPayload,
  options: { classId?: string; priority?: string; createdBy?: string; from?: string; to?: string },
): Promise<NotificationDaysDto> {
  const scope = await resolveClassScope(user, options.classId);
  const grouped = await prisma.notification.groupBy({
    by: ['assignDate'],
    where: { ...classScopeWhere(scope), ...archiveWhere(options) },
    _count: { _all: true },
  });

  const days = grouped
    .map((item) => ({ date: item.assignDate, count: item._count._all }))
    .filter((item) => item.date !== '')
    .sort((left, right) => right.date.localeCompare(left.date));

  return { days };
}

/** 按发布人归档：列出当前筛选范围内的发布人及其条数（供"按发布人看通知"用） */
export async function listNotificationCreators(
  user: TokenPayload,
  options: { classId?: string; priority?: string; date?: string; from?: string; to?: string },
): Promise<NotificationCreatorsDto> {
  const scope = await resolveClassScope(user, options.classId);
  const grouped = await prisma.notification.groupBy({
    by: ['createdBy'],
    where: { ...classScopeWhere(scope), ...archiveWhere(options) },
    _count: { _all: true },
  });

  const owners = await prisma.user.findMany({
    where: { id: { in: grouped.map((item) => item.createdBy) } },
    select: { id: true, name: true, username: true },
  });

  const creators: NotificationCreatorSummary[] = grouped
    .map((item) => {
      const owner = owners.find((candidate) => candidate.id === item.createdBy);
      return {
        id: item.createdBy,
        name: owner?.name ?? '未知用户',
        username: owner?.username ?? '',
        count: item._count._all,
      };
    })
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name, 'zh-CN'));

  return { creators };
}

/**
 * 批量发布通知：一次给多个班级发同一条内容。
 *
 * 逐班串行调用 `createNotification`（复用同一套权限断言 + 上课保护 + 实时广播），
 * 某个班失败只记进结果，不影响其他班 —— 前端拿到逐班结果后自己决定怎么展示与重试。
 */
export async function bulkCreateNotifications(
  user: TokenPayload,
  input: BulkCreateNotificationRequest,
): Promise<BulkPublishResult> {
  const classIds = normalizeBulkClassIds(input.classIds);
  const results: BulkPublishClassResult[] = [];

  for (const classId of classIds) {
    try {
      const dto = await createNotification(user, {
        classId,
        title: input.title,
        content: input.content,
        priority: input.priority,
        confirmDuringClass: input.confirmDuringClass,
      });
      results.push({ classId, ok: true, id: dto.id });
    } catch (error) {
      results.push(toBulkFailure(classId, error, '发布通知'));
    }
  }

  const summary = summarizeBulk(results);
  logger.info(
    `批量发布通知：目标 ${summary.total} 个班级，成功 ${summary.succeeded} 个，失败 ${summary.failed} 个（发起人=${user.username}）`,
  );
  return summary;
}

/**
 * 发布通知并实时广播到 class:{classId} 房间。
 *
 * 上课时段保护：若目标班级当前正在上课且优先级为"紧急"，必须由前端二次确认
 * （`confirmDuringClass: true`）才允许发布，否则返回 409 URGENT_DURING_CLASS，
 * 由 Web 端弹出全屏警告并倒计时 3 秒。
 */
export async function createNotification(
  user: TokenPayload,
  input: CreateNotificationInput,
): Promise<NotificationDto> {
  await assertCanPublishNotification(user, input.classId);

  const priority = input.priority ?? 'NORMAL';
  if (priority === 'URGENT' && input.confirmDuringClass !== true) {
    const status = await computeClassStatus(input.classId);
    if (status.inClass) {
      logger.warn(
        `上课时段发布紧急通知被拦截：班级=${input.classId} 课程=${status.current?.courseName ?? '-'}（等待教师二次确认）`,
      );
      throw new ApiError(409, 'URGENT_DURING_CLASS', '现在为上课时间段，发布紧急通知会干扰上课，请再次确认', {
        classId: input.classId,
        current: status.current,
        next: status.next,
        week: status.week,
        serverTime: status.serverTime,
      });
    }
  }

  const created = await prisma.notification.create({
    data: {
      classId: input.classId,
      title: input.title,
      content: input.content,
      priority,
      createdBy: user.sub,
      // 按天归档用「本地日期」：晚间发布的通知不会被 UTC 切片算到第二天（与作业同口径）
      assignDate: dayKeyLocal(new Date()),
    },
    include: { creator: creatorSelect, reads: true },
  });

  const dto = toNotificationDto(created, { withStatus: true });
  emitToClass(created.classId, SOCKET_EVENTS.notificationNew, dto);

  return dto;
}

export async function deleteNotification(user: TokenPayload, notificationId: string): Promise<void> {
  const current = await prisma.notification.findUnique({ where: { id: notificationId } });
  if (!current) throw ApiError.notFound('通知不存在');
  await assertCanPublishNotification(user, current.classId);
  await prisma.notification.delete({ where: { id: notificationId } });
  emitToClass(current.classId, SOCKET_EVENTS.notificationDeleted, {
    id: notificationId,
    classId: current.classId,
  });
}

/**
 * 标记单条通知已读。
 * 班级账号：为全班学生写入已读记录（班级设备代全班操作），教师端的已读人数随之更新。
 */
export async function markAsRead(
  user: TokenPayload,
  notificationId: string,
): Promise<{ notificationId: string; readAt: string; marked: number }> {
  const notification = await prisma.notification.findUnique({ where: { id: notificationId } });
  if (!notification) throw ApiError.notFound('通知不存在');
  await assertClassAccess(user, notification.classId);

  const personalIds = await resolvePersonalIds(user);
  // 先过滤已读过的记录再创建：SQLite 下 createMany 不支持 skipDuplicates，
  // 直接 createMany 遇到重复会整体失败。
  const existing = await prisma.notificationRead.findMany({
    where: { notificationId, studentId: { in: personalIds } },
    select: { studentId: true },
  });
  const have = new Set(existing.map((item) => item.studentId));
  const missing = personalIds.filter((studentId) => !have.has(studentId));

  if (missing.length > 0) {
    await prisma.notificationRead.createMany({
      data: missing.map((studentId) => ({ notificationId, studentId })),
    });
  }

  return { notificationId, readAt: new Date().toISOString(), marked: missing.length };
}

/** 全部标为已读（可按班级限定） */
export async function markAllAsRead(user: TokenPayload, classId?: string): Promise<{ marked: number }> {
  const scope = await resolveClassScope(user, classId);
  const personalIds = await resolvePersonalIds(user);
  const personalWhere = personalIdWhere(personalIds);

  const pending = await prisma.notification.findMany({
    where: { ...classScopeWhere(scope), reads: { none: personalWhere } },
    select: { id: true },
  });

  let marked = 0;
  for (const item of pending) {
    const existing = await prisma.notificationRead.findMany({
      where: { notificationId: item.id, studentId: { in: personalIds } },
      select: { studentId: true },
    });
    const have = new Set(existing.map((row) => row.studentId));
    const missing = personalIds.filter((studentId) => !have.has(studentId));
    if (missing.length === 0) continue;

    await prisma.notificationRead.createMany({
      data: missing.map((studentId) => ({ notificationId: item.id, studentId })),
    });
    marked += missing.length;
  }

  return { marked };
}

/** 未读数量（客户端红点） */
export async function unreadCount(user: TokenPayload, classId?: string): Promise<number> {
  const scope = await resolveClassScope(user, classId);
  const personalIds = await resolvePersonalIds(user);
  return prisma.notification.count({
    where: { ...classScopeWhere(scope), reads: { none: personalIdWhere(personalIds) } },
  });
}
