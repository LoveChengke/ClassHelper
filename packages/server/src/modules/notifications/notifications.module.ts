import { Router } from 'express';
import { sendCreated, sendOk } from '../../lib/http.js';
import { idParamSchema } from '../../lib/schemas.js';
import { authenticate, getAuthUser, requirePermission } from '../../middleware/auth.js';
import { validate, validatedParams, validatedQuery } from '../../middleware/validate.js';
import { defineModule } from '../module.types.js';
import {
  bulkCreateNotificationSchema,
  createNotificationSchema,
  listNotificationsQuerySchema,
  notificationArchiveQuerySchema,
  notificationScopeQuerySchema,
  type BulkCreateNotificationInput,
  type CreateNotificationInput,
  type ListNotificationQuery,
  type NotificationArchiveQuery,
} from './notifications.schemas.js';
import * as notificationService from './notifications.service.js';

const router = Router();
router.use(authenticate());

/** GET /api/notifications?classId=&priority=&unreadOnly=&date=&from=&to=&createdBy= - 通知列表 */
router.get('/', validate({ query: listNotificationsQuerySchema }), async (req, res) => {
  const user = getAuthUser(req);
  const query = validatedQuery<ListNotificationQuery>(req);
  sendOk(res, await notificationService.listNotifications(user, query), '获取通知列表成功');
});

/** GET /api/notifications/days?classId=&from=&to=&createdBy= - 按天归档（日期 + 条数） */
router.get('/days', validate({ query: notificationArchiveQuerySchema }), async (req, res) => {
  const user = getAuthUser(req);
  const query = validatedQuery<NotificationArchiveQuery>(req);
  sendOk(res, await notificationService.listNotificationDays(user, query), '获取通知日期归档成功');
});

/** GET /api/notifications/creators?classId=&from=&to=&date= - 按发布人归档 */
router.get('/creators', validate({ query: notificationArchiveQuerySchema }), async (req, res) => {
  const user = getAuthUser(req);
  const query = validatedQuery<NotificationArchiveQuery>(req);
  sendOk(res, await notificationService.listNotificationCreators(user, query), '获取通知发布人归档成功');
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
  requirePermission('notification:publish'),
  validate({ body: createNotificationSchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const dto = await notificationService.createNotification(user, req.body as CreateNotificationInput);
    sendCreated(res, dto, '通知发布成功，已实时推送给学生');
  },
);

/** POST /api/notifications/bulk - 一次给多个班级发同一条通知（逐班结果，不整批回滚） */
router.post(
  '/bulk',
  requirePermission('notification:publish'),
  validate({ body: bulkCreateNotificationSchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const result = await notificationService.bulkCreateNotifications(
      user,
      req.body as BulkCreateNotificationInput,
    );
    sendCreated(res, result, `批量发布完成：成功 ${result.succeeded} 个班，失败 ${result.failed} 个班`);
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
  requirePermission('notification:delete'),
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
