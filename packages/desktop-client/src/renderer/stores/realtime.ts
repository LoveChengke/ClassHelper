import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { ElMessage } from 'element-plus';
import { io, type Socket } from 'socket.io-client';
import {
  PRIORITY_LABELS,
  SOCKET_EVENTS,
  type GradeDto,
  type HomeworkDto,
  type NotificationDto,
  type ServerToClientEvents,
} from '@classhelper/shared';
import { socketUrlOf } from '../config.js';
import { pushCallToIsland, pushHomeworkToIsland, pushNotificationToIsland } from '../island/bridge.js';

type RealtimeEventName = keyof ServerToClientEvents;
type EventHandler = (payload: unknown) => void;

/**
 * 实时通道（学生端）。
 * 与 Web 管理端使用同一套事件名；收到事件后除了通知用户，
 * 还会把数据写回 IndexedDB，保证断网时看到的是最后同步到的内容。
 */
export const useRealtimeStore = defineStore('realtime', () => {
  const connected = ref(false);
  const connecting = ref(false);
  const lastEventName = ref<string | null>(null);
  const lastEventAt = ref<number | null>(null);
  const eventCount = ref(0);

  const handlers = new Map<string, Set<EventHandler>>();
  let socket: Socket | null = null;

  const statusText = computed(() => {
    if (connected.value) return '实时连接正常';
    if (connecting.value) return '正在连接服务器';
    return '实时连接已断开';
  });

  function dispatch(event: string, payload: unknown): void {
    for (const handler of handlers.get(event) ?? []) handler(payload);
  }

  function mark(event: string): void {
    lastEventName.value = event;
    lastEventAt.value = Date.now();
    eventCount.value += 1;
  }

  function bind(instance: Socket): void {
    instance.on('connect', () => {
      connected.value = true;
      connecting.value = false;
      dispatch('__connected__', null);
    });
    instance.on('disconnect', () => {
      connected.value = false;
      dispatch('__disconnected__', null);
    });
    instance.on('connect_error', (error: Error) => {
      connected.value = false;
      connecting.value = false;
      dispatch('__connect_error__', error.message);
    });

    instance.on(SOCKET_EVENTS.notificationNew, (payload: NotificationDto) => {
      mark(SOCKET_EVENTS.notificationNew);
      ElMessage({
        message: `【${PRIORITY_LABELS[payload.priority] ?? payload.priority}】${payload.title}`,
        type: payload.priority === 'URGENT' ? 'error' : 'info',
        duration: 5000,
        showClose: true,
      });
      // 投递到桌面灵动岛：紧急通知立即展开；上课期间的非紧急通知会暂存，下课后自动弹出
      pushNotificationToIsland(payload);
      dispatch(SOCKET_EVENTS.notificationNew, payload);
    });

    instance.on(SOCKET_EVENTS.homeworkNew, (payload: HomeworkDto) => {
      mark(SOCKET_EVENTS.homeworkNew);
      ElMessage.success(`新作业：${payload.title}`);
      // 作业发布也上岛：胶囊提示"新作业"，点击展开看截止时间与要求
      pushHomeworkToIsland(payload);
      dispatch(SOCKET_EVENTS.homeworkNew, payload);
    });

    instance.on(SOCKET_EVENTS.callNew, (payload: NotificationDto) => {
      mark(SOCKET_EVENTS.callNew);
      ElMessage({
        message: payload.title,
        type: 'warning',
        duration: 8000,
        showClose: true,
      });
      // 叫人：无论是否上课都立即展开（老师正在等这位同学）
      pushCallToIsland(payload);
      dispatch(SOCKET_EVENTS.callNew, payload);
    });

    instance.on(SOCKET_EVENTS.homeworkUpdated, (payload: HomeworkDto & { deleted?: boolean }) => {
      mark(SOCKET_EVENTS.homeworkUpdated);
      dispatch(SOCKET_EVENTS.homeworkUpdated, payload);
    });

    instance.on(SOCKET_EVENTS.gradeUpdated, (payload: GradeDto) => {
      mark(SOCKET_EVENTS.gradeUpdated);
      ElMessage.success(`成绩更新：${payload.examName} ${payload.score}/${payload.totalScore}`);
      dispatch(SOCKET_EVENTS.gradeUpdated, payload);
    });

    instance.on(SOCKET_EVENTS.scheduleUpdated, (payload: unknown) => {
      mark(SOCKET_EVENTS.scheduleUpdated);
      dispatch(SOCKET_EVENTS.scheduleUpdated, payload);
    });
  }

  function connect(serverUrl: string, token: string): void {
    disconnect();
    connecting.value = true;
    socket = io(socketUrlOf(serverUrl), {
      auth: { token, clientType: 'desktop' },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1500,
      reconnectionDelayMax: 10000,
    });
    bind(socket);
  }

  function disconnect(): void {
    socket?.removeAllListeners();
    socket?.disconnect();
    socket = null;
    connected.value = false;
    connecting.value = false;
  }

  function on(
    event: RealtimeEventName | '__connected__' | '__disconnected__' | '__connect_error__',
    handler: EventHandler,
  ): void {
    const set = handlers.get(event) ?? new Set<EventHandler>();
    set.add(handler);
    handlers.set(event, set);
  }

  function off(
    event: RealtimeEventName | '__connected__' | '__disconnected__' | '__connect_error__',
    handler: EventHandler,
  ): void {
    handlers.get(event)?.delete(handler);
  }

  return {
    connected,
    connecting,
    statusText,
    lastEventName,
    lastEventAt,
    eventCount,
    connect,
    disconnect,
    on,
    off,
  };
});
