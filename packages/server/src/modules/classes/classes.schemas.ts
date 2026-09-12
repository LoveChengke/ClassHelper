import { z } from 'zod';
import { keywordSchema } from '../../lib/schemas.js';

export const createClassSchema = z.object({
  name: z.string().trim().min(1, '请输入班级名称').max(64),
  grade: z.string().trim().min(1, '请输入年级').max(32),
  /** 仅管理员可指定班主任，教师创建时固定为自己 */
  teacherId: z.string().min(1).optional(),
  /** 可选：自定义班级码（学生端班级账号登录用），留空自动生成 */
  code: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{4,16}$/, '班级码需为 4~16 位字母或数字')
    .optional(),
});

export const updateClassSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  grade: z.string().trim().min(1).max(32).optional(),
});

/** 设置 / 重置班级账号（班级码 + 班级密码）：仅管理员 */
export const updateClassAccountSchema = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9]{4,16}$/, '班级码需为 4~16 位字母或数字')
      .optional(),
    password: z.string().min(6, '班级密码至少 6 位').max(64).optional(),
  })
  .refine((value) => value.code !== undefined || value.password !== undefined, {
    message: '请至少填写班级码或班级密码中的一项',
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
export type UpdateClassAccountInput = z.infer<typeof updateClassAccountSchema>;
export type AddStudentInput = z.infer<typeof addStudentSchema>;
