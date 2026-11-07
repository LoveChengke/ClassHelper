import express, { type ErrorRequestHandler } from 'express';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { signToken, type TokenPayload } from '../../lib/jwt.js';
import { ApiError } from '../../lib/http.js';

/** 这里的每个入口都不修改业务数据。方法和路径不能由模型或调用方提供。 */
export const READ_ROUTES = {
  'classes.list': ['/classes', '班级列表'],
  'classes.detail': ['/classes/:id', '班级详情'],
  'classes.students': ['/classes/:id/students', '班级名单'],
  'courses.list': ['/courses', '课程列表'],
  'students.list': ['/students', '学生列表'],
  'students.transfers': ['/students/transfers', '调班记录'],
  'teachers.list': ['/teachers', '教师列表'],
  'homeworks.list': ['/homeworks', '作业列表'],
  'homeworks.detail': ['/homeworks/:id', '作业详情'],
  'homeworks.submissions': ['/homeworks/:id/submissions', '作业提交名单'],
  'notifications.list': ['/notifications', '通知列表'],
  'courseware.list': ['/courseware', '课件列表'],
  'courseware.classes': ['/courseware/classes', '可推送班级'],
  'courseware.folders': ['/courseware/folders', '课件文件夹'],
  'courseware.detail': ['/courseware/:id', '课件详情'],
  'grades.list': ['/grades', '成绩列表'],
  'grades.stats': ['/grades/stats', '成绩统计'],
  'grades.exams': ['/grades/exams', '考试列表'],
  'grades.ranking': ['/grades/ranking', '考试排名'],
  'grades.student': ['/grades/student/:studentNo', '学生成绩'],
  'plans.list': ['/class-plans', '课表列表'],
  'plans.profile': ['/class-plans/profile', '完整课表档案'],
  'plans.export': ['/class-plans/:id/export', '课表内容'],
  'schedules.grid': ['/schedules/grid', '当前周课表'],
  'schedules.scheduled': ['/schedules/scheduled', '预定和临时课表'],
  'layouts.list': ['/time-layouts', '时间表列表'],
  'groups.list': ['/class-plan-groups', '课表群组'],
  'groups.selection': ['/class-plan-groups/selection', '当前课表选择'],
  'term.weeks': ['/term', '学期周次'],
  'promotion.status': ['/term/promotion', '升学计划'],
  'promotion.preview': ['/term/promotion', '升级影响预览'],
  'archives.list': ['/archives', '毕业档案'],
  'archives.detail': ['/archives/:id', '档案详情'],
  'archives.transferred': ['/archives/transferred', '转出名单'],
  'archives.content': ['/archives/:id/classes/:classId/content', '历史班级内容'],
  'clients.list': ['/clients/devices', '客户端设备'],
  'clients.releases': ['/update/client/releases', '客户端安装包缓存'],
  'permissions.catalog': ['/permissions/catalog', '权限目录'],
  'permissions.groups': ['/permissions/groups', '岗位模板'],
  'permissions.users': ['/permissions/users', '账号权限'],
  'permissions.effective': ['/permissions/users/:id/effective', '账号有效权限'],
  'permissions.members': ['/permissions/groups/:id/members', '岗位成员'],
  'permissions.scopes': ['/permissions/scopes', '可分配范围'],
  'dashboard.summary': ['/dashboard', '工作台概览'],
} as const;
export type ReadAction = keyof typeof READ_ROUTES;

export function readPath(action: ReadAction, target: Record<string, string>): string {
  return READ_ROUTES[action][0].replace(/:([A-Za-z]+)/g, (_match, key: string) => {
    if (!target[key] || !/^[\p{L}\p{N}_-]+$/u.test(target[key]))
      throw ApiError.badRequest(`请明确目标 ${key}`);
    return encodeURIComponent(target[key]);
  });
}

/** 仅 GET 白名单，在进程内经过原路由的鉴权和校验，不监听端口。 */
export async function readBusinessAction(
  user: TokenPayload,
  action: string,
  target: Record<string, string> = {},
  query: Record<string, unknown> = {},
): Promise<unknown> {
  if (!Object.hasOwn(READ_ROUTES, action)) throw ApiError.forbidden('此动作不是允许的查询');
  const path = readPath(action as ReadAction, target);
  const { apiModules } = await import('../registry.js');
  const module = apiModules.find((item) => path === item.basePath || path.startsWith(`${item.basePath}/`));
  if (
    !module ||
    ['ai', 'auth', 'database', 'system'].includes(module.name) ||
    (module.name === 'update' && (action !== 'clients.releases' || path !== '/update/client/releases'))
  )
    throw ApiError.forbidden('禁止助手访问此模块');
  const app = express();
  app.use(`/api${module.basePath}`, module.router);
  return new Promise((resolve, reject) => {
    const onError: ErrorRequestHandler = (error, _req, _res, _next) => reject(error);
    app.use(onError);
    const req = new IncomingMessage(new Socket());
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query))
      if (value !== undefined && value !== null) search.set(key, String(value));
    req.url = `/api${path}${search.size ? `?${search}` : ''}`;
    req.method = 'GET';
    req.headers = { authorization: `Bearer ${signToken(user)}` };
    const res = new ServerResponse(req);
    res.end = ((chunk?: unknown) => {
      try {
        const response = JSON.parse(String(chunk ?? '{}')) as {
          data?: unknown;
          message?: string;
          code?: string;
        };
        if (res.statusCode >= 400)
          reject(new ApiError(res.statusCode, 'AI_READ_FAILED', response.message ?? '读取失败'));
        else resolve(response.data);
      } catch (error) {
        reject(error);
      }
      return res;
    }) as typeof res.end;
    app(req, res);
  });
}

export function redact(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !/password|token|secret|api.?key|passwordHash|storagePath/i.test(key))
        .map(([key, item]) => [key, redact(item)]),
    );
  return value;
}
