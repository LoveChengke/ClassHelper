import { dayKeyLocal } from '@classhelper/shared';
import type {
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
  StudentDto,
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
 * "个人记录"归属范围解析：
 * - 传入 userIds（班级账号 = 全班学生）时优先使用；
 * - 否则退化为单个 userId（普通学生账号 = 自己）。
 */
function resolvePool(options: { userId?: string | null; userIds?: string[] }): string[] {
  if (options.userIds && options.userIds.length > 0) return options.userIds;
  return options.userId ? [options.userId] : [];
}

export interface UserLike {
  id: string;
  username: string;
  name: string;
  role: string;
  classId: string | null;
  createdAt: Date;
}

export interface TeacherBriefLike {
  id: string;
  name: string;
  username: string;
}

export interface StudentLike extends UserLike {
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
    classId: user.classId,
    createdAt: toIso(user.createdAt),
  };
}

export function toStudentDto(user: StudentLike): StudentDto {
  return {
    ...toUserDto(user),
    className: user.class?.name ?? null,
    grade: user.class?.grade ?? null,
  };
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
  teacherId: string;
  /** 本学期教学周数（班主任可调，默认 20） */
  termWeeks?: number;
  /** 通知显示位置：both / client / classisland（由教室的班级客户端设置） */
  notificationChannel?: string | null;
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
    teacherId: item.teacherId,
    termWeeks: item.termWeeks ?? 20,
    notificationChannel: toNotificationChannel(item.notificationChannel),
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
  userId: string;
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
    userId: item.userId,
    completed: item.completed,
    updatedAt: toIso(item.updatedAt),
  };
}

/**
 * @param options.userId 指定当前用户，用于填充 completed / homeworkStatus
 * @param options.userIds 班级账号（班级设备）场景：以"全班学生"为范围找完成状态
 * @param options.withStatus 是否统计完成人数（教师视角）
 */
export function toHomeworkDto(
  item: HomeworkLike,
  options: { userId?: string | null; userIds?: string[]; withStatus?: boolean } = {},
): HomeworkDto {
  const statuses = item.statuses ?? [];
  const pool = resolvePool(options);
  const own = pool.length > 0 ? statuses.find((status) => pool.includes(status.userId)) : undefined;

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
  userId: string;
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
 * @param options.userId 指定当前用户（普通学生账号）
 * @param options.userIds 班级账号（班级设备）场景：以"全班学生"为范围找已读状态
 * @param options.withStatus 是否统计已读人数（教师视角）
 */
export function toNotificationDto(
  item: NotificationLike,
  options: { userId?: string | null; userIds?: string[]; withStatus?: boolean } = {},
): NotificationDto {
  const reads = item.reads ?? [];
  const pool = resolvePool(options);
  const own = pool.length > 0 ? reads.find((read) => pool.includes(read.userId)) : undefined;

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
  userId: string;
  examName: string;
  score: number;
  totalScore: number;
  publishedAt: Date;
  course?: CourseBriefLike | null;
  student?: TeacherBriefLike | null;
  class?: { name: string } | null;
}

export function toGradeDto(item: GradeLike): GradeDto {
  return {
    id: item.id,
    classId: item.classId,
    courseId: item.courseId,
    userId: item.userId,
    examName: item.examName,
    score: item.score,
    totalScore: item.totalScore,
    publishedAt: toIso(item.publishedAt),
    course: item.course ? toCourseBrief(item.course) : null,
    student: item.student ? toTeacherBrief(item.student) : null,
    className: item.class?.name ?? null,
  };
}
