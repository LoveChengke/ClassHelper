import type { ActiveClassPlanWeekDto as ContractActiveClassPlanWeekDto } from '@classhelper/shared';
import { watch, type WatchStopHandle } from 'vue';
import {
  SOCKET_EVENTS,
  resolveClassStatus,
  type ClassPeriod,
  type HomeworkDto,
  type NotificationDto,
  type ScheduleDto,
} from '@classhelper/shared';
import { api } from '../api/http.js';
import { notificationApi } from '../api/index.js';
import { fetchWithCache } from '../cache/index.js';
import { getCacheScope } from '../cache/scope.js';
import { clearOfflineSince, readOfflineSince, useAppStore } from '../stores/app.js';
import { useAuthStore } from '../stores/auth.js';
import { useNotificationStore } from '../stores/notifications.js';
import { useRealtimeStore } from '../stores/realtime.js';

/**
 * 灵动岛桥接（渲染进程侧）。
 *
 * 职责：把"当前是否在上课时间段"这件事算出来并同步给主进程 ——
 * 主进程据此决定通知是"立即弹出"还是"上课期间隐藏、下课后自动弹出"。
 *
 * 判定完全基于本地缓存的课表（离线也能算），并每秒复算一次，
 * 因此下课后最多 1 秒内会自动弹出暂存的通知。
 */
const TICK_INTERVAL_MS = 1_000;
const REFRESH_INTERVAL_MS = 30_000;

let schedules: ScheduleDto[] = [];
let currentPeriod: ClassPeriod | null = null;
let inClass = false;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let stopWeekWatch: WatchStopHandle | null = null;
let scheduleRequest = 0;
let scheduleWeek = 1;

/** 供通知投递时读取：当前是否上课 + 本节课结束时间 */
export function getIslandClassContext(): { inClass: boolean; currentPeriodEnd: string | null } {
  return { inClass, currentPeriodEnd: currentPeriod?.endTime ?? null };
}

export function getIslandSchedules(): ScheduleDto[] {
  return schedules;
}

/** 主动刷新课表（课表变更事件触发） */
export async function refreshIslandSchedules(): Promise<void> {
  const appStore = useAppStore();
  const auth = useAuthStore();
  if (!auth.token) return;
  const scope = getCacheScope();
  const classId = auth.classId ?? undefined;
  const request = ++scheduleRequest;
  if (scope !== getCacheScope() || !auth.token || request !== scheduleRequest) return;
  const week = appStore.currentWeek;
  const result = await fetchWithCache<ScheduleDto[]>(
    'schedules',
    `week:${week}`,
    async () => {
      const data = (
        await api.get<ContractActiveClassPlanWeekDto>('/schedules/active-week', { classId, week })
      ).days.flatMap((day) => day.schedules);
      // 网络结果先上岛，IndexedDB 写入不再挡住可见内容；旧请求与切换账号的结果不得回写。
      if (scope !== getCacheScope() || request !== scheduleRequest || !auth.token)
        throw new Error('课表刷新已被新请求替代');
      schedules = data;
      scheduleWeek = week;
      recomputeClassState(true);
      return data;
    },
    [],
  );
  if (scope !== getCacheScope() || request !== scheduleRequest) return;
  if (result.error && !result.updatedAt) return;
  if (result.fromCache) {
    schedules = result.data;
    scheduleWeek = week;
    recomputeClassState(true);
  }
}

let sentDay = '';
function recomputeClassState(force = false): void {
  const day = new Date().toDateString();
  const appStore = useAppStore();
  const status = resolveClassStatus(schedules, new Date(), scheduleWeek);
  const nextInClass = status.inClass;
  const samePeriod =
    currentPeriod?.scheduleId === status.current?.scheduleId &&
    currentPeriod?.endTime === status.current?.endTime;
  currentPeriod = status.current;

  if (!force && day === sentDay && nextInClass === inClass && samePeriod) return;
  sentDay = day;
  inClass = nextInClass;

  window.desktop?.islandSetClassState({
    inClass,
    currentPeriodEnd: currentPeriod?.endTime ?? null,
    week: appStore.currentWeek,
    schedules: schedules.filter((s) => s.dayOfWeek === (new Date().getDay() || 7)),
  });
}

