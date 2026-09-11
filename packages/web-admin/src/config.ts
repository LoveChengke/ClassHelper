import { DEFAULT_SERVER_URL } from '@classhelper/shared';

/** 页面是否由 http(s) 提供（生产环境由后端托管，浏览器里恒为 true） */
const servedOverHttp = typeof window !== 'undefined' && /^https?:$/.test(window.location.protocol);

/**
 * 运行时配置。
 *
 * 默认使用**同源相对路径**：
 * - 生产：后端同时托管 Web 管理端，`/api` 与 `/socket.io` 同源，无需任何配置；
 * - 开发：Vite 已把 `/api` 与 `/socket.io` 代理到后端（见 vite.config.ts），同样可用；
 * - 需要指向其它后端（例如静态托管在 CDN）时，构建期设置 VITE_API_BASE_URL / VITE_SOCKET_URL。
 */
export const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? (servedOverHttp ? '/api' : `${DEFAULT_SERVER_URL}/api`);

export const SOCKET_URL =
  import.meta.env.VITE_SOCKET_URL ?? (servedOverHttp ? window.location.origin : DEFAULT_SERVER_URL);

export const APP_TITLE = '班级小助手 · 管理端';
