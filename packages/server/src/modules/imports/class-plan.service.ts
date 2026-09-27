import { prisma } from '../../lib/db.js';
import { ApiError } from '../../lib/http.js';
import type { TokenPayload } from '../../lib/jwt.js';
import { logger } from '../../lib/logger.js';
import { assertCanManageSchedule } from '../../lib/access.js';
import { weekParityFromDiv } from '@classhelper/shared';
import type { ClassPlanImportInput } from './imports.schemas.js';

/**
 * ClassIsland「课程表（ClassPlan）」导入 —— 支持单双周。
 *
 * 真实档案 JSON（`Profiles/<档案名>.json`）的结构（PascalCase，均为 "Guid → 对象" 字典）：
 *
 * ```jsonc
 * {
 *   "TimeLayouts": { "<guid>": { "Name": "周一作息", "Layouts": [ { "StartTime": "08:00:00", "EndTime": "08:45:00", "TimeType": 0 } ] } },
 *   "ClassPlans":  { "<guid>": { "TimeLayoutId": "<guid>", "TimeRule": { "WeekDay": 1, "WeekCountDiv": 1, "WeekCountDivTotal": 2 }, "Classes": [ { "SubjectId": "<guid>" } ] } },
 *   "Subjects":    { "<guid>": { "Name": "语文", "TeacherName": "王老师" } }
 * }
 * ```
 *
 * 关键语义（与 ClassIsland 源码一致）：
 * - `TimeRule.WeekDay`：0=周日、1=周一 … 6=周六；
 * - `TimeRule.WeekCountDiv`：0=每周；1=单周；2=双周（`WeekCountDivTotal=2` 时）；
 *   一般规则：`WeekCountDivTotal = n` 时，第 `WeekCountDiv` 周启用（1-based）；
 * - `Classes[i]` 对应 `Layouts` 里**第 i 个 `TimeType === 0`（上课）的点**，课间/分割线不占位；
 * - 判周相位（"第 1 周是单周还是双周"）不在 JSON 里，由我们自己的学期起始周决定。
 */

/** 解析出来的单条课程（= 一个 Schedule 行） */
export interface ParsedClassPlanEntry {
  /** 1=周一 … 7=周日（已从 ClassIsland 的 0=周日 转换） */
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  /** 科目名（Subjects 字典里的 Name） */
  subject: string;
  /** 教师名（可选，仅预览展示） */
  teacherName: string;
  /** 单双周 */
  weekParity: 'ALL' | 'ODD' | 'EVEN';
  /** 原始 WeekCountDiv / WeekCountDivTotal，便于预览里解释来源 */
  weekCountDiv: number;
  weekCountDivTotal: number;
  /** 来源课表名（ClassPlan.Name），方便老师核对 */
  planName: string;
}

export interface ClassPlanParseResult {
  entries: ParsedClassPlanEntry[];
  /** 解析到的科目名（去重） */
  subjects: string[];
  /** 需要新建的科目（班级里还没有对应课程） */
  missingSubjects: string[];
  /** 时间表名（多个时间表时列出） */
  layoutNames: string[];
  errors: string[];
  warnings: string[];
}

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** "08:00:00" / "8:0" / 数字秒 → HH:mm */
function normalizeTime(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const seconds = value > 100 ? value : value * 60;
    const hour = Math.floor(seconds / 3600) % 24;
    const minute = Math.floor((seconds % 3600) / 60);
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  const match = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/.exec(text);
  if (match) {
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) return null;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    return `${String(parsed.getHours()).padStart(2, '0')}:${String(parsed.getMinutes()).padStart(2, '0')}`;
  }
  return null;
}

/**
 * `WeekCountDiv` / `WeekCountDivTotal` → 我们课表的 weekParity。
 * 口径集中在 `@classhelper/shared` 的 `weekParityFromDiv`（插件上报走同一份实现），
 * 这里只是本模块内的别名，保证"手动导入 JSON"与"插件实时上报"落到库里完全一致。
 */
const resolveParity = weekParityFromDiv;

