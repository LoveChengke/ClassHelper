import * as bcrypt from 'bcryptjs';
import { env } from '../config/env.js';

/** 生成密码哈希（bcrypt 算法） */
export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, env.bcryptRounds);
}

/** 校验明文密码与哈希是否匹配 */
export function verifyPassword(plain: string, passwordHash: string): Promise<boolean> {
  return bcrypt.compare(plain, passwordHash);
}
