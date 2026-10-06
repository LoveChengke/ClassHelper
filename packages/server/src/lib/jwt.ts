import jwt from 'jsonwebtoken';
import type { SignOptions } from 'jsonwebtoken';
import type { UserRole } from '@classhelper/shared';
import { env } from '../config/env.js';
import { ApiError } from './http.js';

/** JWT 载荷（同时作为 req.auth.user 的类型来源） */
export interface TokenPayload {
  sub: string;
  /** 教师/管理员的工号，或 ClassHelper 班级端的班级码 */
  username: string;
  name: string;
  role: UserRole;
  classId: string | null;
  /** true 表示「ClassHelper 班级端」登录：sub 是班级 id，而非某个账号 */
  classSession?: boolean;
  /** 班级端的班级码（便于日志/审计） */
  classCode?: string;
}

export function signToken(payload: TokenPayload): string {
  // jsonwebtoken 的 expiresIn 类型为 ms.StringValue，这里由 .env 提供字符串，做一次显式收窄
  const options = { expiresIn: env.jwtExpiresIn } as unknown as SignOptions;
  return jwt.sign({ ...payload }, env.jwtSecret, options);
}

/** 校验并解析 token，失败统一抛出 401 */
export function verifyToken(token: string): TokenPayload {
  try {
    const decoded = jwt.verify(token, env.jwtSecret);
    if (typeof decoded === 'string') throw new Error('unexpected token payload');

    const record = decoded as Record<string, unknown>;
    const role = record.role;
    if (role !== 'ADMIN' && role !== 'TEACHER' && role !== 'CLASS_DEVICE') {
      throw new Error('unexpected role in token');
    }

    return {
      sub: String(record.sub ?? ''),
      username: String(record.username ?? ''),
      name: String(record.name ?? ''),
      role,
      classId: record.classId ? String(record.classId) : null,
      classSession: record.classSession === true,
      classCode: record.classCode ? String(record.classCode) : undefined,
    };
  } catch {
    throw ApiError.unauthorized('登录状态已失效，请重新登录');
  }
}

/** 从 Authorization 头中提取 Bearer token */
export function extractBearerToken(headerValue: string | undefined): string | null {
  if (!headerValue) return null;
  const [scheme, token] = headerValue.split(' ');
  if (!token || scheme.toLowerCase() !== 'bearer') return null;
  return token.trim();
}
