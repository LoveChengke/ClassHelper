import axios, { type AxiosError, type AxiosRequestConfig } from 'axios';
import { ElMessage } from 'element-plus';
import { STORAGE_KEYS, type ApiErrorResponse, type ApiResponse } from '@classhelper/shared';
import { API_BASE_URL } from '@/config';

/**
 * Axios 封装：
 * 1) 自动携带 JWT
 * 2) 统一拆包（响应拦截器直接把 data 返回给调用方）
 * 3) 统一错误提示；401 自动清理会话并回到登录页
 */
const instance = axios.create({
  baseURL: API_BASE_URL,
  timeout: 20000,
});

instance.interceptors.request.use((config) => {
  const token = localStorage.getItem(STORAGE_KEYS.token);
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

instance.interceptors.response.use(
  (response) => {
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
    const status = error.response?.status;
    const message = error.response?.data?.message ?? error.message ?? '网络请求失败';

    if (status === 401) {
      localStorage.removeItem(STORAGE_KEYS.token);
      localStorage.removeItem(STORAGE_KEYS.user);
      ElMessage.warning('登录状态已失效，请重新登录');
      if (!window.location.pathname.endsWith('/login')) {
        window.location.assign('/login');
      }
    } else {
      ElMessage.error(message);
    }
    return Promise.reject(error);
  },
);

/** 统一请求入口：返回值已经是响应体里的 data */
async function request<T>(config: AxiosRequestConfig): Promise<T> {
  return (await instance.request(config)) as unknown as T;
}

export const api = {
  get: <T>(url: string, params?: Record<string, unknown>): Promise<T> =>
    request<T>({ method: 'GET', url, params }),
  post: <T>(url: string, data?: unknown): Promise<T> => request<T>({ method: 'POST', url, data }),
  patch: <T>(url: string, data?: unknown): Promise<T> => request<T>({ method: 'PATCH', url, data }),
  put: <T>(url: string, data?: unknown): Promise<T> => request<T>({ method: 'PUT', url, data }),
  delete: <T>(url: string): Promise<T> => request<T>({ method: 'DELETE', url }),
};
