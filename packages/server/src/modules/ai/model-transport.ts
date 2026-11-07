import { z } from 'zod';
import { EventStreamDecoder, type AiModelInfo, type AiReasoningEffort } from '@classhelper/shared';
import { ApiError } from '../../lib/http.js';
import { assertAdmin } from '../../lib/authz/index.js';
import type { TokenPayload } from '../../lib/jwt.js';
import { decryptSecret } from '../../lib/secrets.js';
import { getSetting, SETTING_KEYS } from '../../lib/settings.js';
import type { discoverModelsSchema } from './ai.schemas.js';
import { getAiSettings } from './ai.service.js';

export function modelEndpoint(baseUrl: string, resource = 'chat/completions'): string {
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    throw ApiError.badRequest('请填写有效的模型服务地址');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw ApiError.badRequest('请填写有效的模型服务地址');
  const base = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  url.pathname = `${base}/${resource}`;
  url.hash = '';
  return url.toString();
}

export async function discoverModels(
  user: TokenPayload,
  input: z.infer<typeof discoverModelsSchema>,
): Promise<AiModelInfo[]> {
  assertAdmin(user);
  const settings = await getAiSettings();
  const apiKey = input.apiKey?.trim() || decryptSecret(await getSetting(SETTING_KEYS.aiApiKey));
  if (!apiKey) throw ApiError.badRequest('请先填写模型密钥');
  let response: Response;
  try {
    response = await fetch(modelEndpoint(input.baseUrl ?? settings.baseUrl, 'models'), {
      headers: { authorization: `Bearer ${apiKey}` },
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new ApiError(502, 'AI_MODELS_UNAVAILABLE', '暂时无法获取模型列表，可重试或手动填写模型名');
  }
  if (!response.ok)
    throw new ApiError(
      502,
      'AI_MODELS_UNAVAILABLE',
      `模型列表请求失败（HTTP ${response.status}），请检查地址与密钥`,
    );
  const parsed = z
    .object({
      data: z
        .array(
          z.object({
            id: z.string().min(1).max(120),
            name: z.string().max(200).optional(),
            effort: z.object({ supported_levels: z.array(z.string()) }).optional(),
          }),
        )
        .max(2000),
    })
    .safeParse(await response.json());
  if (!parsed.success)
    throw new ApiError(502, 'AI_MODELS_UNAVAILABLE', '此服务未提供兼容的模型列表，可手动填写模型名');
  const levels: AiReasoningEffort[] = ['none', 'low', 'medium', 'high', 'max'];
  return [
    ...new Map(
      parsed.data.data.map((item) => [
        item.id,
        {
          id: item.id,
          name: item.name || item.id,
          efforts: item.effort
            ? [
                'auto' as const,
                'none' as const,
                ...levels.filter((level) => item.effort!.supported_levels.includes(level)),
              ]
            : ['auto' as const, ...levels.filter((level) => level !== 'max')],
        },
      ]),
    ).values(),
  ].sort((a, b) => a.id.localeCompare(b.id));
}

interface Completion {
  choices?: {
    message?: { content?: string };
    delta?: { content?: string; reasoning_content?: string };
    finish_reason?: string;
  }[];
  error?: unknown;
}
/** 只转发可展示的回复和阶段信息，不把模型推理原文、未校验参数或凭据发给浏览器。 */
export async function readCompletion(
  response: Response,
  onText: (content: string) => void,
  onReasoning?: (characters: number) => void,
): Promise<{ content: string; truncated: boolean }> {
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    const body = (await response.json()) as Completion;
    return {
      content: body.choices?.[0]?.message?.content ?? '',
      truncated: body.choices?.[0]?.finish_reason === 'length',
    };
  }
  if (!response.body) throw new Error('模型未返回内容');
  const reader = response.body.getReader(),
    decoder = new TextDecoder(),
    stream = new EventStreamDecoder();
  let reasoningCharacters = 0;
  let content = '',
    truncated = false,
    completed = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      for (const event of stream.push(decoder.decode(chunk.value, { stream: true }))) {
        if (event === '[DONE]') {
          completed = true;
          continue;
        }
        const data = JSON.parse(event) as Completion;
        if (data.error) throw new Error('模型流中断');
        const choice = data.choices?.[0];
        reasoningCharacters += choice?.delta?.reasoning_content?.length ?? 0;
        if (choice?.delta?.reasoning_content) onReasoning?.(reasoningCharacters);
        content += choice?.delta?.content ?? '';
        if (content.length > 256000) throw new Error('模型回复过长');
        if (choice?.finish_reason) completed = true;
        if (choice?.finish_reason === 'length') truncated = true;
        onText(content);
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return { content, truncated: truncated || !completed };
}
