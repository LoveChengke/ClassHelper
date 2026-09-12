import { Router } from 'express';
import { sendCreated, sendOk } from '../../lib/http.js';
import { authenticate, getAuthUser, requireRole } from '../../middleware/auth.js';
import { validate, validatedQuery } from '../../middleware/validate.js';
import { defineModule } from '../module.types.js';
import { createTeacherSchema, listTeachersQuerySchema, type CreateTeacherInput } from './teachers.schemas.js';
import * as teacherService from './teachers.service.js';

const router = Router();
router.use(authenticate());

/** GET /api/teachers?keyword= - 教师列表（分配协作教师时使用） */
router.get('/', requireRole('ADMIN'), validate({ query: listTeachersQuerySchema }), async (req, res) => {
  const { keyword } = validatedQuery<{ keyword?: string }>(req);
  sendOk(res, await teacherService.listTeachers(keyword), '获取教师列表成功');
});

/** POST /api/teachers - 新建教师账号（仅管理员） */
router.post('/', requireRole('ADMIN'), validate({ body: createTeacherSchema }), async (req, res) => {
  getAuthUser(req);
  sendCreated(res, await teacherService.createTeacher(req.body as CreateTeacherInput), '教师账号创建成功');
});

export const teachersModule = defineModule({
  name: 'teachers',
  basePath: '/teachers',
  router,
});
