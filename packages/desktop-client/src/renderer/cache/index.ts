import { cacheGet, cacheSet, type CacheStore } from './db.js';

export interface CachedFetchResult<T> {
  data: T;
  /** true 表示本次数据来自本地缓存（网络失败或未联网） */
  fromCache: boolean;
  /** 缓存写入时间（来自缓存时有效） */
  updatedAt: number | null;
  /** 网络失败原因（成功时为 null） */
  error: string | null;
}

/**
 * 带离线回退的取数：
 * 1) 先请求网络，成功则写入缓存并返回
 * 2) 网络失败则读取缓存；缓存缺失时返回调用方提供的兜底值
 *
 * 「联网后自动同步」由调用方在重连事件里再次调用本函数完成。
 */
export async function fetchWithCache<T>(
  store: CacheStore,
  key: string,
  loader: () => Promise<T>,
  fallback: T,
): Promise<CachedFetchResult<T>> {
  try {
    const data = await loader();
    await cacheSet(store, key, data);
    return { data, fromCache: false, updatedAt: Date.now(), error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const cached = await cacheGet<T>(store, key).catch(() => null);
    if (cached) {
      return { data: cached.value, fromCache: true, updatedAt: cached.updatedAt, error: message };
    }
    return { data: fallback, fromCache: false, updatedAt: null, error: message };
  }
}

/** 只读缓存（不再发请求），用于启动时先渲染旧数据 */
export async function readCache<T>(
  store: CacheStore,
  key: string,
  fallback: T,
): Promise<CachedFetchResult<T>> {
  const cached = await cacheGet<T>(store, key).catch(() => null);
  if (cached) return { data: cached.value, fromCache: true, updatedAt: cached.updatedAt, error: null };
  return { data: fallback, fromCache: false, updatedAt: null, error: null };
}

/** 把实时推送的数据直接写入缓存，保证离线时看到的是最新内容 */
export async function writeCache<T>(store: CacheStore, key: string, value: T): Promise<void> {
  await cacheSet(store, key, value);
}
