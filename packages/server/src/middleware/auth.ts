import type { Request, RequestHandler } from 'express';
import type { UserRole } from '@classhelper/shared';
import { prisma } from '../lib/db.js';
import { ApiError } from '../lib/http.js';
import { extractBearerToken, verifyToken, type TokenPayload } from '../lib/jwt.js';

/**
 * 认证中间件：解析 Bearer token 并回查数据库，
 * 保证角色 / 班级变更（例如管理员换了班主任）立即生效，不被过期载荷影响。
 */
export function authenticate(): RequestHandler {
  return async (req, _res, next) => {
    try {
      const token = extractBearerToken(req.headers.authorization);
      if (!token) throw ApiError.unauthorized('缺少 Authorization 头');

      const payload = verifyToken(token);

      // ClassHelper 班级端：主体是**班级**而不是某个账号，回查 Class 表
      if (payload.classSession) {
        const record = await prisma.class.findUnique({
          where: { id: payload.classId ?? payload.sub },
          select: { id: true, name: true, code: true },
        });
        if (!record) throw ApiError.unauthorized('班级不存在或已被删除');

        req.auth = {
          token,
          user: {
            sub: record.id,
            username: record.code,
            name: record.name,
            role: 'CLASS_DEVICE',
            classId: record.id,
            classSession: true,
            classCode: record.code,
          },
        };
        next();
        return;
      }

      // 账号（教师 / 管理员）：`User` 是纯账号表，学生不在里面
      const user = await prisma.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, username: true, name: true, role: true },
      });
      if (!user) throw ApiError.unauthorized('账号不存在或已被删除');

      req.auth = {
        token,
        user: {
          sub: user.id,
          username: user.username,
          name: user.name,
          role: user.role as UserRole,
          classId: null,
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
