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
import { toNotificationDto } from '../../lib/mappers.js';
import { emitToClass } from '../../realtime/bus.js';
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

/** 发布通知并实时广播到 class:{classId} 房间 */
export async function createNotification(
  user: TokenPayload,
  input: CreateNotificationInput,
): Promise<NotificationDto> {
  await assertClassWritable(user, input.classId);

  const created = await prisma.notification.create({
    data: {
      classId: input.classId,
      title: input.title,
      content: input.content,
      priority: input.priority ?? 'NORMAL',
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
