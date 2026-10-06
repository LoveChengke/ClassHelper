import { z } from 'zod';
import { gradeLevelSchema, gradeLevelTypeSchema, optionalDateTimeSchema } from '../../lib/schemas.js';

export const listGradesQuerySchema = z.object({
  classId: z.string().min(1).optional(),
  courseId: z.string().min(1).optional(),
  /** 学生 id（学生是名单记录，不是账号） */
  studentId: z.string().min(1).optional(),
  examName: z.string().trim().max(64).optional(),
});

export const statsQuerySchema = z.object({
  classId: z.string().min(1).optional(),
  courseId: z.string().min(1).optional(),
  examName: z.string().trim().max(64).optional(),
});

export const createGradeSchema = z.object({
  classId: z.string().min(1, '请选择班级'),
  courseId: z.string().min(1).nullish(),
  studentId: z.string().min(1, '请选择学生'),
  examName: z.string().trim().min(1, '请输入考试名称').max(64),
  score: z.coerce.number().min(0, '分数不能为负数'),
  totalScore: z.coerce.number().positive('总分必须大于 0').optional(),
  /** 等级口径：percent 百分制 / letter 等级制 A-D / custom 自定义等级 */
  levelType: gradeLevelTypeSchema.optional(),
  /** 手填等级；percent 且留空时由服务端按得分率换算 */
  level: gradeLevelSchema.optional(),
  publishedAt: optionalDateTimeSchema,
});

export const updateGradeSchema = z.object({
  examName: z.string().trim().min(1).max(64).optional(),
  score: z.coerce.number().min(0).optional(),
  totalScore: z.coerce.number().positive().optional(),
  courseId: z.string().min(1).nullish(),
  levelType: gradeLevelTypeSchema.optional(),
  level: gradeLevelSchema.optional(),
  publishedAt: optionalDateTimeSchema,
});

/** 批量录入 / 导入成绩 */
export const bulkCreateGradeSchema = z.object({
  classId: z.string().min(1),
  courseId: z.string().min(1).nullish(),
  examName: z.string().trim().min(1).max(64),
  totalScore: z.coerce.number().positive().optional(),
  levelType: gradeLevelTypeSchema.optional(),
  publishedAt: optionalDateTimeSchema,
  items: z
    .array(
      z.object({
        studentId: z.string().min(1),
        score: z.coerce.number().min(0),
        level: gradeLevelSchema.optional(),
      }),
    )
    .min(1, '至少需要一条成绩记录'),
});

/**
 * 批量修改等级，两种用法二选一：
 * 1. `items`：逐条指定等级（前端表格里改完一次提交；单个编辑就是长度为 1 的数组）；
 * 2. `classId + examName + levelType`：把某个考试的某门课**整批重算**等级
 *    （例如把一次百分制月考整班切成 A/B/C/D 等级制）。
 */
export const updateGradeLevelsSchema = z
  .object({
    items: z
      .array(z.object({ id: z.string().min(1), level: gradeLevelSchema }))
      .min(1, '至少需要一条等级记录')
      .max(1000)
      .optional(),
    classId: z.string().min(1).optional(),
    examName: z.string().trim().min(1).max(64).optional(),
    courseId: z.string().min(1).nullish(),
    levelType: gradeLevelTypeSchema.optional(),
  })
  .refine(
    (value) =>
      (value.items && value.items.length > 0) ||
      Boolean(value.classId && value.examName && value.levelType),
    { message: '请提供 items，或同时提供 classId + examName + levelType' },
  );

/** 按学号查成绩明细：学号走路径参数，classId 可选（班级端固定为自己绑定的班级） */
export const studentGradeParamSchema = z.object({
  studentNo: z.string().trim().min(1, '请填写学号').max(32),
});

export const studentGradeQuerySchema = z.object({
  classId: z.string().min(1).optional(),
  /** 设备令牌通道用查询参数传学号（JWT 通道走路径参数） */
  studentNo: z.string().trim().min(1, '请填写学号').max(32).optional(),
});

export type CreateGradeInput = z.infer<typeof createGradeSchema>;
export type UpdateGradeInput = z.infer<typeof updateGradeSchema>;
export type BulkCreateGradeInput = z.infer<typeof bulkCreateGradeSchema>;
export type UpdateGradeLevelsInput = z.infer<typeof updateGradeLevelsSchema>;
