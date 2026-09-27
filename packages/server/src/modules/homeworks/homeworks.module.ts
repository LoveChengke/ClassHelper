import { Router } from 'express';
import { sendCreated, sendOk } from '../../lib/http.js';
import { idParamSchema } from '../../lib/schemas.js';
import { authenticate, getAuthUser, requireRole } from '../../middleware/auth.js';
import { validate, validatedParams, validatedQuery } from '../../middleware/validate.js';
import { defineModule } from '../module.types.js';
import {
  createHomeworkSchema,
  listHomeworkDaysQuerySchema,
  listHomeworksQuerySchema,
  updateHomeworkSchema,
  updateHomeworkStatusSchema,
  updateHomeworkSubmissionsSchema,
  type CreateHomeworkInput,
  type ListHomeworkDaysInput,
  type UpdateHomeworkInput,
  type UpdateHomeworkStatusInput,
  type UpdateHomeworkSubmissionsInput,
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
/**
 * GET /api/homeworks/days - 一段时间内"哪些天有作业"（客户端/Web 的日期选择器高亮）
 *
 * 必须注册在 /:id 之前，否则 "days" 会被当成作业 id 命中 /:id 路由。
 */
router.get('/days', validate({ query: listHomeworkDaysQuerySchema }), async (req, res) => {
  const user = getAuthUser(req);
  const query = validatedQuery<ListHomeworkDaysInput>(req);
  sendOk(res, await homeworkService.listHomeworkDays(user, query), '获取作业日历成功');
});

router.get('/:id', validate({ params: idParamSchema }), async (req, res) => {
  const user = getAuthUser(req);
  const { id } = validatedParams<{ id: string }>(req);
  sendOk(res, await homeworkService.getHomework(user, id), '获取作业详情成功');
});

/**
 * POST /api/homeworks - 发布作业（发布后广播 homework:new）
 *
 * 这里**不加 requireRole**：教室机器的班级账号也要能录入作业（需求「支持作业在客户端录入」），
 * 能不能发由服务层的 createHomework 判定（staff 或本班班级账号，其余 403）。
 */
router.post(
  '/',
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

/** GET /api/homeworks/:id/submissions - 提交名单（未交名单功能） */
router.get('/:id/submissions', validate({ params: idParamSchema }), async (req, res) => {
  const user = getAuthUser(req);
  const { id } = validatedParams<{ id: string }>(req);
  const result = await homeworkService.listHomeworkSubmissions(user, id);
  sendOk(res, result, `未交 ${result.notSubmitted.length} / ${result.total} 人`);
});

/** PATCH /api/homeworks/:id/submissions - 勾选未交名单（其余学生一律视为已交） */
router.patch(
  '/:id/submissions',
  validate({ params: idParamSchema, body: updateHomeworkSubmissionsSchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const { id } = validatedParams<{ id: string }>(req);
    const result = await homeworkService.updateHomeworkSubmissions(
      user,
      id,
      req.body as UpdateHomeworkSubmissionsInput,
    );
    sendOk(res, result, `已保存未交名单（未交 ${result.notSubmitted.length} 人）`);
  },
);

export const homeworksModule = defineModule({
  name: 'homeworks',
  basePath: '/homeworks',
  router,
});
