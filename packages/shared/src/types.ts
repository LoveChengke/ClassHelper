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

export interface LoginResponse {
  token: string;
  user: UserDto;
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
}

export interface UpdateClassRequest {
  name?: string;
  grade?: string;
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
  createdAt: string;
  course?: CourseBrief | null;
}

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

/* ------------------------------------------------------------------ 作业 */

export interface HomeworkDto {
  id: string;
  classId: string;
  courseId: string | null;
  title: string;
  content: string;
  attachmentUrl: string | null;
  dueAt: string | null;
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
  dueAt?: string | null;
}

export interface UpdateHomeworkStatusRequest {
  completed: boolean;
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
  upcomingDeadlines: HomeworkDto[];
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
