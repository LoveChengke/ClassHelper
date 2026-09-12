import { MAX_TERM_WEEK, resolveCurrentWeek as resolveWeek } from '@classhelper/shared';
import { env } from '../config/env.js';

export { MAX_TERM_WEEK };

/**
 * 当前教学周。
 * 具体计算逻辑在 @classhelper/shared（三端共用），这里只负责注入服务端的
 * TERM_START_DATE 与周次上限，避免"周次"口径在服务端/客户端出现分叉。
 */
export function resolveCurrentWeek(now: Date = new Date()): number {
  return resolveWeek(env.termStartDate, now, MAX_TERM_WEEK);
}
