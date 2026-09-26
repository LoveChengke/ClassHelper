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

  // 按**文案那一层 span 的完整文本**匹配，而不是整项 textContent：
  // "通知"项里还有一个未读红点徽标（sup），整项 textContent 会变成 "2通知"，
  // 用 startsWith 匹配就会误报"菜单项缺失"（历史失败原因）。
  const findMenuItem = (label: string): HTMLElement | undefined =>
    (Array.from(document.querySelectorAll('.el-menu-item')) as HTMLElement[]).find((element) =>
      Array.from(element.querySelectorAll('span')).some(
        (span) => (span.textContent ?? '').trim() === label,
      ),
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

/** 自检临时造的作业/通知（收尾必须删掉，避免污染用户的库） */
let temporaryContent: { token: string; homeworks: string[]; notifications: string[] } | null = null;

/**
 * 服务端业务数据可能被管理员清空（用户明确要求过"删掉所有作业和通知"），
 * 因此联网自检在列表为空时**自建**一条作业/通知来验证链路，收尾（sessionCleanup）删除。
 */
async function seedSmokeContent(
  classId: string | null,
  need: { homework: boolean; notification: boolean },
): Promise<SmokeCheckResult> {
  if (!classId) return { ok: false, detail: '缺少班级，无法自建数据' };
  const serverUrl = 'http://127.0.0.1:4000';
  const stamp = `自检 ${new Date().toLocaleTimeString('zh-CN')}`;

  try {
    const login = await fetch(`${serverUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'teacher1', password: 'teacher123' }),
    }).then((response) => response.json());
    const token: string | undefined = login?.data?.token;
    if (!token) return { ok: false, detail: `教师登录失败：${JSON.stringify(login).slice(0, 120)}` };

    const homeworks: string[] = [];
    const notifications: string[] = [];

    if (need.homework) {
      const created = await fetch(`${serverUrl}/api/homeworks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          classId,
          courseId: null,
          title: `自动化验证作业 ${stamp}`,
          content: '服务端没有作业数据时由冒烟自检临时创建，验证结束后立即删除，不会留在库里。',
        }),
      }).then((response) => response.json());
      const id: string | undefined = created?.data?.id;
      if (!id) return { ok: false, detail: `自建作业失败：${JSON.stringify(created).slice(0, 160)}` };
      homeworks.push(id);
    }

    if (need.notification) {
      const created = await fetch(`${serverUrl}/api/notifications`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          classId,
          title: `自动化验证通知 ${stamp}`,
          content: '服务端没有通知数据时由冒烟自检临时创建，验证结束后立即删除，不会留在库里。',
          priority: 'NORMAL',
        }),
      }).then((response) => response.json());
      const id: string | undefined = created?.data?.id;
      if (!id) return { ok: false, detail: `自建通知失败：${JSON.stringify(created).slice(0, 160)}` };
      notifications.push(id);
    }

    temporaryContent = { token, homeworks, notifications };
    return { ok: true, detail: `作业+${homeworks.length} 通知+${notifications.length}` };
  } catch (error) {
    return { ok: false, detail: `自建数据异常：${error instanceof Error ? error.message : String(error)}` };
  }
}

