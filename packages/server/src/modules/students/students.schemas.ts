import { z } from 'zod';
import { keywordSchema } from '../../lib/schemas.js';

export const listStudentsQuerySchema = z.object({
  classId: z.string().min(1).optional(),
  keyword: keywordSchema,
});

// 学生只有"名单"没有"账号"：不设密码、不能登录（2026-10-01 起学生个人账号已全部清理，
// 学生端统一用班级码 + 班级密码），因此这里没有也不该有任何密码字段。
export const createStudentSchema = z.object({
  username: z.string().trim().min(3, '用户名至少 3 位').max(32),
  name: z.string().trim().min(1, '请输入姓名').max(32),
  classId: z.string().min(1).nullish(),
});

export const updateStudentSchema = z.object({
  username: z.string().trim().min(3).max(32).optional(),
  name: z.string().trim().min(1).max(32).optional(),
  classId: z.string().min(1).nullish(),
});

export type CreateStudentInput = z.infer<typeof createStudentSchema>;
export type UpdateStudentInput = z.infer<typeof updateStudentSchema>;
