import { Router } from 'express';
import { sendOk } from '../../lib/http.js';
import { authenticate, getAuthUser, requireRole } from '../../middleware/auth.js';
import { validate, validatedBody, validatedQuery } from '../../middleware/validate.js';
import { defineModule } from '../module.types.js';
import {
  autoTermWeeksSchema,
  holidayQuerySchema,
  termQuerySchema,
  updateTermWeeksSchema,
  type AutoTermWeeksInput,
  type UpdateTermWeeksInput,
} from './term.schemas.js';
import * as termService from './term.service.js';

const router = Router();
router.use(authenticate());

/**
 * 学期周次。
 *
 * - **读**：教师/管理员都能看自己可访问班级的周次（课表页要显示"第几周"）；
 * - **写**：仅管理员 —— 周次是全校口径，改错会让所有班的课表整体错位；
 * - `classId` 留空 = 全校默认；某个班有自己的配置时优先用它。
 */
router.get('/', requireRole('ADMIN', 'TEACHER'), validate({ query: termQuerySchema }), async (req, res) => {
  const user = getAuthUser(req);
  const { classId } = validatedQuery<{ classId?: string }>(req);
  sendOk(res, await termService.getTermWeeks(user, classId), '获取学期周次成功');
});

/** PUT /api/term - 保存逐周区间（整表覆盖，仅管理员） */
router.put(
  '/',
  requireRole('ADMIN'),
  validate({ body: updateTermWeeksSchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    sendOk(
      res,
      await termService.updateTermWeeks(user, validatedBody<UpdateTermWeeksInput>(req)),
      '学期周次已保存，变更会随课表下发给教室的 ClassHelper 班级端',
    );
  },
);

/**
 * POST /api/term/auto - 按学期开始日期一键生成逐周区间（仅管理员）
 *
 * 配置的起点：先生成一份"标准学期"，再把调休那几周改掉。
 */
router.post(
  '/auto',
  requireRole('ADMIN'),
  validate({ body: autoTermWeeksSchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    sendOk(
      res,
      await termService.autoTermWeeks(user, validatedBody<AutoTermWeeksInput>(req)),
      '已按学期开始日期生成逐周区间，可继续手动微调',
    );
  },
);

/**
 * GET /api/term/holidays?year= - 联网获取法定节假日安排（给建议，不改数据）
 *
 * **机房没有外网时 `ok:false` 是正常结果**，前端按"暂时取不到"呈现即可。
 */
router.get(
  '/holidays',
  requireRole('ADMIN'),
  validate({ query: holidayQuerySchema }),
  async (req, res) => {
    const { year } = validatedQuery<{ year?: number }>(req);
    const result = await termService.suggestHolidays(year);
    sendOk(res, result, result.ok ? '已获取当年的放假安排' : (result.error ?? '暂时无法获取放假安排'));
  },
);

export const termModule = defineModule({
  name: 'term',
  basePath: '/term',
  router,
});
