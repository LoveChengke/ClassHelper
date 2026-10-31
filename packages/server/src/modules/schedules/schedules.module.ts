import { z } from 'zod';
import { assertClassAccess, assertCanManageSchedule } from '../../lib/access.js';
import * as plans from '../class-plans/class-plans.service.js';
import { datedPlanSchema, swapSchema } from '../class-plans/class-plans.schemas.js';
import { prisma } from '../../lib/db.js';
import { ApiError } from '../../lib/http.js';
import { Router } from 'express';
import { sendCreated, sendOk } from '../../lib/http.js';
import { idParamSchema } from '../../lib/schemas.js';
import {
  authenticate,
  getAuthUser,
  requirePermissionOrClassDevice,
  requirePermission,
} from '../../middleware/auth.js';
import { validate, validatedParams, validatedQuery } from '../../middleware/validate.js';
import { defineModule } from '../module.types.js';
import {
  classStatusQuerySchema,
  createScheduleSchema,
  gridQuerySchema,
  listSchedulesQuerySchema,
  updateScheduleSchema,
  type CreateScheduleInput,
  type UpdateScheduleInput,
} from './schedules.schemas.js';
import * as scheduleService from './schedules.service.js';

const router = Router();
router.use(authenticate());
router.get(
  '/active-week',
  requirePermissionOrClassDevice('schedule:read'),
  validate({ query: gridQuerySchema }),
  async (req, res) =>
    sendOk(res, await scheduleService.getActiveScheduleWeek(getAuthUser(req), validatedQuery(req))),
);
router.get(
  '/scheduled',
  requirePermissionOrClassDevice('schedule:read'),
  validate({ query: z.object({ classId: z.string().min(1) }) }),
  async (req, res) => {
    const { classId } = validatedQuery<{ classId: string }>(req);
    await assertClassAccess(getAuthUser(req), classId, 'schedule:read');
    sendOk(
      res,
      await prisma.scheduledClassPlan.findMany({
        where: { classId },
        include: { plan: { select: { name: true, isOverlay: true } } },
        orderBy: { date: 'asc' },
      }),
    );
  },
);
router.delete(
  '/scheduled/:id',
  requirePermission('schedule:write'),
  validate({ params: idParamSchema }),
  async (req, res) => {
    const row = await prisma.scheduledClassPlan.findUnique({
      where: { id: String(req.params.id) },
      include: { plan: true },
    });
    if (!row) throw ApiError.notFound('预定不存在');
    await assertCanManageSchedule(getAuthUser(req), row.classId);
    await prisma.$transaction(async (tx) => {
      await tx.scheduledClassPlan.delete({ where: { id: row.id } });
      if (row.plan.isOverlay)
        await tx.classPlan.update({ where: { id: row.classPlanId }, data: { isEnabled: false } });
    });
    await plans.notifyScheduleChanged(row.classId);
    sendOk(res, { id: row.id });
  },
);

router.post(
  '/scheduled',
  requirePermission('schedule:write'),
  validate({ body: datedPlanSchema }),
  async (req, res) => sendCreated(res, await plans.schedulePlan(getAuthUser(req), req.body)),
);
router.post(
  '/overlay',
  requirePermission('schedule:write'),
  validate({ body: datedPlanSchema }),
  async (req, res) => {
    const source = await plans.requirePlan(getAuthUser(req), req.body.classPlanId);
    if (source.classId !== req.body.classId) throw ApiError.badRequest('课表不属于本班');
    sendCreated(res, await plans.createOverlay(getAuthUser(req), source.id, req.body.date));
  },
);
router.post(
  '/swap',
  requirePermission('schedule:write'),
  validate({ body: swapSchema }),
  async (req, res) => {
    const source = await plans.requirePlan(getAuthUser(req), req.body.classPlanId);
    if (source.classId !== req.body.classId) throw ApiError.badRequest('课表不属于本班');
    sendCreated(
      res,
      await plans.createOverlay(getAuthUser(req), source.id, req.body.date, {
        first: req.body.first,
        second: req.body.second,
      }),
    );
  },
);

/** GET /api/schedules?classId=&week=&dayOfWeek= - 课表列表 */
router.get(
  '/',
  requirePermissionOrClassDevice('schedule:read'),
  validate({ query: listSchedulesQuerySchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const query = validatedQuery<{ classId?: string; week?: number; dayOfWeek?: number }>(req);
    sendOk(res, await scheduleService.listSchedules(user, query), '获取课表成功');
  },
);

/** GET /api/schedules/grid?classId=&week= - 周视图（7 列结构） */
router.get(
  '/grid',
  requirePermissionOrClassDevice('schedule:read'),
  validate({ query: gridQuerySchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const { classId, week } = validatedQuery<{ classId?: string; week?: number }>(req);
    sendOk(
      res,
      await scheduleService.getScheduleGrid(user, {
        classId,
        // 不传 week 就取「本班口径」的当前周次（由 service 内按班级配置解析）
        week,
      }),
      '获取周视图成功',
    );
  },
);

/**
 * GET /api/schedules/current?classId=&at= - 班级当前上课状态。
 * 客户端灵动岛（上课期间隐藏、下课后弹出）与 Web 端"上课时段发布紧急通知"
 * 的全屏二次确认都基于它；`at` 为诊断/联调用时间覆盖。
 */
router.get(
  '/current',
  requirePermissionOrClassDevice('schedule:read'),
  validate({ query: classStatusQuerySchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const { classId, at } = validatedQuery<{ classId?: string; at?: string }>(req);
    const status = await scheduleService.getClassStatus(user, {
      classId,
      at: at ? new Date(at) : undefined,
    });
    sendOk(res, status, status.inClass ? '当前处于上课时间段' : '当前不在上课时间段');
  },
);

/** POST /api/schedules - 新增课表 */
router.post(
  '/',
  requirePermission('schedule:write'),
  validate({ body: createScheduleSchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    sendCreated(
      res,
      await scheduleService.createSchedule(user, req.body as CreateScheduleInput),
      '课表创建成功',
    );
  },
);

/** PATCH /api/schedules/:id - 修改课表 */
router.patch(
  '/:id',
  requirePermission('schedule:write'),
  validate({ params: idParamSchema, body: updateScheduleSchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const { id } = validatedParams<{ id: string }>(req);
    sendOk(
      res,
      await scheduleService.updateSchedule(user, id, req.body as UpdateScheduleInput),
      '课表更新成功',
    );
  },
);

/** DELETE /api/schedules/:id - 删除课表 */
router.delete(
  '/:id',
  requirePermission('schedule:write'),
  validate({ params: idParamSchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const { id } = validatedParams<{ id: string }>(req);
    await scheduleService.deleteSchedule(user, id);
    sendOk(res, { id }, '课表已删除');
  },
);

export const schedulesModule = defineModule({
  name: 'schedules',
  basePath: '/schedules',
  router,
});
