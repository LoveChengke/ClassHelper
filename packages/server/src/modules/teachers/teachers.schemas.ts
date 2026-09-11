import { z } from 'zod';
import { keywordSchema } from '../../lib/schemas.js';

export const listTeachersQuerySchema = z.object({
  keyword: keywordSchema,
});

export const createTeacherSchema = z.object({
  username: z.string().trim().min(3, '用户名至少 3 位').max(32),
  name: z.string().trim().min(1, '请输入姓名').max(32),
  password: z.string().min(6, '密码至少 6 位').max(128),
  role: z.enum(['TEACHER', 'ADMIN']).optional(),
});

export type CreateTeacherInput = z.infer<typeof createTeacherSchema>;
