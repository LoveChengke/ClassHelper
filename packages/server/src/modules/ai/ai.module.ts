import { Router } from 'express';
import { capabilities } from './actions.js';
import { interpretConversation } from './conversation.js';
import { sanitizePrompt } from './model-planner.js';
import { prisma } from '../../lib/db.js';
import { ApiError } from '../../lib/http.js';
import { getPlan, preparePlan, confirmPlan, discardPlan } from './plans.js';
import { planIdSchema, preparePlanSchema, confirmPlanSchema } from './ai.schemas.js';
import { API_PATHS, type AiAgentEvent } from '@classhelper/shared';
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
import { discoverModelsSchema, taskAttachmentSchema } from './ai.schemas.js';
import { discoverModels } from './model-transport.js';
import * as tasks from './tasks.js';
import { setTimeout as delay } from 'node:timers/promises';

const router = Router();
router.use(authenticate());
router.delete(
  '/conversations/:id',
  requirePermission('ai:use'),
  validate({ params: planIdSchema }),
  async (req, res) => {
    sendOk(res, await tasks.deleteConversation(getAuthUser(req), String(req.params.id)));
  },
);
router.post('/conversations', requirePermission('ai:use'), async (req, res) => {
  sendOk(res, await tasks.createConversation(getAuthUser(req)));
});
router.get('/conversations', requirePermission('ai:use'), async (req, res) => {
  sendOk(
    res,
    await tasks.conversations(
      getAuthUser(req),
      typeof req.query.before === 'string' ? req.query.before : undefined,
    ),
  );
});
router.get(
  '/conversations/:id',
  requirePermission('ai:use'),
  validate({ params: planIdSchema }),
  async (req, res) => {
    const before = Number(req.query.before);
    if (req.query.before !== undefined && (!Number.isInteger(before) || before < 1))
      throw ApiError.badRequest('轮次游标无效');
    sendOk(res, await tasks.conversationTurns(getAuthUser(req), String(req.params.id), before || undefined));
  },
);

router.get(
  '/tasks/:id/events',
  requirePermission('ai:use'),
  validate({ params: planIdSchema }),
  async (req, res) => {
    const user = getAuthUser(req),
      id = String(req.params.id);
    await tasks.task(user, id);
    res.status(200).set({
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    });
    res.flushHeaders();
    const connection = new AbortController();
    res.on('close', () => connection.abort());
    const send = (event: AiAgentEvent) => {
      if (!res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const sent = new Set<string>();
    let lastText = '';
    try {
      while (!connection.signal.aborted) {
        const current = await tasks.task(user, id);
        for (const event of current.events) {
          if (event.type === 'message') {
            if (event.text !== lastText) {
              send(event);
              lastText = event.text;
            }
          } else if (!sent.has(JSON.stringify(event))) {
            send(event);
            sent.add(JSON.stringify(event));
          }
        }
        if (['ready', 'succeeded', 'waiting_input'].includes(current.state) && current.result) {
          send({ type: 'result', result: current.result });
          break;
        }
        if (['failed', 'stopped'].includes(current.state)) {
          send({
            type: 'error',
            code: 'AI_TASK_INCOMPLETE',
            message: current.error || '任务已暂停，可继续处理。',
            retryable: true,
          });
          break;
        }
        res.write(': heartbeat\n\n');
        await delay(350, undefined, { signal: connection.signal });
      }
    } catch (error) {
      if (!connection.signal.aborted)
        send({
          type: 'error',
          code: 'AI_READ_FAILED',
          message: error instanceof ApiError ? error.message : '连接暂时中断，后台任务继续运行。',
          retryable: true,
        });
    } finally {
      res.end();
    }
  },
);

router.get('/tasks', requirePermission('ai:use'), async (req, res) =>
  sendOk(res, await tasks.listTasks(getAuthUser(req))),
);
router.post('/tasks', requirePermission('ai:use'), validate({ body: aiInterpretSchema }), async (req, res) =>
  sendOk(res, await tasks.createTask(getAuthUser(req), req.body)),
);
router.get('/tasks/:id', requirePermission('ai:use'), validate({ params: planIdSchema }), async (req, res) =>
  sendOk(res, await tasks.task(getAuthUser(req), String(req.params.id))),
);
router.put(
  '/tasks/:id/files/:attachmentId',
  requirePermission('ai:use'),
  validate({ params: taskAttachmentSchema }),
  async (req, res) => {
    await tasks.stageAttachment(
      getAuthUser(req),
      String(req.params.id),
      String(req.params.attachmentId),
      req,
    );
    sendOk(res, null);
  },
);
router.post(
  '/tasks/:id/start',
  requirePermission('ai:use'),
  validate({ params: planIdSchema }),
  async (req, res) => {
    await tasks.startTask(getAuthUser(req), String(req.params.id));
    sendOk(res, null);
  },
);
router.post(
  '/tasks/:id/execute',
  requirePermission('ai:use'),
  validate({ params: planIdSchema, body: confirmPlanSchema }),
  async (req, res) => {
    await tasks.executeTask(getAuthUser(req), String(req.params.id), req.body, req.socket.localPort!);
    sendOk(res, null);
  },
);
router.post(
  '/tasks/:id/stop',
  requirePermission('ai:use'),
  validate({ params: planIdSchema }),
  async (req, res) => {
    await tasks.stopTask(getAuthUser(req), String(req.params.id));
    sendOk(res, null);
  },
);

router.post(
  '/models',
  requirePermission('ai:manage'),
  validate({ body: discoverModelsSchema }),
  async (req, res) => {
    sendOk(res, await discoverModels(getAuthUser(req), req.body));
  },
);

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
