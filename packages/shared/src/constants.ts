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
  /** ClassIsland 联动：设备接入、状态上报、通知下发 */
  integrations: '/integrations',
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

/**
 * 优先级权重（越大越重要）。
 *
 * 灵动岛有多条通知时按它排序（"默认按重要程度排列"），插件合并同 id 消息时也用它取更高优先级 ——
 * 两边必须同一份口径，否则会出现"列表里的顺序和合并后的优先级不一致"。
 */
export const PRIORITY_RANK: Record<NotificationPriority, number> = {
  LOW: 0,
  NORMAL: 1,
  HIGH: 2,
  URGENT: 3,
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

/**
 * 统一授课科目目录（**全校固定**）：作业、课表、成绩的"科目"都从这里选，
 * 不需要按班级一个个建课 —— 选中后由前端自动为该班建好同名课程（已存在则复用）。
 * 顺序按用户给定的作息习惯：文化课 → 技术 → 体艺 → 班会与早晚读 → 通用技术 → 听力。
 */
export const SUBJECT_CATALOG: readonly string[] = [
  '语文',
  '数学',
  '英语',
  '政治',
  '历史',
  '物理',
  '化学',
  '地理',
  '生物',
  '信息技术',
  '体育',
  '美术',
  '音乐',
  '班会',
  '早读',
  '晚读',
  '通用技术',
  '听力',
] as const;

/**
 * 单双周标签与取值（课表用）。
 * 语义与 ClassIsland 课表一致：WeekCountDivTotal=1 → 每周；=2 时 WeekCountDiv=1 → 单周、=2 → 双周。
 */
export const WEEK_PARITY_LABELS: Record<'ALL' | 'ODD' | 'EVEN', string> = {
  ALL: '每周',
  ODD: '单周',
  EVEN: '双周',
};

export const WEEK_PARITY_VALUES: readonly ('ALL' | 'ODD' | 'EVEN')[] = ['ALL', 'ODD', 'EVEN'];

/** 一个学期按多少周为一个单双周循环（ClassIsland WeekCountDivTotal 的默认值） */
export const WEEK_PARITY_CYCLE = 2;

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
  /**
   * 距屏幕左右边缘的距离（px）：停靠左/右时生效。
   * 默认与原行为一致（8px）—— 加这个设置是为了能调，不是为了改默认外观。
   */
  marginX: 8,
  /** 距屏幕上下边缘的距离（px）：停靠顶/底时生效 */
  marginY: 8,
  /** 是否跟随鼠标所在屏幕（多显示器教室电脑：鼠标在哪块屏就在哪块屏显示） */
  followCursorDisplay: false,
} as const;

/** 个性化设置项的合法区间（前端滑块与后端校验共用，避免越界导致布局错乱） */
export const ISLAND_APPEARANCE_RANGES = {
  height: { min: 36, max: 72 },
  width: { min: 220, max: 420 },
  radius: { min: 8, max: 32 },
  opacity: { min: 0.4, max: 1 },
  fontSize: { min: 11, max: 20 },
  speed: { min: 0.5, max: 2 },
  marginX: { min: 0, max: 200 },
  marginY: { min: 0, max: 160 },
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
  glass: '毛玻璃（半透明）',
  tinted: '主题色渐变',
};

/**
 * 空闲细缝尺寸（参考 WinIsland hidden_width = 5：空闲态是一条很窄的圆角柱）。
 * 宽度固定 6px，高度取胶囊高度的一部分，视觉上就是一条"小黑条"。
 */
export const ISLAND_SLIVER_WIDTH = 6;

/**
 * 各形态相对"胶囊"的尺寸增量（**单一事实来源**，主进程与渲染进程共用）：
 * - 主进程据此计算"固定包围盒窗口"有多大（窗口只为最大形态留位置，开合时不改窗口）；
 * - 渲染进程据此计算岛的目标尺寸并做弹簧形变。
 * 取值参考 WinIsland：胶囊 120×27 → 展开 360×200（宽 ×3、高 ×7.4），我们按内容需要取略小的比例。
 */
export const ISLAND_SIZE_DELTA = {
  expanded: { width: 156, height: 186 },
  urgent: { width: 172, height: 202 },
  call: { width: 188, height: 218 },
} as const;

/** 阴影/光晕留白（窗口比最大形态多出的透明边，保证投影不被窗口裁掉） */
export const ISLAND_SHADOW_PAD = 10;

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

