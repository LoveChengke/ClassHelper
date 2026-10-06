import {
  SOCKET_EVENTS,
  canQueryStudentGrades,
  gradeLevel,
  gradePercent,
  normalizeStudentNo,
  type GradeDto,
  type GradeLevelType,
  type GradeStats,
  type StudentGradeDetailDto,
} from '@classhelper/shared';
import {
  assertCanManageSubjectContent,
  assertClassAccess,
  classScopeWhere,
  isClassDevice,
  resolveClassScope,
  resolveUserClassRole,
} from '../../lib/access.js';
import { prisma } from '../../lib/db.js';
import { ApiError } from '../../lib/http.js';
import type { TokenPayload } from '../../lib/jwt.js';
import { toGradeDto, toStudentBrief } from '../../lib/mappers.js';
import { parseOptionalDate } from '../../lib/schemas.js';
import { resolvePersonalIds } from '../../lib/session.js';
import { emitToClass } from '../../realtime/bus.js';
import type {
  BulkCreateGradeInput,
  CreateGradeInput,
  UpdateGradeInput,
  UpdateGradeLevelsInput,
} from './grades.schemas.js';

const courseSelect = { select: { id: true, name: true } } as const;
const studentSelect = { select: { id: true, studentNo: true, name: true } } as const;
const classSelect = { select: { name: true } } as const;
const include = { course: courseSelect, student: studentSelect, class: classSelect } as const;

export interface ListGradeOptions {
  classId?: string;
  courseId?: string;
  studentId?: string;
  examName?: string;
}

/**
 * ClassHelper 班级端查看本班成绩。
 *
 * 班级端是个人数据的唯一读写主体（学生不是账号），因此这里返回**本班全部学生的成绩**，
 * 便于在教室大屏上一屏展示全班成绩供核对。
 * 教师/管理员调用时返回空数组（他们没有"自己的成绩"），请用 `listGrades`。
 */
export async function listMyGrades(user: TokenPayload): Promise<GradeDto[]> {
  const studentIds = await resolvePersonalIds(user);
  if (studentIds.length === 0) return [];

  const grades = await prisma.grade.findMany({
    where: { studentId: { in: studentIds } },
    include,
    orderBy: [{ publishedAt: 'desc' }, { examName: 'asc' }],
    take: 1000,
  });
  return grades.map(toGradeDto);
}

/** 教师 / 管理员查看成绩（按可访问班级过滤） */
export async function listGrades(user: TokenPayload, options: ListGradeOptions): Promise<GradeDto[]> {
  const scope = await resolveClassScope(user, options.classId);
  const grades = await prisma.grade.findMany({
    where: {
      ...classScopeWhere(scope),
      ...(options.courseId ? { courseId: options.courseId } : {}),
      ...(options.studentId ? { studentId: options.studentId } : {}),
      ...(options.examName ? { examName: options.examName } : {}),
    },
    include,
    orderBy: [{ publishedAt: 'desc' }, { examName: 'asc' }],
    take: 1000,
  });
  return grades.map(toGradeDto);
}

/** 成绩统计（等级分布 + 各课程平均得分率），供 Web 端图表使用 */
export async function getGradeStats(user: TokenPayload, options: ListGradeOptions): Promise<GradeStats> {
  const grades = await listGrades(user, options);

  const distributionMap = new Map<string, number>();
  const byCourseMap = new Map<string, { courseId: string | null; courseName: string; percents: number[] }>();

  for (const grade of grades) {
    const percent = gradePercent(grade.score, grade.totalScore);
    // 自定义等级也要能统计，所以按 level 文本分桶（不再是固定的 A~E）
    const level = grade.level || gradeLevel(percent);
    distributionMap.set(level, (distributionMap.get(level) ?? 0) + 1);

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
    distribution: [...distributionMap.entries()]
      .map(([level, count]) => ({ level, count }))
      .sort((a, b) => b.count - a.count),
  };
}

/* ---------------------------------------------------------------- 录入 / 修改 / 删除 */

/**
 * 录入一条成绩。
 *
 * 权限走 `assertCanManageSubjectContent`：**科任老师只能录自己任教科目**的成绩，
 * 班主任若不教这一科同样被拒；不指定科目（courseId 为空）时只有班主任/管理员可录。
 */
