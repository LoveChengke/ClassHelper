import { SOCKET_ROOMS, SOCKET_EVENT_CHANNELS } from '@classhelper/shared';

/**
 * 实时事件总线。
 *
 * 业务模块只依赖这里，不直接依赖 Socket.IO 实例，
 * 因此「移除实时推送」只需让它注册不到 emitter，业务代码无需改动。
 */
export type RealtimeEmitter = (rooms: string[], event: string, payload: unknown) => void;

let emitter: RealtimeEmitter | null = null;

export function registerEmitter(next: RealtimeEmitter): void {
  emitter = next;
}

export function emitToRooms(rooms: string[], event: string, payload: unknown): void {
  if (!emitter || rooms.length === 0) return;
  emitter(rooms, event, payload);
}

/** 按班级房间广播（class:{classId}） */
export function emitToClass(classId: string, event: string, payload: unknown): void {
  emitToRooms([SOCKET_ROOMS.classChannel(classId, SOCKET_EVENT_CHANNELS[event] ?? 'core')], event, payload);
}

let disconnectUsers: (ids: string[] | null) => void = () => {};
export function registerSessionInvalidator(invalidate: (ids: string[] | null) => void) {
  disconnectUsers = invalidate;
}
export function disconnectUserSessions(ids: string[]) {
  disconnectUsers(ids);
}
/** 班级集合或任课关系变化后，重连重新解析按键范围。 */
export function refreshClassSubscriptions() {
  disconnectUsers(null);
}

/**
 * 定向推送给单个会话。
 *
 * 会话 id：教师/管理员是自己的账号 id，ClassHelper 班级端是**班级 id**
 * （见 socket.ts 的握手逻辑）。学生不是账号，因此没有"学生房间"。
 */
export function emitToSession(sessionId: string, event: string, payload: unknown): void {
  emitToRooms([SOCKET_ROOMS.session(sessionId)], event, payload);
}