/** 删除自检临时造的作业/通知 */
async function cleanupTemporaryContent(): Promise<string> {
  if (!temporaryContent) return '';
  const { token, homeworks, notifications } = temporaryContent;
  temporaryContent = null;
  const serverUrl = 'http://127.0.0.1:4000';
  const removals = [
    ...homeworks.map((id) => `/api/homeworks/${id}`),
    ...notifications.map((id) => `/api/notifications/${id}`),
  ];
  let failed = 0;
  for (const path of removals) {
    const response = await fetch(`${serverUrl}${path}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    }).catch(() => null);
    if (!response?.ok) failed += 1;
  }
  return `自检临时数据已清理 ${removals.length - failed}/${removals.length} 条`;
}

/**
 * 冒烟自检 4（需后端在线）：真实登录 + 拉取四类数据 + Socket.IO 连接。
 * 覆盖渲染进程里实际使用的 API 封装、JWT 注入、实时通道与缓存写入。
 */
export async function onlineScenario(credentials?: {
  code: string;
  password: string;
}): Promise<SmokeCheckResult> {
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
    // 学生端已改为「班级账号」登录：凭据由 scripts/smoke.mjs 通过管理端接口准备并传入
    const code = credentials?.code ?? 'G101';
    const password = credentials?.password ?? '123456';
    if (!credentials?.code) detail.push('未收到班级凭据，回退到种子班级码 G101');

    await auth.login(serverUrl, code, password);
    detail.push(`login=${auth.user?.name ?? '-'}`);
    detail.push(`classSession=${auth.isClassSession}`);

    // 进入主布局（后续的侧边栏点击测试依赖布局已挂载）
    const { router } = await import('../router/index.js');
    await router.push('/schedule');
    const layoutMounted = await waitUntil(() => Boolean(document.querySelector('.el-menu-item')), 5000);
    detail.push(`layout=${layoutMounted}`);

    await appStore.init(serverUrl);
    detail.push(`reachable=${appStore.serverReachable}`);

    const [classes, initialHomeworks, initialNotifications, grades] = await Promise.all([
      api.classApi.list(),
      api.homeworkApi.list(),
      api.notificationApi.list(),
      api.gradeApi.my(),
    ]);

    /**
     * 自检**不允许依赖演示种子数据**：管理员随时可能清空业务数据
     * （例如"删掉服务端所有作业和通知"），此时这几条联网断言不能变成"数据被清空就失败"。
     * 因此列表为空时用教师账号造一条**本次自检专用**的作业/通知，收尾在 sessionCleanup 里删除。
     */
    let homeworks = initialHomeworks;
    let notifications = initialNotifications;
    if (homeworks.length === 0 || notifications.length === 0) {
      const seeded = await seedSmokeContent(auth.classId ?? null, {
        homework: homeworks.length === 0,
        notification: notifications.length === 0,
      });
      detail.push(`自建数据(${seeded.detail})`);
      if (seeded.ok) {
        [homeworks, notifications] = await Promise.all([api.homeworkApi.list(), api.notificationApi.list()]);
      }
    }

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

/**
 * 冒烟自检 6（需后端在线）：ClassIsland 风格"今天"时间轴。
 *
 * 造三节覆盖今天的课（已结束 / 正在上 / 即将开始），切到课表页读取 DOM，
 * 断言：时间轴渲染出卡片、正在上的那张是"进行中"卡片并带倒计时与进度条、
 * "已结束"/"下一节"标记存在、大时钟在走。用后删除探针课表。
 */
export async function scheduleTimelineSelfTest(): Promise<SmokeCheckResult> {
  const [{ useAuthStore }, { router }] = await Promise.all([
    import('../stores/auth.js'),
    import('../router/index.js'),
  ]);
  const auth = useAuthStore();
  const serverUrl = 'http://127.0.0.1:4000';
  const classId = auth.classId ?? null;
  if (!classId) return { ok: false, detail: '当前学生没有班级，无法构造课表' };

  const toHHmm = (minutes: number): string => {
    const clamped = Math.min(23 * 60 + 59, Math.max(0, minutes));
    return `${String(Math.floor(clamped / 60)).padStart(2, '0')}:${String(clamped % 60).padStart(2, '0')}`;
  };

  const created: string[] = [];
  const failures: string[] = [];
  let teacherToken = '';

  try {
    const login = await fetch(`${serverUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'teacher1', password: 'teacher123' }),
    }).then((response) => response.json());
    teacherToken = login?.data?.token ?? '';
    if (!teacherToken) return { ok: false, detail: '教师登录失败' };

    const courses = await fetch(`${serverUrl}/api/courses?classId=${classId}`, {
      headers: { authorization: `Bearer ${teacherToken}` },
    }).then((response) => response.json());
    const courseId = courses?.data?.[0]?.id;
    if (!courseId) return { ok: false, detail: '该班级没有课程，无法构造课表' };

    const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();
    const dayOfWeek = new Date().getDay() === 0 ? 7 : new Date().getDay();
    const probes = [
      { start: toHHmm(nowMinutes - 180), end: toHHmm(nowMinutes - 120), location: '时间轴自检 · 已结束' },
      { start: toHHmm(nowMinutes - 20), end: toHHmm(nowMinutes + 25), location: '时间轴自检 · 正在上课' },
      { start: toHHmm(nowMinutes + 60), end: toHHmm(nowMinutes + 105), location: '时间轴自检 · 下一节' },
      // 深夜/凌晨时相对时间会越过 23:59 / 00:00，被夹紧后 start >= end（服务端 422）。
      // 这种探针构造不出来就跳过，"下一节"的断言按实际创建数量放宽。
    ].filter((probe) => probe.start < probe.end);
    for (const probe of probes) {
      const response = await fetch(`${serverUrl}/api/schedules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${teacherToken}` },
        body: JSON.stringify({
          classId,
          courseId,
          dayOfWeek,
          startTime: probe.start,
          endTime: probe.end,
          weekStart: 1,
          weekEnd: 30,
          location: probe.location,
        }),
      });
      const payload = await response.json().catch(() => null);
      const id = payload?.data?.id;
      if (id) created.push(id);
      // 记录失败原因（限流 429 / 时间非法 400 等），否则只看到一个"2/3"没法排查
      else {
        failures.push(
          `${probe.start}-${probe.end} status=${response.status} ${payload?.message ?? ''}`.trim(),
        );
      }
    }
    if (created.length < probes.length) {
      return {
        ok: false,
        detail: `探针课表创建失败（${created.length}/${probes.length}）${failures.length > 0 ? `：${failures.join('；')}` : ''}`,
      };
    }

    await router.push('/schedule');

    let dom: {
      count: number;
      hasCurrent: boolean;
      currentText: string;
      hasProgress: boolean;
      clock: string;
      headline: string;
      tags: { state: string; text: string }[];
    } | null = null;
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const items = Array.from(document.querySelectorAll('.timeline-item'));
      const current = document.querySelector('.timeline-item.is-current');
      const snapshot = {
        count: items.length,
        hasCurrent: Boolean(current),
        currentText: (current?.textContent ?? '').replace(/\s+/g, ' ').trim(),
        hasProgress: Boolean(current?.querySelector('.lesson-progress')),
        clock: document.querySelector('.clock-main')?.textContent?.trim() ?? '',
        headline: document.querySelector('.status-title')?.textContent?.trim() ?? '',
        tags: items.map((node) => ({
          state: node.getAttribute('data-state') ?? '',
          text: (node.textContent ?? '').replace(/\s+/g, ' ').trim(),
        })),
      };
      if (snapshot.hasCurrent && snapshot.count >= probes.length) {
        dom = snapshot;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    if (!dom) return { ok: false, detail: '时间轴未渲染出"进行中"卡片' };

    const hasPast = dom.tags.some((tag) => tag.state === 'past' && tag.text.includes('已结束'));
    const hasNext = dom.tags.some((tag) => tag.state === 'next' && tag.text.includes('下一节'));
    const countdown = /距下课\s*\d+/.test(dom.currentText) || dom.currentText.includes('即将下课');
    // 深夜/凌晨可能只构造出 2 个探针（"下一节"跨过 23:59），此时不要求存在该卡片
    const expectNextProbe = probes.length >= 3;
    const ok =
      dom.count >= probes.length &&
      dom.hasCurrent &&
      dom.hasProgress &&
      countdown &&
      hasPast &&
      (!expectNextProbe || hasNext) &&
      /^\d{2}:\d{2}$/.test(dom.clock);

    return {
      ok,
      detail:
        `卡片=${dom.count} 进行中=${dom.hasCurrent} 进度条=${dom.hasProgress} 倒计时=${countdown} ` +
        `已结束=${hasPast} 下一节=${hasNext} 大时钟=${dom.clock} 摘要="${dom.headline}"` +
        // 失败时能看出"到底渲染了哪几节、各自什么状态"，否则只看到"已结束=false"无法定位
        ` 卡片状态=[${dom.tags.map((tag) => `${tag.state}:${tag.text.slice(0, 24)}`).join(' | ')}]`,
    };
  } catch (error) {
    return { ok: false, detail: `时间轴自检异常：${error instanceof Error ? error.message : String(error)}` };
  } finally {
    for (const id of created) {
      await fetch(`${serverUrl}/api/schedules/${id}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${teacherToken}` },
      }).catch(() => undefined);
    }
  }
}
/**
 * 冒烟自检 8（需后端在线）：作业看板**全屏自适应**。
 *
 * 用户反馈"全屏模式没有自适应"：点开全屏后卡片挤在左上角、内容显示不全。
 * 这里走真实界面链路：进入作业页 → 切到「看板」→ 点「全屏看板」→
 * 断言 ①布局宽度铺满视口（列数由算法注入 `--board-cols`）②缩放后可视底部不超出屏幕（无需滚动）。
 */
