import { assertClassDevice, assertPermission, classIdsFor } from '../../lib/authz/index.js';
import { getReleaseProgress, setReleaseProgress } from './release-progress.js';
import { Router } from 'express';
import path from 'node:path';
import { sendCreated, sendOk, ApiError } from '../../lib/http.js';
import {
  authenticate,
  getAuthUser,
  hasAuthPermission,
  requireAnyPermission,
  requirePermission,
  requireAdmin,
  requirePermissionOrClassDevice,
} from '../../middleware/auth.js';
import { validateBadRequest as validate, validatedBody, validatedParams } from '../../middleware/validate.js';
import { defineModule } from '../module.types.js';
import * as clientReleases from './client-releases.service.js';
import * as updateService from './update.service.js';
import {
  clientReleaseVersionParamSchema,
  fetchClientReleaseSchema,
  registerClientReleaseSchema,
  type FetchClientReleaseInput,
  type RegisterClientReleaseInput,
} from './update.schemas.js';

const router = Router();
router.use(authenticate());
router.get('/client/progress', requirePermission('client:update'), async (_req, res) =>
  sendOk(res, getReleaseProgress()),
);

/**
 * GET /api/update/check?force=1 - 检查 GitHub 上有没有比本机新的版本
 *
 * 为什么 Web 管理端不直连 GitHub：浏览器的请求受服务端下发的 CSP 约束，
 * `connect-src` 只放行 `'self'` 与 WebSocket（见 `middleware/security.ts`），
 * 直连 `api.github.com` 会被浏览器拦掉。走服务端转发还顺带让所有管理员共享同一份缓存。
 *
 * 桌面客户端不受这条约束（它由主进程直连），但两边拿到的 `UpdateInfo` 结构是一致的。
 *
 * 权限：任何已登录用户都能查（信息本身来自公开仓库）。`force=1` 绕过服务端缓存，
 * 但**只有管理员生效** —— 否则任意登录用户都能靠刷这个参数把匿名限流打满。
 */
router.get('/check', requirePermissionOrClassDevice('update:check'), async (req, res) => {
  const force = req.query.force === '1' && hasAuthPermission(req, 'update:force');
  sendOk(res, await updateService.checkForUpdates({ force }), '更新检查完成');
});

/* ------------------------------- 客户端安装包的服务端缓存（统一下发更新的基础） */

/**
 * GET /api/update/client/releases - 服务端已缓存了哪些客户端版本
 *
 * 教室机器没有外网，所以"统一推送更新"必须有这一层中继：服务端替它们把安装包拉下来，
 * 客户端再从 `/client/download/:version` 取。
 */
router.get(
  '/client/releases',
  requireAnyPermission('client:read', 'client:manage', 'client:update-push'),
  async (_req, res) => {
    sendOk(res, await clientReleases.listReleases(), '获取安装包列表成功');
  },
);

/**
 * POST /api/update/client/fetch - 让服务端从 GitHub 下载某个版本的客户端安装包并登记
 *
 * 服务端（Node）不受浏览器 CSP 约束，这是唯一能"一键代下"的地方；
 * 下不动（学校出口没有外网）时退回 `POST /client/releases` 手工登记。
 */
router.post(
  '/client/fetch',
  requireAdmin(),
  requirePermission('client:update'),
  validate({ body: fetchClientReleaseSchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const input = validatedBody<FetchClientReleaseInput>(req);
    try {
      sendCreated(res, await clientReleases.fetchReleaseFromGithub(user, input), '安装包已下载并登记');
    } catch (error) {
      if (
        !(error instanceof ApiError && error.status === 409) &&
        getReleaseProgress().version === input.version
      )
        setReleaseProgress({
          stage: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
      throw error;
    }
  },
);

/**
 * POST /api/update/client/releases - 登记一份已经放进磁盘的安装包
 *
 * 文件要求放在 `<serverRoot>/../data/client-releases/<版本>/` 下（文件名默认按发布约定推导）。
 * 这条路径也是自动化验收用的：不需要外网、不需要传 100MB 二进制。
 */
router.post(
  '/client/releases',
  requireAdmin(),
  requirePermission('client:update'),
  validate({ body: registerClientReleaseSchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const input = validatedBody<RegisterClientReleaseInput>(req);
    sendCreated(res, await clientReleases.registerRelease(user, input), '安装包已登记');
  },
);

/** DELETE /api/update/client/releases/:version - 删除缓存（元数据 + 磁盘文件） */
router.delete(
  '/client/releases/:version',
  requireAdmin(),
  requirePermission('client:update'),
  validate({ params: clientReleaseVersionParamSchema }),
  async (req, res) => {
    const { version } = validatedParams<{ version: string }>(req);
    sendOk(res, await clientReleases.deleteRelease(getAuthUser(req), version), '安装包已删除');
  },
);

/**
 * GET /api/update/client/download/:version - 下载安装包（客户端自动更新走它）
 *
 * **故意不挂权限键**：下载方是教室里的班级端会话（角色 CLASS_DEVICE，权限集为空），
 * 它代表那个班；真正的保护是"必须已登录 + 限流中间件"。
 * `res.download` 自带 Content-Length / Range 支持，不需要另写流式助手。
 */
router.get(
  '/client/download/:version',
  validate({ params: clientReleaseVersionParamSchema }),
  async (req, res, next) => {
    const user = getAuthUser(req);
    if (user.role === 'CLASS_DEVICE') assertClassDevice(user, user.classId ?? user.sub);
    else {
      await assertPermission(user, 'client:read');
      if (user.role !== 'ADMIN' && !(await classIdsFor(user, 'client:read')).length)
        throw ApiError.forbidden('无可访问班级');
    }
    const { version } = validatedParams<{ version: string }>(req);
    const found = await clientReleases.resolveReleaseFile(version);
    if (!found) throw ApiError.notFound('服务端没有缓存这个版本的安装包');
    res.download(
      path.basename(found.file),
      found.fileName,
      { root: path.dirname(found.file), dotfiles: 'allow' },
      (error) => {
        if (!error || res.destroyed) return;
        if (res.headersSent) {
          res.destroy(error);
          return;
        }
        // 文件可能在解析元数据后被移除；尚未发送响应时必须结束请求，不能让客户端一直等待。
        const code = (error as NodeJS.ErrnoException).code;
        next(
          code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR'
            ? ApiError.notFound('安装包文件不存在或无法读取，请重新缓存')
            : error,
        );
      },
    );
  },
);

export const updateModule = defineModule({
  name: 'update',
  basePath: '/update',
  router,
});
