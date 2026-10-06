import { z } from 'zod';
import { isValidStudentNo, normalizeStudentNo } from '@classhelper/shared';

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

/**
 * 附件链接。
 *
 * 只允许 http(s) 绝对地址或站内相对路径：这一层是为**渲染端**兜底 ——
 * 该字段最终会绑到前端的 `<a href>` / `el-link :href` 上，
 * 若放行 `javascript:` / `data:text/html` 就会变成一条存储型 XSS 的注入点。
 * 空串与 null 都表示"没有附件"。
 */
export const attachmentUrlSchema = z
  .string()
  .trim()
  .max(500)
  .refine(
    (value) =>
      value === '' || value.startsWith('/') || /^https?:\/\//i.test(value),
    { message: '附件链接需为 http(s):// 地址或站内相对路径' },
  )
  .nullish();

/** 周次：1..30 */
export const weekNumberSchema = z.coerce.number().int().min(1).max(30);

/**
 * 学号：学生的唯一标识与查询键。
 *
 * 只做**格式**校验（1~32 位数字/字母/`._-`），归一化（去空白）后入库；
 * 唯一性由 `Student.studentNo` 的唯一约束 + service 层的大小写无关查重共同保证。
 */
export const studentNoSchema = z
  .string()
  .trim()
  .min(1, '请填写学号')
  .max(32, '学号最多 32 位')
  .transform((value) => normalizeStudentNo(value))
  .refine((value) => isValidStudentNo(value), {
    message: '学号只能包含字母、数字与 . _ -（1~32 位）',
  });

/** 学生姓名 */
export const studentNameSchema = z.string().trim().min(1, '请输入姓名').max(32);

/** 学生性别：'' / MALE / FEMALE */
export const studentGenderSchema = z.enum(['', 'MALE', 'FEMALE']).optional();

/** 学生状态 */
export const studentStatusSchema = z.enum(['active', 'graduated', 'transferred', 'inactive']).optional();

/** 家长手机号（可空） */
export const guardianPhoneSchema = z.string().trim().max(32).optional();

/** 入学年份（届别） */
export const enrollmentYearSchema = z.coerce.number().int().min(2000).max(2100);

/** 班号 */
export const classIndexSchema = z.coerce.number().int().min(1).max(99);

/** 成绩等级口径 */
export const gradeLevelTypeSchema = z.enum(['percent', 'letter', 'custom']);

/** 成绩等级文本（自定义等级也要能填，所以只限长度） */
export const gradeLevelSchema = z.string().trim().max(16);