export async function homeworkBoardSelfTest(): Promise<SmokeCheckResult> {
  const { router } = await import('../router/index.js');
  try {
    await router.push('/homeworks');
    if (!(await waitUntil(() => Boolean(document.querySelector('.homework-page')), 6000))) {
      return { ok: false, detail: '作业页未挂载' };
    }

    // 必须是「看板」模式（列表模式没有全屏看板入口）
    const boardTab = Array.from(document.querySelectorAll('.el-radio-button')).find((node) =>
      (node.textContent ?? '').includes('看板'),
    );
    if (!(boardTab instanceof HTMLElement)) return { ok: false, detail: '找不到「看板」切换按钮' };
    boardTab.click();
    await waitUntil(() => Boolean(document.querySelector('.board-config')), 3000);

    // 今天可能恰好没有作业：先关掉「只看今天」，保证看板一定有卡片（断言才有意义）
    if (!document.querySelector('.board-host')) {
      const todaySwitch = document.querySelector('.page-header .el-switch');
      if (todaySwitch instanceof HTMLElement) todaySwitch.click();
    }
    const hasBoard = await waitUntil(() => Boolean(document.querySelector('.board-host')), 4000);

    const fullscreenButton = Array.from(document.querySelectorAll('button')).find((node) =>
      (node.textContent ?? '').includes('全屏看板'),
    );
    if (!(fullscreenButton instanceof HTMLElement)) return { ok: false, detail: '找不到「全屏看板」按钮' };
    fullscreenButton.click();

    const dialogReady = await waitUntil(
      () => Boolean(document.querySelector('.board-fullscreen .board-lg')),
      6000,
    );
    if (!dialogReady) return { ok: false, detail: '全屏看板弹窗未出现' };

    // 等自适应轮询跑完（最多 20 次 × 60ms）
    await new Promise((resolve) => setTimeout(resolve, 1600));

    const board = document.querySelector('.board-fullscreen .board-lg');
    const host = document.querySelector('.board-fullscreen .board-host-lg');
    if (!(board instanceof HTMLElement) || !(host instanceof HTMLElement)) {
      return { ok: false, detail: '全屏看板容器缺失' };
    }
    const rect = board.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const layoutWidth = board.offsetWidth;
    const columns = Number(board.style.getPropertyValue('--board-cols') || 0);
    const cards = board.querySelectorAll('.board-card').length;
    const scale = Number((getComputedStyle(board).transform.match(/matrix\(([-\d.]+)/) ?? [])[1] ?? 1);

    const fillsWidth = layoutWidth >= viewportWidth * 0.9;
    const fitsScreen = rect.bottom <= viewportHeight + 2 && rect.width <= viewportWidth + 2;

    // 第二阶段：模拟"科目很多"（真实班级看板常有 5~8 个科目）。
    // 克隆卡片到 6 张 → 触发 resize 让自适应算法重算 → 断言列数自动变多且仍然铺满、不溢出。
    let manyCards = '';
    let manyOk = false;
    const sample = board.querySelector('.board-card');
    if (sample instanceof HTMLElement) {
      while (board.querySelectorAll('.board-card').length < 6) {
        const clone = sample.cloneNode(true) as HTMLElement;
        clone.setAttribute('data-smoke-filler', '1');
        board.appendChild(clone);
      }
      window.dispatchEvent(new Event('resize'));
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const cardsMany = board.querySelectorAll('.board-card').length;
      const columnsMany = Number(board.style.getPropertyValue('--board-cols') || 0);
      const layoutWidthMany = board.offsetWidth;
      const rectMany = board.getBoundingClientRect();
      manyOk =
        cardsMany === 6 &&
        columnsMany >= 2 &&
        columnsMany <= cardsMany &&
        layoutWidthMany >= viewportWidth * 0.9 &&
        rectMany.bottom <= viewportHeight + 2;
      manyCards =
        `多科目：卡片=${cardsMany} 列数=${columnsMany} 排版宽=${layoutWidthMany} ` +
        `可视底=${Math.round(rectMany.bottom)} 通过=${manyOk}`;
    }

    const closeButton = document.querySelector('.board-fullscreen .el-dialog__headerbtn');
    if (closeButton instanceof HTMLElement) closeButton.click();

    return {
      ok: hasBoard && cards > 0 && columns >= 1 && columns <= cards && fillsWidth && fitsScreen && manyOk,
      detail:
        `卡片=${cards} 列数=${columns} 缩放=${Number.isFinite(scale) ? scale.toFixed(3) : '-'} ` +
        `排版宽=${layoutWidth}（视口宽=${viewportWidth}）可视底=${Math.round(rect.bottom)}（视口高=${viewportHeight}） ` +
        `铺满宽=${fillsWidth} 不超出屏幕=${fitsScreen}；${manyCards}`,
    };
  } catch (error) {
    return {
      ok: false,
      detail: `看板自适应自检异常：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** 冒烟收尾：删除自检临时数据 → 断开实时通道 → 退出登录，保证下次冒烟从登录页开始 */
export async function sessionCleanup(): Promise<SmokeCheckResult> {
  const [{ useAuthStore }, { useRealtimeStore }] = await Promise.all([
    import('../stores/auth.js'),
    import('../stores/realtime.js'),
  ]);
  try {
    const cleaned = await cleanupTemporaryContent();
    useRealtimeStore().disconnect();
    await useAuthStore().logout();
    return { ok: true, detail: `已断开实时通道并清理登录态${cleaned ? `；${cleaned}` : ''}` };
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
    scheduleTimelineSelfTest,
    homeworkBoardSelfTest,
    sessionCleanup,
  };
}
