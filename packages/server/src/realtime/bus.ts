import { SOCKET_ROOMS } from '@classhelper/shared';

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
  emitToRooms([SOCKET_ROOMS.class(classId)], event, payload);
}

/** 定向推送给单个用户 */
export function emitToUser(userId: string, event: string, payload: unknown): void {
  emitToRooms([SOCKET_ROOMS.user(userId)], event, payload);
}
