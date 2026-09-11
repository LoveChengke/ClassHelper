import { z } from 'zod';
import { timeSchema, weekNumberSchema } from '../../lib/schemas.js';

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
  })
  .refine((data) => !data.startTime || !data.endTime || data.startTime < data.endTime, {
    message: '结束时间必须晚于开始时间',
    path: ['endTime'],
  });

export type CreateScheduleInput = z.infer<typeof createScheduleSchema>;
export type UpdateScheduleInput = z.infer<typeof updateScheduleSchema>;
