import { ref } from 'vue';
import { defineStore } from 'pinia';
import { ElNotification } from 'element-plus';
import { io, type Socket } from 'socket.io-client';
import {
  PRIORITY_LABELS,
  SOCKET_EVENTS,
  type ClassIslandNotificationEvent,
  type ClassIslandStateEvent,
  type GradeDto,
  type HomeworkDto,
  type NotificationDto,
  type ScheduleDto,
  type ServerToClientEvents,
} from '@classhelper/shared';
import { SOCKET_URL } from '@/config';

type RealtimeEventName = keyof ServerToClientEvents;
type EventHandler = (payload: unknown) => void;

const EVENT_LABELS: Record<string, string> = {
  [SOCKET_EVENTS.notificationNew]: '新通知',
  [SOCKET_EVENTS.homeworkNew]: '新作业',
  [SOCKET_EVENTS.homeworkUpdated]: '作业变更',
  [SOCKET_EVENTS.gradeUpdated]: '成绩更新',
  [SOCKET_EVENTS.scheduleUpdated]: '课表变更',
  [SOCKET_EVENTS.homeworkStatus]: '作业状态',
  [SOCKET_EVENTS.classislandState]: 'ClassIsland 状态',
  [SOCKET_EVENTS.classislandNotification]: 'ClassIsland 提醒',
};

/**
 * 实时通道 store：
 * - 持有 Socket.IO 连接（自动重连）
 * - 收到事件时弹出 Element Plus 通知
 * - 通过 on/off 让页面订阅事件后自动刷新列表
 */
export const useRealtimeStore = defineStore('realtime', () => {
  const connected = ref(false);
  const connecting = ref(false);
  const lastEventName = ref<string | null>(null);
  const lastEventAt = ref<number | null>(null);
  const eventCount = ref(0);

  const handlers = new Map<string, Set<EventHandler>>();
  let socket: Socket | null = null;

  function notify(
    event: string,
    title: string,
    message: string,
    type: 'success' | 'info' | 'warning' | 'error' = 'info',
  ): void {
    ElNotification({ title: `${title}`, message, type, duration: 4000, position: 'bottom-right' });
  }

  function dispatch(event: string, payload: unknown): void {
    for (const handler of handlers.get(event) ?? []) {
      handler(payload);
    }
  }

  function bindEvents(instance: Socket): void {
    instance.on('connect', () => {
      connected.value = true;
      connecting.value = false;
    });
    instance.on('disconnect', () => {
      connected.value = false;
    });
    instance.on('connect_error', (error: Error) => {
      connected.value = false;
      connecting.value = false;
      // 重连过程中的失败只提示一次，避免刷屏
      if (eventCount.value === 0) notify('error', '实时通道连接失败', error.message);
    });

    instance.on(SOCKET_EVENTS.notificationNew, (payload: NotificationDto) => {
      markEvent(SOCKET_EVENTS.notificationNew);
      notify(
        'info',
        `新通知 · ${PRIORITY_LABELS[payload.priority] ?? payload.priority}`,
        `${payload.title}`,
        payload.priority === 'URGENT' ? 'error' : payload.priority === 'HIGH' ? 'warning' : 'info',
      );
      dispatch(SOCKET_EVENTS.notificationNew, payload);
    });

    instance.on(SOCKET_EVENTS.homeworkNew, (payload: HomeworkDto) => {
      markEvent(SOCKET_EVENTS.homeworkNew);
      notify('success', '新作业发布', payload.title);
      dispatch(SOCKET_EVENTS.homeworkNew, payload);
    });

    instance.on(SOCKET_EVENTS.homeworkUpdated, (payload: HomeworkDto) => {
      markEvent(SOCKET_EVENTS.homeworkUpdated);
      dispatch(SOCKET_EVENTS.homeworkUpdated, payload);
    });

    instance.on(SOCKET_EVENTS.homeworkStatus, (payload) => {
      markEvent(SOCKET_EVENTS.homeworkStatus);
      dispatch(SOCKET_EVENTS.homeworkStatus, payload);
    });

    instance.on(SOCKET_EVENTS.gradeUpdated, (payload: GradeDto) => {
      markEvent(SOCKET_EVENTS.gradeUpdated);
      notify('success', '成绩已更新', `${payload.examName}：${payload.score}/${payload.totalScore}`);
      dispatch(SOCKET_EVENTS.gradeUpdated, payload);
    });

    instance.on(SOCKET_EVENTS.scheduleUpdated, (payload: { schedule?: ScheduleDto; action: string }) => {
      markEvent(SOCKET_EVENTS.scheduleUpdated);
      if (payload.action !== 'updated') {
        notify(
          'info',
          '课表变更',
          `课表已${payload.action === 'created' ? '新增' : '删除'}：${payload.schedule?.course?.name ?? ''}`,
        );
      }
      dispatch(SOCKET_EVENTS.scheduleUpdated, payload);
    });

    instance.on(SOCKET_EVENTS.classislandState, (payload: ClassIslandStateEvent) => {
      markEvent(SOCKET_EVENTS.classislandState);
      // 状态是"心跳"级事件（每次上报都会来），弹通知会刷屏，只静默分发给页面
      dispatch(SOCKET_EVENTS.classislandState, payload);
    });

    instance.on(SOCKET_EVENTS.classislandNotification, (payload: ClassIslandNotificationEvent) => {
      markEvent(SOCKET_EVENTS.classislandNotification);
      if (payload.targetCount > 0) {
        notify('success', '提醒已下发到 ClassIsland', payload.title);
      } else {
        // 没有已接入的设备时提醒只落库，老师需要知道"没送到教室"
        notify('warning', '该班级还没有已接入的 ClassIsland 设备', payload.title);
      }
      dispatch(SOCKET_EVENTS.classislandNotification, payload);
    });

    instance.on(SOCKET_EVENTS.connected, (payload: { rooms: string[] }) => {
      markEvent(SOCKET_EVENTS.connected);
      console.info('[realtime] 已加入房间', payload.rooms);
    });
  }

  function markEvent(event: string): void {
    lastEventName.value = event;
    lastEventAt.value = Date.now();
    eventCount.value += 1;
  }

  function connect(token: string): void {
    if (socket?.connected || connecting.value) return;
    connecting.value = true;
    socket = io(SOCKET_URL, {
      auth: { token, clientType: 'admin' },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 8000,
    });
    bindEvents(socket);
  }

  function disconnect(): void {
    socket?.disconnect();
    socket?.removeAllListeners();
    socket = null;
    connected.value = false;
    connecting.value = false;
  }

  function on(event: RealtimeEventName, handler: EventHandler): void {
    const set = handlers.get(event) ?? new Set<EventHandler>();
    set.add(handler);
    handlers.set(event, set);
  }

  function off(event: RealtimeEventName, handler: EventHandler): void {
    handlers.get(event)?.delete(handler);
  }

  function eventLabel(): string {
    return lastEventName.value ? (EVENT_LABELS[lastEventName.value] ?? lastEventName.value) : '';
  }

  return {
    connected,
    connecting,
    lastEventName,
    lastEventAt,
    eventCount,
    eventLabel,
    connect,
    disconnect,
    on,
    off,
  };
});
