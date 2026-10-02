import {
  API_PATHS,
  type ClassDetailDto,
  type ClassDto,
  type ClassPlanImportResultDto,
  type ClassPlanPreviewDto,
  type ClassStatusDto,
  type CourseDto,
  type CreateClassRequest,
  type CreateCallRequest,
  type CreateCourseRequest,
  type CreateGradeRequest,
  type CreateHomeworkRequest,
  type CreateIntegrationDeviceRequest,
  type CreateNotificationRequest,
  type CreateScheduleRequest,
  type DashboardSummary,
  type DatabaseBackupMetaDto,
  type DatabaseBackupScheduleDto,
  type DatabaseConnectionTestDto,
  type DatabaseStatusDto,
  type DatabaseSwitchJobDto,
  type GradeDto,
  type GradeStats,
  type HomeworkDaysDto,
  type HomeworkDto,
  type HomeworkSubmissionsDto,
  type IntegrationDeviceDto,
  type IntegrationDeviceTokenDto,
  type LoginRequest,
  type LoginResponse,
  type NotificationDto,
  type ScheduleDto,
  type ScheduleWeekView,
  type SendClassIslandNotificationRequest,
  type SendClassIslandNotificationResult,
  type StudentDto,
  type TableImportPreview,
  type TableImportResult,
  type TimeLayoutDto,
  type TimeLayoutImportResult,
  type TimeLayoutParsePreview,
  type UpdateClassAccountRequest,
  type UpdateClassRequest,
  type UpdateIntegrationDeviceRequest,
  type UserDto,
} from '@classhelper/shared';
import { api } from './http';

/* ------------------------------------------------------------------ 认证 */

export const authApi = {
  login: (payload: LoginRequest): Promise<LoginResponse> => api.post(API_PATHS.auth.login, payload),
  logout: (): Promise<{ loggedOut: boolean }> => api.post(API_PATHS.auth.logout, {}),
  me: (): Promise<StudentDto> => api.get(API_PATHS.auth.me),
  changePassword: (payload: {
    currentPassword: string;
    newPassword: string;
  }): Promise<{ changed: boolean }> => api.patch(API_PATHS.auth.changePassword, payload),
};

/* ------------------------------------------------------------------ 班级 */

export const classApi = {
  list: (params?: { keyword?: string }): Promise<ClassDto[]> => api.get(API_PATHS.classes, params),
  detail: (id: string): Promise<ClassDetailDto> => api.get(`${API_PATHS.classes}/${id}`),
  create: (payload: CreateClassRequest): Promise<ClassDto> => api.post(API_PATHS.classes, payload),
  update: (id: string, payload: UpdateClassRequest): Promise<ClassDto> =>
    api.patch(`${API_PATHS.classes}/${id}`, payload),
  remove: (id: string): Promise<{ id: string }> => api.delete(`${API_PATHS.classes}/${id}`),
  students: (id: string): Promise<StudentDto[]> => api.get(`${API_PATHS.classes}/${id}/students`),
  addStudent: (
    id: string,
    payload: { username: string; name: string; password?: string },
  ): Promise<StudentDto> => api.post(`${API_PATHS.classes}/${id}/students`, payload),
  removeStudent: (id: string, userId: string): Promise<unknown> =>
    api.delete(`${API_PATHS.classes}/${id}/students/${userId}`),
  assignTeacher: (id: string, teacherId: string): Promise<unknown> =>
    api.post(`${API_PATHS.classes}/${id}/teachers`, { teacherId }),
  /** 设置 / 更改班主任：仅管理员 */
  assignHeadTeacher: (id: string, teacherId: string): Promise<ClassDto> =>
    api.patch(`${API_PATHS.classes}/${id}/head-teacher`, { teacherId }),
  removeTeacher: (id: string, teacherId: string): Promise<unknown> =>
    api.delete(`${API_PATHS.classes}/${id}/teachers/${teacherId}`),
  /** 设置 / 重置班级账号（班级码 + 班级密码）：仅管理员 */
  updateAccount: (id: string, payload: UpdateClassAccountRequest): Promise<ClassDto> =>
    api.patch(`${API_PATHS.classes}/${id}/class-account`, payload),
};

