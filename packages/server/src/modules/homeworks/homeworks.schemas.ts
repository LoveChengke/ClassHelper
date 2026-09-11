import { z } from 'zod';
import { booleanFlagSchema, optionalDateTimeSchema } from '../../lib/schemas.js';

export const listHomeworksQuerySchema = z.object({
  classId: z.string().min(1).optional(),
  courseId: z.string().min(1).optional(),
  /** 学生端：只看未完成 */
  pendingOnly: booleanFlagSchema,
  keyword: z.string().trim().max(64).optional(),
});

export const createHomeworkSchema = z.object({
  classId: z.string().min(1, '请选择班级'),
  courseId: z.string().min(1).nullish(),
  title: z.string().trim().min(1, '请输入作业标题').max(120),
  content: z.string().min(1, '请输入作业内容').max(5000),
  attachmentUrl: z.string().trim().max(500).nullish(),
  dueAt: optionalDateTimeSchema,
});

export const updateHomeworkSchema = z.object({
  courseId: z.string().min(1).nullish(),
  title: z.string().trim().min(1).max(120).optional(),
  content: z.string().min(1).max(5000).optional(),
  attachmentUrl: z.string().trim().max(500).nullish(),
  dueAt: optionalDateTimeSchema,
});

export const updateHomeworkStatusSchema = z.object({
  completed: z.boolean(),
  /** 教师代学生标记时使用；学生只能标记自己 */
  userId: z.string().min(1).optional(),
});

export type CreateHomeworkInput = z.infer<typeof createHomeworkSchema>;
export type UpdateHomeworkInput = z.infer<typeof updateHomeworkSchema>;
export type UpdateHomeworkStatusInput = z.infer<typeof updateHomeworkStatusSchema>;
