import { z } from 'zod';
import { isDayKey } from '@classhelper/shared';
import { booleanFlagSchema } from '../../lib/schemas.js';

export const notificationPrioritySchema = z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']);

/** 本地日期（YYYY-MM-DD）：按天归档/筛选用它，不要用 createdAt 的 UTC 切片 */
const dayKeySchema = z
  .string()
  .trim()
  .refine(isDayKey, { message: '日期格式应为 YYYY-MM-DD' });

export const listNotificationsQuerySchema = z.object({
  classId: z.string().min(1).optional(),
  priority: notificationPrioritySchema.optional(),
  unreadOnly: booleanFlagSchema,
  keyword: z.string().trim().max(64).optional(),
  /** 只看某一天；与 from/to 二选一 */
  date: dayKeySchema.optional(),
  /** 日期区间（含边界） */
  from: dayKeySchema.optional(),
  to: dayKeySchema.optional(),
  /** 只看某位发布人 */
  createdBy: z.string().min(1).optional(),
});

/** GET /notifications/days 与 GET /notifications/creators 的筛选条件（不含 date 自身） */
export const notificationArchiveQuerySchema = z.object({
  classId: z.string().min(1).optional(),
  priority: notificationPrioritySchema.optional(),
  createdBy: z.string().min(1).optional(),
  from: dayKeySchema.optional(),
  to: dayKeySchema.optional(),
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

/**
 * 一次给多个班级发同一条通知（批量发布）。
 *
 * 上限 50 个班是刻意设的：批量发布是逐班串行落库 + 逐班推 ClassIsland，
 * 一次塞几百个班会长时间占住请求，也会把教室大屏刷屏。
 */
export const bulkCreateNotificationSchema = z.object({
  classIds: z
    .array(z.string().min(1))
    .min(1, '请至少选择一个班级')
    .max(50, '一次最多发布 50 个班级'),
  title: z.string().trim().min(1, '请输入通知标题').max(120),
  content: z.string().min(1, '请输入通知内容').max(5000),
  priority: notificationPrioritySchema.optional(),
  confirmDuringClass: z.boolean().optional(),
});

export type CreateNotificationInput = z.infer<typeof createNotificationSchema>;
export type NotificationPriorityInput = z.infer<typeof notificationPrioritySchema>;
export type ListNotificationQuery = z.infer<typeof listNotificationsQuerySchema>;
export type NotificationArchiveQuery = z.infer<typeof notificationArchiveQuerySchema>;
export type BulkCreateNotificationInput = z.infer<typeof bulkCreateNotificationSchema>;
