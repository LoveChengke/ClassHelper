/**
 * 三端共享的领域类型定义。
 * 这里的类型是后端 REST API / WebSocket 契约的唯一来源，
 * 后端返回值与前端调用方都必须依赖它，避免契约漂移。
 */

/**
 * 账号角色：管理员 / 教师 / ClassHelper 班级端。
 *
 * **没有 STUDENT**：学生不是账号，只是 `Student` 表里的班级名单记录，
 * 既没有密码也没有登录入口（2026-10-06 起由表结构保证，不再靠代码分支拦）。
 * `CLASS_DEVICE` 是教室里那台绑定到某个班的 ClassHelper 班级端（班级码 + 班级密码登录），
 * 它代全班读写个人数据。
 */
export type UserRole = 'ADMIN' | 'TEACHER' | 'CLASS_DEVICE';

/** 通知优先级 */
export type NotificationPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';

/** 百分制默认等级换算结果的取值域（自定义等级不受它限制） */
export type GradeLevel = 'A' | 'B' | 'C' | 'D' | 'E';

/**
 * 成绩的等级口径：
 * - `percent` 百分制：等级由得分率自动换算（教师仍可手改单条）
 * - `letter`  等级制：A / B / C / D
 * - `custom`  自定义等级：教师填任意文本（优 / 良 / 合格 / 待提高…）
 */
export type GradeLevelType = 'percent' | 'letter' | 'custom';

/**
 * 学生状态。
 *
 * - `active`      在读
 * - `graduated`   已毕业（随届别归档）
 * - `transferred` 已转出（学籍离开本校，班级归属保留作历史）
 * - `inactive`    停用（休学等，记录保留）
 */
export type StudentStatus = 'active' | 'graduated' | 'transferred' | 'inactive';

/** 学生性别：'' = 未填 */
export type StudentGender = '' | 'MALE' | 'FEMALE';

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

/* ------------------------------------------------------------------ 账号（管理员 / 教师） */

/**
 * 账号 DTO：管理员与教师。
 *
 * `username` 对教师而言就是**工号**（界面上一律显示「工号」），也是登录名。
 * 学生不在这个类型里 —— 他们只是班级名单记录，见 `StudentDto`。
 */
