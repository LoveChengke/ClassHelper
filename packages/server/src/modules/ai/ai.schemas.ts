import { z } from 'zod';

/** 大模型服务端实现：openai=真接口 / mock=离线确定性结果（自动化验收用，不联网） */
export const AI_PROVIDERS = ['openai', 'mock'] as const;
const reasoningEffortSchema = z.enum(['auto', 'none', 'low', 'medium', 'high', 'max']);

/** `PUT /api/ai/settings`：字段都可选；`apiKey` 传字符串=换新、null=清除、不传=保持 */
export const updateAiSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  provider: z.enum(AI_PROVIDERS).optional(),
  baseUrl: z.string().trim().max(300).optional(),
  model: z.string().trim().max(120).optional(),
  reasoningEffort: reasoningEffortSchema.optional(),
  apiKey: z.string().trim().max(300).nullable().optional(),
  systemPromptExtra: z.string().trim().max(1000).optional(),
});

export const discoverModelsSchema = updateAiSettingsSchema.pick({ baseUrl: true, apiKey: true });

/** `POST /api/ai/interpret`：一句中文原话 */
export const aiInterpretSchema = z.object({
  supersedesTaskId: z.string().min(1).max(100).optional(),
  conversationId: z.string().min(1).max(100).optional(),
  text: z.string().trim().min(1, '请说明要做的事').max(8000),
  messages: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(8000) }).strict())
    .max(20)
    .optional(),
  attachments: z
    .array(
      z
        .object({
          id: z.string().min(1).max(100),
          name: z.string().min(1).max(180),
          size: z
            .number()
            .int()
            .min(1)
            .max(512 * 1024 * 1024),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    )
    .max(8)
    .refine((items) => new Set(items.map((item) => item.id)).size === items.length, '附件标识重复')
    .optional(),
  classId: z.string().min(1).optional(),
});

export const aiAuditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export type UpdateAiSettingsInput = z.infer<typeof updateAiSettingsSchema>;
export type AiInterpretInput = z.infer<typeof aiInterpretSchema>;
export type AiAuditQuery = z.infer<typeof aiAuditQuerySchema>;

export const planIdSchema = z.object({ id: z.string().min(1).max(100) });
export const taskAttachmentSchema = z.object({
  id: z.string().min(1).max(100),
  attachmentId: z.string().min(1).max(100),
});
export const preparePlanSchema = z
  .object({
    files: z.record(z.string(), z.object({ contentBase64: z.string().max(12 * 1024 * 1024) }).strict()),
    mappings: z.record(z.string(), z.record(z.string(), z.string().max(200))).optional(),
  })
  .strict();
export const confirmPlanSchema = z
  .object({
    confirmed: z.literal(true),
    extraConfirmed: z.boolean().optional(),
    urgentConfirmed: z.boolean().optional(),
    secrets: z.record(z.string(), z.record(z.string(), z.string().max(128))).optional(),
  })
  .strict();