/* ------------------------------------------------------------------ 课程 */

export const courseApi = {
  list: (classId?: string): Promise<CourseDto[]> =>
    api.get(API_PATHS.courses, classId ? { classId } : undefined),
  create: (payload: CreateCourseRequest): Promise<CourseDto> => api.post(API_PATHS.courses, payload),
  update: (id: string, payload: { name: string }): Promise<CourseDto> =>
    api.patch(`${API_PATHS.courses}/${id}`, payload),
  remove: (id: string): Promise<{ id: string }> => api.delete(`${API_PATHS.courses}/${id}`),
};

/* ------------------------------------------------------------------ 课表 */

export const scheduleApi = {
  list: (params: { classId?: string; week?: number; dayOfWeek?: number }): Promise<ScheduleDto[]> =>
    api.get(API_PATHS.schedules, params),
  grid: (params: { classId?: string; week?: number }): Promise<ScheduleWeekView> =>
    api.get(`${API_PATHS.schedules}/grid`, params),
  /** 班级当前上课状态：上课时段发布紧急通知时必须先二次确认 */
  classStatus: (classId: string): Promise<ClassStatusDto> =>
    api.get(`${API_PATHS.schedules}/current`, { classId }),
  create: (payload: CreateScheduleRequest): Promise<ScheduleDto> => api.post(API_PATHS.schedules, payload),
  update: (id: string, payload: Partial<CreateScheduleRequest>): Promise<ScheduleDto> =>
    api.patch(`${API_PATHS.schedules}/${id}`, payload),
  remove: (id: string): Promise<{ id: string }> => api.delete(`${API_PATHS.schedules}/${id}`),
};

/* ------------------------------------------------------------------ 作业 */

export const homeworkApi = {
  list: (params: {
    classId?: string;
    courseId?: string;
    pendingOnly?: boolean;
    keyword?: string;
    /** 只看某一天（YYYY-MM-DD，按作业所属日期） */
    date?: string;
  }): Promise<HomeworkDto[]> => api.get(API_PATHS.homeworks, params),
  /** 哪些天有作业（日期选择器高亮） */
  days: (params: {
    classId?: string;
    from?: string;
    to?: string;
    days?: number;
  }): Promise<HomeworkDaysDto> => api.get(`${API_PATHS.homeworks}/days`, params),
  detail: (id: string): Promise<HomeworkDto> => api.get(`${API_PATHS.homeworks}/${id}`),
  create: (payload: CreateHomeworkRequest): Promise<HomeworkDto> => api.post(API_PATHS.homeworks, payload),
  update: (id: string, payload: Partial<CreateHomeworkRequest>): Promise<HomeworkDto> =>
    api.patch(`${API_PATHS.homeworks}/${id}`, payload),
  remove: (id: string): Promise<{ id: string }> => api.delete(`${API_PATHS.homeworks}/${id}`),
  /** 提交名单 / 未交名单（教师与班级设备可用） */
  submissions: (id: string): Promise<HomeworkSubmissionsDto> =>
    api.get(`${API_PATHS.homeworks}/${id}/submissions`),
  saveSubmissions: (id: string, notSubmittedUserIds: string[]): Promise<HomeworkSubmissionsDto> =>
    api.patch(`${API_PATHS.homeworks}/${id}/submissions`, { notSubmittedUserIds }),
};

/* ------------------------------------------------------------------ 通知 */

