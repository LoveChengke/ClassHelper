import { z } from 'zod';

const operationSchema = z
  .object({
    action: z.string().min(1).max(80),
    target: z.record(z.string(), z.string().max(100)).optional(),
    params: z.record(z.string(), z.unknown()).optional(),
    query: z.record(z.string(), z.unknown()).optional(),
    attachmentId: z.string().max(100).optional(),
  })
  .strict();
export const modelReplySchema = z
  .object({
    message: z.string().max(4000).optional(),
    questions: z
      .array(
        z.object({
          id: z.string().min(1).max(100),
          text: z.string().min(1).max(1000),
          options: z.array(z.string().min(1).max(200)).max(10).optional(),
        }),
      )
      .max(3)
      .optional(),
    queries: z.array(operationSchema).max(8).default([]),
    operations: z.array(operationSchema).max(16).default([]),
  })
  .refine(
    (v) => !!v.message?.trim() || !!v.questions?.length || v.queries.length > 0 || v.operations.length > 0,
    '回复不能是空对象',
  );
export type ModelReply = z.infer<typeof modelReplySchema>;

function isQuestion(text: string) {
  return /[?？]|是否|能否|可否|请(?:问|确认|选择|提供|补充|说明|指定)|which\b|would you\b|could you\b/i.test(
    text,
  );
}
function questionFromText(text: string) {
  return {
    id: 'question-1',
    text: text.slice(0, 1000),
    ...(/请确认|是否确认|确定(?:要|删除)|are you sure/i.test(text)
      ? { options: ['继续生成操作预览', '取消本次请求'] }
      : {}),
  };
}
/** 仅兼容展示与追问字段，不从自然语言推断任何业务动作、对象 id 或执行许可。 */
export function normalizeModelReply(value: unknown): ModelReply {
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text || !isQuestion(text)) throw new Error('模型回复不是有效的操作协议或追问');
    return modelReplySchema.parse({
      message: text,
      questions: [questionFromText(text)],
    });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return modelReplySchema.parse(value);
  const raw = value as Record<string, unknown>;
  const requested = raw.questions ?? (raw.question === undefined ? undefined : [raw.question]);
  let questions: unknown = requested;
  if (requested !== undefined) {
    const list = Array.isArray(requested) ? requested : [requested];
    questions = list.map((item, index) => {
      if (typeof item === 'string') return { id: `question-${index + 1}`, text: item.trim() };
      if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
      const question = item as Record<string, unknown>;
      return {
        id: question.id || `question-${index + 1}`,
        text: question.text ?? question.question,
        options: Array.isArray(question.options)
          ? question.options.map((option) =>
              typeof option === 'object' && option !== null && !Array.isArray(option)
                ? (option as Record<string, unknown>).label
                : option,
            )
          : question.options,
      };
    });
  }
  // 文字追问只能在没有业务动作/查询时转成问题；已有删除预览保留原有确认链。
  if (
    (questions === undefined || (Array.isArray(questions) && questions.length === 0)) &&
    typeof raw.message === 'string' &&
    isQuestion(raw.message) &&
    (raw.operations === undefined || (Array.isArray(raw.operations) && raw.operations.length === 0)) &&
    (raw.queries === undefined || (Array.isArray(raw.queries) && raw.queries.length === 0))
  ) {
    questions = [questionFromText(raw.message.trim())];
  }
  if (Array.isArray(questions) && questions.length) {
    return modelReplySchema.parse({ ...raw, questions, queries: [], operations: [] });
  }
  return modelReplySchema.parse({ ...raw, questions });
}
export function parseModelReply(content: string): ModelReply {
  const trimmed = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  const start = trimmed.indexOf('{'),
    end = trimmed.lastIndexOf('}');
  if (start >= 0 && end >= start) return normalizeModelReply(JSON.parse(trimmed.slice(start, end + 1)));
  // 不把截断的 JSON 或损坏的动作协议当普通提问吞掉。
  if (/^[{[\"]|^```/.test(trimmed)) return normalizeModelReply(JSON.parse(trimmed));
  return normalizeModelReply(trimmed);
}
