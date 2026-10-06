import { z } from 'zod';

/** 导入类型：成绩 / 学生名单 / 教师名单 / 班级任课老师 */
export const IMPORT_KINDS = ['grades', 'students', 'teachers', 'classTeachers'] as const;

/** 表格导入：上传的文件（base64）+ 类型 */
export const tableFileSchema = z.object({
  kind: z.enum(IMPORT_KINDS),
  fileName: z.string().trim().min(1, '缺少文件名').max(200),
  /**
   * base64（不含 data: 前缀）。
   * 这里刻意不限制最小长度：空内容交给 service 返回 IMPORT_EMPTY_FILE，
   * 这样前端能拿到"文件为空"这一精确原因，而不是笼统的参数校验错误。
   */
  contentBase64: z.string(),
});

/** 表格提交：在预览基础上带字段映射、目标班级与写入模式 */
export const tableCommitSchema = tableFileSchema.extend({
  /** 目标班级：成绩/学生名单必填；教师名单与本班任课老师也可用表格里的班级列 */
  classId: z.string().min(1, '请选择班级').optional(),
  /** 列映射：规范字段 → 文件列名（或列索引字符串） */
  mapping: z.record(z.string(), z.string().min(1)),
  /** append = 仅新增；upsert = 已存在则更新（成绩按 学生+考试+课程，名单按学号） */
  mode: z.enum(['append', 'upsert']).default('upsert'),
  /**
   * **班级任课老师导入**专用：是否用「工号」去匹配已有教师账号。
   * 打开时优先按工号匹配（匹配不到就按工号新建账号）；关闭时只按姓名匹配、匹配不到即报错。
   */
  useTeacherNo: z.boolean().optional(),
});

/** ClassIsland 课表时间导入：先校验/预览，再提交 */
export const timeLayoutImportSchema = z.object({
  classId: z.string().min(1, '请选择班级'),
  name: z.string().trim().max(64).optional(),
  /** replace = 覆盖该班现有时间配置；merge = 按开始时间合并 */
  mode: z.enum(['replace', 'merge']).default('replace'),
  /**
   * ClassIsland 导出的 JSON（对象或字符串均可）。
   * 字符串是为了兼容"直接粘贴 JSON 文本"的场景。
   */
  payload: z.union([
    z.string().min(1, '请粘贴或选择 ClassIsland 导出的 JSON'),
    z.record(z.string(), z.unknown()),
    z.array(z.unknown()),
  ]),
});

/** 时间配置查询 */
export const timeLayoutQuerySchema = z.object({
  classId: z.string().min(1, '请选择班级'),
});

/**
 * ClassIsland 课程表（ClassPlan）导入：先预览再提交。
 * 真实档案 JSON 里 TimeLayouts / ClassPlans / Subjects 都是 "Guid → 对象" 的字典，
 * 单双周由 ClassPlan.TimeRule.WeekCountDiv / WeekCountDivTotal 表达。
 */
export const classPlanImportSchema = z.object({
  classId: z.string().min(1, '请选择班级'),
  /** replace = 清空该班现有课表后写入；merge = 保留现有条目，只新增（同 星期+节次+单双周 视为重复则更新） */
  mode: z.enum(['replace', 'merge']).default('replace'),
  /** 学期起始周（用于计算单双周；不传则用服务端配置的开学日期推算） */
  termStartWeek: z.coerce.number().int().min(1).max(60).optional(),
  payload: z.union([
    z.string().min(1, '请粘贴或选择 ClassIsland 导出的 JSON'),
    z.record(z.string(), z.unknown()),
  ]),
});

export type TableFileInput = z.infer<typeof tableFileSchema>;
export type TableCommitInput = z.infer<typeof tableCommitSchema>;
export type TimeLayoutImportInput = z.infer<typeof timeLayoutImportSchema>;
export type ClassPlanImportInput = z.infer<typeof classPlanImportSchema>;
