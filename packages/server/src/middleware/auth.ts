import type { Request, RequestHandler } from 'express';
import type { UserRole } from '@classhelper/shared';
import { prisma } from '../lib/db.js';
import { ApiError } from '../lib/http.js';
import { extractBearerToken, verifyToken, type TokenPayload } from '../lib/jwt.js';

/**
 * 认证中间件：解析 Bearer token 并回查数据库，
 * 保证角色 / 班级变更（例如教师把学生转到别的班）立即生效，不被过期载荷影响。
 */
export function authenticate(): RequestHandler {
  return async (req, _res, next) => {
    try {
      const token = extractBearerToken(req.headers.authorization);
      if (!token) throw ApiError.unauthorized('缺少 Authorization 头');

      const payload = verifyToken(token);
      const user = await prisma.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, username: true, name: true, role: true, classId: true },
      });
      if (!user) throw ApiError.unauthorized('账号不存在或已被删除');

      req.auth = {
        token,
        user: {
          sub: user.id,
          username: user.username,
          name: user.name,
          role: user.role as UserRole,
          classId: user.classId,
        },
      };
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** 角色守卫 */
export function requireRole(...roles: UserRole[]): RequestHandler {
  return (req, _res, next) => {
    const user = req.auth?.user;
    if (!user) {
      next(ApiError.unauthorized());
      return;
    }
    if (!roles.includes(user.role)) {
      next(ApiError.forbidden(`该操作仅限 ${roles.join(' / ')} 角色使用`));
      return;
    }
    next();
  };
}

/** 取出当前登录用户，未认证时抛 401 */
export function getAuthUser(req: Request): TokenPayload {
  if (!req.auth?.user) throw ApiError.unauthorized();
  return req.auth.user;
}
