import type { PermissionKey } from '@classhelper/shared';
import { assertAdmin, assertPermission, classIdsFor } from '../../lib/authz/index.js';
import { activeStudentWhere } from '../../lib/students.js';
import {
  dayKeyLocal,
  type AiActionKind,
  type AiAuditDto,
  type AiInterpretResult,
  type AiSettingsDto,
} from '@classhelper/shared';
import { z } from 'zod';
import { getAccessibleClassIds, assertClassAccess } from '../../lib/access.js';
import { prisma } from '../../lib/db.js';
import { ApiError } from '../../lib/http.js';
import type { TokenPayload } from '../../lib/jwt.js';
import { logger } from '../../lib/logger.js';
import { decryptSecret, encryptSecret } from '../../lib/secrets.js';
import { SETTING_KEYS, getSetting, getSettings, setSetting } from '../../lib/settings.js';
import { createHomeworkSchema } from '../homeworks/homeworks.schemas.js';
import { createNotificationSchema } from '../notifications/notifications.schemas.js';
import type { AiInterpretInput, UpdateAiSettingsInput } from './ai.schemas.js';

/**
 * 大模型助手：**只解析、不落库**。
 *
 * 设计边界（照 approved 计划）：
 * 1. 模型只输出结构化意图（`{action, params, confidence}`），服务端用**与手动入口同一份 zod**
 *    二次校验后返回预览；真正落库由前端确认后调既有端点（`POST /homeworks` 等），
 *    于是权限断言、上课时段紧急通知保护全部自动复用（AGENTS.md 的现行工程约定）；
 * 2. **密钥只进不出**：`AppSetting` 里存的是 `encryptSecret()` 的密文，任何 GET 都不回传；
 * 3. `provider: 'mock'` 用确定性规则离线解析 —— 自动化验收**绝不访问外网**（§5 第 52 条），
 *    真实模型走 `provider: 'openai'` 时的 `{baseUrl}/chat/completions`。
 */
const DEFAULT_TIMEOUT_MS = 20_000;

/** 与手动入口同源的参数校验（助手不得放宽任何字段约束） */
const homeworkParamsSchema = createHomeworkSchema.pick({
  classId: true,
  courseId: true,
  title: true,
  content: true,
  assignDate: true,
});
const notificationParamsSchema = createNotificationSchema.pick({
  classId: true,
  title: true,
  content: true,
  priority: true,
});
const callParamsSchema = z.object({
  classId: z.string().min(1),
  studentId: z.string().min(1).optional(),
  studentName: z.string().trim().max(40).optional(),
  message: z.string().trim().max(200).optional(),
});

const modelReplySchema = z.object({
  action: z.enum(['create_homework', 'create_notification', 'call_student', 'unknown']),
  params: z.record(z.string(), z.unknown()).default({}),
  confidence: z.number().min(0).max(1).optional(),
  reason: z.string().max(200).optional(),
});

export async function getAiSettings(): Promise<AiSettingsDto> {
  const values = await getSettings([
    SETTING_KEYS.aiEnabled,
    SETTING_KEYS.aiProvider,
    SETTING_KEYS.aiBaseUrl,
    SETTING_KEYS.aiModel,
    SETTING_KEYS.aiApiKey,
    SETTING_KEYS.aiSystemPromptExtra,
  ]);
  const apiKey = decryptSecret(values[SETTING_KEYS.aiApiKey] ?? '');
  return {
    enabled: values[SETTING_KEYS.aiEnabled] === 'true',
    provider: values[SETTING_KEYS.aiProvider] === 'mock' ? 'mock' : 'openai',
    baseUrl: values[SETTING_KEYS.aiBaseUrl] ?? '',
    model: values[SETTING_KEYS.aiModel] ?? '',
    hasApiKey: apiKey.length > 0,
    keyHint: apiKey.length >= 4 ? apiKey.slice(-4) : '',
    systemPromptExtra: values[SETTING_KEYS.aiSystemPromptExtra] ?? '',
  };
}

