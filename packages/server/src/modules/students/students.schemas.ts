import { z } from 'zod';
import {
  enrollmentYearSchema,
  guardianPhoneSchema,
  keywordSchema,
  studentGenderSchema,
  studentNameSchema,
  studentNoSchema,
  studentStatusSchema,
} from '../../lib/schemas.js';

export const listStudentsQuerySchema = z.object({
  classId: z.string().min(1).optional(),
  keyword: keywordSchema,
  /** 只看某个状态（默认不筛选；`active` = 只看在读） */
  status: studentStatusSchema,
  /** 是否包含已归档（毕业/转出）的学生，默认 false */
  includeArchived: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((value) => value === true || value === 'true' || value === '1'),
});

// 学生只有「名单」没有「账号」：没有密码字段、没有角色字段，也不能登录。
// 学号是学生的唯一标识与查询键，`studentNoSchema` 负责归一化与格式校验。
export const createStudentSchema = z.object({
  studentNo: studentNoSchema,
  name: studentNameSchema,
  classId: z.string().min(1).nullish(),
  gender: studentGenderSchema,
  guardianPhone: guardianPhoneSchema,
  status: studentStatusSchema,
});

export const updateStudentSchema = z.object({
  studentNo: studentNoSchema.optional(),
  name: studentNameSchema.optional(),
  classId: z.string().min(1).nullish(),
  gender: studentGenderSchema,
  guardianPhone: guardianPhoneSchema,
  status: studentStatusSchema,
});

/**
 * 调班：单个与批量共用。
 * 传一个 id 就是单个调班；`toClassId = null` 表示移出班级（回到「未分班」）。
 * **学号不变**，历史作业与成绩保留原归属。
 */
export const transferStudentsSchema = z.object({
  studentIds: z.array(z.string().min(1)).min(1, '请至少选择一名学生').max(500),
  toClassId: z.string().min(1).nullable(),
  note: z.string().trim().max(200).optional(),
});

/** 转出（学籍离开本校，不是调班）：班级归属保留作历史 */
export const transferOutStudentsSchema = z.object({
  studentIds: z.array(z.string().min(1)).min(1, '请至少选择一名学生').max(500),
  note: z.string().trim().max(200).optional(),
});

/** 调班历史查询 */
export const listTransfersQuerySchema = z.object({
  studentId: z.string().min(1).optional(),
  classId: z.string().min(1).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
});

/** 学生名单导入时的班级归属（按班级名解析，重名报错） */
export const studentClassHintSchema = z.object({
  className: z.string().trim().max(64).optional(),
  enrollmentYear: enrollmentYearSchema.optional(),
});

export type CreateStudentInput = z.infer<typeof createStudentSchema>;
export type UpdateStudentInput = z.infer<typeof updateStudentSchema>;
export type TransferStudentsInput = z.infer<typeof transferStudentsSchema>;
export type TransferOutStudentsInput = z.infer<typeof transferOutStudentsSchema>;
export type ListStudentsQuery = z.infer<typeof listStudentsQuerySchema>;
export type ListTransfersQuery = z.infer<typeof listTransfersQuerySchema>;
