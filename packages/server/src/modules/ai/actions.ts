import { z } from 'zod';
import {
  clientReleaseFileName,
  type AiCapability,
  type AiOperation,
  type AiAttachment,
  type PermissionKey,
} from '@classhelper/shared';
import { prisma } from '../../lib/db.js';
import { activeStudentWhere } from '../../lib/students.js';
import { getMaxTermWeeks } from '../../lib/term.js';
import { ApiError } from '../../lib/http.js';
import type { TokenPayload } from '../../lib/jwt.js';
import {
  assertAdmin,
  assertPermission,
  assertAnyPermission,
  assertClassRead,
  assertContentWrite,
  assertHeadOnly,
  assertManage,
  assertPublish,
  isHead,
  loadAuthPrincipal,
} from '../../lib/authz/index.js';
import { assertCanManageRoster } from '../../lib/access.js';
import * as hw from '../homeworks/homeworks.schemas.js';
import * as nt from '../notifications/notifications.schemas.js';
import * as cl from '../classes/classes.schemas.js';
import * as st from '../students/students.schemas.js';
import * as te from '../teachers/teachers.schemas.js';
import * as co from '../courses/courses.schemas.js';
import * as gr from '../grades/grades.schemas.js';
import * as cp from '../class-plans/class-plans.schemas.js';
import * as cw from '../courseware/courseware.schemas.js';
import * as pe from '../permissions/permissions.schemas.js';
import * as tm from '../term/term.schemas.js';
import * as im from '../imports/imports.schemas.js';
import * as de from '../clients/clients.schemas.js';
import * as up from '../update/update.schemas.js';
import { inspectClientRelease } from '../update/client-releases.service.js';
import * as ar from '../archives/archives.schemas.js';
import { promotionConfigSchema, previewPromotion } from '../term/promotion.service.js';
import { createCallSchema } from '../calls/calls.schemas.js';
import { changePasswordSchema } from '../auth/auth.schemas.js';
import { assertLayoutWrite, requirePlan, validatePlanEntries } from '../class-plans/class-plans.service.js';
import { readable, teachingClasses } from '../courseware/courseware.service.js';
import { previewTable, IMPORT_FIELDS } from '../imports/table-import.service.js';
import { previewClassPlan } from '../imports/class-plan.service.js';
import { previewYamlClassPlan } from '../imports/class-plan-yaml.service.js';
import { previewClassIslandTimeLayout } from '../imports/time-layout.service.js';
import { READ_ROUTES, readBusinessAction, redact } from './business-read.js';

type Method = 'POST' | 'PATCH' | 'PUT' | 'DELETE';
interface WriteAction {
  label: string;
  method: Method;
  path: string;
  key: PermissionKey;
  schema: z.ZodType;
  admin?: boolean;
  dangerous?: boolean;
  sensitive?: string[];
}
const empty = z.object({});
const readSchemas: Record<string, z.ZodType> = {
  'classes.list': cl.listClassesQuerySchema,
  'courses.list': co.listCoursesQuerySchema,
  'students.list': st.listStudentsQuerySchema,
  'students.transfers': st.listTransfersQuerySchema,
  'teachers.list': te.listTeachersQuerySchema,
  'homeworks.list': hw.listHomeworksQuerySchema,
  'notifications.list': nt.listNotificationsQuerySchema,
  'grades.list': gr.listGradesQuerySchema,
  'grades.stats': gr.statsQuerySchema,
  'grades.exams': gr.examListQuerySchema,
  'grades.ranking': gr.examRankingQuerySchema,
  'grades.student': gr.studentGradeQuerySchema,
  'plans.list': cp.scopeQuery,
  'plans.profile': z.object({ classId: z.string().min(1) }),
  'layouts.list': cp.scopeQuery,
  'groups.list': z.object({ classId: z.string().min(1) }),
  'groups.selection': z.object({ classId: z.string().min(1) }),
  'term.weeks': tm.termQuerySchema,
  'promotion.preview': z.object({ year: z.number().int().min(2000).max(2100) }),
  'archives.list': ar.listArchivesQuerySchema,
  'archives.content': ar.archivedContentQuerySchema,
  'clients.list': de.listClientDevicesQuerySchema,
  'clients.releases': empty,
  'schedules.grid': z.object({
    classId: z.string().min(1).optional(),
    week: z.number().int().min(1).max(60).optional(),
  }),
  'schedules.scheduled': z.object({ classId: z.string().min(1) }),
};
const id = z.string().min(1).max(100);
function write(
  label: string,
  method: Method,
  path: string,
  key: PermissionKey,
  schema: z.ZodType = empty,
  extra: Partial<WriteAction> = {},
): WriteAction {
  return { label, method, path, key, schema, ...extra };
}

