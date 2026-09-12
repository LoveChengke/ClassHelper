import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import {
  SOCKET_EVENTS,
  SOCKET_ROOMS,
  type ClientToServerEvents,
  type ServerToClientEvents,
  type SocketAuthPayload,
  type UserRole,
} from '@classhelper/shared';
import { env } from '../config/env.js';
import { getAccessibleClassIds } from '../lib/access.js';
import { verifyToken } from '../lib/jwt.js';
import { logger } from '../lib/logger.js';
import { registerEmitter, type RealtimeEmitter } from './bus.js';

interface SocketData {
  user: {
    id: string;
    username: string;
    name: string;
    role: UserRole;
    classId: string | null;
  };
}

export type RealtimeServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;

/** 绑定 Socket.IO 到 HTTP 服务，并注册到事件总线 */
export function initRealtime(httpServer: HttpServer): RealtimeServer {
  const io: RealtimeServer = new Server(httpServer, {
    cors: { origin: env.corsOrigins, credentials: true },
    transports: ['websocket', 'polling'],
    pingInterval: 25000,
    pingTimeout: 20000,
  });

  // 握手鉴权：客户端通过 handshake.auth.token 传入 JWT
  io.use((socket, next) => {
    try {
      const auth = (socket.handshake.auth ?? {}) as Partial<SocketAuthPayload>;
      const queryToken =
        typeof socket.handshake.query.token === 'string' ? socket.handshake.query.token : null;
      const token = auth.token ?? queryToken;
      if (!token) {
        next(new Error('缺少认证 token'));
        return;
      }
      const payload = verifyToken(token);
      // 班级账号（班级设备）：socket.data.user.id 用班级 id，据此加入 user:{classId} 房间，
      // "叫人"等定向消息因此能直达班级设备（见 calls.service）。
      socket.data.user = {
        id: payload.classSession ? (payload.classId ?? payload.sub) : payload.sub,
        username: payload.classSession ? (payload.classCode ?? payload.username) : payload.username,
        name: payload.name,
        role: payload.role,
        classId: payload.classId,
      };
      next();
    } catch {
      next(new Error('认证失败，请重新登录'));
    }
  });

  io.on('connection', (socket) => {
    const user = socket.data.user;
    void (async () => {
      const rooms = [SOCKET_ROOMS.user(user.id), SOCKET_ROOMS.role(user.role)];

      try {
        const classIds = await getAccessibleClassIds({
          sub: user.id,
          username: user.username,
          name: user.name,
          role: user.role,
          classId: user.classId,
        });
        for (const classId of classIds) {
          await socket.join(SOCKET_ROOMS.class(classId));
          rooms.push(SOCKET_ROOMS.class(classId));
        }
      } catch (error) {
        logger.warn(`加入班级房间失败（user=${user.id}）`, error);
      }

      await socket.join(user.role === 'STUDENT' ? SOCKET_ROOMS.students : SOCKET_ROOMS.teachers);
      rooms.push(user.role === 'STUDENT' ? SOCKET_ROOMS.students : SOCKET_ROOMS.teachers);

      logger.info(`实时连接建立：${user.name}(${user.role}) sid=${socket.id}`);
      socket.emit(SOCKET_EVENTS.connected, { userId: user.id, role: user.role, rooms });
    })();

    // 客户端可显式订阅某个班级（服务端二次校验权限）
    socket.on('class:join', (classId, ack) => {
      void (async () => {
        try {
          const allowed = await getAccessibleClassIds({
            sub: user.id,
            username: user.username,
            name: user.name,
            role: user.role,
            classId: user.classId,
          });
          if (!allowed.includes(classId)) {
            ack?.({ ok: false, message: '无权订阅该班级' });
            return;
          }
          await socket.join(SOCKET_ROOMS.class(classId));
          ack?.({ ok: true });
        } catch {
          ack?.({ ok: false, message: '订阅失败' });
        }
      })();
    });

    socket.on('class:leave', (classId) => {
      void socket.leave(SOCKET_ROOMS.class(classId));
    });

    socket.on('ping', (ack) => {
      ack?.();
    });

    socket.on('disconnect', (reason) => {
      logger.debug(`实时连接断开：${user.name} (${reason})`);
    });
  });

  const emit: RealtimeEmitter = (rooms, event, payload) => {
    const target = io.to(rooms) as unknown as { emit: (event: string, payload: unknown) => void };
    target.emit(event, payload);
    logger.debug(`实时推送 ${event} -> ${rooms.join(',')}`);
  };
  registerEmitter(emit);

  logger.info('Socket.IO 实时通道已就绪（房间规则：class:{classId} / user:{id}）');
  return io;
}
