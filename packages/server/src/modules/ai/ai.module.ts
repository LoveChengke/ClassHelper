import { Router } from 'express';
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

/**
 * 大模型助手。
 *
 * 权限分成两把：`ai:manage`（设置，默认只有管理员）与 `ai:use`（用一句话办事，默认教师也有）。
 * **`/interpret` 只解析、绝不落库**：真正发布由前端确认后调既有端点，权限与上课时段保护
 * 都在那条路径上（AGENTS.md 的现行工程约定）。
 */
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
    sendOk(res, await aiService.interpret(user, input), '助手已解析，请确认后发布');
  },
);

router.get('/audit', requirePermission('ai:manage'), validate({ query: aiAuditQuerySchema }), async (req, res) => {
  const query = validatedQuery<AiAuditQuery>(req);
  sendOk(res, await aiService.listAudit(query.limit ?? 50), '获取助手使用记录成功');
});

export const aiModule = defineModule({
  name: 'ai',
  basePath: API_PATHS.ai,
  router,
});
