import { Router } from 'express';
import { sendCreated, sendOk } from '../../lib/http.js';
import { idParamSchema } from '../../lib/schemas.js';
import { authenticate, getAuthUser, requireRole } from '../../middleware/auth.js';
import { validate, validatedParams, validatedQuery } from '../../middleware/validate.js';
import { defineModule } from '../module.types.js';
import {
  createHomeworkSchema,
  listHomeworksQuerySchema,
  updateHomeworkSchema,
  updateHomeworkStatusSchema,
  type CreateHomeworkInput,
  type UpdateHomeworkInput,
  type UpdateHomeworkStatusInput,
} from './homeworks.schemas.js';
import * as homeworkService from './homeworks.service.js';

const router = Router();
router.use(authenticate());

/** GET /api/homeworks?classId=&courseId=&pendingOnly=&keyword= - 作业列表 */
router.get('/', validate({ query: listHomeworksQuerySchema }), async (req, res) => {
  const user = getAuthUser(req);
  const query = validatedQuery<{
    classId?: string;
    courseId?: string;
    pendingOnly: boolean;
    keyword?: string;
  }>(req);
  sendOk(res, await homeworkService.listHomeworks(user, query), '获取作业列表成功');
});

/** GET /api/homeworks/:id - 作业详情 */
router.get('/:id', validate({ params: idParamSchema }), async (req, res) => {
  const user = getAuthUser(req);
  const { id } = validatedParams<{ id: string }>(req);
  sendOk(res, await homeworkService.getHomework(user, id), '获取作业详情成功');
});

/** POST /api/homeworks - 发布作业（发布后广播 homework:new） */
router.post(
  '/',
  requireRole('ADMIN', 'TEACHER'),
  validate({ body: createHomeworkSchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    sendCreated(
      res,
      await homeworkService.createHomework(user, req.body as CreateHomeworkInput),
      '作业发布成功',
    );
  },
);

/** PATCH /api/homeworks/:id - 修改作业 */
router.patch(
  '/:id',
  requireRole('ADMIN', 'TEACHER'),
  validate({ params: idParamSchema, body: updateHomeworkSchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const { id } = validatedParams<{ id: string }>(req);
    sendOk(
      res,
      await homeworkService.updateHomework(user, id, req.body as UpdateHomeworkInput),
      '作业更新成功',
    );
  },
);

/** DELETE /api/homeworks/:id - 删除作业 */
router.delete(
  '/:id',
  requireRole('ADMIN', 'TEACHER'),
  validate({ params: idParamSchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const { id } = validatedParams<{ id: string }>(req);
    await homeworkService.deleteHomework(user, id);
    sendOk(res, { id }, '作业已删除');
  },
);

/** PATCH /api/homeworks/:id/status - 标记完成 / 取消完成 */
router.patch(
  '/:id/status',
  validate({ params: idParamSchema, body: updateHomeworkStatusSchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const { id } = validatedParams<{ id: string }>(req);
    const result = await homeworkService.updateHomeworkStatus(
      user,
      id,
      req.body as UpdateHomeworkStatusInput,
    );
    sendOk(res, result, result.completed ? '已标记为完成' : '已取消完成标记');
  },
);

export const homeworksModule = defineModule({
  name: 'homeworks',
  basePath: '/homeworks',
  router,
});