/**
 * 展开态"多条通知列表"的排版度量（单位：**基础字号的倍数**，即与 `--island-font` 同源）。
 *
 * 为什么这份常量必须放在 shared：列表比普通展开卡高得多，**窗口包围盒要跟着长高**，
 * 否则卡片底部（那排按钮）会被窗口裁掉 —— 而窗口尺寸只有主进程能改、行高只有渲染进程知道。
 * 两边用同一份度量各算一次"该显示几行 / 卡片多高"，就不会出现"渲染进程以为放得下、窗口却不够高"的漂移。
 *
 * 与 `IslandApp.vue` 里 `.expanded-layer`、`.list-row`、`.list-hint`、`.foot` 的 CSS 逐项对应，
 * **改 CSS 必须同步改这里**。
 */
export const ISLAND_LIST_METRICS = {
  /** 卡片上下内边距 */
  paddingY: 1.4,
  /** 卡片内各块（标题行 / 批次标题 / 列表 / 按钮行）之间的间距 */
  gap: 0.7,
  /** 顶部标题行（图标 + 徽标 + 时间 + 收起按钮） */
  headerHeight: 1.7,
  /** 批次标题（"共 N 条待处理通知"，单行） */
  titleHeight: 1.4,
  /** 单条通知行高 */
  rowHeight: 2.7,
  /** 行间距（含提示行上方的间距） */
  rowGap: 0.4,
  /** "展开更多 / 更多请前往应用内操作"那一行（含上方间距） */
  hintHeight: 2.5,
  /** 底部按钮行（含上方间距、分隔线与内边距） */
  footerHeight: 3.45,
  /** 默认只显示前几条 —— 用户要求「只显示前三个，下面显示展开更多」 */
  defaultVisibleRows: 3,
  /** 兜底上限：再多也交给"前往应用内操作"，避免窗口长到离谱 */
  maxRows: 20,
  /** 高度余量：浮点排版误差不至于让最后一行贴着裁切边 */
  safetyPad: 6,
} as const;

/** 列表布局结算结果（主进程据此算窗口包围盒，渲染进程据此渲染） */
export interface IslandListLayout {
  /** 实际要展示的通知行数 */
  rows: number;
  /** 底部提示行的形态：more=可"展开更多"；app=放不下，请去应用内看；null=没有更多了 */
  hint: 'more' | 'app' | null;
  /** 卡片高度（CSS px） */
  height: number;
}

/** 列表卡片里"除通知行之外"的固定高度（CSS px）：内边距 + 标题行 + 批次标题 + 底部按钮行 + 可选提示行 */
function islandListChromeHeight(fontSize: number, withHint: boolean): number {
  const m = ISLAND_LIST_METRICS;
  const base = (m.paddingY * 2 + m.headerHeight + m.titleHeight + m.footerHeight + m.gap * 3) * fontSize;
  return base + (withHint ? m.hintHeight * fontSize : 0);
}

/** n 行通知（含行间距）占用的高度（CSS px） */
function islandListRowsHeight(fontSize: number, rows: number): number {
  const m = ISLAND_LIST_METRICS;
  if (rows <= 0) return 0;
  return (rows * m.rowHeight + (rows - 1) * m.rowGap) * fontSize;
}

/** 在给定高度里最多放得下几行通知（至少 1 行，至多 maxRows） */
function islandListFittingRows(fontSize: number, maxHeight: number, withHint: boolean): number {
  const m = ISLAND_LIST_METRICS;
  const chrome = islandListChromeHeight(fontSize, withHint) + m.safetyPad;
  const unit = (m.rowHeight + m.rowGap) * fontSize;
  const rowUnit = m.rowHeight * fontSize;
  const room = maxHeight - chrome;
  if (room < rowUnit) return 1;
  return Math.max(1, Math.min(m.maxRows, Math.floor((room + m.rowGap * fontSize) / unit)));
}

/**
 * 结算"多条通知"的展开卡布局（**主进程与渲染进程共用**）：
 * - 默认只显示前 `defaultVisibleRows` 条，多余的放进"展开更多"；
 * - 放不下的部分（快到屏幕下沿的任务栏了）不再撑高卡片，改为提示"更多请前往应用内操作"；
 * - 返回的 `height` 就是卡片（以及窗口包围盒）应有的高度。
 */
