import { z } from 'zod';
import { Router } from 'express';
import { sendCreated, sendOk } from '../../lib/http.js';
import { idParamSchema } from '../../lib/schemas.js';
import { authenticate, getAuthUser, requirePermission } from '../../middleware/auth.js';
import { validate, validatedBody, validatedParams, validatedQuery } from '../../middleware/validate.js';
import { defineModule } from '../module.types.js';
import {
  assignUserGroupsSchema,
  createPermissionGroupSchema,
  updatePermissionGroupSchema,
  type AssignUserGroupsInput,
  type CreatePermissionGroupInput,
  type UpdatePermissionGroupInput,
} from './permissions.schemas.js';
import * as permissionService from './permissions.service.js';

const router = Router();
router.use(authenticate());

/**
 * GET /api/permissions/me - 当前账号的生效权限。
 *
 * **故意不挂权限键**：任何登录账号都要能读自己的权限（两端据此决定入口显不显示），
 * 而"能读自己有什么权限"本身不是什么机密。班级端会话返回空集。
 */
router.get('/me', async (req, res) => {
  const user = getAuthUser(req);
  sendOk(res, await permissionService.myPermissions(user), '获取当前权限成功');
});

/** GET /api/permissions/catalog - 权限键目录（权限页整棵勾选树的唯一来源） */
router.get('/catalog', requirePermission('permission:manage'), async (_req, res) => {
  sendOk(res, await permissionService.permissionCatalog(), '获取权限目录成功');
});

/** GET /api/permissions/groups - 权限组列表 */
router.get('/groups', requirePermission('permission:manage'), async (_req, res) => {
  sendOk(res, await permissionService.listGroups(), '获取权限组成功');
});

router.get('/scopes', requirePermission('permission:manage'), async (_req, res) =>
  sendOk(res, await permissionService.scopeOptions()),
);
router.get(
  '/audit',
  requirePermission('permission:manage'),
  validate({
    query: z.object({
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(30),
    }),
  }),
  async (req, res) => {
    const { page, pageSize } = validatedQuery<{ page: number; pageSize: number }>(req);
    sendOk(res, await permissionService.listAudits(page, pageSize));
  },
);
router.get(
  '/groups/:id/members',
  requirePermission('permission:manage'),
  validate({ params: idParamSchema }),
  async (req, res) => sendOk(res, await permissionService.groupMembers(String(req.params.id))),
);

/** POST /api/permissions/groups - 新建权限组 */
router.post(
  '/groups',
  requirePermission('permission:manage'),
  validate({ body: createPermissionGroupSchema }),
  async (req, res) => {
    const input = validatedBody<CreatePermissionGroupInput>(req);
    sendCreated(res, await permissionService.createGroup(getAuthUser(req), input), '权限组已创建');
  },
);

/** PATCH /api/permissions/groups/:id - 改名 / 改描述 / 整体替换权限键 */
router.patch(
  '/groups/:id',
  requirePermission('permission:manage'),
  validate({ params: idParamSchema, body: updatePermissionGroupSchema }),
  async (req, res) => {
    const { id } = validatedParams<{ id: string }>(req);
    const input = validatedBody<UpdatePermissionGroupInput>(req);
    sendOk(res, await permissionService.updateGroup(getAuthUser(req), id, input), '权限组已更新');
  },
);

/** DELETE /api/permissions/groups/:id - 删除权限组（内置组不允许删除） */
router.delete(
  '/groups/:id',
  requirePermission('permission:manage'),
  validate({ params: idParamSchema }),
  async (req, res) => {
    const { id } = validatedParams<{ id: string }>(req);
    await permissionService.deleteGroup(getAuthUser(req), id);
    sendOk(res, { id }, '权限组已删除，原成员回到角色默认权限');
  },
);

/** GET /api/permissions/users - 成员列表（含所属权限组与生效权限数量） */
router.get('/users', requirePermission('permission:manage'), async (_req, res) => {
  sendOk(res, await permissionService.listMembers(), '获取成员成功');
});

/** PUT /api/permissions/users/:id/groups - 整体替换某账号的权限组 */
router.put(
  '/users/:id/groups',
  requirePermission('permission:manage'),
  validate({ params: idParamSchema, body: assignUserGroupsSchema }),
  async (req, res) => {
    const { id } = validatedParams<{ id: string }>(req);
    const input = validatedBody<AssignUserGroupsInput>(req);
    sendOk(res, await permissionService.assignUserGroups(getAuthUser(req), id, input), '权限组分配已保存');
  },
);

export const permissionsModule = defineModule({
  name: 'permissions',
  basePath: '/permissions',
  router,
});
