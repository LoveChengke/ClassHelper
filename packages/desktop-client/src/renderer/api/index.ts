import {
  API_PATHS,
  type ClassDetailDto,
  type ClassDto,
  type DashboardSummary,
  type GradeDto,
  type HomeworkDto,
  type HomeworkStatusDto,
  type LoginRequest,
  type LoginResponse,
  type NotificationDto,
  type ScheduleDto,
  type ScheduleWeekView,
  type StudentDto,
} from '@classhelper/shared';
import { api } from './http.js';

/** 客户端只需用到学生视角的这批接口（与后端同一套 REST 契约） */
export const authApi = {
  /** 个人账号登录（教师/管理员/个人学生；客户端界面已不再展示，保留以兼容旧流程与排障） */
  login: (payload: LoginRequest): Promise<LoginResponse> => api.post(API_PATHS.auth.login, payload),
  /** 班级账号登录（学生端主入口）：班级码 + 班级密码 */
  classLogin: (payload: { code: string; password: string }): Promise<LoginResponse> =>
    api.post('/auth/class-login', payload),
  logout: (): Promise<{ loggedOut: boolean }> => api.post(API_PATHS.auth.logout, {}),
  me: (): Promise<StudentDto> => api.get(API_PATHS.auth.me),
};

export const classApi = {
  list: (): Promise<ClassDto[]> => api.get(API_PATHS.classes),
  detail: (id: string): Promise<ClassDetailDto> => api.get(`${API_PATHS.classes}/${id}`),
};

export const scheduleApi = {
  list: (params: { classId?: string; week?: number }): Promise<ScheduleDto[]> =>
    api.get(API_PATHS.schedules, params),
  grid: (params: { classId?: string; week?: number }): Promise<ScheduleWeekView> =>
    api.get(`${API_PATHS.schedules}/grid`, params),
};

export const homeworkApi = {
  list: (params?: { classId?: string; pendingOnly?: boolean; courseId?: string }): Promise<HomeworkDto[]> =>
    api.get(API_PATHS.homeworks, params),
  detail: (id: string): Promise<HomeworkDto> => api.get(`${API_PATHS.homeworks}/${id}`),
  updateStatus: (id: string, completed: boolean): Promise<HomeworkStatusDto> =>
    api.patch(`${API_PATHS.homeworks}/${id}/status`, { completed }),
};

export const notificationApi = {
  list: (params?: { classId?: string; unreadOnly?: boolean }): Promise<NotificationDto[]> =>
    api.get(API_PATHS.notifications, params),
  unreadCount: (): Promise<{ count: number }> => api.get(`${API_PATHS.notifications}/unread-count`),
  markRead: (id: string): Promise<{ notificationId: string; readAt: string }> =>
    api.post(`${API_PATHS.notifications}/${id}/read`, {}),
  markAllRead: (): Promise<{ marked: number }> => api.post(`${API_PATHS.notifications}/read-all`, {}),
};

export const gradeApi = {
  my: (): Promise<GradeDto[]> => api.get(`${API_PATHS.grades}/my`),
};

export const dashboardApi = {
  summary: (): Promise<DashboardSummary> => api.get(API_PATHS.dashboard),
  term: (): Promise<{ currentWeek: number; maxWeek: number }> => api.get('/dashboard/term'),
};
