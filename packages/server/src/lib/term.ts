import { env } from '../config/env.js';

const MS_PER_DAY = 86_400_000;
export const MAX_TERM_WEEK = 30;

/**
 * 依据 TERM_START_DATE 计算当前教学周（第 1 周从该日期所在周一开始）。
 * 学生端与 Web 端"当前周次"默认值都走这里，保证三端口径一致。
 */
export function resolveCurrentWeek(now: Date = new Date()): number {
  if (!env.termStartDate) return 1;
  const start = new Date(env.termStartDate);
  if (Number.isNaN(start.getTime())) return 1;

  // 归一到该日期所在周的周一
  const weekday = start.getDay() === 0 ? 7 : start.getDay();
  const monday = new Date(start.getTime() - (weekday - 1) * MS_PER_DAY);
  monday.setHours(0, 0, 0, 0);

  const diffDays = Math.floor((now.getTime() - monday.getTime()) / MS_PER_DAY);
  const week = Math.floor(diffDays / 7) + 1;
  return Math.min(Math.max(week, 1), MAX_TERM_WEEK);
}
