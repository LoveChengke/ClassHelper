import { SOCKET_EVENTS, type NotificationDto } from '@classhelper/shared';
import {
  assertClassAccess,
  assertClassWritable,
  classScopeWhere,
  resolveClassScope,
} from '../../lib/access.js';
import { prisma } from '../../lib/db.js';
import { ApiError } from '../../lib/http.js';
import type { TokenPayload } from '../../lib/jwt.js';
import { logger } from '../../lib/logger.js';
import { toNotificationDto } from '../../lib/mappers.js';
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

  const notifications = await prisma.notification.findMany({
    where: {
      ...classScopeWhere(scope),
      ...(options.priority ? { priority: options.priority } : {}),
      ...(options.keyword
        ? { OR: [{ title: { contains: options.keyword } }, { content: { contains: options.keyword } }] }
        : {}),
      ...(options.unreadOnly ? { reads: { none: { userId: user.sub } } } : {}),
    },
    include: {
      creator: creatorSelect,
      reads: isStaff ? true : { where: { userId: user.sub } },
    },
    orderBy: [{ createdAt: 'desc' }],
    take: 200,
  });

  return notifications.map((item) => toNotificationDto(item, { userId: user.sub, withStatus: isStaff }));
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
  await assertClassWritable(user, input.classId);

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
  await assertClassWritable(user, current.classId);
  await prisma.notification.delete({ where: { id: notificationId } });
}

/** 标记单条通知已读 */
export async function markAsRead(
  user: TokenPayload,
  notificationId: string,
): Promise<{ notificationId: string; readAt: string }> {
  const notification = await prisma.notification.findUnique({ where: { id: notificationId } });
  if (!notification) throw ApiError.notFound('通知不存在');
  await assertClassAccess(user, notification.classId);

  const read = await prisma.notificationRead.upsert({
    where: { notificationId_userId: { notificationId, userId: user.sub } },
    create: { notificationId, userId: user.sub },
    update: {},
  });

  return { notificationId, readAt: read.readAt.toISOString() };
}

/** 全部标为已读（可按班级限定） */
export async function markAllAsRead(user: TokenPayload, classId?: string): Promise<{ marked: number }> {
  const scope = await resolveClassScope(user, classId);

  const pending = await prisma.notification.findMany({
    where: { ...classScopeWhere(scope), reads: { none: { userId: user.sub } } },
    select: { id: true },
  });

  for (const item of pending) {
    await prisma.notificationRead.upsert({
      where: { notificationId_userId: { notificationId: item.id, userId: user.sub } },
      create: { notificationId: item.id, userId: user.sub },
      update: {},
    });
  }

  return { marked: pending.length };
}

/** 未读数量（客户端红点） */
export async function unreadCount(user: TokenPayload, classId?: string): Promise<number> {
  const scope = await resolveClassScope(user, classId);
  return prisma.notification.count({
    where: { ...classScopeWhere(scope), reads: { none: { userId: user.sub } } },
  });
}
