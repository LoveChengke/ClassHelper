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
