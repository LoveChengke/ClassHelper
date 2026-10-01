import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import type { ApiErrorResponse } from '@classhelper/shared';
import { ApiError } from '../lib/http.js';
import { logger } from '../lib/logger.js';
import { env } from '../config/env.js';

function sendError(
  res: Parameters<ErrorRequestHandler>[2],
  status: number,
  message: string,
  code: string,
  details?: unknown,
): void {
  const body: ApiErrorResponse = { success: false, data: null, message, code };
  if (details !== undefined) body.details = details;
  res.status(status).json(body);
}

/** 404：未匹配到任何路由 */
export const notFoundHandler: RequestHandler = (req, res) => {
  sendError(res, 404, `接口不存在：${req.method} ${req.originalUrl}`, 'NOT_FOUND');
};

/** 统一错误处理：把 Zod / ApiError / Prisma 错误转换成统一响应体 */
export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  if (error instanceof ZodError) {
    const details = error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    logger.warn(`参数校验失败：${req.method} ${req.originalUrl}`, details);
    sendError(res, 422, '请求参数不合法', 'VALIDATION_ERROR', details);
    return;
  }

  if (error instanceof ApiError) {
    if (error.status >= 500) logger.error(error.message, error.details);
    sendError(res, error.status, error.message, error.code, error.details);
    return;
  }

  /**
   * 请求体超限（body-parser 抛的 `entity.too.large`）。
   *
   * 必须单独处理：它带 `status: 413` 但不是 ApiError，落进下面的兜底分支会变成
   * 「500 服务器内部错误：request entity too large」——既是错的状态码，也把英文原文抛给用户，
   * 而用户真正需要知道的是"文件太大了、请拆分"（表格导入的 8MB 上限见 table-import.service）。
   */
  if ((error as { type?: string }).type === 'entity.too.large') {
    logger.warn(`请求体超过上限：${req.method} ${req.originalUrl}`);
    sendError(
      res,
      413,
      '上传内容过大：请把文件拆分后分批导入（表格文件上限 8MB）',
      'IMPORT_TOO_LARGE',
    );
    return;
  }

  // Prisma 已知错误码（P2002 唯一约束 / P2025 记录不存在 / P2003 外键约束）
  const prismaCode = (error as { code?: string }).code;
  if (prismaCode === 'P2002') {
    sendError(res, 409, '数据已存在，请检查唯一字段（用户名 / 课程名等）', 'CONFLICT');
    return;
  }
  if (prismaCode === 'P2025') {
    sendError(res, 404, '目标记录不存在或已被删除', 'NOT_FOUND');
    return;
  }
  if (prismaCode === 'P2003') {
    sendError(res, 400, '关联数据不存在或仍被引用', 'BAD_REQUEST');
    return;
  }

  logger.error(`未处理异常：${req.method} ${req.originalUrl}`, error);
  sendError(
    res,
    500,
    env.isProduction ? '服务器内部错误' : `服务器内部错误：${(error as Error).message}`,
    'INTERNAL_ERROR',
  );
};
