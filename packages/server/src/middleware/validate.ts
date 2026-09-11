import type { Request, RequestHandler } from 'express';
import type { ZodType } from 'zod';

interface ValidationTargets<B, Q, P> {
  body?: ZodType<B>;
  query?: ZodType<Q>;
  params?: ZodType<P>;
}

/**
 * 基于 zod 的请求校验中间件。
 * 校验结果写入 req.body / req.validatedQuery / req.validatedParams，
 * 失败抛出的 ZodError 由统一错误中间件转换成 422。
 */
export function validate<B = unknown, Q = unknown, P = unknown>(
  targets: ValidationTargets<B, Q, P>,
): RequestHandler {
  return (req, _res, next) => {
    try {
      if (targets.body) req.body = targets.body.parse(req.body) as unknown;
      if (targets.query) req.validatedQuery = targets.query.parse(req.query) as unknown;
      if (targets.params) req.validatedParams = targets.params.parse(req.params) as unknown;
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** 读取已校验的 query（类型由调用方用 zod schema 保证） */
export function validatedQuery<T>(req: Request): T {
  return (req.validatedQuery ?? {}) as T;
}

/** 读取已校验的 params */
export function validatedParams<T>(req: Request): T {
  return (req.validatedParams ?? {}) as T;
}
