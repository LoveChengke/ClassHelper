import { z } from 'zod';

/** 导入类型：成绩 / 学生名单 / 课表时间配置 */
export const IMPORT_KINDS = ['grades', 'students'] as const;

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
  classId: z.string().min(1, '请选择班级'),
  /** 列映射：规范字段 → 文件列名（或列索引字符串） */
  mapping: z.record(z.string(), z.string().min(1)),
  /** append = 仅新增；upsert = 已存在则更新（成绩按 学生+考试+课程，名单按用户名） */
  mode: z.enum(['append', 'upsert']).default('upsert'),
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

export type TableFileInput = z.infer<typeof tableFileSchema>;
export type TableCommitInput = z.infer<typeof tableCommitSchema>;
export type TimeLayoutImportInput = z.infer<typeof timeLayoutImportSchema>;
