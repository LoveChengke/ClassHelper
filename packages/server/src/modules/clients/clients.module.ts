import { Router } from 'express';
import type { ClientUpdateProgressDto } from '@classhelper/shared';
import { sendCreated, sendOk } from '../../lib/http.js';
import { idParamSchema } from '../../lib/schemas.js';
import { authenticate, getAuthUser, requireRole, requirePermission } from '../../middleware/auth.js';
import { validate, validatedBody, validatedParams, validatedQuery } from '../../middleware/validate.js';
import { defineModule } from '../module.types.js';
import {
  clientCommandAckSchema,
  clientHeartbeatSchema,
  clientProgressSchema,
  createClientCommandSchema,
  listClientDevicesQuerySchema,
  pushClientUpdateSchema,
  type ClientCommandAckInput,
  type ClientHeartbeatInput,
  type CreateClientCommandInput,
  type ListClientDevicesQuery,
  type PushClientUpdateInput,
} from './clients.schemas.js';
import * as clientService from './clients.service.js';

const router = Router();
router.use(authenticate());
router.post(
  '/update-progress',
  requireRole('CLASS_DEVICE'),
  validate({ body: clientProgressSchema }),
  async (req, res) => {
    const input = validatedBody<{
      deviceKey: string;
      progress: ClientUpdateProgressDto;
    }>(req);
    await clientService.reportUpdateProgress(getAuthUser(req), input.deviceKey, input.progress);
    sendOk(res, null);
  },
);

/**
 * POST /api/clients/heartbeat - 客户端每 30 秒上报一次
 *
 * **不挂权限键**：上报方是教室里的班级端会话（角色 CLASS_DEVICE，权限集为空）。
 * 返回值里同时带回"要不要更新 + 安装包信息 + 一条待执行命令"，客户端一次请求全拿到。
 */
router.post(
  '/heartbeat',
  requireRole('CLASS_DEVICE'),
  validate({ body: clientHeartbeatSchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const input = validatedBody<ClientHeartbeatInput>(req);
    const result = await clientService.heartbeat(user, input, req.ip ?? '');
    // 1.3.x 旧客户端误读顶层字段，提供兼容别名让它们仍能接收修复版更新。
    sendOk(res, result, '心跳已上报', 200, input.agentProtocol === 2 ? {} : result);
  },
);

/** POST /api/clients/commands/:id/ack - 执行回执（同样不挂权限键，靠 deviceKey 归属校验） */
router.post(
  '/commands/:id/ack',
  requireRole('CLASS_DEVICE'),
  validate({ params: idParamSchema, body: clientCommandAckSchema }),
  async (req, res) => {
    const { id } = validatedParams<{ id: string }>(req);
    const input = validatedBody<ClientCommandAckInput>(req);
    sendOk(res, await clientService.ackCommand(getAuthUser(req), id, input), '回执已记录');
  },
);

/**
 * POST /api/clients/commands - 下发远控命令（关机 / 重启 / 注销 / 锁屏）
 *
 * 权限键 `remote:control`（默认只有管理员有）：这是唯一能远程动别人电脑的接口。
 */
router.post(
  '/commands',
  requirePermission('remote:control'),
  validate({ body: createClientCommandSchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const input = validatedBody<CreateClientCommandInput>(req);
    sendCreated(
      res,
      await clientService.createCommands(user, input),
      '命令已下发，将在这台电脑下次心跳时送达',
    );
  },
);

/** GET /api/clients/devices?classId= - Web 端设备列表（版本 / 在线 / 待执行命令） */
router.get(
  '/devices',
  requirePermission('client:read'),
  validate({ query: listClientDevicesQuerySchema }),
  async (req, res) => {
    const query = validatedQuery<ListClientDevicesQuery>(req);
    sendOk(
      res,
      await clientService.listDevices(getAuthUser(req), { classId: query.classId }),
      '获取设备列表成功',
    );
  },
);

/** POST /api/clients/updates - 统一下发客户端更新 */
router.post(
  '/updates',
  requirePermission('client:update-push'),
  validate({ body: pushClientUpdateSchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const input = validatedBody<PushClientUpdateInput>(req);
    sendOk(res, await clientService.pushUpdate(user, input), '更新已下发，将在这台电脑下次心跳时送达');
  },
);

/** DELETE /api/clients/devices/:id - 移除设备记录（换机 / 旧机器清理） */
router.delete(
  '/devices/:id',
  requirePermission('client:manage'),
  validate({ params: idParamSchema }),
  async (req, res) => {
    const { id } = validatedParams<{ id: string }>(req);
    sendOk(res, await clientService.deleteDevice(getAuthUser(req), id), '设备已移除');
  },
);

export const clientsModule = defineModule({
  name: 'clients',
  basePath: '/clients',
  router,
});
