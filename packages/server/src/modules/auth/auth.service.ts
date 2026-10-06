import type { LoginResponse, SessionUser, UserRole } from '@classhelper/shared';
import { changeClassPassword, findClassForLogin, verifyClassPassword } from '../../lib/class-account.js';
import { prisma } from '../../lib/db.js';
import { ApiError } from '../../lib/http.js';
import { signToken, type TokenPayload } from '../../lib/jwt.js';
import { toClassDeviceUser, toUserDto, toUserSessionUser } from '../../lib/mappers.js';
import { hashPassword, verifyPassword } from '../../lib/password.js';
import { isClassDevice } from '../../lib/access.js';
import type { ChangePasswordInput, ClassLoginInput, LoginInput } from './auth.schemas.js';

/**
 * 登录：校验工号（管理员为登录名）与密码并签发 JWT。
 *
 * **学生不在 `User` 表里**，因此这里没有、也不该有"学生账号"分支：
 * 学生只是 `Student` 名单记录，唯一的登录途径是教室机器用班级码 + 班级密码
 * （`classLogin`），而那签发的会话主体是**班级**，不是某个学生。
 */
export async function login(input: LoginInput): Promise<LoginResponse> {
  const user = await prisma.user.findUnique({ where: { username: input.username } });
  if (!user) throw ApiError.unauthorized('工号或密码错误');

  const passwordMatched = await verifyPassword(input.password, user.passwordHash);
  if (!passwordMatched) throw ApiError.unauthorized('工号或密码错误');

  const payload: TokenPayload = {
    sub: user.id,
    username: user.username,
    name: user.name,
    role: user.role as UserRole,
    classId: null,
  };
  const token = signToken(payload);

  return { token, user: toUserSessionUser(user) };
}

/**
 * ClassHelper 班级端登录：班级码 + 班级密码。
 *
 * 签发的 JWT 以**班级**为主体：`sub` 与 `classId` 都是班级 id，并带 `classSession: true`，
 * 角色是 `CLASS_DEVICE`。后续个人数据（作业完成、通知已读）由服务端按"全班学生"范围读写，
 * 因此教师端的"完成人数 / 已读人数"统计依然准确。
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
    role: 'CLASS_DEVICE',
    classId: record.id,
    classSession: true,
    classCode: record.code,
  };
  const token = signToken(payload);

  return {
    token,
    user: toClassDeviceUser({
      id: record.id,
      code: record.code,
      name: record.name,
      grade: record.grade,
      studentGradeQueryEnabled: record.studentGradeQueryEnabled,
      createdAt: new Date(),
    }),
  };
}

/**
 * 当前账号信息。
 * ClassHelper 班级端返回班级信息（id 即班级 id）。
 */
export async function getProfile(user: TokenPayload): Promise<SessionUser> {
  if (isClassDevice(user)) {
    const record = await prisma.class.findUnique({
      where: { id: user.classId ?? user.sub },
      select: {
        id: true,
        name: true,
        grade: true,
        code: true,
        studentGradeQueryEnabled: true,
        createdAt: true,
      },
    });
    if (!record) throw ApiError.unauthorized('班级不存在或已被删除');
    return toClassDeviceUser({
      id: record.id,
      code: record.code,
      name: record.name,
      grade: record.grade,
      studentGradeQueryEnabled: record.studentGradeQueryEnabled,
      createdAt: record.createdAt,
    });
  }

  const record = await prisma.user.findUnique({ where: { id: user.sub } });
  if (!record) throw ApiError.unauthorized('账号不存在或已被删除');
  return toUserSessionUser(record);
}

/** 修改自己的密码；ClassHelper 班级端修改的是「班级密码」 */
export async function changePassword(user: TokenPayload, input: ChangePasswordInput): Promise<void> {
  if (isClassDevice(user)) {
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

/** 供 auth 模块的路由复用：账号 DTO */
export { toUserDto };
