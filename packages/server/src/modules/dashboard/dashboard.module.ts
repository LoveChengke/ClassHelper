import { Router } from 'express';
import { sendOk } from '../../lib/http.js';
import { resolveCurrentWeek, MAX_TERM_WEEK } from '../../lib/term.js';
import { authenticate, getAuthUser } from '../../middleware/auth.js';
import { defineModule } from '../module.types.js';
import * as dashboardService from './dashboard.service.js';

const router = Router();
router.use(authenticate());

/** GET /api/dashboard/summary - 首页汇总（按角色权限收敛数据范围） */
router.get('/summary', async (req, res) => {
  const user = getAuthUser(req);
  sendOk(res, await dashboardService.getDashboardSummary(user), '获取仪表盘数据成功');
});

/** GET /api/dashboard/term - 学期信息（当前教学周） */
router.get('/term', (_req, res) => {
  sendOk(res, { currentWeek: resolveCurrentWeek(), maxWeek: MAX_TERM_WEEK }, '获取学期信息成功');
});

export const dashboardModule = defineModule({
  name: 'dashboard',
  basePath: '/dashboard',
  router,
});
