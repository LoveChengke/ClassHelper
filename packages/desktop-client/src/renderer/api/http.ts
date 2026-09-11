import axios, { type AxiosError, type AxiosRequestConfig } from 'axios';
import { ElMessage } from 'element-plus';
import type { ApiErrorResponse, ApiResponse } from '@classhelper/shared';
import { apiBaseOf } from '../config.js';

export const http = axios.create({ timeout: 15000 });

/** 服务器地址变化时更新 baseURL（登录页/设置页可改） */
export function setApiBaseUrl(serverUrl: string): void {
  http.defaults.baseURL = apiBaseOf(serverUrl);
}

let tokenProvider: () => string | null = () => null;
export function setTokenProvider(provider: () => string | null): void {
  tokenProvider = provider;
}

let unauthorizedHandler: () => void = () => undefined;
export function setUnauthorizedHandler(handler: () => void): void {
  unauthorizedHandler = handler;
}

let reachabilityReporter: (reachable: boolean) => void = () => undefined;
export function setReachabilityReporter(reporter: (reachable: boolean) => void): void {
  reachabilityReporter = reporter;
}

/** 判断是否为「网络不可达」（用于离线判定，不弹提示） */
export function isNetworkError(error: unknown): boolean {
  const axiosError = error as AxiosError | undefined;
  return Boolean(axiosError && !axiosError.response);
}

http.interceptors.request.use((config) => {
  const token = tokenProvider();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

http.interceptors.response.use(
  (response) => {
    reachabilityReporter(true);
    const body = response.data as ApiResponse<unknown> | undefined;
    if (body && typeof body === 'object' && 'success' in body) {
      if (!body.success) {
        ElMessage.error(body.message || '请求失败');
        return Promise.reject(new Error(body.message || '请求失败'));
      }
      return body.data as never;
    }
    return response.data as never;
  },
  (error: AxiosError<ApiErrorResponse>) => {
    // 网络不可达：交给调用方走离线缓存，不打扰用户
    if (!error.response) {
      reachabilityReporter(false);
      return Promise.reject(error);
    }

    reachabilityReporter(true);
    const status = error.response.status;
    const message = error.response.data?.message ?? `请求失败（${status}）`;

    if (status === 401) {
      ElMessage.warning('登录状态已失效，请重新登录');
      unauthorizedHandler();
    } else {
      ElMessage.error(message);
    }
    return Promise.reject(error);
  },
);

async function request<T>(config: AxiosRequestConfig): Promise<T> {
  return (await http.request(config)) as unknown as T;
}

export const api = {
  get: <T>(url: string, params?: Record<string, unknown>): Promise<T> =>
    request<T>({ method: 'GET', url, params }),
  post: <T>(url: string, data?: unknown): Promise<T> => request<T>({ method: 'POST', url, data }),
  patch: <T>(url: string, data?: unknown): Promise<T> => request<T>({ method: 'PATCH', url, data }),
  delete: <T>(url: string): Promise<T> => request<T>({ method: 'DELETE', url }),
};

/** 健康检查（用于可达性轮询，不弹任何提示） */
export async function pingHealth(): Promise<{ ok: boolean; status?: string }> {
  try {
    const base = http.defaults.baseURL ?? '';
    const response = await axios.get(`${base}/health`, { timeout: 5000 });
    return { ok: true, status: response.data?.data?.status as string | undefined };
  } catch {
    return { ok: false };
  }
}
