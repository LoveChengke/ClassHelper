import { createHash } from 'node:crypto';
import type { AiAttachment, AiExecutionRequest, AiOperation, AiPlanStep } from '@classhelper/shared';
import type { AiPlanStep as StoredStep } from '../../generated/prisma/client.js';
import type { TokenPayload } from '../../lib/jwt.js';
import { prisma } from '../../lib/db.js';
import { ApiError } from '../../lib/http.js';
import { assertPermission } from '../../lib/authz/index.js';
import { encryptSecret, decryptSecret } from '../../lib/secrets.js';
import {
  actionPath,
  authorizeWrite,
  authorizeStoredResult,
  changePreview,
  getWrite,
  importPreview,
  parseOperation,
} from './actions.js';
import { redact } from './business-read.js';

export interface PlanPayload {
  operation: AiOperation;
  attachments: AiAttachment[];
  before?: unknown;
  preview?: unknown;
  summary?: string;
}
function needsExtraConfirmation(payload: PlanPayload): boolean {
  const { operation, before } = payload,
    p = operation.params ?? {};
  if (getWrite(operation.action).dangerous || p.mode === 'replace' || p.kind === 'classTeachers') return true;
  if (operation.action === 'teachers.create' && p.role === 'ADMIN') return true;
  if (!before || typeof before !== 'object') return false;
  if (operation.action === 'teachers.update' && p.role && 'role' in before && p.role !== before.role)
    return true;
  const field =
    operation.action === 'layouts.update'
      ? 'points'
      : operation.action === 'plans.entries'
        ? 'entries'
        : undefined;
  if (!field) return false;
  const old = (before as Record<string, unknown>)[field] as Record<string, unknown>[] | undefined;
  const next = p[field] as Record<string, unknown>[] | undefined;
  const key = field === 'points' ? 'id' : 'timeLayoutItemId';
  return (old ?? []).some((item) => !(next ?? []).some((value) => value[key] === item[key]));
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export function decodeStep(row: StoredStep): PlanPayload {
  return JSON.parse(decryptSecret(row.payload)) as PlanPayload;
}
function safeParams(params: Record<string, unknown> = {}): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(redact(params) as Record<string, unknown>).filter(
      ([key]) => !['contentBase64', 'payload', 'text'].includes(key),
    ),
  );
}
export function executionRequest(payload: PlanPayload): AiExecutionRequest {
  const { operation } = payload,
    tool = getWrite(operation.action);
  const file = payload.attachments.find((item) => item.id === operation.attachmentId);
  const body = operation.params ?? {};
  return {
    method: tool.method,
    path: actionPath(operation.action, operation.target),
    body: operation.action === 'courseware.upload' ? {} : body,
    query:
      operation.action === 'courseware.upload'
        ? { metadata: JSON.stringify(body) }
        : Object.fromEntries(
            Object.entries(operation.query ?? {})
              .filter(([, value]) => value !== undefined && value !== null)
              .map(([key, value]) => [key, String(value)]),
          ),
    ...(file && operation.action === 'courseware.upload'
      ? { attachmentId: file.id, sha256: file.sha256 }
      : {}),
  };
}
function dto(row: StoredStep, includeRequest = false): AiPlanStep {
  const payload = decodeStep(row),
    tool = getWrite(payload.operation.action);
  const result = row.result ? JSON.parse(row.result) : undefined;
  return {
    ...payload.operation,
    params: safeParams(payload.operation.params),
    id: row.id,
    label: tool.label,
    status: row.state as AiPlanStep['status'],
    summary: payload.summary ?? tool.label,
    dangerous: needsExtraConfirmation(payload),
    sensitiveFields: tool.sensitive ?? [],
    before: payload.before,
    preview: payload.preview,
    ...(row.state === 'succeeded'
      ? { result }
      : row.result
        ? { error: String(result?.message ?? '执行失败') }
        : {}),
    ...(includeRequest && row.state === 'confirmed' ? { request: executionRequest(payload) } : {}),
  };
}

