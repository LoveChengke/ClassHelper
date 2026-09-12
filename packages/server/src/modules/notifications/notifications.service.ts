import { SOCKET_EVENTS, type NotificationDto } from '@classhelper/shared';
import {
  assertClassAccess,
  assertCanPublishContent,
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
      ...(options.priority ? { priority: options.priority } : {}),
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

  return notifications.map((item) => toNotificationDto(item, { userIds: personalIds, withStatus: isStaff }));
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
  await assertCanPublishContent(user, input.classId);

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
    },
    include: { creator: creatorSelect, reads: true },
  });

  const dto = toNotificationDto(created, { userId: user.sub, withStatus: true });
  emitToClass(created.classId, SOCKET_EVENTS.notificationNew, dto);
  return dto;
}

export async function deleteNotification(user: TokenPayload, notificationId: string): Promise<void> {
  const current = await prisma.notification.findUnique({ where: { id: notificationId } });
  if (!current) throw ApiError.notFound('通知不存在');
  await assertCanPublishContent(user, current.classId);
  await prisma.notification.delete({ where: { id: notificationId } });
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
    where: { notificationId, userId: { in: personalIds } },
    select: { userId: true },
  });
  const have = new Set(existing.map((item) => item.userId));
  const missing = personalIds.filter((userId) => !have.has(userId));

  if (missing.length > 0) {
    await prisma.notificationRead.createMany({
      data: missing.map((userId) => ({ notificationId, userId })),
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
      where: { notificationId: item.id, userId: { in: personalIds } },
      select: { userId: true },
    });
    const have = new Set(existing.map((row) => row.userId));
    const missing = personalIds.filter((userId) => !have.has(userId));
    if (missing.length === 0) continue;

    await prisma.notificationRead.createMany({
      data: missing.map((userId) => ({ notificationId: item.id, userId })),
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
