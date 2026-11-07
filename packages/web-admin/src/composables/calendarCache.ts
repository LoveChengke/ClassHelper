import { isAxiosError } from 'axios';
import type { DateMark } from '@classhelper/ui';

const prefix = 'classhelper.calendar.';
type CalendarStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;
function browserStorage(): CalendarStorage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

export function calendarCacheScope(
  principal: {
    user: { id: string; role: string } | null;
    permissions: readonly string[];
    classScopes: object;
    allScopeKeys: readonly string[];
  },
  server = location.origin,
): string {
  return JSON.stringify([
    server,
    principal.user?.id,
    principal.user?.role,
    principal.permissions,
    principal.classScopes,
    principal.allScopeKeys,
  ]);
}

export function clearCalendarCache(storage: CalendarStorage | undefined = browserStorage()): void {
  if (!storage) return;
  try {
    for (let i = storage.length - 1; i >= 0; i--) {
      const key = storage.key(i);
      if (key?.startsWith(prefix)) storage.removeItem(key);
    }
  } catch {
    /* 缓存不可用不阻断登录和在线读取。 */
  }
}

export async function cachedCalendarMarks(
  scope: string,
  filters: object,
  load: () => Promise<DateMark[]>,
  storage: CalendarStorage | undefined = browserStorage(),
): Promise<DateMark[]> {
  const key = prefix + JSON.stringify([scope, filters]);
  try {
    const marks = await load();
    try {
      if (storage && storage.length >= 100) clearCalendarCache(storage);
      storage?.setItem(key, JSON.stringify(marks));
    } catch {
      /* 配额或隐私设置不影响在线结果。 */
    }
    return marks;
  } catch (error) {
    // 服务端拒绝、校验错误与撤权不能降级读取缓存。
    if (isAxiosError(error) && [401, 403].includes(error.response?.status ?? 0)) clearCalendarCache(storage);
    if (!isAxiosError(error) || error.response) throw error;
    try {
      const cached: unknown = JSON.parse(storage?.getItem(key) ?? 'null');
      if (
        Array.isArray(cached) &&
        cached.every(
          (item) =>
            item && /^\d{4}-\d{2}-\d{2}$/.test(item.date) && Number.isInteger(item.count) && item.count > 0,
        )
      )
        return cached;
    } catch {
      /* 损坏缓存交给原请求错误处理。 */
    }
    throw error;
  }
}
