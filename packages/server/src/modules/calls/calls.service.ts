import { SOCKET_EVENTS, buildCallTitle, type NotificationDto } from '@classhelper/shared';
import { assertCanPublishNotification } from '../../lib/access.js';
import { prisma } from '../../lib/db.js';
import { ApiError } from '../../lib/http.js';
import type { TokenPayload } from '../../lib/jwt.js';
import { logger } from '../../lib/logger.js';
import { toNotificationDto } from '../../lib/mappers.js';
import { emitToClass, emitToSession } from '../../realtime/bus.js';
import { pushToClassIsland, shouldPushToClassIsland } from '../integrations/integrations.service.js';
import type { CreateCallInput } from './calls.schemas.js';

const creatorSelect = { select: { id: true, name: true, username: true } } as const;

/**
 * "叫人"：老师点名让某位同学去找他。
 *
 * 设计：复用通知表落库（通知中心可见、已读状态天然可用、离线也能看到历史），
 * 同时额外广播 `call:new`，客户端据此把消息标记为"叫人"类型（徽标/按钮/尺寸）。
 * **是否立即展开由 priority 决定**：
 * - 紧急叫人（urgent=true → URGENT）：无视上课时段立即展开；
 * - 普通叫人（默认 → HIGH）：按普通通知处理，上课时段只进队列、下课后弹出，
 *   课间则先显示胶囊、点击后展开。
 * 两种情况都不会被"上课时段发布紧急通知"的 409 拦截（老师确实需要学生过来）。
 *
 * 注：学生不是账号，没有"学生自己的客户端"，因此 `call:new` 只发给
 * **教室机器**（ClassHelper 班级端，会话房间以班级 id 为键）—— 学生姓名在标题里，
 * 全班都看得到在叫谁，这与需求「教室机器代全班」一致。
 */
export async function createCall(user: TokenPayload, input: CreateCallInput): Promise<NotificationDto> {
  await assertCanPublishNotification(user, input.classId);

  const student = await prisma.student.findUnique({
    where: { id: input.studentId },
    select: { id: true, name: true, studentNo: true, classId: true },
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
  const studentName = student.name || student.studentNo;
  const message = input.message?.trim() || input.quickPhrase?.trim() || '请尽快到老师这里来';

  const created = await prisma.notification.create({
    data: {
      classId: input.classId,
      title: buildCallTitle(studentName, teacherName),
      content: message,
      // 紧急叫人 → URGENT（客户端无视上课时段立即展开）；普通叫人 → HIGH
      // （不会触发上课时段 409 拦截，但客户端按普通通知排队处理）
      priority: input.urgent ? 'URGENT' : 'HIGH',
      createdBy: user.sub,
    },
    include: { creator: creatorSelect, reads: true },
  });

  const dto = toNotificationDto(created, { studentId: student.id, withStatus: true });
  // 班级房间广播：通知中心都能看到
  emitToClass(created.classId, SOCKET_EVENTS.notificationNew, dto);
  // 定向广播给教室机器：会话房间以**班级 id** 为键，叫人消息因此立即展开
  emitToSession(created.classId, SOCKET_EVENTS.callNew, dto);

  // 叫人同样推到教室的 ClassIsland：老师点名时，教室大屏也弹一条（学生姓名在标题里）。
  // 显示位置由班级端决定；推送失败不影响叫人本身。
  try {
    if (await shouldPushToClassIsland(input.classId)) {
      await pushToClassIsland({
        classId: input.classId,
        title: created.title,
        content: created.content,
        urgent: input.urgent === true,
        // 叫人属于「主动通知」：教室的 ClassIsland 上课时段也要立刻弹
        kind: 'call',
        createdBy: user.sub,
        notificationId: created.id,
        teacherName,
      });
    }
  } catch (error) {
    logger.warn(`叫人推送 ClassIsland 失败（叫人本身已发出）：${String(error)}`);
  }

  logger.info(`${input.urgent ? '紧急叫人' : '叫人'}：${teacherName} → ${studentName}（${message}）`);
  return dto;
}
