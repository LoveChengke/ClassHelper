import { Router } from 'express';
import { sendOk, sendCreated } from '../../lib/http.js';
import { idParamSchema } from '../../lib/schemas.js';
import {
  authenticate,
  getAuthUser,
  requireRole,
  requirePermission,
  requirePermissionOrClassDevice,
} from '../../middleware/auth.js';
import { validate, validatedBody, validatedQuery, validatedParams } from '../../middleware/validate.js';
import { defineModule } from '../module.types.js';
import {
  coursewareDeviceQuery,
  coursewareScopeSchema,
  coursewareUploadQuery,
  coursewareFolderSchema,
  coursewareMoveSchema,
} from './courseware.schemas.js';
import type { CoursewareUploadRequest } from '@classhelper/shared';
import * as service from './courseware.service.js';
const router = Router();
router.use(authenticate());
const staff = [requireRole('ADMIN', 'TEACHER'), requirePermission('courseware:write')];
router.get('/', requirePermissionOrClassDevice('courseware:read'), async (req, res) =>
  sendOk(res, await service.listCourseware(getAuthUser(req))),
);
router.get('/classes', ...staff, async (req, res) =>
  sendOk(res, await service.teachingClasses(getAuthUser(req))),
);
router.get('/folders', ...staff, async (req, res) =>
  sendOk(res, await service.listFolders(getAuthUser(req))),
);
router.post('/folders', ...staff, validate({ body: coursewareFolderSchema }), async (req, res) =>
  sendCreated(res, await service.createFolder(getAuthUser(req), validatedBody<{ path: string }>(req).path)),
);
router.patch(
  '/:id/folder',
  ...staff,
  validate({ params: idParamSchema, body: coursewareMoveSchema }),
  async (req, res) =>
    sendOk(
      res,
      await service.moveCourseware(
        getAuthUser(req),
        validatedParams<{ id: string }>(req).id,
        validatedBody<{ folderPath: string }>(req).folderPath,
      ),
    ),
);
router.get(
  '/transfers',
  requireRole('CLASS_DEVICE'),
  validate({ query: coursewareDeviceQuery }),
  async (req, res) =>
    sendOk(
      res,
      await service.pendingTransfers(getAuthUser(req), validatedQuery<{ deviceKey: string }>(req).deviceKey),
    ),
);
router.post(
  '/transfers/:id/ack',
  requireRole('CLASS_DEVICE'),
  validate({ params: idParamSchema, body: coursewareDeviceQuery }),
  async (req, res) => {
    await service.acknowledgeTransfer(
      getAuthUser(req),
      validatedParams<{ id: string }>(req).id,
      validatedBody<{ deviceKey: string }>(req).deviceKey,
    );
    sendOk(res, null);
  },
);
router.post('/upload', ...staff, validate({ query: coursewareUploadQuery }), async (req, res) =>
  sendCreated(
    res,
    await service.uploadCourseware(
      getAuthUser(req),
      validatedQuery<{ metadata: CoursewareUploadRequest }>(req).metadata,
      req,
    ),
  ),
);
router.get(
  '/:id/download',
  requirePermissionOrClassDevice('courseware:read'),
  validate({ params: idParamSchema }),
  async (req, res, next) => {
    const row = await service.readable(
      getAuthUser(req),
      validatedParams<{ id: string }>(req).id,
      'courseware:read',
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.download(row.storagePath, row.name, { root: service.coursewareRoot, dotfiles: 'allow' }, (error) => {
      if (error && !res.headersSent) next(error);
    });
  },
);
router.patch(
  '/:id/visibility',
  ...staff,
  validate({ params: idParamSchema, body: coursewareScopeSchema }),
  async (req, res) =>
    sendOk(
      res,
      await service.setVisibility(
        getAuthUser(req),
        validatedParams<{ id: string }>(req).id,
        validatedBody<{ classIds: string[] }>(req).classIds,
      ),
    ),
);
router.post(
  '/:id/push',
  ...staff,
  validate({ params: idParamSchema, body: coursewareScopeSchema }),
  async (req, res) => {
    await service.pushCourseware(
      getAuthUser(req),
      validatedParams<{ id: string }>(req).id,
      validatedBody<{ classIds: string[] }>(req).classIds,
    );
    sendOk(res, null);
  },
);
router.delete('/:id', ...staff, validate({ params: idParamSchema }), async (req, res) => {
  await service.deleteCourseware(getAuthUser(req), validatedParams<{ id: string }>(req).id);
  sendOk(res, null);
});
router.get(
  '/:id',
  requirePermissionOrClassDevice('courseware:read'),
  validate({ params: idParamSchema }),
  async (req, res) =>
    sendOk(res, await service.getCourseware(getAuthUser(req), validatedParams<{ id: string }>(req).id)),
);
export const coursewareModule = defineModule({ name: 'courseware', basePath: '/courseware', router });
