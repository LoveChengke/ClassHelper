import { z } from 'zod';
import { CLASSISLAND_NOTIFICATION_CHANNELS, MAX_TERM_WEEK, SUBJECT_CATALOG, isDayKey } from '@classhelper/shared';
import {
  classIndexSchema,
  enrollmentYearSchema,
  guardianPhoneSchema,
  keywordSchema,
  studentGenderSchema,
  studentNameSchema,
  studentNoSchema,
} from '../../lib/schemas.js';

export const createClassSchema = z.object({
  /** 显示名由入学年份与班号生成，不收；保留字段仅为兼容旧客户端 */
  name: z.string().trim().max(64).optional(),
  grade: z.string().trim().min(1, '请输入年级').max(32),
  /** 入学年份（届别）：2026 → 班级称呼「2026级1班」 */
  enrollmentYear: enrollmentYearSchema,
  /** 班号（同一届内的序号） */
  classIndex: classIndexSchema,
  /** 仅管理员可指定班主任，教师创建时固定为自己 */
  teacherId: z.string().min(1).optional(),
  /** 可选：自定义班级码（ClassHelper 班级端登录用），留空自动生成 */
  code: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{4,16}$/, '班级码需为 4~16 位字母或数字')
    .optional(),
  /**
   * 本学期教学周数。上限与课表周次口径统一取 MAX_TERM_WEEK（30）：
   * 周次选择器与 weekNumberSchema 都只到 30，允许更大的值只会让用户设出一个
   * 系统兑现不了的学期长度（第 31 周之后永远为空）。
   */
  termWeeks: z.coerce.number().int().min(1).max(MAX_TERM_WEEK).optional(),
});

/**
 * 编辑班级。
 *
 * `grade` 是**学年升级**用的：高一 → 高二 只改它，班级记录与学生数据全部沿用，**不归档**。
 * `enrollmentYear` / `classIndex` 是给"有名无实的旧数据"补届别用的，改了会重算班级称呼。
 */
export const updateClassSchema = z.object({
  grade: z.string().trim().min(1).max(32).optional(),
  /** 本班学期开始日期（第 1 教学周的周一）；空串 = 回落到全局配置 */
  termStartDate: z
    .union([z.string().trim().refine(isDayKey, { message: '日期格式应为 YYYY-MM-DD' }), z.literal('')])
    .nullish(),
  enrollmentYear: enrollmentYearSchema.optional(),
  classIndex: classIndexSchema.optional(),
  termWeeks: z.coerce.number().int().min(1).max(MAX_TERM_WEEK).optional(),
});

/** 学年升级（批量改年级，不归档） */
export const promoteClassesSchema = z.object({
  classIds: z.array(z.string().min(1)).min(1, '请至少选择一个班级').max(200),
  grade: z.string().trim().min(1, '请输入升级后的年级').max(32),
});

/** 设置 / 重置班级账号（班级码 + 班级密码）：仅管理员 */
export const updateClassAccountSchema = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9]{4,16}$/, '班级码需为 4~16 位字母或数字')
      .optional(),
    password: z.string().min(6, '班级密码至少 6 位').max(64).optional(),
  })
  .refine((value) => value.code !== undefined || value.password !== undefined, {
    message: '请至少填写班级码或班级密码中的一项',
  });

export const listClassesQuerySchema = z.object({
  keyword: keywordSchema,
});

/** 往班级名单里加一名学生（学生没有账号，只有学号与姓名） */
export const addStudentSchema = z.object({
  studentNo: studentNoSchema,
  name: studentNameSchema,
  gender: studentGenderSchema,
  guardianPhone: guardianPhoneSchema,
});

/**
 * 设置某班各科的任课老师（班级 + 科目 + 教师）。
 *
 * `subjectName` 用全校统一科目目录里的名字（找不到就自动建课）；
 * `teacherId` 留空表示解除该科的任课老师。
 */
export const assignSubjectTeachersSchema = z.object({
  assignments: z
    .array(
      z.object({
        courseId: z.string().min(1).nullish(),
        subjectName: z
          .string()
          .trim()
          .min(1, '请选择或填写科目')
          .max(32)
          .refine(
            (value) => value.length > 0,
            { message: '科目名不能为空' },
          ),
        teacherId: z.string().min(1).nullish(),
      }),
    )
    .max(SUBJECT_CATALOG.length + 20, '科目数量超出预期'),
});

/** 设置 / 更改班主任（仅管理员） */
export const assignHeadTeacherSchema = z.object({
  teacherId: z.string().min(1, '请选择班主任'),
});

/**
 * 通知显示位置（both / client / classisland）。
 * 由 **ClassHelper 班级端**在设置页里改，教师/管理员也可以在 Web 端改。
 */
export const updateNotificationChannelSchema = z.object({
  notificationChannel: z.enum(
    CLASSISLAND_NOTIFICATION_CHANNELS as unknown as [string, ...string[]],
    { message: '显示位置只能是 both / client / classisland' },
  ),
});

/** 班级端按学号查询成绩明细的开关 */
export const updateStudentGradeQuerySchema = z.object({
  enabled: z.boolean(),
});

export const classStudentParamSchema = z.object({
  id: z.string().min(1),
  studentId: z.string().min(1),
});

export type CreateClassInput = z.infer<typeof createClassSchema>;
export type UpdateClassInput = z.infer<typeof updateClassSchema>;
export type UpdateClassAccountInput = z.infer<typeof updateClassAccountSchema>;
export type UpdateNotificationChannelInput = z.infer<typeof updateNotificationChannelSchema>;
export type UpdateStudentGradeQueryInput = z.infer<typeof updateStudentGradeQuerySchema>;
export type AddStudentInput = z.infer<typeof addStudentSchema>;
export type AssignSubjectTeachersInput = z.infer<typeof assignSubjectTeachersSchema>;
