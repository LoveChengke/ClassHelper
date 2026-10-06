import { Router } from 'express';
import { sendCreated, sendOk } from '../../lib/http.js';
import { idParamSchema } from '../../lib/schemas.js';
import { authenticate, getAuthUser, requireRole } from '../../middleware/auth.js';
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

/** GET /api/schedules?classId=&week=&dayOfWeek= - 课表列表 */
router.get('/', validate({ query: listSchedulesQuerySchema }), async (req, res) => {
  const user = getAuthUser(req);
  const query = validatedQuery<{ classId?: string; week?: number; dayOfWeek?: number }>(req);
  sendOk(res, await scheduleService.listSchedules(user, query), '获取课表成功');
});

/** GET /api/schedules/grid?classId=&week= - 周视图（7 列结构） */
router.get('/grid', validate({ query: gridQuerySchema }), async (req, res) => {
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
});

/**
 * GET /api/schedules/current?classId=&at= - 班级当前上课状态。
 * 客户端灵动岛（上课期间隐藏、下课后弹出）与 Web 端"上课时段发布紧急通知"
 * 的全屏二次确认都基于它；`at` 为诊断/联调用时间覆盖。
 */
router.get('/current', validate({ query: classStatusQuerySchema }), async (req, res) => {
  const user = getAuthUser(req);
  const { classId, at } = validatedQuery<{ classId?: string; at?: string }>(req);
  const status = await scheduleService.getClassStatus(user, {
    classId,
    at: at ? new Date(at) : undefined,
  });
  sendOk(res, status, status.inClass ? '当前处于上课时间段' : '当前不在上课时间段');
});

/** POST /api/schedules - 新增课表 */
router.post(
  '/',
  requireRole('ADMIN', 'TEACHER'),
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
  requireRole('ADMIN', 'TEACHER'),
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
  requireRole('ADMIN', 'TEACHER'),
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
