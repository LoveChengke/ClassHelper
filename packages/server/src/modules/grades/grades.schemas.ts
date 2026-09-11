import { z } from 'zod';
import { optionalDateTimeSchema } from '../../lib/schemas.js';

export const listGradesQuerySchema = z.object({
  classId: z.string().min(1).optional(),
  courseId: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
  examName: z.string().trim().max(64).optional(),
});

export const statsQuerySchema = z.object({
  classId: z.string().min(1).optional(),
  courseId: z.string().min(1).optional(),
  examName: z.string().trim().max(64).optional(),
});

export const createGradeSchema = z.object({
  classId: z.string().min(1, '请选择班级'),
  courseId: z.string().min(1).nullish(),
  userId: z.string().min(1, '请选择学生'),
  examName: z.string().trim().min(1, '请输入考试名称').max(64),
  score: z.coerce.number().min(0, '分数不能为负数'),
  totalScore: z.coerce.number().positive('总分必须大于 0').optional(),
  publishedAt: optionalDateTimeSchema,
});

export const updateGradeSchema = z.object({
  examName: z.string().trim().min(1).max(64).optional(),
  score: z.coerce.number().min(0).optional(),
  totalScore: z.coerce.number().positive().optional(),
  courseId: z.string().min(1).nullish(),
  publishedAt: optionalDateTimeSchema,
});

/** 批量录入 / 导入成绩 */
export const bulkCreateGradeSchema = z.object({
  classId: z.string().min(1),
  courseId: z.string().min(1).nullish(),
  examName: z.string().trim().min(1).max(64),
  totalScore: z.coerce.number().positive().optional(),
  publishedAt: optionalDateTimeSchema,
  items: z
    .array(
      z.object({
        userId: z.string().min(1),
        score: z.coerce.number().min(0),
      }),
    )
    .min(1, '至少需要一条成绩记录'),
});

export type CreateGradeInput = z.infer<typeof createGradeSchema>;
export type UpdateGradeInput = z.infer<typeof updateGradeSchema>;
export type BulkCreateGradeInput = z.infer<typeof bulkCreateGradeSchema>;
