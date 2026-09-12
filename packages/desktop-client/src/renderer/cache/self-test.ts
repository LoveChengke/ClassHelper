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

/** 轮询等待条件成立（用于验证点击后界面确实发生跳转） */
async function waitUntil(predicate: () => boolean, timeoutMs = 3000, intervalMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return predicate();
}

/** 侧边栏菜单与期望路由的对应关系（按显示文案匹配） */
const EXPECTED_MENU: Array<{ label: string; path: string }> = [
  { label: '课表', path: '/schedule' },
  { label: '作业', path: '/homeworks' },
  { label: '通知', path: '/notifications' },
  { label: '成绩', path: '/grades' },
  { label: '设置', path: '/settings' },
];

/**
 * 冒烟自检 3：侧边栏点击导航。
 * 直接对真实 DOM 触发 click，验证每次点击后路由与视图都发生切换 ——
 * 这是"点击左侧边栏没反应"这类问题的回归测试。
 */
export async function layoutNavigationSelfTest(): Promise<SmokeCheckResult> {
  const { router } = await import('../router/index.js');

  const findMenuItem = (label: string): HTMLElement | undefined =>
    (Array.from(document.querySelectorAll('.el-menu-item')) as HTMLElement[]).find((element) =>
      (element.textContent ?? '').trim().startsWith(label),
    );

  if (!findMenuItem('课表')) {
    return { ok: false, detail: '侧边栏未渲染（当前不在主布局或未登录）' };
  }

  const visited: string[] = [];
  const failures: string[] = [];

  for (const { label, path } of EXPECTED_MENU) {
    const element = findMenuItem(label);
    if (!element) {
      failures.push(`${label}(菜单项缺失)`);
      continue;
    }

    element.click();
    const navigated = await waitUntil(() => router.currentRoute.value.path === path);
    const actualPath = router.currentRoute.value.path;

    // 视图内容也要跟着变（标题取自各页 .page-title）
    const rendered = await waitUntil(() => Boolean(document.querySelector('.page-title')));
    const title = (document.querySelector('.page-title')?.textContent ?? '').trim();

    visited.push(`${label}→${actualPath}${title ? `(${title})` : ''}`);
    if (!navigated) failures.push(`${label}(期望 ${path} 实际 ${actualPath})`);
    else if (!rendered) failures.push(`${label}(视图未渲染)`);
  }

  return {
    ok: failures.length === 0,
    detail: `visited=[${visited.join(' ')}]${failures.length > 0 ? ` failures=${failures.join(';')}` : ''}`,
  };
}

/**
 * 冒烟自检 4（需后端在线）：真实登录 + 拉取四类数据 + Socket.IO 连接。
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

    // 进入主布局（后续的侧边栏点击测试依赖布局已挂载）
    const { router } = await import('../router/index.js');
    await router.push('/schedule');
    const layoutMounted = await waitUntil(() => Boolean(document.querySelector('.el-menu-item')), 5000);
    detail.push(`layout=${layoutMounted}`);

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
      realtime.connected &&
      layoutMounted;

    // 会话保留给后续的侧边栏点击测试，由 sessionCleanup() 统一清理
    return { ok, detail: detail.join(' ') };
  } catch (error) {
    return {
      ok: false,
      detail: `${detail.join(' ')} error=${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 冒烟自检 5（需后端在线）：真实通知链路 → 灵动岛。
 *
 * 前面的灵动岛用例直接调 IPC 验证"状态机"，这一条走**真机链路**：
 * 教师账号给"当前登录学生所在班级"发一条通知 → 服务端 Socket.IO 广播 →
 * 客户端 realtime store → bridge → 主进程灵动岛。主进程随后断言灵动岛弹出胶囊，
 * 并继续验证"在灵动岛点标为已读 → 通知中心同步为已读"。
 */
export async function islandRealtimeScenario(): Promise<{
  ok: boolean;
  detail: string;
  notificationId?: string;
  teacherToken?: string;
  title?: string;
  classId?: string;
  inClass?: boolean;
}> {
  const [{ useAuthStore }, { getIslandClassContext }] = await Promise.all([
    import('../stores/auth.js'),
    import('../island/bridge.js'),
  ]);
  const auth = useAuthStore();
  const serverUrl = 'http://127.0.0.1:4000';
  const classId = auth.classId ?? null;
  if (!classId) return { ok: false, detail: '当前学生没有班级，无法投递通知' };

  const title = `灵动岛真机链路自检 ${Date.now()}`;
  try {
    const login = await fetch(`${serverUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'teacher1', password: 'teacher123' }),
    }).then((response) => response.json());
    const teacherToken: string | undefined = login?.data?.token;
    if (!teacherToken) return { ok: false, detail: `教师登录失败：${JSON.stringify(login).slice(0, 120)}` };

    const created = await fetch(`${serverUrl}/api/notifications`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${teacherToken}` },
      body: JSON.stringify({
        classId,
        title,
        content: '自动化验证：这条通知用于确认「服务端广播 → 客户端实时通道 → 灵动岛」整条链路可用。',
        priority: 'NORMAL',
      }),
    }).then((response) => response.json());
    const notificationId: string | undefined = created?.data?.id;
    if (!notificationId)
      return { ok: false, detail: `发布通知失败：${JSON.stringify(created).slice(0, 160)}` };

    const context = getIslandClassContext();
    return {
      ok: true,
      detail: `classId=${classId} 通知=${notificationId} 客户端判定上课中=${context.inClass}`,
      notificationId,
      teacherToken,
      title,
      classId,
      inClass: context.inClass,
    };
  } catch (error) {
    return { ok: false, detail: `投递失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

/** 冒烟收尾：删除真实链路自检产生的通知 */
export async function islandRealtimeCleanup(
  notificationId: string,
  teacherToken: string,
): Promise<SmokeCheckResult> {
  try {
    const response = await fetch(`http://127.0.0.1:4000/api/notifications/${notificationId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${teacherToken}` },
    });
    return { ok: response.ok, detail: `清理通知 ${notificationId} → HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 读取某条通知在本地通知中心里的已读状态。
 * 用于验证"灵动岛点标为已读 → 通知中心也变成已读、未读数下降"。
 */
export async function islandReadState(notificationId: string): Promise<{
  found: boolean;
  read: boolean;
  unreadCount: number;
  title: string;
}> {
  const { useNotificationStore } = await import('../stores/notifications.js');
  const store = useNotificationStore();
  if (store.items.length === 0) await store.load().catch(() => undefined);
  const target = store.items.find((item) => item.id === notificationId);
  return {
    found: Boolean(target),
    read: Boolean(target?.read),
    unreadCount: store.unreadCount,
    title: target?.title ?? '',
  };
}

/** 冒烟收尾：断开实时通道并退出登录，保证下次冒烟从登录页开始 */
export async function sessionCleanup(): Promise<SmokeCheckResult> {
  const [{ useAuthStore }, { useRealtimeStore }] = await Promise.all([
    import('../stores/auth.js'),
    import('../stores/realtime.js'),
  ]);
  try {
    useRealtimeStore().disconnect();
    await useAuthStore().logout();
    return { ok: true, detail: '已断开实时通道并清理登录态' };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/** 注册到 window，供主进程冒烟脚本调用 */
export function registerSmokeHooks(): void {
  window.__classhelperSmoke__ = {
    cacheSelfTest,
    offlineScenario,
    layoutNavigationSelfTest,
    onlineScenario,
    islandRealtimeScenario,
    islandRealtimeCleanup,
    islandReadState,
    sessionCleanup,
  };
}
