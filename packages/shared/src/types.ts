/**
 * 三端共享的领域类型定义。
 * 这里的类型是后端 REST API / WebSocket 契约的唯一来源，
 * 后端返回值与前端调用方都必须依赖它，避免契约漂移。
 */

/** 用户角色：管理员 / 教师 / 学生 */
export type UserRole = 'ADMIN' | 'TEACHER' | 'STUDENT';

/** 通知优先级 */
export type NotificationPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';

/** 成绩等级 */
export type GradeLevel = 'A' | 'B' | 'C' | 'D' | 'E';

/** 统一响应体（后端所有接口均返回该结构） */
export interface ApiResponse<T = unknown> {
  success: boolean;
  data: T;
  message: string;
}

/** 统一错误响应体 */
export interface ApiErrorResponse {
  success: false;
  data: null;
  message: string;
  code?: string;
  details?: unknown;
}

/** 分页查询参数 */
export interface PaginationQuery {
  page?: number;
  pageSize?: number;
}

/** 分页结果 */
export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/* ------------------------------------------------------------------ 用户 / 认证 */

export interface UserDto {
  id: string;
  username: string;
  name: string;
  role: UserRole;
  classId: string | null;
  createdAt: string;
}

export interface StudentDto extends UserDto {
  className?: string | null;
  grade?: string | null;
}

export interface LoginRequest {
  username: string;
  password: string;
}

/**
 * 登录会话主体。
 * - 普通账号（教师/管理员/个人学生）：就是用户本身；
 * - 班级账号（班级设备）：`classSession = true`，此时 `id` 与 `classId` 都是班级 id，
 *   `name` 是班级名，个人数据由服务端按"全班"范围读写。
 */
export interface SessionUser extends StudentDto {
  classSession?: boolean;
  /** 班级账号的班级码（仅班级会话返回） */
  classCode?: string;
}

export interface LoginResponse {
  token: string;
  user: SessionUser;
}

/** 班级账号登录（学生端）：班级码 + 班级密码 */
export interface ClassLoginRequest {
  code: string;
  password: string;
}

/* ------------------------------------------------------------------ 班级 */

export interface ClassDto {
  id: string;
  name: string;
  grade: string;
  teacherId: string;
  createdAt: string;
  teacher?: ClassTeacherBrief | null;
  studentCount?: number;
  courseCount?: number;
  homeworkCount?: number;
  notificationCount?: number;
  /** 班级码（学生端班级账号登录用）；仅对有管理权限的角色返回 */
  code?: string;
  /** 是否已设置班级密码（哈希永不外泄） */
  hasPassword?: boolean;
  /** 本学期教学周数（班主任可调，默认 20）：课表周次选择与默认 weekEnd 都用它 */
  termWeeks: number;
}

export interface ClassTeacherBrief {
  id: string;
  name: string;
  username: string;
}

export interface ClassDetailDto extends ClassDto {
  students: StudentDto[];
  courses: CourseDto[];
  teachers: ClassTeacherBrief[];
}

export interface CreateClassRequest {
  name: string;
  grade: string;
  /** 可选：自定义班级码，留空自动生成 */
  code?: string;
}

export interface UpdateClassRequest {
  name?: string;
  grade?: string;
  /** 本学期教学周数（1~40，班主任可调） */
  termWeeks?: number;
}

/** 管理员设置/重置班级账号（班级码 + 班级密码） */
export interface UpdateClassAccountRequest {
  /** 新的班级码（4~16 位字母数字，留空表示不改） */
  code?: string;
  /** 新的班级密码（留空表示不改） */
  password?: string;
}

/* ------------------------------------------------------------------ 课程 */

export interface CourseDto {
  id: string;
  name: string;
  teacherId: string;
  classId: string;
  createdAt: string;
  teacher?: ClassTeacherBrief | null;
}

export interface CreateCourseRequest {
  name: string;
  classId: string;
}

/* ------------------------------------------------------------------ 课表 */

/**
 * 课表条目。
 * 星期与周次均为 1 起始：dayOfWeek 1=周一 ... 7=周日，weekStart/weekEnd 为学期周次。
 */