export const notificationApi = {
  list: (params: {
    classId?: string;
    priority?: string;
    unreadOnly?: boolean;
    keyword?: string;
  }): Promise<NotificationDto[]> => api.get(API_PATHS.notifications, params),
  create: (payload: CreateNotificationRequest): Promise<NotificationDto> =>
    api.post(API_PATHS.notifications, payload),
  remove: (id: string): Promise<{ id: string }> => api.delete(`${API_PATHS.notifications}/${id}`),
  unreadCount: (classId?: string): Promise<{ count: number }> =>
    api.get(`${API_PATHS.notifications}/unread-count`, classId ? { classId } : undefined),
};

/* ------------------------------------------------------------------ 叫人 */

export const callApi = {
  /** 点名让学生来找老师（学生端灵动岛会立即弹出"请 XXX 同学找 XXX 老师"） */
  create: (payload: CreateCallRequest): Promise<NotificationDto> => api.post(API_PATHS.calls, payload),
};

/* ------------------------------------------------------------------ 成绩 */

export const gradeApi = {
  list: (params: {
    classId?: string;
    courseId?: string;
    userId?: string;
    examName?: string;
  }): Promise<GradeDto[]> => api.get(API_PATHS.grades, params),
  stats: (params: { classId?: string; courseId?: string; examName?: string }): Promise<GradeStats> =>
    api.get(`${API_PATHS.grades}/stats`, params),
  create: (payload: CreateGradeRequest): Promise<GradeDto> => api.post(API_PATHS.grades, payload),
  bulkCreate: (payload: {
    classId: string;
    courseId?: string | null;
    examName: string;
    totalScore?: number;
    publishedAt?: string | null;
    items: Array<{ userId: string; score: number }>;
  }): Promise<{ count: number; items: GradeDto[] }> => api.post(`${API_PATHS.grades}/bulk`, payload),
  update: (id: string, payload: Partial<CreateGradeRequest>): Promise<GradeDto> =>
    api.patch(`${API_PATHS.grades}/${id}`, payload),
  remove: (id: string): Promise<{ id: string }> => api.delete(`${API_PATHS.grades}/${id}`),
};

/* ------------------------------------------------------------------ 学生 */

// 学生是"名单"不是"账号"：没有密码相关接口（登录统一走班级码 + 班级密码）
export const studentApi = {
  list: (params?: { classId?: string; keyword?: string }): Promise<StudentDto[]> =>
    api.get(API_PATHS.students, params),
  create: (payload: { username: string; name: string; classId?: string | null }): Promise<StudentDto> =>
    api.post(API_PATHS.students, payload),
  update: (
    id: string,
    payload: { username?: string; name?: string; classId?: string | null },
  ): Promise<StudentDto> => api.patch(`${API_PATHS.students}/${id}`, payload),
  remove: (id: string): Promise<{ id: string }> => api.delete(`${API_PATHS.students}/${id}`),
};

/* ------------------------------------------------------------------ 仪表盘 */

export const dashboardApi = {
  summary: (): Promise<DashboardSummary> => api.get(API_PATHS.dashboard),
  /**
   * 学期信息：`maxWeek` 是该班的教学周数（`Class.termWeeks`，班主任可调，默认 20），
   * 不带 classId 时后端回退全局默认值。
   */
  term: (classId?: string): Promise<{ currentWeek: number; maxWeek: number }> =>
    api.get('/dashboard/term', classId ? { classId } : undefined),
};

/* ------------------------------------------------------------------ 教师管理（仅管理员） */

export const teacherApi = {
  list: (keyword?: string): Promise<UserDto[]> =>
    api.get(API_PATHS.teachers, keyword ? { keyword } : undefined),
  create: (payload: {
    username: string;
    name: string;
    password?: string;
    role?: 'TEACHER' | 'ADMIN';
  }): Promise<UserDto> => api.post(API_PATHS.teachers, payload),
  update: (
    id: string,
    payload: { username?: string; name?: string; role?: 'TEACHER' | 'ADMIN' },
  ): Promise<UserDto> => api.patch(`${API_PATHS.teachers}/${id}`, payload),
  remove: (id: string): Promise<{ id: string }> => api.delete(`${API_PATHS.teachers}/${id}`),
  resetPassword: (id: string, newPassword?: string): Promise<unknown> =>
    api.post(`${API_PATHS.teachers}/${id}/reset-password`, newPassword ? { newPassword } : {}),
  /** 班级详情中的 teachers 字段即为已分配的协作教师 */
  fromClass: (classId: string): Promise<ClassDetailDto> => classApi.detail(classId),
};

