import { Router } from 'express';
import { capabilities } from './actions.js';
import { interpretConversation } from './conversation.js';
import { sanitizePrompt } from './model-planner.js';
import { prisma } from '../../lib/db.js';
import { ApiError } from '../../lib/http.js';
import { getPlan, preparePlan, confirmPlan, discardPlan } from './plans.js';
import { planIdSchema, preparePlanSchema, confirmPlanSchema } from './ai.schemas.js';
import { API_PATHS } from '@classhelper/shared';
import { sendOk } from '../../lib/http.js';
import { authenticate, getAuthUser, requirePermission } from '../../middleware/auth.js';
import { validate, validatedBody, validatedQuery } from '../../middleware/validate.js';
import { defineModule } from '../module.types.js';
import {
  aiAuditQuerySchema,
  aiInterpretSchema,
  updateAiSettingsSchema,
  type AiAuditQuery,
  type AiInterpretInput,
  type UpdateAiSettingsInput,
} from './ai.schemas.js';
import * as aiService from './ai.service.js';

const router = Router();
router.use(authenticate());

router.get('/settings', requirePermission('ai:manage'), async (_req, res) => {
  sendOk(res, await aiService.getAiSettings(), '获取大模型设置成功');
});

router.put(
  '/settings',
  requirePermission('ai:manage'),
  validate({ body: updateAiSettingsSchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const input = validatedBody<UpdateAiSettingsInput>(req);
    sendOk(res, await aiService.updateAiSettings(user, input), '大模型设置已保存');
  },
);

router.post(
  '/interpret',
  requirePermission('ai:use'),
  validate({ body: aiInterpretSchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const input = validatedBody<AiInterpretInput>(req);
    try {
      sendOk(res, await interpretConversation(user, input), '任务已解析');
    } catch (error) {
      await prisma.aiAudit.create({
        data: {
          userId: user.sub,
          prompt: sanitizePrompt(input.text),
          intent: 'rejected',
          status: 'rejected',
          message: error instanceof ApiError ? error.message : '任务参数或解析失败',
        },
      });
      throw error;
    }
  },
);

router.get(
  '/audit',
  requirePermission('ai:manage'),
  validate({ query: aiAuditQuerySchema }),
  async (req, res) => {
    const query = validatedQuery<AiAuditQuery>(req);
    sendOk(res, await aiService.listAudit(query.limit ?? 50), '获取助手使用记录成功');
  },
);

router.get('/capabilities', requirePermission('ai:use'), async (req, res) =>
  sendOk(res, await capabilities(getAuthUser(req))),
);
router.get('/plans/:id', requirePermission('ai:use'), validate({ params: planIdSchema }), async (req, res) =>
  sendOk(res, await getPlan(getAuthUser(req), String(req.params.id))),
);
router.post(
  '/plans/:id/prepare',
  requirePermission('ai:use'),
  validate({ params: planIdSchema, body: preparePlanSchema }),
  async (req, res) =>
    sendOk(
      res,
      await preparePlan(getAuthUser(req), String(req.params.id), req.body.files, req.body.mappings),
    ),
);
router.post(
  '/plans/:id/confirm',
  requirePermission('ai:use'),
  validate({ params: planIdSchema, body: confirmPlanSchema }),
  async (req, res) => sendOk(res, await confirmPlan(getAuthUser(req), String(req.params.id), req.body)),
);
router.delete(
  '/plans/:id',
  requirePermission('ai:use'),
  validate({ params: planIdSchema }),
  async (req, res) => {
    await discardPlan(getAuthUser(req), String(req.params.id));
    sendOk(res, null);
  },
);

export const aiModule = defineModule({
  name: 'ai',
  basePath: API_PATHS.ai,
  router,
});
