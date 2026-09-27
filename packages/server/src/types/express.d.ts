import type { TokenPayload } from '../lib/jwt.js';

/**
 * 扩展 Express 的 Request 类型。
 * - auth：认证中间件解析出的当前用户
 * - validatedQuery / validatedParams：校验中间件产出的类型安全数据
 *   （Express 5 中 req.query 是只读 getter，不能直接覆盖，因此单独存放）
 */
declare global {
  namespace Express {
    interface Request {
      auth?: {
        token: string;
        user: TokenPayload;
      };
      validatedQuery?: unknown;
      validatedParams?: unknown;
      /** ClassIsland 联动插件上报时解析出的设备上下文（见 modules/integrations/device-auth.ts） */
      device?: {
        deviceId: string;
        classId: string;
        name: string;
        enabled: boolean;
        syncScheduleToServer: boolean;
        mirrorScheduleToClassIsland: boolean;
      };
    }
  }
}

export {};
