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
  /** 叫人：老师点名让学生过来 */
  calls: '/calls',
  grades: '/grades',
  students: '/students',
  teachers: '/teachers',
  /** 导入：模板下载 / 表格导入 / ClassIsland 课表时间配置 */
  imports: '/imports',
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

/** 灵动岛默认外观（设置页个性化项的初始值，也是区间校验的单一来源） */
export const DEFAULT_ISLAND_APPEARANCE = {
  height: 44,
  width: 268,
  radius: 20,
  opacity: 1,
  /** 默认强调色采用 Apple 系统蓝（与 WinIsland 的系统色体系一致） */
  accent: '#0a84ff',
  fontSize: 13,
  animations: true,
  speed: 1,
  position: 'top-center',
  alwaysOnTop: true,
  /** 纯黑底（WinIsland default 风格） */
  style: 'black',
  /** 空闲时完全隐藏（与原行为一致；打开后空闲会留一条细缝） */
  idleSliver: false,
} as const;

/** 个性化设置项的合法区间（前端滑块与后端校验共用，避免越界导致布局错乱） */
export const ISLAND_APPEARANCE_RANGES = {
  height: { min: 36, max: 72 },
  width: { min: 220, max: 420 },
  radius: { min: 8, max: 32 },
  opacity: { min: 0.4, max: 1 },
  fontSize: { min: 11, max: 20 },
  speed: { min: 0.5, max: 2 },
} as const;

/** 停靠位置可选值（与 WinIsland 的 DockPosition 一致：顶/底 × 左/中/右） */
export const ISLAND_POSITIONS = [
  'top-center',
  'top-left',
  'top-right',
  'bottom-center',
  'bottom-left',
  'bottom-right',
] as const;

export const ISLAND_POSITION_LABELS: Record<(typeof ISLAND_POSITIONS)[number], string> = {
  'top-center': '顶部居中',
  'top-left': '左上角',
  'top-right': '右上角',
  'bottom-center': '底部居中',
  'bottom-left': '左下角',
  'bottom-right': '右下角',
};

/** 视觉风格可选值（参考 WinIsland 的 island_style） */
export const ISLAND_STYLES = ['black', 'glass', 'tinted'] as const;

export const ISLAND_STYLE_LABELS: Record<(typeof ISLAND_STYLES)[number], string> = {
  black: '纯黑（灵动岛默认）',
  glass: '毛玻璃（半透明模糊）',
  tinted: '主题色渐变',
};

/**
 * 空闲细缝尺寸（参考 WinIsland hidden_width = 5：空闲态是一条很窄的圆角柱）。
 * 宽度固定 6px，高度取胶囊高度的一部分，视觉上就是一条"小黑条"。
 */
export const ISLAND_SLIVER_WIDTH = 6;

/** 岛内文本的排版系数（相对基础字号，集中在这里方便统一调整） */
export const ISLAND_TYPE_SCALE = {
  /** 展开卡标题 */
  title: 1.08,
  /** 正文 */
  body: 0.95,
  /** 次要说明 / 元信息 */
  meta: 0.78,
  /** 徽标 / 按钮 */
  badge: 0.76,
  /** 胶囊主标题 */
  pillTitle: 0.92,
  /** 胶囊副标题 */
  pillSub: 0.74,
} as const;
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
  /** "叫人"：老师点名让某位同学去找他（定向到 user:{studentId} 房间） */
  callNew: 'call:new',
  connected: 'connected',
} as const;

/**
 * "叫人"快捷短语（Web 管理端一键选择，学生端灵动岛同步展示）。
 * 自定义消息会替换/补全这些短语；`message` 为空时用短语本身。
 */
export const CALL_QUICK_PHRASES: readonly string[] = [
  '请到办公室找我',
  '请到讲台找我',
  '请带上作业本找我',
  '请带上试卷找我',
  '请到实验室找我',
  '请到门卫处找我',
  '请到教室门口等我',
  '请马上来一趟',
] as const;

/** 叫人消息标题模板：请 XXX 同学找 XXX 老师（老师名字已含"老师"时不重复追加） */
export function buildCallTitle(studentName: string, teacherName: string): string {
  const teacher = /老师|教师|主任|校长/.test(teacherName) ? teacherName : `${teacherName} 老师`;
  return `请 ${studentName} 同学找 ${teacher}`;
}

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
