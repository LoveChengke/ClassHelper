import { prisma } from '../../lib/db.js';
import { ApiError } from '../../lib/http.js';
import type { TokenPayload } from '../../lib/jwt.js';
import { logger } from '../../lib/logger.js';
import { assertCanManageSchedule } from '../../lib/access.js';
import type { TimeLayoutImportInput } from './imports.schemas.js';

/**
 * ClassIsland 课表时间（TimeLayout）导入。
 *
 * ClassIsland 的导出结构在不同版本里略有差异，常见形态：
 *   1. 顶层就是数组：`[{ StartTime: "8:0:0", EndTime: "8:45:0", TimeType: 0 }, ...]`
 *   2. 包在对象里：`{ TimeLayouts: [...] }` / `{ TimeLayoutItems: [...] }` / `{ items: [...] }`
 *   3. 时间用秒表示：`{ StartSecond: 28800, EndSecond: 31500 }`
 *   4. 字段名大小写/命名不同：`StartTime` / `startTime` / `Start`；`Name` / `Title`
 *
 * 因此这里做**容错解析**：先把可能的数组抠出来，再逐条按候选字段名解析时间，
 * 解析失败的行进入 errors（不写库），成功解析但可疑的进入 warnings（可继续导入）。
 */
export type TimeLayoutItemType = 'class' | 'break' | 'divider' | 'action';

export interface ParsedTimeLayoutItem {
  index: number;
  name: string;
  startTime: string;
  endTime: string;
  type: TimeLayoutItemType;
  skipped: boolean;
}

export interface TimeLayoutParseResult {
  items: ParsedTimeLayoutItem[];
  errors: string[];
  warnings: string[];
}

const TIME_KEYS = ['StartTime', 'startTime', 'start', 'Start'] as const;
const END_KEYS = ['EndTime', 'endTime', 'end', 'End'] as const;
const START_SECOND_KEYS = ['StartSecond', 'startSecond', 'StartSeconds'] as const;
const END_SECOND_KEYS = ['EndSecond', 'endSecond', 'EndSeconds'] as const;
const NAME_KEYS = ['Name', 'name', 'Title', 'title', 'Subject'] as const;
const TYPE_KEYS = ['TimeType', 'timeType', 'Type', 'type'] as const;
const SKIP_KEYS = ['IsSkipped', 'isSkipped', 'Skipped', 'skip'] as const;

function pick(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

/** 把 ClassIsland 的时间写法统一成 HH:mm */
function normalizeTime(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // 数字：优先按"秒"解释（ClassIsland 的 StartSecond），小于 100 时按"分钟"
    const seconds = value > 100 ? value : value * 60;
    return secondsToHHmm(seconds);
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;

  // HH:mm / H:mm / HH:mm:ss / H:mm:ss
  const match = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/.exec(text);
  if (match) {
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) return null;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }

  // ISO 字符串（ClassIsland 某些版本导出 "2024-01-01T08:00:00"）
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    return `${String(parsed.getHours()).padStart(2, '0')}:${String(parsed.getMinutes()).padStart(2, '0')}`;
  }
  return null;
}

function secondsToHHmm(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hour = Math.floor(total / 3600) % 24;
  const minute = Math.floor((total % 3600) / 60);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * 从任意形态里抠出"可能是时间表条目"的数组。
 *
 * ClassIsland 真实档案（`Profiles/<档案名>.json`，1.7.106+ / 2.x）里是：
 *   `{ "TimeLayouts": { "<guid>": { "Name": "默认", "Layouts": [ { StartTime, EndTime, TimeType } ] } } }`
 * —— 即**按 Guid 索引的字典**，条目在各自的 `Layouts` 里。早期版本还可能直接是数组或 `{ items: [...] }`。
 * 之前只认数组 / `.items`，导致真实导出文件完全导不进来（本次修复）。
 */
function extractItems(input: unknown): { items: unknown[]; shape: string } {
  if (Array.isArray(input)) return { items: input, shape: 'array' };
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    for (const key of ['TimeLayouts', 'TimeLayoutItems', 'Items', 'items', 'Layouts']) {
      const value = record[key];
      if (Array.isArray(value)) return { items: value, shape: key };
      // 有些导出是 { TimeLayouts: { items: [...] } }
      const nestedItems =
        value && typeof value === 'object' ? (value as Record<string, unknown>).items : null;
      if (Array.isArray(nestedItems)) {
        return { items: nestedItems as unknown[], shape: `${key}.items` };
      }
      // ClassIsland 真实形态：Guid → { Name, Layouts: [...] }；合并所有时间表的 Layouts
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const merged: unknown[] = [];
        let layoutCount = 0;
        for (const entry of Object.values(value as Record<string, unknown>)) {
          const layoutRecord = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null;
          const layouts = layoutRecord?.Layouts ?? layoutRecord?.layouts;
          if (Array.isArray(layouts)) {
            merged.push(...layouts);
            layoutCount += 1;
          }
        }
        if (merged.length > 0) {
          return { items: merged, shape: `${key}{guid}×${layoutCount}` };
        }
      }
    }
    // 单个时间表对象：{ Name, Layouts: [...] }
    const single = record.Layouts ?? record.layouts;
    if (Array.isArray(single)) return { items: single, shape: 'Layouts' };
  }
  return { items: [], shape: 'unknown' };
}

