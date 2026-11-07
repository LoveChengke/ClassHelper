import { z } from 'zod';
import { dayKeyLocal, type AiInterpretResult, type AiConversationResult } from '@classhelper/shared';
import { assertPermission, assertPublish } from '../../lib/authz/index.js';
import { prisma } from '../../lib/db.js';
import { ApiError } from '../../lib/http.js';
import type { TokenPayload } from '../../lib/jwt.js';
import { activeStudentWhere } from '../../lib/students.js';
import { capabilities, runRead } from './actions.js';
import { createPlan } from './plans.js';
import { planWithModel, sanitizePrompt } from './model-planner.js';
import { getAiSettings } from './ai.service.js';
import type { AiInterpretInput } from './ai.schemas.js';

const operationSchema = z
  .object({
    action: z.string().min(1).max(80),
    target: z.record(z.string(), z.string().max(100)).optional(),
    params: z.record(z.string(), z.unknown()).optional(),
    query: z.record(z.string(), z.unknown()).optional(),
    attachmentId: z.string().max(100).optional(),
  })
  .strict();
const replySchema = z.object({
  message: z.string().max(4000).optional(),
  queries: z.array(operationSchema).max(8).default([]),
  operations: z.array(operationSchema).max(16).default([]),
});
const aliases: Record<string, string> = {
  create_homework: 'homeworks.create',
  create_notification: 'notifications.create',
  call_student: 'calls.create',
};

/** 本地确定性解析只用于 mock 和原有模型之外的文件、查询入口，不新增任何模型出站数据。 */
function localReply(
  input: AiInterpretInput,
  classes: { id: string; name: string }[],
): z.infer<typeof replySchema> | null {
  const classId =
    input.classId ||
    classes.find((item) => input.text.includes(item.name))?.id ||
    (classes.length === 1 ? classes[0]?.id : undefined);
  const text = input.text;
  if (/数据库|服务器|SQL|备份|密钥/.test(text))
    return replySchema.parse({ operations: [{ action: 'database.forbidden' }] });
  if (/查询|查看|列出|有哪些|查一下/.test(text)) {
    const action = /课件/.test(text)
      ? 'courseware.list'
      : /时间表/.test(text)
        ? 'layouts.list'
        : /课表/.test(text)
          ? 'plans.list'
          : /作业/.test(text)
            ? 'homeworks.list'
            : /通知/.test(text)
              ? 'notifications.list'
              : /设备/.test(text)
                ? 'clients.list'
                : /学生|名单/.test(text)
                  ? 'students.list'
                  : /岗位|权限/.test(text)
                    ? 'permissions.groups'
                    : /教师/.test(text)
                      ? 'teachers.list'
                      : /周次/.test(text)
                        ? 'term.weeks'
                        : /归档/.test(text)
                          ? 'archives.list'
                          : 'classes.list';
    return replySchema.parse({
      queries: [{ action, query: classId ? { classId } : {} }],
      message: '已读取记录',
    });
  }
  const file = input.attachments?.[0];
  if (file && !classId) return replySchema.parse({ message: '请选择目标班级。' });
  if (file && /推送|发送|课件/.test(text))
    return replySchema.parse({
      operations: [
        { action: 'courseware.upload', attachmentId: file.id, params: { classIds: [classId], mode: 'push' } },
      ],
    });
  if (file && /导入/.test(text)) {
    const action = /\.ya?ml$/i.test(file.name)
      ? 'imports.yaml'
      : /\.json$/i.test(file.name)
        ? /时间表|作息/.test(text)
          ? 'imports.layout'
          : 'imports.plan'
        : 'imports.table';
    return replySchema.parse({
      operations: [
        {
          action,
          attachmentId: file.id,
          params: {
            classId,
            mode: action === 'imports.table' ? 'upsert' : 'merge',
            ...(action === 'imports.table'
              ? {
                  kind: /成绩/.test(text) ? 'grades' : /教师/.test(text) ? 'teachers' : 'students',
                  mapping: {},
                }
              : {}),
          },
        },
      ],
    });
  }
  return null;
}

