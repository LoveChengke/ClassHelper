import { Router } from 'express';
import { sendCreated, sendOk } from '../../lib/http.js';
import { idParamSchema } from '../../lib/schemas.js';
import { authenticate, getAuthUser, requireRole } from '../../middleware/auth.js';
import {
  validate,
  validatedBody,
  validatedParams,
  validatedQuery,
} from '../../middleware/validate.js';
import { defineModule } from '../module.types.js';
import {
  addStudentSchema,
  assignHeadTeacherSchema,
  assignTeacherSchema,
  classStudentParamSchema,
  classTeacherParamSchema,
  createClassSchema,
  listClassesQuerySchema,
  updateClassAccountSchema,
  updateClassSchema,
  updateNotificationChannelSchema,
  type AddStudentInput,
  type CreateClassInput,
  type UpdateClassAccountInput,
  type UpdateClassInput,
  type UpdateNotificationChannelInput,
} from './classes.schemas.js';
import * as classService from './classes.service.js';

const router = Router();

// 班级相关接口统一需要登录
router.use(authenticate());

/** GET /api/classes - 班级列表（教师/管理员：自己管理的班级；学生：自己所在班级） */
router.get('/', validate({ query: listClassesQuerySchema }), async (req, res) => {
  const user = getAuthUser(req);
  const { keyword } = validatedQuery<{ keyword?: string }>(req);
  sendOk(res, await classService.listClasses(user, keyword), '获取班级列表成功');
});

/** GET /api/classes/:id - 班级详情 */
router.get('/:id', validate({ params: idParamSchema }), async (req, res) => {
  const user = getAuthUser(req);
  const { id } = validatedParams<{ id: string }>(req);
  sendOk(res, await classService.getClassDetail(user, id), '获取班级详情成功');
});

/** POST /api/classes - 创建班级 */
router.post('/', requireRole('ADMIN'), validate({ body: createClassSchema }), async (req, res) => {
  const user = getAuthUser(req);
  sendCreated(res, await classService.createClass(user, req.body as CreateClassInput), '班级创建成功');
});

/** PATCH /api/classes/:id - 编辑班级 */
router.patch(
  '/:id',
  requireRole('ADMIN', 'TEACHER'),
  validate({ params: idParamSchema, body: updateClassSchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const { id } = validatedParams<{ id: string }>(req);
    sendOk(res, await classService.updateClass(user, id, req.body as UpdateClassInput), '班级更新成功');
  },
);

/** DELETE /api/classes/:id - 删除班级 */
router.delete(
  '/:id',
  requireRole('ADMIN', 'TEACHER'),
  validate({ params: idParamSchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const { id } = validatedParams<{ id: string }>(req);
    await classService.deleteClass(user, id);
    sendOk(res, { id }, '班级已删除');
  },
);

/**
 * PATCH /api/classes/:id/class-account - 设置 / 重置班级账号（班级码 + 班级密码）
 * 仅管理员：学生端「班级登录」用的就是这个班级码
 */
router.patch(
  '/:id/class-account',
  requireRole('ADMIN'),
  validate({ params: idParamSchema, body: updateClassAccountSchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const { id } = validatedParams<{ id: string }>(req);
    sendOk(
      res,
      await classService.updateClassAccount(user, id, req.body as UpdateClassAccountInput),
      '班级账号已更新',
    );
  },
);

/**
 * PATCH /api/classes/:id/head-teacher - 设置 / 更改班主任
 * 仅管理员：班主任决定谁能管这个班的课表与成绩，属于人员分配权限
 */
router.patch(
  '/:id/head-teacher',
  requireRole('ADMIN'),
  validate({ params: idParamSchema, body: assignHeadTeacherSchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const { id } = validatedParams<{ id: string }>(req);
    const { teacherId } = req.body as { teacherId: string };
    sendOk(res, await classService.updateHeadTeacher(user, id, teacherId), '班主任已更新');
  },
);

/**
 * GET /api/classes/:id/notification-channel - 读取"通知显示到哪个端"
 *
 * 教室的班级客户端登录后会拉这个值，据此决定自己是弹窗/上岛还是静默；
 * 教师/管理员也能读（Web 端展示用）。
 */
router.get('/:id/notification-channel', validate({ params: idParamSchema }), async (req, res) => {
  const user = getAuthUser(req);
  const { id } = validatedParams<{ id: string }>(req);
  sendOk(res, await classService.getNotificationChannel(user, id), '获取通知显示位置成功');
});

/**
 * PATCH /api/classes/:id/notification-channel - 设置"通知显示到哪个端"
 *
 * **由教室的班级客户端自己选**（班级账号可改），教师/管理员也可改；
 * 普通学生账号被拒（见 service 内的断言）。
 */
router.patch(
  '/:id/notification-channel',
  validate({ params: idParamSchema, body: updateNotificationChannelSchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const { id } = validatedParams<{ id: string }>(req);
    sendOk(
      res,
      await classService.updateNotificationChannel(
        user,
        id,
        validatedBody<UpdateNotificationChannelInput>(req),
      ),
      '通知显示位置已更新',
    );
  },
);

/** GET /api/classes/:id/students - 班级学生名单 */
router.get('/:id/students', validate({ params: idParamSchema }), async (req, res) => {
  const user = getAuthUser(req);
  const { id } = validatedParams<{ id: string }>(req);
  sendOk(res, await classService.listClassStudents(user, id), '获取学生名单成功');
});

/** POST /api/classes/:id/students - 添加学生（支持已存在账号转入） */
router.post(
  '/:id/students',
  requireRole('ADMIN', 'TEACHER'),
  validate({ params: idParamSchema, body: addStudentSchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const { id } = validatedParams<{ id: string }>(req);
    sendCreated(res, await classService.addStudent(user, id, req.body as AddStudentInput), '学生已加入班级');
  },
);

/** DELETE /api/classes/:id/students/:userId - 移出学生 */
router.delete(
  '/:id/students/:userId',
  requireRole('ADMIN', 'TEACHER'),
  validate({ params: classStudentParamSchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const { id, userId } = validatedParams<{ id: string; userId: string }>(req);
    await classService.removeStudent(user, id, userId);
    sendOk(res, { classId: id, userId }, '学生已移出班级');
  },
);

/** POST /api/classes/:id/teachers - 分配协作教师 */
router.post(
  '/:id/teachers',
  requireRole('ADMIN', 'TEACHER'),
  validate({ params: idParamSchema, body: assignTeacherSchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const { id } = validatedParams<{ id: string }>(req);
    const { teacherId } = req.body as { teacherId: string };
    await classService.assignTeacher(user, id, teacherId);
    sendCreated(res, { classId: id, teacherId }, '教师已分配');
  },
);

/** DELETE /api/classes/:id/teachers/:teacherId - 取消协作教师 */
router.delete(
  '/:id/teachers/:teacherId',
  requireRole('ADMIN', 'TEACHER'),
  validate({ params: classTeacherParamSchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const { id, teacherId } = validatedParams<{ id: string; teacherId: string }>(req);
    await classService.removeTeacher(user, id, teacherId);
    sendOk(res, { classId: id, teacherId }, '已取消教师分配');
  },
);

export const classesModule = defineModule({
  name: 'classes',
  basePath: '/classes',
  router,
});