export interface UserDto {
  id: string;
  username: string;
  name: string;
  role: UserRole;
  /** 手机号（可空） */
  phone: string;
  createdAt: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

/**
 * 登录会话主体。
 * - 教师 / 管理员：就是账号本身（`classSession` 为空）；
 * - ClassHelper 班级端：`classSession = true`，此时 `id` 与 `classId` 都是班级 id，
 *   `name` 是班级名，`username` 是班级码，个人数据由服务端按「全班」范围读写。
 */
export interface SessionUser {
  id: string;
  /** 教师/管理员的工号，或班级端的班级码 */
  username: string;
  name: string;
  role: UserRole;
  classId: string | null;
  createdAt: string;
  phone?: string;
  className?: string | null;
  grade?: string | null;
  /** ClassHelper 班级端（班级会话） */
  classSession?: boolean;
  /** 班级端的班级码（仅班级会话返回） */
  classCode?: string;
  /**
   * 班级端按学号查询成绩明细的开关（仅班级会话返回）。
   * 客户端据此决定要不要显示"按学号查成绩"入口。
   */
  studentGradeQueryEnabled?: boolean;
}

export interface LoginResponse {
  token: string;
  user: SessionUser;
}

/** 班级端登录（ClassHelper 班级端）：班级码 + 班级密码 */
export interface ClassLoginRequest {
  code: string;
  password: string;
}

/* ------------------------------------------------------------------ 学生（班级名单记录，没有账号） */

/**
 * 学生 DTO。
 *
 * 学生**不是账号**：没有密码、不能登录、没有个人入口。
 * `studentNo`（学号）是学生在系统里的唯一标识，也是查询键（成绩、作业提交名单、导入导出都用它）。
 */
export interface StudentDto {
  id: string;
  /** 学号：学生唯一标识（全校唯一） */
  studentNo: string;
  name: string;
  /** 当前班级；null = 未分班 */
  classId: string | null;
  className?: string | null;
  grade?: string | null;
  gender: StudentGender;
  /** 家长手机号（可空） */
  guardianPhone: string;
  status: StudentStatus;
  /** 毕业归档所属届别；null = 未归档 */
  archivedYearId?: string | null;
  archivedAt?: string | null;
  /** 转出时间（status='transferred' 时写入） */
  transferredAt?: string | null;
  transferNote?: string;
  createdAt: string;
}

/** 学生简要信息（成绩、提交名单等引用处使用） */
export interface StudentBrief {
  id: string;
  studentNo: string;
  name: string;
}

export interface CreateStudentRequest {
  studentNo: string;
  name: string;
  classId?: string | null;
  gender?: StudentGender;
  guardianPhone?: string;
  status?: StudentStatus;
}

export interface UpdateStudentRequest {
  studentNo?: string;
  name?: string;
  classId?: string | null;
  gender?: StudentGender;
  guardianPhone?: string;
  status?: StudentStatus;
}

/** 学生是否属于某个班的判定范围（列表查询用） */
export interface StudentQueryParams {
  classId?: string;
  keyword?: string;
}

/* ------------------------------------------------------------------ 调班 */

/** 调班 / 转出的方式 */
export type StudentTransferMode = 'single' | 'batch' | 'transfer-out';

/** 一次调班 / 转出的历史记录（原班级 / 新班级 / 操作人 / 时间） */
export interface StudentTransferDto {
  id: string;
  studentId: string;
  /** 学号快照：学生被删除后历史仍可读 */
  studentNo: string;
  studentName: string;
  fromClassId: string | null;
  fromClassName: string;
  toClassId: string | null;
  toClassName: string;
  operatorId: string | null;
  operatorName: string;
  /** single = 单个调班 / batch = 批量调班 / transfer-out = 转出（离开本校） */
  mode: StudentTransferMode;
  note: string;
  createdAt: string;
}

/**
 * 调班请求：单个与批量共用。
 * 传一个 id 就是单个调班；`toClassId = null` 表示移出班级（回到「未分班」）。
 * **学号不变**，只改学生当前的班级归属；历史作业与成绩保留原归属。
 */
export interface TransferStudentsRequest {
  studentIds: string[];
  toClassId: string | null;
  note?: string;
}

/**
 * 学生转出（学籍离开本校，不是调班）：班级归属保留作历史，状态置为 `transferred`。
 * 单个与批量共用 —— 传一个 id 就是单个。
 */
export interface TransferOutStudentsRequest {
  studentIds: string[];
  /** 转出去向 / 原因备注 */
  note?: string;
}

/* ------------------------------------------------------------------ 毕业归档 */

/**
 * 届别档案：一次「毕业归档」的留痕。
 *
 * 归档是**打标记 + 只读**，不删任何数据：毕业班级的作业与通知原样留在库里，
 * 通过归档详情只读查看。**未毕业而升级的班级不归档**（升级只改年级，数据沿用）。
 */
export interface ArchivedYearDto {
  id: string;
  /** 届别 = 入学年份（2026 表示 2026 级） */
  enrollmentYear: number;
  /** 毕业年份 */
  graduationYear: number;
  /** 届别名，如「2026 级」 */
  name: string;
  note: string;
  operatorId: string | null;
  operatorName: string;
  /** 归档时的统计快照 */
  classCount: number;
  studentCount: number;
  transferredCount: number;
  homeworkCount: number;
  notificationCount: number;
  archivedAt: string;
}

/** 归档里的一个班级 */
export interface ArchivedClassDto {
  id: string;
  name: string;
  grade: string;
  enrollmentYear: number | null;
  classIndex: number | null;
  headTeacherName: string | null;
  studentCount: number;
  homeworkCount: number;
  notificationCount: number;
  archivedAt: string | null;
}

export interface ArchivedYearDetailDto extends ArchivedYearDto {
  classes: ArchivedClassDto[];
  /** 本届毕业生 */
  graduates: StudentDto[];
  /** 本届在读期间转出的学生 */
  transferred: StudentDto[];
}

/** 归档班级的作业与通知（只读） */
export interface ArchivedClassContentDto {
  classId: string;
  className: string;
  homeworks: HomeworkDto[];
  notifications: NotificationDto[];
}

export interface CreateArchiveRequest {
  /** 要归档的届别（入学年份） */
  enrollmentYear: number;
  /** 毕业年份；留空 = 入学年份 + 默认学制（3 年） */
  graduationYear?: number;
  note?: string;
}

/** 学年升级：只改年级，不归档、数据沿用 */
export interface PromoteClassesRequest {
  classIds: string[];
  /** 升级后的年级，如「高二」 */
  grade: string;
}

/* ------------------------------------------------------------------ 学期周次 */

/**
 * 一个教学周的日期区间。
 *
 * 学期周次不能只靠"开学日期 + 每周七天"线性推算：法定节假日调休、周末补课、错峰开学
 * 都会让某一周变长变短。管理员可以逐周设置区间（也可以先按开学日期一键生成再微调）。
 */
export interface TermWeekDto {
  weekNumber: number;
  /** YYYY-MM-DD（本地日期） */
  startDate: string;
  /** YYYY-MM-DD */
  endDate: string;
  note: string;
}

export interface TermWeeksDto {
  /**
   * 这套区间属于谁：空串 = **全校默认**；非空 = 某个班的覆盖。
   * 班级没有自己的配置时回落到全校默认。
   */
  classId: string;
  /** 学期开始日期（第 1 教学周的周一，YYYY-MM-DD） */
  termStartDate: string;
  /** 当前教学周（按区间判定；不在任何区间内时按学期开始日期线性兜底） */
  currentWeek: number;
  /** 本学期的教学周数上限 */
  maxWeek: number;
  /** 是否已逐周配置（false = 完全按学期开始日期线性推算） */
  configured: boolean;
  weeks: TermWeekDto[];
}

export interface UpdateTermWeeksRequest {
  /** 不传 = 改全校默认 */
  classId?: string | null;
  /** 学期开始日期（第 1 教学周的周一）；不传则保持原值 */
  termStartDate?: string;
  /** 逐周区间（整表覆盖） */
  weeks: Array<{ weekNumber: number; startDate: string; endDate: string; note?: string }>;
}

export interface AutoTermWeeksRequest {
  classId?: string | null;
  termStartDate?: string;
  /** 生成多少周；不传用班级的教学周数（Class.termWeeks） */
  maxWeek?: number;
}

/** 联网获取的法定节假日建议（失败时 ok=false，属于正常结果） */
export interface HolidaySuggestionDto {
  ok: boolean;
  /** 失败原因（给人看的一句话）；ok=true 时为 null */
  error: string | null;
  /** 数据来源年份 */
  year: number;
  /** 建议的「不上课」日期区间（调休放假），管理员可据此调整周次 */
  holidays: Array<{ name: string; startDate: string; endDate: string }>;
  checkedAt: string;
}

/* ------------------------------------------------------------------ 班级 */

export interface ClassDto {
  id: string;
  /** 班级称呼，如「2026级1班」（由 enrollmentYear + classIndex 生成） */
  name: string;
  /** 当前年级（高一 / 高二 / 高三），学年升级时更新 */
  grade: string;
  /** 入学年份（届别）：2026 → 称呼「2026级…」 */
  enrollmentYear: number | null;
  /** 班号（同一届内的序号） */
  classIndex: number | null;
  teacherId: string;
  createdAt: string;
  teacher?: ClassTeacherBrief | null;
  studentCount?: number;
  courseCount?: number;
  homeworkCount?: number;
  notificationCount?: number;
  /** 班级码（ClassHelper 班级端班级账号登录用）；仅对有管理权限的角色返回 */
  code?: string;
  /** 是否已设置班级密码（哈希永不外泄） */
  hasPassword?: boolean;
  /** 本学期教学周数（班主任可调，默认 20）：课表周次选择与默认 weekEnd 都用它 */
  termWeeks: number;
  /** 本班学期开始日期（YYYY-MM-DD）；null = 用全局配置 */
  termStartDate?: string | null;
  /** 是否已有启用中的 ClassIsland 联动设备（班级列表/课表页显示「已接入」徽标） */
  classIslandConnected?: boolean;
  /** 通知显示位置（由 ClassHelper 班级端设置，见 CLASSISLAND_NOTIFICATION_CHANNELS） */
  notificationChannel?: ClassIslandNotificationChannel;
  /**
   * 是否允许 ClassHelper 班级端按学号查询本班学生的成绩明细（默认开启）。
   * 关闭后班级端查成绩一律 403，教师端不受影响。
   */
  studentGradeQueryEnabled: boolean;
  /** 毕业归档所属届别；null = 在读（常规班级列表只显示未归档的） */
  archivedYearId?: string | null;
  archivedAt?: string | null;
}

/** 账号简要信息（工号 + 姓名）：用于"班主任""发布人"等展示位 */
export interface ClassTeacherBrief {
  id: string;
  name: string;
  /** 教师的工号（管理员为登录名） */
  username: string;
}

/**
 * 某班某科的任课老师 —— 需求里的「班级 + 科目 + 教师」任课关系。
 * 落在 `Course` 上（它本来就是 `classId + name + teacherId`）。
 */
export interface SubjectTeacherDto {
  courseId: string;
  /** 科目名 */
  subjectName: string;
  teacherId: string;
  teacherName: string;
}

/** 管理员设置某班某科的任课老师 */
export interface AssignSubjectTeachersRequest {
  assignments: Array<{
    /** 已有课程 id；留空时按 subjectName 匹配或自动建课 */
    courseId?: string | null;
    subjectName: string;
    /** 留空表示解除该科的任课老师（保留课程本身） */
    teacherId?: string | null;
  }>;
}

export interface ClassDetailDto extends ClassDto {
  students: StudentDto[];
  courses: CourseDto[];
  /** 班主任（与 `teacher` 同一人，单独给一个语义明确的字段） */
  headTeacher: ClassTeacherBrief | null;
  /** 各科任课老师 */
  subjectTeachers: SubjectTeacherDto[];
}

export interface CreateClassRequest {
  /**
   * 班级称呼。**可以留空** —— 填了 `enrollmentYear` 与 `classIndex` 时由服务端生成「2026级1班」，
   * 这时传进来的 name 会被忽略（避免出现"名字是高一(1)班、届别是 2026 级"这种自相矛盾的数据）。
   */
  name?: string;
  grade: string;
  /** 入学年份（届别），如 2026 */
  enrollmentYear: number;
  /** 班号（同一届内的序号），如 1 */
  classIndex: number;
  /** 可选：自定义班级码，留空自动生成 */
  code?: string;
  /** 本学期教学周数（1~30，仅管理员可调）；不传由服务端用默认值 20 */
  termWeeks?: number;
  /** 仅管理员可指定班主任；不传时由创建者本人担任 */
  teacherId?: string;
}

export interface UpdateClassRequest {
  /** 本班学期开始日期（YYYY-MM-DD，第 1 教学周的周一）；留空串表示回落到全局配置 */
  termStartDate?: string | null;
  /** 入学年份（有名无实的旧数据需要补填；填了会重算 name） */
  enrollmentYear?: number;
  /** 班号（同上） */
  classIndex?: number;
  /** 当前年级（高一 / 高二 / 高三；学年升级时改它，**不归档**） */
  grade?: string;
  /** 本学期教学周数（1~30，仅管理员可调） */
  termWeeks?: number;
}

/** 班级端成绩查询开关 */
export interface UpdateStudentGradeQueryRequest {
  enabled: boolean;
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
  /**
   * 作业所属日期（YYYY-MM-DD，**不带时区**）。
   *
   * 与 createdAt 的区别：createdAt 是"什么时候录的"，assignDate 是"这天的作业"。
   * 客户端 / Web 的按天查看与日期高亮都用它，避免跨时区把作业算到前一天。
   */
  assignDate: string;
  course?: CourseBrief | null;
  creator?: ClassTeacherBrief | null;
  /** 当前登录学生的完成状态（ClassHelper 班级端接口返回） */
  completed?: boolean;
  homeworkStatus?: HomeworkStatusDto | null;
  /** 教师视角：已提交人数 */
  completedCount?: number;
}

/** 某一天有作业（用于日期选择器高亮） */
export interface HomeworkDaySummary {
  /** YYYY-MM-DD */
  date: string;
  /** 当天作业条数 */
  count: number;
}

/** GET /api/homeworks/days 的返回 */
export interface HomeworkDaysDto {
  days: HomeworkDaySummary[];
}

export interface HomeworkStatusDto {
  id: string;
  homeworkId: string;
  /** 学生 id（学生是名单记录，没有账号） */
  studentId: string;
  completed: boolean;
  updatedAt: string;
}

export interface CreateHomeworkRequest {
  classId: string;
  courseId?: string | null;
  title: string;
  content: string;
  /** 作业所属日期（YYYY-MM-DD）；不传按服务器当天处理 */
  assignDate?: string | null;
  attachmentUrl?: string | null;
}

export interface UpdateHomeworkStatusRequest {
  completed: boolean;
}

/** 作业提交名单里的一位学生 */
export interface HomeworkSubmissionDto {
  studentId: string;
  /** 学号（学生唯一标识与查询键） */
  studentNo: string;
  name: string;
  completed: boolean;
}

/**
 * 作业提交名单（"未交名单"功能的载体）：
 * 教师端 / ClassHelper 班级端用它勾选谁没交作业，其余学生一律视为已交。
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
  notSubmittedStudentIds: string[];
}

export interface HomeworkQueryParams {
  classId?: string;
  courseId?: string;
  /** ClassHelper 班级端：只看未完成 */
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
 * ClassHelper 班级端灵动岛会立即弹出"请 XXX 同学找 XXX 老师"。
 */
export interface CreateCallRequest {
  classId: string;
  studentId: string;
  /**
   * 是否"紧急叫人"：
   * - true：落库为 URGENT，ClassHelper 班级端灵动岛无视上课时段立即展开（与紧急通知同等待遇）；
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
  /** 学生 id（学生是名单记录，没有账号） */
  studentId: string;
  examName: string;
  score: number;
  totalScore: number;
  /**
   * 等级口径：percent 百分制 / letter 等级制 A-D / custom 自定义等级。
   * 决定 `level` 是怎么来的，也决定界面上给不给"改等级"的入口。
   */
  levelType: GradeLevelType;
  /**
   * 等级文本。`percent` 下由服务端按得分率生成初值（教师仍可手改并覆盖），
   * `letter`/`custom` 下由教师直接指定。
   */
  level: string;
  publishedAt: string;
  course?: CourseBrief | null;
  student?: StudentBrief | null;
  className?: string | null;
}

export interface CreateGradeRequest {
  classId: string;
  courseId?: string | null;
  studentId: string;
  examName: string;
  score: number;
  totalScore?: number;
  /** 等级口径，默认 percent */
  levelType?: GradeLevelType;
  /** 手填等级；percent 且留空时由服务端按得分率换算 */
  level?: string;
  publishedAt?: string | null;
}

/** 批量导入成绩（教师端"导入成绩"使用） */
export interface BulkCreateGradeRequest {
  classId: string;
  courseId?: string | null;
  examName: string;
  totalScore?: number;
  levelType?: GradeLevelType;
  publishedAt?: string | null;
  items: Array<{ studentId: string; score: number; level?: string }>;
}

/** 单个 / 批量修改等级 */
export interface UpdateGradeLevelsRequest {
  /** 逐条指定等级（单个就是长度为 1 的数组） */
  items: Array<{ id: string; level: string }>;
}

/** 按学号查询的学生成绩明细（ClassHelper 班级端 / 教师端共用） */
export interface StudentGradeDetailDto {
  student: StudentBrief;
  classId: string | null;
  className: string | null;
  /** 该生的全部成绩（按考试时间倒序） */
  items: GradeDto[];
  /** 得分率均值（0-100，一位小数） */
  averagePercent: number;
}

/** 成绩统计（教师端图表 / 班级端汇总） */
export interface GradeStats {
  total: number;
  averagePercent: number;
  byCourse: Array<{ courseId: string | null; courseName: string; count: number; averagePercent: number }>;
  /** 等级分布：等级文本 -> 人数（自定义等级也能统计） */
  distribution: Array<{ level: string; count: number }>;
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
  /** 距屏幕左右边缘的距离（px）：停靠左/右时生效 */
  marginX: number;
  /** 距屏幕上下边缘的距离（px）：停靠顶/底时生效 */
  marginY: number;
  /** 是否跟随鼠标所在屏幕（多显示器教室电脑用） */
  followCursorDisplay: boolean;
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
  /**
   * 多条通知时是否已点过"展开更多"（展开后显示全部放得下的通知）。
   * 由主进程持有：卡片高度与窗口包围盒都由它决定，渲染进程只负责照此渲染。
   */
  listExpanded: boolean;
  /**
   * 展开卡在当前屏幕与停靠位置下的**可用高度上限**（CSS px，已经扣到任务栏/工作区下沿）。
   * 渲染进程用它决定"列表能显示几条"，主进程用它给窗口包围盒封顶 —— 两边算的是同一个数。
   */
  maxCardHeight: number;
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
    /** imported = 由 ClassIsland 插件上报后整体刷新课表 */
    action: 'created' | 'updated' | 'deleted' | 'imported';
    schedule?: ScheduleDto;
  }) => void;
  'class:updated': (payload: { classId: string; action: 'created' | 'updated' | 'deleted' }) => void;
  /** ClassIsland 联动：设备上报了当前上课状态（Web 端实时展示「现在上什么课」） */
  'classisland:state': (payload: ClassIslandStateEvent) => void;
  /** ClassIsland 联动：老师发的提醒已下发给该班设备（Web 端据此提示「已送达」） */
  'classisland:notification': (payload: ClassIslandNotificationEvent) => void;
  /** 会话主体 id：教师/管理员是自己的账号 id，ClassHelper 班级端是班级 id */
  connected: (payload: { sessionId: string; role: UserRole; rooms: string[] }) => void;
}

