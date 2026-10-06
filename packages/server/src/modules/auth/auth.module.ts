import { Router } from 'express';
import type { LoginResponse } from '@classhelper/shared';
import { sendOk } from '../../lib/http.js';
import { authenticate, getAuthUser } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { defineModule } from '../module.types.js';
import {
  changePasswordSchema,
  classLoginSchema,
  loginSchema,
  type ChangePasswordInput,
  type ClassLoginInput,
  type LoginInput,
} from './auth.schemas.js';
import * as authService from './auth.service.js';

const router = Router();

/** POST /api/auth/login - 登录（公开）：教师 / 管理员 / 个人学生账号 */
router.post('/login', validate({ body: loginSchema }), async (req, res) => {
  const result: LoginResponse = await authService.login(req.body as LoginInput);
  sendOk(res, result, '登录成功');
});

/**
 * POST /api/auth/class-login - 班级账号登录（公开，ClassHelper 班级端主入口）
 *
 * 班级码 + 班级密码 → 以「班级」为主体的 JWT（个人数据按全班读写）。
 * 个人学生账号仍可用 /auth/login 登录（向后兼容，客户端已不再展示该入口）。
 */
router.post('/class-login', validate({ body: classLoginSchema }), async (req, res) => {
  const result: LoginResponse = await authService.classLogin(req.body as ClassLoginInput);
  sendOk(res, result, '班级登录成功');
});

/** GET /api/auth/me - 当前用户信息（班级账号返回班级信息） */
router.get('/me', authenticate(), async (req, res) => {
  const user = getAuthUser(req);
  sendOk(res, await authService.getProfile(user), '获取当前用户成功');
});

/** PATCH /api/auth/password - 修改密码（班级账号修改的是班级密码） */
router.patch('/password', authenticate(), validate({ body: changePasswordSchema }), async (req, res) => {
  const user = getAuthUser(req);
  await authService.changePassword(user, req.body as ChangePasswordInput);
  sendOk(res, { changed: true }, '密码修改成功，请重新登录');
});

/**
 * POST /api/auth/logout - 退出登录。
 * JWT 为无状态凭证，服务端不做黑名单，客户端丢弃 token 即可。
 */
router.post('/logout', authenticate(), (_req, res) => {
  sendOk(res, { loggedOut: true }, '已退出登录');
});

export const authModule = defineModule({
  name: 'auth',
  basePath: '/auth',
  router,
});
