import { z } from 'zod';
import { currentAcademicYearStart, graduationYearOf } from '@classhelper/shared';
import { enrollmentYearSchema } from '../../lib/schemas.js';

/** 届别列表的查询参数 */
export const listArchivesQuerySchema = z.object({
  /** 只看某一届 */
  enrollmentYear: enrollmentYearSchema.optional(),
  keyword: z.string().trim().max(64).optional(),
});

/** 归档班级的内容（作业 / 通知）查询 */
export const archivedContentQuerySchema = z.object({
  /** 作业与通知最多各返回多少条（默认 200） */
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export const archiveClassParamSchema = z.object({
  id: z.string().min(1),
  classId: z.string().min(1),
});

/**
 * 可归档的届别（前端下拉用）：当前学年往前推几届，已经毕业的那几届就是候选。
 * 只给"看起来该毕业了"的届别，避免管理员手滑把在读的届归档掉。
 */
export function suggestedEnrollmentYears(now: Date = new Date()): number[] {
  const start = currentAcademicYearStart(now);
  return [start - 2, start - 3, start - 4, start - 5];
}

export { graduationYearOf };
