import type { NotificationPriority, UserRole } from './types.js';

/** API 前缀 */
export const API_PREFIX = '/api';

/** REST 路径集中管理，避免前端散落硬编码字符串 */
export const API_PATHS = {
  auth: {
    login: '/auth/login',
    logout: '/auth/logout',
    me: '/auth/me',
    changePassword: '/auth/password',
  },
  classes: '/classes',
  courses: '/courses',
  schedules: '/schedules',
  homeworks: '/homeworks',
  notifications: '/notifications',
  grades: '/grades',
  students: '/students',
  teachers: '/teachers',
  dashboard: '/dashboard/summary',
} as const;

/** 用户角色 */
export const USER_ROLES: readonly UserRole[] = ['ADMIN', 'TEACHER', 'STUDENT'];

export const ROLE_LABELS: Record<UserRole, string> = {
  ADMIN: '系统管理员',
  TEACHER: '教师',
  STUDENT: '学生',
};

/** 通知优先级 */
export const NOTIFICATION_PRIORITIES: readonly NotificationPriority[] = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];

export const PRIORITY_LABELS: Record<NotificationPriority, string> = {
  LOW: '低',
  NORMAL: '普通',
  HIGH: '重要',
  URGENT: '紧急',
};

/** Element Plus tag 类型，三端统一文案与配色 */
export const PRIORITY_TAG_TYPES: Record<NotificationPriority, 'info' | 'primary' | 'warning' | 'danger'> = {
  LOW: 'info',
  NORMAL: 'primary',
  HIGH: 'warning',
  URGENT: 'danger',
};

/** 星期：1=周一 ... 7=周日（与数据库 dayOfWeek 一致） */
export const WEEKDAY_LABELS: Record<number, string> = {
  1: '周一',
  2: '周二',
  3: '周三',
  4: '周四',
  5: '周五',
  6: '周六',
  7: '周日',
};

export const WEEKDAYS: readonly number[] = [1, 2, 3, 4, 5, 6, 7];

/** 默认学期周次上限 */
export const DEFAULT_WEEK_COUNT = 20;

/** WebSocket 事件名（服务端广播 / 客户端监听保持一致） */
export const SOCKET_EVENTS = {
  notificationNew: 'notification:new',
  homeworkNew: 'homework:new',
  homeworkUpdated: 'homework:updated',
  homeworkStatus: 'homework:status',
  gradeUpdated: 'grade:updated',
  scheduleUpdated: 'schedule:updated',
  classUpdated: 'class:updated',
  connected: 'connected',
} as const;

/** Socket.IO 房间名生成规则：与后端保持一致，客户端订阅时复用 */
export const SOCKET_ROOMS = {
  class: (classId: string): string => `class:${classId}`,
  user: (userId: string): string => `user:${userId}`,
  teacher: (teacherId: string): string => `teacher:${teacherId}`,
  role: (role: UserRole): string => `role:${role}`,
  students: 'students',
  teachers: 'teachers',
} as const;

/** 本地持久化键（Web 端 localStorage / EXE 端 IndexedDB 命名空间） */
export const STORAGE_KEYS = {
  token: 'classhelper.token',
  user: 'classhelper.user',
  serverUrl: 'classhelper.serverUrl',
  cachePrefix: 'classhelper.cache',
  lastSyncAt: 'classhelper.lastSyncAt',
} as const;

/** 桌面客户端默认后端地址 */
export const DEFAULT_SERVER_URL = 'http://127.0.0.1:4000';

/** 默认端口与分页 */
export const DEFAULT_SERVER_PORT = 4000;
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 200;

/** 教师与管理员角色集合，便于 RBAC 判断 */
export const STAFF_ROLES: readonly UserRole[] = ['ADMIN', 'TEACHER'];