export interface ScheduleDto {
  id: string;
  classId: string;
  courseId: string;
  dayOfWeek: number;
  /** HH:mm */
  startTime: string;
  /** HH:mm */
  endTime: string;
  location: string | null;
  weekStart: number;
  weekEnd: number;
  /**
   * 单双周：ALL = 每周都上（默认）；ODD = 只在单周；EVEN = 只在双周。
   * 与 ClassIsland 课表的 WeekCountDiv / WeekCountDivTotal 语义对应（见导入模块）。
   */
  weekParity: WeekParity;
  createdAt: string;
  course?: CourseBrief | null;
}

/** 单双周（ClassIsland：WeekCountDivTotal=2 时按 WeekCountDiv 分单/双周） */
export type WeekParity = 'ALL' | 'ODD' | 'EVEN';

export interface CourseBrief {
  id: string;
  name: string;
}

export interface CreateScheduleRequest {
  classId: string;
  courseId: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  location?: string | null;
  weekStart?: number;
  weekEnd?: number;
  /** 单双周：ALL（默认）/ ODD（单周）/ EVEN（双周） */
  weekParity?: WeekParity;
}

export type UpdateScheduleRequest = Partial<CreateScheduleRequest>;

/** 按天分组的课表视图，供客户端渲染周视图 */
export interface ScheduleDayColumn {
  dayOfWeek: number;
  label: string;
  items: ScheduleDto[];
}

export interface ScheduleWeekView {
  week: number;
  columns: ScheduleDayColumn[];
}

/* ------------------------------------------------------------------ ClassIsland 课程表导入（单双周） */

/** 解析出来的单节课（预览用） */
export interface ClassPlanEntryDto {
  /** 1=周一 … 7=周日（已从 ClassIsland 的 0=周日 转换） */
  dayOfWeek: number;
  /** 展示用：周一 / 周二 … */
  weekdayLabel?: string;
  startTime: string;
  endTime: string;
  subject: string;
  teacherName?: string;
  /** 单双周：ALL / ODD（单周）/ EVEN（双周） */
  weekParity: WeekParity;
  /** 原始 WeekCountDiv / WeekCountDivTotal，便于核对来源 */
  weekCountDiv: number;
  weekCountDivTotal: number;
  planName: string;
}

/** 课程表导入预览结果 */
export interface ClassPlanPreviewDto {
  entries: ClassPlanEntryDto[];
  /** 解析到的科目名（去重） */
  subjects: string[];
  /** 班级里还没有、导入时会自动补建的科目 */
  missingSubjects: string[];
  /** 解析到的时间表名 */
  layoutNames: string[];
  errors: string[];
  warnings: string[];
}

/** 课程表导入结果 */
export interface ClassPlanImportResultDto {
  imported: number;
  created: number;
  updated: number;
  /** 自动补建的课程名 */
  createdCourses: string[];
  weekStart: number;
  weekEnd: number;
}

/* ------------------------------------------------------------------ 作业 */

export interface HomeworkDto {
  id: string;
  classId: string;
  courseId: string | null;
  title: string;
  content: string;
  attachmentUrl: string | null;
  createdBy: string;
  createdAt: string;
  course?: CourseBrief | null;
  creator?: ClassTeacherBrief | null;
  /** 当前登录学生的完成状态（学生端接口返回） */
  completed?: boolean;
  homeworkStatus?: HomeworkStatusDto | null;
  /** 教师视角：已提交人数 */
  completedCount?: number;
}

export interface HomeworkStatusDto {
  id: string;
  homeworkId: string;
  userId: string;
  completed: boolean;
  updatedAt: string;
}

export interface CreateHomeworkRequest {
  classId: string;
  courseId?: string | null;
  title: string;
  content: string;
  attachmentUrl?: string | null;
}

export interface UpdateHomeworkStatusRequest {
  completed: boolean;
}

/** 作业提交名单里的一位学生 */
export interface HomeworkSubmissionDto {
  userId: string;
  name: string;
  username: string;
  completed: boolean;
}

