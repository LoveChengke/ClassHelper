import { Router } from 'express';
import { sendCreated, sendOk } from '../../lib/http.js';
import { idParamSchema } from '../../lib/schemas.js';
import { authenticate, getAuthUser, requireRole } from '../../middleware/auth.js';
import { validate, validatedParams, validatedQuery } from '../../middleware/validate.js';
import { defineModule } from '../module.types.js';
import {
  createStudentSchema,
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
 * - 写：管理员或**本班班主任**（服务层逐班判权限），调班与转出仅管理员。
 */
router.get(
  '/',
  requireRole('ADMIN', 'TEACHER'),
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
  requireRole('ADMIN', 'TEACHER'),
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
  requireRole('ADMIN'),
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
  requireRole('ADMIN'),
  validate({ body: transferOutStudentsSchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const result = await studentService.transferOutStudents(user, req.body as TransferOutStudentsInput);
    sendOk(res, result, `已办理 ${result.transferred} 名学生转出`);
  },
);

/** GET /api/students/:id/transfers - 单个学生的调班 / 转出历史 */
router.get(
  '/:id/transfers',
  requireRole('ADMIN', 'TEACHER'),
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
  requireRole('ADMIN', 'TEACHER'),
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
  requireRole('ADMIN', 'TEACHER'),
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
  requireRole('ADMIN', 'TEACHER'),
  validate({ params: idParamSchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const { id } = validatedParams<{ id: string }>(req);
    await studentService.deleteStudent(user, id);
    sendOk(res, { id }, '学生记录已删除');
  },
);

export const studentsModule = defineModule({
  name: 'students',
  basePath: '/students',
  router,
});