export async function ownedSteps(user: TokenPayload, planId: string): Promise<StoredStep[]> {
  await assertPermission(user, 'ai:use');
  const audit = await prisma.aiAudit.findFirst({ where: { id: planId, userId: user.sub } });
  if (!audit) throw ApiError.forbidden('无法访问该操作计划');
  const rows = await prisma.aiPlanStep.findMany({
    where: { auditId: planId, userId: user.sub },
    orderBy: { ordinal: 'asc' },
  });
  for (const row of rows) {
    const payload = decodeStep(row);
    await authorizeStoredResult(user, payload.operation, payload.before);
  }
  return rows;
}
export async function getPlan(user: TokenPayload, planId: string): Promise<AiPlanStep[]> {
  return (await ownedSteps(user, planId)).map((row) => dto(row));
}

export async function createPlan(
  user: TokenPayload,
  prompt: string,
  operations: AiOperation[],
  attachments: AiAttachment[],
): Promise<{ planId: string; steps: AiPlanStep[] }> {
  const expanded: AiOperation[] = [];
  for (const input of operations) {
    if (!['homeworks.bulk', 'notifications.bulk'].includes(input.action)) {
      expanded.push(input);
      continue;
    }
    if (Object.keys(input.params ?? {}).some((key) => /password|secret|token|api.?key/i.test(key)))
      throw ApiError.badRequest('密码等敏感字段请在确认表单中填写');
    const bulk = parseOperation(input, attachments, true);
    await authorizeWrite(user, bulk);
    const { classIds, subjectName, ...params } = bulk.params!;
    for (const classId of new Set(classIds as string[])) {
      const course =
        input.action === 'homeworks.bulk' && subjectName
          ? await prisma.course.findFirst({
              where: { classId, name: String(subjectName) },
              select: { id: true },
            })
          : null;
      expanded.push({
        action: input.action === 'homeworks.bulk' ? 'homeworks.create' : 'notifications.create',
        params: { ...params, classId, ...(course ? { courseId: course.id } : {}) },
        ...(input.attachmentId ? { attachmentId: input.attachmentId } : {}),
      });
    }
  }
  const prepared: { payload: PlanPayload; state: string }[] = [];
  for (const input of expanded) {
    getWrite(input.action);
    if (Object.keys(input.params ?? {}).some((key) => /password|secret|token|api.?key/i.test(key)))
      throw ApiError.badRequest('密码等敏感字段请在确认表单中填写');
    const operation = { ...input, params: { ...input.params } };
    if (operation.action.startsWith('notifications.')) {
      delete operation.params.confirmDuringClass;
    }
    const attachment = attachments.find((item) => item.id === input.attachmentId);
    if (operation.action === 'courseware.upload') {
      if (!attachment) throw ApiError.badRequest('请先添加要推送的文件');
      Object.assign(operation.params, { name: attachment.name, size: attachment.size });
    }
    if (operation.action === 'imports.table' && attachment)
      Object.assign(operation.params, {
        fileName: attachment.name,
        contentBase64: '',
        mapping: operation.params.mapping ?? {},
      });
    if (
      ['imports.yaml', 'imports.plan', 'imports.layout', 'plans.import-profile'].includes(operation.action) &&
      attachment
    )
      Object.assign(operation.params, operation.action === 'imports.yaml' ? { text: '' } : { payload: '{}' });
    const parsed = parseOperation(operation, attachments, true);
    const before = await authorizeWrite(user, parsed);
    const p = parsed.params ?? {},
      source =
        before && !Array.isArray(before) && typeof before === 'object'
          ? (before as Record<string, unknown>)
          : {};
    const sources = (Array.isArray(before) ? before : [source]) as Record<string, unknown>[];
    const classIds = new Set([
      ...(Array.isArray(p.classIds) ? p.classIds.filter((id): id is string => typeof id === 'string') : []),
      ...(typeof p.classId === 'string' ? [p.classId] : []),
      ...(p.plan && typeof p.plan === 'object' && 'classId' in p.plan && typeof p.plan.classId === 'string'
        ? [p.plan.classId]
        : []),
      ...(typeof source.classId === 'string' ? [source.classId] : []),
      ...sources.flatMap((item) => (typeof item.classId === 'string' ? [item.classId] : [])),
    ]);
    const names = classIds.size
      ? await prisma.class.findMany({ where: { id: { in: [...classIds] } }, select: { name: true } })
      : [];
    const destination =
      typeof p.toClassId === 'string'
        ? await prisma.class.findUnique({ where: { id: p.toClassId }, select: { name: true } })
        : null;
    const course =
      typeof p.courseId === 'string'
        ? await prisma.course.findUnique({ where: { id: p.courseId }, select: { name: true } })
        : null;
    const summary = [
      getWrite(parsed.action).label,
      names.map((item) => item.name).join('、'),
      destination ? `移至${destination.name}` : p.toClassId === null ? '移至未分班' : '',
      course?.name,
      p.version ?? parsed.target?.version,
      source.fileName,
      attachment?.name ?? String(p.title ?? p.name ?? source.title ?? source.name ?? ''),
      sources
        .map((item) => String(item.studentName ?? item.name ?? ''))
        .filter(Boolean)
        .join('、'),
      ({ shutdown: '关机', restart: '重启', logoff: '注销', lock: '锁屏' } as Record<string, string>)[
        String(p.kind)
      ] ?? '',
      p.all ? '全校设备' : '',
    ]
      .filter(Boolean)
      .join(' · ');
    const draft = !!attachment && operation.action !== 'courseware.upload';
    const preview = draft
      ? undefined
      : ((await importPreview(user, parsed)) ?? (await changePreview(parsed, before)));
    prepared.push({
      payload: { operation: parsed, attachments, before, preview, summary },
      state: draft ? 'draft' : 'prepared',
    });
  }
  const audit = await prisma.$transaction(async (tx) => {
    const audit = await tx.aiAudit.create({
      data: {
        userId: user.sub,
        prompt,
        intent: operations
          .map((item) => item.action)
          .join(',')
          .slice(0, 500),
        status: 'pending',
        message: `待确认 ${prepared.length} 项操作`,
      },
    });
    for (const [ordinal, item] of prepared.entries())
      await tx.aiPlanStep.create({
        data: {
          auditId: audit.id,
          userId: user.sub,
          ordinal,
          payload: encryptSecret(JSON.stringify(item.payload)),
          state: item.state,
        },
      });
    return audit;
  });
  return { planId: audit.id, steps: await getPlan(user, audit.id) };
}