export async function updateAiSettings(
  user: TokenPayload,
  input: UpdateAiSettingsInput,
): Promise<AiSettingsDto> {
  assertAdmin(user);
  if (input.enabled !== undefined) await setSetting(SETTING_KEYS.aiEnabled, input.enabled ? 'true' : 'false');
  if (input.provider !== undefined) await setSetting(SETTING_KEYS.aiProvider, input.provider);
  if (input.baseUrl !== undefined) await setSetting(SETTING_KEYS.aiBaseUrl, input.baseUrl.trim());
  if (input.model !== undefined) await setSetting(SETTING_KEYS.aiModel, input.model.trim());
  if (input.systemPromptExtra !== undefined) {
    await setSetting(SETTING_KEYS.aiSystemPromptExtra, input.systemPromptExtra.trim());
  }
  if (input.apiKey !== undefined) {
    // 传 null = 清除；传字符串 = 换成新密钥（空串按清除处理）
    await setSetting(SETTING_KEYS.aiApiKey, input.apiKey ? encryptSecret(input.apiKey.trim()) : '');
  }
  logger.info(`大模型设置已更新（操作人=${user.username}，密钥${input.apiKey ? '已更新' : '未改'}）`);
  return getAiSettings();
}

interface AssistantContext {
  classes: { id: string; name: string }[];
  courses: { id: string; name: string }[];
}

async function resolveContext(user: TokenPayload, classId?: string): Promise<AssistantContext> {
  if (classId) await assertClassAccess(user, classId, 'ai:use');
  await assertPermission(user, 'ai:use');
  const candidates = new Set(
    (
      await Promise.all(
        ['notification:publish', 'homework:write', 'call:create'].map((key) =>
          classIdsFor(user, key as PermissionKey),
        ),
      )
    ).flat(),
  );
  const classIds = (await getAccessibleClassIds(user, 'ai:use')).filter((id) => candidates.has(id));
  const classes = await prisma.class.findMany({
    where: {
      id: { in: classIds },
      ...(user.role !== 'ADMIN'
        ? { OR: [{ teacherId: user.sub }, { courses: { some: { teacherId: user.sub } } }] }
        : {}),
    },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
    take: 80,
  });
  const courses =
    classId && classIds.includes(classId)
      ? await prisma.course.findMany({ where: { classId }, select: { id: true, name: true } })
      : [];
  return { classes, courses };
}

