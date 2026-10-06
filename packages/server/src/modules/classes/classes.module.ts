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
  assignSubjectTeachersSchema,
  classStudentParamSchema,
  createClassSchema,
  listClassesQuerySchema,
  promoteClassesSchema,
  updateClassAccountSchema,
  updateClassSchema,
  updateNotificationChannelSchema,
  updateStudentGradeQuerySchema,
  type AddStudentInput,
  type AssignSubjectTeachersInput,
  type CreateClassInput,
  type UpdateClassAccountInput,
  type UpdateClassInput,
  type UpdateNotificationChannelInput,
  type UpdateStudentGradeQueryInput,
} from './classes.schemas.js';
import * as classService from './classes.service.js';

const router = Router();

// 班级相关接口统一需要登录
router.use(authenticate());

/**
 * GET /api/classes - 班级列表
 *
 * 只列**在读**班级（毕业归档的班级属于「归档管理」页）；
 * 教师/管理员看自己可访问的班级（班主任 ∪ 任课），ClassHelper 班级端看自己绑定的那个。
 */
router.get('/', validate({ query: listClassesQuerySchema }), async (req, res) => {
  const user = getAuthUser(req);
  const { keyword } = validatedQuery<{ keyword?: string }>(req);
  sendOk(res, await classService.listClasses(user, keyword), '获取班级列表成功');
});

/**
 * POST /api/classes/promote - 学年升级（批量改年级，仅管理员）
 *
 * **升级不归档、数据沿用**：只改 `grade`（高一 → 高二），班级记录、学生名单、学号、
 * 作业与成绩全部原样。归档只在毕业时由「归档管理」页显式执行。
 */
router.post(
  '/promote',
  requireRole('ADMIN'),
  validate({ body: promoteClassesSchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const body = validatedBody<{ classIds: string[]; grade: string }>(req);
    sendOk(res, await classService.promoteClasses(user, body), '班级已升级，数据继续沿用');
  },
);

/** GET /api/classes/:id - 班级详情（学生名单 + 课程 + 班主任 + 各科任课老师） */
router.get('/:id', validate({ params: idParamSchema }), async (req, res) => {
  const user = getAuthUser(req);
  const { id } = validatedParams<{ id: string }>(req);
  sendOk(res, await classService.getClassDetail(user, id), '获取班级详情成功');
});

/** POST /api/classes - 创建班级（称呼由入学年份 + 班号生成，如「2026级1班」） */
router.post('/', requireRole('ADMIN'), validate({ body: createClassSchema }), async (req, res) => {
  const user = getAuthUser(req);
  sendCreated(res, await classService.createClass(user, req.body as CreateClassInput), '班级创建成功');
});

/** PATCH /api/classes/:id - 编辑班级（年级 / 届别 / 教学周数），仅管理员 */
router.patch(
  '/:id',
  requireRole('ADMIN'),
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
  requireRole('ADMIN'),
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
 * 仅管理员：教室机器「ClassHelper 班级端」登录用的就是这个班级码
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
 * PATCH /api/classes/:id/head-teacher - 设置 / 更改班主任（每班 1 人）
 * 仅管理员：班主任决定谁能管这个班的学生名单与课表，属于人员分配权限
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
 * PUT /api/classes/:id/subject-teachers - 设置各科任课老师（班级 + 科目 + 教师）
 *
 * 仅管理员。这是「科任老师」这条关系的唯一写入口 —— 作业与成绩能不能被某位老师改动，
 * 查的就是这里写下的 `Course.teacherId`。
 * 班主任同时是某科科任老师时，两条记录指向同一个账号：不重复建号、权限自动合并。
 */
router.put(
  '/:id/subject-teachers',
  requireRole('ADMIN'),
  validate({ params: idParamSchema, body: assignSubjectTeachersSchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const { id } = validatedParams<{ id: string }>(req);
    sendOk(
      res,
      await classService.assignSubjectTeachers(user, id, validatedBody<AssignSubjectTeachersInput>(req)),
      '任课老师已更新',
    );
  },
);

/**
 * GET /api/classes/:id/classisland-status - 本班 ClassHelper 班级端 / ClassIsland 联动状态
 *
 * 教室机器（ClassHelper 班级端）也能读：客户端「设置 → ClassIsland 联动」据此显示状态。
 */
router.get('/:id/classisland-status', validate({ params: idParamSchema }), async (req, res) => {
  const user = getAuthUser(req);
  const { id } = validatedParams<{ id: string }>(req);
  sendOk(res, await classService.getClassIslandStatus(user, id), '获取联动状态成功');
});

/**
 * GET /api/classes/:id/notification-channel - 读取"通知显示到哪个端"
 *
 * 教室的 ClassHelper 班级端登录后会拉这个值，据此决定自己是弹窗/上岛还是静默；
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
 * **由教室的 ClassHelper 班级端自己选**，教师/管理员也可改。
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

/**
 * GET /api/classes/:id/student-grade-query - 本班是否允许班级端按学号查成绩明细
 * PATCH 同路径 - 开关它（班级端自己可改，教师/管理员也可改）
 */
router.get('/:id/student-grade-query', validate({ params: idParamSchema }), async (req, res) => {
  const user = getAuthUser(req);
  const { id } = validatedParams<{ id: string }>(req);
  sendOk(res, await classService.getStudentGradeQuery(user, id), '获取成绩查询开关成功');
});

router.patch(
  '/:id/student-grade-query',
  validate({ params: idParamSchema, body: updateStudentGradeQuerySchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const { id } = validatedParams<{ id: string }>(req);
    sendOk(
      res,
      await classService.updateStudentGradeQuery(
        user,
        id,
        validatedBody<UpdateStudentGradeQueryInput>(req),
      ),
      '成绩查询开关已更新',
    );
  },
);

/** GET /api/classes/:id/students - 班级学生名单 */
router.get('/:id/students', validate({ params: idParamSchema }), async (req, res) => {
  const user = getAuthUser(req);
  const { id } = validatedParams<{ id: string }>(req);
  sendOk(res, await classService.listClassStudents(user, id), '获取学生名单成功');
});

/** POST /api/classes/:id/students - 把学生加入班级（按学号，已存在则转入并留调班痕迹） */
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

/** DELETE /api/classes/:id/students/:studentId - 移出学生（回到「未分班」，名单记录保留） */
router.delete(
  '/:id/students/:studentId',
  requireRole('ADMIN', 'TEACHER'),
  validate({ params: classStudentParamSchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const { id, studentId } = validatedParams<{ id: string; studentId: string }>(req);
    await classService.removeStudent(user, id, studentId);
    sendOk(res, { classId: id, studentId }, '学生已移出班级');
  },
);

export const classesModule = defineModule({
  name: 'classes',
  basePath: '/classes',
  router,
});