export async function preparePlan(
  user: TokenPayload,
  planId: string,
  files: Record<string, { contentBase64: string }>,
  mappings: Record<string, Record<string, string>> = {},
): Promise<AiPlanStep[]> {
  const rows = await ownedSteps(user, planId);
  for (const row of rows) {
    if (row.state !== 'draft' && !(row.state === 'prepared' && mappings[row.id])) continue;
    const payload = decodeStep(row),
      op = payload.operation;
    const attachment = payload.attachments.find((file) => file.id === op.attachmentId);
    if (row.state === 'draft') {
      if (!attachment) throw ApiError.badRequest('请重新选择原附件');
      if (!files[attachment.id]) continue;
      if (attachment.size > 8 * 1024 * 1024)
        throw new ApiError(413, 'IMPORT_TOO_LARGE', '结构化导入文件不能超过 8 MB');
      const bytes = Buffer.from(files[attachment.id]!.contentBase64, 'base64');
      if (
        bytes.length !== attachment.size ||
        createHash('sha256').update(bytes).digest('hex') !== attachment.sha256
      )
        throw ApiError.badRequest('附件已变化，请重新生成计划');
      if (op.action === 'imports.table')
        Object.assign(op.params!, { contentBase64: bytes.toString('base64'), fileName: attachment.name });
      else if (op.action === 'imports.yaml') op.params!.text = bytes.toString('utf8');
      else {
        try {
          op.params!.payload = JSON.parse(bytes.toString('utf8'));
        } catch {
          throw ApiError.badRequest('附件不是有效 JSON');
        }
      }
    }
    if (mappings[row.id] && op.action === 'imports.table') op.params!.mapping = mappings[row.id];
    payload.operation = parseOperation(op, payload.attachments, true);
    payload.before = await authorizeWrite(user, payload.operation);
    payload.preview = await importPreview(user, payload.operation);
    if (op.action === 'imports.table') {
      const preview = payload.preview as {
        suggestedMapping: Record<string, string>;
        errors?: unknown[];
        warnings?: unknown[];
      };
      if (!Object.keys(op.params!.mapping as object).length)
        payload.operation.params!.mapping = preview.suggestedMapping;
    }
    await prisma.aiPlanStep.updateMany({
      where: { id: row.id, userId: user.sub, state: { in: ['draft', 'prepared'] } },
      data: { state: 'prepared', payload: encryptSecret(JSON.stringify(payload)) },
    });
  }
  return getPlan(user, planId);
}