/** 写动作必须逐项登记；没有通用 HTTP、SQL、文件系统或服务器工具。 */
export const WRITE_ACTIONS: Record<string, WriteAction> = {
  'account.password': write('修改本人密码', 'PATCH', '/auth/password', 'ai:use', changePasswordSchema, {
    dangerous: true,
    sensitive: ['currentPassword', 'newPassword'],
  }),
  'classes.promote': write(
    '升级所选班级',
    'POST',
    '/classes/promote',
    'promotion:manage',
    cl.promoteClassesSchema,
    { admin: true, dangerous: true },
  ),
  'homeworks.create': write('布置作业', 'POST', '/homeworks', 'homework:write', hw.createHomeworkSchema),
  'homeworks.bulk': write(
    '跨班布置作业',
    'POST',
    '/homeworks/bulk',
    'homework:write',
    hw.bulkCreateHomeworkSchema,
  ),
  'homeworks.update': write('修改作业', 'PATCH', '/homeworks/:id', 'homework:write', hw.updateHomeworkSchema),
  'homeworks.delete': write('删除作业', 'DELETE', '/homeworks/:id', 'homework:write', empty, {
    dangerous: true,
  }),
  'homeworks.set-submissions': write(
    '维护未交名单',
    'PATCH',
    '/homeworks/:id/submissions',
    'homework:write',
    hw.updateHomeworkSubmissionsSchema,
  ),
  'notifications.create': write(
    '发布通知',
    'POST',
    '/notifications',
    'notification:publish',
    nt.createNotificationSchema,
  ),
  'notifications.bulk': write(
    '跨班发布通知',
    'POST',
    '/notifications/bulk',
    'notification:publish',
    nt.bulkCreateNotificationSchema,
  ),
  'notifications.delete': write('删除通知', 'DELETE', '/notifications/:id', 'notification:delete', empty, {
    dangerous: true,
  }),
  'calls.create': write('叫同学来', 'POST', '/calls', 'call:create', createCallSchema),
  'courseware.upload': write(
    '上传并推送课件',
    'POST',
    '/courseware/upload',
    'courseware:write',
    cw.coursewareUploadSchema,
  ),
  'courseware.push': write(
    '推送已有课件',
    'POST',
    '/courseware/:id/push',
    'courseware:write',
    cw.coursewareScopeSchema,
  ),
  'courseware.visibility': write(
    '修改课件可见范围',
    'PATCH',
    '/courseware/:id/visibility',
    'courseware:write',
    cw.coursewareScopeSchema,
  ),
  'courseware.move': write(
    '移动课件',
    'PATCH',
    '/courseware/:id/folder',
    'courseware:write',
    cw.coursewareMoveSchema,
  ),
  'courseware.folder': write(
    '新建课件文件夹',
    'POST',
    '/courseware/folders',
    'courseware:write',
    cw.coursewareFolderSchema,
  ),
  'courseware.delete': write('删除课件', 'DELETE', '/courseware/:id', 'courseware:write', empty, {
    dangerous: true,
  }),
  'classes.create': write('新建班级', 'POST', '/classes', 'class:manage', cl.createClassSchema, {
    admin: true,
  }),
  'classes.update': write('修改班级', 'PATCH', '/classes/:id', 'class:manage', cl.updateClassSchema, {
    admin: true,
  }),
  'classes.delete': write('删除班级', 'DELETE', '/classes/:id', 'class:manage', empty, {
    admin: true,
    dangerous: true,
  }),
  'classes.settings': write(
    '修改班级学期设置',
    'PATCH',
    '/classes/:id/settings',
    'class:settings',
    cl.updateClassSettingsSchema,
  ),
  'classes.account': write(
    '修改班级登录账号',
    'PATCH',
    '/classes/:id/class-account',
    'class:account',
    cl.updateClassAccountSchema,
    { dangerous: true, sensitive: ['password'] },
  ),
  'classes.head': write(
    '分配班主任',
    'PATCH',
    '/classes/:id/head-teacher',
    'class:manage',
    cl.assignHeadTeacherSchema,
    { admin: true, dangerous: true },
  ),
  'classes.subjects': write(
    '分配任课教师',
    'PUT',
    '/classes/:id/subject-teachers',
    'class:manage',
    cl.assignSubjectTeachersSchema,
    { admin: true, dangerous: true },
  ),
  'classes.grade-query': write(
    '设置个人成绩查询',
    'PATCH',
    '/classes/:id/student-grade-query',
    'grade:write',
    cl.updateStudentGradeQuerySchema,
  ),
  'classes.add-student': write(
    '添加班级学生',
    'POST',
    '/classes/:id/students',
    'roster:manage',
    cl.addStudentSchema,
  ),
  'classes.remove-student': write(
    '移出班级学生',
    'DELETE',
    '/classes/:id/students/:studentId',
    'roster:manage',
    empty,
    { dangerous: true },
  ),
  'courses.create': write('新建课程', 'POST', '/courses', 'schedule:write', co.createCourseSchema, {
    admin: true,
  }),
  'courses.update': write('修改课程', 'PATCH', '/courses/:id', 'schedule:write', co.updateCourseSchema),
  'courses.delete': write('删除课程', 'DELETE', '/courses/:id', 'schedule:write', empty, { dangerous: true }),
  'students.create': write('添加学生', 'POST', '/students', 'roster:manage', st.createStudentSchema),
  'students.update': write('修改学生资料', 'PATCH', '/students/:id', 'roster:manage', st.updateStudentSchema),
  'students.delete': write('移除学生', 'DELETE', '/students/:id', 'roster:manage', empty, {
    dangerous: true,
  }),
  'students.transfer': write(
    '学生调班',
    'POST',
    '/students/transfer',
    'roster:manage',
    st.transferStudentsSchema,
    { dangerous: true },
  ),
  'students.transfer-out': write(
    '学生转出',
    'POST',
    '/students/transfer-out',
    'roster:manage',
    st.transferOutStudentsSchema,
    { dangerous: true },
  ),
  'students.transfer-in': write(
    '学生转入',
    'POST',
    '/students/transfer-in',
    'roster:manage',
    st.transferInSchema,
  ),
  'students.restore': write(
    '学生复学',
    'POST',
    '/students/:id/restore',
    'roster:manage',
    st.restoreStudentSchema,
  ),
  'teachers.create': write('新建教师账号', 'POST', '/teachers', 'teacher:manage', te.createTeacherSchema, {
    admin: true,
    sensitive: ['password'],
  }),
  'teachers.update': write(
    '修改教师资料',
    'PATCH',
    '/teachers/:id',
    'teacher:manage',
    te.updateTeacherSchema,
    { admin: true },
  ),
  'teachers.password': write(
    '重置教师密码',
    'POST',
    '/teachers/:id/reset-password',
    'teacher:manage',
    te.resetTeacherPasswordSchema,
    { admin: true, dangerous: true, sensitive: ['newPassword'] },
  ),
  'teachers.delete': write('删除教师账号', 'DELETE', '/teachers/:id', 'teacher:manage', empty, {
    admin: true,
    dangerous: true,
  }),
  'grades.create': write('录入成绩', 'POST', '/grades', 'grade:write', gr.createGradeSchema),
  'grades.bulk': write('批量录入成绩', 'POST', '/grades/bulk', 'grade:write', gr.bulkCreateGradeSchema),
  'grades.update': write('修改成绩', 'PATCH', '/grades/:id', 'grade:write', gr.updateGradeSchema),
  'grades.delete': write('删除成绩', 'DELETE', '/grades/:id', 'grade:write', empty, { dangerous: true }),
  'grades.levels': write(
    '修改成绩等级',
    'PATCH',
    '/grades/levels',
    'grade:write',
    gr.updateGradeLevelsSchema,
  ),
  'grades.exam': write('修改考试总分口径', 'PUT', '/grades/exams', 'grade:write', gr.setExamSchema),
  'plans.create': write('新建课表', 'POST', '/class-plans', 'schedule:write', cp.planSchema),
  'plans.update': write('修改课表', 'PUT', '/class-plans/:id', 'schedule:write', cp.planSchema),
  'plans.entries': write(
    '调整课程安排',
    'PUT',
    '/class-plans/:id/entries',
    'schedule:write',
    cp.entriesSchema,
  ),
  'plans.enabled': write(
    '启停课表',
    'PATCH',
    '/class-plans/:id/enabled',
    'schedule:write',
    z.object({ enabled: z.boolean() }),
  ),
  'plans.clone': write('复制课表', 'POST', '/class-plans/:id/clone', 'schedule:write', cp.cloneSchema),
  'plans.delete': write('删除课表', 'DELETE', '/class-plans/:id', 'schedule:write', empty, {
    dangerous: true,
  }),
  'plans.import': write(
    '导入课表',
    'POST',
    '/class-plans/import',
    'schedule:write',
    z.object({ plan: cp.planSchema, entries: cp.entriesSchema.shape.entries }),
  ),
  'plans.import-profile': write(
    '导入完整课表档案',
    'POST',
    '/class-plans/import/profile',
    'schedule:write',
    z.object({ classId: id, payload: z.unknown(), mode: z.enum(['merge', 'replace']).default('merge') }),
  ),
  'layouts.create': write('新建时间表', 'POST', '/time-layouts', 'schedule:write', cp.layoutSchema),
  'layouts.update': write('修改时间表', 'PUT', '/time-layouts/:id', 'schedule:write', cp.layoutSchema),
  'layouts.clone': write('复制时间表', 'POST', '/time-layouts/:id/clone', 'schedule:write', cp.cloneSchema),
  'layouts.import': write(
    '导入时间点',
    'POST',
    '/time-layouts/:id/import',
    'schedule:write',
    cp.importLayoutSchema,
  ),
  'layouts.apply-default': write(
    '应用默认课程',
    'POST',
    '/time-layouts/:id/points/:pointId/apply-default',
    'schedule:write',
  ),
  'layouts.delete': write('删除时间表', 'DELETE', '/time-layouts/:id', 'schedule:write', empty, {
    dangerous: true,
  }),
  'groups.create': write('新建课表群组', 'POST', '/class-plan-groups', 'schedule:write', cp.groupSchema),
  'groups.update': write('修改课表群组', 'PUT', '/class-plan-groups/:id', 'schedule:write', cp.groupSchema),
  'groups.delete': write('删除课表群组', 'DELETE', '/class-plan-groups/:id', 'schedule:write', empty, {
    dangerous: true,
  }),
  'groups.select': write(
    '选择启用课表',
    'POST',
    '/class-plan-groups/select',
    'schedule:write',
    cp.groupSelectionSchema,
  ),
  'term.update': write('修改学期周次', 'PUT', '/term', 'term:write', tm.updateTermWeeksSchema),
  'term.auto': write('生成学期周次', 'POST', '/term/auto', 'term:write', tm.autoTermWeeksSchema),
  'promotion.configure': write(
    '配置学年升级',
    'PUT',
    '/term/promotion',
    'promotion:manage',
    promotionConfigSchema,
    { admin: true, dangerous: true },
  ),
  'promotion.run': write(
    '执行学年升级',
    'POST',
    '/term/promotion/run',
    'promotion:manage',
    z
      .object({
        year: z.number().int().min(2000).max(2100),
        planHash: z.string().length(64),
        confirm: z.literal(true),
        catchUp: z.boolean().optional(),
      })
      .strict(),
    { admin: true, dangerous: true },
  ),
  'schedules.schedule': write(
    '预定课表',
    'POST',
    '/schedules/scheduled',
    'schedule:write',
    cp.datedPlanSchema,
  ),
  'schedules.overlay': write(
    '创建临时课表',
    'POST',
    '/schedules/overlay',
    'schedule:write',
    cp.datedPlanSchema,
  ),
  'schedules.swap': write('临时换课', 'POST', '/schedules/swap', 'schedule:write', cp.swapSchema),
  'schedules.unschedule': write(
    '取消预定课表',
    'DELETE',
    '/schedules/scheduled/:id',
    'schedule:write',
    empty,
    { dangerous: true },
  ),
  'archives.restore': write(
    '撤销学生转出',
    'POST',
    '/archives/transferred/:id/restore',
    'roster:manage',
    st.restoreStudentSchema,
  ),
  'archives.delete': write('删除历史档案', 'DELETE', '/archives/:id', 'archive:manage', empty, {
    admin: true,
    dangerous: true,
  }),
  'permissions.create': write(
    '新建岗位模板',
    'POST',
    '/permissions/groups',
    'permission:manage',
    pe.createPermissionGroupSchema,
    { admin: true, dangerous: true },
  ),
  'permissions.update': write(
    '修改岗位模板',
    'PATCH',
    '/permissions/groups/:id',
    'permission:manage',
    pe.updatePermissionGroupSchema,
    { admin: true, dangerous: true },
  ),
  'permissions.delete': write(
    '删除岗位模板',
    'DELETE',
    '/permissions/groups/:id',
    'permission:manage',
    empty,
    { admin: true, dangerous: true },
  ),
  'permissions.assign': write(
    '分配岗位与范围',
    'PUT',
    '/permissions/users/:id/groups',
    'permission:manage',
    pe.assignUserGroupsSchema,
    { admin: true, dangerous: true },
  ),
  'clients.command': write(
    '设备远控',
    'POST',
    '/clients/commands',
    'remote:control',
    de.createClientCommandSchema,
    { dangerous: true },
  ),
  'clients.update': write(
    '推送客户端更新',
    'POST',
    '/clients/updates',
    'client:update-push',
    de.pushClientUpdateSchema,
    { dangerous: true },
  ),
  'clients.delete': write('移除设备登记', 'DELETE', '/clients/devices/:id', 'client:manage', empty, {
    dangerous: true,
  }),
  'clients.release-fetch': write(
    '缓存客户端安装包',
    'POST',
    '/update/client/fetch',
    'client:update',
    up.fetchClientReleaseSchema,
    { admin: true, dangerous: true },
  ),
  'clients.release-register': write(
    '登记客户端安装包',
    'POST',
    '/update/client/releases',
    'client:update',
    up.registerClientReleaseSchema,
    { admin: true, dangerous: true },
  ),
  'clients.release-delete': write(
    '删除客户端安装包缓存',
    'DELETE',
    '/update/client/releases/:version',
    'client:update',
    empty,
    { admin: true, dangerous: true },
  ),
  'imports.table': write('导入表格', 'POST', '/imports/table/commit', 'roster:manage', im.tableCommitSchema),
  'imports.yaml': write(
    '导入课表 YAML',
    'POST',
    '/imports/class-plan/yaml',
    'schedule:write',
    im.classPlanYamlImportSchema,
  ),
  'imports.plan': write(
    '导入课表 JSON',
    'POST',
    '/imports/class-plan',
    'schedule:write',
    im.classPlanImportSchema,
  ),
  'imports.layout': write(
    '导入时间表 JSON',
    'POST',
    '/imports/time-layout',
    'schedule:write',
    im.timeLayoutImportSchema,
  ),
};

