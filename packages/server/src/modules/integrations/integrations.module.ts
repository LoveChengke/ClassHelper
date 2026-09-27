import { Router } from 'express';
import { sendCreated, sendOk } from '../../lib/http.js';
import { authenticate, getAuthUser, requireRole } from '../../middleware/auth.js';
import { validate, validatedBody, validatedParams, validatedQuery } from '../../middleware/validate.js';
import { defineModule } from '../module.types.js';
import { authenticateDevice, assertDeviceEnabled, getDevice } from './device-auth.js';
import {
  ackNotificationSchema,
  classIslandReportSchema,
  createDeviceSchema,
  deviceIdParamSchema,
  listDevicesQuerySchema,
  sendNotificationSchema,
  updateDeviceSchema,
  type ClassIslandReportInput,
  type CreateDeviceInput,
  type SendNotificationInput,
  type UpdateDeviceInput,
} from './integrations.schemas.js';
import * as integrationService from './integrations.service.js';

const router = Router();

/* ================================================================== 插件侧
 * 用**设备令牌**鉴权（X-ClassIsland-Token / Authorization: Bearer），不是 JWT 会话。
 * 路由放在文件最前面，避免被下面的 authenticate() 拦住；每个路由单独挂 authenticateDevice()。
 */

/** POST /api/integrations/classisland/report - 插件上报当前状态 +（可选）课表 */
router.post(
  '/classisland/report',
  authenticateDevice(),
  validate({ body: classIslandReportSchema }),
  async (req, res) => {
    const device = getDevice(req);
    assertDeviceEnabled(device);
    const result = await integrationService.applyReport(device, validatedBody<ClassIslandReportInput>(req));
    sendOk(res, result, '上报成功');
  },
);

/** GET /api/integrations/classisland/pending - 插件拉取尚未确认的下发提醒（离线补齐） */
router.get('/classisland/pending', authenticateDevice(), async (req, res) => {
  const device = getDevice(req);
  assertDeviceEnabled(device);
  sendOk(res, await integrationService.listPendingNotifications(device), '获取待提醒成功');
});

/** POST /api/integrations/classisland/ack - 插件确认提醒已弹出（之后不再补发） */
router.post(
  '/classisland/ack',
  authenticateDevice(),
  validate({ body: ackNotificationSchema }),
  async (req, res) => {
    const device = getDevice(req);
    assertDeviceEnabled(device);
    await integrationService.ackNotification(device, validatedBody<{ id: string }>(req).id);
    sendOk(res, { acked: true }, '已确认');
  },
);

/** GET /api/integrations/classisland/class-plan - 插件拉取本班课表（镜像回 ClassIsland） */
router.get('/classisland/class-plan', authenticateDevice(), async (req, res) => {
  const device = getDevice(req);
  assertDeviceEnabled(device);
  if (!device.mirrorScheduleToClassIsland) {
    sendOk(res, null, '该设备未开启「把班级课表镜像到 ClassIsland」');
    return;
  }
  sendOk(res, await integrationService.pullClassPlanForDevice(device), '获取课表成功');
});

/* ================================================================== Web 管理端
 * 用 JWT 鉴权；权限与"课表管理 / 发通知"保持一致，由 service 内二次校验班级维度角色。
 */
router.use(authenticate());

/**
 * GET /api/integrations/devices?classId= - 联动设备列表（含最后一次上报的状态快照）
 *
 * 仅管理员/教师可见：设备列表属于管理面，学生也不需要知道教室机器接了哪台设备；
 * 教师只能看到自己可访问班级的设备（service 内按 classScope 过滤）。
 */
router.get(
  '/devices',
  requireRole('ADMIN', 'TEACHER'),
  validate({ query: listDevicesQuerySchema }),
  async (req, res) => {
    const { classId } = validatedQuery<{ classId?: string }>(req);
    sendOk(res, await integrationService.listDevices(getAuthUser(req), classId), '获取设备列表成功');
  },
);

/** POST /api/integrations/devices - 新建设备并一次性返回明文令牌（管理员或本班班主任） */
router.post(
  '/devices',
  requireRole('ADMIN', 'TEACHER'),
  validate({ body: createDeviceSchema }),
  async (req, res) => {
    const result = await integrationService.createDevice(
      getAuthUser(req),
      validatedBody<CreateDeviceInput>(req),
    );
    sendCreated(res, result, '设备已创建，请把令牌填入插件设置（只显示这一次）');
  },
);

/** PATCH /api/integrations/devices/:id - 改名 / 启停 / 调整同步开关 */
router.patch(
  '/devices/:id',
  requireRole('ADMIN', 'TEACHER'),
  validate({ params: deviceIdParamSchema, body: updateDeviceSchema }),
  async (req, res) => {
    const { id } = validatedParams<{ id: string }>(req);
    sendOk(
      res,
      await integrationService.updateDevice(getAuthUser(req), id, validatedBody<UpdateDeviceInput>(req)),
      '设备已更新',
    );
  },
);

/** POST /api/integrations/devices/:id/token - 重置令牌（旧令牌立即失效） */
router.post(
  '/devices/:id/token',
  requireRole('ADMIN', 'TEACHER'),
  validate({ params: deviceIdParamSchema }),
  async (req, res) => {
    const { id } = validatedParams<{ id: string }>(req);
    sendOk(res, await integrationService.resetDeviceToken(getAuthUser(req), id), '令牌已重置');
  },
);

/** DELETE /api/integrations/devices/:id - 删除设备 */
router.delete(
  '/devices/:id',
  requireRole('ADMIN', 'TEACHER'),
  validate({ params: deviceIdParamSchema }),
  async (req, res) => {
    const { id } = validatedParams<{ id: string }>(req);
    await integrationService.deleteDevice(getAuthUser(req), id);
    sendOk(res, { id }, '设备已删除');
  },
);

/** POST /api/integrations/classisland/notify - 把提醒下发到该班的 ClassIsland 设备 */
router.post(
  '/classisland/notify',
  requireRole('ADMIN', 'TEACHER'),
  validate({ body: sendNotificationSchema }),
  async (req, res) => {
    const result = await integrationService.sendNotification(
      getAuthUser(req),
      validatedBody<SendNotificationInput>(req),
    );
    sendOk(
      res,
      result,
      result.skipped === 'channel-client'
        ? '该班教室已设置为「只在 ClassHelper 客户端显示」，本次未推送到 ClassIsland'
        : result.targetCount === 0
          ? '已保存提醒，但该班级还没有已接入的 ClassIsland 设备'
          : `已下发到 ${result.delivered} 台 ClassIsland 设备`,
    );
  },
);

export const integrationsModule = defineModule({
  name: 'integrations',
  basePath: '/integrations',
  router,
});
