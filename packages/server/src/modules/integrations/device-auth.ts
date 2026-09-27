import crypto from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { prisma } from '../../lib/db.js';
import { ApiError } from '../../lib/http.js';

/**
 * 联动设备的令牌工具。
 *
 * 为什么不用 JWT：
 * - 令牌是「设备级长期凭证」，插件装在教室机器上，长时间无人值守，
 *   需要一个"管理员在 Web 端点了重置才失效"的凭证，而不是有固定过期时间的会话；
 * - 明文只在创建/重置接口返回一次，服务端只存 sha256 —— 库被读走也无法反推出可用令牌。
 */
export function generateDeviceToken(): string {
  // 32 字节随机 -> 64 位十六进制，前缀便于在日志/设置页里一眼认出
  return `chci_${crypto.randomBytes(32).toString('hex')}`;
}

export function hashDeviceToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 令牌前缀提示（chci_ + 前 8 位），用于设备列表里人眼识别 */
export function tokenHintOf(token: string): string {
  return `${token.slice(0, 13)}…`;
}

/** 从 \`X-ClassIsland-Token\` 或 \`Authorization: Bearer\` 中取出设备令牌 */
export function extractDeviceToken(headerValue: string | undefined, custom: unknown): string | null {
  if (typeof custom === 'string' && custom.trim()) return custom.trim();
  if (!headerValue) return null;
  const [scheme, value] = headerValue.split(' ');
  if (!value || scheme.toLowerCase() !== 'bearer') return null;
  return value.trim();
}

/** 设备上下文（与 Express.Request.device 的结构一致） */
export interface DeviceContext {
  deviceId: string;
  classId: string;
  name: string;
  enabled: boolean;
  syncScheduleToServer: boolean;
  mirrorScheduleToClassIsland: boolean;
}

/** 插件侧路由统一挂这个中间件：解析设备令牌并回查设备记录 */
export function authenticateDevice(): RequestHandler {
  return (req, _res, next) => {
    void (async () => {
      try {
        const token = extractDeviceToken(req.headers.authorization, req.headers['x-classisland-token']);
        if (!token) throw ApiError.unauthorized('缺少设备令牌（X-ClassIsland-Token）');

        const record = await prisma.integrationDevice.findFirst({
          where: { tokenHash: hashDeviceToken(token) },
          select: {
            id: true,
            classId: true,
            name: true,
            enabled: true,
            syncScheduleToServer: true,
            mirrorScheduleToClassIsland: true,
          },
        });
        if (!record) throw ApiError.unauthorized('设备令牌无效，请在「ClassIsland 联动」里重新生成');

        const context: DeviceContext = {
          deviceId: record.id,
          classId: record.classId,
          name: record.name,
          enabled: record.enabled,
          syncScheduleToServer: record.syncScheduleToServer,
          mirrorScheduleToClassIsland: record.mirrorScheduleToClassIsland,
        };
        req.device = context;
        next();
      } catch (error) {
        next(error);
      }
    })();
  };
}

/** 取出当前设备上下文，未鉴权时抛 401 */
export function getDevice(req: Request): DeviceContext {
  const device = req.device;
  if (!device) throw ApiError.unauthorized('缺少设备上下文');
  return device;
}

/** 设备被管理员停用：插件上报与下发一律拒绝（403 而不是 401，便于插件提示"请管理员开启"） */
export function assertDeviceEnabled(device: DeviceContext): void {
  if (!device.enabled) {
    throw ApiError.forbidden('该设备已在「ClassIsland 联动」中被停用，请联系管理员开启');
  }
}

/** 生成的令牌字符串的字面量前缀，供测试与文档引用 */
export const DEVICE_TOKEN_PREFIX = 'chci_';
