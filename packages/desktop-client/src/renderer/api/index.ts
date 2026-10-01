import {
  API_PATHS,
  type ClassDetailDto,
  type ClassDto,
  type ClassIslandNotificationChannel,
  type CourseDto,
  type HomeworkDaysDto,
  type DashboardSummary,
  type GradeDto,
  type HomeworkDto,
  type HomeworkStatusDto,
  type HomeworkSubmissionsDto,
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
  /** 账号登录（教师/管理员用；客户端界面走班级登录，学生个人账号已清理不能登录） */
  login: (payload: LoginRequest): Promise<LoginResponse> => api.post(API_PATHS.auth.login, payload),
  /** 班级账号登录（学生端主入口）：班级码 + 班级密码 */
  classLogin: (payload: { code: string; password: string }): Promise<LoginResponse> =>
    api.post('/auth/class-login', payload),
  logout: (): Promise<{ loggedOut: boolean }> => api.post(API_PATHS.auth.logout, {}),
  me: (): Promise<StudentDto> => api.get(API_PATHS.auth.me),
  /**
   * 修改密码（设置页「账号信息」里的入口）。
   * 服务端同一个接口按会话类型分流：班级账号改的是**班级密码**，教师/管理员改的是本人登录密码 ——
   * 因此这台机器无论以哪种身份登录，改密入口都走这一条。
   */
  changePassword: (payload: {
    currentPassword: string;
    newPassword: string;
  }): Promise<{ changed: boolean }> => api.patch(API_PATHS.auth.changePassword, payload),
};

export const classApi = {
  list: (): Promise<ClassDto[]> => api.get(API_PATHS.classes),
  detail: (id: string): Promise<ClassDetailDto> => api.get(`${API_PATHS.classes}/${id}`),
};

/**
 * 通知显示位置（both / client / classisland）。
 *
 * 由**这台教室机器自己**决定"提醒弹在 ClassHelper 还是 ClassIsland"：
 * 本地存一份用于本机的弹窗/上岛判断，同时写回班级记录，服务端据此决定要不要推 ClassIsland。
 */
export const classChannelApi = {
  get: (classId: string): Promise<{ notificationChannel: ClassIslandNotificationChannel }> =>
    api.get(`${API_PATHS.classes}/${classId}/notification-channel`),
  set: (
    classId: string,
    notificationChannel: ClassIslandNotificationChannel,
  ): Promise<{ notificationChannel: ClassIslandNotificationChannel }> =>
    api.patch(`${API_PATHS.classes}/${classId}/notification-channel`, { notificationChannel }),
};

/** 本班 ClassIsland 联动状态（教室客户端「设置 → ClassIsland 联动」展示） */
export const classIslandStatusApi = {
  get: (
    classId: string,
  ): Promise<{
    connected: boolean;
    deviceName: string | null;
    deviceCount: number;
    lastSeenAt: string | null;
    pluginVersion: string | null;
    classIslandVersion: string | null;
  }> => api.get(`${API_PATHS.classes}/${classId}/classisland-status`),
};

export const scheduleApi = {
  list: (params: { classId?: string; week?: number }): Promise<ScheduleDto[]> =>
    api.get(API_PATHS.schedules, params),
  grid: (params: { classId?: string; week?: number }): Promise<ScheduleWeekView> =>
    api.get(`${API_PATHS.schedules}/grid`, params),
};

export const courseApi = {
  list: (classId?: string): Promise<CourseDto[]> =>
    api.get(API_PATHS.courses, classId ? { classId } : undefined),
};

export const homeworkApi = {
  list: (params?: {
    classId?: string;
    pendingOnly?: boolean;
    courseId?: string;
    /** 只看某一天（YYYY-MM-DD，按作业所属日期） */
    date?: string;
  }): Promise<HomeworkDto[]> => api.get(API_PATHS.homeworks, params),
  /** 哪些天有作业（日期选择器高亮） */
  days: (params: { classId?: string; from?: string; to?: string; days?: number }): Promise<HomeworkDaysDto> =>
    api.get(`${API_PATHS.homeworks}/days`, params),
  /** 在教室机器上直接录入作业（班级账号可调用；也可选所属日期） */
  create: (payload: {
    classId: string;
    courseId?: string | null;
    title: string;
    content: string;
    assignDate?: string | null;
  }): Promise<HomeworkDto> => api.post(API_PATHS.homeworks, payload),
  detail: (id: string): Promise<HomeworkDto> => api.get(`${API_PATHS.homeworks}/${id}`),
  updateStatus: (id: string, completed: boolean): Promise<HomeworkStatusDto> =>
    api.patch(`${API_PATHS.homeworks}/${id}/status`, { completed }),
  /** 提交名单 / 未交名单（教师与班级设备可用） */
  submissions: (id: string): Promise<HomeworkSubmissionsDto> =>
    api.get(`${API_PATHS.homeworks}/${id}/submissions`),
  saveSubmissions: (id: string, notSubmittedUserIds: string[]): Promise<HomeworkSubmissionsDto> =>
    api.patch(`${API_PATHS.homeworks}/${id}/submissions`, { notSubmittedUserIds }),
};

export const notificationApi = {
  list: (params?: { classId?: string; unreadOnly?: boolean }): Promise<NotificationDto[]> =>
    api.get(API_PATHS.notifications, params),
  unreadCount: (): Promise<{ count: number }> => api.get(`${API_PATHS.notifications}/unread-count`),
  // id 来自服务端或灵动岛（作业卡是本地合成的 `homework-…`），一律 encodeURIComponent：
  // 否则含 `/` 或 `..` 的 id 会改变实际请求的路径
  markRead: (id: string): Promise<{ notificationId: string; readAt: string }> =>
    api.post(`${API_PATHS.notifications}/${encodeURIComponent(id)}/read`, {}),
  markAllRead: (): Promise<{ marked: number }> => api.post(`${API_PATHS.notifications}/read-all`, {}),
};

export const gradeApi = {
  my: (): Promise<GradeDto[]> => api.get(`${API_PATHS.grades}/my`),
};

export const dashboardApi = {
  summary: (): Promise<DashboardSummary> => api.get(API_PATHS.dashboard),
  term: (classId?: string): Promise<{ currentWeek: number; maxWeek: number }> =>
    api.get('/dashboard/term', classId ? { classId } : undefined),
};