/**
 * 作业提交名单（"未交名单"功能的载体）：
 * 教师端 / 班级设备用它勾选谁没交作业，其余学生一律视为已交。
 */
export interface HomeworkSubmissionsDto {
  homeworkId: string;
  classId: string;
  /** 全班学生数 */
  total: number;
  completedCount: number;
  /** 只包含未交的学生（completed=false），便于直接渲染"未交名单" */
  notSubmitted: HomeworkSubmissionDto[];
  /** 全班学生及其完成状态 */
  students: HomeworkSubmissionDto[];
}

export interface UpdateHomeworkSubmissionsRequest {
  /** 未交作业的学生 id（其余学生一律标记为已交） */
  notSubmittedUserIds: string[];
}

export interface HomeworkQueryParams {
  classId?: string;
  courseId?: string;
  /** 学生端：只看未完成 */
  pendingOnly?: boolean;
  keyword?: string;
}

/* ------------------------------------------------------------------ 通知 */

export interface NotificationDto {
  id: string;
  classId: string;
  title: string;
  content: string;
  priority: NotificationPriority;
  createdBy: string;
  createdAt: string;
  creator?: ClassTeacherBrief | null;
  /** 当前用户是否已读 */
  read?: boolean;
  readAt?: string | null;
  /** 教师视角：已读人数 */
  readCount?: number;
}

export interface CreateNotificationRequest {
  classId: string;
  title: string;
  content: string;
  priority?: NotificationPriority;
  /**
   * 上课时间段内发布"紧急"通知时必须显式置为 true（表示教师已确认会干扰上课）。
   * 否则服务端返回 409 URGENT_DURING_CLASS，由前端弹出全屏二次确认。
   */
  confirmDuringClass?: boolean;
}

/**
 * 叫人请求：老师在 Web 管理端选中学生 + 快捷短语/自定义消息，
 * 学生端灵动岛会立即弹出"请 XXX 同学找 XXX 老师"。
 */
export interface CreateCallRequest {
  classId: string;
  studentId: string;
  /**
   * 是否"紧急叫人"：
   * - true：落库为 URGENT，学生端灵动岛无视上课时段立即展开（与紧急通知同等待遇）；
   * - 省略/false：普通叫人（默认），按普通通知处理 —— 上课时段只进队列、不打断课堂，下课后弹出。
   */
  urgent?: boolean;
  /** 快捷短语（与 message 至少填一个） */
  quickPhrase?: string;
  /** 自定义消息（优先于快捷短语） */
  message?: string;
}

export interface NotificationQueryParams {
  classId?: string;
  priority?: NotificationPriority;
  unreadOnly?: boolean;
  keyword?: string;
}

/* ------------------------------------------------------------------ 成绩 */

export interface GradeDto {
  id: string;
  classId: string;
  courseId: string | null;
  userId: string;
  examName: string;
  score: number;
  totalScore: number;
  publishedAt: string;
  course?: CourseBrief | null;
  student?: ClassTeacherBrief | null;
  className?: string | null;
}

export interface CreateGradeRequest {
  classId: string;
  courseId?: string | null;
  userId: string;
  examName: string;
  score: number;
  totalScore?: number;
  publishedAt?: string | null;
}

/** 批量导入成绩（教师端"导入成绩"使用） */
export interface BulkCreateGradeRequest {
  classId: string;
  courseId?: string | null;
  examName: string;
  totalScore?: number;
  publishedAt?: string | null;
  items: Array<{ userId: string; score: number }>;
}

/** 成绩统计（教师端图表 / 学生端汇总） */
export interface GradeStats {
  total: number;
  averagePercent: number;
  byCourse: Array<{ courseId: string | null; courseName: string; count: number; averagePercent: number }>;
  distribution: Array<{ level: GradeLevel; count: number }>;
}

/* ------------------------------------------------------------------ 上课时段（灵动岛 / 紧急通知确认共用） */

/** 一节课的时段信息 */
export interface ClassPeriod {
  scheduleId: string;
  courseId: string;
  courseName: string;
  /** HH:mm */
  startTime: string;
  /** HH:mm */
  endTime: string;
  location: string | null;
  /** 1=周一 ... 7=周日 */
  dayOfWeek: number;
}

