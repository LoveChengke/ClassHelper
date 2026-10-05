import { Router } from 'express';
import { sendOk } from '../../lib/http.js';
import { authenticate, getAuthUser } from '../../middleware/auth.js';
import { defineModule } from '../module.types.js';
import * as updateService from './update.service.js';

const router = Router();
router.use(authenticate());

/**
 * GET /api/update/check?force=1 - 检查 GitHub 上有没有比本机新的版本
 *
 * 为什么 Web 管理端不直连 GitHub：浏览器的请求受服务端下发的 CSP 约束，
 * `connect-src` 只放行 `'self'` 与 WebSocket（见 `middleware/security.ts`），
 * 直连 `api.github.com` 会被浏览器拦掉。走服务端转发还顺带让所有管理员共享同一份缓存。
 *
 * 桌面客户端不受这条约束（它由主进程直连），但两边拿到的 `UpdateInfo` 结构是一致的。
 *
 * 权限：任何已登录用户都能查（信息本身来自公开仓库）。`force=1` 绕过服务端缓存，
 * 但**只有管理员生效** —— 否则任意登录用户都能靠刷这个参数把匿名限流打满。
 */
router.get('/check', async (req, res) => {
  const user = getAuthUser(req);
  const force = req.query.force === '1' && user.role === 'ADMIN';
  sendOk(res, await updateService.checkForUpdates({ force }), '更新检查完成');
});

export const updateModule = defineModule({
  name: 'update',
  basePath: '/update',
  router,
});
