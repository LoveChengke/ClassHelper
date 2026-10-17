import type { CollectiveGradeAnalysisDto as ContractCollectiveGradeAnalysisDto } from '@classhelper/shared';
import {
  SOCKET_EVENTS,
  canQueryStudentGrades,
  gradeLevel,
  gradePercent,
  normalizeStudentNo,
  type ExamDto,
  type ExamRankingDto,
  type ExamSubjectRanking,
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
  isStaff,
  resolveClassScope,
  resolveUserClassRole,
} from '../../lib/access.js';
import { activeStudentWhere, isActiveStudent } from '../../lib/students.js';
import { prisma } from '../../lib/db.js';
import { ApiError } from '../../lib/http.js';
import type { TokenPayload } from '../../lib/jwt.js';
import { logger } from '../../lib/logger.js';
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

/** 个人查询关闭时，实时通道同样只发送刷新通知，不能绕过 HTTP 明细闸门。 */
async function emitGradeUpdated(classId: string, payload: unknown) {
  const cls = await prisma.class.findUnique({
    where: { id: classId },
    select: { studentGradeQueryEnabled: true },
  });
  emitToClass(
    classId,
    SOCKET_EVENTS.gradeUpdated,
    cls?.studentGradeQueryEnabled ? payload : { classId, collective: true },
  );
}

const courseSelect = { select: { id: true, name: true } } as const;
const studentSelect = { select: { id: true, studentNo: true, name: true } } as const;
const classSelect = { select: { name: true } } as const;
const include = { course: courseSelect, student: studentSelect, class: classSelect } as const;

async function assertDetailQuery(user: TokenPayload, classId: string): Promise<void> {
  await assertClassAccess(user, classId);
  const cls = await prisma.class.findUniqueOrThrow({ where: { id: classId } });
  if (
    !canQueryStudentGrades({
      classRole: await resolveUserClassRole(user, classId),
      gradeQueryEnabled: cls.studentGradeQueryEnabled,
    })
  ) {
    throw ApiError.forbidden('本班只开放集体分析，未开放个人成绩');
  }
}

/** 服务端聚合；不返回极值、个人标识或可由补集反推的稀疏分段。 */
export async function collectiveAnalysis(
  user: TokenPayload,
  classId: string,
): Promise<ContractCollectiveGradeAnalysisDto> {
  await assertClassAccess(user, classId);
  const rows = await prisma.grade.findMany({
    where: { classId, student: activeStudentWhere() },
    select: {
      studentId: true,
      course: { select: { name: true } },
      examName: true,
      score: true,
      totalScore: true,
    },
  });
  const enough = (items: typeof rows) => new Set(items.map((r) => r.studentId)).size >= 5;
  const mean = (items: typeof rows) =>
    enough(items)
      ? Math.round(items.reduce((s, r) => s + gradePercent(r.score, r.totalScore), 0) / items.length)
      : null;
  const suppressed = !enough(rows);
  const subjects = [...new Set(rows.map((r) => r.course?.name || '综合'))].map((name) => ({
    name,
    averagePercent: mean(rows.filter((r) => (r.course?.name || '综合') === name)),
  }));
  const trend = [...new Set(rows.map((r) => r.examName))].map((examName) => ({
    examName,
    averagePercent: mean(rows.filter((r) => r.examName === examName)),
  }));
  const bins = [0, 60, 80, 90].map((min, index, all) => ({
    label: `${min}–${all[index + 1] ?? 100}`,
    count: rows.filter((r) => {
      const p = gradePercent(r.score, r.totalScore);
      return p >= min && (index === all.length - 1 || p < all[index + 1]!);
    }).length,
  }));
  const sparse = suppressed || bins.some((b) => b.count > 0 && b.count < 3);
  const rate = (min: number) => {
    const n = rows.filter((r) => gradePercent(r.score, r.totalScore) >= min).length;
    return suppressed || n < 3 || rows.length - n < 3 ? null : Math.round((n / rows.length) * 100);
  };
  return {
    mode: 'collective',
    classId,
    suppressed,
    averagePercent: mean(rows),
    passRate: rate(60),
    excellentRate: rate(90),
    subjects: suppressed ? [] : subjects,
    trend: suppressed ? [] : trend,
    distribution: bins.map((b) => ({ ...b, count: sparse ? null : b.count })),
  };
}

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
  if (isClassDevice(user)) await assertDetailQuery(user, user.classId ?? user.sub);
  const studentIds = await resolvePersonalIds(user);
  if (studentIds.length === 0) return [];

  const grades = await prisma.grade.findMany({
    where: { studentId: { in: studentIds }, student: activeStudentWhere() },
    include,
    orderBy: [{ publishedAt: 'desc' }, { examName: 'asc' }],
    take: 1000,
  });
  return grades.map(toGradeDto);
}

