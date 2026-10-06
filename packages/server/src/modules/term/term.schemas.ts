import { z } from 'zod';
import { isDayKey } from '@classhelper/shared';

/** 一个教学周的日期区间 */
const termWeekItemSchema = z.object({
  weekNumber: z.coerce.number().int().min(1).max(60),
  startDate: z.string().trim().refine(isDayKey, { message: '开始日期格式应为 YYYY-MM-DD' }),
  endDate: z.string().trim().refine(isDayKey, { message: '结束日期格式应为 YYYY-MM-DD' }),
  note: z.string().trim().max(64).optional(),
});

const termStartDateSchema = z.string().trim().refine(isDayKey, { message: '日期格式应为 YYYY-MM-DD' });

/** `classId` 为空表示全校默认 */
export const termQuerySchema = z.object({
  classId: z.string().min(1).optional(),
});

export const updateTermWeeksSchema = z.object({
  classId: z.string().min(1).nullish(),
  termStartDate: termStartDateSchema.optional(),
  /** 整表覆盖：传空数组 = 清空逐周配置，回到按开学日期线性推算 */
  weeks: z.array(termWeekItemSchema).max(60),
});

export const autoTermWeeksSchema = z.object({
  classId: z.string().min(1).nullish(),
  termStartDate: termStartDateSchema.optional(),
  maxWeek: z.coerce.number().int().min(1).max(60).optional(),
});

export const holidayQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});

export type UpdateTermWeeksInput = z.infer<typeof updateTermWeeksSchema>;
export type AutoTermWeeksInput = z.infer<typeof autoTermWeeksSchema>;