/** 解析 ClassIsland 档案 JSON（或只含 ClassPlans 的片段）里的课程表 */
export function parseClassIslandClassPlan(input: unknown): ClassPlanParseResult {
  const result: ClassPlanParseResult = {
    entries: [],
    subjects: [],
    missingSubjects: [],
    layoutNames: [],
    errors: [],
    warnings: [],
  };

  let payload: unknown = input;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch (error) {
      result.errors.push(`JSON 解析失败：${(error as Error).message}`);
      return result;
    }
  }
  const root = asRecord(payload);
  if (!root) {
    result.errors.push(
      '无法识别的 JSON 结构：期望 ClassIsland 档案对象（含 TimeLayouts / ClassPlans / Subjects）',
    );
    return result;
  }

  // 科目字典：Guid → { Name, TeacherName }
  const subjectDict = asRecord(root.Subjects) ?? {};
  const subjectName = (id: string): string => {
    const record = asRecord(subjectDict[id]);
    return String(record?.Name ?? '').trim();
  };

  // 时间表字典：Guid → { Name, Layouts: [...] }
  const layoutDict = asRecord(root.TimeLayouts) ?? {};
  const layouts = new Map<string, { name: string; items: { start: string; end: string }[] }>();
  for (const [id, value] of Object.entries(layoutDict)) {
    const record = asRecord(value);
    if (!record) continue;
    const name = String(record.Name ?? '时间表').trim() || '时间表';
    // 只取"上课"时间点（TimeType 0 / 缺省），与 ClassIsland 的 Classes[i] 对齐规则一致
    const items = asArray(record.Layouts)
      .map((item) => asRecord(item))
      .filter((item): item is Record<string, unknown> => item !== null)
      .filter((item) => {
        const raw = item.TimeType ?? item.timeType ?? 0;
        const numeric = typeof raw === 'number' ? raw : Number(raw);
        return !Number.isFinite(numeric) || numeric === 0;
      })
      .map((item) => ({
        start: normalizeTime(item.StartTime ?? item.StartSecond ?? item.startTime) ?? '',
        end: normalizeTime(item.EndTime ?? item.EndSecond ?? item.endTime) ?? '',
      }));
    layouts.set(id, { name, items });
    result.layoutNames.push(name);
  }

  // 兼容"只给了 ClassPlans 片段"的情况：此时从 Classes 里直接读时间（可选字段 StartTime/EndTime）
  const planDict = asRecord(root.ClassPlans) ?? asRecord(root.classPlans) ?? root;
  const plans = Object.entries(planDict).filter(([, value]) => {
    const record = asRecord(value);
    return Boolean(record && (record.TimeRule || record.timeRule || record.Classes || record.classes));
  });
  if (plans.length === 0) {
    result.errors.push(
      '没找到课表（ClassPlans）：请确认选择的是 ClassIsland 档案 JSON，或包含 ClassPlans 的片段',
    );
    return result;
  }

  for (const [planId, value] of plans) {
    const plan = asRecord(value);
    if (!plan) continue;
    const planName = String(plan.Name ?? plan.name ?? planId).trim() || '课表';
    if (plan.IsEnabled === false || plan.isEnabled === false) continue;
    if (plan.IsOverlay === true || plan.isOverlay === true) continue;

    const rule = asRecord(plan.TimeRule ?? plan.timeRule) ?? {};
    const rawWeekDay = Number(rule.WeekDay ?? rule.weekDay ?? 0);
    // ClassIsland：0=周日 … 6=周六 → 我们：1=周一 … 7=周日
    const dayOfWeek = Number.isFinite(rawWeekDay)
      ? rawWeekDay === 0
        ? 7
        : Math.min(7, Math.max(1, rawWeekDay))
      : 1;
    const weekCountDiv = Number(rule.WeekCountDiv ?? rule.weekCountDiv ?? 0) || 0;
    const weekCountDivTotal = Number(rule.WeekCountDivTotal ?? rule.weekCountDivTotal ?? 2) || 2;
    if (weekCountDivTotal > 2 && weekCountDiv > 0) {
      result.warnings.push(
        `${planName}：${weekCountDivTotal} 周轮换无法用"单双周"表达，已按每周处理（第 ${weekCountDiv} 周）`,
      );
    }
    const weekParity = resolveParity(weekCountDiv, weekCountDivTotal);

    const layoutId = String(plan.TimeLayoutId ?? plan.timeLayoutId ?? '');
    const layout = layouts.get(layoutId) ?? (layouts.size > 0 ? [...layouts.values()][0] : undefined);
    const timeItems = layout?.items ?? [];
    if (timeItems.length === 0) {
      result.warnings.push(`${planName}：没有可用的时间表节次，已跳过（请先导入该班的时间配置）`);
      continue;
    }

    const classes = asArray(plan.Classes ?? plan.classes);
    classes.forEach((item, index) => {
      const info = asRecord(item);
      if (!info) return;
      if (info.IsEnabled === false || info.isEnabled === false) return;
      const slot = timeItems[index];
      if (!slot) return;
      const subjectId = String(info.SubjectId ?? info.subjectId ?? '');
      const subject = subjectName(subjectId);
      if (!subject) {
        result.warnings.push(`${planName} 第 ${index + 1} 节：科目未在 Subjects 里找到，已跳过`);
        return;
      }
      if (!slot.start || !slot.end || slot.start >= slot.end) {
        result.warnings.push(`${planName} 第 ${index + 1} 节：时间非法（${slot.start}-${slot.end}），已跳过`);
        return;
      }
      const teacherRecord = asRecord(subjectDict[subjectId]);
      result.entries.push({
        dayOfWeek,
        startTime: slot.start,
        endTime: slot.end,
        subject,
        teacherName: String(teacherRecord?.TeacherName ?? ''),
        weekParity,
        weekCountDiv,
        weekCountDivTotal,
        planName,
      });
    });
  }

  if (result.entries.length === 0 && result.errors.length === 0) {
    result.errors.push(
      '没有解析出任何课程：请检查 TimeLayouts 与 ClassPlans 是否完整（Classes 与上课时间点一一对应）',
    );
  }

  result.subjects = [...new Set(result.entries.map((item) => item.subject))];
  return result;
}

