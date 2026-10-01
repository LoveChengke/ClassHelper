import { Router } from 'express';
import { sendCreated, sendOk } from '../../lib/http.js';
import { idParamSchema } from '../../lib/schemas.js';
import { authenticate, getAuthUser, requireRole } from '../../middleware/auth.js';
import { validate, validatedParams, validatedQuery } from '../../middleware/validate.js';
import { defineModule } from '../module.types.js';
import {
  createStudentSchema,
  listStudentsQuerySchema,
  updateStudentSchema,
  type CreateStudentInput,
  type UpdateStudentInput,
} from './students.schemas.js';
import * as studentService from './students.service.js';
const router = Router();
router.use(authenticate());

/**
 * GET /api/students?classId=&keyword= - 学生名单
 *
 * 注意是**仅管理员**（不是教师/管理员）：学生名单自带用户名，而学生初始密码是统一的默认值，
 * 因此名单属于管理员专属数据；教师查看本班学生请用 `GET /api/classes/:id/students`
 * （那条按班级权限校验，班级设备也能读）。
 */
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

/** DELETE /api/students - 删除学生名单记录 */
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
