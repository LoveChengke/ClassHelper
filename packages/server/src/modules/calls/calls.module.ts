import { Router } from 'express';
import { sendCreated } from '../../lib/http.js';
import { authenticate, getAuthUser, requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { defineModule } from '../module.types.js';
import { createCallSchema, type CreateCallInput } from './calls.schemas.js';
import * as callService from './calls.service.js';

const router = Router();
router.use(authenticate());

/**
 * POST /api/calls - 叫人（老师点名让学生过来）
 * ClassHelper 班级端会在灵动岛上立即弹出"请 XXX 同学找 XXX 老师"，无论是否在上课。
 */
router.post('/', requireRole('ADMIN', 'TEACHER'), validate({ body: createCallSchema }), async (req, res) => {
  const user = getAuthUser(req);
  sendCreated(res, await callService.createCall(user, req.body as CreateCallInput), '已通知该学生');
});

export const callsModule = defineModule({
  name: 'calls',
  basePath: '/calls',
  router,
});
