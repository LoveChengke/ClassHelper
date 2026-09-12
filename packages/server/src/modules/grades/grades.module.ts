import { Router } from 'express';
import { sendCreated, sendOk } from '../../lib/http.js';
import { idParamSchema } from '../../lib/schemas.js';
import { authenticate, getAuthUser, requireRole } from '../../middleware/auth.js';
import { validate, validatedParams, validatedQuery } from '../../middleware/validate.js';
import { defineModule } from '../module.types.js';
import {
  bulkCreateGradeSchema,
  createGradeSchema,
  listGradesQuerySchema,
  statsQuerySchema,
  updateGradeSchema,
  type BulkCreateGradeInput,
  type CreateGradeInput,
  type UpdateGradeInput,
} from './grades.schemas.js';
import * as gradeService from './grades.service.js';

const router = Router();
router.use(authenticate());

/** GET /api/grades/my - 学生查看个人成绩（任意角色都可查自己的） */
router.get('/my', async (req, res) => {
  const user = getAuthUser(req);
  sendOk(res, await gradeService.listMyGrades(user), '获取个人成绩成功');
});

/** GET /api/grades/stats?classId=&courseId=&examName= - 成绩统计（图表） */
router.get(
  '/stats',
  requireRole('ADMIN', 'TEACHER'),
  validate({ query: statsQuerySchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const query = validatedQuery<{ classId?: string; courseId?: string; examName?: string }>(req);
    sendOk(res, await gradeService.getGradeStats(user, query), '获取成绩统计成功');
  },
);

/** GET /api/grades?classId=&courseId=&userId=&examName= - 成绩列表（教师） */
router.get(
  '/',
  requireRole('ADMIN', 'TEACHER'),
  validate({ query: listGradesQuerySchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const query = validatedQuery<{ classId?: string; courseId?: string; userId?: string; examName?: string }>(
      req,
    );
    sendOk(res, await gradeService.listGrades(user, query), '获取成绩列表成功');
  },
);

/** POST /api/grades - 录入单条成绩（广播 grade:updated） */
router.post('/', requireRole('ADMIN', 'TEACHER'), validate({ body: createGradeSchema }), async (req, res) => {
  const user = getAuthUser(req);
  sendCreated(
    res,
    await gradeService.createGrade(user, req.body as CreateGradeInput),
    '成绩录入成功，已实时推送',
  );
});

/** POST /api/grades/bulk - 批量录入 / 导入成绩 */
router.post(
  '/bulk',
  requireRole('ADMIN', 'TEACHER'),
  validate({ body: bulkCreateGradeSchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const grades = await gradeService.bulkCreateGrades(user, req.body as BulkCreateGradeInput);
    sendCreated(res, { count: grades.length, items: grades }, `已录入 ${grades.length} 条成绩`);
  },
);

/** PATCH /api/grades/:id - 修改成绩 */
router.patch(
  '/:id',
  requireRole('ADMIN', 'TEACHER'),
  validate({ params: idParamSchema, body: updateGradeSchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const { id } = validatedParams<{ id: string }>(req);
    sendOk(res, await gradeService.updateGrade(user, id, req.body as UpdateGradeInput), '成绩更新成功');
  },
);

/** DELETE /api/grades/:id - 删除成绩 */
router.delete(
  '/:id',
  requireRole('ADMIN', 'TEACHER'),
  validate({ params: idParamSchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const { id } = validatedParams<{ id: string }>(req);
    await gradeService.deleteGrade(user, id);
    sendOk(res, { id }, '成绩已删除');
  },
);

export const gradesModule = defineModule({
  name: 'grades',
  basePath: '/grades',
  router,
});
