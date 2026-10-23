import { assertGlobalPermission } from '../../lib/access.js';
import { z } from 'zod';
import {
  promotionStatus,
  previewPromotion,
  promotionConfigSchema,
  configurePromotion,
  runPromotion,
} from './promotion.service.js';
import { Router } from 'express';
import { ApiError, sendOk } from '../../lib/http.js';
import { authenticate, getAuthUser, requirePermission } from '../../middleware/auth.js';
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
router.use('/promotion', async (req, _res, next) => {
  await assertGlobalPermission(getAuthUser(req), 'promotion:manage');
  next();
});
router.get('/promotion', requirePermission('promotion:manage'), async (_req, res) =>
  sendOk(res, await promotionStatus()),
);
router.put(
  '/promotion',
  requirePermission('promotion:manage'),
  validate({ body: promotionConfigSchema }),
  async (req, res) => sendOk(res, await configurePromotion(req.body, getAuthUser(req))),
);
router.post(
  '/promotion/preview',
  requirePermission('promotion:manage'),
  validate({ body: z.object({ year: z.number().int().min(2000).max(2100) }) }),
  async (req, res) => sendOk(res, await previewPromotion(req.body.year)),
);
router.post(
  '/promotion/run',
  requirePermission('promotion:manage'),
  (req, _res, next) => {
    if (req.body && 'dryRun' in req.body)
      return next(
        ApiError.badRequest('请更新页面：预览使用 /term/promotion/preview，执行需提供计划哈希并确认学年'),
      );
    next();
  },
  validate({
    body: z
      .object({
        year: z.number().int().min(2000).max(2100),
        planHash: z.string().length(64),
        confirm: z.literal(true),
        catchUp: z.boolean().optional(),
      })
      .strict(),
  }),
  async (req, res) =>
    sendOk(res, await runPromotion(req.body.year, { ...req.body, actor: getAuthUser(req) })),
);

/**
 * 学期周次。
 *
 * - **读**：教师/管理员都能看自己可访问班级的周次（课表页要显示"第几周"）；
 * - **写**：仅管理员 —— 周次是全校口径，改错会让所有班的课表整体错位；
 * - `classId` 留空 = 全校默认；某个班有自己的配置时优先用它。
 */
router.get('/', requirePermission('term:read'), validate({ query: termQuerySchema }), async (req, res) => {
  const user = getAuthUser(req);
  const { classId } = validatedQuery<{ classId?: string }>(req);
  sendOk(res, await termService.getTermWeeks(user, classId), '获取学期周次成功');
});

/** PUT /api/term - 保存逐周区间（整表覆盖，仅管理员） */
router.put(
  '/',
  requirePermission('term:write'),
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
  requirePermission('term:write'),
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
  requirePermission('term:write'),
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