/* ------------------------------------------------------------------ 导入（模板 / 表格 / 课表时间配置 / ClassIsland 课程表） */

export const importApi = {
  /** 模板下载地址（CSV 走 JSON，XLSX 走二进制） */
  template: (
    kind: 'grades' | 'students' | 'teachers',
    format: 'csv' | 'xlsx' = 'csv',
  ): Promise<{ kind: string; format: string; fileName: string; content: string }> =>
    api.get(`${API_PATHS.imports}/template`, { kind, format }),

  /** 上传表格并预览（解析 + 必填列校验 + 建议映射，不写库） */
  previewTable: (payload: {
    kind: 'grades' | 'students' | 'teachers';
    fileName: string;
    contentBase64: string;
  }): Promise<TableImportPreview> => api.post(`${API_PATHS.imports}/table/preview`, payload),

  /** 确认字段映射与写入模式后执行导入（教师名单与班级无关，classId 可省略） */
  commitTable: (payload: {
    kind: 'grades' | 'students' | 'teachers';
    classId?: string;
    fileName: string;
    contentBase64: string;
    mapping: Record<string, string>;
    mode: 'append' | 'upsert';
  }): Promise<TableImportResult> => api.post(`${API_PATHS.imports}/table/commit`, payload),

  /** ClassIsland 时间配置解析预览（不写库） */
  previewTimeLayout: (payload: {
    classId: string;
    name?: string;
    mode?: 'replace' | 'merge';
    payload: unknown;
  }): Promise<TimeLayoutParsePreview> => api.post(`${API_PATHS.imports}/time-layout/preview`, payload),

  /** 某班已导入的时间配置 */
  listTimeLayouts: (classId: string): Promise<TimeLayoutDto[]> =>
    api.get(`${API_PATHS.imports}/time-layout`, { classId }),

  /** 导入（覆盖或合并；解析失败返回 400 且不改动原配置） */
  importTimeLayout: (payload: {
    classId: string;
    name?: string;
    mode: 'replace' | 'merge';
    payload: unknown;
  }): Promise<TimeLayoutImportResult> => api.post(`${API_PATHS.imports}/time-layout`, payload),

  removeTimeLayout: (id: string): Promise<{ id: string }> =>
    api.delete(`${API_PATHS.imports}/time-layout/${id}`),

  /**
   * ClassIsland 课程表（ClassPlan）解析预览（不写库）。
   * 注意：请求体里的 JSON 字段名就叫 payload（与 ClassIsland 档案 JSON 同名）。
   */
  previewClassPlan: (payload: {
    classId: string;
    mode?: 'replace' | 'merge';
    payload: unknown;
  }): Promise<ClassPlanPreviewDto> => api.post(`${API_PATHS.imports}/class-plan/preview`, payload),

  /** 导入 ClassIsland 课程表（支持单双周：replace 覆盖 / merge 合并；失败会抛错且不改动原课表） */
  importClassPlan: (payload: {
    classId: string;
    mode?: 'replace' | 'merge';
    payload: unknown;
  }): Promise<ClassPlanImportResultDto> => api.post(`${API_PATHS.imports}/class-plan`, payload),
};

/* ------------------------------------------------------------------ ClassIsland 联动 */

/**
 * 联动设备管理 + 提醒下发。
 *
 * 设备令牌（chci_...）只在**创建**与**重置**两个接口的返回值里出现一次，
 * 其余接口永远只回 tokenHint（前缀提示），因此拿到 token 后要立刻提示老师复制保存。
 */
