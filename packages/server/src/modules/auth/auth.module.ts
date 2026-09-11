import { Router } from 'express';
import type { LoginResponse } from '@classhelper/shared';
import { sendOk } from '../../lib/http.js';
import { authenticate, getAuthUser } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { defineModule } from '../module.types.js';
import {
  changePasswordSchema,
  loginSchema,
  type ChangePasswordInput,
  type LoginInput,
} from './auth.schemas.js';
import * as authService from './auth.service.js';

const router = Router();

/** POST /api/auth/login - 登录（公开） */
router.post('/login', validate({ body: loginSchema }), async (req, res) => {
  const result: LoginResponse = await authService.login(req.body as LoginInput);
  sendOk(res, result, '登录成功');
});

/** GET /api/auth/me - 当前用户信息 */
router.get('/me', authenticate(), async (req, res) => {
  const user = getAuthUser(req);
  sendOk(res, await authService.getProfile(user.sub), '获取当前用户成功');
});

/** PATCH /api/auth/password - 修改密码 */
router.patch('/password', authenticate(), validate({ body: changePasswordSchema }), async (req, res) => {
  const user = getAuthUser(req);
  await authService.changePassword(user.sub, req.body as ChangePasswordInput);
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
