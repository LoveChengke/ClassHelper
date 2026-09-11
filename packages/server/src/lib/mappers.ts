import type {
  ClassDto,
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

export function toClassDto(item: ClassLike): ClassDto {
  return {
    id: item.id,
    name: item.name,
    grade: item.grade,
    teacherId: item.teacherId,
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
  dueAt: Date | null;
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
 * @param options.withStatus 是否统计完成人数（教师视角）
 */
export function toHomeworkDto(
  item: HomeworkLike,
  options: { userId?: string | null; withStatus?: boolean } = {},
): HomeworkDto {
  const statuses = item.statuses ?? [];
  const own = options.userId ? statuses.find((status) => status.userId === options.userId) : undefined;

  return {
    id: item.id,
    classId: item.classId,
    courseId: item.courseId,
    title: item.title,
    content: item.content,
    attachmentUrl: item.attachmentUrl,
    dueAt: toIsoOrNull(item.dueAt),
    createdBy: item.createdBy,
    createdAt: toIso(item.createdAt),
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

export function toNotificationDto(
  item: NotificationLike,
  options: { userId?: string | null; withStatus?: boolean } = {},
): NotificationDto {
  const reads = item.reads ?? [];
  const own = options.userId ? reads.find((read) => read.userId === options.userId) : undefined;

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
