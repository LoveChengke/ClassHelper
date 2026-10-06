import {
  buildAutoTermWeeks,
  validateTermWeeks,
  type HolidaySuggestionDto,
  type TermWeeksDto,
} from '@classhelper/shared';
import { assertCanManageClasses, assertClassAccess } from '../../lib/access.js';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/db.js';
import { ApiError } from '../../lib/http.js';
import type { TokenPayload } from '../../lib/jwt.js';
import { logger } from '../../lib/logger.js';
import { MAX_TERM_WEEK, loadTermContext, resolveCurrentWeek } from '../../lib/term.js';
import { emitToClass } from '../../realtime/bus.js';
import { SOCKET_EVENTS } from '@classhelper/shared';
import { notifyScheduleChanged } from '../integrations/integrations.service.js';
import type { AutoTermWeeksInput, UpdateTermWeeksInput } from './term.schemas.js';

/**
 * 学期周次（仅管理员可写）。
 *
 * 为什么需要逐周配置：`TERM_START_DATE + 每周七天`的线性推算遇到法定节假日调休、
 * 周末补课、错峰开学就会**整体错位**——而课表、作业、成绩都按周次组织，错一周就全错。
 * 因此管理员可以：
 *   1. 先按开学日期一键生成逐周区间（`autoTermWeeks`）；
 *   2. 再逐周微调（调休那一周拉长、开学前那几天并进第 1 周…）；
 *   3. 也可以直接改某个班的开学日期（`Class.termStartDate`）。
 *
 * `classId = ''` 表示**全校默认**；某个班有自己的配置时优先用它。
 * 改完之后会把新的课表口径（含周次区间）**下发给该班所有在线的 ClassIsland**。
 */

/** 把 null/undefined 归一成空串（空串 = 全校默认） */
function scopeOf(classId?: string | null): string {
  return classId ?? '';
}

/** 读取某个范围的周次配置 */
export async function getTermWeeks(user: TokenPayload, classId?: string | null): Promise<TermWeeksDto> {
  const scope = scopeOf(classId);
  if (scope) await assertClassAccess(user, scope);

  const [weeks, cls] = await Promise.all([
    prisma.termWeek.findMany({ where: { classId: scope }, orderBy: { weekNumber: 'asc' } }),
    scope
      ? prisma.class.findUnique({ where: { id: scope }, select: { termStartDate: true, termWeeks: true } })
      : Promise.resolve(null),
  ]);

  const context = await loadTermContext(scope || null);
  return {
    classId: scope,
    termStartDate: context.termStartDate || env.termStartDate,
    currentWeek: resolveCurrentWeek(new Date(), context),
    maxWeek: cls?.termWeeks && cls.termWeeks > 0 ? cls.termWeeks : MAX_TERM_WEEK,
    configured: weeks.length > 0,
    weeks: weeks.map((item) => ({
      weekNumber: item.weekNumber,
      startDate: item.startDate,
      endDate: item.endDate,
      note: item.note,
    })),
  };
}

/**
 * 保存逐周配置（整表覆盖）。仅管理员。
 *
 * 校验：日期格式、起止顺序、**区间不重叠**（重叠会让"当前第几周"出现歧义）。
 * 保存后把新的周次口径下发给该班所有在线设备。
 */
export async function updateTermWeeks(user: TokenPayload, input: UpdateTermWeeksInput): Promise<TermWeeksDto> {
  assertCanManageClasses(user);
  const scope = scopeOf(input.classId);

  const errors = validateTermWeeks(input.weeks);
  if (errors.length > 0) throw ApiError.badRequest(errors[0]!, { errors });

  // 重复的周次号会让唯一约束直接抛 500，这里给一句人话
  const seen = new Set<number>();
  for (const week of input.weeks) {
    if (seen.has(week.weekNumber)) {
      throw ApiError.badRequest(`第 ${week.weekNumber} 周出现了两次`);
    }
    seen.add(week.weekNumber);
  }

  if (scope) {
    const exists = await prisma.class.findUnique({ where: { id: scope }, select: { id: true } });
    if (!exists) throw ApiError.notFound('班级不存在');
  }

  await prisma.$transaction([
    prisma.termWeek.deleteMany({ where: { classId: scope } }),
    ...(input.weeks.length > 0
      ? [
          prisma.termWeek.createMany({
            data: input.weeks.map((week) => ({
              classId: scope,
              weekNumber: week.weekNumber,
              startDate: week.startDate,
              endDate: week.endDate,
              note: week.note ?? '',
            })),
          }),
        ]
      : []),
    ...(input.termStartDate && scope
      ? [prisma.class.update({ where: { id: scope }, data: { termStartDate: input.termStartDate } })]
      : []),
  ]);

  logger.info(
    `学期周次已更新：范围=${scope || '全校默认'} 周数=${input.weeks.length} 由 ${user.name} 执行`,
  );
  await publishTermChange(scope);
  return getTermWeeks(user, scope || null);
}

