import {
  MAX_TERM_WEEK,
  resolveCurrentWeek as resolveWeek,
  resolveWeekFromRanges,
} from '@classhelper/shared';
import { env } from '../config/env.js';
import { prisma } from './db.js';

export { MAX_TERM_WEEK };

/** 某个班的周次口径（管理员可以为每个班单独配开学日期与逐周区间） */
export interface TermWeekContext {
  termStartDate: string;
  /** 逐周区间；空数组 = 完全按学期开始日期线性推算 */
  weeks: Array<{ weekNumber: number; startDate: string; endDate: string }>;
  maxWeek: number;
}

/**
 * 当前教学周。
 * 具体计算逻辑在 `@classhelper/shared`（三端共用），这里只负责注入服务端的
 * 配置，避免"周次"口径在服务端/客户端出现分叉。
 *
 * @param context 班级维度的周次口径（`Class.termStartDate` + 该班的逐周区间）。
 *                不传时退回全局 `TERM_START_DATE` 线性推算。
 */
export function resolveCurrentWeek(now: Date = new Date(), context?: TermWeekContext | null): number {
  const termStartDate = context?.termStartDate || env.termStartDate;
  const maxWeek = context?.maxWeek ?? MAX_TERM_WEEK;

  // 配了逐周区间就按区间判定 —— 调休/补课让某一周变长变短时，线性推算会整体错位
  if (context && context.weeks.length > 0) {
    const fromRanges = resolveWeekFromRanges(context.weeks, now);
    if (fromRanges !== null) return fromRanges;
  }
  return resolveWeek(termStartDate, now, maxWeek);
}

/**
 * 取出某个班的周次口径。
 *
 * 优先级：班级自己的逐周区间 → 全校默认的逐周区间 → 纯线性推算。
 * 开学日期同理：`Class.termStartDate` 优先，没配就用全局 `TERM_START_DATE`。
 *
 * @param classId 不传/空串表示**只看全校默认**（管理员在「学期周次」页编辑默认口径时就是这种调用）
 */
export async function loadTermContext(classId?: string | null): Promise<TermWeekContext> {
  const globalWeeks = await prisma.termWeek.findMany({
    where: { classId: '' },
    orderBy: { weekNumber: 'asc' },
    select: { weekNumber: true, startDate: true, endDate: true },
  });
  if (!classId) {
    // 全校默认没有"班级记录"可以存开学日期，因此**第 1 周的起始日就是它**
    // （管理员点「按开学日期生成」时，第 1 周就是从那天开始的）
    const firstGlobal = globalWeeks.find((item) => item.weekNumber === 1)?.startDate;
    return { termStartDate: firstGlobal || env.termStartDate, weeks: globalWeeks, maxWeek: MAX_TERM_WEEK };
  }

  const [cls, classWeeks] = await Promise.all([
    prisma.class.findUnique({
      where: { id: classId },
      select: { termStartDate: true, termWeeks: true },
    }),
    prisma.termWeek.findMany({
      where: { classId },
      orderBy: { weekNumber: 'asc' },
      select: { weekNumber: true, startDate: true, endDate: true },
    }),
  ]);

  const weeks = classWeeks.length > 0 ? classWeeks : globalWeeks;
  // 班级的逐周区间若覆盖了第 1 周，开学日期就以它为准（管理员改周次时最直观）
  const firstWeekStart = weeks.find((item) => item.weekNumber === 1)?.startDate;
  return {
    termStartDate: cls?.termStartDate || firstWeekStart || env.termStartDate,
    weeks,
    maxWeek: cls?.termWeeks && cls.termWeeks > 0 ? cls.termWeeks : MAX_TERM_WEEK,
  };
}
