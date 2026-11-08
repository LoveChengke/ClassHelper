import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Request } from 'express';
import type { AiAgentEvent, AiConversationResult, AiTaskDto } from '@classhelper/shared';
import { prisma } from '../../lib/db.js';
import { ApiError } from '../../lib/http.js';
import { logger } from '../../lib/logger.js';
import { assertPermission, loadAuthPrincipal } from '../../lib/authz/index.js';
import { loadSessionUser } from '../../lib/authz/session.js';
import { encryptSecret, decryptSecret } from '../../lib/secrets.js';
import { signToken, type TokenPayload } from '../../lib/jwt.js';
import { coursewareRoot } from '../courseware/courseware.service.js';
import { interpretConversation } from './conversation.js';
import { sanitizePrompt } from './model-planner.js';
import { runRead } from './actions.js';
import { confirmPlan, getPlan, preparePlan, discardPlan } from './plans.js';
import type { AiInterpretInput } from './ai.schemas.js';

const active = new Map<string, AbortController>();
const stagingRoot = path.resolve(coursewareRoot, '.ai-tasks');
const decode = <T>(value: string): T => JSON.parse(decryptSecret(value));
async function accessStamp(user: TokenPayload): Promise<string> {
  const current = await loadSessionUser({ ...user });
  const principal = await loadAuthPrincipal(current);
  const relations =
    current.role === 'ADMIN'
      ? []
      : await Promise.all([
          prisma.class.findMany({
            select: { id: true, grade: true, teacherId: true },
            orderBy: { id: 'asc' },
          }),
          prisma.course.findMany({
            where: { teacherId: current.sub },
            select: { id: true, classId: true, name: true },
            orderBy: { id: 'asc' },
          }),
        ]);
  return createHash('sha256')
    .update(
      JSON.stringify({
        role: current.role,
        keys: [...principal.permissions].sort(),
        grants: [...principal.grants].sort(),
        relations,
      }),
    )
    .digest('hex');
}
function attachmentPath(id: string, attachmentId: string): string {
  return path.join(
    stagingRoot,
    createHash('sha256').update(id).digest('hex'),
    createHash('sha256').update(attachmentId).digest('hex'),
  );
}
async function owned(user: TokenPayload, id: string) {
  await assertPermission(user, 'ai:use');
  const row = await prisma.aiTask.findFirst({ where: { id, userId: user.sub } });
  if (!row) throw ApiError.forbidden('无法访问此任务');
  const saved = decode<AiInterpretInput & { accessStamp?: string }>(row.input).accessStamp;
  if (saved && saved !== (await accessStamp(user)))
    throw ApiError.forbidden('权限或任课关系已变化，请重新提交任务，原计划不会自动执行');
  return row;
}
export async function createTask(user: TokenPayload, input: AiInterpretInput) {
  await assertPermission(user, 'ai:use');
  const expired = await prisma.aiTask.findMany({
    where: {
      userId: user.sub,
      state: { in: ['preparing', 'ready', 'failed', 'stopped', 'succeeded', 'waiting_input'] },
      updatedAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    },
    take: 20,
  });
  for (const row of expired) await cleanup(row.id, decode<AiInterpretInput>(row.input));
  if (
    (await prisma.aiTask.count({ where: { userId: user.sub, state: { in: ['planning', 'executing'] } } })) >=
    3
  )
    throw ApiError.conflict('请等待现有后台任务完成');
  const conversation = input.conversationId
    ? await ownedConversation(user, input.conversationId)
    : await createConversation(user);
  if (input.supersedesTaskId) {
    const old = await owned(user, input.supersedesTaskId);
    if (old.conversationId !== conversation.id || old.state !== 'ready')
      throw ApiError.conflict('只能替换本对话中明确选中的待确认计划');
  }
  const previous = await prisma.aiTask.findMany({
    where: { userId: user.sub, conversationId: conversation.id },
    orderBy: { turnNumber: 'asc' },
  });
  if (previous.some((t) => ['planning', 'executing'].includes(t.state)))
    throw ApiError.conflict('当前对话仍在处理，请等待完成');
  const history: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const old of previous) {
    const checked = await task(user, old.id);
    history.push({ role: 'user', content: checked.text });
    if (checked.result)
      history.push({
        role: 'assistant',
        content:
          checked.result.message +
          '\n' +
          JSON.stringify(
            checked.result.steps.map((s) => ({ action: s.action, status: s.status, summary: s.summary })),
          ),
      });
  }
  const context =
    history.length > 18
      ? [
          {
            role: 'user' as const,
            content:
              '此前用户需求摘要：' +
              history
                .slice(0, -18)
                .filter((m) => m.role === 'user')
                .map((m) => m.content.slice(0, 300))
                .join('；')
                .slice(-7000),
          },
          ...history.slice(-18),
        ]
      : history;
  const last = previous.at(-1);
  const inherited =
    last?.state === 'waiting_input' && !input.attachments?.length
      ? decode<AiInterpretInput>(last.input).attachments
      : undefined;
  const safe = {
    ...input,
    attachments: input.attachments?.length ? input.attachments : inherited,
    text: sanitizePrompt(input.text),
    conversationId: conversation.id,
    messages: context.map((item) => ({ ...item, content: sanitizePrompt(item.content).slice(0, 8000) })),
  };
  Object.assign(safe, { accessStamp: await accessStamp(user) });
  const row = await prisma.$transaction(async (tx) => {
    // 与删除对话共用同一行锁，避免新轮次写入已删除的对话。
    const locked = await tx.aiConversation.updateMany({
      where: { id: conversation.id, userId: user.sub },
      data: { updatedAt: new Date(), title: conversation.title || sanitizePrompt(input.text).slice(0, 80) },
    });
    if (!locked.count) throw ApiError.forbidden('此对话已删除或无法访问');
    const latest = await tx.aiTask.findFirst({
      where: { conversationId: conversation.id, userId: user.sub },
      orderBy: { turnNumber: 'desc' },
    });
    if ((latest?.turnNumber ?? 0) !== (previous.at(-1)?.turnNumber ?? 0))
      throw ApiError.conflict('对话已有新轮次，请重新发送');
    return tx.aiTask.create({
      data: {
        userId: user.sub,
        conversationId: conversation.id,
        turnNumber: (latest?.turnNumber ?? 0) + 1,
        input: encryptSecret(JSON.stringify(safe)),
      },
    });
  });
  if (last && inherited?.length) {
    for (const attachment of inherited) {
      const source = attachmentPath(last.id, attachment.id),
        target = attachmentPath(row.id, attachment.id);
      if (!fs.existsSync(source)) throw ApiError.badRequest('原附件暂存已过期，请重新上传后继续');
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.copyFile(source, target);
    }
  }
  return { id: row.id, conversationId: conversation.id };
}
export async function stageAttachment(
  user: TokenPayload,
  id: string,
  attachmentId: string,
  request: Request,
) {
  const row = await owned(user, id);
  if (row.state !== 'preparing' || active.has(id)) throw ApiError.conflict('任务已开始，不能更换附件');
  const attachment = decode<AiInterpretInput>(row.input).attachments?.find(
    (item) => item.id === attachmentId,
  );
  if (!attachment) throw ApiError.forbidden('附件不属于本次任务');
  const file = attachmentPath(id, attachmentId),
    partial = file + '.' + randomUUID() + '.partial';
  await fsp.mkdir(path.dirname(file), { recursive: true });
  let size = 0;
  const digest = createHash('sha256');
  try {
    await pipeline(
      request,
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          if (size > attachment.size) {
            callback(ApiError.badRequest('附件大小与预览不一致'));
            return;
          }
          digest.update(chunk);
          callback(null, chunk);
        },
      }),
      fs.createWriteStream(partial, { flags: 'wx' }),
    );
    if (size !== attachment.size || digest.digest('hex') !== attachment.sha256)
      throw ApiError.badRequest('附件校验失败，请重新上传');
    await fsp.rename(partial, file);
  } finally {
    await fsp.rm(partial, { force: true });
  }
}
async function cleanup(id: string, input: AiInterpretInput) {
  for (const attachment of input.attachments ?? [])
    await fsp.rm(attachmentPath(id, attachment.id), { force: true });
  await fsp.rmdir(path.dirname(attachmentPath(id, ''))).catch(() => undefined);
}

