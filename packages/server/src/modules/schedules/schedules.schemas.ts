import { z } from 'zod';
import { timeSchema, weekNumberSchema } from '../../lib/schemas.js';

/** 单双周：ALL=每周 / ODD=单周 / EVEN=双周（与 ClassIsland 的 WeekCountDiv 语义一致） */
const weekParitySchema = z.enum(['ALL', 'ODD', 'EVEN']);

export const listSchedulesQuerySchema = z.object({
  classId: z.string().min(1).optional(),
  /** 不传则按"当前教学周"过滤 */
  week: weekNumberSchema.optional(),
  dayOfWeek: z.coerce.number().int().min(1).max(7).optional(),
});

export const gridQuerySchema = z.object({
  classId: z.string().min(1).optional(),
  week: weekNumberSchema.optional(),
});

/**
 * 上课状态查询。
 * `at` 为诊断/联调用的时间覆盖（例如排查"为什么现在不认为是上课"），
 * 不传则按服务器当前时间判定。
 */
export const classStatusQuerySchema = z.object({
  classId: z.string().min(1).optional(),
  at: z
    .string()
    .min(1)
    .optional()
    .refine((value) => value === undefined || !Number.isNaN(new Date(value).getTime()), 'at 需为合法时间'),
});

export const createScheduleSchema = z
  .object({
    classId: z.string().min(1, '请选择班级'),
    courseId: z.string().min(1, '请选择课程'),
    dayOfWeek: z.coerce.number().int().min(1, '星期范围为 1-7').max(7),
    startTime: timeSchema,
    endTime: timeSchema,
    location: z.string().trim().max(64).nullish(),
    weekStart: weekNumberSchema.optional(),
    weekEnd: weekNumberSchema.optional(),
    /** 单双周（默认 ALL=每周） */
    weekParity: weekParitySchema.optional(),
  })
  .refine((data) => data.startTime < data.endTime, {
    message: '结束时间必须晚于开始时间',
    path: ['endTime'],
  })
  .refine((data) => (data.weekStart ?? 1) <= (data.weekEnd ?? 20), {
    message: '起始周次不能大于结束周次',
    path: ['weekEnd'],
  });

export const updateScheduleSchema = z
  .object({
    courseId: z.string().min(1).optional(),
    dayOfWeek: z.coerce.number().int().min(1).max(7).optional(),
    startTime: timeSchema.optional(),
    endTime: timeSchema.optional(),
    location: z.string().trim().max(64).nullish(),
    weekStart: weekNumberSchema.optional(),
    weekEnd: weekNumberSchema.optional(),
    /** 单双周（默认 ALL=每周） */
    weekParity: weekParitySchema.optional(),
  })
  .refine((data) => !data.startTime || !data.endTime || data.startTime < data.endTime, {
    message: '结束时间必须晚于开始时间',
    path: ['endTime'],
  });

export type CreateScheduleInput = z.infer<typeof createScheduleSchema>;
export type UpdateScheduleInput = z.infer<typeof updateScheduleSchema>;