/** 预览：解析 + 与现有课程比对（列出需要新建的科目） */
export async function previewClassPlan(
  user: TokenPayload,
  input: ClassPlanImportInput,
): Promise<ClassPlanParseResult & { entries: (ParsedClassPlanEntry & { weekdayLabel: string })[] }> {
  await assertCanManageSchedule(user, input.classId);
  const parsed = parseClassIslandClassPlan(input.payload);
  const courses = await prisma.course.findMany({
    where: { classId: input.classId },
    select: { name: true },
  });
  const existing = new Set(courses.map((item) => item.name));
  parsed.missingSubjects = parsed.subjects.filter((name) => !existing.has(name));
  return {
    ...parsed,
    entries: parsed.entries.map((item) => ({
      ...item,
      weekdayLabel: WEEKDAY_LABELS[item.dayOfWeek % 7] ?? `周${item.dayOfWeek}`,
    })),
  };
}

/**
 * 导入：把解析出的课程写成课表（Schedule），必要时自动补建缺失的课程。
 * - replace：先清空该班课表再写入（失败回滚：整个过程在一个事务里）；
 * - merge：按 `星期 + 开始时间 + 单双周` 去重，存在则更新时间/课程，否则新增。
 */
export async function importClassPlan(
  user: TokenPayload,
  input: ClassPlanImportInput,
): Promise<{
  imported: number;
  created: number;
  updated: number;
  createdCourses: string[];
  weekStart: number;
  weekEnd: number;
}> {
  await assertCanManageSchedule(user, input.classId);
  const parsed = parseClassIslandClassPlan(input.payload);
  if (parsed.entries.length === 0) {
    throw new ApiError(400, 'IMPORT_INVALID', parsed.errors[0] ?? '没有可导入的课程');
  }

  const classRecord = await prisma.class.findUnique({
    where: { id: input.classId },
    select: { id: true, teacherId: true },
  });
  if (!classRecord) throw ApiError.notFound('班级不存在');

  // 时间配置（导入的时间表）里如果只有部分节次，weekEnd 用默认 20 周
  const weekStart = input.termStartWeek ?? 1;
  const weekEnd = 20;

  const result = await prisma.$transaction(async (tx) => {
    // 1) 补建缺失课程（用班主任作为课程任课老师）
    const existingCourses = await tx.course.findMany({
      where: { classId: input.classId },
      select: { id: true, name: true },
    });
    const courseIdByName = new Map(existingCourses.map((item) => [item.name, item.id]));
    const createdCourses: string[] = [];
    for (const name of parsed.subjects) {
      if (courseIdByName.has(name)) continue;
      const created = await tx.course.create({
        data: { classId: input.classId, name, teacherId: classRecord.teacherId },
        select: { id: true, name: true },
      });
      courseIdByName.set(created.name, created.id);
      createdCourses.push(created.name);
    }

    // 2) replace 模式：先清空该班课表
    if (input.mode === 'replace') {
      await tx.schedule.deleteMany({ where: { classId: input.classId } });
    }

    // 3) 写入课程（merge 时按 星期+开始时间+单双周 去重）
    let created = 0;
    let updated = 0;
    for (const entry of parsed.entries) {
      const courseId = courseIdByName.get(entry.subject);
      if (!courseId) continue;
      const existing = await tx.schedule.findFirst({
        where: {
          classId: input.classId,
          dayOfWeek: entry.dayOfWeek,
          startTime: entry.startTime,
          weekParity: entry.weekParity,
        },
        select: { id: true },
      });
      if (existing) {
        await tx.schedule.update({
          where: { id: existing.id },
          data: { courseId, endTime: entry.endTime, weekStart, weekEnd },
        });
        updated += 1;
      } else {
        await tx.schedule.create({
          data: {
            classId: input.classId,
            courseId,
            dayOfWeek: entry.dayOfWeek,
            startTime: entry.startTime,
            endTime: entry.endTime,
            location: null,
            weekStart,
            weekEnd,
            weekParity: entry.weekParity,
          },
        });
        created += 1;
      }
    }
    return { created, updated, createdCourses };
  });

  const total = result.created + result.updated;
  logger.info(
    `ClassIsland 课程表导入：班级=${input.classId} 模式=${input.mode} 新增=${result.created} 更新=${result.updated} ` +
      `补建科目=[${result.createdCourses.join(',')}]`,
  );
  return {
    imported: total,
    created: result.created,
    updated: result.updated,
    createdCourses: result.createdCourses,
    weekStart,
    weekEnd,
  };
}
