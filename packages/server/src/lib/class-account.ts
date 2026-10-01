import { randomInt } from 'node:crypto';
import { prisma } from './db.js';
import { ApiError } from './http.js';
import { hashPassword, verifyPassword } from './password.js';

/**
 * 班级账号（学生端「班级」主体）：
 * - 每个班级有一个**班级码**（唯一、大写字母数字）和**班级密码**（bcrypt）；
 * - 学生端班级设备用「班级码 + 班级密码」登录，拿到 `classSession` 的 JWT；
 * - 管理员可在「班级管理」里修改班级码、重置班级密码。
 *
 * 兼容性：个人学生账号（User.username）完全不受影响，仍然是独立账号。
 */

/** 班级码：去掉易混淆字符（0/O/1/I），4~16 位大写字母数字 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_PATTERN = /^[A-Za-z0-9]{4,16}$/;

/** 归一化班级码：去空格 + 转大写（登录时用户输入大小写都可） */
export function normalizeClassCode(input: string): string {
  return input.trim().toUpperCase();
}

export function isValidClassCode(input: string): boolean {
  return CODE_PATTERN.test(input.trim());
}

/** 随机生成一个未被占用的班级码 */
export async function generateClassCode(prefix = ''): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const length = Math.max(4, 6 - prefix.length);
    let body = '';
    for (let index = 0; index < length; index += 1) {
      // 用 CSPRNG 而不是 Math.random()：班级码会作为学生端登录的账号名打印/张贴，
      // 用可预测的 PRNG 生成等于把"半个凭证"送给猜码的人（randomInt 无取模偏差）
      body += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
    }
    const code = `${prefix}${body}`.toUpperCase();
    const exists = await prisma.class.findUnique({ where: { code }, select: { id: true } });
    if (!exists) return code;
  }
  throw new ApiError(500, 'INTERNAL_ERROR', '班级码生成失败，请重试或手动指定班级码');
}

/** 创建班级时调用：生成班级码并写入默认班级密码 */
export async function buildClassAccountCreateData(
  defaultPassword: string,
  requestedCode?: string,
): Promise<{ code: string; passwordHash: string }> {
  const code = requestedCode ? normalizeClassCode(requestedCode) : await generateClassCode();
  if (!isValidClassCode(code)) throw ApiError.badRequest('班级码需为 4~16 位字母或数字');
  const taken = await prisma.class.findUnique({ where: { code }, select: { id: true } });
  if (taken) throw ApiError.badRequest(`班级码 ${code} 已被占用，请更换`);
  return { code, passwordHash: await hashPassword(defaultPassword) };
}

/** 管理员：修改班级码 / 重置班级密码 */
export async function updateClassAccount(
  classId: string,
  input: { code?: string; password?: string },
): Promise<{ code: string; hasPassword: boolean }> {
  const current = await prisma.class.findUnique({ where: { id: classId }, select: { id: true, code: true } });
  if (!current) throw ApiError.notFound('班级不存在');

  const data: { code?: string; passwordHash?: string } = {};

  if (input.code !== undefined) {
    const code = normalizeClassCode(input.code);
    if (!isValidClassCode(code)) throw ApiError.badRequest('班级码需为 4~16 位字母或数字');
    if (code !== current.code) {
      const taken = await prisma.class.findUnique({ where: { code }, select: { id: true } });
      if (taken) throw ApiError.badRequest(`班级码 ${code} 已被其他班级使用`);
      data.code = code;
    }
  }

  if (input.password !== undefined && input.password !== '') {
    if (input.password.length < 6) throw ApiError.badRequest('班级密码至少 6 位');
    data.passwordHash = await hashPassword(input.password);
  }

  if (Object.keys(data).length === 0) {
    throw ApiError.badRequest('没有需要更新的内容（班级码或班级密码）');
  }

  const updated = await prisma.class.update({
    where: { id: classId },
    data,
    select: { code: true, passwordHash: true },
  });
  return { code: updated.code, hasPassword: Boolean(updated.passwordHash) };
}

/** 班级账号登录：返回班级记录（密码校验在 service 层完成） */
export async function findClassForLogin(code: string): Promise<{
  id: string;
  name: string;
  grade: string;
  code: string;
  passwordHash: string | null;
}> {
  const normalized = normalizeClassCode(code);
  const record = await prisma.class.findUnique({
    where: { code: normalized },
    select: { id: true, name: true, grade: true, code: true, passwordHash: true },
  });
  if (!record) throw ApiError.unauthorized('班级码或班级密码错误');
  if (!record.passwordHash) {
    throw new ApiError(
      403,
      'CLASS_PASSWORD_NOT_SET',
      '该班级尚未设置班级密码，请联系管理员在「班级管理」中设置',
    );
  }
  return record;
}

export async function verifyClassPassword(plain: string, passwordHash: string): Promise<boolean> {
  return verifyPassword(plain, passwordHash);
}

/** 班级账号自助修改班级密码 */
export async function changeClassPassword(
  classId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const record = await prisma.class.findUnique({ where: { id: classId }, select: { passwordHash: true } });
  if (!record) throw ApiError.notFound('班级不存在');
  if (record.passwordHash && !(await verifyPassword(currentPassword, record.passwordHash))) {
    throw ApiError.badRequest('当前班级密码不正确');
  }
  await prisma.class.update({
    where: { id: classId },
    data: { passwordHash: await hashPassword(newPassword) },
  });
}
