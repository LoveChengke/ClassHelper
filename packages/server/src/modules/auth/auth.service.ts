import type { LoginResponse, StudentDto, UserRole } from '@classhelper/shared';
import { changeClassPassword, findClassForLogin, verifyClassPassword } from '../../lib/class-account.js';
import { prisma } from '../../lib/db.js';
import { ApiError } from '../../lib/http.js';
import { signToken, type TokenPayload } from '../../lib/jwt.js';
import { toStudentDto, toUserDto } from '../../lib/mappers.js';
import { hashPassword, verifyPassword } from '../../lib/password.js';
import { isClassSession } from '../../lib/session.js';
import type { ChangePasswordInput, ClassLoginInput, LoginInput } from './auth.schemas.js';

/**
 * 登录：校验用户名密码并签发 JWT。
 *
 * 学生端主体是**班级**（班级码 + 班级密码）：个人学生账号（student01…）**不再允许登录**，
 * 它们的用户名只是"作业完成 / 通知已读 / 成绩"等个人数据的记录键（由班级会话代全班读写）。
 * 教师与管理员仍用用户名登录。
 */
export async function login(input: LoginInput): Promise<LoginResponse> {
  const user = await prisma.user.findUnique({ where: { username: input.username } });
  if (!user) throw ApiError.unauthorized('用户名或密码错误');

  // 角色判定必须放在密码校验**之前**：否则"密码错"与"密码对但学生账号已停用"会给出
  // 不同的响应（401 / 403），攻击者据此就能把学生账号的密码当成可离线验证的预言机。
  // 文案与状态码保持不变（客户端按 403 提示"请用班级码登录"）。
  if (user.role === 'STUDENT') {
    throw ApiError.forbidden('学生请使用「班级码 + 班级密码」登录（个人学生账号已停用）');
  }

  const passwordMatched = await verifyPassword(input.password, user.passwordHash);
  if (!passwordMatched) throw ApiError.unauthorized('用户名或密码错误');

  const payload: TokenPayload = {
    sub: user.id,
    username: user.username,
    name: user.name,
    role: user.role as UserRole,
    classId: user.classId,
  };
  const token = signToken(payload);

  return { token, user: toUserDto(user) };
}

/**
 * 班级账号登录（学生端）：班级码 + 班级密码。
 *
 * 签发的 JWT 以**班级**为主体：`sub` 与 `classId` 都是班级 id，并带 `classSession: true`，
 * 后续个人数据（作业完成、通知已读）由服务端按"全班"范围读写，个人学生不再是登录主体。
 */
export async function classLogin(input: ClassLoginInput): Promise<LoginResponse> {
  const record = await findClassForLogin(input.code);

  if (!(await verifyClassPassword(input.password, record.passwordHash ?? ''))) {
    throw ApiError.unauthorized('班级码或班级密码错误');
  }

  const payload: TokenPayload = {
    sub: record.id,
    username: record.code,
    name: record.name,
    role: 'STUDENT',
    classId: record.id,
    classSession: true,
    classCode: record.code,
  };
  const token = signToken(payload);

  return {
    token,
    user: {
      id: record.id,
      username: record.code,
      name: record.name,
      role: 'STUDENT',
      classId: record.id,
      createdAt: new Date().toISOString(),
      className: record.name,
      grade: record.grade,
      classSession: true,
      classCode: record.code,
    },
  };
}

/**
 * 当前用户信息（学生额外带班级名与年级）。
 * 班级账号返回班级信息（id 即班级 id）。
 */
export async function getProfile(user: TokenPayload): Promise<StudentDto> {
  if (isClassSession(user)) {
    const record = await prisma.class.findUnique({
      where: { id: user.classId ?? user.sub },
      select: { id: true, name: true, grade: true, code: true, createdAt: true },
    });
    if (!record) throw ApiError.unauthorized('班级不存在或已被删除');
    return {
      id: record.id,
      username: record.code,
      name: record.name,
      role: 'STUDENT',
      classId: record.id,
      createdAt: record.createdAt.toISOString(),
      className: record.name,
      grade: record.grade,
      classSession: true,
      classCode: record.code,
    } as StudentDto & { classSession: boolean; classCode: string };
  }

  const user_ = await prisma.user.findUnique({
    where: { id: user.sub },
    include: { class: { select: { name: true, grade: true } } },
  });
  if (!user_) throw ApiError.unauthorized('账号不存在或已被删除');
  return toStudentDto(user_);
}

/** 修改自己的密码；班级账号修改的是「班级密码」 */
export async function changePassword(user: TokenPayload, input: ChangePasswordInput): Promise<void> {
  if (isClassSession(user)) {
    await changeClassPassword(user.classId ?? user.sub, input.currentPassword, input.newPassword);
    return;
  }

  const record = await prisma.user.findUnique({ where: { id: user.sub } });
  if (!record) throw ApiError.unauthorized('账号不存在或已被删除');

  const matched = await verifyPassword(input.currentPassword, record.passwordHash);
  if (!matched) throw ApiError.badRequest('当前密码不正确');

  await prisma.user.update({
    where: { id: user.sub },
    data: { passwordHash: await hashPassword(input.newPassword) },
  });
}
