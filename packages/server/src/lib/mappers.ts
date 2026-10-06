import { dayKeyLocal } from '@classhelper/shared';
import type {
  ArchivedClassDto,
  ArchivedYearDto,
  ClassDto,
  ClassIslandNotificationChannel,
  ClassTeacherBrief,
  CourseBrief,
  CourseDto,
  GradeDto,
  HomeworkDto,
  HomeworkStatusDto,
  NotificationDto,
  NotificationPriority,
  ScheduleDto,
  SessionUser,
  StudentBrief,
  StudentDto,
  StudentTransferDto,
  UserDto,
  UserRole,
} from '@classhelper/shared';

/**
 * 数据库记录 -> API DTO 的映射层。
 *
 * 这里刻意使用结构化的 `XxxLike` 接口而不是 Prisma 生成的模型类型：
 * 1) 生成代码的模型类型命名随版本变化，映射层不应该跟着漂移；
 * 2) 只有被 include/select 出来的字段才会出现在结果里，结构化类型能精确表达这一点。
 */

const toIso = (value: Date): string => value.toISOString();
const toIsoOrNull = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);

/**
 * "个人记录"归属范围解析（记录键是**学生 id**）：
 * - 传入 studentIds（ClassHelper 班级端 = 全班学生）时优先使用；
 * - 否则退化为单个 studentId。
 */
function resolvePool(options: { studentId?: string | null; studentIds?: string[] }): string[] {
  if (options.studentIds && options.studentIds.length > 0) return options.studentIds;
  return options.studentId ? [options.studentId] : [];
}

export interface UserLike {
  id: string;
  username: string;
  name: string;
  role: string;
  /** 手机号；老库/老对象可能没有这个字段 */
  phone?: string | null;
  createdAt: Date;
}

export interface TeacherBriefLike {
  id: string;
  name: string;
  username: string;
}

/** 学生简要信息（id + 学号 + 姓名） */
export interface StudentBriefLike {
  id: string;
  studentNo: string;
  name: string;
}

/**
 * 学生记录（`Student` 表）。
 *
 * 学生不是账号 —— 这里没有 `role`、没有 `passwordHash`，
 * 唯一的标识是 `studentNo`（学号）。
 */
export interface StudentLike {
  id: string;
  studentNo: string;
  name: string;
  classId: string | null;
  gender: string;
  guardianPhone: string;
  status: string;
  archivedYearId?: string | null;
  archivedAt?: Date | null;
  transferredAt?: Date | null;
  transferNote?: string;
  createdAt: Date;
  class?: { name: string; grade: string } | null;
}

export interface CourseBriefLike {
  id: string;
  name: string;
}

export function toUserDto(user: UserLike): UserDto {
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role as UserRole,
    phone: user.phone ?? '',
    createdAt: toIso(user.createdAt),
  };
}

/** 账号的会话主体（登录返回 / GET /auth/me） */
export function toUserSessionUser(user: UserLike): SessionUser {
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role as UserRole,
    phone: user.phone ?? '',
    classId: null,
    createdAt: toIso(user.createdAt),
  };
}

/** ClassHelper 班级端登录时用到的班级字段 */
export interface ClassDeviceLike {
  id: string;
  code: string;
  name: string;
  grade: string;
  studentGradeQueryEnabled: boolean;
  createdAt: Date;
}

/**
 * ClassHelper 班级端的会话主体：`id` 与 `classId` 都是**班级 id**，
 * 角色是 `CLASS_DEVICE`（学生不是账号，因此这里不会出现学生身份）。
 */
export function toClassDeviceUser(record: ClassDeviceLike): SessionUser {
  return {
    id: record.id,
    username: record.code,
    name: record.name,
    role: 'CLASS_DEVICE',
    classId: record.id,
    className: record.name,
    grade: record.grade,
    classSession: true,
    classCode: record.code,
    studentGradeQueryEnabled: record.studentGradeQueryEnabled,
    createdAt: toIso(record.createdAt),
  };
}

