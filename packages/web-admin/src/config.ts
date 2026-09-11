import { DEFAULT_SERVER_URL } from '@classhelper/shared';

/**
 * 运行时配置。
 * 默认直连后端（开发/生产都可用）；如需走 Vite 代理，把 .env 里的
 * VITE_API_BASE_URL 设为 /api 即可（vite.config.ts 已配置代理）。
 */
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? `${DEFAULT_SERVER_URL}/api`;

export const SOCKET_URL = import.meta.env.VITE_SOCKET_URL ?? DEFAULT_SERVER_URL;

export const APP_TITLE = '班级小助手 · 管理端';
