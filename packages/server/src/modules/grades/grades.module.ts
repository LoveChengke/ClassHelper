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
  studentGradeParamSchema,
  studentGradeQuerySchema,
  updateGradeLevelsSchema,
  updateGradeSchema,
  type BulkCreateGradeInput,
  type CreateGradeInput,
  type UpdateGradeInput,
  type UpdateGradeLevelsInput,
} from './grades.schemas.js';
import * as gradeService from './grades.service.js';

const router = Router();
router.use(authenticate());

/** GET /api/grades/my - ClassHelper 班级端查看本班成绩（教师/管理员返回空数组） */
router.get('/my', async (req, res) => {
  const user = getAuthUser(req);
  sendOk(res, await gradeService.listMyGrades(user), '获取本班成绩成功');
});

/**
 * GET /api/grades/student/:studentNo?classId= - 按**学号**查询某学生的成绩明细
 *
 * 三类调用方共用这一个接口：
 * - 教师 / 管理员（Web 端"按学号查成绩"）；
 * - ClassHelper 班级端（教室机器，学生按学号查自己的明细）；
 * - 科任老师查自己班的学生。
 * 班级端需要该班打开 `studentGradeQueryEnabled`，否则 403。
 */
router.get(
  '/student/:studentNo',
  validate({ params: studentGradeParamSchema, query: studentGradeQuerySchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const { studentNo } = validatedParams<{ studentNo: string }>(req);
    const { classId } = validatedQuery<{ classId?: string }>(req);
    sendOk(
      res,
      await gradeService.getStudentGradeDetail(user, studentNo, classId),
      '获取学生成绩明细成功',
    );
  },
);

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

/** GET /api/grades?classId=&courseId=&studentId=&examName= - 成绩列表（教师） */
router.get(
  '/',
  requireRole('ADMIN', 'TEACHER'),
  validate({ query: listGradesQuerySchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const query = validatedQuery<{
      classId?: string;
      courseId?: string;
      studentId?: string;
      examName?: string;
    }>(req);
    sendOk(res, await gradeService.listGrades(user, query), '获取成绩列表成功');
  },
);

/** POST /api/grades - 录入单条成绩（仅自己任教科目） */
router.post('/', requireRole('ADMIN', 'TEACHER'), validate({ body: createGradeSchema }), async (req, res) => {
  const user = getAuthUser(req);
  sendCreated(
    res,
    await gradeService.createGrade(user, req.body as CreateGradeInput),
    '成绩录入成功，已实时推送',
  );
});

/**
 * PATCH /api/grades/levels - 批量修改等级
 *
 * 两种用法：`items` 逐条指定；或 `classId + examName + levelType` 整批重算。
 * 逐条改时按每条成绩自己的班级 + 科目判权限。
 */
router.patch(
  '/levels',
  requireRole('ADMIN', 'TEACHER'),
  validate({ body: updateGradeLevelsSchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const result = await gradeService.updateGradeLevels(user, req.body as UpdateGradeLevelsInput);
    sendOk(res, result, `已更新 ${result.updated} 条成绩的等级`);
  },
);

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

/** PATCH /api/grades/:id - 修改成绩（含单个改等级） */
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
