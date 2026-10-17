import { z } from 'zod';

export const createCourseSchema = z.object({
  initial: z.string().trim().max(8).optional(),
  isOutDoor: z.boolean().optional(),
  name: z.string().trim().min(1, '请输入课程名称').max(64),
  classId: z.string().min(1, '请选择班级'),
});

export const updateCourseSchema = z.object({
  initial: z.string().trim().max(8).optional(),
  isOutDoor: z.boolean().optional(),
  name: z.string().trim().min(1).max(64).optional(),
});

export const listCoursesQuerySchema = z.object({
  classId: z.string().min(1).optional(),
});

export type CreateCourseInput = z.infer<typeof createCourseSchema>;
export type UpdateCourseInput = z.infer<typeof updateCourseSchema>;