export async function createGrade(user: TokenPayload, input: CreateGradeInput): Promise<GradeDto> {
  await assertCanManageSubjectContent(user, input.classId, input.courseId ?? null, '录入成绩');
  await assertStudentInClass(input.studentId, input.classId);
  if (input.courseId) await assertCourseInClass(input.courseId, input.classId);

  const levelType: GradeLevelType = input.levelType ?? 'percent';
  const totalScore = input.totalScore ?? 100;

  const dto = await upsertGrade({
    classId: input.classId,
    courseId: input.courseId ?? null,
    studentId: input.studentId,
    examName: input.examName,
    score: input.score,
    totalScore,
    levelType,
    level: resolveLevel(levelType, input.level, input.score, totalScore),
    publishedAt: parseOptionalDate(input.publishedAt) ?? new Date(),
  });

  emitToClass(dto.classId, SOCKET_EVENTS.gradeUpdated, dto);
  return dto;
}

/** 批量录入：同一个考试一次提交整班成绩 */
export async function bulkCreateGrades(user: TokenPayload, input: BulkCreateGradeInput): Promise<GradeDto[]> {
  await assertCanManageSubjectContent(user, input.classId, input.courseId ?? null, '录入成绩');
  if (input.courseId) await assertCourseInClass(input.courseId, input.classId);

  const publishedAt = parseOptionalDate(input.publishedAt) ?? new Date();
  const levelType: GradeLevelType = input.levelType ?? 'percent';
  const totalScore = input.totalScore ?? 100;
  const results: GradeDto[] = [];

  for (const item of input.items) {
    await assertStudentInClass(item.studentId, input.classId);
    const dto = await upsertGrade({
      classId: input.classId,
      courseId: input.courseId ?? null,
      studentId: item.studentId,
      examName: input.examName,
      score: item.score,
      totalScore,
      levelType,
      level: resolveLevel(levelType, item.level, item.score, totalScore),
      publishedAt,
    });
    results.push(dto);
  }

  if (results[0]) {
    emitToClass(input.classId, SOCKET_EVENTS.gradeUpdated, {
      ...results[0],
      bulk: true,
      count: results.length,
    });
  }
  return results;
}

export async function updateGrade(
  user: TokenPayload,
  gradeId: string,
  input: UpdateGradeInput,
): Promise<GradeDto> {
  const current = await prisma.grade.findUnique({ where: { id: gradeId } });
  if (!current) throw ApiError.notFound('成绩记录不存在');

  // 改的是哪条成绩，就按那条成绩所属的班级 + 科目判权限
  const nextCourseId = input.courseId === undefined ? current.courseId : (input.courseId ?? null);
  await assertCanManageSubjectContent(user, current.classId, nextCourseId, '修改成绩');
  if (nextCourseId) await assertCourseInClass(nextCourseId, current.classId);

  const totalScore = input.totalScore ?? current.totalScore;
  const score = input.score ?? current.score;
  const levelType = (input.levelType ?? current.levelType) as GradeLevelType;
  // 改了分数就重算 percent 口径下的等级；显式传了 level 则以它为准
  const level =
    input.level !== undefined
      ? input.level
      : levelType === 'percent'
        ? resolveLevel(levelType, '', score, totalScore)
        : current.level;

  const updated = await prisma.grade.update({
    where: { id: gradeId },
    data: {
      ...(input.examName ? { examName: input.examName } : {}),
      ...(input.score !== undefined ? { score: input.score } : {}),
      ...(input.totalScore !== undefined ? { totalScore: input.totalScore } : {}),
      ...(input.courseId !== undefined ? { courseId: nextCourseId } : {}),
      levelType,
      level,
      ...(input.publishedAt !== undefined
        ? { publishedAt: parseOptionalDate(input.publishedAt) ?? new Date() }
        : {}),
    },
    include,
  });

  const dto = toGradeDto(updated);
  emitToClass(dto.classId, SOCKET_EVENTS.gradeUpdated, dto);
  return dto;
}

