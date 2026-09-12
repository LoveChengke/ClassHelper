import {
  SOCKET_EVENTS,
  gradeLevel,
  gradePercent,
  type GradeDto,
  type GradeLevel,
  type GradeStats,
} from '@classhelper/shared';
import { assertCanManageGrades, classScopeWhere, resolveClassScope } from '../../lib/access.js';
import { prisma } from '../../lib/db.js';
import { ApiError } from '../../lib/http.js';
import type { TokenPayload } from '../../lib/jwt.js';
import { toGradeDto } from '../../lib/mappers.js';
import { parseOptionalDate } from '../../lib/schemas.js';
import { resolvePersonalIds } from '../../lib/session.js';
import { emitToClass, emitToUser } from '../../realtime/bus.js';
import type { BulkCreateGradeInput, CreateGradeInput, UpdateGradeInput } from './grades.schemas.js';

const courseSelect = { select: { id: true, name: true } } as const;
const studentSelect = { select: { id: true, name: true, username: true } } as const;
const classSelect = { select: { name: true } } as const;
const include = { course: courseSelect, student: studentSelect, class: classSelect } as const;

export interface ListGradeOptions {
  classId?: string;
  courseId?: string;
  userId?: string;
  examName?: string;
}

/**
 * 学生查看成绩。
 * - 普通学生账号：只看自己的成绩；
 * - 班级账号（班级设备）：返回**本班全部学生的成绩总览**（个人学生不再是登录主体，
 *   班级设备上一屏展示全班成绩，便于张贴/核对）。
 */
export async function listMyGrades(user: TokenPayload): Promise<GradeDto[]> {
  const personalIds = await resolvePersonalIds(user);

  const grades = await prisma.grade.findMany({
    where: { userId: { in: personalIds } },
    include,
    orderBy: [{ publishedAt: 'desc' }, { examName: 'asc' }],
    take: 500,
  });
  return grades.map(toGradeDto);
}

/** 教师查看班级成绩 */
export async function listGrades(user: TokenPayload, options: ListGradeOptions): Promise<GradeDto[]> {
  const scope = await resolveClassScope(user, options.classId);
  const grades = await prisma.grade.findMany({
    where: {
      ...classScopeWhere(scope),
      ...(options.courseId ? { courseId: options.courseId } : {}),
      ...(options.userId ? { userId: options.userId } : {}),
      ...(options.examName ? { examName: options.examName } : {}),
    },
    include,
    orderBy: [{ publishedAt: 'desc' }, { examName: 'asc' }],
    take: 500,
  });
  return grades.map(toGradeDto);
}

/** 成绩统计（等级分布 + 各课程平均得分率），供 Web 端图表使用 */
export async function getGradeStats(user: TokenPayload, options: ListGradeOptions): Promise<GradeStats> {
  const grades = await listGrades(user, options);
  const levels: GradeLevel[] = ['A', 'B', 'C', 'D', 'E'];
  const distribution = levels.map((level) => ({ level, count: 0 }));

  const byCourseMap = new Map<string, { courseId: string | null; courseName: string; percents: number[] }>();

  for (const grade of grades) {
    const percent = gradePercent(grade.score, grade.totalScore);
    const bucket = distribution.find((item) => item.level === gradeLevel(percent));
    if (bucket) bucket.count += 1;

    const key = grade.courseId ?? '__none__';
    const entry = byCourseMap.get(key) ?? {
      courseId: grade.courseId,
      courseName: grade.course?.name ?? '未关联课程',
      percents: [],
    };
    entry.percents.push(percent);
    byCourseMap.set(key, entry);
  }

  const allPercents = grades.map((grade) => gradePercent(grade.score, grade.totalScore));

  return {
    total: grades.length,
    averagePercent:
      allPercents.length === 0
        ? 0
        : Math.round((allPercents.reduce((sum, value) => sum + value, 0) / allPercents.length) * 10) / 10,
    byCourse: [...byCourseMap.values()].map((entry) => ({
      courseId: entry.courseId,
      courseName: entry.courseName,
      count: entry.percents.length,
      averagePercent:
        Math.round((entry.percents.reduce((sum, value) => sum + value, 0) / entry.percents.length) * 10) / 10,
    })),
    distribution,
  };
}

export async function createGrade(user: TokenPayload, input: CreateGradeInput): Promise<GradeDto> {
  await assertCanManageGrades(user, input.classId);
  await assertStudentInClass(input.userId, input.classId);
  if (input.courseId) await assertCourseInClass(input.courseId, input.classId);

  const dto = await upsertGrade({
    classId: input.classId,
    courseId: input.courseId ?? null,
    userId: input.userId,
    examName: input.examName,
    score: input.score,
    totalScore: input.totalScore ?? 100,
    publishedAt: parseOptionalDate(input.publishedAt) ?? new Date(),
  });

  emitToClass(dto.classId, SOCKET_EVENTS.gradeUpdated, dto);
  emitToUser(dto.userId, SOCKET_EVENTS.gradeUpdated, dto);
  return dto;
}

