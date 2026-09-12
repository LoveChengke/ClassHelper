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

export function startIslandBridge(): void {
  if (tickTimer) return;

  void refreshIslandSchedules().catch(() => undefined);

  // 课表变更（教师改课）立即复算，避免"下课后不弹出"或"上课没隐藏"
  useRealtimeStore().on(SOCKET_EVENTS.scheduleUpdated, () => {
    void refreshIslandSchedules().catch(() => undefined);
  });

  tickTimer = setInterval(() => recomputeClassState(), TICK_INTERVAL_MS);
  refreshTimer = setInterval(() => {
    void refreshIslandSchedules().catch(() => undefined);
  }, REFRESH_INTERVAL_MS);
}

export function stopIslandBridge(): void {
  if (tickTimer) clearInterval(tickTimer);
  if (refreshTimer) clearInterval(refreshTimer);
  tickTimer = null;
  refreshTimer = null;
}
