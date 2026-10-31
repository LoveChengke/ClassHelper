import type { Request, RequestHandler } from 'express';
import type { PermissionKey, UserRole } from '@classhelper/shared';
import { PERMISSION_LABELS } from '@classhelper/shared';
import { ApiError } from '../lib/http.js';
import { loadAuthPrincipal } from '../lib/authz/index.js';
import { loadSessionUser } from '../lib/authz/session.js';
import { extractBearerToken, verifyToken, type TokenPayload } from '../lib/jwt.js';

/**
 * 认证中间件：解析 Bearer token 并回查数据库，
 * 保证角色 / 班级变更（例如管理员换了班主任）立即生效，不被过期载荷影响。
 *
 * 2026-10-10 起**顺带装载生效权限集合**（`req.auth.permissions`）：
 * 角色判据换成权限键判据（`requirePermission`），角色只用来决定"没有分组时的默认模板"。
 */
export function authenticate(): RequestHandler {
  return async (req, _res, next) => {
    try {
      const token = extractBearerToken(req.headers.authorization);
      if (!token) throw ApiError.unauthorized('缺少 Authorization 头');

      const payload = verifyToken(token);

      const user = await loadSessionUser(payload);
      req.auth = { token, user, permissions: (await loadAuthPrincipal(user)).permissions };
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** 角色守卫（仍保留：少数场景要按角色而不是按权限键判断，如班级端专属入口） */
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

/**
 * 权限守卫：要求当前登录主体拥有**全部**列出的权限键。
 *
 * 权限集合来自 {@link loadAuthPrincipal}（管理员全集，或教师模板与分配）。
 * 提示文案用中文权限名，用户看到的是"缺少「导入成绩」权限"而不是一堆键名。
 */
export function requirePermission(...keys: PermissionKey[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth?.user) {
      next(ApiError.unauthorized());
      return;
    }
    const permissions = req.auth.permissions ?? new Set<PermissionKey>();
    const missing = keys.filter((key) => !permissions.has(key));
    if (missing.length > 0) {
      const labels = missing.map((key) => `「${PERMISSION_LABELS[key]}」`).join('');
      next(ApiError.forbidden(`当前账号缺少${labels}权限，请联系管理员在「权限组」里分配`));
      return;
    }
    next();
  };
}

/** 班级端按班级范围开放读取；教师/管理员仍按可编辑的功能权限校验。 */
export function requirePermissionOrClassDevice(...keys: PermissionKey[]): RequestHandler {
  const guard = requirePermission(...keys);
  return (req, res, next) => {
    if (req.auth?.user.role === 'CLASS_DEVICE') return next();
    return guard(req, res, next);
  };
}

/**
 * 权限守卫（任一满足）：只要拥有其中**一个**权限键就放行。
 *
 * 用在"同一入口服务多种能力"的接口上：如导入模板按 `kind` 区分能力，
 * 只要有一种导入能力就能取模板（具体哪种 kind 能不能导，由 service 里的 kind 断言决定）。
 */
export function requireAnyPermission(...keys: PermissionKey[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth?.user) {
      next(ApiError.unauthorized());
      return;
    }
    const permissions = req.auth.permissions ?? new Set<PermissionKey>();
    if (keys.length > 0 && !keys.some((key) => permissions.has(key))) {
      const labels = keys.map((key) => `「${PERMISSION_LABELS[key]}」`).join('、');
      next(
        ApiError.forbidden(`当前账号缺少权限（${labels} 中至少需要一项），请联系管理员在「权限组」里分配`),
      );
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

/** 取出当前登录主体的生效权限集合（未认证时抛 401） */
export function getAuthPermissions(req: Request): ReadonlySet<PermissionKey> {
  if (!req.auth?.user) throw ApiError.unauthorized();
  return req.auth.permissions ?? new Set<PermissionKey>();
}

/** 当前主体是否有某个权限键（页面/服务里做条件分支用，找不到也当无权限） */
export function hasAuthPermission(req: Request, key: PermissionKey): boolean {
  return (req.auth?.permissions ?? new Set<PermissionKey>()).has(key);
}

export const requireAdmin = (): RequestHandler => requireRole('ADMIN');