/** 教师 / 管理员查看成绩（按可访问班级过滤） */
export async function listGrades(user: TokenPayload, options: ListGradeOptions): Promise<GradeDto[]> {
  const scope = await resolveClassScope(user, options.classId);
  if (isClassDevice(user)) await assertDetailQuery(user, user.classId ?? user.sub);
  const grades = await prisma.grade.findMany({
    where: {
      ...classScopeWhere(scope),
      student: activeStudentWhere(),
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

  await emitGradeUpdated(dto.classId, dto);
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
    await emitGradeUpdated(input.classId, {
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
  const current = await prisma.grade.findFirst({ where: { id: gradeId, student: activeStudentWhere() } });
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
  await emitGradeUpdated(dto.classId, dto);
  return dto;
}

export async function deleteGrade(user: TokenPayload, gradeId: string): Promise<void> {
  const current = await prisma.grade.findFirst({ where: { id: gradeId, student: activeStudentWhere() } });
  if (!current) throw ApiError.notFound('成绩记录不存在');
  await assertCanManageSubjectContent(user, current.classId, current.courseId, '删除成绩');

  await prisma.grade.delete({ where: { id: gradeId } });
  await emitGradeUpdated(current.classId, {
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
      where: { id: { in: input.items.map((item) => item.id) }, student: activeStudentWhere() },
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
      input.items.map((item) => prisma.grade.update({ where: { id: item.id }, data: { level: item.level } })),
    );

    const counts = new Map<string, number>();
    for (const item of input.items) {
      const classId = byId.get(item.id)!.classId;
      counts.set(classId, (counts.get(classId) ?? 0) + 1);
    }
    for (const [classId, count] of counts) await emitGradeUpdated(classId, { bulk: true, count });
    return { updated: input.items.length };
  }

  // 整批重算
  const classId = input.classId!;
  await assertCanManageSubjectContent(user, classId, input.courseId ?? null, '调整成绩等级');
  const levelType = input.levelType!;
  if (levelType === 'custom') throw ApiError.badRequest('自定义等级不能由分数推算，请逐条填写等级');
  const records = await prisma.grade.findMany({
    where: {
      classId,
      examName: input.examName!,
      student: activeStudentWhere(),
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
          level: gradeLevel(gradePercent(item.score, item.totalScore)),
        },
      }),
    ),
  );

  await emitGradeUpdated(classId, { bulk: true, count: records.length });
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
  if (isClassDevice(user)) await assertDetailQuery(user, user.classId ?? user.sub);
  const scope = await resolveClassScope(user, requestedClassId);

  const student = await prisma.student.findFirst({
    where: { ...activeStudentWhere(), studentNo: normalizeStudentNo(studentNo), ...classScopeWhere(scope) },
    include: { class: { select: { id: true, name: true, studentGradeQueryEnabled: true } } },
  });
  if (!student) throw ApiError.notFound('没找到这个学号的学生，请核对学号是否输入正确');

  if (student.class) {
    const classRole = await resolveUserClassRole(user, student.class.id);
    const allowed =
      isStaff(user) ||
      canQueryStudentGrades({
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
    select: { studentNo: true, classId: true, status: true },
  });
  if (!student || ('status' in student && !isActiveStudent(student as { status: string })))
    throw ApiError.notFound('学生不存在');
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
    select: { classId: true, status: true },
  });
  if (!student || !isActiveStudent(student)) throw ApiError.badRequest('学生不存在');
  if (student.classId !== classId) throw ApiError.badRequest('该学生不属于所选班级');
}

async function assertCourseInClass(courseId: string, classId: string): Promise<void> {
  const course = await prisma.course.findUnique({ where: { id: courseId }, select: { classId: true } });
  if (!course) throw ApiError.badRequest('课程不存在');
  if (course.classId !== classId) throw ApiError.badRequest('该课程不属于所选班级');
}

/* ---------------------------------------------------------------- 考试与排名 */

/**
 * 列出某班出现过的考试名（`Grade.examName` 的去重），并带上"是否计入总分"。
 *
 * 以**成绩行**为准而不是以 `Exam` 表为准：老师可能先导了成绩才开始管口径，
 * 只列 `Exam` 会让刚导进去的那次考试在界面上根本找不到。
 */
export async function listExams(user: TokenPayload, classId: string): Promise<ExamDto[]> {
  await assertClassAccess(user, classId);
  const [groups, exams] = await Promise.all([
    prisma.grade.groupBy({
      by: ['examName'],
      where: { classId, student: activeStudentWhere() },
      _count: { _all: true },
    }),
    prisma.exam.findMany({
      where: { classId },
      select: { id: true, name: true, countInTotal: true },
    }),
  ]);
  const byName = new Map(exams.map((item) => [item.name, item]));
  return groups
    .map((group) => {
      const row = byName.get(group.examName);
      return {
        id: row?.id ?? '',
        classId,
        name: group.examName,
        countInTotal: row?.countInTotal ?? false,
        gradeCount: group._count._all,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

/**
 * 设置「这次考试要不要把所有科目相加做总分排名」。仅教师 / 管理员。
 *
 * 为什么要单独一个开关：语数外的 150 分和音体美的 100 分不是一个量纲，
 * "这次考试要不要合总分"是学校的口径，程序不能替它默认决定 ——
 * 而客户端要显示总分榜就必须知道，所以按「班级 + 考试名」存一条（`Exam` 表）。
 */
export async function setExamCountInTotal(
  user: TokenPayload,
  classId: string,
  name: string,
  countInTotal: boolean,
): Promise<ExamDto> {
  await assertClassAccess(user, classId);
  if (!isStaff(user)) throw ApiError.forbidden('只有教师/管理员可以设置考试口径');

  const row = await prisma.exam.upsert({
    where: { classId_name: { classId, name } },
    create: { classId, name, countInTotal },
    update: { countInTotal },
  });
  const gradeCount = await prisma.grade.count({ where: { classId, examName: name } });
  logger.info(`考试口径：班级=${classId} 考试=${name} 计入总分=${countInTotal} 由 ${user.name} 设置`);
  return { id: row.id, classId, name, countInTotal, gradeCount };
}

/** 并列名次：分数相同的取同一名次，下一个名次跳过（1、2、2、4） */
function assignRanks<T extends { score: number }>(
  rows: T[],
  rankOf: (row: T) => number,
): Array<T & { rank: number }> {
  const sorted = [...rows].sort((a, b) => rankOf(b) - rankOf(a));
  let lastScore: number | null = null;
  let lastRank = 0;
  return sorted.map((row, index) => {
    const score = rankOf(row);
    const rank = lastScore !== null && score === lastScore ? lastRank : index + 1;
    lastScore = score;
    lastRank = rank;
    return { ...row, rank };
  });
}

/**
 * 一次考试的排名（单科 + 总分）。
 *
 * 单科榜按 `courseId` 分组；成绩行里 `courseId` 可能为 null（没挂科目的成绩），
 * 那种归到「未关联课程」一栏，不并进任何科目。
 *
 * 总分榜只在 `Exam.countInTotal` 为 true 时才算 —— 见 `setExamCountInTotal` 的说明。
 * 合计时**按科目去重**：同一个学生同一个科目在一次考试里有多行（老师补录过）时只取最高分，
 * 否则"补录一条"会变成"总分多一科"，排名直接失真。
 *
 * 班级端受 `Class.studentGradeQueryEnabled` 控制（与按学号查明细同一条边界）。
 */
export async function getExamRanking(
  user: TokenPayload,
  classId: string,
  examName: string,
): Promise<ExamRankingDto> {
  await assertClassAccess(user, classId);
  const classRecord = await prisma.class.findUnique({
    where: { id: classId },
    select: { name: true, studentGradeQueryEnabled: true },
  });
  if (!classRecord) throw ApiError.notFound('班级不存在');

  const classRole = await resolveUserClassRole(user, classId);
  const allowed =
    isStaff(user) ||
    canQueryStudentGrades({
      classRole,
      // 老库补列时的默认值是 true（开箱可用），所以 null/undefined 都按开启处理
      gradeQueryEnabled: classRecord.studentGradeQueryEnabled ?? true,
    });
  if (!allowed) throw ApiError.forbidden('本班未开放成绩查询，请联系老师开启');

  const [grades, exam] = await Promise.all([
    prisma.grade.findMany({
      where: { classId, examName, student: activeStudentWhere() },
      include,
      orderBy: [{ publishedAt: 'desc' }],
    }),
    prisma.exam.findUnique({
      where: { classId_name: { classId, name: examName } },
      select: { countInTotal: true },
    }),
  ]);

  // 同一个学生同一科目只留最高分（补录 / 重考的场景）
  const best = new Map<string, GradeDto>();
  for (const grade of grades.map(toGradeDto)) {
    const key = `${grade.studentId}|${grade.courseId ?? ''}`;
    const current = best.get(key);
    if (!current || grade.score > current.score) best.set(key, grade);
  }
  const unique = [...best.values()];

  const byCourse = new Map<string, { courseId: string | null; courseName: string; rows: GradeDto[] }>();
  for (const grade of unique) {
    const key = grade.courseId ?? '__none__';
    const entry = byCourse.get(key) ?? {
      courseId: grade.courseId,
      courseName: grade.course?.name ?? '未关联课程',
      rows: [],
    };
    entry.rows.push(grade);
    byCourse.set(key, entry);
  }

  const subjects: ExamSubjectRanking[] = [...byCourse.values()]
    .map((entry) => ({
      courseId: entry.courseId,
      courseName: entry.courseName,
      rows: assignRanks(entry.rows, (row) => gradePercent(row.score, row.totalScore)).map((row) => ({
        studentId: row.studentId,
        studentNo: row.student?.studentNo ?? '',
        studentName: row.student?.name ?? '',
        score: row.score,
        totalScore: row.totalScore,
        rank: row.rank,
      })),
    }))
    .sort((a, b) => a.courseName.localeCompare(b.courseName, 'zh-Hans-CN'));

  const countInTotal = exam?.countInTotal === true;
  let total: ExamRankingDto['total'] = [];
  if (countInTotal) {
    const sum = new Map<
      string,
      { studentId: string; studentNo: string; studentName: string; score: number; subjectCount: number }
    >();
    for (const grade of unique) {
      const entry = sum.get(grade.studentId) ?? {
        studentId: grade.studentId,
        studentNo: grade.student?.studentNo ?? '',
        studentName: grade.student?.name ?? '',
        score: 0,
        subjectCount: 0,
      };
      entry.score += grade.score;
      entry.subjectCount += 1;
      sum.set(grade.studentId, entry);
    }
    total = assignRanks([...sum.values()], (row) => row.score);
  }

  return {
    classId,
    className: classRecord.name,
    examName,
    countInTotal,
    subjects,
    total,
  };
}
