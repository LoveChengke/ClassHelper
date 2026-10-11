import type { PermissionKey } from '@classhelper/shared';
import type { TokenPayload } from '../lib/jwt.js';
import type { DeviceContext } from '../modules/integrations/device-auth.js';

/**
 * 扩展 Express 的 Request 类型。
 * - auth：认证中间件解析出的当前用户 + 生效权限集合
 * - validatedQuery / validatedParams：校验中间件产出的类型安全数据
 *   （Express 5 中 req.query 是只读 getter，不能直接覆盖，因此单独存放）
 * - device：ClassIsland 插件上报时解析出的设备上下文
 */
declare global {
  namespace Express {
    interface Request {
      auth?: {
        token: string;
        user: TokenPayload;
        /** 生效权限集合（权限组并集，或角色默认模板；班级端为空集） */
        permissions?: ReadonlySet<PermissionKey>;
      };
      validatedQuery?: unknown;
      validatedParams?: unknown;
      /**
       * ClassIsland 联动插件上报时解析出的设备上下文（见 modules/integrations/device-auth.ts）。
       *
       * **引用那个接口本身，不要在这里再抄一遍字段** —— 原先这里是手抄的结构，
       * 往 `DeviceContext` 加字段时两边就漂了，而报错会落在 `getDevice()` 的 `return device;`
       * 上（"Property 'x' is missing … but required"），看不出真正原因是这处重复声明。
       */
      device?: DeviceContext;
    }
  }
}

export {};