/* ------------------------------------------------------------------ 导入（模板 / 表格 / 课表时间配置） */

/**
 * 表格导入的类型：
 * - `grades`       成绩单（按学号匹配本班学生）
 * - `students`     学生名单（学号必填唯一；只建名单，不建账号）
 * - `teachers`     教师账号名单（工号 + 姓名）
 * - `classTeachers` 班级任课老师（班级 + 科目 + 工号 + 角色）
 */
export type TableImportKind = 'grades' | 'students' | 'teachers' | 'classTeachers';

/** 表格导入预览：列名、前若干行、建议字段映射与校验问题 */
export interface TableImportPreview {
  kind: TableImportKind;
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
  kind: TableImportKind;
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

/* ------------------------------------------------------------------ ClassIsland 联动（集成） */

/**
 * 通知的显示位置（存在班级上，由教室的班级客户端在设置页里选）。
 * 服务端据此决定「发通知时要不要同时推给教室的 ClassIsland」。
 */
export type ClassIslandNotificationChannel = 'both' | 'client' | 'classisland';

/**
 * 联动方式：
 * - `plugin`：安装「ClassHelper 联动插件」，由插件把 ClassIsland 的当前状态与课表推给本服务；
 * - `import`：只把 ClassIsland 导出的档案 JSON 导入本服务（一次性，无实时联动）。
 */
export type IntegrationMode = 'plugin' | 'import';

/** 设备（一台安装了 ClassIsland 插件的机器）与班级的绑定关系 */
export interface IntegrationDeviceDto {
  id: string;
  classId: string;
  className?: string | null;
  /** 设备显示名（默认取机器名） */
  name: string;
  /** 设备唯一标识（插件上报的机器码） */
  deviceKey: string;
  /** ClassIsland 版本，例如 2.1.0.0 */
  classIslandVersion: string | null;
  /** 插件版本 */
  pluginVersion: string | null;
  mode: IntegrationMode;
  /** 是否接入：接入后插件才能上报状态/课表并接收通知 */
  enabled: boolean;
  /**
   * 是否允许插件把 ClassIsland 的课表**自动**回传到本服务（覆盖/合并本班课表）。
   * **默认关闭**：课表以服务端为准，自动回传会在老师手排课之后被教室的旧课表覆盖；
   * 要取教室的课表请用「从教室机器获取课表」这个手动动作。
   */
  syncScheduleToServer: boolean;
  /** 是否允许把班级课表镜像回 ClassIsland（由插件执行） */
  mirrorScheduleToClassIsland: boolean;
  /** 最后一次"带运行状态"的上报时间（心跳之外还有实际内容的那次） */
  lastSeenAt: string | null;
  /** 最后一次心跳时间（每次上报都刷新）；在线判定看它 */
  lastHeartbeatAt: string | null;
  /** 是否在线：最后一次心跳在 CLASS_HELPER_ONLINE_WINDOW_MS 之内 */
  online: boolean;
  /** 最后一次上报里 ClassIsland 是否已加载课表 */
  classPlanLoaded: boolean;
  /** 最后一次上报里的当前科目 */
  currentSubject: string | null;
  /** 最后一次上报里的当前时间点状态（OnClass / Breaking / AfterSchool / None / PrepareOnClass） */
  currentTimeState: string | null;
  /** 最后一次上报里的当前节次起止时间（HH:mm） */
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  /** 最后一次上报里的下一节课科目 */
  nextSubject: string | null;
  /** 是否有待办的「立即上报一次课表」请求（Web 端点过之后置位，插件上报后清除） */
  requestScheduleReport: boolean;
  /** 令牌前缀提示（chci_xxxxxxxx…）：设备列表里用于区分多台设备各自用的令牌 */
  tokenHint?: string;
  /** 创建/重置接口一次性下发的纯文本设备令牌（其他接口永不返回） */
  token?: string;
  createdAt: string;
  updatedAt: string;
}

/** 创建/重置设备令牌的返回（token 只在这一次返回） */
export interface IntegrationDeviceTokenDto {
  device: IntegrationDeviceDto;
  token: string;
}

export interface CreateIntegrationDeviceRequest {
  classId: string;
  name?: string;
  mode?: IntegrationMode;
  syncScheduleToServer?: boolean;
  mirrorScheduleToClassIsland?: boolean;
}

export interface UpdateIntegrationDeviceRequest {
  name?: string;
  enabled?: boolean;
  syncScheduleToServer?: boolean;
  mirrorScheduleToClassIsland?: boolean;
  mode?: IntegrationMode;
}

/* ------------------ ClassHelper 班级端在线状态（教师网页查看） ------------------ */

/** 一台 ClassHelper 班级端设备的在线状态 */
export interface ClassHelperDeviceStatusDto {
  deviceId: string;
  /** 设备显示名（默认取机器名） */
  deviceName: string;
  /** 设备/机器码 */
  deviceKey: string;
  /** 是否接入（停用的设备一律按离线展示） */
  enabled: boolean;
  /** 在线 = 最近一次心跳在 CLASS_HELPER_ONLINE_WINDOW_MS 之内 */
  online: boolean;
  /** 最后一次带运行状态的上报时间 */
  lastSeenAt: string | null;
  /** 最后一次心跳时间 */
  lastHeartbeatAt: string | null;
  pluginVersion: string | null;
  classIslandVersion: string | null;
}

/**
 * 某个班的 ClassHelper 班级端在线状态。
 *
 * 范围：管理员看全部班级；普通教师看自己担任班主任的班级 ∪ 任课（有 Course）的班级。
 */
export interface ClassHelperStatusDto {
  classId: string;
  className: string;
  grade: string;
  /** 该班绑定的全部设备（可能多台：讲台机 + 备用机） */
  devices: ClassHelperDeviceStatusDto[];
  /** 任一设备在线即视为该班在线 */
  online: boolean;
  /** 是否允许班级端按学号查询本班学生成绩明细 */
  studentGradeQueryEnabled: boolean;
}

/** GET /api/integrations/classisland/status 的返回 */
export interface ClassHelperStatusListDto {
  /** 后端判定所用的服务器时间（前端据此算"距今多久"，避免依赖本机时钟） */
  serverTime: string;
  /** 在线判定窗口（毫秒） */
  onlineWindowMs: number;
  classes: ClassHelperStatusDto[];
}

/** 通知下发：把一条通知推给某班级的 ClassIsland 设备（在 ClassIsland 上全屏提醒） */
export interface SendClassIslandNotificationRequest {
  classId: string;
  title: string;
  content: string;
  /** 显示时长（秒，1~120，默认 8）：映射到 ClassIsland 的 NotificationContent.Duration */
  durationSeconds?: number;
  /** 是否语音朗读（默认 false） */
  speech?: boolean;
  /** 语音朗读内容（留空则朗读 title + content） */
  speechContent?: string;
  /** 是否同时落库到班级通知中心（默认 true） */
  saveToNotifications?: boolean;
  /** 优先级（落库时使用，默认 NORMAL） */
  priority?: NotificationPriority;
}

export interface SendClassIslandNotificationResult {
  /** 已下发（在线）的设备数 */
  delivered: number;
  /** 目标设备总数 */
  targetCount: number;
  /** 一并落库的通知 id（saveToNotifications=false 时为 null） */
  notificationId: string | null;
  /**
   * 本次被跳过的原因（没有跳过时为 null/undefined）。
   * `channel-client` = 该班教室在客户端里选了"只在 ClassHelper 客户端显示"，
   * 因此没有推送到 ClassIsland —— 让老师知道"不是没送达，是教室没要"。
   */
  skipped?: 'channel-client' | null;
}

/* ------------------ 插件上报（设备令牌鉴权，不是 JWT 会话） ------------------ */

/** 插件上报的课表条目（已按本系统口径归一化） */
export interface ClassIslandScheduleEntry {
  /** 1=周一 … 7=周日（插件已从 ClassIsland 的 0=周日 转换） */
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  subject: string;
  teacherName?: string | null;
  weekParity: WeekParity;
  weekCountDiv: number;
  weekCountDivTotal: number;
  planName: string;
}

/** 插件上报的节次时间（时间表） */
export interface ClassIslandTimeLayoutEntry {
  index: number;
  name: string;
  startTime: string;
  endTime: string;
  type: 'class' | 'break' | 'divider' | 'action';
  skipped: boolean;
}

/** POST /api/integrations/classisland/report —— 插件的一次上报 */
export interface ClassIslandReportRequest {
  /** 插件/应用版本，便于排查 */
  pluginVersion?: string;
  classIslandVersion?: string;
  /** 本机运行状态 */
  state?: {
    inClass: boolean;
    subject: string | null;
    nextSubject: string | null;
    /** 当前时间点状态字符串（ClassIsland TimeState） */
    timeState: string | null;
    periodStart: string | null;
    periodEnd: string | null;
    week: number | null;
    classPlanLoaded: boolean;
    /** 客户端本机时间，用于诊断时钟偏差 */
    clientTime: string;
  };
  /** 课表（仅在 syncScheduleToServer 打开时有意义；不传表示本次不上报课表） */
  schedule?: {
    /** replace 覆盖本班课表 / merge 合并（默认） */
    mode: 'replace' | 'merge';
    entries: ClassIslandScheduleEntry[];
  } | null;
  /** 节次时间表 */
  timeLayout?: {
    name?: string;
    mode: 'replace' | 'merge';
    items: ClassIslandTimeLayoutEntry[];
  } | null;
}

/** POST /api/integrations/classisland/report 的返回 */
export interface ClassIslandReportResult {
  /** 服务端是否接受并应用了课表 */
  scheduleApplied: boolean;
  scheduleCreated: number;
  scheduleUpdated: number;
  /** 自动补建/命中的课程名 */
  courses: string[];
  timeLayoutApplied: boolean;
  /** 服务端当前教学周（插件可用来校正"第几周"） */
  week: number;
  /** 服务端时间（插件可用来校正时钟） */
  serverTime: string;
  /** 回传给插件的外观/行为设置：本轮需要下发的通知已随实时事件推送 */
  settings: {
    mirrorScheduleToClassIsland: boolean;
    enabled: boolean;
    /**
     * 服务端请求插件**立刻上报一次课表**（Web 端点了「从教室机器获取课表」）。
     * 独立于 `syncScheduleToServer`：那个开关管的是"要不要自动回传"。
     */
    scheduleRequested?: boolean;
  };
  /** 尚未在 ClassIsland 上确认过的一条提醒（插件可立即弹出） */
  pendingNotification?: ClassIslandPushNotification | null;
}

/** 下发给 ClassIsland 的提醒（教师发通知 → 学生机器全屏弹出） */
export interface ClassIslandPushNotification {
  id: string;
  title: string;
  content: string;
  /** 显示时长（秒） */
  durationSeconds: number;
  /** 语音朗读内容；null = 不朗读 */
  speechContent: string | null;
  createdAt: string;
  /** 是否紧急（紧急时插件用更强的遮罩与更长的时长） */
  urgent: boolean;
  /**
   * 提醒类型：
   * - `notification`：通知类提醒 —— **上课时段插件会暂存，下课后才弹**；
   * - `call`：叫人等「主动通知」—— 不论是否上课都立刻弹（老师正在等学生）。
   */
  kind: 'notification' | 'call';
  classId: string;
  className?: string | null;
  teacherName?: string | null;
}

/** GET /api/integrations/classisland/pending 的返回（插件重连后补齐漏掉的通知） */
export interface ClassIslandPendingResult {
  notifications: ClassIslandPushNotification[];
  serverTime: string;
  week: number;
}

/** 插件拉取本班的整份课表（mirrorScheduleToClassIsland 打开时，插件把课表写回 ClassIsland） */
export interface ClassIslandClassPlanPull {
  /** ClassIsland 的口径：0=周日、1=周一 … 6=周六 */
  classPlan: {
    entries: {
      /** ClassIsland 的 WeekDay：0=周日 … 6=周六 */
      weekDay: number;
      weekCountDiv: number;
      weekCountDivTotal: number;
      /** 科目名 */
      subject: string;
      teacherName: string | null;
      /**
       * 该课目的起止时间（HH:mm）。
       *
       * ClassIsland 的 `ClassPlan.Classes[i]` 必须与时间表里第 i 个上课点对齐，
       * 因此插件要按这些时间重建时间表 —— 缺了它们整份镜像课表都会错位。
       */
      startTime: string;
      endTime: string;
      timeLayoutId: string;
    }[];
    timeLayouts: {
      id: string;
      name: string;
      layouts: {
        startTime: string;
        endTime: string;
        /** ClassIsland TimeType：0=上课、1=课间、2=分割线、3=行动 */
        timeType: number;
      }[];
    }[];
    /** 建议的档案名 */
    profileName: string;
    /** 教学周起始日期（用于插件设置 ClassIsland 的周次口径） */
    termStartDate: string;
  };
  week: number;
  /**
   * 学期逐周区间（管理员在「学期周次」里配的）。
   * 空数组 = 完全按 `termStartDate` 线性推算。
   * ClassIsland 自身只认"教学周序号 + 单双周"，因此它拿这个主要是为了
   * 校正"现在是第几周"、以及在设置页里展示教室所在的实际日期区间。
   */
  weekRanges?: Array<{ weekNumber: number; startDate: string; endDate: string }>;
  serverTime: string;
}

/** Socket.IO 事件：ClassIsland 设备状态变化（Web 管理端实时展示） */
export interface ClassIslandStateEvent {
  classId: string;
  deviceId: string;
  deviceName: string;
  inClass: boolean;
  subject: string | null;
  nextSubject: string | null;
  timeState: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  week: number | null;
  classPlanLoaded: boolean;
  at: string;
}

/** Socket.IO 事件：有新提醒下发到 ClassIsland（插件与 Web 端都可据此刷新） */
export interface ClassIslandNotificationEvent extends ClassIslandPushNotification {
  /** 是下发给本班级设备，还是仅通知 Web 端展示 */
  targetCount: number;
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

/* ================================================================ 数据库管理（仅管理员） */

/** 数据库管理支持的提供方（Redis 等键值库不是 Prisma 支持的主库，不在范围内） */
export type DatabaseProvider = 'sqlite' | 'mysql';

/** GET /api/database/status 的返回 */
export interface DatabaseStatusDto {
  provider: DatabaseProvider;
  connected: boolean;
  /** ping 延迟（毫秒）；未连接时为 null */
  latencyMs: number | null;
  /** 数据库引擎版本（sqlite_version() / VERSION()） */
  version: string | null;
  /** 数据体积（字节）；MySQL 取 information_schema 汇总 */
  sizeBytes: number | null;
  /** 当前连接串的脱敏展示（MySQL 隐藏密码） */
  databaseUrlMasked: string;
  /** SQLite 数据文件绝对路径（MySQL 为空串） */
  sqliteFilePath: string;
  /** 数据目录（备份与定时配置所在处） */
  dataDir: string;
  backupDir: string;
  tables: DatabaseTableCountDto[];
  backups: DatabaseBackupMetaDto[];
  schedule: DatabaseBackupScheduleDto;
  /** 是否有正在进行的切换任务（期间禁止备份/导入/恢复） */
  switchRunning: boolean;
}

export interface DatabaseTableCountDto {
  name: string;
  /** -1 表示统计失败（表结构与代码不一致时出现） */
  count: number;
}

export interface DatabaseBackupMetaDto {
  name: string;
  kind: 'manual' | 'auto';
  sizeBytes: number;
  createdAt: string;
}

export interface DatabaseBackupScheduleDto {
  enabled: boolean;
  intervalHours: number;
  keepCount: number;
  lastAutoBackupAt: string | null;
}

/** POST /api/database/test-connection 的返回 */
export interface DatabaseConnectionTestDto {
  ok: boolean;
  provider: DatabaseProvider;
  latencyMs: number | null;
  version: string | null;
  /** 新建 SQLite 库时目标文件还不存在，属正常情况（切换时会自动建库） */
  note?: string;
  error?: string;
}

/** 数据库切换任务（POST /switch 后用 jobId 轮询） */
export interface DatabaseSwitchJobDto {
  id: string;
  status: 'running' | 'done' | 'error';
  target: { provider: DatabaseProvider; url: string };
  steps: DatabaseSwitchStepDto[];
  error?: string;
  /** 完成后为 true：需要重启服务端才能让新数据库生效 */
  restartRequired: boolean;
  counts?: Record<string, number>;
  backupName?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface DatabaseSwitchStepDto {
  name: string;
  status: 'running' | 'done' | 'error';
  detail?: string;
}

/* ------------------------------------------------------------------ 更新检查 */

/** Release 里的一个附件（安装包 / 便携版 / 插件包） */
export interface UpdateAssetDto {
  name: string;
  downloadUrl: string;
  size: number;
}

/**
 * 更新检查结果（服务端 `GET /api/update/check` 与桌面客户端 IPC 共用同一结构）。
 *
 * 两点约定：
 * 1. **`ok:false` 是正常结果，不是异常** —— 服务器没有外网、GitHub 限流、请求超时都会走到这里，
 *    调用方按"暂时查不到"呈现即可（与 ClassIsland 推送失败只记日志是同一种处理思路）。
 * 2. **`currentVersion` 由调用方各自提供**：服务端比的是服务端版本、客户端比的是客户端版本。
 *    两边安装版本可能不同（例如教室机没跟着升级），所以不能由一端替另一端判断。
 */
export interface UpdateInfo {
  ok: boolean;
  /** 失败原因（给人看的一句话）；ok=true 时为 null */
  error: string | null;
  /** 本机版本 */
  currentVersion: string;
  /** GitHub 上最新 Release 的版本号；ok=false 时为 null */
  latestVersion: string | null;
  hasUpdate: boolean;
  /** 给人看的 Release 页面地址（「前往下载」用） */
  releaseUrl: string;
  /** Release 标题 */
  releaseName: string | null;
  publishedAt: string | null;
  /** Release 说明（Markdown 原文，由界面自行截断展示） */
  notes: string | null;
  assets: UpdateAssetDto[];
  checkedAt: string;
}
