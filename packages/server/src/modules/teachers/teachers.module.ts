import { Router } from 'express';
import { sendCreated, sendOk } from '../../lib/http.js';
import { idParamSchema } from '../../lib/schemas.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
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

/**
 * 教师账号管理：**全部接口仅管理员**。
 * 学生端主体是班级，但教师账号决定谁是哪班班主任、谁能录课表/成绩，属于系统级配置，
 * 因此录入/修改/重置密码/删除都只开放给 ADMIN（路由层 + 前端菜单双重收敛）。
 */

/** GET /api/teachers?keyword= - 教师列表（教师管理页 + 分配协作教师时使用） */
router.get('/', requireRole('ADMIN'), validate({ query: listTeachersQuerySchema }), async (req, res) => {
  const { keyword } = validatedQuery<{ keyword?: string }>(req);
  sendOk(res, await teacherService.listTeachers(keyword), '获取教师列表成功');
});

/** POST /api/teachers - 录入教师账号（仅管理员） */
router.post('/', requireRole('ADMIN'), validate({ body: createTeacherSchema }), async (req, res) => {
  sendCreated(res, await teacherService.createTeacher(req.body as CreateTeacherInput), '教师账号创建成功');
});

/** PATCH /api/teachers/:id - 编辑教师（姓名 / 用户名 / 角色） */
router.patch(
  '/:id',
  requireRole('ADMIN'),
  validate({ params: idParamSchema, body: updateTeacherSchema }),
  async (req, res) => {
    const { id } = validatedParams<{ id: string }>(req);
    sendOk(res, await teacherService.updateTeacher(id, req.body as UpdateTeacherInput), '教师信息更新成功');
  },
);

/** POST /api/teachers/:id/reset-password - 重置教师密码 */
router.post(
  '/:id/reset-password',
  requireRole('ADMIN'),
  validate({ params: idParamSchema, body: resetTeacherPasswordSchema }),
  async (req, res) => {
    const { id } = validatedParams<{ id: string }>(req);
    await teacherService.resetTeacherPassword(id, req.body as ResetTeacherPasswordInput);
    sendOk(res, { id }, '密码已重置');
  },
);

/** DELETE /api/teachers/:id - 删除教师账号（有班级职责/课程时拒绝，见 service） */
router.delete('/:id', requireRole('ADMIN'), validate({ params: idParamSchema }), async (req, res) => {
  const { id } = validatedParams<{ id: string }>(req);
  await teacherService.deleteTeacher(id);
  sendOk(res, { id }, '教师账号已删除');
});

export const teachersModule = defineModule({
  name: 'teachers',
  basePath: '/teachers',
  router,
});