export function toStudentDto(student: StudentLike): StudentDto {
  return {
    id: student.id,
    studentNo: student.studentNo,
    name: student.name,
    classId: student.classId,
    className: student.class?.name ?? null,
    grade: student.class?.grade ?? null,
    gender: (student.gender ?? '') as StudentDto['gender'],
    guardianPhone: student.guardianPhone ?? '',
    status: (student.status ?? 'active') as StudentDto['status'],
    archivedYearId: student.archivedYearId ?? null,
    archivedAt: toIsoOrNull(student.archivedAt),
    transferredAt: toIsoOrNull(student.transferredAt),
    transferNote: student.transferNote ?? '',
    createdAt: toIso(student.createdAt),
  };
}

/** 学生简要信息（成绩、提交名单等引用位） */
export function toStudentBrief(student: StudentBriefLike): StudentBrief {
  return { id: student.id, studentNo: student.studentNo, name: student.name };
}

export function toTeacherBrief(user: TeacherBriefLike): ClassTeacherBrief {
  return { id: user.id, name: user.name, username: user.username };
}

export function toCourseBrief(course: CourseBriefLike): CourseBrief {
  return { id: course.id, name: course.name };
}

/* ------------------------------------------------------------------ 班级 */

export interface ClassLike {
  id: string;
  name: string;
  grade: string;
  /** 入学年份（届别）；老数据可能为空 */
  enrollmentYear?: number | null;
  /** 班号；老数据可能为空 */
  classIndex?: number | null;
  teacherId: string;
  /** 本学期教学周数（班主任可调，默认 20） */
  termWeeks?: number;
  /** 通知显示位置：both / client / classisland（由 ClassHelper 班级端设置） */
  notificationChannel?: string | null;
  /** 班级端按学号查成绩的开关 */
  studentGradeQueryEnabled?: boolean | null;
  /** 毕业归档所属届别；null = 在读 */
  archivedYearId?: string | null;
  archivedAt?: Date | null;
  createdAt: Date;
  teacher?: TeacherBriefLike | null;
  _count?: {
    students?: number;
    courses?: number;
    homeworks?: number;
    notifications?: number;
    enrollments?: number;
  };
}

/** 通知显示位置：库里存字符串，出参收敛成联合类型（非法值一律按默认 both 处理） */
export function toNotificationChannel(value: string | null | undefined): ClassIslandNotificationChannel {
  return value === 'client' || value === 'classisland' ? value : 'both';
}

export function toClassDto(item: ClassLike): ClassDto {
  return {
    id: item.id,
    name: item.name,
    grade: item.grade,
    enrollmentYear: item.enrollmentYear ?? null,
    classIndex: item.classIndex ?? null,
    teacherId: item.teacherId,
    termWeeks: item.termWeeks ?? 20,
    notificationChannel: toNotificationChannel(item.notificationChannel),
    // 默认开启：老库补列时的默认值也是 true，两边保持一致
    studentGradeQueryEnabled: item.studentGradeQueryEnabled ?? true,
    archivedYearId: item.archivedYearId ?? null,
    archivedAt: toIsoOrNull(item.archivedAt),
    createdAt: toIso(item.createdAt),
    teacher: item.teacher ? toTeacherBrief(item.teacher) : null,
    studentCount: item._count?.students ?? undefined,
    courseCount: item._count?.courses ?? undefined,
    homeworkCount: item._count?.homeworks ?? undefined,
    notificationCount: item._count?.notifications ?? undefined,
  };
}

/* ------------------------------------------------------------------ 课程 */

export interface CourseLike {
  id: string;
  name: string;
  teacherId: string;
  classId: string;
  createdAt: Date;
  teacher?: TeacherBriefLike | null;
}

export function toCourseDto(item: CourseLike): CourseDto {
  return {
    id: item.id,
    name: item.name,
    teacherId: item.teacherId,
    classId: item.classId,
    createdAt: toIso(item.createdAt),
    teacher: item.teacher ? toTeacherBrief(item.teacher) : null,
  };
}

/* ------------------------------------------------------------------ 课表 */

export interface ScheduleLike {
  id: string;
  classId: string;
  courseId: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  location: string | null;
  weekStart: number;
  weekEnd: number;
  weekParity: string;
  createdAt: Date;
  course?: CourseBriefLike | null;
}