function buildSystemPrompt(context: AssistantContext, extra: string): string {
  return [
    '你是班级管理系统的指令解析器。把老师的一句中文转成严格 JSON，不要输出任何解释。',
    '可选动作（action）：create_homework（布置作业）、create_notification（发通知）、call_student（叫学生来）、unknown（看不懂）。',
    '输出格式：{"action":"…","params":{…},"confidence":0~1}。',
    'create_homework 的 params：{classId, courseId?, title, content, assignDate?(YYYY-MM-DD)}。',
    'create_notification 的 params：{classId, title, content, priority?(LOW|NORMAL|HIGH|URGENT)}。',
    'call_student 的 params：{classId, studentName, message?}。',
    `今天日期：${dayKeyLocal(new Date())}。`,
    `可用班级：${context.classes.map((item) => `${item.name}(${item.id})`).join('、') || '无'}。`,
    context.courses.length
      ? `候选班级的科目：${context.courses.map((item) => `${item.name}(${item.id})`).join('、')}。`
      : '未指定班级时 courseId 留空。',
    '信息不足时把 confidence 压低并在 reason 里说明缺什么；不要编造不存在于上面的班级/科目 id。',
    extra ? `学校额外要求：${extra}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** 离线确定性解析（provider=mock）：只做关键词判断，供自动化与"没配模型时试跑"用 */
function mockInterpret(text: string, context: AssistantContext): z.infer<typeof modelReplySchema> {
  // 优先用句子里**真正提到的**班级（「给2026级1班布置作业」）；都没提到才退回按名称升序的第一个。
  // （曾经只取第一个，结果本机取到了已归档的 2023级1班，与句子里说的班级无关。）
  const mentioned = context.classes.find((item) => text.includes(item.name));
  const classId = mentioned?.id ?? context.classes[0]?.id ?? '';
  if (!classId) return { action: 'unknown', params: {}, confidence: 0.1, reason: '当前账号没有可发布的班级' };
  const course = context.courses.find((item) => text.includes(item.name));

  if (/作业|布置|卷子|练习|预习|背诵/.test(text)) {
    return {
      action: 'create_homework',
      params: {
        classId,
        courseId: course?.id ?? null,
        title: text.length <= 40 ? text : `${text.slice(0, 38)}…`,
        content: text,
        assignDate: dayKeyLocal(new Date()),
      },
      confidence: 0.55,
    };
  }
  if (/通知|告知|提醒|传达/.test(text)) {
    return {
      action: 'create_notification',
      params: {
        classId,
        title: text.length <= 40 ? text : `${text.slice(0, 38)}…`,
        content: text,
        priority: /紧急|立即|马上/.test(text) ? 'URGENT' : 'NORMAL',
      },
      confidence: 0.55,
    };
  }
  if (/叫|找|来一趟|办公室/.test(text)) {
    const matched = /\S{2,4}(?=同学|来|到)/.exec(text);
    return {
      action: 'call_student',
      params: { classId, studentName: matched?.[0] ?? '', message: text },
      confidence: 0.4,
      reason: '离线示例解析只按关键词猜测学生姓名',
    };
  }
  return { action: 'unknown', params: {}, confidence: 0.2, reason: '没听懂要做什么' };
}

async function callOpenAi(
  input: AiInterpretInput,
  extension: { baseUrl: string; model: string; apiKey: string; prompt: string },
): Promise<z.infer<typeof modelReplySchema>> {
  let response: Response;
  try {
    response = await fetch(`${extension.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${extension.apiKey}`,
      },
      body: JSON.stringify({
        model: extension.model || 'gpt-4o-mini',
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: extension.prompt },
          { role: 'user', content: input.text },
        ],
      }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ApiError(
      504,
      'AI_TIMEOUT',
      `无法连接大模型服务：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!response.ok) {
    throw ApiError.badRequest(`大模型服务返回 HTTP ${response.status}（请检查服务地址、模型名与密钥）`);
  }

  const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  const content = body.choices?.[0]?.message?.content ?? '';
  try {
    return modelReplySchema.parse(JSON.parse(content));
  } catch {
    logger.warn(`大模型返回无法解析：${content.slice(0, 200)}`);
    throw new ApiError(502, 'AI_INVALID_OUTPUT', '大模型返回的内容不是可用的指令，请换一种说法');
  }
}

/** 把校验通过的参数解析成"给人看的预览"（班级/科目/学生名都换成中文） */
async function buildPreview(
  action: AiActionKind,
  params: Record<string, unknown>,
): Promise<AiInterpretResult['preview']> {
  const warnings: string[] = [];
  const classId = typeof params.classId === 'string' ? params.classId : '';
  const classRecord = classId
    ? await prisma.class.findUnique({ where: { id: classId }, select: { name: true } })
    : null;

  if (action === 'create_homework') {
    const courseId = typeof params.courseId === 'string' ? params.courseId : '';
    const course = courseId
      ? await prisma.course.findUnique({ where: { id: courseId }, select: { name: true } })
      : null;
    if (!course) warnings.push('没有指定科目：只有班主任/管理员能发不指定科目的作业');
    return {
      summary: `给${classRecord?.name ?? '未知班级'}布置作业：${String(params.title ?? '')}`,
      className: classRecord?.name ?? null,
      courseName: course?.name ?? null,
      warnings,
    };
  }

  if (action === 'create_notification') {
    return {
      summary: `给${classRecord?.name ?? '未知班级'}发通知：${String(params.title ?? '')}`,
      className: classRecord?.name ?? null,
      warnings,
    };
  }

  if (action === 'call_student') {
    const studentName = typeof params.studentName === 'string' ? params.studentName : '';
    const student =
      studentName && classId
        ? await prisma.student.findFirst({
            where: { classId, name: studentName, ...activeStudentWhere() },
            select: { id: true, name: true },
          })
        : null;
    if (!student) warnings.push(studentName ? `没找到学生「${studentName}」` : '没识别出学生姓名');
    return {
      summary: `叫${student?.name ?? (studentName || '某位同学')}到老师这里`,
      className: classRecord?.name ?? null,
      studentName: student?.name ?? (studentName || null),
      warnings,
    };
  }

  return { summary: '没听懂要做什么，请换一种说法', warnings: ['助手没有解析出可用动作'] };
}

/**
 * POST /api/ai/interpret - 解析一句中文，返回**待确认**的结构化动作。
 * 绝不写业务表；只写一条 `AiAudit`（谁在什么时候让助手做了什么）。
 */
export async function interpret(user: TokenPayload, input: AiInterpretInput): Promise<AiInterpretResult> {
  const settings = await getAiSettings();
  if (!settings.enabled) {
    throw new ApiError(400, 'AI_NOT_CONFIGURED', '助手功能还没开启，请管理员在「大模型设置」里打开');
  }
  if (settings.provider === 'openai' && (!settings.hasApiKey || !settings.baseUrl)) {
    throw new ApiError(
      400,
      'AI_NOT_CONFIGURED',
      '还没配置大模型服务地址或密钥，请管理员在「大模型设置」里填写',
    );
  }

  const context = await resolveContext(user, input.classId);
  const reply =
    settings.provider === 'mock'
      ? mockInterpret(input.text, context)
      : await callOpenAi(input, {
          baseUrl: settings.baseUrl,
          model: settings.model,
          apiKey: decryptSecret(await getSetting(SETTING_KEYS.aiApiKey)),
          prompt: buildSystemPrompt(context, settings.systemPromptExtra),
        });

  // 用与手动入口同一份 zod 再校验一次：模型给的东西**不可信**
  let action: AiActionKind = 'unknown';
  let params: Record<string, unknown> = {};
  const warnings: string[] = [];
  try {
    if (reply.action === 'create_homework') {
      const parsed = homeworkParamsSchema.parse({
        ...reply.params,
        classId: reply.params.classId ?? input.classId,
      });
      action = 'create_homework';
      params = parsed as unknown as Record<string, unknown>;
    } else if (reply.action === 'create_notification') {
      const parsed = notificationParamsSchema.parse({
        ...reply.params,
        classId: reply.params.classId ?? input.classId,
      });
      action = 'create_notification';
      params = parsed as unknown as Record<string, unknown>;
    } else if (reply.action === 'call_student') {
      const parsed = callParamsSchema.parse({
        ...reply.params,
        classId: reply.params.classId ?? input.classId,
      });
      action = 'call_student';
      params = parsed as unknown as Record<string, unknown>;
    }
  } catch (error) {
    warnings.push('助手给出的参数不完整，请手动补全后再发布');
    logger.warn(`助手参数校验失败：${error instanceof Error ? error.message : String(error)}`);
  }

  if (typeof params.classId === 'string') {
    await assertClassAccess(user, params.classId, 'ai:use');
    if (typeof params.courseId === 'string') {
      const course = await prisma.course.findFirst({
        where: { id: params.courseId, classId: params.classId },
        select: { id: true },
      });
      if (!course) throw ApiError.badRequest('科目不属于所选班级');
    }
  }
  const preview = await buildPreview(action, params);
  preview.warnings = [...preview.warnings, ...warnings];
  if (settings.provider === 'mock') preview.warnings.push('当前是离线示例解析（未配置真实模型），请仔细核对');

  await prisma.aiAudit.create({
    data: {
      userId: user.sub,
      prompt: input.text,
      intent: action,
      // 审计只记录解析，不代表前端确认后的业务操作已执行。
      status: action === 'unknown' ? 'unrecognized' : 'interpreted',
      message: preview.summary,
      rawReply: JSON.stringify(reply).slice(0, 2000),
    },
  });

  return {
    action,
    params,
    preview,
    confidence: reply.confidence ?? 0.5,
    needConfirm: true,
    rawReply: null,
  };
}

/** GET /api/ai/audit - 助手使用审计（最近 N 条） */
export async function listAudit(limit = 50): Promise<AiAuditDto[]> {
  const rows = await prisma.aiAudit.findMany({ orderBy: { createdAt: 'desc' }, take: limit });
  // `AiAudit.userId` 是普通字符串列（schema 里没有建 User 关系），所以姓名另外查一次
  const userIds = [...new Set(rows.map((row) => row.userId))];
  const users = userIds.length
    ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })
    : [];
  return rows.map((row) => ({
    id: row.id,
    userId: row.userId,
    userName: users.find((user) => user.id === row.userId)?.name ?? '',
    prompt: row.prompt,
    intent: row.intent,
    status: row.status,
    message: row.message,
    createdAt: row.createdAt.toISOString(),
  }));
}
