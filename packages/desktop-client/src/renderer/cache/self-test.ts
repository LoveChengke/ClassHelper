import { cacheGet, cacheRemove, cacheSet, cacheStats } from './db.js';
import { fetchWithCache } from './index.js';

export interface SmokeCheckResult {
  ok: boolean;
  detail: string;
}

/**
 * 冒烟用的教师凭据：**由 preload 从环境变量注入，不写死在代码里**。
 *
 * 本文件会进渲染进程产物（`dist/renderer/assets/*.js`）→ `app.asar` → 每台学生机，
 * 而 asar 可以直接解包。因此任何口令字面量都不能留在这里；
 * 凭据由 `scripts/smoke.mjs` / `scripts/verify-packaged.mjs` 通过环境变量提供
 * （见 `main/smoke.ts` 顶部关于 app.asar 的完整说明）。
 */
let smokeTeacherCredentials: { username: string; password: string } = { username: '', password: '' };

/** 由 main.ts 在注册冒烟钩子时注入（来源：ELECTRON_SMOKE_USER / ELECTRON_SMOKE_PASSWORD） */
export function setSmokeTeacherCredentials(next: { username: string; password: string }): void {
  smokeTeacherCredentials = {
    username: next?.username ?? '',
    password: next?.password ?? '',
  };
}