export async function confirmPlan(
  user: TokenPayload,
  planId: string,
  input: {
    confirmed: true;
    extraConfirmed?: boolean;
    urgentConfirmed?: boolean;
    secrets?: Record<string, Record<string, string>>;
  },
): Promise<AiPlanStep[]> {
  const rows = await ownedSteps(user, planId);
  const updates: { id: string; payload: string }[] = [];
  for (const row of rows) {
    if (row.state === 'succeeded') continue;
    if (!['prepared', 'failed', 'confirmed'].includes(row.state))
      throw ApiError.conflict('计划未准备好或执行结果待核对，请刷新状态');
    const payload = decodeStep(row),
      tool = getWrite(payload.operation.action);
    if (needsExtraConfirmation(payload) && !input.extraConfirmed)
      throw ApiError.badRequest('此操作需要单独确认');
    const params = { ...payload.operation.params };
    if (payload.operation.action === 'imports.table') {
      const preview = (await importPreview(user, payload.operation)) as {
        columns: string[];
        fields: { key: string; label: string; required: boolean }[];
      };
      const mapping = params.mapping as Record<string, string>;
      for (const field of preview.fields)
        if (field.required && !preview.columns.includes(mapping[field.key] ?? ''))
          throw ApiError.badRequest(`请为「${field.label}」选择对应列`);
      if (params.kind === 'grades' && !mapping.studentNo && !mapping.name)
        throw ApiError.badRequest('请映射学生学号或姓名');
    }
    for (const key of tool.sensitive ?? []) {
      const value = input.secrets?.[row.id]?.[key];
      if (value) params[key] = value;
    }
    if (input.urgentConfirmed && payload.operation.action.startsWith('notifications.'))
      params.confirmDuringClass = true;
    payload.operation = {
      ...payload.operation,
      params: tool.schema.parse(params) as Record<string, unknown>,
    };
    const reviewedParams = canonical(payload.operation.params);
    const before = await authorizeWrite(user, payload.operation);
    if (reviewedParams !== canonical(payload.operation.params))
      throw ApiError.conflict('业务约束已变化，请重新生成预览');
    if (canonical(before) !== canonical(payload.before))
      throw ApiError.conflict('目标内容已变化，请重新生成预览');
    updates.push({ id: row.id, payload: encryptSecret(JSON.stringify(payload)) });
  }
  await prisma.$transaction(
    updates.map((item) =>
      prisma.aiPlanStep.updateMany({
        where: { id: item.id, userId: user.sub, state: { in: ['prepared', 'failed', 'confirmed'] } },
        data: { payload: item.payload, state: 'confirmed', result: '' },
      }),
    ),
  );
  await prisma.aiAudit.update({
    where: { id: planId },
    data: { status: 'confirmed', message: '用户已确认，等待业务接口执行' },
  });
  return (await ownedSteps(user, planId)).map((row) => dto(row, true));
}

export async function discardPlan(user: TokenPayload, planId: string): Promise<void> {
  await ownedSteps(user, planId);
  await prisma.aiPlanStep.updateMany({
    where: { auditId: planId, userId: user.sub, state: { in: ['draft', 'prepared', 'confirmed', 'failed'] } },
    data: { state: 'blocked', result: JSON.stringify({ message: '用户已取消' }) },
  });
  await prisma.aiAudit.update({ where: { id: planId }, data: { status: 'rejected', message: '用户已取消' } });
}
