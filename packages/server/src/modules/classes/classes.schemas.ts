import { z } from 'zod';
import { keywordSchema } from '../../lib/schemas.js';

export const createClassSchema = z.object({
  name: z.string().trim().min(1, '请输入班级名称').max(64),
  grade: z.string().trim().min(1, '请输入年级').max(32),
  /** 仅管理员可指定班主任，教师创建时固定为自己 */
  teacherId: z.string().min(1).optional(),
});

export const updateClassSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  grade: z.string().trim().min(1).max(32).optional(),
});

export const listClassesQuerySchema = z.object({
  keyword: keywordSchema,
});

export const addStudentSchema = z.object({
  username: z.string().trim().min(3, '用户名至少 3 位').max(32),
  name: z.string().trim().min(1, '请输入姓名').max(32),
  password: z.string().min(6, '密码至少 6 位').max(128).optional(),
});

export const assignTeacherSchema = z.object({
  teacherId: z.string().min(1, '请选择教师'),
});

export const classStudentParamSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
});

export const classTeacherParamSchema = z.object({
  id: z.string().min(1),
  teacherId: z.string().min(1),
});

export type CreateClassInput = z.infer<typeof createClassSchema>;
export type UpdateClassInput = z.infer<typeof updateClassSchema>;
export type AddStudentInput = z.infer<typeof addStudentSchema>;