/**
 * 按学期开始日期**一键生成**逐周区间（管理员再逐周微调）。仅管理员。
 *
 * 这是配置的起点：先生成一份"标准学期"，再把调休那几周改掉，
 * 比从空白开始一周周填要快得多。
 */
export async function autoTermWeeks(user: TokenPayload, input: AutoTermWeeksInput): Promise<TermWeeksDto> {
  assertCanManageClasses(user);
  const scope = scopeOf(input.classId);
  const context = await loadTermContext(scope || null);
  const termStartDate = input.termStartDate || context.termStartDate || env.termStartDate;
  const maxWeek = input.maxWeek ?? context.maxWeek;

  const weeks = buildAutoTermWeeks(termStartDate, maxWeek);
  if (weeks.length === 0) throw ApiError.badRequest('请先填写学期开始日期（第 1 教学周的周一）');

  return updateTermWeeks(user, { classId: scope || null, termStartDate, weeks });
}

/* ------------------------------------------------------------------ 调休建议（联网，可选） */

/** 建议结果的缓存（1 小时）：节假日数据一年才变几次，不必每次点都打外网 */
const holidayCache = new Map<number, { at: number; data: HolidaySuggestionDto }>();
const HOLIDAY_CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * 联网拉取法定节假日安排，给出「哪几天不上课」的建议。
 *
 * **`ok:false` 是设计内的结果**：机房与教室机器常常只有内网，离线 / 超时 / 限流
 * 一律收敛成 `ok:false` + 一句人话，绝不抛 500（与更新检查同一种处理思路）。
 * 而且它只**给建议**，不会自动改任何数据 —— 管理员确认后才应用到周次上。
 */
export async function suggestHolidays(year?: number): Promise<HolidaySuggestionDto> {
  const targetYear = year ?? new Date().getFullYear();
  const cached = holidayCache.get(targetYear);
  if (cached && Date.now() - cached.at < HOLIDAY_CACHE_TTL_MS) return cached.data;

  const fallback = (error: string): HolidaySuggestionDto => ({
    ok: false,
    error,
    year: targetYear,
    holidays: [],
    checkedAt: new Date().toISOString(),
  });

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(`https://timor.tech/api/holiday/year/${targetYear}`, {
      signal: controller.signal,
      headers: { 'user-agent': 'ClassHelper-TermWeeks' },
    }).finally(() => clearTimeout(timer));

    if (!response.ok) {
      const data = fallback(`节假日服务返回 ${response.status}`);
      holidayCache.set(targetYear, { at: Date.now(), data });
      return data;
    }

    const payload = (await response.json()) as {
      holiday?: Record<string, { holiday: boolean; name: string; date: string }>;
    };
    const holidays = Object.values(payload.holiday ?? {})
      .filter((item) => item.holiday === true)
      .map((item) => ({
        name: item.name,
        startDate: item.date,
        endDate: item.date,
      }))
      .sort((a, b) => a.startDate.localeCompare(b.startDate));

    const data: HolidaySuggestionDto = {
      ok: true,
      error: null,
      year: targetYear,
      holidays,
      checkedAt: new Date().toISOString(),
    };
    holidayCache.set(targetYear, { at: Date.now(), data });
    return data;
  } catch (error) {
    const reason =
      error instanceof Error && error.name === 'AbortError'
        ? '请求超时（服务器可能没有外网）'
        : `无法获取节假日数据：${error instanceof Error ? error.message : String(error)}`;
    const data = fallback(reason);
    // 失败结果同样进缓存：否则断网时点一次按钮就要白等一个超时
    holidayCache.set(targetYear, { at: Date.now(), data });
    return data;
  }
}

/* ------------------------------------------------------------------ 内部工具 */

/**
 * 周次变了要把新的口径**下发给教室的 ClassIsland**（需求：「对所有 ClassIsland 下发修改」）。
 *
 * 逐周区间没法直接塞进 ClassIsland 的模型（它按"教学周序号 + 单双周"组织课表），
 * 因此实际下发的是**学期开始日期**与**各周次的起止**，随镜像课表一起走：
 * 插件据此校正"现在是第几周"，并让课表的周次口径与教室里的实际日历对齐。
 */
async function publishTermChange(scope: string): Promise<void> {
  if (scope) {
    emitToClass(scope, SOCKET_EVENTS.classUpdated, { classId: scope, action: 'updated' });
    await notifyScheduleChanged(scope).catch((error) => {
      logger.warn(`周次变更后下发课表失败（数据已保存）：${String(error)}`);
    });
    return;
  }

  // 全校默认：把每个在读班级都刷一遍
  const classes = await prisma.class.findMany({
    where: { archivedYearId: null },
    select: { id: true },
  });
  for (const item of classes) {
    emitToClass(item.id, SOCKET_EVENTS.classUpdated, { classId: item.id, action: 'updated' });
    await notifyScheduleChanged(item.id).catch(() => undefined);
  }
}