const READ_KEYS: Record<string, PermissionKey> = {
  classes: 'class:read',
  schedules: 'schedule:read',
  courses: 'schedule:read',
  students: 'roster:read',
  teachers: 'teacher:read',
  homeworks: 'homework:read',
  notifications: 'notification:read',
  courseware: 'courseware:read',
  grades: 'grade:read',
  plans: 'schedule:read',
  layouts: 'schedule:read',
  groups: 'schedule:read',
  term: 'term:read',
  promotion: 'promotion:manage',
  archives: 'archive:manage',
  clients: 'client:read',
  permissions: 'permission:manage',
  dashboard: 'dashboard:read',
};
function readKey(action: string): PermissionKey {
  return action === 'classes.students'
    ? 'roster:read'
    : action === 'grades.student'
      ? 'student:grade-query'
      : action === 'courseware.classes' || action === 'courseware.folders'
        ? 'courseware:write'
        : action === 'homeworks.submissions'
          ? 'homework:write'
          : READ_KEYS[action.split('.')[0]!]!;
}
const CLIENT_CACHE_READ_KEYS: PermissionKey[] = ['client:read', 'client:manage', 'client:update-push'];
export function getWrite(action: string): WriteAction {
  if (!Object.hasOwn(WRITE_ACTIONS, action))
    throw ApiError.forbidden('助手不支持此操作，数据库和服务器维护仅可手动执行');
  return WRITE_ACTIONS[action]!;
}
export function actionPath(action: string, target: Record<string, string> = {}): string {
  return getWrite(action).path.replace(/:([A-Za-z]+)/g, (_match, key: string) => {
    if (key === 'version') return encodeURIComponent(up.clientReleaseVersionSchema.parse(target[key]));
    if (!target[key] || !/^[\p{L}\p{N}_-]+$/u.test(target[key]))
      throw ApiError.badRequest(`请明确目标 ${key}`);
    return encodeURIComponent(target[key]);
  });
}
export async function capabilities(user: TokenPayload): Promise<AiCapability[]> {
  await assertPermission(user, 'ai:use');
  const auth = await loadAuthPrincipal(user);
  const reads = Object.entries(READ_ROUTES)
    .filter(([action]) =>
      action === 'clients.releases'
        ? CLIENT_CACHE_READ_KEYS.some((key) => auth.permissions.has(key))
        : auth.permissions.has(readKey(action)),
    )
    .map(([action, route]) => ({
      action,
      label: route[1],
      kind: 'read' as const,
      dangerous: false,
      sensitiveFields: [],
      schema: {
        target: [...route[0].matchAll(/:([A-Za-z]+)/g)].map((item) => item[1]),
        query: z.toJSONSchema(readSchemas[action] ?? empty, { io: 'input', unrepresentable: 'any' }),
      },
    }));
  const writes = Object.entries(WRITE_ACTIONS)
    .filter(
      ([action, tool]) =>
        (!tool.admin || user.role === 'ADMIN') &&
        (auth.permissions.has(tool.key) ||
          (action === 'imports.table' &&
            ['grade:import', 'import:students', 'import:teachers', 'import:class-teachers'].some((key) =>
              auth.permissions.has(key as PermissionKey),
            )) ||
          (tool.path.startsWith('/term') && auth.permissions.has('class:settings')) ||
          (tool.path.startsWith('/time-layouts') && user.role === 'ADMIN')),
    )
    .map(([action, tool]) => ({
      action,
      label: tool.label,
      kind: 'write' as const,
      dangerous: !!tool.dangerous,
      sensitiveFields: tool.sensitive ?? [],
      schema: {
        target: [...tool.path.matchAll(/:([A-Za-z]+)/g)].map((item) => item[1]),
        params: z.toJSONSchema(tool.schema, { io: 'input', unrepresentable: 'any' }),
      },
    }));
  return [...reads, ...writes];
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
async function record<T>(value: Promise<T | null>): Promise<T> {
  const row = await value;
  if (!row) throw ApiError.notFound('目标记录不存在');
  return row;
}

export async function authorizeStoredResult(
  user: TokenPayload,
  operation: AiOperation,
  before?: unknown,
): Promise<void> {
  const tool = getWrite(operation.action),
    p = operation.params ?? {};
  const key: PermissionKey =
    operation.action === 'imports.table'
      ? p.kind === 'grades'
        ? 'grade:import'
        : p.kind === 'teachers'
          ? 'import:teachers'
          : p.kind === 'classTeachers'
            ? 'import:class-teachers'
            : 'import:students'
      : operation.action.startsWith('term.') && p.classId
        ? 'class:settings'
        : tool.key;
  if (tool.admin) assertAdmin(user);
  await assertPermission(user, key);
  const ids = new Set(strings(p.classIds));
  if (typeof p.classId === 'string') ids.add(p.classId);
  if (operation.action.startsWith('classes.') && operation.target?.id) {
    ids.add(operation.target.id);
    if (['classes.account', 'classes.settings'].includes(operation.action))
      await assertHeadOnly(user, key, operation.target.id);
  }
  if (p.plan && typeof p.plan === 'object' && 'classId' in p.plan && typeof p.plan.classId === 'string')
    ids.add(p.plan.classId);
  for (const row of Array.isArray(before) ? before : [before])
    if (row && typeof row === 'object' && typeof row.classId === 'string') ids.add(row.classId);
  for (const classId of ids) await assertClassRead(user, key, classId);
}

/** 预览和确认也执行资源级断言；最终写入继续经过原业务端点的完整校验。 */
export async function authorizeWrite(user: TokenPayload, operation: AiOperation): Promise<unknown> {
  const tool = getWrite(operation.action),
    p = operation.params ?? {},
    target = operation.target ?? {};
  const key =
    operation.action === 'imports.table'
      ? p.kind === 'grades'
        ? 'grade:import'
        : p.kind === 'teachers'
          ? 'import:teachers'
          : p.kind === 'classTeachers'
            ? 'import:class-teachers'
            : 'import:students'
      : tool.key;
  if (operation.action.startsWith('term.') && p.classId)
    await assertHeadOnly(user, 'class:settings', String(p.classId));
  else if (operation.action.startsWith('layouts.')) {
    if (user.role !== 'ADMIN') await assertPermission(user, 'schedule:write');
  } else await assertPermission(user, key);
  if (tool.admin) assertAdmin(user);
  let before: unknown;
  if (
    operation.action.startsWith('homeworks.') ||
    (operation.action.startsWith('grades.') && operation.action !== 'grades.exam')
  ) {
    const grade = operation.action.startsWith('grades.');
    const rows = [];
    if (target.id)
      rows.push(
        grade
          ? await record(prisma.grade.findUnique({ where: { id: target.id } }))
          : await record(prisma.homework.findUnique({ where: { id: target.id } })),
      );
    if (operation.action === 'grades.levels' && Array.isArray(p.items))
      for (const item of p.items as { id: string }[])
        rows.push(await record(prisma.grade.findUnique({ where: { id: item.id } })));
    for (const row of rows) await assertContentWrite(user, tool.key, row.classId, row.courseId, tool.label);
    const classId = string(p.classId) ?? rows[0]?.classId;
    if (classId)
      await assertContentWrite(
        user,
        tool.key,
        classId,
        Object.hasOwn(p, 'courseId') ? string(p.courseId) : rows[0]?.courseId,
        tool.label,
      );
    if (!classId && operation.action !== 'homeworks.bulk') throw ApiError.badRequest('请明确目标班级');
    if (operation.action === 'homeworks.bulk')
      for (const classId of strings(p.classIds)) {
        await assertClassRead(user, tool.key, classId);
        const course = p.subjectName
          ? await prisma.course.findFirst({ where: { classId, name: String(p.subjectName) } })
          : null;
        if (p.subjectName && !course) throw ApiError.badRequest('部分班级没有该科目，请调整目标班级');
        await assertContentWrite(user, tool.key, classId, course?.id ?? string(p.courseId), tool.label);
      }
    if (grade) {
      const studentIds = [
        ...(typeof p.studentId === 'string' ? [p.studentId] : []),
        ...(operation.action === 'grades.bulk' && Array.isArray(p.items)
          ? (p.items as { studentId: string }[]).map((item) => item.studentId)
          : []),
      ];
      const students = await prisma.student.findMany({
        where: { id: { in: studentIds }, classId, ...activeStudentWhere() },
        select: { id: true, name: true, classId: true, studentNo: true },
      });
      if (students.length !== new Set(studentIds).size) throw ApiError.badRequest('学生不属于目标班级');
      const previous = await Promise.all(
        rows.map(async (row) => ({
          ...row,
          ...('studentId' in row
            ? { studentName: (await prisma.student.findUnique({ where: { id: row.studentId } }))?.name }
            : {}),
        })),
      );
      before = previous.length ? (previous.length === 1 ? previous[0] : previous) : students;
    } else before = rows.length === 1 ? rows[0] : rows;
  } else if (operation.action === 'grades.exam') {
    await assertManage(user, 'grade:write', String(p.classId));
    before = await prisma.exam.findUnique({
      where: { classId_name: { classId: String(p.classId), name: String(p.name) } },
    });
  } else if (operation.action.startsWith('notifications.') || operation.action === 'calls.create') {
    if (target.id) {
      const row = await record(prisma.notification.findUnique({ where: { id: target.id } }));
      await assertClassRead(user, tool.key, row.classId);
      if (user.role !== 'ADMIN' && row.createdBy !== user.sub && !(await isHead(user, row.classId)))
        throw ApiError.forbidden('只有发布者、班主任或管理员可删除通知');
      before = row;
    } else
      for (const classId of p.classId ? [String(p.classId)] : strings(p.classIds))
        await assertPublish(user, tool.key, classId);
    if (p.studentId && p.classId) {
      const student = await prisma.student.findFirst({
        where: { id: String(p.studentId), classId: String(p.classId), ...activeStudentWhere() },
        select: { id: true, name: true, classId: true, studentNo: true },
      });
      if (!student) throw ApiError.badRequest('学生不属于目标班级');
      before = {
        studentId: student.id,
        studentName: student.name,
        classId: student.classId,
        studentNo: student.studentNo,
      };
    }
  } else if (operation.action.startsWith('courseware.')) {
    const allowed = new Set((await teachingClasses(user)).map((item) => item.id));
    for (const classId of strings(p.classIds))
      if (!allowed.has(classId)) throw ApiError.forbidden('只能推送到本人任教的班级');
    if (target.id) {
      const row = await readable(user, target.id, 'courseware:write');
      if (row.ownerId !== user.sub) throw ApiError.forbidden('只能修改自己的课件');
      before = row;
    }
  } else if (operation.action.startsWith('students.') || operation.action === 'archives.restore') {
    const studentIds = [
      ...strings(p.studentIds),
      ...(target.id ? [target.id] : []),
      ...(p.studentId ? [String(p.studentId)] : []),
    ];
    const rows = [];
    for (const id of studentIds) {
      const row = await record(prisma.student.findUnique({ where: { id } }));
      await assertCanManageRoster(user, row.classId ?? undefined);
      rows.push(row);
    }
    if (p.toClassId !== undefined) await assertCanManageRoster(user, string(p.toClassId));
    if (operation.action === 'students.create') await assertCanManageRoster(user, string(p.classId));
    before = rows;
  } else if (operation.action.startsWith('classes.')) {
    if (target.id) {
      if (['classes.settings', 'classes.account'].includes(operation.action))
        await assertHeadOnly(user, tool.key, target.id);
      else if (operation.action === 'classes.grade-query') await assertManage(user, tool.key, target.id);
      else if (operation.action.includes('student')) await assertCanManageRoster(user, target.id);
      else await assertClassRead(user, tool.key, target.id);
      before = await record(prisma.class.findUnique({ where: { id: target.id } }));
    }
  } else if (operation.action.startsWith('courses.')) {
    const row = target.id ? await record(prisma.course.findUnique({ where: { id: target.id } })) : null;
    await assertManage(user, 'schedule:write', String(row?.classId ?? p.classId));
    before = row;
  } else if (operation.action.startsWith('plans.') || operation.action.startsWith('groups.')) {
    if (target.id && operation.action.startsWith('plans.')) before = await requirePlan(user, target.id);
    if (operation.action === 'plans.entries')
      before = await validatePlanEntries(user, target.id!, cp.entriesSchema.parse(p));
    if (target.id && operation.action.startsWith('groups.')) {
      const row = await record(prisma.classPlanGroup.findUnique({ where: { id: target.id } }));
      await assertManage(user, 'schedule:write', row.classId);
      before = row;
    }
    const nested = p.plan && typeof p.plan === 'object' ? (p.plan as Record<string, unknown>) : p;
    if (nested.classId) await assertManage(user, 'schedule:write', String(nested.classId));
    if (['plans.create', 'plans.update', 'plans.import'].includes(operation.action)) {
      const maxWeeks = await getMaxTermWeeks();
      if (Number(nested.weekStart) > maxWeeks) throw ApiError.badRequest('起始周超过全校上限');
      nested.weekEnd = Math.min(Number(nested.weekEnd), maxWeeks);
    }
    if (p.isGlobal) assertAdmin(user);
    if (operation.action === 'plans.import' || operation.action === 'plans.import-profile')
      await assertPermission(user, 'import:schedule');
  } else if (operation.action.startsWith('layouts.')) {
    const row = target.id
      ? await record(
          prisma.timeLayout.findUnique({
            where: { id: target.id },
            include: { points: { orderBy: { position: 'asc' } } },
          }),
        )
      : null;
    await assertLayoutWrite(user, row ? row.classId : (string(p.classId) ?? null), target.id);
    before = row;
    if (p.classId !== undefined && row && p.classId !== row.classId)
      throw ApiError.forbidden('不可迁移时间表所属班级');
  } else if (operation.action.startsWith('term.')) {
    if (!p.classId) assertAdmin(user);
    before = await readBusinessAction(user, 'term.weeks', {}, p.classId ? { classId: p.classId } : {});
  } else if (operation.action.startsWith('clients.release-')) {
    const version = up.clientReleaseVersionSchema.parse(
      operation.action === 'clients.release-delete' ? target.version : p.version,
    );
    if (operation.action === 'clients.release-delete') operation.target = { ...target, version };
    const snapshot = await inspectClientRelease(
      user,
      {
        version,
        fileName:
          operation.action === 'clients.release-fetch' ? clientReleaseFileName(version) : string(p.fileName),
      },
      operation.action === 'clients.release-register',
    );
    if (operation.action === 'clients.release-delete' && !snapshot.current)
      throw ApiError.notFound('服务端没有这个版本的客户端安装包');
    before = snapshot;
  } else if (operation.action.startsWith('clients.')) {
    const ids = target.id ? [target.id] : strings(p.deviceIds);
    const devices = [];
    for (const id of ids) {
      const row = await record(prisma.clientDevice.findUnique({ where: { id } }));
      if (!row.classId) throw ApiError.forbidden('设备未绑定班级');
      await assertClassRead(user, tool.key, row.classId);
      devices.push({ id: row.id, name: row.name, classId: row.classId });
    }
    for (const classId of strings(p.classIds)) await assertClassRead(user, tool.key, classId);
    if (p.all && user.role !== 'ADMIN') throw ApiError.forbidden('请明确选择授权范围内的设备或班级');
    before = devices;
  } else if (operation.action.startsWith('schedules.')) {
    if (target.id) {
      const row = await record(prisma.scheduledClassPlan.findUnique({ where: { id: target.id } }));
      await assertManage(user, 'schedule:write', row.classId);
      before = row;
    } else {
      const plan = await requirePlan(user, String(p.classPlanId));
      if (plan.classId !== p.classId) throw ApiError.forbidden('课表不属于本班');
      before = plan;
    }
  } else if (operation.action.startsWith('imports.')) {
    if (['teachers', 'classTeachers'].includes(String(p.kind))) assertAdmin(user);
    else if (operation.action === 'imports.table') {
      if (p.kind === 'grades') {
        await assertPermission(user, 'grade:write');
        if (p.classId) await assertClassRead(user, 'grade:import', String(p.classId));
      } else {
        await assertPermission(user, 'roster:manage');
        await assertCanManageRoster(user, string(p.classId));
      }
    } else {
      await assertPermission(user, 'import:schedule');
      await assertManage(user, 'schedule:write', String(p.classId));
    }
  } else if (operation.action.startsWith('permissions.')) {
    assertAdmin(user);
    if (operation.action === 'permissions.assign')
      before = await readBusinessAction(user, 'permissions.effective', { id: target.id! });
    else if (target.id)
      before = await prisma.permissionGroup.findUnique({
        where: { id: target.id },
        include: { items: true },
      });
  } else if (operation.action.startsWith('teachers.') && target.id)
    before = await prisma.user.findUnique({
      where: { id: target.id },
      select: { id: true, username: true, name: true, role: true, phone: true },
    });
  return redact(before);
}

export function parseOperation(
  operation: AiOperation,
  attachments: AiAttachment[],
  allowSensitivePlaceholder = false,
): AiOperation {
  const tool = getWrite(operation.action);
  actionPath(operation.action, operation.target);
  const params = { ...operation.params };
  if (operation.attachmentId && !attachments.some((file) => file.id === operation.attachmentId))
    throw ApiError.forbidden('附件不属于当前任务');
  for (const key of Object.keys(params))
    if (/password|secret|token|api.?key/i.test(key) && !allowSensitivePlaceholder)
      throw ApiError.badRequest('敏感字段请在确认表单中填写');
  if (allowSensitivePlaceholder)
    for (const key of tool.sensitive ?? []) if (!params[key]) params[key] = 'placeholder-12345';
  const parsed = tool.schema.parse(params) as Record<string, unknown>;
  if (allowSensitivePlaceholder) for (const key of tool.sensitive ?? []) delete parsed[key];
  return {
    action: operation.action,
    target: operation.target ?? {},
    params: parsed,
    query: operation.query ?? {},
    ...(operation.attachmentId ? { attachmentId: operation.attachmentId } : {}),
  };
}

export async function importPreview(user: TokenPayload, operation: AiOperation): Promise<unknown> {
  if (operation.action === 'imports.table') {
    const input = im.tableFileSchema.parse(operation.params),
      preview = previewTable(input);
    const fields = IMPORT_FIELDS[input.kind].map(({ key, label, required }) => ({ key, label, required }));
    const provided = operation.params?.mapping as Record<string, string> | undefined;
    const mapping = provided && Object.keys(provided).length ? provided : preview.suggestedMapping;
    return {
      ...preview,
      fields,
      errors: fields
        .filter((field) => field.required && !preview.columns.includes(mapping[field.key] ?? ''))
        .map((field) => `请为「${field.label}」选择对应列`),
    };
  }
  if (operation.action === 'imports.yaml')
    return previewYamlClassPlan(user, im.classPlanYamlImportSchema.parse(operation.params));
  if (operation.action === 'imports.plan')
    return previewClassPlan(user, im.classPlanImportSchema.parse(operation.params));
  if (operation.action === 'imports.layout')
    return previewClassIslandTimeLayout(im.timeLayoutImportSchema.parse(operation.params).payload);
  return undefined;
}

export async function changePreview(operation: AiOperation, before: unknown): Promise<unknown> {
  if (operation.action.startsWith('clients.release-')) {
    const snapshot = before as Awaited<ReturnType<typeof inspectClientRelease>>;
    const size = snapshot.file?.size ?? snapshot.current?.size;
    return {
      操作: getWrite(operation.action).label,
      版本: snapshot.version,
      文件: snapshot.fileName,
      大小: size === undefined ? '下载后校验' : `${size} 字节`,
      当前登记: snapshot.current ?? '未登记',
      ...(operation.params?.notes !== undefined ? { 说明: operation.params.notes || '清空说明' } : {}),
      执行后: operation.action === 'clients.release-delete' ? '移除该版本缓存及登记' : '仅缓存，不安装或推送',
    };
  }
  if (operation.action !== 'plans.entries' && operation.action !== 'layouts.update') return undefined;
  const source = before as {
    classId: string;
    points?: { id: string; name: string; startTime: string; endTime: string }[];
    layout?: { points: { id: string; name: string; startTime: string; endTime: string }[] };
    entries?: { timeLayoutItemId: string; course?: { name: string } | null }[];
  };
  if (operation.action === 'layouts.update') {
    const points = operation.params!.points as {
      id?: string;
      name: string;
      startTime: string;
      endTime: string;
    }[];
    return [
      ...points.map((point) => {
        const old = source.points?.find((item) => item.id === point.id);
        return {
          时间点: point.name || `${point.startTime}–${point.endTime}`,
          修改前: old ? `${old.startTime}–${old.endTime}` : '新增',
          修改后: `${point.startTime}–${point.endTime}`,
        };
      }),
      ...(source.points ?? [])
        .filter((point) => !points.some((item) => item.id === point.id))
        .map((point) => ({
          时间点: point.name || point.startTime,
          修改前: `${point.startTime}–${point.endTime}`,
          修改后: '删除',
        })),
    ];
  }
  const entries = operation.params!.entries as {
    timeLayoutItemId: string;
    courseId?: string | null;
    isEnabled?: boolean;
    location?: string | null;
  }[];
  const ids = entries.flatMap((item) => (item.courseId ? [item.courseId] : []));
  const courses = await prisma.course.findMany({
    where: { classId: source.classId, id: { in: ids } },
    select: { id: true, name: true },
  });
  return [
    ...entries.map((entry) => {
      const point = source.layout?.points.find((item) => item.id === entry.timeLayoutItemId);
      return {
        时间点: point?.name || `${point?.startTime ?? ''}–${point?.endTime ?? ''}`,
        原课程:
          source.entries?.find((item) => item.timeLayoutItemId === entry.timeLayoutItemId)?.course?.name ||
          '空',
        新课程: courses.find((item) => item.id === entry.courseId)?.name || '空',
        启用: entry.isEnabled !== false,
        地点: entry.location || '—',
      };
    }),
    ...(source.entries ?? [])
      .filter((old) => !entries.some((entry) => entry.timeLayoutItemId === old.timeLayoutItemId))
      .map((old) => {
        const point = source.layout?.points.find((item) => item.id === old.timeLayoutItemId);
        return {
          时间点: point?.name || `${point?.startTime ?? ''}–${point?.endTime ?? ''}`,
          原课程: old.course?.name || '空',
          新课程: '移除条目',
          启用: false,
          地点: '—',
        };
      }),
  ];
}

export async function runRead(user: TokenPayload, operation: AiOperation): Promise<unknown> {
  await assertPermission(user, 'ai:use');
  if (operation.action === 'clients.releases') await assertAnyPermission(user, CLIENT_CACHE_READ_KEYS);
  else await assertPermission(user, readKey(operation.action));
  if (operation.action === 'promotion.preview') {
    assertAdmin(user);
    return previewPromotion(
      z
        .number()
        .int()
        .min(2000)
        .max(2100)
        .parse(operation.query?.year ?? operation.params?.year),
    );
  }
  const query = readSchemas[operation.action]?.parse(operation.query ?? operation.params ?? {}) as
    Record<string, unknown> | undefined;
  return redact(
    await readBusinessAction(
      user,
      operation.action,
      operation.target,
      query ?? operation.query ?? operation.params,
    ),
  );
}