/** 班级当前上课状态 */
export interface ClassStatusDto {
  classId: string;
  /** 当前是否处于上课时间段 */
  inClass: boolean;
  /** 正在上的这节课（inClass=true 时非空） */
  current: ClassPeriod | null;
  /** 下一节课（用于"下课后自动弹出"的提示与倒计时） */
  next: ClassPeriod | null;
  /** 服务器判定所用的时间（客户端可据此校正本地时钟偏差） */
  serverTime: string;
  /** 判定所用的教学周 */
  week: number;
}

/* ------------------------------------------------------------------ 灵动岛 */

/** 灵动岛显示状态 */
export type IslandMode = 'hidden' | 'pill' | 'expanded';

/**
 * 灵动岛消息类型：
 * - `notification` 普通/重要/紧急通知
 * - `homework`     新作业发布（带截止时间，样式区分）
 * - `call`         "叫人"：老师点名让某位同学去找他（无论是否上课都立即展开）
 */
export type IslandNotificationKind = 'notification' | 'homework' | 'call';

/** 投递到灵动岛的通知载荷（服务端 NotificationDto 的精简版） */
export interface IslandNotification {
  id: string;
  title: string;
  content: string;
  priority: NotificationPriority;
  createdAt: string;
  courseName?: string | null;
  teacherName?: string | null;
  /** 消息类型，默认 notification */
  kind?: IslandNotificationKind;
  /** 附加说明，例如作业截止时间、"请到办公室" */
  subtitle?: string | null;
}

/** 灵动岛外观设置（设置页可调，主进程持久化并按此驱动窗口与渲染进程） */
export interface IslandAppearance {
  /** 胶囊高度（px，36~72）：展开卡高度按比例联动，保证布局不错乱 */
  height: number;
  /** 胶囊宽度（px，220~420） */
  width: number;
  /** 卡片圆角（px，8~32）：采用连续圆角（squircle），此值为四角的基准半径 */
  radius: number;
  /** 整体不透明度（0.4~1） */
  opacity: number;
  /** 主题色（强调色，用于高亮与按钮） */
  accent: string;
  /**
   * 基础字号（px，11~20）——参考 WinIsland 的 font_size：
   * 岛内**所有文本**都由它乘以各自的排版系数得出，因此改字号会整体等比缩放。
   */
  fontSize: number;
  /** 是否启用动画（关闭后展开/收起为瞬时） */
  animations: boolean;
  /** 动画速度倍率（0.5 慢 ~ 2 快） */
  speed: number;
  /** 显示位置（顶/底 × 左/中/右，与 WinIsland 的 DockPosition 对齐） */
  position: IslandPosition;
  /** 是否始终置顶 */
  alwaysOnTop: boolean;
  /**
   * 视觉风格（参考 WinIsland 的 island_style）：
   * - `black`：纯黑底（默认，WinIsland `default` 风格）
   * - `glass`：半透明 + 背景模糊（WinIsland `glass` 风格）
   * - `tinted`：强调色渐变（本产品特色，保持与原主题色一致）
   */
  style: IslandStyle;
  /**
   * 空闲时是否保留一条"细缝"（参考 WinIsland 的 hidden_width：空闲态是一条很窄的圆角柱）。
   * 关闭时（默认）空闲即完全隐藏，与原行为一致。
   */
  idleSliver: boolean;
}

/** 灵动岛停靠位置（6 个锚点，与 WinIsland 一致） */
export type IslandPosition =
  'top-center' | 'top-left' | 'top-right' | 'bottom-center' | 'bottom-left' | 'bottom-right';

/** 灵动岛视觉风格 */
export type IslandStyle = 'black' | 'glass' | 'tinted';

