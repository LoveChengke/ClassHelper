import { Router } from 'express';
import { sendCreated, sendOk } from '../../lib/http.js';
import { idParamSchema } from '../../lib/schemas.js';
import { authenticate, getAuthUser, requireRole } from '../../middleware/auth.js';
import { validate, validatedParams, validatedQuery } from '../../middleware/validate.js';
import { defineModule } from '../module.types.js';
import {
  createStudentSchema,
  listStudentsQuerySchema,
  resetPasswordSchema,
  updateStudentSchema,
  type CreateStudentInput,
  type ResetPasswordInput,
  type UpdateStudentInput,
} from './students.schemas.js';
import * as studentService from './students.service.js';

const router = Router();
router.use(authenticate());

/** GET /api/students?classId=&keyword= - 学生名单（教师/管理员） */
router.get('/', requireRole('ADMIN'), validate({ query: listStudentsQuerySchema }), async (req, res) => {
  const user = getAuthUser(req);
  const query = validatedQuery<{ classId?: string; keyword?: string }>(req);
  sendOk(res, await studentService.listStudents(user, query), '获取学生列表成功');
});

/** POST /api/students - 新建学生账号 */
router.post('/', requireRole('ADMIN'), validate({ body: createStudentSchema }), async (req, res) => {
  const user = getAuthUser(req);
  sendCreated(
    res,
    await studentService.createStudent(user, req.body as CreateStudentInput),
    '学生账号创建成功',
  );
});

/** PATCH /api/students/:id - 修改学生信息 / 调班 */
router.patch(
  '/:id',
  requireRole('ADMIN'),
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

/** POST /api/students/:id/reset-password - 重置密码 */
router.post(
  '/:id/reset-password',
  requireRole('ADMIN'),
  validate({ params: idParamSchema, body: resetPasswordSchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const { id } = validatedParams<{ id: string }>(req);
    await studentService.resetPassword(user, id, req.body as ResetPasswordInput);
    sendOk(res, { id }, '密码已重置');
  },
);

/** DELETE /api/students/:id - 删除学生账号 */
router.delete('/:id', requireRole('ADMIN'), validate({ params: idParamSchema }), async (req, res) => {
  const user = getAuthUser(req);
  const { id } = validatedParams<{ id: string }>(req);
  await studentService.deleteStudent(user, id);
  sendOk(res, { id }, '学生账号已删除');
});

export const studentsModule = defineModule({
  name: 'students',
  basePath: '/students',
  router,
});
