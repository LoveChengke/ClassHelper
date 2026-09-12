import {
  API_PATHS,
  type ClassDetailDto,
  type ClassDto,
  type ClassStatusDto,
  type CourseDto,
  type CreateClassRequest,
  type CreateCallRequest,
  type CreateCourseRequest,
  type CreateGradeRequest,
  type CreateHomeworkRequest,
  type CreateNotificationRequest,
  type CreateScheduleRequest,
  type DashboardSummary,
  type GradeDto,
  type GradeStats,
  type HomeworkDto,
  type LoginRequest,
  type LoginResponse,
  type NotificationDto,
  type ScheduleDto,
  type ScheduleWeekView,
  type StudentDto,
  type TableImportPreview,
  type TableImportResult,
  type TimeLayoutDto,
  type TimeLayoutImportResult,
  type TimeLayoutParsePreview,
  type UpdateClassAccountRequest,
  type UpdateClassRequest,
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
  }): Promise<HomeworkDto[]> => api.get(API_PATHS.homeworks, params),
  detail: (id: string): Promise<HomeworkDto> => api.get(`${API_PATHS.homeworks}/${id}`),
  create: (payload: CreateHomeworkRequest): Promise<HomeworkDto> => api.post(API_PATHS.homeworks, payload),
  update: (id: string, payload: Partial<CreateHomeworkRequest>): Promise<HomeworkDto> =>
    api.patch(`${API_PATHS.homeworks}/${id}`, payload),
  remove: (id: string): Promise<{ id: string }> => api.delete(`${API_PATHS.homeworks}/${id}`),
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

export const studentApi = {
  list: (params?: { classId?: string; keyword?: string }): Promise<StudentDto[]> =>
    api.get(API_PATHS.students, params),
  create: (payload: {
    username: string;
    name: string;
    password?: string;
    classId?: string | null;
  }): Promise<StudentDto> => api.post(API_PATHS.students, payload),
  update: (
    id: string,
    payload: { username?: string; name?: string; classId?: string | null },
  ): Promise<StudentDto> => api.patch(`${API_PATHS.students}/${id}`, payload),
  remove: (id: string): Promise<{ id: string }> => api.delete(`${API_PATHS.students}/${id}`),
  resetPassword: (id: string, newPassword?: string): Promise<unknown> =>
    api.post(`${API_PATHS.students}/${id}/reset-password`, newPassword ? { newPassword } : {}),
};

/* ------------------------------------------------------------------ 仪表盘 */

export const dashboardApi = {
  summary: (): Promise<DashboardSummary> => api.get(API_PATHS.dashboard),
  term: (): Promise<{ currentWeek: number; maxWeek: number }> => api.get('/dashboard/term'),
};

/* ------------------------------------------------------------------ 协作教师 */

export const teacherApi = {
  list: (keyword?: string): Promise<UserDto[]> =>
    api.get(API_PATHS.teachers, keyword ? { keyword } : undefined),
  create: (payload: {
    username: string;
    name: string;
    password: string;
    role?: 'TEACHER' | 'ADMIN';
  }): Promise<UserDto> => api.post(API_PATHS.teachers, payload),
  /** 班级详情中的 teachers 字段即为已分配的协作教师 */
  fromClass: (classId: string): Promise<ClassDetailDto> => classApi.detail(classId),
};

/* ------------------------------------------------------------------ 导入（模板 / 表格 / 课表时间配置） */

export const importApi = {
  /** 模板下载地址（CSV 走 JSON，XLSX 走二进制） */
  template: (
    kind: 'grades' | 'students',
    format: 'csv' | 'xlsx' = 'csv',
  ): Promise<{ kind: string; format: string; fileName: string; content: string }> =>
    api.get(`${API_PATHS.imports}/template`, { kind, format }),

  /** 上传表格并预览（解析 + 必填列校验 + 建议映射，不写库） */
  previewTable: (payload: {
    kind: 'grades' | 'students';
    fileName: string;
    contentBase64: string;
  }): Promise<TableImportPreview> => api.post(`${API_PATHS.imports}/table/preview`, payload),

  /** 确认字段映射与写入模式后执行导入 */
  commitTable: (payload: {
    kind: 'grades' | 'students';
    classId: string;
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
};
