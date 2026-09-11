import { z } from 'zod';

/** 通用路径参数：:id */
export const idParamSchema = z.object({ id: z.string().min(1, '缺少 id') });

/** HH:mm 时间 */
export const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '时间格式应为 HH:mm');

/** ISO 日期时间字符串（接受 2026-03-01 或完整 ISO） */
export const dateTimeSchema = z
  .string()
  .min(1)
  .refine((value) => !Number.isNaN(new Date(value).getTime()), '日期时间格式不正确');

/** 可选日期时间：允许 null / 空字符串，表示清空 */
export const optionalDateTimeSchema = z.union([dateTimeSchema, z.null(), z.literal('')]).optional();

/** 把可选日期时间统一转成 Date | null */
export function parseOptionalDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 查询参数里的布尔值（true/1） */
export const booleanFlagSchema = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((value) => value === true || value === 'true' || value === '1');

/** 关键字查询 */
export const keywordSchema = z.string().trim().max(64).optional();

/** 周次：1..30 */
export const weekNumberSchema = z.coerce.number().int().min(1).max(30);
