import { z } from 'zod';
import { keywordSchema } from '../../lib/schemas.js';

export const listTeachersQuerySchema = z.object({
  keyword: keywordSchema,
});

/**
 * 录入教师账号。
 * `username` 对教师而言就是**工号**（界面上也这么叫），也是登录名。
 */
export const createTeacherSchema = z.object({
  username: z.string().trim().min(3, '工号至少 3 位').max(32),
  name: z.string().trim().min(1, '请输入姓名').max(32),
  /** 手机号（可空） */
  phone: z.string().trim().max(32).optional(),
  /** 留空则用默认初始密码（DEFAULT_TEACHER_PASSWORD） */
  password: z.string().min(6, '密码至少 6 位').max(128).optional(),
  role: z.enum(['TEACHER', 'ADMIN']).optional(),
});

/** 编辑教师：姓名 / 工号 / 手机号 / 角色（角色可升为管理员，也可降回教师） */
export const updateTeacherSchema = z.object({
  username: z.string().trim().min(3).max(32).optional(),
  name: z.string().trim().min(1).max(32).optional(),
  phone: z.string().trim().max(32).optional(),
  role: z.enum(['TEACHER', 'ADMIN']).optional(),
});

export const resetTeacherPasswordSchema = z.object({
  newPassword: z.string().min(6, '新密码至少 6 位').max(128).optional(),
});

export type CreateTeacherInput = z.infer<typeof createTeacherSchema>;
export type UpdateTeacherInput = z.infer<typeof updateTeacherSchema>;
export type ResetTeacherPasswordInput = z.infer<typeof resetTeacherPasswordSchema>;
