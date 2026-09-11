import { cacheGet, cacheRemove, cacheSet, cacheStats } from './db.js';
import { fetchWithCache } from './index.js';

export interface SmokeCheckResult {
  ok: boolean;
  detail: string;
}

/**
 * 冒烟自检 1：IndexedDB 写入 / 读回 / 统计 / 删除。
 * 由主进程通过 webContents.executeJavaScript 调用。
 */
export async function cacheSelfTest(): Promise<SmokeCheckResult> {
  const key = '__smoke_selftest__';
  const payload = { text: 'ok', at: Date.now() };

  await cacheSet('profile', key, payload);
  const readBack = await cacheGet<typeof payload>('profile', key);
  const stats = await cacheStats();
  await cacheRemove('profile', key);
  const removed = await cacheGet<typeof payload>('profile', key);

  const ok = readBack?.value.text === 'ok' && removed === null && stats.length > 0;
  return {
    ok,
    detail: `readBack=${readBack?.value.text ?? '-'} removed=${removed === null} stores=${stats.length}`,
  };
}

/**
 * 冒烟自检 2：断网回退。
 * 先写入缓存，再向一个不存在的端口发请求（必然失败），
 * 验证 fetchWithCache 能回退到本地缓存。
 */
export async function offlineScenario(): Promise<SmokeCheckResult> {
  const key = '__smoke_offline__';
  const payload = [{ id: 'offline-1', title: '离线缓存中的作业' }];

  await cacheSet('homeworks', key, payload);

  const result = await fetchWithCache<Array<{ id: string; title: string }>>(
    'homeworks',
    key,
    async () => {
      const response = await fetch('http://127.0.0.1:59999/api/homeworks');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return (await response.json()) as Array<{ id: string; title: string }>;
    },
    [],
  );

  await cacheRemove('homeworks', key);

  const ok = result.fromCache === true && result.data.length === 1 && Boolean(result.error);
  return {
    ok,
    detail: `fromCache=${result.fromCache} items=${result.data.length} error=${result.error ?? '-'}`,
  };
}

/**
 * 冒烟自检 3（需后端在线）：真实登录 + 拉取四类数据 + Socket.IO 连接。
 * 覆盖渲染进程里实际使用的 API 封装、JWT 注入、实时通道与缓存写入。
 */
export async function onlineScenario(): Promise<SmokeCheckResult> {
  const [{ useAuthStore }, { useAppStore }, { useRealtimeStore }, api, cache] = await Promise.all([
    import('../stores/auth.js'),
    import('../stores/app.js'),
    import('../stores/realtime.js'),
    import('../api/index.js'),
    import('./index.js'),
  ]);

  const auth = useAuthStore();
  const appStore = useAppStore();
  const realtime = useRealtimeStore();

  const serverUrl = 'http://127.0.0.1:4000';
  const detail: string[] = [];

  try {
    await auth.login(serverUrl, 'student01', 'student123');
    detail.push(`login=${auth.user?.name ?? '-'}`);

    await appStore.init(serverUrl);
    detail.push(`reachable=${appStore.serverReachable}`);

    const [classes, homeworks, notifications, grades] = await Promise.all([
      api.classApi.list(),
      api.homeworkApi.list(),
      api.notificationApi.list(),
      api.gradeApi.my(),
    ]);
    const term = await api.dashboardApi.term();
    const schedules = await api.scheduleApi.list({ week: term.currentWeek });

    detail.push(`classes=${classes.length}`);
    detail.push(`homeworks=${homeworks.length}`);
    detail.push(`notifications=${notifications.length}`);
    detail.push(`grades=${grades.length}`);
    detail.push(`week${term.currentWeek}Schedules=${schedules.length}`);

    // 写入缓存（离线可用的前提）
    await cache.writeCache('homeworks', 'self', homeworks);
    await cache.writeCache('grades', 'my', grades);
    await cache.writeCache('notifications', 'self', notifications);

    // Socket.IO：连接并等待服务端回执
    if (auth.token) {
      realtime.connect(serverUrl, auth.token);
      const connected = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 8000);
        const handler = (): void => {
          clearTimeout(timer);
          resolve(true);
        };
        realtime.on('__connected__', handler);
        if (realtime.connected) handler();
      });
      detail.push(`socket=${connected}`);
      if (!connected) {
        realtime.disconnect();
        await auth.logout();
        return { ok: false, detail: `${detail.join(' ')} (实时通道未连接)` };
      }
    }

    const ok =
      classes.length === 1 &&
      schedules.length > 0 &&
      homeworks.length > 0 &&
      notifications.length > 0 &&
      grades.length > 0 &&
      realtime.connected;

    realtime.disconnect();
    await auth.logout(); // 清理登录态，保证下次冒烟从登录页开始
    return { ok, detail: detail.join(' ') };
  } catch (error) {
    realtime.disconnect();
    await auth.logout().catch(() => undefined);
    return {
      ok: false,
      detail: `${detail.join(' ')} error=${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** 注册到 window，供主进程冒烟脚本调用 */
export function registerSmokeHooks(): void {
  window.__classhelperSmoke__ = { cacheSelfTest, offlineScenario, onlineScenario };
}