function normalizeType(record: Record<string, unknown>): TimeLayoutItemType {
  const raw = pick(record, TYPE_KEYS);
  const numeric = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
  if (numeric === 1) return 'break';
  if (numeric === 3) return 'action'; // ClassIsland TimeType=3：行动（非上课/课间）
  if (numeric === 2) return 'divider';
  return 'class';
}

export function parseClassIslandTimeLayout(input: unknown): TimeLayoutParseResult {
  let payload = input;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch (error) {
      return { items: [], errors: [`JSON 解析失败：${(error as Error).message}`], warnings: [] };
    }
  }

  const { items: rawItems, shape } = extractItems(payload);
  const errors: string[] = [];
  const warnings: string[] = [];

  if (rawItems.length === 0) {
    return {
      items: [],
      errors: [
        '未识别到时间表条目：请确认是 ClassIsland 导出的课表时间 JSON（数组或含 TimeLayouts/TimeLayoutItems 字段）',
      ],
      warnings: [],
    };
  }
  if (shape === 'unknown') {
    warnings.push('未识别外层结构，已尝试按数组解析');
  }

  const parsed: ParsedTimeLayoutItem[] = [];
  rawItems.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      errors.push(`第 ${index + 1} 条：不是对象，已跳过`);
      return;
    }
    const record = raw as Record<string, unknown>;

    const start =
      normalizeTime(pick(record, TIME_KEYS)) ?? normalizeTime(pick(record, START_SECOND_KEYS)) ?? null;
    const end = normalizeTime(pick(record, END_KEYS)) ?? normalizeTime(pick(record, END_SECOND_KEYS)) ?? null;

    const skipped = pick(record, SKIP_KEYS) === true || pick(record, SKIP_KEYS) === 'true';
    const type = normalizeType(record);
    const nameRaw = pick(record, NAME_KEYS);
    const name = typeof nameRaw === 'string' && nameRaw.trim() ? nameRaw.trim() : '';

    if (!start || !end) {
      if (type === 'divider') {
        warnings.push(`第 ${index + 1} 条：分割线没有时间，已忽略`);
        return;
      }
      errors.push(
        `第 ${index + 1} 条（${name || '未命名'}）：无法解析开始/结束时间` +
          `（支持 StartTime: "8:0:0"、StartSecond: 28800 等写法）`,
      );
      return;
    }
    if (start >= end) {
      errors.push(`第 ${index + 1} 条（${name || '未命名'}）：结束时间 ${end} 不晚于开始时间 ${start}`);
      return;
    }
    if (skipped) warnings.push(`第 ${index + 1} 条（${name || '未命名'}）：原配置标记为跳过`);

    parsed.push({
      index: parsed.length + 1,
      name: name || `第 ${parsed.length + 1} 节`,
      startTime: start,
      endTime: end,
      type,
      skipped,
    });
  });

  // 排序 + 重叠检测（不阻断导入，仅提示）
  parsed.sort((a, b) => a.startTime.localeCompare(b.startTime));
  for (let index = 1; index < parsed.length; index += 1) {
    const previous = parsed[index - 1];
    const current = parsed[index];
    if (
      previous &&
      current &&
      previous.type === 'class' &&
      current.type === 'class' &&
      current.startTime < previous.endTime
    ) {
      warnings.push(
        `时间重叠：${previous.startTime}-${previous.endTime} 与 ${current.startTime}-${current.endTime}`,
      );
    }
  }

  return { items: parsed, errors, warnings };
}

export interface TimeLayoutDto {
  id: string;
  classId: string;
  name: string;
  source: string;
  items: ParsedTimeLayoutItem[];
  createdAt: string;
  updatedAt: string;
}