/** 教师登录请求体；未注入凭据时返回 null（调用方据此跳过并说明原因） */
function teacherLoginBody(): { username: string; password: string } | null {
  return smokeTeacherCredentials.username && smokeTeacherCredentials.password
    ? { username: smokeTeacherCredentials.username, password: smokeTeacherCredentials.password }
    : null;
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

/** 侧边栏菜单与期望路由的对应关系（按显示文案匹配；侧边栏是「分组 + 子菜单」结构） */
const EXPECTED_MENU: Array<{ label: string; path: string }> = [
  { label: '课表', path: '/schedule' },
  { label: '作业', path: '/homeworks' },
  { label: '通知', path: '/notifications' },
  { label: '成绩', path: '/grades' },
  /** 设置组的代表子项：设置入口改成分组后，用「通用」验证设置子页导航可用 */
  { label: '通用', path: '/settings/general' },
];

/**
 * 一级菜单项：2026-10-05 起「学习」分组已拆掉，课表/作业/通知/成绩**直接铺在侧栏一级**。
 * 下面的结构自检会确认它们真的不在任何 `el-sub-menu` 里。
 */
const PRIMARY_MENU_ITEMS = ['课表', '作业', '通知', '成绩'];

/** 分组标题（el-sub-menu）与应包含的子项，点击分组展开后再点子项。设置组自成一类，保留分组 */
const MENU_GROUPS: Array<{ title: string; labels: string[] }> = [
  { title: '设置', labels: ['通用', '外观', '灵动岛', '提醒', '账号', '关于'] },
];

/**
 * 冒烟自检 3：侧边栏点击导航（分组结构版）。
 * 先点分组标题展开，再逐个点击子项，验证每次点击后路由与视图都发生切换 ——
 * 这是"点击左侧边栏没反应"这类问题的回归测试（侧边栏改为「学习/设置」分组后重写）。
 */
export async function layoutNavigationSelfTest(): Promise<SmokeCheckResult> {
  const { router } = await import('../router/index.js');

  // 按**文案那一层 span 的完整文本**匹配，而不是整项 textContent：
  // "通知"项里还有一个未读红点徽标（sup），整项 textContent 会变成 "2通知"，
  // 用 startsWith 匹配就会误报"菜单项缺失"（历史失败原因）。
  const findByLabel = (selector: string, label: string): HTMLElement | undefined =>
    (Array.from(document.querySelectorAll(selector)) as HTMLElement[]).find((element) =>
      Array.from(element.querySelectorAll('span')).some((span) => (span.textContent ?? '').trim() === label),
    );
  const findMenuItem = (label: string): HTMLElement | undefined => findByLabel('.el-menu-item', label);
  const findGroupTitle = (title: string): HTMLElement | undefined =>
    findByLabel('.el-sub-menu__title', title);

  if (!findGroupTitle('设置')) {
    return { ok: false, detail: '侧边栏「设置」分组未渲染（当前不在主布局或未登录）' };
  }
  const missingPrimary = PRIMARY_MENU_ITEMS.filter((label) => !findMenuItem(label));
  if (missingPrimary.length > 0) {
    return { ok: false, detail: `侧边栏缺少一级项：${missingPrimary.join('、')}` };
  }

  const visited: string[] = [];
  const failures: string[] = [];

  // 展开分组：默认只展开"当前路由所在分组"，其它组需要先点开。
  // 判据用"子项是否可见"而不是"盲点一次标题" —— 标题点击是 toggle，
  // 对已经展开的组再点一下会把它**收起**，后续点不到子项。
  const isVisible = (element: HTMLElement | undefined): boolean =>
    Boolean(element && element.offsetParent !== null);
  for (const group of MENU_GROUPS) {
    const firstItem = findMenuItem(group.labels[0] ?? '');
    if (!isVisible(firstItem)) {
      findGroupTitle(group.title)?.click();
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  // 结构自检：
  //   ① 一级项必须**真的在一级** —— 不能还挂在某个 el-sub-menu 里（用户要求把"学习"拆掉）；
  //   ② 分组各自应包含全部子项
  for (const label of PRIMARY_MENU_ITEMS) {
    const element = findMenuItem(label);
    if (element?.closest('.el-sub-menu')) failures.push(`${label}(仍挂在分组里，应在一级)`);
  }
  for (const group of MENU_GROUPS) {
    for (const label of group.labels) {
      if (!findMenuItem(label)) failures.push(`${group.title}组缺少子项 ${label}`);
    }
  }

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
    // 凭据由环境变量注入（理由见文件顶部）：没给就明确跳过，而不是拿种子账号兜底
    const loginBody = teacherLoginBody();
    if (!loginBody) {
      return {
        ok: false,
        detail: '未提供冒烟教师凭据（ELECTRON_SMOKE_USER / ELECTRON_SMOKE_PASSWORD），无法自建测试数据',
      };
    }
    const login = await fetch(`${serverUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(loginBody),
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
    // ClassHelper 班级端已改为「班级账号」登录：凭据由 scripts/smoke.mjs 通过管理端接口准备并传入。
    // 这里**不再回退到种子班级码**（G101/123456 也是真实可用的登录凭据，不能写进安装包）：
    // 没有凭据就明确跳过，由 scripts/smoke.mjs 打印"未能准备班级账号"。
    const code = credentials?.code ?? '';
    const password = credentials?.password ?? '';
    if (!code) {
      return {
        ok: false,
        detail:
          '未收到班级凭据（ELECTRON_SMOKE_CLASS_CODE / ELECTRON_SMOKE_CLASS_PASSWORD），已跳过联网集成自检',
      };
    }

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
    const loginBody = teacherLoginBody();
    if (!loginBody) {
      return {
        ok: false,
        detail: '未提供冒烟教师凭据（ELECTRON_SMOKE_USER / ELECTRON_SMOKE_PASSWORD），无法投递通知',
      };
    }
    const login = await fetch(`${serverUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(loginBody),
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
        // 普通优先级：冒烟客户端登录的是**临时班级**（无课表 → 判定不在上课），
        // 普通通知也会立刻弹出胶囊，链路断言与真实上课时段无关。
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
    const loginBody = teacherLoginBody();
    if (!loginBody) {
      return {
        ok: false,
        detail: '未提供冒烟教师凭据（ELECTRON_SMOKE_USER / ELECTRON_SMOKE_PASSWORD），无法构造课表',
      };
    }
    const login = await fetch(`${serverUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(loginBody),
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

    // 今天可能恰好没有作业：切到「最近一个有作业的日期」保证看板一定有卡片（断言才有意义）。
    // 按天查看支持 ?date=YYYY-MM-DD 深链，切天不需要去操作日期选择器。
    // 注意判据是「看板里没有卡片」而不是「没有 board-host 容器」——空看板照样渲染容器，
    // 拿容器当判据会导致切日期的兜底永远不触发（今天的日期没作业时看板必然为空）。
    if (!document.querySelector('.board-card')) {
      const [{ homeworkApi }, { useAuthStore }] = await Promise.all([
        import('../api/index.js'),
        import('../stores/auth.js'),
      ]);
      const classId = useAuthStore().classId ?? undefined;
      const days = await homeworkApi.days({ classId }).catch(() => ({ days: [] }));
      const latest = days.days.length > 0 ? days.days[days.days.length - 1].date : null;
      if (latest) {
        await router.push({ path: '/homeworks', query: { date: latest } });
      }
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

/**
 * 冒烟自检（不需要后端）：**本机录入的作业不再上灵动岛**（用户要求）。
 *
 * 场景：教室机器上录完作业，服务端照样广播 `homework:new`，但"自己通知自己"没有意义。
 * 判定按**内容指纹 + id**（发起请求前就登记，避免"广播晚于响应"漏判），因此这里两条都要验：
 * 1) 登记过的这条：投递后灵动岛状态不变；
 * 2) 没登记过的同形作业（别班/别的标题）：照常上岛。
 */
export async function islandHomeworkSuppressionCheck(): Promise<SmokeCheckResult> {
  const [{ markHomeworkCreatedLocally, isLocalHomework, pushHomeworkToIsland }, { useAuthStore }] =
    await Promise.all([import('../island/bridge.js'), import('../stores/auth.js')]);
  try {
    const classId = useAuthStore().classId ?? 'smoke-class';
    const assignDate = '2030-01-01';
    const draft = {
      id: 'smoke-homework-suppressed',
      classId,
      title: '本机录入的作业',
      content: '这条不应该弹上岛',
      assignDate,
    };
    markHomeworkCreatedLocally(draft);
    const recognized = isLocalHomework(draft);
    // 同 id、同内容 → 必须认出来；换个标题 → 不算本机录入
    const recognizedByFingerprint = isLocalHomework({ ...draft, id: '' });
    const foreign = isLocalHomework({ ...draft, id: 'other', title: '别的作业' });

    const before = await window.desktop?.islandGetState?.();
    pushHomeworkToIsland({
      ...draft,
      courseId: null,
      attachmentUrl: null,
      createdBy: '',
      createdAt: new Date().toISOString(),
    } as never);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const after = await window.desktop?.islandGetState?.();
    const untouched =
      (before?.active?.id ?? null) === (after?.active?.id ?? null) &&
      (before?.queued.length ?? 0) === (after?.queued.length ?? 0);

    return {
      ok: recognized && recognizedByFingerprint && !foreign && untouched,
      detail:
        `按 id 认出=${recognized} 按内容指纹认出=${recognizedByFingerprint} 别的作业误判=${foreign} ` +
        `投递后灵动岛未变=${untouched}`,
    };
  } catch (error) {
    return {
      ok: false,
      detail: `本机作业不上岛自检异常：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 冒烟自检（不需要后端）：**初次启动引导**。
 *
 * 冒烟每次都用全新配置目录（等于"首次启动"），因此引导必须自动弹出；
 * 这里真实点击把它一步步走完，断言：遮罩关闭 + `onboardingDone` 已写入配置。
 * 关闭判据用「元素从 DOM 消失」——引导是 v-if 自绘遮罩（特意不用 el-dialog，
 * 避免"关闭后 DOM 残留在文档里"的误报，见 AGENTS §7 第 22 条）。
 */
export async function onboardingSelfTest(): Promise<SmokeCheckResult> {
  try {
    // 引导在启动后延迟 ~400ms 弹出，这里轮询等它出现
    const appearDeadline = Date.now() + 5000;
    while (Date.now() < appearDeadline && !document.querySelector('.onboarding-welcome')) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!document.querySelector('.onboarding-welcome')) {
      const config = await window.desktop?.getConfig?.();
      return {
        ok: false,
        detail: `初次启动引导未自动出现（onboardingDone=${config?.onboardingDone ?? '-'}）`,
      };
    }

    // 逐页「下一步」到最后一页再点「开始使用」（按钮由 data-action 标识，不依赖文案）
    const clicks: string[] = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const action = document.querySelector('.onboarding-welcome [data-action="finish"]') ? 'finish' : 'next';
      const button = document.querySelector<HTMLElement>(`.onboarding-welcome [data-action="${action}"]`);
      if (!button) break;
      clicks.push(action);
      button.click();
      if (action === 'finish') break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    let closed = !document.querySelector('.onboarding-welcome');
    const closeDeadline = Date.now() + 2000;
    while (Date.now() < closeDeadline && !closed) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      closed = !document.querySelector('.onboarding-welcome');
    }

    const config = await window.desktop?.getConfig?.();
    const done = config?.onboardingDone === true;
    return {
      ok: closed && done,
      detail: `步骤点击=[${clicks.join(',')}] 已关闭=${closed} onboardingDone=${config?.onboardingDone ?? '-'}`,
    };
  } catch (error) {
    return {
      ok: false,
      detail: `引导自检异常：${error instanceof Error ? error.message : String(error)}`,
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

/**
 * 冒烟自检（不需要后端）：主界面外观件 —— 主题切换与侧边栏折叠。
 * 走**真实 DOM 点击**（顶栏日月按钮 / 汉堡按钮），验证：
 * 1) html.dark 类与 store 同步翻转，且写入主进程配置；
 * 2) 侧边栏折叠后 el-menu 进入 collapse 态、宽度收窄，配置同步；
 * 结束时把主题还原为初始值（后续截图/几何用例依赖固定主题）。
 */
export async function layoutChromeSelfTest(): Promise<SmokeCheckResult> {
  try {
    const { router } = await import('../router/index.js');
    await router.push('/schedule');
    if (!(await waitUntil(() => Boolean(document.querySelector('[data-test="theme-toggle"]')), 6000))) {
      return { ok: false, detail: '主布局未渲染（找不到主题切换按钮）' };
    }

    const clickToggle = (selector: string): boolean => {
      const node = document.querySelector<HTMLElement>(selector);
      if (!node) return false;
      node.click();
      return true;
    };

    // 1) 主题：真实点击日月按钮 → html.dark 翻转 → 配置落盘
    const initialDark = document.documentElement.classList.contains('dark');
    if (!clickToggle('[data-test="theme-toggle"]')) return { ok: false, detail: '主题按钮点击失败' };
    const flipped = await waitUntil(
      () => document.documentElement.classList.contains('dark') !== initialDark,
      2500,
    );
    const flippedDark = document.documentElement.classList.contains('dark');
    const configAfterFlip = await window.desktop?.getConfig?.();
    const themePersisted = configAfterFlip?.theme === (flippedDark ? 'dark' : 'light');

    // 1.5) 顶栏右侧必须水平对齐（用户反馈"深色模式没对齐"，两种主题其实都偏）。
    //   Element Plus 给按钮的是 `vertical-align:middle`、给下拉容器的是 `vertical-align:top`，
    //   容器不是 flex 的话两个 inline-level 子元素会各按各的规则落位，错开几像素。
    const centerYOf = (element: Element | null | undefined): number | null => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return rect.height > 0 ? rect.top + rect.height / 2 : null;
    };
    const themeToggleY = centerYOf(document.querySelector('[data-test="theme-toggle"]'));
    const userChipY = centerYOf(document.querySelector('.user-chip'));
    const headerCenterDelta =
      themeToggleY !== null && userChipY !== null ? Math.abs(themeToggleY - userChipY) : null;
    const headerAligned = headerCenterDelta !== null && headerCenterDelta <= 1.5;

    // 2) 侧边栏：点汉堡折叠 → 图标导轨态 + 宽度收窄（是动画，要等它走完）→ 配置落盘 → 再展开还原
    const asideBefore = document.querySelector<HTMLElement>('.aside.ch-nav');
    const widthBefore = asideBefore?.offsetWidth ?? 0;
    // 2.0) 折叠必须是**动画**而不是瞬切（用户要求"重写菜单的动画"）。
    //      不去抓中间帧（时序敏感），直接断言侧栏上挂着 width 的过渡 —— 确定性的。
    const asideComputed = asideBefore ? getComputedStyle(asideBefore) : null;
    const asideTransitionProperty = asideComputed?.transitionProperty ?? '';
    const asideTransitionSeconds = asideComputed ? Number.parseFloat(asideComputed.transitionDuration) : 0;
    const widthAnimated =
      asideTransitionProperty.includes('width') &&
      Number.isFinite(asideTransitionSeconds) &&
      asideTransitionSeconds > 0.05;
    if (!clickToggle('[data-test="sidebar-toggle"]')) return { ok: false, detail: '汉堡按钮点击失败' };
    /*
     * 判据是「宽度收拢到**稳态**」而不是「宽度小于 80」。
     *
     * 折叠的目标宽度是 64px（ClientLayout 的 `:width="ui.sidebarCollapsed ? '64px' : '200px'"`），
     * 而宽度与菜单项内边距是同一条过渡在驱动 —— 只等「≤80」会在动画还剩几十毫秒时就往下走，
     * 下面量图标中心时内边距仍在变化，量到的是中间帧而非稳态（实测出现过 0.5px 与 2.3px 两个值，
     * 全看当时机器有多忙）。等它真正到位之后再量，这条断言才是它想表达的"折叠后同列"。
     */
    const collapsed = await waitUntil(() => {
      const aside = document.querySelector<HTMLElement>('.aside.ch-nav');
      return Boolean(aside?.classList.contains('is-collapsed')) && (aside?.offsetWidth ?? 999) <= 65;
    }, 4000);
    const asideAfter = document.querySelector<HTMLElement>('.aside.ch-nav');
    const widthAfter = asideAfter?.offsetWidth ?? 0;
    const configAfterCollapse = await window.desktop?.getConfig?.();
    const collapsePersisted = configAfterCollapse?.sidebarCollapsed === true;

    // 2.1) 折叠态的两条观感硬要求（用户反馈回归）：
    //   a) 菜单里不允许残留任何**可见**的文字。折叠实现是"文字宽度被 flex 压到 0 + overflow:hidden
    //      裁掉 + opacity 归零"（`display:none` 无法过渡，用不了），所以判据是"看得见"
    //      —— 有宽度且未透明 —— 而不是"根本没参与布局"；
    //   b) 折叠后的图标必须与顶部汉堡按钮在同一竖列（中心 x 相差 ≤ 2px）。
    //      分组标题里还有个绝对定位的折叠箭头，它同样带 el-icon 类但已淡出，量它没有意义，排除。
    const centerXOf = (element: Element | null | undefined): number | null => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 ? rect.left + rect.width / 2 : null;
    };
    const leftoverText: string[] = [];
    for (const node of Array.from(
      document.querySelectorAll('.aside .el-menu-item > span, .aside .el-sub-menu__title > span'),
    )) {
      const element = node as HTMLElement;
      if (element.classList.contains('menu-icon-slot')) continue;
      const text = (element.textContent ?? '').trim();
      if (!text || element.getClientRects().length === 0) continue;
      const rect = element.getBoundingClientRect();
      const opacity = Number(getComputedStyle(element).opacity || '1');
      if (rect.width >= 1 && opacity > 0.05) leftoverText.push(`可见:${text.slice(0, 6)}`);
    }
    const toggleCenter = centerXOf(document.querySelector('[data-test="sidebar-toggle"]'));
    const iconCenters = Array.from(
      document.querySelectorAll(
        '.aside.is-collapsed .menu-icon-slot .el-icon, ' +
          '.aside.is-collapsed .el-sub-menu__title > .el-icon:not([class*="icon-arrow"])',
      ),
    ).map((node) => centerXOf(node));
    const iconDeltas = iconCenters
      .filter((value): value is number => value !== null && toggleCenter !== null)
      .map((value) => Math.abs(value - (toggleCenter as number)));
    const iconsAligned = iconDeltas.length > 0 && Math.max(...iconDeltas) <= 2;

    // 2.2) 导轨必须"一眼看全"：先把设置组展开（11 行图标 = 最坏情况），再断言菜单区没有纵向溢出。
    //      折叠态页脚必须把**高度**也收成 0 —— 只淡出不留高度的话，那 ~70px 会把最后两个图标
    //      顶出可视区，用户就得上下滑动（反馈原话："菜单图标无法完全显示需要上下滑动"）。
    const settingsItem = Array.from(
      document.querySelectorAll<HTMLElement>('.aside .el-sub-menu .el-menu-item'),
    ).find((element) =>
      Array.from(element.querySelectorAll('span')).some((span) => (span.textContent ?? '').trim() === '通用'),
    );
    const submenuOpen = (): boolean => Boolean(settingsItem && settingsItem.offsetParent !== null);
    if (!submenuOpen()) {
      // el-sub-menu__title 的点击是 **toggle**：先判"子项是否可见"再点，
      // 盲点一次会把已展开的组收起来（AGENTS §5 第 49 条）
      document.querySelector<HTMLElement>('.aside .el-sub-menu__title')?.click();
      await waitUntil(() => submenuOpen(), 2000);
    }
    const railMenu = document.querySelector<HTMLElement>('.aside .menu');
    const railOverflowPx = railMenu ? railMenu.scrollHeight - railMenu.clientHeight : Number.NaN;
    const railFits = Number.isFinite(railOverflowPx) && railOverflowPx <= 1;

    clickToggle('[data-test="sidebar-toggle"]');
    // 展开同样是动画：等宽度回到 200 再继续，否则下面量页脚时侧栏还停在中间宽度
    const expandedBack = await waitUntil(() => {
      const aside = document.querySelector<HTMLElement>('.aside.ch-nav');
      return !aside?.classList.contains('is-collapsed') && (aside?.offsetWidth ?? 0) >= 190;
    }, 4000);

    // 3) 侧栏不溢出：菜单区自己滚动（.menu 有 min-height:0 + overflow-y:auto），
    //    底部「第 N 周 / 最近同步」始终留在窗口内 —— 窗口默认高 582px，
    //    在加这条结构性保证之前，两个分组全展开会把 footer 挤出屏幕（用户反馈）。
    const footer = document.querySelector<HTMLElement>('.aside-footer');
    const footerRect = footer?.getBoundingClientRect();
    const footerVisible =
      Boolean(footer && footer.offsetParent !== null) &&
      Boolean(footerRect && footerRect.bottom <= window.innerHeight + 1);

    // 3) 还原主题，避免影响后续用例
    clickToggle('[data-test="theme-toggle"]');
    await waitUntil(() => document.documentElement.classList.contains('dark') === initialDark, 2500);

    const ok =
      flipped &&
      themePersisted &&
      headerAligned &&
      widthAnimated &&
      collapsed &&
      collapsePersisted &&
      widthAfter < widthBefore &&
      widthAfter <= 80 &&
      expandedBack &&
      leftoverText.length === 0 &&
      iconsAligned &&
      railFits &&
      footerVisible;
    return {
      ok,
      detail:
        `主题翻转=${flipped} 落盘=${themePersisted}(${configAfterFlip?.theme ?? '-'}) ` +
        `顶栏对齐=${headerAligned}（中线差=${headerCenterDelta === null ? '-' : headerCenterDelta.toFixed(1)}px，要求 ≤1.5px） ` +
        `宽度过渡=${widthAnimated}(${asideTransitionProperty} ${asideTransitionSeconds}s) ` +
        `折叠=${collapsed} 宽度=${widthBefore}→${widthAfter} 展开还原=${expandedBack} 落盘=${collapsePersisted} ` +
        `文字残影=${leftoverText.length === 0 ? '无' : leftoverText.join(',')} ` +
        `图标与汉堡同列=${iconsAligned}（中心差=${iconDeltas.map((d) => d.toFixed(1)).join('/') || '-'}，要求 ≤2px） ` +
        `导轨无溢出=${railFits}（溢出=${Number.isFinite(railOverflowPx) ? `${railOverflowPx}px` : '-'}） ` +
        `侧栏底部可见=${footerVisible}`,
    };
  } catch (error) {
    return {
      ok: false,
      detail: `外观件自检异常：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 冒烟自检（不需要后端）：关于页（/settings/about）。
 * 断言页面渲染出标题与「鸣谢 / 诊断信息」区块，且 getAppInfo 返回了新增的 configPath
 * （诊断信息依赖它）。
 */
export async function aboutPageSelfTest(): Promise<SmokeCheckResult> {
  try {
    const { router } = await import('../router/index.js');
    await router.push('/settings/about');
    const rendered = await waitUntil(
      () => (document.querySelector('.page-title')?.textContent ?? '').includes('关于'),
      6000,
    );
    if (!rendered) return { ok: false, detail: '关于页未挂载' };

    const text = document.body.innerText.replace(/\s+/g, ' ');
    const hasThanks = text.includes('鸣谢');
    const hasDiagnostics = text.includes('诊断信息');
    const info = await window.desktop?.getAppInfo?.();
    const hasConfigPath = Boolean(info?.configPath);

    // 检查更新入口（新功能回归）：关于页要有这一块，且按钮可点。
    // 这里只断言"入口存在"——是否真有新版本取决于 GitHub，不该绑进冒烟（见 main/update.ts）
    const updateBlock = document.querySelector('[data-test="update-check"]');
    const updateButton = document.querySelector('[data-test="update-check-button"]');

    await router.push('/schedule');
    return {
      ok: hasThanks && hasDiagnostics && hasConfigPath && Boolean(updateBlock) && Boolean(updateButton),
      detail:
        `鸣谢=${hasThanks} 诊断=${hasDiagnostics} configPath=${hasConfigPath ? '有' : '无'} ` +
        `检查更新块=${updateBlock ? '有' : '无'} 按钮=${updateButton ? '有' : '无'}`,
    };
  } catch (error) {
    return {
      ok: false,
      detail: `关于页自检异常：${error instanceof Error ? error.message : String(error)}`,
    };
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
    islandHomeworkSuppressionCheck,
    onboardingSelfTest,
    layoutChromeSelfTest,
    aboutPageSelfTest,
    scheduleTimelineSelfTest,
    homeworkBoardSelfTest,
    sessionCleanup,
  };
}