export async function interpretConversation(
  user: TokenPayload,
  input: AiInterpretInput,
): Promise<AiInterpretResult & AiConversationResult> {
  await assertPermission(user, 'ai:use');
  const settings = await getAiSettings();
  if (!settings.enabled) throw new ApiError(400, 'AI_NOT_CONFIGURED', '请管理员先开启 AI 助手');
  const tools = await capabilities(user);
  const classes = tools.some((item) => item.action === 'classes.list')
    ? ((await runRead(user, { action: 'classes.list' })) as { id: string; name: string }[])
    : [];
  let reply: z.infer<typeof replySchema> | null = null;
  if (settings.provider === 'mock') {
    try {
      reply = replySchema.parse(JSON.parse(input.text));
    } catch {
      /* 自然语言示例继续走本地解析。 */
    }
  }
  let modelResults: AiConversationResult['results'] = [];
  if (settings.provider === 'openai') {
    const planned = await planWithModel(user, input, tools, classes);
    reply = planned.reply;
    modelResults = planned.results;
  } else reply ??= localReply(input, classes);
  if (!reply) {
    const classId = input.classId || classes.find((item) => input.text.includes(item.name))?.id;
    if (!classId) reply = replySchema.parse({ message: '请明确目标班级。' });
    else if (/作业|布置|练习|预习|背诵/.test(input.text))
      reply = replySchema.parse({
        operations: [
          {
            action: 'homeworks.create',
            params: {
              classId,
              title: input.text.slice(0, 80),
              content: input.text,
              assignDate: dayKeyLocal(new Date()),
            },
          },
        ],
      });
    else if (/通知|告知|提醒/.test(input.text))
      reply = replySchema.parse({
        operations: [
          {
            action: 'notifications.create',
            params: {
              classId,
              title: input.text.slice(0, 80),
              content: input.text,
              priority: /紧急|立即|马上/.test(input.text) ? 'URGENT' : 'NORMAL',
            },
          },
        ],
      });
    else reply = replySchema.parse({ message: '离线示例未识别此任务，请配置模型或补充具体操作。' });
  }
  const results: AiConversationResult['results'] = [...modelResults];
  for (const query of reply.queries)
    results.push({
      action: query.action,
      label: tools.find((item) => item.action === query.action)?.label ?? query.action,
      data: await runRead(user, query),
    });
  for (const operation of reply.operations)
    if (operation.action === 'calls.create' && operation.params?.studentName && !operation.params.studentId) {
      const classId = String(operation.params.classId ?? '');
      await assertPublish(user, 'call:create', classId);
      const students = await prisma.student.findMany({
        where: { classId, name: String(operation.params.studentName), ...activeStudentWhere() },
        select: { id: true },
        take: 2,
      });
      if (students.length !== 1) throw ApiError.badRequest('学生姓名未找到或存在重名，请明确选择学生');
      operation.params.studentId = students[0]!.id;
      delete operation.params.studentName;
    }
  const plan = reply.operations.length
    ? await createPlan(user, sanitizePrompt(input.text), reply.operations, input.attachments ?? [])
    : { planId: null, steps: [] };
  const message =
    reply.message ||
    (plan.steps.length
      ? '请核对操作计划后确认执行。'
      : results.length
        ? '已读取记录。'
        : '请补充要处理的内容。');
  if (!plan.planId)
    await prisma.aiAudit.create({
      data: {
        userId: user.sub,
        prompt: sanitizePrompt(input.text),
        intent: results
          .map((item) => item.action)
          .join(',')
          .slice(0, 500),
        status: results.length ? 'queried' : 'unrecognized',
        message,
      },
    });
  const first = reply.operations[0];
  const action = Object.entries(aliases).find(([, modern]) => modern === first?.action)?.[0] as
    AiInterpretResult['action'] | undefined;
  return {
    ...plan,
    message,
    results,
    action: action ?? 'unknown',
    params: first?.params ?? {},
    preview: { summary: message, warnings: settings.provider === 'mock' ? ['当前为离线示例模式'] : [] },
    confidence: 0.8,
    needConfirm: !!plan.steps.length,
    rawReply: null,
  };
}