export function islandListLayout(input: {
  /** 待处理通知总数 */
  count: number;
  /** 基础字号（外观设置） */
  fontSize: number;
  /** 当前屏幕/停靠位置下卡片可用的最大高度（CSS px） */
  maxHeight: number;
  /** 是否已点过"展开更多" */
  expanded: boolean;
}): IslandListLayout {
  const m = ISLAND_LIST_METRICS;
  const total = Math.max(0, Math.floor(input.count));
  // 先按"用户意图"决定想显示几行；再受屏幕高度限制
  const desired = input.expanded ? Math.min(total, m.maxRows) : Math.min(total, m.defaultVisibleRows);
  const wantsHint = desired < total;
  const fitting = islandListFittingRows(input.fontSize, input.maxHeight, wantsHint);
  const rows = Math.max(1, Math.min(desired, fitting));
  const hint: IslandListLayout['hint'] =
    rows >= total ? null : input.expanded || rows >= fitting ? 'app' : 'more';
  return {
    rows,
    hint,
    height: Math.min(
      input.maxHeight,
      islandListChromeHeight(input.fontSize, hint !== null) +
        islandListRowsHeight(input.fontSize, rows) +
        m.safetyPad,
    ),
  };
}

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
  /** ClassIsland 联动：设备状态上报（Web 端实时展示当前课程） */
  classislandState: 'classisland:state',
  /** ClassIsland 联动：教师发起的提醒已下发（插件据此全屏弹出） */
  classislandNotification: 'classisland:notification',
  connected: 'connected',
} as const;

/** ClassIsland 联动：设备接入令牌的前缀（便于识别与日志排查） */
export const CLASSISLAND_DEVICE_TOKEN_PREFIX = 'chci_';

/** ClassIsland 联动：ClassIsland 的时间点类型（与 TimeLayoutItem.TimeType 一致） */
export const CLASSISLAND_TIME_TYPES = {
  class: 0,
  break: 1,
  divider: 2,
  action: 3,
} as const;

/**
 * ClassIsland 的时间点类型 -> 本系统的节次类型。
 * 3（行动）在本系统里按"分割线"处理：它不占课时，只做视觉分隔。
 */
export const CLASSISLAND_TIME_TYPE_LABELS: Record<number, string> = {
  0: '上课',
  1: '课间',
  2: '分割线',
  3: '行动',
};

/** ClassIsland TimeState 字符串 -> 中文（插件上报 → Web 端展示） */
export const CLASSISLAND_TIME_STATE_LABELS: Record<string, string> = {
  None: '空闲',
  OnClass: '上课中',
  PrepareOnClass: '预备铃',
  Breaking: '课间休息',
  AfterSchool: '已放学',
};

/**
 * 通知的显示位置（由**教室的班级客户端**在设置页里选，存在班级上）。
 *
 * - `both`：ClassHelper 客户端弹（弹窗 + 灵动岛），同时推给教室的 ClassIsland；
 * - `client`：只在 ClassHelper 客户端弹，不打扰 ClassIsland；
 * - `classisland`：只在 ClassIsland 上弹（客户端只进通知中心，不弹窗、不上岛）。
 */
export const CLASSISLAND_NOTIFICATION_CHANNELS = ['both', 'client', 'classisland'] as const;

export const CLASSISLAND_NOTIFICATION_CHANNEL_LABELS: Record<string, string> = {
  both: '两者都弹',
  client: '灵动岛（ClassHelper 客户端）',
  classisland: 'ClassIsland',
};

export const CLASSISLAND_NOTIFICATION_CHANNEL_HINTS: Record<string, string> = {
  both: '灵动岛与 ClassIsland 都会提醒老师发的内容（默认）',
  client: '只在 ClassHelper 客户端的灵动岛提醒，不推送到 ClassIsland',
  classisland: '只推送到 ClassIsland 全屏提醒，灵动岛不弹（通知中心仍留记录）',
};

/** 默认显示位置：两端都弹 */
export const DEFAULT_CLASSISLAND_NOTIFICATION_CHANNEL = 'both';
/**
 * 作业录入的默认快捷短语（客户端「设置 → 作业录入」可增删）。
 *
 * 教室里老师录作业的常见口径：科目简称（P=拼音）、本子类型（大本/小本）、
 * 作业动作（背诵/默写/听写/预习/订正）—— 点一下就追加到内容里，少打字。
 */
export const HOMEWORK_PHRASE_DEFAULTS = [
  'P',
  '大本',
  '小本',
  '卷子',
  '背诵',
  '默写',
  '听写',
  '预习',
  '订正',
  '读书',
] as const;

/** 单条快捷短语的最大长度（防止把整篇作业粘进去） */
export const HOMEWORK_PHRASE_MAX_LENGTH = 20;

/** 快捷短语最多几条 */
export const HOMEWORK_PHRASE_MAX_COUNT = 24;

/** 默认提醒显示时长（秒），后端与插件共用同一口径 */
export const CLASSISLAND_NOTIFICATION_DEFAULT_DURATION = 8;
export const CLASSISLAND_NOTIFICATION_MAX_DURATION = 120;

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
