import { z } from 'zod';
import { isDayKey, TIME_POINT_TYPES } from '@classhelper/shared';
import { timeSchema } from '../../lib/schemas.js';
export const scopeQuery = z.object({
  classId: z.string().min(1).optional(),
  week: z.coerce.number().int().min(1).max(60).optional(),
});
export const pointSchema = z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().max(64).default(''),
    startTime: timeSchema,
    endTime: timeSchema,
    timeType: z.enum(TIME_POINT_TYPES).default('LESSON'),
    isHideDefault: z.boolean().default(false),
    defaultClassId: z.string().nullish(),
    breakName: z.string().max(64).default(''),
    actionSet: z.string().max(10000).default('{}'),
  })
  .refine((p) => p.timeType === 'DIVIDER' || p.startTime < p.endTime, '结束时间必须晚于开始时间');
export const layoutSchema = z.object({
  name: z.string().trim().min(1).max(64),
  classId: z.string().nullish(),
  points: z.array(pointSchema).max(100),
});
export const planSchema = z
  .object({
    classId: z.string().min(1),
    name: z.string().trim().min(1).max(64),
    timeLayoutId: z.string().min(1),
    associatedGroup: z.string().nullish(),
    weekday: z.number().int().min(0).max(7).default(0),
    weekCountDiv: z.number().int().min(0).max(9).default(0),
    weekCountDivTotal: z.number().int().min(1).max(9).default(2),
    weekStart: z.number().int().min(1).max(60).default(1),
    weekEnd: z.number().int().min(1).max(60).default(60),
    isEnabled: z.boolean().default(true),
  })
  .refine((p) => p.weekCountDiv <= p.weekCountDivTotal && p.weekStart <= p.weekEnd, '启用周次规则不合法');
export const entriesSchema = z.object({
  entries: z
    .array(
      z.object({
        timeLayoutItemId: z.string().min(1),
        courseId: z.string().nullish(),
        isEnabled: z.boolean().default(true),
        isChangedClass: z.boolean().default(false),
        location: z.string().max(100).nullish(),
      }),
    )
    .max(100),
});
export const groupSchema = z.object({
  classId: z.string().min(1),
  name: z.string().trim().min(1).max(64),
  isGlobal: z.boolean().default(false),
  isDefault: z.boolean().default(false),
});
export const datedPlanSchema = z.object({
  classId: z.string().min(1),
  classPlanId: z.string().min(1),
  date: z.string().refine(isDayKey, '日期无效'),
});
export const swapSchema = datedPlanSchema.extend({ first: z.string().min(1), second: z.string().min(1) });
export const cloneSchema = z.object({ name: z.string().trim().min(1).max(64).optional() });
export const importLayoutSchema = z.object({ sourceId: z.string().min(1) });
export const groupSelectionSchema = z.object({
  classId: z.string().min(1),
  selected: z.string().min(1).optional(),
  temporary: z.string().min(1).optional(),
  expireTime: z.iso.datetime({ offset: true }).optional(),
});
