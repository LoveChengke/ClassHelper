import { z } from 'zod';
import { keywordSchema } from '../../lib/schemas.js';

export const listStudentsQuerySchema = z.object({
  classId: z.string().min(1).optional(),
  keyword: keywordSchema,
});

export const createStudentSchema = z.object({
  username: z.string().trim().min(3, '用户名至少 3 位').max(32),
  name: z.string().trim().min(1, '请输入姓名').max(32),
  password: z.string().min(6, '密码至少 6 位').max(128).optional(),
  classId: z.string().min(1).nullish(),
});

export const updateStudentSchema = z.object({
  username: z.string().trim().min(3).max(32).optional(),
  name: z.string().trim().min(1).max(32).optional(),
  classId: z.string().min(1).nullish(),
});

export const resetPasswordSchema = z.object({
  newPassword: z.string().min(6, '新密码至少 6 位').max(128).optional(),
});

export type CreateStudentInput = z.infer<typeof createStudentSchema>;
export type UpdateStudentInput = z.infer<typeof updateStudentSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
