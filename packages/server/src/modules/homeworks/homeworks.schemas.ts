import { z } from 'zod';
import { isDayKey } from '@classhelper/shared';
import { booleanFlagSchema } from '../../lib/schemas.js';

/** YYYY-MM-DD，且必须是真实存在的日期 */
const dayKeySchema = z
  .string()
  .trim()
  .refine((value) => isDayKey(value), { message: '日期格式应为 YYYY-MM-DD' });

export const listHomeworksQuerySchema = z.object({
  classId: z.string().min(1).optional(),
  courseId: z.string().min(1).optional(),
  /** 学生端：只看未完成 */
  pendingOnly: booleanFlagSchema,
  keyword: z.string().trim().max(64).optional(),
  /** 只看某一天的作业（按 Homework.assignDate，本地日期） */
  date: dayKeySchema.optional(),
});

/** 按天查看用：查一段时间内"哪些天有作业"（日期选择器高亮） */
export const listHomeworkDaysQuerySchema = z.object({
  classId: z.string().min(1).optional(),
  from: dayKeySchema.optional(),
  to: dayKeySchema.optional(),
  /** 不传 from/to 时回看的天数（默认 60 天） */
  days: z.coerce.number().int().min(1).max(366).optional(),
});

export const createHomeworkSchema = z.object({
  classId: z.string().min(1, '请选择班级'),
  courseId: z.string().min(1).nullish(),
  title: z.string().trim().min(1, '请输入作业标题').max(120),
  content: z.string().min(1, '请输入作业内容').max(5000),
  attachmentUrl: z.string().trim().max(500).nullish(),
  /** 作业所属日期（YYYY-MM-DD）：客户端/Web 录入时选，不传按服务器当天 */
  assignDate: dayKeySchema.nullish(),
});

export const updateHomeworkSchema = z.object({
  courseId: z.string().min(1).nullish(),
  /** 改作业所属日期（把作业挪到另一天） */
  assignDate: dayKeySchema.optional(),
  title: z.string().trim().min(1).max(120).optional(),
  content: z.string().min(1).max(5000).optional(),
  attachmentUrl: z.string().trim().max(500).nullish(),
});

export const updateHomeworkStatusSchema = z.object({
  completed: z.boolean(),
  /** 教师代学生标记时使用；学生只能标记自己 */
  userId: z.string().min(1).optional(),
});

/** 保存"未交名单"：列出未交的学生 id（其余学生一律标记为已交） */
export const updateHomeworkSubmissionsSchema = z.object({
  notSubmittedUserIds: z.array(z.string().min(1)).max(200).default([]),
});

export type ListHomeworkDaysInput = z.infer<typeof listHomeworkDaysQuerySchema>;
export type CreateHomeworkInput = z.infer<typeof createHomeworkSchema>;
export type UpdateHomeworkInput = z.infer<typeof updateHomeworkSchema>;
export type UpdateHomeworkStatusInput = z.infer<typeof updateHomeworkStatusSchema>;
export type UpdateHomeworkSubmissionsInput = z.infer<typeof updateHomeworkSubmissionsSchema>;