export function toScheduleDto(item: ScheduleLike): ScheduleDto {
  return {
    id: item.id,
    classId: item.classId,
    courseId: item.courseId,
    dayOfWeek: item.dayOfWeek,
    startTime: item.startTime,
    endTime: item.endTime,
    location: item.location,
    weekStart: item.weekStart,
    weekEnd: item.weekEnd,
    weekParity: (item.weekParity ?? 'ALL') as ScheduleDto['weekParity'],
    createdAt: toIso(item.createdAt),
    course: item.course ? toCourseBrief(item.course) : null,
  };
}

/* ------------------------------------------------------------------ 作业 */

export interface HomeworkStatusLike {
  id: string;
  homeworkId: string;
  studentId: string;
  completed: boolean;
  updatedAt: Date;
}

export interface HomeworkLike {
  id: string;
  classId: string;
  courseId: string | null;
  title: string;
  content: string;
  attachmentUrl: string | null;
  /** 作业所属日期（YYYY-MM-DD，本地日期）；老库可能为空串 */
  assignDate?: string | null;
  createdBy: string;
  createdAt: Date;
  course?: CourseBriefLike | null;
  creator?: TeacherBriefLike | null;
  statuses?: HomeworkStatusLike[];
}

export function toHomeworkStatusDto(item: HomeworkStatusLike): HomeworkStatusDto {
  return {
    id: item.id,
    homeworkId: item.homeworkId,
    studentId: item.studentId,
    completed: item.completed,
    updatedAt: toIso(item.updatedAt),
  };
}

/**
 * @param options.studentId 指定单个学生，用于填充 completed / homeworkStatus
 * @param options.studentIds ClassHelper 班级端场景：以"全班学生"为范围找完成状态
 * @param options.withStatus 是否统计完成人数（教师视角）
 */
export function toHomeworkDto(
  item: HomeworkLike,
  options: { studentId?: string | null; studentIds?: string[]; withStatus?: boolean } = {},
): HomeworkDto {
  const statuses = item.statuses ?? [];
  const pool = resolvePool(options);
  const own = pool.length > 0 ? statuses.find((status) => pool.includes(status.studentId)) : undefined;

  return {
    id: item.id,
    classId: item.classId,
    courseId: item.courseId,
    title: item.title,
    content: item.content,
    attachmentUrl: item.attachmentUrl,
    createdBy: item.createdBy,
    createdAt: toIso(item.createdAt),
    // 老库兜底：assignDate 为空时按 createdAt 的本地日期回退，前端不必处理空值
    assignDate: item.assignDate || dayKeyLocal(item.createdAt),
    course: item.course ? toCourseBrief(item.course) : null,
    creator: item.creator ? toTeacherBrief(item.creator) : null,
    completed: own ? own.completed : undefined,
    homeworkStatus: own ? toHomeworkStatusDto(own) : null,
    completedCount: options.withStatus ? statuses.filter((status) => status.completed).length : undefined,
  };
}

/* ------------------------------------------------------------------ 通知 */

export interface NotificationReadLike {
  id: string;
  notificationId: string;
  studentId: string;
  readAt: Date;
}

export interface NotificationLike {
  id: string;
  classId: string;
  title: string;
  content: string;
  priority: string;
  createdBy: string;
  createdAt: Date;
  creator?: TeacherBriefLike | null;
  reads?: NotificationReadLike[];
}

/**
 * @param options.studentId 指定单个学生
 * @param options.studentIds ClassHelper 班级端场景：以"全班学生"为范围找已读状态
 * @param options.withStatus 是否统计已读人数（教师视角）
 */
export function toNotificationDto(
  item: NotificationLike,
  options: { studentId?: string | null; studentIds?: string[]; withStatus?: boolean } = {},
): NotificationDto {
  const reads = item.reads ?? [];
  const pool = resolvePool(options);
  const own = pool.length > 0 ? reads.find((read) => pool.includes(read.studentId)) : undefined;

  return {
    id: item.id,
    classId: item.classId,
    title: item.title,
    content: item.content,
    priority: item.priority as NotificationPriority,
    createdBy: item.createdBy,
    createdAt: toIso(item.createdAt),
    creator: item.creator ? toTeacherBrief(item.creator) : null,
    read: own ? true : false,
    readAt: toIsoOrNull(own?.readAt),
    readCount: options.withStatus ? reads.length : undefined,
  };
}

