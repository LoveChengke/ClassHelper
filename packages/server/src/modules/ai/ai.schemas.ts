import { z } from 'zod';

/** 大模型服务端实现：openai=真接口 / mock=离线确定性结果（自动化验收用，不联网） */
export const AI_PROVIDERS = ['openai', 'mock'] as const;

/** `PUT /api/ai/settings`：字段都可选；`apiKey` 传字符串=换新、null=清除、不传=保持 */
export const updateAiSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  provider: z.enum(AI_PROVIDERS).optional(),
  baseUrl: z.string().trim().max(300).optional(),
  model: z.string().trim().max(120).optional(),
  apiKey: z.string().trim().max(300).nullable().optional(),
  systemPromptExtra: z.string().trim().max(1000).optional(),
});

/** `POST /api/ai/interpret`：一句中文原话 */
export const aiInterpretSchema = z.object({
  text: z.string().trim().min(1, '请说一句要做的事').max(500, '一句话最多 500 个字'),
  classId: z.string().min(1).optional(),
});

export const aiAuditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export type UpdateAiSettingsInput = z.infer<typeof updateAiSettingsSchema>;
export type AiInterpretInput = z.infer<typeof aiInterpretSchema>;
export type AiAuditQuery = z.infer<typeof aiAuditQuerySchema>;
