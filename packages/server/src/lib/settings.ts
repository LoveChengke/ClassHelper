import { prisma } from './db.js';

/**
 * 全局设置（`AppSetting` 表的唯一读写入口）。
 *
 * 值一律存字符串：布尔存 `'true'`/`'false'`，复杂结构存 JSON 文本。
 * 键名集中在这里，避免各模块手写字符串导致拼错后"设置静默不生效"。
 */
export const SETTING_KEYS = {
  /** 服务端开发者模式（仅 ADMIN 可改）：错误响应带堆栈、日志降到 debug 级 */
  developerMode: 'system.developerMode',
  /** 大模型功能开关与配置（见 modules/ai） */
  aiEnabled: 'ai.enabled',
  /** 服务端解析器的实现：openai=真接口 / mock=离线确定性结果（自动化验收用） */
  aiProvider: 'ai.provider',
  aiBaseUrl: 'ai.baseUrl',
  aiModel: 'ai.model',
  /** 加密后的 API Key（见 lib/secrets.ts；接口只进不出） */
  aiApiKey: 'ai.apiKey',
  /** 追加到系统提示词末尾的学校自定义要求（可空） */
  aiSystemPromptExtra: 'ai.systemPromptExtra',
  /**
   * 全校学期开始日期（`YYYY-MM-DD`，本地日期）。
   *
   * 需求：「服务端可设置学期开始日期，以保证当前周次正确，管理员也可以随时纠正」。
   * 原先它只能来自 `.env` 的 `TERM_START_DATE`（改一次要动文件 + 重启），
   * 于是"开学日期填错了"这种事只能靠运维；现在管理员在「学期周次」页直接改，立即生效。
   * 班级自己的 `Class.termStartDate` 仍然优先（见 `lib/term.ts` 的三级回落）。
   */
  termStartDate: 'term.startDate',
  termMaxWeeks: 'term.maxWeeks',
  promotionAt: 'term.promotionAt',
  promotionPlan: 'term.promotionPlan',
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

export async function getSetting(key: SettingKey): Promise<string> {
  const row = await prisma.appSetting.findUnique({ where: { key }, select: { value: true } });
  return row?.value ?? '';
}

/** 批量读（避免逐键一条 SQL） */
export async function getSettings(keys: readonly SettingKey[]): Promise<Record<string, string>> {
  const rows = await prisma.appSetting.findMany({
    where: { key: { in: [...keys] } },
    select: { key: true, value: true },
  });
  const map: Record<string, string> = {};
  for (const key of keys) map[key] = '';
  for (const row of rows) map[row.key] = row.value;
  return map;
}

export async function setSetting(key: SettingKey, value: string): Promise<void> {
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
}

export async function getBooleanSetting(key: SettingKey, fallback = false): Promise<boolean> {
  const raw = await getSetting(key);
  if (raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

export async function setBooleanSetting(key: SettingKey, value: boolean): Promise<void> {
  await setSetting(key, value ? 'true' : 'false');
  if (key === SETTING_KEYS.developerMode) developerModeCache = value;
}

/**
 * 开发者模式的内存缓存。
 *
 * 为什么缓存：错误中间件与日志级别是**热路径**（每个出错请求都要问一次），
 * 不可能为此每请求查一次 `AppSetting`。缓存由三处维护：启动时 `refreshDeveloperMode()`、
 * 管理员改设置时（`setBooleanSetting` 顺手更新）、以及需要时可手动刷新。
 */
let developerModeCache = false;

export function isDeveloperMode(): boolean {
  return developerModeCache;
}

export async function refreshDeveloperMode(): Promise<void> {
  developerModeCache = await getBooleanSetting(SETTING_KEYS.developerMode, false);
}
