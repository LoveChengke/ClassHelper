import { Router } from 'express';
import { ApiError, sendCreated, sendOk } from '../../lib/http.js';
import { idParamSchema } from '../../lib/schemas.js';
import { authenticate, getAuthUser, requirePermission } from '../../middleware/auth.js';
import { validate, validatedParams, validatedQuery } from '../../middleware/validate.js';
import { defineModule } from '../module.types.js';
import {
  createStudentSchema,
  transferInSchema,
  restoreStudentSchema,
  deleteStudentQuerySchema,
  listStudentsQuerySchema,
  listTransfersQuerySchema,
  transferOutStudentsSchema,
  transferStudentsSchema,
  updateStudentSchema,
  type CreateStudentInput,
  type ListStudentsQuery,
  type ListTransfersQuery,
  type TransferOutStudentsInput,
  type TransferStudentsInput,
  type UpdateStudentInput,
} from './students.schemas.js';
import * as studentService from './students.service.js';

const router = Router();
router.use(authenticate());

/**
 * 学生名单。
 *
 * - 学生**没有账号**：这里是"名单记录"的增删改，没有任何密码/角色字段；
 * - 读：教师/管理员按自己可访问的班级过滤（服务层 `resolveClassScope`）；
 *   教室机器读本班名单请用 `GET /api/classes/:id/students`；
 * - 写：管理员或**本班班主任**（服务层逐班判权限），调班与转出还需覆盖源班和目标班。
 */
router.get(
  '/',
  requirePermission('roster:read'),
  validate({ query: listStudentsQuerySchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const query = validatedQuery<ListStudentsQuery>(req);
    sendOk(res, await studentService.listStudents(user, query), '获取学生列表成功');
  },
);

/** GET /api/students/transfers - 调班 / 转出历史（管理员看全部，也可按学生或班级过滤） */
router.get(
  '/transfers',
  requirePermission('roster:read'),
  validate({ query: listTransfersQuerySchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const query = validatedQuery<ListTransfersQuery>(req);
    sendOk(res, await studentService.listTransfers(user, query), '获取调班历史成功');
  },
);

/**
 * POST /api/students/transfer - 调班（单个与批量同一接口）
 *
 * 只改学生当前班级：**学号不变、不创建账号**，原班级/新班级/操作人/时间记入历史；
 * 历史作业与成绩保留原归属。
 */
router.post(
  '/transfer',
  requirePermission('roster:manage'),
  validate({ body: transferStudentsSchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const result = await studentService.transferStudents(user, req.body as TransferStudentsInput);
    sendOk(res, result, `已调动 ${result.moved} 名学生`);
  },
);

/** POST /api/students/transfer-out - 学生转出（学籍离开本校，不是调班） */
router.post(
  '/transfer-out',
  requirePermission('roster:manage'),
  validate({ body: transferOutStudentsSchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const result = await studentService.transferOutStudents(user, req.body as TransferOutStudentsInput);
    sendOk(res, result, `已办理 ${result.transferred} 名学生转出`);
  },
);

router.post(
  '/transfer-in',
  requirePermission('roster:manage'),
  validate({ body: transferInSchema }),
  async (req, res) => sendCreated(res, await studentService.transferInStudent(getAuthUser(req), req.body)),
);
router.post(
  '/:id/restore',
  requirePermission('roster:manage'),
  validate({ params: idParamSchema, body: restoreStudentSchema }),
  async (req, res) =>
    sendOk(res, await studentService.restoreStudent(getAuthUser(req), String(req.params.id), req.body)),
);

/** GET /api/students/:id/transfers - 单个学生的调班 / 转出历史 */
router.get(
  '/:id/transfers',
  requirePermission('roster:read'),
  validate({ params: idParamSchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const { id } = validatedParams<{ id: string }>(req);
    const result = await studentService.listTransfers(user, { studentId: id, pageSize: 200 });
    sendOk(res, result, '获取该生调班历史成功');
  },
);

/** POST /api/students - 新建学生（名单记录，不是账号） */
router.post(
  '/',
  requirePermission('roster:manage'),
  validate({ body: createStudentSchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    sendCreated(
      res,
      await studentService.createStudent(user, req.body as CreateStudentInput),
      '学生已加入名单',
    );
  },
);

/** PATCH /api/students/:id - 修改学生信息 / 调班 */
router.patch(
  '/:id',
  requirePermission('roster:manage'),
  (req, _res, next) => {
    if (req.body && ('classId' in req.body || 'status' in req.body))
      return next(ApiError.badRequest('班级和状态请使用调班、转出或复学接口修改'));
    next();
  },
  validate({ params: idParamSchema, body: updateStudentSchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const { id } = validatedParams<{ id: string }>(req);
    sendOk(
      res,
      await studentService.updateStudent(user, id, req.body as UpdateStudentInput),
      '学生信息更新成功',
    );
  },
);

/** DELETE /api/students/:id - 删除学生名单记录 */
router.delete(
  '/:id',
  requirePermission('roster:manage'),
  validate({ params: idParamSchema, query: deleteStudentQuerySchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const { id } = validatedParams<{ id: string }>(req);
    const query = validatedQuery<{ hard?: string; confirm?: string }>(req);
    await studentService.deleteStudent(user, id, {
      hard: query.hard === 'true',
      confirm: query.confirm === 'true',
    });
    sendOk(res, { id }, '学生名单操作已完成');
  },
);

export const studentsModule = defineModule({
  name: 'students',
  basePath: '/students',
  router,
});