/** 灵动岛当前状态（主进程持有，渲染进程与冒烟测试读取） */
export interface IslandState {
  mode: IslandMode;
  /** 正在展示的通知（展开态或胶囊态） */
  active: IslandNotification | null;
  /** 上课期间被暂存、待下课后弹出的通知 */
  queued: IslandNotification[];
  /** 当前是否处于上课时间段 */
  inClass: boolean;
  /** 当前课的结束时间（HH:mm），用于"下课后自动弹出" */
  currentPeriodEnd: string | null;
  /** 本轮展示原因：新消息 / 下课后补发 / 紧急插播 / 叫人 */
  reason: 'new' | 'after-class' | 'urgent' | 'call' | null;
  updatedAt: number;
}

/* ------------------------------------------------------------------ 仪表盘 */

export interface DashboardSummary {
  classCount: number;
  studentCount: number;
  courseCount: number;
  scheduleCount: number;
  homeworkCount: number;
  notificationCount: number;
  gradeCount: number;
  unreadNotificationCount: number;
  pendingHomeworkCount: number;
  recentNotifications: NotificationDto[];
  recentHomeworks: HomeworkDto[];
}

/* ------------------------------------------------------------------ WebSocket */

/** 服务端 -> 客户端事件名 */
export interface ServerToClientEvents {
  'notification:new': (payload: NotificationDto) => void;
  /** 叫人：定向广播给被叫学生 */
  'call:new': (payload: NotificationDto) => void;
  'homework:new': (payload: HomeworkDto) => void;
  /** deleted=true 表示该作业已被删除，客户端应从本地缓存中移除 */
  'homework:updated': (payload: HomeworkDto & { deleted?: boolean }) => void;
  'homework:status': (payload: HomeworkStatusDto & { classId: string }) => void;
  'grade:updated': (payload: GradeDto) => void;
  'schedule:updated': (payload: {
    classId: string;
    action: 'created' | 'updated' | 'deleted';
    schedule?: ScheduleDto;
  }) => void;
  'class:updated': (payload: { classId: string; action: 'created' | 'updated' | 'deleted' }) => void;
  connected: (payload: { userId: string; role: UserRole; rooms: string[] }) => void;
}

/* ------------------------------------------------------------------ 导入（模板 / 表格 / 课表时间配置） */

/** 表格导入预览：列名、前若干行、建议字段映射与校验问题 */
export interface TableImportPreview {
  kind: 'grades' | 'students';
  columns: string[];
  rows: string[][];
  totalRows: number;
  suggestedMapping: Record<string, string>;
  errors: string[];
  warnings: string[];
  templateCsv: string;
}

/** 导入时某一行的具体错误（row 为 Excel 视角的行号，含表头） */
export interface TableImportRowError {
  row: number;
  message: string;
}

/** 导入结果统计 */
export interface TableImportResult {
  kind: 'grades' | 'students';
  total: number;
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
  errors: TableImportRowError[];
  warnings: string[];
}

/** ClassIsland 时间配置条目 */
export interface TimeLayoutEntry {
  index: number;
  name: string;
  startTime: string;
  endTime: string;
  type: 'class' | 'break' | 'divider';
  skipped: boolean;
}

export interface TimeLayoutDto {
  id: string;
  classId: string;
  name: string;
  source: string;
  items: TimeLayoutEntry[];
  createdAt: string;
  updatedAt: string;
}

/** ClassIsland JSON 解析结果（预览用：只解析不落库） */
export interface TimeLayoutParsePreview {
  items: TimeLayoutEntry[];
  errors: string[];
  warnings: string[];
  shape: string;
}

/** 课表时间配置导入结果 */
export interface TimeLayoutImportResult {
  layout: TimeLayoutDto;
  mode: 'replace' | 'merge';
  warnings: string[];
  /** merge 时：被此次导入覆盖的旧节次数 */
  merged: number;
  /** merge 时：新增节次数；replace 时为总节次数 */
  replaced: number;
}

/** 客户端 -> 服务端事件名 */
export interface ClientToServerEvents {
  'class:join': (classId: string, ack?: (result: { ok: boolean; message?: string }) => void) => void;
  'class:leave': (classId: string) => void;
  ping: (ack?: () => void) => void;
}

/** 连接鉴权信息（Socket.IO handshake.auth） */
export interface SocketAuthPayload {
  token: string;
  clientType?: 'admin' | 'desktop';
}
