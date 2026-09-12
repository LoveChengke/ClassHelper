import { z } from 'zod';

export const loginSchema = z.object({
  username: z.string().trim().min(1, '请输入用户名').max(64),
  password: z.string().min(1, '请输入密码').max(128),
});

/** 班级账号登录（学生端）：班级码 + 班级密码 */
export const classLoginSchema = z.object({
  code: z.string().trim().min(4, '请输入班级码').max(16),
  password: z.string().min(1, '请输入班级密码').max(128),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, '请输入当前密码'),
  newPassword: z.string().min(6, '新密码至少 6 位').max(128),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type ClassLoginInput = z.infer<typeof classLoginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