/** 把校园通知投递到灵动岛（由实时通道收到 notification:new 时调用） */
export function pushNotificationToIsland(notification: NotificationDto): void {
  window.desktop?.islandPush({
    notification: {
      id: notification.id,
      title: notification.title,
      content: notification.content,
      priority: notification.priority,
      createdAt: notification.createdAt,
      courseName: currentPeriod?.courseName ?? null,
      teacherName: notification.creator?.name ?? null,
      kind: 'notification',
    },
    context: getIslandClassContext(),
  });
}

/** 新作业上岛（homework:new）：胶囊提示"新作业"，点击展开看作业要求 */
export function pushHomeworkToIsland(homework: HomeworkDto): void {
  // 本机刚录入的作业不再上岛：教室机器上录作业的人就是眼前这台设备的主人，
  // 再弹一张"新作业"卡片纯属自己通知自己（用户反馈）。
  if (isLocalHomework(homework)) {
    return;
  }
  window.desktop?.islandPush({
    notification: {
      id: `homework-${homework.id}`,
      title: homework.title,
      content: homework.content?.trim() || '（老师没有填写作业说明）',
      priority: 'NORMAL',
      createdAt: homework.createdAt,
      courseName: homework.course?.name ?? null,
      teacherName: homework.creator?.name ?? null,
      kind: 'homework',
    },
    context: getIslandClassContext(),
  });
}

/* ------------------------------------------------------------ 本机录入的作业 */

/**
 * 本机刚录入的作业指纹。
 *
 * 为什么按指纹而不只按 id：`homework:new` 是服务端**先广播、后回响应**的，
 * 录入接口返回的 id 很可能比实时事件到得还晚 —— 只记 id 会漏掉"事件先到"的那一半，
 * 于是本机录的作业照样弹上岛。因此在发请求**之前**就按内容记一份指纹，
 * 回来后补记 id（覆盖事件晚到的情况）。指纹带 TTL，避免长期占用内存。
 */
const localHomeworkKeys = new Set<string>();
let localHomeworkKeysAt = 0;
const LOCAL_HOMEWORK_TTL_MS = 60_000;

/** 作业内容指纹：同一班、同一天、同标题同正文 = 就是本机刚录的那条 */
function homeworkFingerprint(homework: {
  classId?: string | null;
  title?: string | null;
  content?: string | null;
  assignDate?: string | null;
}): string {
  return [
    homework.classId ?? '',
    homework.assignDate ?? '',
    (homework.title ?? '').trim(),
    (homework.content ?? '').trim(),
  ].join('|');
}

/** 录入前/后登记"这条作业是本机录的"（id 可后补） */
export function markHomeworkCreatedLocally(homework: {
  id?: string | null;
  classId?: string | null;
  title?: string | null;
  content?: string | null;
  assignDate?: string | null;
}): void {
  const now = Date.now();
  if (now - localHomeworkKeysAt > LOCAL_HOMEWORK_TTL_MS) localHomeworkKeys.clear();
  localHomeworkKeysAt = now;
  localHomeworkKeys.add(homeworkFingerprint(homework));
  if (homework.id) localHomeworkKeys.add(homework.id);
}

/** 这条作业是不是本机刚录的（供投递前判定与冒烟验证） */
export function isLocalHomework(homework: {
  id?: string | null;
  classId?: string | null;
  title?: string | null;
  content?: string | null;
  assignDate?: string | null;
}): boolean {
  if (homework.id && localHomeworkKeys.has(homework.id)) return true;
  return localHomeworkKeys.has(homeworkFingerprint(homework));
}

/**
 * "叫人"上岛：紧急叫人（priority=URGENT）无视上课时段立即展开；
 * 普通叫人按普通通知处理（课间先显示胶囊、点击展开，上课时段只排队）。
 * 两种都带"叫人"类型（徽标/「收到」按钮/更大的展开卡）。
 */
