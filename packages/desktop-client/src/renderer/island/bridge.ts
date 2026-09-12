import {
  SOCKET_EVENTS,
  resolveClassStatus,
  type ClassPeriod,
  type NotificationDto,
  type ScheduleDto,
} from '@classhelper/shared';
import { scheduleApi } from '../api/index.js';
import { fetchWithCache } from '../cache/index.js';
import { useAppStore } from '../stores/app.js';
import { useAuthStore } from '../stores/auth.js';
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
    },
    context: getIslandClassContext(),
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