export async function task(user: TokenPayload, id: string): Promise<AiTaskDto> {
  const row = await owned(user, id);
  if (
    ['planning', 'executing'].includes(row.state) &&
    !active.has(id) &&
    Date.now() - row.updatedAt.getTime() > 2000
  ) {
    await prisma.aiTask.updateMany({
      where: { id, state: row.state },
      data: {
        state: 'failed',
        error:
          row.state === 'executing'
            ? '服务已重启，请核对步骤状态后继续；成功步骤不会重复执行。'
            : '服务已重启，任务已保留，可继续处理。',
      },
    });
    return task(user, id);
  }
  let result = row.result ? decode<AiConversationResult>(row.result) : undefined;
  if (result) {
    if (result.planId) result.steps = await getPlan(user, result.planId);
    // 重进页面时重新查询授权范围，不能用历史快照泄漏撤权后的记录。
    const results: AiConversationResult['results'] = [];
    for (const item of result.results)
      if (item.operation) {
        const data = await runRead(user, item.operation);
        if (JSON.stringify(data) !== JSON.stringify(item.data))
          throw ApiError.forbidden('记录或权限已变化，请重新查询当前结果');
        results.push({ ...item, data });
      }
    result = { ...result, results };
  }
  return {
    id,
    classId: decode<AiInterpretInput>(row.input).classId,
    conversationId: row.conversationId,
    turnNumber: row.turnNumber,
    state: row.state,
    text: decode<AiInterpretInput>(row.input).text,
    result,
    events: row.events ? decode<AiAgentEvent[]>(row.events) : [],
    ...(row.error ? { error: row.error } : {}),
  };
}
export async function listTasks(user: TokenPayload) {
  await assertPermission(user, 'ai:use');
  const rows = await prisma.aiTask.findMany({
    where: { userId: user.sub },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  return rows.map((row) => ({
    id: row.id,
    state: row.state,
    text: decode<AiInterpretInput>(row.input).text,
    events: [],
  }));
}

function launch(
  id: string,
  user: TokenPayload,
  work: (signal: AbortSignal, emit: (event: AiAgentEvent) => void) => Promise<void>,
) {
  const controller = new AbortController();
  active.set(id, controller);
  let events: AiAgentEvent[] = [],
    writes = Promise.resolve(),
    lastMessage = '';
  const emit = (event: AiAgentEvent) => {
    if (event.type === 'status' && event.message.startsWith('模型正在推理'))
      events = events.filter((item) => item.type !== 'status' || !item.message.startsWith('模型正在推理'));
    if (event.type === 'message') {
      if (lastMessage === event.text) return;
      lastMessage = event.text;
      events = events.filter((item) => item.type !== 'message');
    }
    events = [...events, event].slice(-80);
    const snapshot = encryptSecret(JSON.stringify(events));
    writes = writes
      .then(async () => {
        await prisma.aiTask.update({ where: { id }, data: { events: snapshot } });
      })
      .catch(() => undefined);
  };
  void work(controller.signal, emit)
    .catch(async (error) => {
      const message = controller.signal.aborted
        ? '任务已按你的要求停止。'
        : error instanceof ApiError
          ? error.message
          : '任务暂未完成，已保留当前进度。请重试继续。';
      await prisma.aiTask.update({
        where: { id },
        data: { state: controller.signal.aborted ? 'stopped' : 'failed', error: message },
      });
      await prisma.aiAudit.create({
        data: { userId: user.sub, prompt: '后台任务', intent: id, status: 'failed', message },
      });
    })
    .finally(async () => {
      await writes.catch(() => undefined);
      active.delete(id);
    })
    .catch(() => {
      active.delete(id);
    });
}

export async function startTask(user: TokenPayload, id: string) {
  const row = await owned(user, id);
  if (active.has(id)) return;
  if (!['preparing', 'failed', 'stopped'].includes(row.state) || row.result)
    throw ApiError.conflict('任务已有结果，请核对现有计划');
  const input = decode<AiInterpretInput>(row.input);
  for (const attachment of input.attachments ?? [])
    if (!fs.existsSync(attachmentPath(id, attachment.id)))
      throw ApiError.badRequest('附件尚未上传完成，请重新选择原文件');
  const claimed = await prisma.aiTask.updateMany({
    where: { id, state: row.state },
    data: { state: 'planning', error: '' },
  });
  if (!claimed.count) return;
  launch(id, user, async (signal, emit) => {
    const result = await interpretConversation(user, input, {
      signal,
      emit,
      authorize: async () => {
        await owned(user, id);
      },
    });
    if (result.planId && result.steps.some((step) => step.status === 'draft')) {
      for (const step of result.steps.filter((step) => step.status === 'draft')) {
        signal.throwIfAborted();
        const file = attachmentPath(id, step.attachmentId!);
        if ((await fsp.stat(file)).size > 8 * 1024 * 1024)
          throw ApiError.badRequest('结构化导入文件不可超过 8 MB');
        result.steps = await preparePlan(user, result.planId, {
          [step.attachmentId!]: { contentBase64: (await fsp.readFile(file)).toString('base64') },
        });
      }
    }
    signal.throwIfAborted();
    await prisma.aiTask.update({
      where: { id },
      data: {
        state: result.questions?.length ? 'waiting_input' : result.steps.length ? 'ready' : 'succeeded',
        result: encryptSecret(JSON.stringify(result)),
      },
    });
    if (input.supersedesTaskId && result.steps.length) {
      const old = await owned(user, input.supersedesTaskId);
      if (old.conversationId !== row.conversationId || old.state !== 'ready')
        throw ApiError.conflict('原计划已变化，替换未完成，请分别核对计划');
      if (active.has(old.id)) throw ApiError.conflict('原计划正在执行，不能替换');
      const claimed = await prisma.aiTask.updateMany({
        where: { id: old.id, state: 'ready' },
        data: { state: 'superseded' },
      });
      if (!claimed.count) throw ApiError.conflict('原计划已变化，替换未完成');
      const oldResult = decode<AiConversationResult>(old.result);
      if (oldResult.planId) await discardPlan(user, oldResult.planId);
      await prisma.aiTask.updateMany({
        where: { id: old.id, state: 'ready' },
        data: { state: 'superseded' },
      });
    }
    emit({ type: 'status', message: result.steps.length ? '变更预览已准备，等待确认' : '处理完成' });
    if (!result.steps.length && !result.questions?.length) await cleanup(id, input);
  });
}

export async function executeTask(
  user: TokenPayload,
  id: string,
  confirmation: Parameters<typeof confirmPlan>[2],
  localPort: number,
) {
  const row = await owned(user, id);
  if (active.has(id)) return;
  const result = row.result ? decode<AiConversationResult>(row.result) : undefined;
  if (!result?.planId) throw ApiError.badRequest('请先生成操作预览');
  const steps = await confirmPlan(user, result.planId, confirmation);
  const input = decode<AiInterpretInput>(row.input);
  for (const step of steps)
    if (
      step.status !== 'succeeded' &&
      step.request?.attachmentId &&
      !fs.existsSync(attachmentPath(id, step.request.attachmentId))
    )
      throw ApiError.badRequest('临时附件已过期，请重新上传原文件');
  const claimed = await prisma.aiTask.updateMany({
    where: { id, state: row.state },
    data: { state: 'executing', error: '' },
  });
  if (!claimed.count) return;
  launch(id, user, async (signal, emit) => {
    for (const step of steps) {
      signal.throwIfAborted();
      if (step.status === 'succeeded') continue;
      const request = step.request;
      if (!request) throw ApiError.conflict('此步骤未确认，请重新核对');
      emit({ type: 'status', message: `正在执行：${step.label}` });
      // 地址只由本进程监听端口和确认后的动作目录生成，不接受模型 URL。
      const url = new URL(`/api${request.path}`, `http://127.0.0.1:${localPort}`);
      for (const [key, value] of Object.entries(request.query)) url.searchParams.set(key, String(value));
      const file = request.attachmentId ? attachmentPath(id, request.attachmentId) : undefined;
      const response = await fetch(url, {
        method: request.method,
        headers: {
          authorization: `Bearer ${signToken(user)}`,
          'x-classhelper-ai-step': step.id,
          'content-type': file ? 'application/octet-stream' : 'application/json',
          ...(file ? { 'x-classhelper-ai-sha256': request.sha256! } : {}),
        },
        body: file
          ? (fs.createReadStream(file) as unknown as NonNullable<Parameters<typeof fetch>[1]>['body'])
          : JSON.stringify(request.body),
        ...(file ? { duplex: 'half' } : {}),
        signal: AbortSignal.timeout(600000),
      });
      const body = (await response.json()) as { message?: string };
      if (!response.ok)
        throw new ApiError(response.status, 'AI_READ_FAILED', body.message || '此步骤未完成，后续步骤已暂停');
      emit({ type: 'status', message: `已完成：${step.label}` });
    }
    result.steps = await getPlan(user, result.planId!);
    await prisma.aiTask.update({
      where: { id },
      data: { state: 'succeeded', result: encryptSecret(JSON.stringify(result)) },
    });
    await cleanup(id, input);
  });
}
export async function stopTask(user: TokenPayload, id: string) {
  await owned(user, id);
  const controller = active.get(id);
  if (controller) controller.abort();
  else
    await prisma.aiTask.update({
      where: { id },
      data: { state: 'stopped', error: '任务已按你的要求停止。' },
    });
}

export async function createConversation(user: TokenPayload) {
  await assertPermission(user, 'ai:use');
  return prisma.aiConversation.create({ data: { userId: user.sub } });
}
async function ownedConversation(user: TokenPayload, id: string) {
  await assertPermission(user, 'ai:use');
  const row = await prisma.aiConversation.findFirst({ where: { id, userId: user.sub } });
  if (!row) throw ApiError.forbidden('无法访问此对话');
  return row;
}
export async function conversations(user: TokenPayload, before?: string) {
  await assertPermission(user, 'ai:use');
  const legacy = await prisma.aiTask.findMany({
    where: { userId: user.sub, conversationId: null },
    take: 100,
  });
  for (const old of legacy)
    await prisma.$transaction(async (tx) => {
      const c = await tx.aiConversation.upsert({
        where: { id: old.id },
        create: {
          id: old.id,
          userId: user.sub,
          title: sanitizePrompt(decode<AiInterpretInput>(old.input).text).slice(0, 80),
          createdAt: old.createdAt,
        },
        update: {},
      });
      await tx.aiTask.updateMany({
        where: { id: old.id, conversationId: null },
        data: { conversationId: c.id },
      });
    });
  return prisma.aiConversation.findMany({
    where: { userId: user.sub },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    take: 30,
    ...(before ? { cursor: { id: before }, skip: 1 } : {}),
  });
}
export async function conversationTurns(user: TokenPayload, id: string, before?: number) {
  await ownedConversation(user, id);
  const rows = await prisma.aiTask.findMany({
    where: { conversationId: id, userId: user.sub, ...(before ? { turnNumber: { lt: before } } : {}) },
    orderBy: { turnNumber: 'desc' },
    take: 30,
  });
  return Promise.all(rows.reverse().map((row) => task(user, row.id)));
}

/** 删除自己的对话，不回滚已执行业务，也不删除业务审计。 */
export async function deleteConversation(user: TokenPayload, id: string) {
  await ownedConversation(user, id);
  const rows = await prisma.$transaction(async (tx) => {
    const locked = await tx.aiConversation.updateMany({
      where: { id, userId: user.sub },
      data: { updatedAt: new Date() },
    });
    if (!locked.count) throw ApiError.forbidden('无法访问此对话');
    const tasks = await tx.aiTask.findMany({ where: { conversationId: id, userId: user.sub } });
    if (tasks.some((t) => active.has(t.id) || ['planning', 'executing'].includes(t.state)))
      throw ApiError.conflict('对话仍有后台任务，请先停止或等待完成后再删除');
    const planIds = tasks.flatMap((t) =>
      t.result ? [decode<AiConversationResult>(t.result).planId].filter((p): p is string => Boolean(p)) : [],
    );
    if (
      await tx.aiPlanStep.count({ where: { auditId: { in: planIds }, userId: user.sub, state: 'running' } })
    )
      throw ApiError.conflict('业务操作正在执行，请等待完成后再删除');
    await tx.aiPlanStep.updateMany({
      where: {
        auditId: { in: planIds },
        userId: user.sub,
        state: { in: ['draft', 'prepared', 'confirmed', 'failed'] },
      },
      data: { state: 'blocked', result: JSON.stringify({ message: '对话已删除，未完成计划已取消' }) },
    });
    await tx.aiTask.deleteMany({ where: { conversationId: id, userId: user.sub } });
    await tx.aiConversation.delete({ where: { id } });
    return tasks;
  });
  for (const row of rows)
    await cleanup(row.id, decode<AiInterpretInput>(row.input)).catch(() =>
      logger.warn('AI 对话已删除，暂存附件清理未完成'),
    );
  return { id };
}
