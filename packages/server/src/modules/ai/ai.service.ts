import type { AiAuditDto, AiSettingsDto } from '@classhelper/shared';
import { assertAdmin } from '../../lib/authz/index.js';
import { prisma } from '../../lib/db.js';
import type { TokenPayload } from '../../lib/jwt.js';
import { logger } from '../../lib/logger.js';
import { decryptSecret, encryptSecret } from '../../lib/secrets.js';
import { SETTING_KEYS, getSettings, setSetting } from '../../lib/settings.js';
import type { AiInterpretInput, UpdateAiSettingsInput } from './ai.schemas.js';

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

export async function interpret(user: TokenPayload, input: AiInterpretInput) {
  const { interpretConversation } = await import('./conversation.js');
  return interpretConversation(user, input);
}

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
