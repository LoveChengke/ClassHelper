import type { BulkPublishClassResult, BulkPublishResult } from '@classhelper/shared';
import { ApiError } from './http.js';
import { logger } from './logger.js';

/**
 * 批量发布的公共收尾：把单个班级的失败翻译成可直接展示给用户的结果。
 *
 * 批量发布是**逐班判定**的 —— 某个班没有权限、或正在上课而通知是紧急的，
 * 都不该让整批失败：成功的班照常落库并实时推送，失败的班把自己的错误码与中文原因带回来，
 * 由 Web 端在结果弹窗里逐行列出。因此这里保留 ApiError 的 code/details 原样透传。
 */
export function toBulkFailure(classId: string, error: unknown, action = '发布'): BulkPublishClassResult {
  if (error instanceof ApiError) {
    return {
      classId,
      ok: false,
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details as Record<string, unknown> }),
    };
  }

  logger.error(
    `批量${action}出现未预期错误：班级=${classId} 原因=${error instanceof Error ? error.message : String(error)}`,
  );
  return { classId, ok: false, code: 'INTERNAL_ERROR', message: `${action}失败，请稍后重试` };
}

/** 汇总逐班结果（succeeded/failed 由结果本身统计，调用方不必自己数） */
export function summarizeBulk(results: BulkPublishClassResult[]): BulkPublishResult {
  const succeeded = results.filter((item) => item.ok).length;
  return { total: results.length, succeeded, failed: results.length - succeeded, results };
}

/** 批量目标班级：去重并保持调用方给的顺序（多选控件重复提交时会带重复 id） */
export function normalizeBulkClassIds(classIds: readonly string[]): string[] {
  return [...new Set(classIds)];
}
