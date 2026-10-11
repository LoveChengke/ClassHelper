import { Router } from 'express';
import { API_PATHS } from '@classhelper/shared';
import { sendOk } from '../../lib/http.js';
import { authenticate, getAuthUser, requirePermission } from '../../middleware/auth.js';
import { validate, validatedBody } from '../../middleware/validate.js';
import { defineModule } from '../module.types.js';
import {
  updateAutostartSchema,
  updateSystemSettingsSchema,
  type UpdateAutostartInput,
  type UpdateSystemSettingsInput,
} from './system.schemas.js';
import * as systemService from './system.service.js';

const router = Router();
router.use(authenticate());

/**
 * 系统设置与运维接口（**全部仅 ADMIN**，权限键 `system:manage`）。
 *
 * 这些接口改的是"这台服务器怎么运行"（开发者模式、开机自启），
 * 与业务数据无关，因此不走任何班级维度断言。
 */
router.get('/settings', requirePermission('system:manage'), async (_req, res) => {
  sendOk(res, await systemService.getSystemSettings(), '获取系统设置成功');
});

router.put(
  '/settings',
  requirePermission('system:manage'),
  validate({ body: updateSystemSettingsSchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const input = validatedBody<UpdateSystemSettingsInput>(req);
    sendOk(res, await systemService.updateSystemSettings(user, input), '系统设置已保存');
  },
);

router.get('/autostart', requirePermission('system:manage'), async (_req, res) => {
  sendOk(res, await systemService.getAutostartStatus(), '获取开机自启状态成功');
});

router.put(
  '/autostart',
  requirePermission('system:manage'),
  validate({ body: updateAutostartSchema }),
  async (req, res) => {
    const input = validatedBody<UpdateAutostartInput>(req);
    sendOk(res, await systemService.updateAutostart(input), '开机自启设置已生效');
  },
);

/** 运行诊断：开发者模式下排查"服务端到底跑的哪份代码、数据在哪" */
router.get('/diagnostics', requirePermission('system:manage'), async (_req, res) => {
  sendOk(res, await systemService.getDiagnostics(), '获取运行诊断成功');
});

export const systemModule = defineModule({
  name: 'system',
  basePath: API_PATHS.system,
  router,
});