export async function deleteGrade(user: TokenPayload, gradeId: string): Promise<void> {
  const current = await prisma.grade.findUnique({ where: { id: gradeId } });
  if (!current) throw ApiError.notFound('成绩记录不存在');
  await assertCanManageSubjectContent(user, current.classId, current.courseId, '删除成绩');

  await prisma.grade.delete({ where: { id: gradeId } });
  emitToClass(current.classId, SOCKET_EVENTS.gradeUpdated, {
    ...toGradeDto({ ...current, course: null, student: null, class: null }),
    deleted: true,
  });
}

/* ---------------------------------------------------------------- 等级：单个 / 批量 */

/**
 * 批量修改等级。
 *
 * 两种用法：
 * 1. `items`：逐条指定等级（前端表格里改完一次提交；单个编辑就是长度 1 的数组）；
 * 2. `classId + examName + levelType`：把某个考试的某门课整批**重算**等级
 *    （percent 按得分率换算，其余口径沿用原等级或留空）。
 *
 * 逐条改时按**每条成绩自己的班级 + 科目**判权限，科任老师改不了别人的科目。
 */
export async function updateGradeLevels(
  user: TokenPayload,
  input: UpdateGradeLevelsInput,
): Promise<{ updated: number }> {
  if (input.items && input.items.length > 0) {
    const records = await prisma.grade.findMany({
      where: { id: { in: input.items.map((item) => item.id) } },
      select: { id: true, classId: true, courseId: true },
    });
    if (records.length !== input.items.length) {
      throw ApiError.badRequest('部分成绩记录不存在，请刷新后重试');
    }
    const byId = new Map(records.map((item) => [item.id, item]));

    // 逐条判权限：可能跨多个班级/科目（管理员在成绩页多选修改时会这样）
    for (const item of input.items) {
      const record = byId.get(item.id)!;
      await assertCanManageSubjectContent(user, record.classId, record.courseId, '修改成绩等级');
    }

    await prisma.$transaction(
      input.items.map((item) =>
        prisma.grade.update({ where: { id: item.id }, data: { level: item.level } }),
      ),
    );

    const sample = byId.get(input.items[0]!.id);
    if (sample) emitToClass(sample.classId, SOCKET_EVENTS.gradeUpdated, { bulk: true, count: input.items.length });
    return { updated: input.items.length };
  }

  // 整批重算
  const classId = input.classId!;
  await assertCanManageSubjectContent(user, classId, input.courseId ?? null, '调整成绩等级');
  const levelType = input.levelType!;
  const records = await prisma.grade.findMany({
    where: {
      classId,
      examName: input.examName!,
      ...(input.courseId !== undefined ? { courseId: input.courseId ?? null } : {}),
    },
    select: { id: true, score: true, totalScore: true, level: true },
  });

  await prisma.$transaction(
    records.map((item) =>
      prisma.grade.update({
        where: { id: item.id },
        data: {
          levelType,
          level:
            levelType === 'percent'
              ? gradeLevel(gradePercent(item.score, item.totalScore))
              : item.level,
        },
      }),
    ),
  );

  emitToClass(classId, SOCKET_EVENTS.gradeUpdated, { bulk: true, count: records.length });
  return { updated: records.length };
}

/* ---------------------------------------------------------------- 按学号查明细 */

/**
 * 按**学号**查询某个学生的成绩明细（ClassHelper 班级端 / 教师端共用）。
 *
 * 权限：
 * - 管理员：全库任意学号；
 * - 班主任 / 科任老师：自己可访问的班级；
 * - ClassHelper 班级端：仅本班，**且**该班打开了 `studentGradeQueryEnabled`
 *   —— 这就是「是否允许学生通过班级端查看本人明细，由教师或管理员开关控制」。
 */