function toDto(record: {
  id: string;
  classId: string;
  name: string;
  source: string;
  items: string;
  createdAt: Date;
  updatedAt: Date;
}): TimeLayoutDto {
  let items: ParsedTimeLayoutItem[] = [];
  try {
    items = JSON.parse(record.items) as ParsedTimeLayoutItem[];
  } catch {
    items = [];
  }
  return {
    id: record.id,
    classId: record.classId,
    name: record.name,
    source: record.source,
    items,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/** 预览：只解析不落库（失败时原配置不受影响） */
export function previewClassIslandTimeLayout(payload: unknown): TimeLayoutParseResult & { shape: string } {
  return {
    ...parseClassIslandTimeLayout(payload),
    shape: extractItems(typeof payload === 'string' ? safeJson(payload) : payload).shape,
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function listTimeLayouts(user: TokenPayload, classId: string): Promise<TimeLayoutDto[]> {
  await assertCanManageSchedule(user, classId);
  const records = await prisma.timeLayout.findMany({ where: { classId }, orderBy: { updatedAt: 'desc' } });
  return records.map(toDto);
}

/**
 * 导入（写入）：解析 → 有错误直接 400（不写库）→ 按 replace/merge 落库。
 * 权限与"课表管理"一致：管理员或本班班主任。
 */
export async function importTimeLayout(
  user: TokenPayload,
  input: TimeLayoutImportInput,
): Promise<{ layout: TimeLayoutDto; mode: string; warnings: string[]; replaced: number; merged: number }> {
  await assertCanManageSchedule(user, input.classId);

  const parsed = parseClassIslandTimeLayout(input.payload);
  if (parsed.errors.length > 0) {
    throw new ApiError(400, 'IMPORT_INVALID', '课表时间配置解析失败，已保持原有配置不变', {
      errors: parsed.errors,
      warnings: parsed.warnings,
    });
  }
  if (parsed.items.length === 0) {
    throw new ApiError(400, 'IMPORT_EMPTY', '没有解析到任何有效节次，已保持原有配置不变', {
      warnings: parsed.warnings,
    });
  }

  const name = input.name?.trim() || '默认时间表';
  const existing = await prisma.timeLayout.findMany({
    where: { classId: input.classId },
    orderBy: { updatedAt: 'desc' },
  });
  const current = existing.find((item) => item.name === name) ?? existing[0] ?? null;

  if (input.mode === 'merge' && current) {
    let previousItems: ParsedTimeLayoutItem[] = [];
    try {
      previousItems = JSON.parse(current.items) as ParsedTimeLayoutItem[];
    } catch {
      previousItems = [];
    }

    // 以"开始时间"为槽位标识：
    // - 导入项与旧配置的开始时间相同 → 视为同一节次被覆盖（计入 merged）
    // - 开始时间不同 → 视为新增（计入 replaced），旧节次全部保留
    // 注意：旧配置里可能存在开始时间相同的多条（例如分割线/跳过的节次），
    // 只有被此次导入显式覆盖的那些才移除，避免合并时静默丢数据。
    const incomingStarts = new Set(parsed.items.map((item) => item.startTime));
    const previousStarts = new Set(previousItems.map((item) => item.startTime));
    const merged = parsed.items.filter((item) => previousStarts.has(item.startTime)).length;
    const replaced = parsed.items.length - merged;
    const preserved = previousItems.filter((item) => !incomingStarts.has(item.startTime));
    const combined = [...preserved, ...parsed.items].sort((a, b) => a.startTime.localeCompare(b.startTime));

    const updated = await prisma.timeLayout.update({
      where: { id: current.id },
      data: {
        items: JSON.stringify(combined.map((item, index) => ({ ...item, index: index + 1 }))),
        source: 'classisland',
      },
    });
    logger.info(
      `课表时间配置合并导入：班级=${input.classId} 覆盖=${merged} 新增=${replaced} 共 ${combined.length} 节`,
    );
    return { layout: toDto(updated), mode: 'merge', warnings: parsed.warnings, replaced, merged };
  }

  // replace：同一班级同名配置整体替换；没有则新建
  if (current) {
    const updated = await prisma.timeLayout.update({
      where: { id: current.id },
      data: { items: JSON.stringify(parsed.items), name, source: 'classisland' },
    });
    logger.info(`课表时间配置覆盖导入：班级=${input.classId} 共 ${parsed.items.length} 节`);
    return {
      layout: toDto(updated),
      mode: 'replace',
      warnings: parsed.warnings,
      replaced: parsed.items.length,
      merged: 0,
    };
  }
  const created = await prisma.timeLayout.create({
    data: { classId: input.classId, name, source: 'classisland', items: JSON.stringify(parsed.items) },
  });
  logger.info(`课表时间配置新建：班级=${input.classId} 共 ${parsed.items.length} 节`);
  return {
    layout: toDto(created),
    mode: 'replace',
    warnings: parsed.warnings,
    replaced: parsed.items.length,
    merged: 0,
  };
}

export async function deleteTimeLayout(user: TokenPayload, layoutId: string): Promise<void> {
  const record = await prisma.timeLayout.findUnique({ where: { id: layoutId } });
  if (!record) throw ApiError.notFound('时间配置不存在');
  await assertCanManageSchedule(user, record.classId);
  await prisma.timeLayout.delete({ where: { id: layoutId } });
}
