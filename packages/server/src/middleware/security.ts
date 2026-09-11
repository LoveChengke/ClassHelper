import type { RequestHandler } from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * 安全响应头（helmet）。
 *
 * CSP 说明：
 * - style-src 需要 'unsafe-inline'：Element Plus 运行时注入行内样式
 * - connect-src 需要放行 WebSocket（同源 ws/wss）与已配置的跨域后端
 * - 桌面客户端通过 file:// 加载页面，因此不启用 COOP/COEP，资源策略设为 cross-origin
 */
export function securityHeaders(): RequestHandler {
  const connectSrc = new Set<string>(["'self'", 'ws:', 'wss:']);
  if (Array.isArray(env.corsOrigins)) {
    for (const origin of env.corsOrigins) connectSrc.add(origin);
  }

  return helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:', 'blob:'],
        'font-src': ["'self'", 'data:'],
        'connect-src': [...connectSrc],
        'object-src': ["'none'"],
        'base-uri': ["'self'"],
        'frame-ancestors': ["'none'"],
        'form-action': ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    // 允许桌面客户端等跨源场景读取静态资源与接口响应
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    referrerPolicy: { policy: 'no-referrer' },
    hsts: env.isProduction ? { maxAge: 15552000, includeSubDomains: true } : false,
  });
}

/** 通用接口限流：防止单 IP 高频刷接口 */
export function apiRateLimiter(): RequestHandler {
  const limiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    limit: env.isProduction ? 600 : 3000,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => !env.rateLimitEnabled,
    handler: (req, res) => {
      logger.warn(`触发接口限流：${req.ip ?? '-'} ${req.method} ${req.originalUrl}`);
      res.status(429).json({
        success: false,
        data: null,
        message: '请求过于频繁，请稍后再试',
        code: 'TOO_MANY_REQUESTS',
      });
    },
  });
  return limiter;
}

/** 登录接口专用限流：防暴力破解 */
export function loginRateLimiter(): RequestHandler {
  return rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: env.isProduction ? 20 : 200,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    skip: () => !env.rateLimitEnabled,
    handler: (req, res) => {
      logger.warn(`登录尝试过于频繁：${req.ip ?? '-'}`);
      res.status(429).json({
        success: false,
        data: null,
        message: '登录尝试过于频繁，请 10 分钟后再试',
        code: 'TOO_MANY_REQUESTS',
      });
    },
  });
}

/** 请求耗时日志（生产 info，开发 debug） */
export function requestLogger(): RequestHandler {
  return (req, res, next) => {
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const message = `${req.method} ${req.originalUrl} ${res.statusCode} ${durationMs.toFixed(1)}ms`;
      if (res.statusCode >= 500) logger.error(message);
      else if (res.statusCode >= 400) logger.warn(message);
      else if (env.isProduction) logger.info(message);
      else logger.debug(message);
    });
    next();
  };
}
