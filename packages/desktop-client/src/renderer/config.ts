import { DEFAULT_SERVER_URL } from '@classhelper/shared';

/** 默认后端地址（首次启动的预填值） */
export const DEFAULT_SERVER = DEFAULT_SERVER_URL;

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
