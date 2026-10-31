import { Router } from 'express';
import { sendCreated, sendOk } from '../../lib/http.js';
import { idParamSchema } from '../../lib/schemas.js';
import {
  authenticate,
  getAuthUser,
  requireAdmin,
  requirePermission,
  requireAnyPermission,
} from '../../middleware/auth.js';
import { validate, validatedParams, validatedQuery } from '../../middleware/validate.js';
import { defineModule } from '../module.types.js';
import {
  createTeacherSchema,
  listTeachersQuerySchema,
  resetTeacherPasswordSchema,
  updateTeacherSchema,
  type CreateTeacherInput,
  type ResetTeacherPasswordInput,
  type UpdateTeacherInput,
} from './teachers.schemas.js';
import * as teacherService from './teachers.service.js';

const router = Router();
router.use(authenticate());

/** 教师列表使用 teacher:read/teacher:manage，写入统一要求 teacher:manage；额外业务约束见 service。 */

/** GET /api/teachers?keyword= - 教师列表（教师管理页 + 分配协作教师时使用） */
router.get(
  '/',
  requireAnyPermission('teacher:read', 'teacher:manage'),
  validate({ query: listTeachersQuerySchema }),
  async (req, res) => {
    const { keyword } = validatedQuery<{ keyword?: string }>(req);
    sendOk(res, await teacherService.listTeachers(getAuthUser(req), keyword), '获取教师列表成功');
  },
);

/** POST /api/teachers - 录入教师账号（需 teacher:manage） */
router.post(
  '/',
  requireAdmin(),
  requirePermission('teacher:manage'),
  validate({ body: createTeacherSchema }),
  async (req, res) => {
    sendCreated(
      res,
      await teacherService.createTeacher(getAuthUser(req), req.body as CreateTeacherInput),
      '教师账号创建成功',
    );
  },
);

/** PATCH /api/teachers/:id - 编辑教师（姓名 / 用户名 / 角色） */
router.patch(
  '/:id',
  requireAdmin(),
  requirePermission('teacher:manage'),
  validate({ params: idParamSchema, body: updateTeacherSchema }),
  async (req, res) => {
    const { id } = validatedParams<{ id: string }>(req);
    sendOk(
      res,
      await teacherService.updateTeacher(getAuthUser(req), id, req.body as UpdateTeacherInput),
      '教师信息更新成功',
    );
  },
);

/** POST /api/teachers/:id/reset-password - 重置教师密码 */
router.post(
  '/:id/reset-password',
  requireAdmin(),
  requirePermission('teacher:manage'),
  validate({ params: idParamSchema, body: resetTeacherPasswordSchema }),
  async (req, res) => {
    const { id } = validatedParams<{ id: string }>(req);
    await teacherService.resetTeacherPassword(getAuthUser(req), id, req.body as ResetTeacherPasswordInput);
    sendOk(res, { id }, '密码已重置');
  },
);

/** DELETE /api/teachers/:id - 删除教师账号（有班级职责/课程时拒绝，见 service） */
router.delete(
  '/:id',
  requireAdmin(),
  requirePermission('teacher:manage'),
  validate({ params: idParamSchema }),
  async (req, res) => {
    const { id } = validatedParams<{ id: string }>(req);
    await teacherService.deleteTeacher(getAuthUser(req), id);
    sendOk(res, { id }, '教师账号已删除');
  },
);

export const teachersModule = defineModule({
  name: 'teachers',
  basePath: '/teachers',
  router,
});
