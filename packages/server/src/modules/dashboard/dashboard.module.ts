import { Router } from 'express';
import { sendOk } from '../../lib/http.js';
import { resolveCurrentWeek, loadTermContext } from '../../lib/term.js';
import { authenticate, getAuthUser, requireStaffPermission } from '../../middleware/auth.js';
import { defineModule } from '../module.types.js';
import * as dashboardService from './dashboard.service.js';

const router = Router();
router.use(authenticate());

/** GET /api/dashboard/summary - 首页汇总（按角色权限收敛数据范围） */
router.get('/summary', requireStaffPermission('dashboard:read'), async (req, res) => {
  const user = getAuthUser(req);
  sendOk(res, await dashboardService.getDashboardSummary(user), '获取仪表盘数据成功');
});

/**
 * GET /api/dashboard/term?classId= - 学期信息（当前教学周 + 本班教学周数）
 *
 * `maxWeek` 取**班级的教学周数**（`Class.termWeeks`，管理员在班级设置里调，默认 20），
 * 这样周次选择器不会再出现"实际 20 周却给到 30 周"的情况；不带 classId 时退回全局默认值。
 * 带 classId 时会先校验班级访问权限（见 resolveTermWeeks）。
 */
router.get('/term', requireStaffPermission('term:read'), async (req, res) => {
  const user = getAuthUser(req);
  const classId = typeof req.query.classId === 'string' && req.query.classId ? req.query.classId : undefined;
  const maxWeek = await dashboardService.resolveTermWeeks(user, classId);
  const targetClassId = user.role === 'CLASS_DEVICE' ? (user.classId ?? user.sub) : classId;
  const context = await loadTermContext(targetClassId);
  sendOk(res, { currentWeek: resolveCurrentWeek(new Date(), context), maxWeek }, '获取学期信息成功');
});

export const dashboardModule = defineModule({
  name: 'dashboard',
  basePath: '/dashboard',
  router,
});