export function pushCallToIsland(call: NotificationDto): void {
  window.desktop?.islandPush({
    notification: {
      id: call.id,
      title: call.title,
      content: call.content?.trim() || '老师正在等你，请尽快前往。',
      priority: call.priority,
      createdAt: call.createdAt,
      courseName: null,
      teacherName: call.creator?.name ?? null,
      kind: 'call',
      subtitle: '请尽快前往，收到后点「收到」',
    },
    context: getIslandClassContext(),
  });
}

/* ------------------------------------------------------------ 补弹离线期间收到的消息（需求 11） */

/**
 * 补弹条数上限。
 *
 * 灵动岛的多条通知列表默认只显示 `ISLAND_LIST_METRICS.defaultVisibleRows`（3）条 +
 * 「展开更多（还有 N 条）」。所以一条不补、和一次补十几条，都是同样的阅读体验 ——
 * 封顶 5 条 = 3 条可见 + 2 条藏在"展开更多"里，正好是打开就能读完的量；
 * 补太多只会让"展开更多"变成一个没有意义的按钮。
 */
const REPLAY_MAX_COUNT = 5;

/**
 * 上线后补弹「离线期间收到的消息」（需求 11）。
 *
 * 调用时机：`App.vue` 订阅 `useAppStore().onServerRecovered`，也就是**可达性由不可达变为可达**
 * 的那一刻（断网期间的实时通道是断的，那些通知既没弹过、也没进过用户的视野）。
 *
 * 数据来源复用既有的通知接口（`notificationApi.list({ unreadOnly: true })`）：
 * 客户端本来就是离线优先的（`fetchWithCache` 会把数据落 IndexedDB），**不为此新建数据源** ——
 * 补弹只需要"服务端现在有哪些未读"，而通知列表本来就是这个问题的答案。
 *
 * 实现上有四条约定：
 * 1. **没有离线起点就直接返回 0**（首次启动 / 一直在线）：离线起点只由
 *    `stores/app.ts` 在"由可达变不可达"的那一刻写入，没有它就说明这段时间根本没断过网，
 *    此时补弹等于把**历史未读**全弹一遍，那不是「离线期间收到的」。
 * 2. **只补离线起点之后创建的**（`createdAt > offlineSince`），并且在服务端排序之外再排一次
 *    **按时间升序**投递 —— 顺序投递才能让灵动岛的队列保持时间顺序。
 * 3. **取最近的 5 条**（升序列表的尾部）：断网一天可能积压几十条，取最早的那 5 条等于
 *    让用户先看最旧的、最新的反而被"展开更多"挡住。取最近的 5 条更符合"我刚错过了什么"。
 * 4. **推完就清掉离线起点**：同一次离线只补一次，否则每次可达性抖动都会重复弹同一批。
 *
 * @returns 实际补弹的条数（0 = 没补）
 */
export async function replayMissedNotifications(): Promise<number> {
  // 冒烟保护：`verify:desktop` / `verify:packaged` 有一条「灵动岛队列」的断言链
  // （100+ 条断言量的是卡片的条数、顺序、高度与"展开更多"的分页），
  // 冒烟脚本会反复断开/恢复网络，注入的合成通知与这里的补弹会互相打乱队列，
  // 让那些断言随机变红。冒烟模式下**直接跳过补弹**（也不动离线起点），
  // 补弹本身由人工/单元路径覆盖，不进冒烟。
  if (window.desktop?.smokeTest === true) return 0;

  const offlineSince = readOfflineSince();
  if (!offlineSince) return 0;
  const sinceMs = Date.parse(offlineSince);
  if (Number.isNaN(sinceMs)) {
    // 存储里是坏值（手工改过 / 旧版本写入格式不同）：清掉，别让它永远挡住补弹
    clearOfflineSince();
    return 0;
  }

  let unread: NotificationDto[];
  try {
    unread = await notificationApi.list({ unreadOnly: true });
  } catch {
    // 刚恢复就又断了（或服务端还没真正就绪）：保留离线起点，等下一次恢复再补
    return 0;
  }

  const missed = unread
    .filter((item) => {
      const at = Date.parse(item.createdAt);
      return !Number.isNaN(at) && at > sinceMs;
    })
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

  const picked = missed.slice(-REPLAY_MAX_COUNT);
  for (const item of picked) pushNotificationToIsland(item);

  // 无论补到几条都清掉：这一轮离线已经被处理过了
  clearOfflineSince();
  console.info(`[离线补弹] 补弹离线消息 ${picked.length} 条（离线起点 ${offlineSince}）`);
  return picked.length;
}

