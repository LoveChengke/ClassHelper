import {
  SOCKET_EVENTS,
  resolveClassStatus,
  type ClassPeriod,
  type HomeworkDto,
  type NotificationDto,
  type ScheduleDto,
} from '@classhelper/shared';
import { scheduleApi } from '../api/index.js';
import { fetchWithCache } from '../cache/index.js';
import { useAppStore } from '../stores/app.js';
import { useAuthStore } from '../stores/auth.js';
import { useNotificationStore } from '../stores/notifications.js';
import { useRealtimeStore } from '../stores/realtime.js';

/**
 * 灵动岛桥接（渲染进程侧）。
 *
 * 职责：把"当前是否在上课时间段"这件事算出来并同步给主进程 ——
 * 主进程据此决定通知是"立即弹出"还是"上课期间隐藏、下课后自动弹出"。
 *
 * 判定完全基于本地缓存的课表（离线也能算），并每 10 秒复算一次，
 * 因此下课后最多 10 秒内会自动弹出暂存的通知。
 */
const TICK_INTERVAL_MS = 10_000;
const REFRESH_INTERVAL_MS = 5 * 60_000;

let schedules: ScheduleDto[] = [];
let currentPeriod: ClassPeriod | null = null;
let inClass = false;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

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

  const week = appStore.currentWeek;
  const result = await fetchWithCache<ScheduleDto[]>(
    'schedules',
    `week:${week}`,
    () => scheduleApi.list({ classId: auth.classId ?? undefined, week }),
    [],
  );
  schedules = result.data;
  recomputeClassState(true);
}

function recomputeClassState(force = false): void {
  const appStore = useAppStore();
  const status = resolveClassStatus(schedules, new Date(), appStore.currentWeek);
  const nextInClass = status.inClass;
  currentPeriod = status.current;

  if (!force && nextInClass === inClass) return;
  inClass = nextInClass;

  window.desktop?.islandSetClassState({
    inClass,
    currentPeriodEnd: currentPeriod?.endTime ?? null,
    week: appStore.currentWeek,
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
  void refreshIslandSchedules().catch(() => undefined);
}

export function startIslandBridge(): void {
  if (tickTimer) return;

  void refreshIslandSchedules().catch(() => undefined);

  // 课表变更（教师改课）立即复算，避免"下课后不弹出"或"上课没隐藏"
  useRealtimeStore().on(SOCKET_EVENTS.scheduleUpdated, onScheduleUpdated);

  tickTimer = setInterval(() => recomputeClassState(), TICK_INTERVAL_MS);
  refreshTimer = setInterval(() => {
    void refreshIslandSchedules().catch(() => undefined);
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

  useRealtimeStore().off(SOCKET_EVENTS.scheduleUpdated, onScheduleUpdated);
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
  });
}
