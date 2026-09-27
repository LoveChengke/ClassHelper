import { WEEKDAY_LABELS, WEEKDAYS, WEEK_PARITY_LABELS } from './constants.js';
import type { ClassPeriod, GradeLevel, ScheduleDto, ScheduleWeekView, WeekParity } from './types.js';

/* ------------------------------------------------------------------ 日期时间 */

export function toDate(value: string | number | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

function pad(input: number): string {
  return input < 10 ? `0${input}` : String(input);
}

/**
 * 本地日期串（YYYY-MM-DD）。
 *
 * 「作业属于哪一天」用它是**本地**日期，不是 UTC 日期：教室在 UTC+8，晚上 8 点录的作业
 * 应该算今天，而 `toISOString().slice(0, 10)` 会把它算成明天（UTC 已跨天）。
 */
export function dayKeyLocal(value: string | number | Date): string {
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 判断字符串是否形如 YYYY-MM-DD（并校验是真实存在的日期） */
export function isDayKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return (
    date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
  );
}

/** 在 YYYY-MM-DD 上加减天数（用于日期选择器的区间与"昨天/明天"） */
export function shiftDayKey(value: string, deltaDays: number): string {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day + deltaDays);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 格式化为 YYYY-MM-DD，withTime=true 时追加 HH:mm */
export function formatDate(value: string | number | Date | null | undefined, withTime = false): string {
  if (value === null || value === undefined || value === '') return '';
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return '';
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return withTime ? `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}` : day;
}

export function formatTime(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 周几，1=周一 ... 7=周日 */
export function weekdayOf(value: string | number | Date): number {
  const day = toDate(value).getDay();
  return day === 0 ? 7 : day;
}

/** ISO 周次（与学期周次解耦，仅用于展示当前自然周） */
export function getIsoWeek(value: string | number | Date): number {
  const date = toDate(value);
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNumber = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNumber);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  return Math.ceil(((target.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

/** 相对时间描述，例如"3 分钟前" */
export function relativeTime(value: string | number | Date, now: Date = new Date()): string {
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return '';
  const diffSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);
  if (diffSeconds < 60) return '刚刚';
  const minutes = Math.floor(diffSeconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return formatDate(date);
}

/* ------------------------------------------------------------------ 课表 */

/** 第 week 周是单周还是双周（第 1 周记为单周，与 ClassIsland 的 WeekCountDiv 一致） */
export function weekParityOf(week: number): Exclude<WeekParity, 'ALL'> {
  return week % 2 === 0 ? 'EVEN' : 'ODD';
}

/**
 * ClassIsland 的 `WeekCountDiv` / `WeekCountDivTotal` → 本系统的单双周。
 *
 * 语义（与 ClassIsland 源码一致）：`WeekCountDivTotal = n` 时，第 `WeekCountDiv` 周启用（1-based）；
 * `WeekCountDiv <= 0` 或 `Total <= 1` 表示每周都上。
 *
 * 注意：本系统只用单双周（2 周循环），3 周及以上的循环**无法表达**，此时降级为「每周」
 * 并由调用方向用户提示（导入模块记 warning）。这里集中为一处，避免导入与插件上报各写一套。
 */
export function weekParityFromDiv(weekCountDiv: number, weekCountDivTotal: number): WeekParity {
  if (weekCountDiv <= 0 || weekCountDivTotal <= 1) return 'ALL';
  const position = ((weekCountDiv - 1) % weekCountDivTotal) + 1;
  if (weekCountDivTotal === 2) return position === 1 ? 'ODD' : 'EVEN';
  return 'ALL';
}

/** `weekParityFromDiv` 的逆运算：本系统的单双周 → ClassIsland 的 Div/Total */
export function weekDivFromParity(parity: WeekParity | null | undefined): {
  weekCountDiv: number;
  weekCountDivTotal: number;
} {
  if (parity === 'ODD') return { weekCountDiv: 1, weekCountDivTotal: 2 };
  if (parity === 'EVEN') return { weekCountDiv: 2, weekCountDivTotal: 2 };
  return { weekCountDiv: 0, weekCountDivTotal: 0 };
}

/** 多周循环（3 周及以上）无法用单双周表达：告知调用方是否被降级 */
export function isWeekCycleDegraded(weekCountDiv: number, weekCountDivTotal: number): boolean {
  return weekCountDivTotal > 2;
}

/** 判断某个课表条目在第 week 周是否上课（周次区间 + 单双周） */
export function isScheduleActiveInWeek(
  schedule: Pick<ScheduleDto, 'weekStart' | 'weekEnd'> & { weekParity?: WeekParity | null },
  week: number,
): boolean {
  if (week < schedule.weekStart || week > schedule.weekEnd) return false;
  const parity = schedule.weekParity ?? 'ALL';
  if (parity === 'ALL') return true;
  return parity === weekParityOf(week);
}

/** 格式化单双周标签（课表卡片用） */
export function formatWeekParity(parity: WeekParity | null | undefined): string {
  return WEEK_PARITY_LABELS[(parity ?? 'ALL') as WeekParity] ?? '每周';
}

/** 格式化周次范围，例如"1-20 周" / "单周" */
export function formatWeekRange(weekStart: number, weekEnd: number): string {
  if (weekStart === weekEnd) return `第 ${weekStart} 周`;
  return `${weekStart}-${weekEnd} 周`;
}

/** 按时间排序（HH:mm 字符串可直接字典序比较） */
export function sortScheduleByTime<T extends Pick<ScheduleDto, 'dayOfWeek' | 'startTime'>>(items: T[]): T[] {
  return [...items].sort((a, b) =>
    a.dayOfWeek === b.dayOfWeek ? a.startTime.localeCompare(b.startTime) : a.dayOfWeek - b.dayOfWeek,
  );
}

/** 组装周视图：7 列固定输出，便于前端直接渲染 */
export function buildScheduleWeekView(items: ScheduleDto[], week: number): ScheduleWeekView {
  const active = sortScheduleByTime(items.filter((item) => isScheduleActiveInWeek(item, week)));
  return {
    week,
    columns: WEEKDAYS.map((dayOfWeek) => ({
      dayOfWeek,
      label: WEEKDAY_LABELS[dayOfWeek] ?? `周${dayOfWeek}`,
      items: active.filter((item) => item.dayOfWeek === dayOfWeek),
    })),
  };
}

/** 计算两个 HH:mm 之间的时长（分钟），非法输入返回 0 */
export function durationMinutes(startTime: string, endTime: string): number {
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);
  if ([sh, sm, eh, em].some((n) => Number.isNaN(n))) return 0;
  return (eh as number) * 60 + (em as number) - ((sh as number) * 60 + (sm as number));
}

/* ------------------------------------------------------------------ 成绩 */

/** 得分率（0-100），总分非法时返回 0 */
export function gradePercent(score: number, totalScore: number): number {
  if (!Number.isFinite(score) || !Number.isFinite(totalScore) || totalScore <= 0) return 0;
  return round((score / totalScore) * 100, 1);
}

/** 等级换算，学生端图表与标签复用 */
export function gradeLevel(percent: number): GradeLevel {
  if (percent >= 90) return 'A';
  if (percent >= 80) return 'B';
  if (percent >= 70) return 'C';
  if (percent >= 60) return 'D';
  return 'E';
}

export function averageOf(numbers: number[]): number {
  const valid = numbers.filter((n) => Number.isFinite(n));
  if (valid.length === 0) return 0;
  return round(valid.reduce((sum, n) => sum + n, 0) / valid.length, 1);
}

export function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/* ------------------------------------------------------------------ 通用 */

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function groupBy<T, K extends string | number>(items: T[], keyOf: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = map.get(key);
    if (bucket) bucket.push(item);
    else map.set(key, [item]);
  }
  return map;
}

export function uniqueBy<T, K>(items: T[], keyOf: (item: T) => K): T[] {
  const seen = new Set<K>();
  const result: T[] = [];
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

/** 生成 [1, max] 的周次选项，课表周次切换与表单下拉复用 */
export function buildWeekOptions(max = 20, min = 1): number[] {
  const safeMax = Math.max(min, Math.floor(max));
  return Array.from({ length: safeMax - min + 1 }, (_, index) => min + index);
}

/** 安全的数字转换，表单输入（字符串）到接口字段（number）之间使用 */
export function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/** 截断长文本（列表页展示摘要） */
export function truncate(text: string | null | undefined, max = 60): string {
  if (!text) return '';
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** HH:mm 校验 */
export function isValidTimeString(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/* ------------------------------------------------------------------ 上课时段判定 */

/** HH:mm -> 分钟数（非法输入返回 -1） */
export function timeToMinutes(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  if (hour === undefined || minute === undefined || Number.isNaN(hour) || Number.isNaN(minute)) return -1;
  return hour * 60 + minute;
}

const MS_PER_DAY = 86_400_000;
export const MAX_TERM_WEEK = 30;

/**
 * 依据学期起始日（第 1 教学周的周一）计算当前教学周。
 * 服务端与三端共用同一份实现，避免"周次"口径不一致。
 */
export function resolveCurrentWeek(
  termStartDate: string,
  now: Date = new Date(),
  maxWeek: number = MAX_TERM_WEEK,
): number {
  if (!termStartDate) return 1;
  const start = toDate(termStartDate);
  if (Number.isNaN(start.getTime())) return 1;

  const weekday = start.getDay() === 0 ? 7 : start.getDay();
  const monday = new Date(start.getTime() - (weekday - 1) * MS_PER_DAY);
  monday.setHours(0, 0, 0, 0);

  const diffDays = Math.floor((now.getTime() - monday.getTime()) / MS_PER_DAY);
  const week = Math.floor(diffDays / 7) + 1;
  return clamp(week, 1, maxWeek);
}

/** 把课表条目转换成时段信息 */
export function toClassPeriod(schedule: ScheduleDto): ClassPeriod {
  return {
    scheduleId: schedule.id,
    courseId: schedule.courseId,
    courseName: schedule.course?.name ?? '课程',
    startTime: schedule.startTime,
    endTime: schedule.endTime,
    location: schedule.location,
    dayOfWeek: schedule.dayOfWeek,
  };
}

/**
 * 判断某一时刻是否处于上课时间段，并给出正在上的课与下一节课。
 *
 * @param schedules 该班级的课表（可含全部周次）
 * @param now       判定时刻
 * @param week      当前教学周；传 0 / 省略表示不按周次过滤（仅按星期与时间）
 */
export function resolveClassStatus(
  schedules: ScheduleDto[],
  now: Date = new Date(),
  week?: number,
): { inClass: boolean; current: ClassPeriod | null; next: ClassPeriod | null } {
  const weekday = weekdayOf(now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  const weekFiltered =
    week && week > 0 ? schedules.filter((item) => isScheduleActiveInWeek(item, week)) : schedules;
  const today = weekFiltered.filter((item) => item.dayOfWeek === weekday);

  const current = today
    .filter((item) => {
      const start = timeToMinutes(item.startTime);
      const end = timeToMinutes(item.endTime);
      return start >= 0 && end > start && nowMinutes >= start && nowMinutes < end;
    })
    .sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime))[0];

  const next = today
    .filter((item) => timeToMinutes(item.startTime) > nowMinutes)
    .sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime))[0];

  return {
    inClass: Boolean(current),
    current: current ? toClassPeriod(current) : null,
    next: next ? toClassPeriod(next) : null,
  };
}

/** 时段的可读文案，例如 "08:00-08:45 · 数学 · 教学楼 A301" */
export function formatClassPeriod(period: ClassPeriod | null): string {
  if (!period) return '';
  const location = period.location ? ` · ${period.location}` : '';
  return `${period.startTime}-${period.endTime} · ${period.courseName}${location}`;
}

/** 距离某个 HH:mm 还有多少分钟（已过则为负） */
export function minutesUntil(time: string, now: Date = new Date()): number {
  const target = timeToMinutes(time);
  if (target < 0) return 0;
  return target - (now.getHours() * 60 + now.getMinutes());
}
