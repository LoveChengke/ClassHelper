import { DEFAULT_SERVER_URL } from '@classhelper/shared';

/** 默认后端地址（首次启动的预填值） */
export const DEFAULT_SERVER = DEFAULT_SERVER_URL;

/**
 * 品牌标地址（侧栏与登录页的 `<img>` 用它）。
 *
 * 模板里既不能写 `src="logo.png"`、也不能写 `src="/logo.png"`：
 *   ① 字面量的**相对** `src` 会被 Vite 当成模块导入去解析 —— 构建直接失败
 *      （`Rolldown failed to resolve import "logo.png" from "LoginView.vue"`）；
 *   ② 根绝对路径在打包形态下是坏的：Electron 用 `file://` 加载
 *      `dist/renderer/index.html`，`/logo.png` 会解析到**盘符根目录**。
 * 所以只能「绑定属性 + 跟着 vite base 走」：base 为 `'./'`，结果是 `./logo.png`，
 * 开发态（5174 静态服务）与打包态（`dist/renderer/logo.png`）都指向 public/ 拷过去的那份。
 */
export const BRAND_LOGO_URL = `${import.meta.env.BASE_URL}logo.png`;

/** 由服务器地址推导 API 基地址，例如 http://127.0.0.1:4000 -> http://127.0.0.1:4000/api */
export function apiBaseOf(serverUrl: string): string {
  return `${serverUrl.trim().replace(/\/+$/, '')}/api`;
}

/** 由服务器地址推导 Socket.IO 地址 */
export function socketUrlOf(serverUrl: string): string {
  return serverUrl.trim().replace(/\/+$/, '');
}

/** 校验用户输入的服务器地址 */
export function normalizeServerUrl(input: string): string | null {
  const value = input.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s]+$/i.test(value)) return null;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}
