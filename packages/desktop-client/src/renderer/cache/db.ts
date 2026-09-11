/**
 * IndexedDB 缓存层（无第三方依赖）。
 *
 * 设计：
 * - 一个数据库 classhelper-cache，按业务域拆分为多个 object store
 * - 每条记录 = { key, value, updatedAt }，key 形如 `${classId}` / `${classId}:${week}`
 * - 所有操作都包成 Promise；任何一步失败都不会抛出到 UI（离线时降级为空）
 */

export const CACHE_STORES = [
  'profile',
  'classes',
  'schedules',
  'homeworks',
  'notifications',
  'grades',
] as const;
export type CacheStore = (typeof CACHE_STORES)[number];

export interface CacheRecord<T> {
  key: string;
  value: T;
  updatedAt: number;
}

export interface CacheStoreStat {
  store: CacheStore;
  count: number;
  updatedAt: number | null;
}

const DB_NAME = 'classhelper-cache';
const DB_VERSION = 1;

let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;

  databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      for (const store of CACHE_STORES) {
        if (!db.objectStoreNames.contains(store)) {
          db.createObjectStore(store, { keyPath: 'key' });
        }
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 打开失败'));
    request.onblocked = () => reject(new Error('IndexedDB 被其它窗口占用'));
  });

  return databasePromise;
}

function runRequest<T>(
  store: CacheStore,
  mode: IDBTransactionMode,
  action: (objectStore: IDBObjectStore) => IDBRequest,
): Promise<T> {
  return openDatabase().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(store, mode);
        const request = action(transaction.objectStore(store));
        request.onsuccess = () => resolve(request.result as T);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB 操作失败'));
      }),
  );
}

/**
 * 转成可被 IndexedDB 结构化克隆的纯数据。
 *
 * 关键：Vue 的 reactive/ref 包装对象是 Proxy，直接 put 会抛
 * "could not be cloned"。缓存内容都是后端 JSON 响应，因此用 JSON 往返即可，
 * 既去掉代理又保证与 DTO（日期为 ISO 字符串）一致。
 */
function toPlain<T>(value: T): T {
  if (value === undefined) return null as unknown as T;
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

export async function cacheSet<T>(store: CacheStore, key: string, value: T): Promise<void> {
  const record: CacheRecord<T> = { key, value: toPlain(value), updatedAt: Date.now() };
  await runRequest<IDBValidKey>(store, 'readwrite', (objectStore) => objectStore.put(record));
}

export function cacheGet<T>(store: CacheStore, key: string): Promise<CacheRecord<T> | null> {
  return runRequest<CacheRecord<T> | undefined>(store, 'readonly', (objectStore) =>
    objectStore.get(key),
  ).then((record) => record ?? null);
}

export function cacheList<T>(store: CacheStore): Promise<Array<CacheRecord<T>>> {
  return runRequest<Array<CacheRecord<T>>>(store, 'readonly', (objectStore) => objectStore.getAll());
}

export async function cacheRemove(store: CacheStore, key: string): Promise<void> {
  await runRequest<undefined>(store, 'readwrite', (objectStore) => objectStore.delete(key));
}

export async function cacheClearStore(store: CacheStore): Promise<void> {
  await runRequest<undefined>(store, 'readwrite', (objectStore) => objectStore.clear());
}

export async function cacheClearAll(): Promise<void> {
  for (const store of CACHE_STORES) {
    await cacheClearStore(store);
  }
}

/** 各业务域的条目数与最近更新时间，用于「设置」页展示离线缓存状况 */
export async function cacheStats(): Promise<CacheStoreStat[]> {
  const stats: CacheStoreStat[] = [];
  for (const store of CACHE_STORES) {
    const records = await cacheList<unknown>(store);
    const latest = records.reduce<number | null>(
      (max, record) => (max === null || record.updatedAt > max ? record.updatedAt : max),
      null,
    );
    stats.push({ store, count: records.length, updatedAt: latest });
  }
  return stats;
}
