import type { Request, Response } from 'express';
import { prisma } from '../../lib/db.js';
import { ApiError, sendOk } from '../../lib/http.js';
import { assertPermission } from '../../lib/authz/index.js';
import { getSetting, SETTING_KEYS } from '../../lib/settings.js';
import { authorizeWrite, authorizeStoredResult } from './actions.js';
import { canonical, decodeStep, executionRequest } from './plans.js';
import { redact } from './business-read.js';

/** 返回 false 表示已返回去重结果，不再进入业务处理器。 */
export async function guardAiExecution(req: Request, res: Response): Promise<boolean> {
  const stepId = req.get('x-classhelper-ai-step');
  if (!stepId) return true;
  const user = req.auth!.user;
  await assertPermission(user, 'ai:use');
  if ((await getSetting(SETTING_KEYS.aiEnabled)) !== 'true') throw ApiError.forbidden('AI 助手已停用');
  const row = await prisma.aiPlanStep.findFirst({ where: { id: stepId, userId: user.sub } });
  if (!row) throw ApiError.forbidden('操作计划不属于当前用户');
  const payload = decodeStep(row),
    expected = executionRequest(payload);
  if (
    req.method !== expected.method ||
    req.originalUrl.split('?')[0] !== `/api${expected.path}` ||
    canonical(req.query) !== canonical(expected.query)
  )
    throw ApiError.forbidden('请求与已确认的计划不一致');
  if (expected.attachmentId) {
    if (!req.is('application/octet-stream') || req.get('x-classhelper-ai-sha256') !== expected.sha256)
      throw ApiError.forbidden('附件与计划不一致');
  } else if (canonical(req.body ?? {}) !== canonical(expected.body))
    throw ApiError.forbidden('参数与已确认的计划不一致');
  await authorizeStoredResult(user, payload.operation, payload.before);
  if (row.state === 'succeeded') {
    sendOk(res, row.result ? JSON.parse(row.result) : null, '此步骤已经完成');
    return false;
  }
  if (row.state !== 'confirmed') throw ApiError.conflict('此步骤尚未确认、正在执行或结果待核对');
  const unfinished = await prisma.aiPlanStep.count({
    where: { auditId: row.auditId, ordinal: { lt: row.ordinal }, state: { not: 'succeeded' } },
  });
  if (unfinished) throw ApiError.conflict('前置步骤尚未成功，已停止后续操作');
  const reviewedParams = canonical(payload.operation.params);
  const before = await authorizeWrite(user, payload.operation);
  if (reviewedParams !== canonical(payload.operation.params))
    throw ApiError.conflict('业务约束已变化，请重新生成预览');
  if (canonical(before) !== canonical(payload.before))
    throw ApiError.conflict('目标内容已变化，请重新生成预览');
  const claimed = await prisma.aiPlanStep.updateMany({
    where: { id: row.id, userId: user.sub, state: 'confirmed' },
    data: { state: 'running' },
  });
  if (!claimed.count) throw ApiError.conflict('此步骤已经被其他请求接收');
  const json = res.json.bind(res);
  let finishing = false;
  res.json = (body: unknown) => {
    if (finishing) return res;
    finishing = true;
    const success = res.statusCode < 400;
    const state = success ? 'succeeded' : res.statusCode < 500 ? 'failed' : 'blocked';
    const data = body && typeof body === 'object' && 'data' in body ? (body as { data: unknown }).data : body;
    void prisma.aiPlanStep
      .update({
        where: { id: row.id },
        data: { state, result: JSON.stringify(redact(success ? (data ?? null) : body)) },
      })
      .then(async () => {
        const remaining = await prisma.aiPlanStep.count({
          where: { auditId: row.auditId, state: { not: 'succeeded' } },
        });
        await prisma.aiAudit.update({
          where: { id: row.auditId },
          data: {
            status: success ? (remaining ? 'partial' : 'succeeded') : state,
            message: success
              ? remaining
                ? '已完成当前步骤，尚有步骤待处理'
                : '全部步骤已完成'
              : '业务接口拒绝或执行失败',
          },
        });
        json(body);
      })
      .catch(() => {
        res.status(503);
        json({
          success: false,
          code: 'AI_RESULT_UNCERTAIN',
          message: '结果记录失败，请先在业务页面核对，勿重复提交',
        });
      });
    return res;
  };
  res.once('close', () => {
    if (!finishing)
      void prisma.aiPlanStep
        .updateMany({
          where: { id: row.id, state: 'running' },
          data: { state: 'blocked', result: JSON.stringify({ message: '连接中断，请先核对业务结果' }) },
        })
        .catch(() => undefined);
  });
  return true;
}
