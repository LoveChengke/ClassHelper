import { Router } from 'express';
import { sendCreated, sendOk } from '../../lib/http.js';
import { idParamSchema } from '../../lib/schemas.js';
import { authenticate, getAuthUser, requireRole } from '../../middleware/auth.js';
import { validate, validatedParams, validatedQuery } from '../../middleware/validate.js';
import { defineModule } from '../module.types.js';
import {
  createNotificationSchema,
  listNotificationsQuerySchema,
  notificationScopeQuerySchema,
  type CreateNotificationInput,
} from './notifications.schemas.js';
import * as notificationService from './notifications.service.js';

const router = Router();
router.use(authenticate());

/** GET /api/notifications?classId=&priority=&unreadOnly= - 通知列表 */
router.get('/', validate({ query: listNotificationsQuerySchema }), async (req, res) => {
  const user = getAuthUser(req);
  const query = validatedQuery<{
    classId?: string;
    priority?: string;
    unreadOnly: boolean;
    keyword?: string;
  }>(req);
  sendOk(res, await notificationService.listNotifications(user, query), '获取通知列表成功');
});

/** GET /api/notifications/unread-count?classId= - 未读数（客户端红点） */
router.get('/unread-count', validate({ query: notificationScopeQuerySchema }), async (req, res) => {
  const user = getAuthUser(req);
  const { classId } = validatedQuery<{ classId?: string }>(req);
  sendOk(res, { count: await notificationService.unreadCount(user, classId) }, '获取未读数成功');
});

/** POST /api/notifications/read-all - 全部标为已读 */
router.post('/read-all', validate({ body: notificationScopeQuerySchema }), async (req, res) => {
  const user = getAuthUser(req);
  const { classId } = (req.body ?? {}) as { classId?: string };
  sendOk(res, await notificationService.markAllAsRead(user, classId), '已全部标为已读');
});

/** POST /api/notifications - 发布通知（发布后广播 notification:new） */
router.post(
  '/',
  requireRole('ADMIN', 'TEACHER'),
  validate({ body: createNotificationSchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const dto = await notificationService.createNotification(user, req.body as CreateNotificationInput);
    sendCreated(res, dto, '通知发布成功，已实时推送给学生');
  },
);

/** POST /api/notifications/:id/read - 标记已读 */
router.post('/:id/read', validate({ params: idParamSchema }), async (req, res) => {
  const user = getAuthUser(req);
  const { id } = validatedParams<{ id: string }>(req);
  sendOk(res, await notificationService.markAsRead(user, id), '已标记为已读');
});

/** DELETE /api/notifications/:id - 删除通知 */
router.delete(
  '/:id',
  requireRole('ADMIN', 'TEACHER'),
  validate({ params: idParamSchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const { id } = validatedParams<{ id: string }>(req);
    await notificationService.deleteNotification(user, id);
    sendOk(res, { id }, '通知已删除');
  },
);

export const notificationsModule = defineModule({
  name: 'notifications',
  basePath: '/notifications',
  router,
});
