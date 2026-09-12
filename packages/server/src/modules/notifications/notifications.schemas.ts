import { z } from 'zod';
import { booleanFlagSchema } from '../../lib/schemas.js';

export const notificationPrioritySchema = z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']);

export const listNotificationsQuerySchema = z.object({
  classId: z.string().min(1).optional(),
  priority: notificationPrioritySchema.optional(),
  unreadOnly: booleanFlagSchema,
  keyword: z.string().trim().max(64).optional(),
});

export const createNotificationSchema = z.object({
  classId: z.string().min(1, '请选择班级'),
  title: z.string().trim().min(1, '请输入通知标题').max(120),
  content: z.string().min(1, '请输入通知内容').max(5000),
  priority: notificationPrioritySchema.optional(),
  /**
   * 上课时间段内发布"紧急"通知时必须显式确认（教师已在全屏警告中二次确认）。
   * 未确认时服务端返回 409 URGENT_DURING_CLASS 及当前课程信息。
   */
  confirmDuringClass: z.boolean().optional(),
});

export const notificationScopeQuerySchema = z.object({
  classId: z.string().min(1).optional(),
});

export type CreateNotificationInput = z.infer<typeof createNotificationSchema>;
export type NotificationPriorityInput = z.infer<typeof notificationPrioritySchema>;
