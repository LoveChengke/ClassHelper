import { SOCKET_EVENTS, buildCallTitle, type NotificationDto } from '@classhelper/shared';
import { assertCanPublishContent } from '../../lib/access.js';
import { prisma } from '../../lib/db.js';
import { ApiError } from '../../lib/http.js';
import type { TokenPayload } from '../../lib/jwt.js';
import { logger } from '../../lib/logger.js';
import { toNotificationDto } from '../../lib/mappers.js';
import { emitToClass, emitToUser } from '../../realtime/bus.js';
import type { CreateCallInput } from './calls.schemas.js';

const creatorSelect = { select: { id: true, name: true, username: true } } as const;

/**
 * "叫人"：老师点名让某位同学去找他。
 *
 * 设计：复用通知表落库（学生端通知中心可见、已读状态天然可用、离线也能看到历史），
 * 同时额外广播 `call:new` 到该学生的 user 房间 —— 客户端据此把消息标记为
 * "叫人"类型，无论是否在上课都立即展开显示。
 */
export async function createCall(user: TokenPayload, input: CreateCallInput): Promise<NotificationDto> {
  await assertCanPublishContent(user, input.classId);

  const student = await prisma.user.findUnique({
    where: { id: input.studentId },
    select: { id: true, name: true, username: true, classId: true },
  });
  if (!student) throw ApiError.notFound('学生不存在');
  if (student.classId !== input.classId) {
    throw new ApiError(400, 'BAD_REQUEST', '该学生不在所选班级');
  }

  const teacher = await prisma.user.findUnique({
    where: { id: user.sub },
    select: { name: true, username: true },
  });
  const teacherName = teacher?.name ?? teacher?.username ?? '老师';
  const studentName = student.name || student.username;
  const message = input.message?.trim() || input.quickPhrase?.trim() || '请尽快到老师这里来';

  const created = await prisma.notification.create({
    data: {
      classId: input.classId,
      title: buildCallTitle(studentName, teacherName),
      content: message,
      // 叫人属于需要立即响应的消息，用 HIGH 级别（不会触发上课时段 409 拦截）
      priority: 'HIGH',
      createdBy: user.sub,
    },
    include: { creator: creatorSelect, reads: true },
  });

  const dto = toNotificationDto(created, { userIds: [student.id], withStatus: true });
  // 班级房间广播：通知中心/其他端都能看到
  emitToClass(created.classId, SOCKET_EVENTS.notificationNew, dto);
  // 定向广播给被叫的学生：个人学生端灵动岛立即展开
  emitToUser(student.id, SOCKET_EVENTS.callNew, dto);
  // 同时广播到 classId 对应的 user 房间：班级账号（班级设备）以此房间登录，
  // 因此"叫人"消息在班级设备上也会立即展开（学生姓名在标题里，全班都能看到叫谁）
  emitToUser(created.classId, SOCKET_EVENTS.callNew, dto);

  logger.info(`叫人：${teacherName} → ${studentName}（${message}）`);
  return dto;
}