export async function getStudentGradeDetail(
  user: TokenPayload,
  studentNo: string,
  requestedClassId?: string,
): Promise<StudentGradeDetailDto> {
  const scope = await resolveClassScope(user, requestedClassId);

  const student = await prisma.student.findFirst({
    where: { studentNo: normalizeStudentNo(studentNo), ...classScopeWhere(scope) },
    include: { class: { select: { id: true, name: true, studentGradeQueryEnabled: true } } },
  });
  if (!student) throw ApiError.notFound('没找到这个学号的学生，请核对学号是否输入正确');

  if (student.class) {
    const classRole = await resolveUserClassRole(user, student.class.id);
    const allowed = canQueryStudentGrades({
      classRole,
      // 老库补列时的默认值是 true（开箱可用），所以 null/undefined 都按开启处理
      gradeQueryEnabled: student.class.studentGradeQueryEnabled ?? true,
    });
    if (!allowed) {
      throw ApiError.forbidden('本班未开放学生自助查询成绩，请联系老师开启');
    }
  } else if (isClassDevice(user)) {
    throw ApiError.forbidden('该学生尚未分班，无法查询');
  }

  const grades = await prisma.grade.findMany({
    where: { studentId: student.id },
    include,
    orderBy: [{ publishedAt: 'desc' }, { examName: 'asc' }],
    take: 500,
  });

  const percents = grades.map((item) => gradePercent(item.score, item.totalScore));
  return {
    student: toStudentBrief(student),
    classId: student.classId,
    className: student.class?.name ?? null,
    items: grades.map(toGradeDto),
    averagePercent:
      percents.length === 0
        ? 0
        : Math.round((percents.reduce((sum, value) => sum + value, 0) / percents.length) * 10) / 10,
  };
}

/** 教师端：查看某个学生的成绩明细（按学生 id，内部复用按学号的实现） */
export async function getStudentGradeDetailById(
  user: TokenPayload,
  studentId: string,
): Promise<StudentGradeDetailDto> {
  const student = await prisma.student.findUnique({
    where: { id: studentId },
    select: { studentNo: true, classId: true },
  });
  if (!student) throw ApiError.notFound('学生不存在');
  await assertClassAccess(user, student.classId ?? '');
  return getStudentGradeDetail(user, student.studentNo);
}

/* ---------------------------------------------------------------- 内部工具 */

/**
 * 等级文本：
 * - 显式给了就用它（教师手改的等级优先）；
 * - 否则 percent 口径按得分率换算；
 * - letter / custom 留空时给空串，由前端提示"请选择等级"。
 */
function resolveLevel(
  levelType: GradeLevelType,
  level: string | undefined,
  score: number,
  totalScore: number,
): string {
  const provided = (level ?? '').trim();
  if (provided) return provided;
  return levelType === 'percent' ? gradeLevel(gradePercent(score, totalScore)) : '';
}

/**
 * 同一学生 + 同一课程 + 同一考试名称视为同一条记录，
 * 重复录入时覆盖旧分数，避免教师"改分"产生重复行。
 */
async function upsertGrade(data: {
  classId: string;
  courseId: string | null;
  studentId: string;
  examName: string;
  score: number;
  totalScore: number;
  levelType: GradeLevelType;
  level: string;
  publishedAt: Date;
}): Promise<GradeDto> {
  const existing = await prisma.grade.findFirst({
    where: {
      classId: data.classId,
      courseId: data.courseId,
      studentId: data.studentId,
      examName: data.examName,
    },
    select: { id: true },
  });

  if (existing) {
    const updated = await prisma.grade.update({
      where: { id: existing.id },
      data: {
        score: data.score,
        totalScore: data.totalScore,
        levelType: data.levelType,
        level: data.level,
        publishedAt: data.publishedAt,
      },
      include,
    });
    return toGradeDto(updated);
  }

  const created = await prisma.grade.create({ data, include });
  return toGradeDto(created);
}

async function assertStudentInClass(studentId: string, classId: string): Promise<void> {
  const student = await prisma.student.findUnique({
    where: { id: studentId },
    select: { classId: true },
  });
  if (!student) throw ApiError.badRequest('学生不存在');
  if (student.classId !== classId) throw ApiError.badRequest('该学生不属于所选班级');
}

async function assertCourseInClass(courseId: string, classId: string): Promise<void> {
  const course = await prisma.course.findUnique({ where: { id: courseId }, select: { classId: true } });
  if (!course) throw ApiError.badRequest('课程不存在');
  if (course.classId !== classId) throw ApiError.badRequest('该课程不属于所选班级');
}
