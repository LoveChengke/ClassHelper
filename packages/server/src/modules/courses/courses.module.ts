import { Router } from 'express';
import { sendCreated, sendOk } from '../../lib/http.js';
import { idParamSchema } from '../../lib/schemas.js';
import { authenticate, getAuthUser, requireRole } from '../../middleware/auth.js';
import { validate, validatedParams, validatedQuery } from '../../middleware/validate.js';
import { defineModule } from '../module.types.js';
import {
  createCourseSchema,
  listCoursesQuerySchema,
  updateCourseSchema,
  type CreateCourseInput,
  type UpdateCourseInput,
} from './courses.schemas.js';
import * as courseService from './courses.service.js';

const router = Router();
router.use(authenticate());

/** GET /api/courses?classId= - 课程列表 */
router.get('/', validate({ query: listCoursesQuerySchema }), async (req, res) => {
  const user = getAuthUser(req);
  const { classId } = validatedQuery<{ classId?: string }>(req);
  sendOk(res, await courseService.listCourses(user, classId), '获取课程列表成功');
});

/** POST /api/courses - 新增课程 */
router.post(
  '/',
  requireRole('ADMIN', 'TEACHER'),
  validate({ body: createCourseSchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    sendCreated(res, await courseService.createCourse(user, req.body as CreateCourseInput), '课程创建成功');
  },
);

/** PATCH /api/courses/:id - 修改课程 */
router.patch(
  '/:id',
  requireRole('ADMIN', 'TEACHER'),
  validate({ params: idParamSchema, body: updateCourseSchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const { id } = validatedParams<{ id: string }>(req);
    sendOk(res, await courseService.updateCourse(user, id, req.body as UpdateCourseInput), '课程更新成功');
  },
);

/** DELETE /api/courses/:id - 删除课程 */
router.delete(
  '/:id',
  requireRole('ADMIN', 'TEACHER'),
  validate({ params: idParamSchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const { id } = validatedParams<{ id: string }>(req);
    await courseService.deleteCourse(user, id);
    sendOk(res, { id }, '课程已删除');
  },
);

export const coursesModule = defineModule({
  name: 'courses',
  basePath: '/courses',
  router,
});
