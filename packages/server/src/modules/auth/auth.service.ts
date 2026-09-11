import type { LoginResponse, StudentDto, UserRole } from '@classhelper/shared';
import { prisma } from '../../lib/db.js';
import { ApiError } from '../../lib/http.js';
import { signToken } from '../../lib/jwt.js';
import { toStudentDto, toUserDto } from '../../lib/mappers.js';
import { hashPassword, verifyPassword } from '../../lib/password.js';
import type { ChangePasswordInput, LoginInput } from './auth.schemas.js';

/** 登录：校验用户名密码并签发 JWT */
export async function login(input: LoginInput): Promise<LoginResponse> {
  const user = await prisma.user.findUnique({ where: { username: input.username } });
  if (!user) throw ApiError.unauthorized('用户名或密码错误');

  const passwordMatched = await verifyPassword(input.password, user.passwordHash);
  if (!passwordMatched) throw ApiError.unauthorized('用户名或密码错误');

  const token = signToken({
    sub: user.id,
    username: user.username,
    name: user.name,
    role: user.role as UserRole,
    classId: user.classId,
  });

  return { token, user: toUserDto(user) };
}

/** 当前用户信息（学生额外带班级名与年级） */
export async function getProfile(userId: string): Promise<StudentDto> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { class: { select: { name: true, grade: true } } },
  });
  if (!user) throw ApiError.unauthorized('账号不存在或已被删除');
  return toStudentDto(user);
}

/** 修改自己的密码 */
export async function changePassword(userId: string, input: ChangePasswordInput): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw ApiError.unauthorized('账号不存在或已被删除');

  const matched = await verifyPassword(input.currentPassword, user.passwordHash);
  if (!matched) throw ApiError.badRequest('当前密码不正确');

  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await hashPassword(input.newPassword) },
  });
}