export const integrationApi = {
  listDevices: (classId?: string): Promise<IntegrationDeviceDto[]> =>
    api.get(`${API_PATHS.integrations}/devices`, classId ? { classId } : undefined),
  createDevice: (payload: CreateIntegrationDeviceRequest): Promise<IntegrationDeviceTokenDto> =>
    api.post(`${API_PATHS.integrations}/devices`, payload),
  updateDevice: (id: string, payload: UpdateIntegrationDeviceRequest): Promise<IntegrationDeviceDto> =>
    api.patch(`${API_PATHS.integrations}/devices/${id}`, payload),
  /** 重置令牌：旧令牌立即失效，插件需要重新填写 */
  resetToken: (id: string): Promise<IntegrationDeviceTokenDto> =>
    api.post(`${API_PATHS.integrations}/devices/${id}/token`, {}),
  removeDevice: (id: string): Promise<{ id: string }> =>
    api.delete(`${API_PATHS.integrations}/devices/${id}`),
  /** 把一条提醒下发到该班的 ClassIsland 设备（ClassIsland 上全屏弹出） */
  notify: (payload: SendClassIslandNotificationRequest): Promise<SendClassIslandNotificationResult> =>
    api.post(`${API_PATHS.integrations}/classisland/notify`, payload),
};

/* ------------------------------------------------------------------ 数据库管理（仅管理员） */

/**
 * 数据库管理：状态 / 连接测试 / 备份 / 导入导出 / 定时备份 / 一键切换。
 *
 * 「快照下载」与「数据库文件下载」是二进制流，走 http.ts 的 download()（返回 Blob），
 * 由页面负责触发浏览器保存；导入把快照 JSON 转 base64 放进请求体（受 12MB 请求体限制）。
 */
export const databaseApi = {
  status: (): Promise<DatabaseStatusDto> => api.get(`${API_PATHS.database}/status`),
  testConnection: (payload: { provider: 'sqlite' | 'mysql'; url: string }): Promise<DatabaseConnectionTestDto> =>
    api.post(`${API_PATHS.database}/test-connection`, payload),
  listBackups: (): Promise<DatabaseBackupMetaDto[]> => api.get(`${API_PATHS.database}/backups`),
  createBackup: (): Promise<DatabaseBackupMetaDto> => api.post(`${API_PATHS.database}/backups`, {}),
  restoreBackup: (name: string): Promise<{ counts: Record<string, number> }> =>
    api.post(`${API_PATHS.database}/backups/${encodeURIComponent(name)}/restore`, {}),
  deleteBackup: (name: string): Promise<{ name: string }> =>
    api.delete(`${API_PATHS.database}/backups/${encodeURIComponent(name)}`),
  importSnapshot: (base64: string): Promise<{ counts: Record<string, number> }> =>
    api.post(`${API_PATHS.database}/import`, { data: base64 }),
  /** 下载当前库的 JSON 快照（Blob，页面触发浏览器保存） */
  downloadSnapshot: (): Promise<Blob> => api.download(`${API_PATHS.database}/export`),
  /** 下载数据库文件（仅 SQLite 模式；MySQL 无单文件概念） */
  downloadSqliteFile: (): Promise<Blob> => api.download(`${API_PATHS.database}/sqlite-file`),
  getSchedule: (): Promise<DatabaseBackupScheduleDto> => api.get(`${API_PATHS.database}/backup-schedule`),
  saveSchedule: (payload: DatabaseBackupScheduleDto): Promise<DatabaseBackupScheduleDto> =>
    api.put(`${API_PATHS.database}/backup-schedule`, payload),
  startSwitch: (payload: { provider: 'sqlite' | 'mysql'; url: string }): Promise<{ jobId: string }> =>
    api.post(`${API_PATHS.database}/switch`, payload),
  getSwitchJob: (jobId: string): Promise<DatabaseSwitchJobDto | null> =>
    api.get(`${API_PATHS.database}/switch/jobs/${encodeURIComponent(jobId)}`),
};
