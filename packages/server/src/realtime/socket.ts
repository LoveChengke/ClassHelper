import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import {
  SOCKET_EVENTS,
  SOCKET_ROOMS,
  SOCKET_CHANNELS,
  type SocketChannel,
  type PermissionKey,
  type ClientToServerEvents,
  type ServerToClientEvents,
  type SocketAuthPayload,
} from '@classhelper/shared';
import { env } from '../config/env.js';
import { verifyToken, type TokenPayload } from '../lib/jwt.js';
import { loadSessionUser } from '../lib/authz/session.js';
import { classIdsFor, loadAuthPrincipal, classDeviceClassId } from '../lib/authz/index.js';
import { logger } from '../lib/logger.js';
import { registerEmitter, registerSessionInvalidator } from './bus.js';

interface SocketData {
  user: TokenPayload;
  token: string;
}
export type RealtimeServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;
const channelKeys: Record<SocketChannel, PermissionKey[]> = {
  core: ['class:read', 'schedule:read'],
  homework: ['homework:read'],
  notification: ['notification:read'],
  grade: ['grade:read'],
  courseware: ['courseware:read'],
};
async function channelClasses(user: TokenPayload, channel: SocketChannel): Promise<Set<string>> {
  const id = classDeviceClassId(user);
  if (id) return new Set([id]);
  return new Set((await Promise.all(channelKeys[channel].map((key) => classIdsFor(user, key)))).flat());
}
export function initRealtime(httpServer: HttpServer): RealtimeServer {
  const io: RealtimeServer = new Server(httpServer, {
    cors: { origin: env.corsOrigins, credentials: true },
    transports: ['websocket', 'polling'],
    pingInterval: 25000,
    pingTimeout: 20000,
  });
  io.use((socket, next) => {
    void (async () => {
      try {
        const auth = socket.handshake.auth as Partial<SocketAuthPayload>;
        const token =
          auth.token ??
          (typeof socket.handshake.query.token === 'string' ? socket.handshake.query.token : '');
        const user = await loadSessionUser(verifyToken(token));
        await loadAuthPrincipal(user);
        socket.data = { user, token };
        next();
      } catch {
        next(new Error('认证失败，请重新登录'));
      }
    })();
  });
  io.on('connection', (socket) => {
    const user = socket.data.user;
    // 手动订阅每次回查账号与权限；不沿用握手时的权限快照。
    const ready = (async () => {
      const base = [
        SOCKET_ROOMS.session(user.sub),
        SOCKET_ROOMS.role(user.role),
        user.role === 'CLASS_DEVICE' ? SOCKET_ROOMS.students : SOCKET_ROOMS.teachers,
      ];
      await socket.join(base);
      for (const channel of SOCKET_CHANNELS)
        for (const id of await channelClasses(user, channel))
          await socket.join(SOCKET_ROOMS.classChannel(id, channel));
      socket.emit(SOCKET_EVENTS.connected, {
        sessionId: user.sub,
        role: user.role,
        rooms: [...socket.rooms].filter((r) => r !== socket.id),
      });
    })().catch((error) => {
      logger.warn('实时订阅失败', error);
      socket.disconnect(true);
    });
    socket.on('class:join', (request, ack) => {
      void (async () => {
        await ready;
        try {
          const current = await loadSessionUser(verifyToken(socket.data.token));
          const classId = typeof request === 'string' ? request : request.classId;
          const requested =
            typeof request === 'string' ? SOCKET_CHANNELS : (request.channels ?? SOCKET_CHANNELS);
          if (!requested.length || requested.some((c) => !SOCKET_CHANNELS.includes(c))) {
            ack?.({ ok: false, message: '未知事件通道' });
            return;
          }
          const allowed: SocketChannel[] = [];
          for (const channel of requested)
            if ((await channelClasses(current, channel)).has(classId)) allowed.push(channel);
          // 旧字符串协议只加入有权通道；新协议显式通道有任一无权则全部拒绝。
          if (!allowed.length || (typeof request !== 'string' && allowed.length !== requested.length)) {
            ack?.({ ok: false, message: '无权订阅该班级或通道' });
            return;
          }
          for (const channel of allowed) await socket.join(SOCKET_ROOMS.classChannel(classId, channel));
          ack?.({ ok: true });
        } catch {
          ack?.({ ok: false, message: '订阅失败' });
        }
      })();
    });
    socket.on('class:leave', (request) => {
      void (async () => {
        await ready;
        const classId = typeof request === 'string' ? request : request.classId;
        for (const channel of typeof request === 'string'
          ? SOCKET_CHANNELS
          : (request.channels ?? SOCKET_CHANNELS))
          await socket.leave(SOCKET_ROOMS.classChannel(classId, channel));
      })();
    });
    socket.on('ping', (ack) => ack?.());
  });
  registerEmitter((rooms, event, payload) => {
    (io.to(rooms) as unknown as { emit(event: string, payload: unknown): void }).emit(event, payload);
  });
  registerSessionInvalidator((ids) => {
    if (ids === null) {
      io.in(SOCKET_ROOMS.teachers).disconnectSockets(true);
      return;
    }
    for (const id of ids) io.in(SOCKET_ROOMS.session(id)).disconnectSockets(true);
  });
  return io;
}