/** 批量录入：同一个考试一次提交整班成绩 */
export async function bulkCreateGrades(user: TokenPayload, input: BulkCreateGradeInput): Promise<GradeDto[]> {
  await assertCanManageGrades(user, input.classId);
  if (input.courseId) await assertCourseInClass(input.courseId, input.classId);

  const publishedAt = parseOptionalDate(input.publishedAt) ?? new Date();
  const results: GradeDto[] = [];

  for (const item of input.items) {
    await assertStudentInClass(item.userId, input.classId);
    const dto = await upsertGrade({
      classId: input.classId,
      courseId: input.courseId ?? null,
      userId: item.userId,
      examName: input.examName,
      score: item.score,
      totalScore: input.totalScore ?? 100,
      publishedAt,
    });
    results.push(dto);
  }

  // 一次广播覆盖整班（房间内包含全部学生）
  emitToClass(input.classId, SOCKET_EVENTS.gradeUpdated, {
    ...results[0],
    bulk: true,
    count: results.length,
  });
  return results;
}

export async function updateGrade(
  user: TokenPayload,
  gradeId: string,
  input: UpdateGradeInput,
): Promise<GradeDto> {
  const current = await prisma.grade.findUnique({ where: { id: gradeId } });
  if (!current) throw ApiError.notFound('成绩记录不存在');
  await assertCanManageGrades(user, current.classId);
  if (input.courseId) await assertCourseInClass(input.courseId, current.classId);

  const updated = await prisma.grade.update({
    where: { id: gradeId },
    data: {
      ...(input.examName ? { examName: input.examName } : {}),
      ...(input.score !== undefined ? { score: input.score } : {}),
      ...(input.totalScore !== undefined ? { totalScore: input.totalScore } : {}),
      ...(input.courseId !== undefined ? { courseId: input.courseId ?? null } : {}),
      ...(input.publishedAt !== undefined
        ? { publishedAt: parseOptionalDate(input.publishedAt) ?? new Date() }
        : {}),
    },
    include,
  });

  const dto = toGradeDto(updated);
  emitToClass(dto.classId, SOCKET_EVENTS.gradeUpdated, dto);
  emitToUser(dto.userId, SOCKET_EVENTS.gradeUpdated, dto);
  return dto;
}

export async function deleteGrade(user: TokenPayload, gradeId: string): Promise<void> {
  const current = await prisma.grade.findUnique({ where: { id: gradeId } });
  if (!current) throw ApiError.notFound('成绩记录不存在');
  await assertCanManageGrades(user, current.classId);
  await prisma.grade.delete({ where: { id: gradeId } });
  emitToClass(current.classId, SOCKET_EVENTS.gradeUpdated, {
    ...toGradeDto({ ...current, course: null, student: null, class: null }),
    deleted: true,
  });
}

/**
 * 同一学生 + 同一课程 + 同一考试名称视为同一条记录，
 * 重复录入时覆盖旧分数，避免教师"改分"产生重复行。
 */
async function upsertGrade(data: {
  classId: string;
  courseId: string | null;
  userId: string;
  examName: string;
  score: number;
  totalScore: number;
  publishedAt: Date;
}): Promise<GradeDto> {
  const existing = await prisma.grade.findFirst({
    where: {
      classId: data.classId,
      courseId: data.courseId,
      userId: data.userId,
      examName: data.examName,
    },
    select: { id: true },
  });

  if (existing) {
    const updated = await prisma.grade.update({
      where: { id: existing.id },
      data: { score: data.score, totalScore: data.totalScore, publishedAt: data.publishedAt },
      include,
    });
    return toGradeDto(updated);
  }

  const created = await prisma.grade.create({ data, include });
  return toGradeDto(created);
}

async function assertStudentInClass(userId: string, classId: string): Promise<void> {
  const student = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, classId: true },
  });
  if (!student || student.role !== 'STUDENT') throw ApiError.badRequest('学生不存在');
  if (student.classId !== classId) throw ApiError.badRequest('该学生不属于所选班级');
}

async function assertCourseInClass(courseId: string, classId: string): Promise<void> {
  const course = await prisma.course.findUnique({ where: { id: courseId }, select: { classId: true } });
  if (!course) throw ApiError.badRequest('课程不存在');
  if (course.classId !== classId) throw ApiError.badRequest('该课程不属于所选班级');
}
