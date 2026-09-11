import type { Router } from 'express';

/**
 * 模块契约。
 *
 * app.ts 只做一件事：遍历 registry 里启用的模块并挂载到 `${API_PREFIX}${basePath}`。
 * 因此「新增/移除一个功能模块」= 在 registry.ts 里增删一行，
 * 不需要改动 app.ts、错误处理或实时通道。
 */
export interface ApiModule {
  /** 模块名，用于日志 */
  name: string;
  /** 挂载路径，例如 '/classes' */
  basePath: string;
  /** Express 路由 */
  router: Router;
  /** 置为 false 可临时下线该模块（不出现在路由表中） */
  enabled?: boolean;
}

export function defineModule(module: ApiModule): ApiModule {
  return module;
}