/**
 * 灵动岛点了"标为已读" → 在通知中心里也标记已读（并刷新未读红点）。
 * 由 App.vue 在挂载时订阅一次。
 */
export function subscribeIslandMarkRead(): void {
  window.desktop?.onIslandMarkRead?.((id) => {
    void (async () => {
      const store = useNotificationStore();
      try {
        await store.markRead(id);
      } catch {
        // 离线或通知已被删除：本地先记为已读，等下次同步纠正
        const target = store.items.find((item) => item.id === id);
        if (target) target.read = true;
      }
    })();
  });
}

/**
 * 灵动岛点了"标为已读"（多条通知的整批）→ 把这一批都在通知中心里标记已读。
 * 与单条版本同一套兜底：离线时先在本地记为已读。
 */
export function subscribeIslandMarkAllRead(): void {
  window.desktop?.onIslandMarkAllRead?.((ids) => {
    void (async () => {
      const store = useNotificationStore();
      await Promise.all(
        (ids ?? []).map(async (id) => {
          try {
            await store.markRead(id);
          } catch {
            const target = store.items.find((item) => item.id === id);
            if (target) target.read = true;
          }
        }),
      );
    })();
  });
}

/** 具名的课表变更处理器：匿名函数在停止时无法 off 掉，会随"登出→登录"越挂越多 */
function onScheduleUpdated(): void {
  // 教学周校正并行进行，课表变更不再等待另一个接口；周次改变由 watch 补取。
  void useAppStore()
    .refreshTerm(useAuthStore().classId ?? undefined)
    .catch(() => undefined);
  void refreshIslandSchedules().catch(() => undefined);
}

export function startIslandBridge(): void {
  if (tickTimer) return;
  stopWeekWatch = watch(
    () => useAppStore().currentWeek,
    () => {
      void refreshIslandSchedules();
    },
  );

  onScheduleUpdated();
  useRealtimeStore().on('__connected__', onScheduleUpdated);

  // 课表变更（教师改课）立即复算，避免"下课后不弹出"或"上课没隐藏"
  useRealtimeStore().on(SOCKET_EVENTS.scheduleUpdated, onScheduleUpdated);

  tickTimer = setInterval(() => recomputeClassState(), TICK_INTERVAL_MS);
  refreshTimer = setInterval(() => {
    onScheduleUpdated();
  }, REFRESH_INTERVAL_MS);
}

/**
 * 停止桥接：退出登录 / 切换账号时必须调用。
 *
 * 只清定时器是不够的：
 * - 订阅要 off，否则每次"登出 → 登录"都会多挂一份监听；
 * - 本地课表缓存要清空，否则登出后仍会按**上一个班**的课表继续给主进程下发"上课/下课"
 *   （灵动岛按陈旧课表隐藏或弹出），换班登录时第一轮刷新回来之前用的也是旧课表。
 */
export function stopIslandBridge(): void {
  if (tickTimer) clearInterval(tickTimer);
  if (refreshTimer) clearInterval(refreshTimer);
  tickTimer = null;
  refreshTimer = null;
  scheduleRequest += 1;
  stopWeekWatch?.();
  stopWeekWatch = null;

  useRealtimeStore().off(SOCKET_EVENTS.scheduleUpdated, onScheduleUpdated);
  useRealtimeStore().off('__connected__', onScheduleUpdated);
  sentDay = '';
  schedules = [];
  currentPeriod = null;
  inClass = false;

  // 把"不在上课"同步给主进程：否则主进程还记着上一个会话的"上课中"，
  // 重新登录后若第一轮课表刷新失败（离线且无缓存），灵动岛会继续按上课态把通知压着不弹，
  // 直到下一次刷新成功为止。这里主动对齐一次，代价是登出瞬间可能补弹一条此前被暂存的通知。
  window.desktop?.islandSetClassState({
    inClass: false,
    currentPeriodEnd: null,
    week: useAppStore().currentWeek,
    schedules: [],
  });
}