/* ------------------------------------------------------------------ 成绩 */

export interface GradeLike {
  id: string;
  classId: string;
  courseId: string | null;
  studentId: string;
  examName: string;
  score: number;
  totalScore: number;
  /** 等级口径：percent / letter / custom（老库可能为空，按 percent 兜底） */
  levelType?: string | null;
  /** 等级文本（老库可能为空） */
  level?: string | null;
  publishedAt: Date;
  course?: CourseBriefLike | null;
  student?: StudentBriefLike | null;
  class?: { name: string } | null;
}

export function toGradeDto(item: GradeLike): GradeDto {
  return {
    id: item.id,
    classId: item.classId,
    courseId: item.courseId,
    studentId: item.studentId,
    examName: item.examName,
    score: item.score,
    totalScore: item.totalScore,
    levelType: (item.levelType ?? 'percent') as GradeDto['levelType'],
    level: item.level ?? '',
    publishedAt: toIso(item.publishedAt),
    course: item.course ? toCourseBrief(item.course) : null,
    student: item.student ? toStudentBrief(item.student) : null,
    className: item.class?.name ?? null,
  };
}

/* ------------------------------------------------------------------ 调班 / 归档 */

export interface StudentTransferLike {
  id: string;
  studentId: string;
  studentNo: string;
  studentName: string;
  fromClassId: string | null;
  fromClassName: string;
  toClassId: string | null;
  toClassName: string;
  operatorId: string | null;
  operatorName: string;
  mode: string;
  note?: string | null;
  createdAt: Date;
}

export function toStudentTransferDto(item: StudentTransferLike): StudentTransferDto {
  return {
    id: item.id,
    studentId: item.studentId,
    studentNo: item.studentNo,
    studentName: item.studentName,
    fromClassId: item.fromClassId,
    fromClassName: item.fromClassName,
    toClassId: item.toClassId,
    toClassName: item.toClassName,
    operatorId: item.operatorId,
    operatorName: item.operatorName,
    mode: item.mode as StudentTransferDto['mode'],
    note: item.note ?? '',
    createdAt: toIso(item.createdAt),
  };
}

export interface ArchivedYearLike {
  id: string;
  enrollmentYear: number;
  graduationYear: number;
  name: string;
  note: string;
  operatorId: string | null;
  operatorName: string;
  classCount: number;
  studentCount: number;
  transferredCount: number;
  homeworkCount: number;
  notificationCount: number;
  archivedAt: Date;
}

export function toArchivedYearDto(item: ArchivedYearLike): ArchivedYearDto {
  return {
    id: item.id,
    enrollmentYear: item.enrollmentYear,
    graduationYear: item.graduationYear,
    name: item.name,
    note: item.note,
    operatorId: item.operatorId,
    operatorName: item.operatorName,
    classCount: item.classCount,
    studentCount: item.studentCount,
    transferredCount: item.transferredCount,
    homeworkCount: item.homeworkCount,
    notificationCount: item.notificationCount,
    archivedAt: toIso(item.archivedAt),
  };
}

export interface ArchivedClassLike {
  id: string;
  name: string;
  grade: string;
  enrollmentYear: number | null;
  classIndex: number | null;
  archivedAt: Date | null;
  teacher?: { name: string } | null;
  _count?: { students?: number; homeworks?: number; notifications?: number };
}

export function toArchivedClassDto(item: ArchivedClassLike): ArchivedClassDto {
  return {
    id: item.id,
    name: item.name,
    grade: item.grade,
    enrollmentYear: item.enrollmentYear,
    classIndex: item.classIndex,
    headTeacherName: item.teacher?.name ?? null,
    studentCount: item._count?.students ?? 0,
    homeworkCount: item._count?.homeworks ?? 0,
    notificationCount: item._count?.notifications ?? 0,
    archivedAt: toIsoOrNull(item.archivedAt),
  };
}
