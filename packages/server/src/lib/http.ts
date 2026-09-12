import type { Response } from 'express';
import type { ApiResponse } from '@classhelper/shared';

/** 成功响应：{ success: true, data, message } */
export function sendOk<T>(res: Response, data: T, message = 'ok', status = 200): void {
  const body: ApiResponse<T> = { success: true, data, message };
  res.status(status).json(body);
}

/** 创建成功（201） */
export function sendCreated<T>(res: Response, data: T, message = '创建成功'): void {
  sendOk(res, data, message, 201);
}

export type ApiErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'TOO_MANY_REQUESTS'
  /** 上课时间段发布紧急通知需要二次确认（前端据此弹出全屏警告 + 3 秒倒计时） */
  | 'URGENT_DURING_CLASS'
  /** 导入：空文件 / 文件过大 / 格式错误 / 内容不合法 / 没有有效数据 */
  | 'IMPORT_EMPTY_FILE'
  | 'IMPORT_TOO_LARGE'
  | 'IMPORT_FORMAT_INVALID'
  | 'IMPORT_INVALID'
  | 'IMPORT_EMPTY'
  | 'INTERNAL_ERROR';

/** 业务异常：中间件会把它转换成统一错误响应体 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details?: unknown;

  constructor(status: number, code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(message: string, details?: unknown): ApiError {
    return new ApiError(400, 'BAD_REQUEST', message, details);
  }

  static validation(message: string, details?: unknown): ApiError {
    return new ApiError(422, 'VALIDATION_ERROR', message, details);
  }

  static unauthorized(message = '未登录或登录已过期'): ApiError {
    return new ApiError(401, 'UNAUTHORIZED', message);
  }

  static forbidden(message = '无权访问该资源'): ApiError {
    return new ApiError(403, 'FORBIDDEN', message);
  }

  static notFound(message = '资源不存在'): ApiError {
    return new ApiError(404, 'NOT_FOUND', message);
  }

  static conflict(message = '资源冲突'): ApiError {
    return new ApiError(409, 'CONFLICT', message);
  }

  static internal(message = '服务器内部错误', details?: unknown): ApiError {
    return new ApiError(500, 'INTERNAL_ERROR', message, details);
  }
}
