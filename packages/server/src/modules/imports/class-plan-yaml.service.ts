import { parse as parseYaml } from 'yaml';
import type {
  ClassPlanYamlEntryDto,
  ClassPlanYamlImportResultDto,
  ClassPlanYamlPreviewDto,
  WeekParity,
} from '@classhelper/shared';
import { prisma } from '../../lib/db.js';
import { ApiError } from '../../lib/http.js';
import { assertCanImportSchedule } from '../../lib/access.js';
import { getMaxTermWeeks } from '../../lib/term.js';
import type { TokenPayload } from '../../lib/jwt.js';
import { importProfile } from '../class-plans/profile-import.service.js';
import type { ClassPlanYamlImportInput } from './imports.schemas.js';

/**
 * 课表 YAML 导入（面向手写 / 大模型生成的课表文件）。
 *
 * YAML 只表达「星期 + 单双周 + 起止时间 + 科目」，比 ClassIsland 档案 JSON 简单得多。
 * 这里把它**归一化成 ClassIsland 兼容的 `{ TimeLayouts, ClassPlans, Subjects }` 载荷**，
 * 再交给 `importProfile()` 写入：
 * - merge / replace、稳定 id、事务回滚、权限与 `notifyScheduleChanged` 全部复用现有一份实现；
 * - 全部 schedules 里出现过的不同 (start_time, end_time) 合并成一张时间表，
 *   LESSON 时间点按时间排序，同一天没列出的时间点写成空课（IsEmpty）；
 * - 单双周映射：all → WeekCountDiv=0，odd → 1/2，even → 2/2；
 * - enable_day 1=周一 … 7=周日，ClassIsland 的 WeekDay 同样 1=周一 … 7=周日，直接对应。
 *
 * 校验失败不写库：预览把问题放进 `errors` 展示，导入阶段直接返回 400 中文原因。
 */

const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const LAYOUT_NAME = 'YAML 导入时间表';
const MAX_SCHEDULES = 500;
const MAX_CLASSES_PER_DAY = 200;
const MAX_LAYOUT_LESSONS = 100;

function assertYamlSize(text: string): void {
  if (Buffer.byteLength(text, 'utf8') > 8 * 1024 * 1024)
    throw new ApiError(413, 'IMPORT_TOO_LARGE', '课表 YAML 不能超过 8 MB');
}

/** 解析出的单节课；subject 为空串表示显式空课。 */
interface YamlLesson {
  subject: string;
  startTime: string;
  endTime: string;
  /** 来自科目 room 的上课地点 */
  location: string;
}

interface YamlSchedule {
  /** 在原文件 schedules 数组里的 0-based 下标，用于报错定位 */
  index: number;
  name: string;
  weekday: number;
  parity: WeekParity;
  lessons: YamlLesson[];
}

interface YamlSubject {
  name: string;
  /** 课程简称（来自 simplified_name），未声明时为 null */
  initial: string | null;
  room: string;
  teacher: string;
}

interface YamlLayoutPoint {
  startTime: string;
  endTime: string;
}

/** 解析（校验 + 归一化）结果，不涉及数据库。 */
export interface YamlClassPlanParseResult {
  /** 通过校验、去重后的课表（每组 星期+单双周 一条） */
  schedules: YamlSchedule[];
  /** 只包含课表里实际用到的科目（已声明在前、自动补建在后） */
  subjects: YamlSubject[];
  layout: YamlLayoutPoint[];
  /** 预览行（按星期、时间排序；空课不出现） */
  entries: ClassPlanYamlEntryDto[];
  subjectNames: string[];
  planCount: number;
  errors: string[];
  warnings: string[];
}

/** 有上限的问题收集器：异常输入最多展示 20 条错误 / 50 条提示，避免超大文件刷爆响应。 */
class ParseIssues {
  readonly errors: string[] = [];
  readonly warnings: string[] = [];
  private errorCount = 0;
  private warningCount = 0;

  error(message: string): void {
    this.errorCount += 1;
    if (this.errors.length < 20) this.errors.push(message);
  }

  warn(message: string): void {
    this.warningCount += 1;
    if (this.warnings.length < 50) this.warnings.push(message);
  }

  finish(): void {
    if (this.errorCount > this.errors.length)
      this.errors.push(`……另有 ${this.errorCount - this.errors.length} 个问题未展开，请先修正以上内容`);
    if (this.warningCount > this.warnings.length)
      this.warnings.push(`……另有 ${this.warningCount - this.warnings.length} 条提示未展开`);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 字符串标量：缺省/null 视为空串；数字/布尔转字符串（YAML 里可能被误写成数字）；对象/数组返回 null。 */
function scalarText(value: unknown): string | null {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/** 数字字段：接受整数或纯数字字符串（大模型偶尔会把数字写成带引号）。 */
function integerValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

/** 报错里展示原始值，长文本截断，避免把整棵 YAML 树写进消息。 */
function displayValue(value: unknown): string {
  if (value === undefined) return '缺失';
  if (value === null) return 'null';
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return '空字符串';
    return `「${text.length > 40 ? `${text.slice(0, 40)}…` : text}」`;
  }
  if (typeof value === 'object') return Array.isArray(value) ? '数组' : '对象';
  return `「${String(value)}」`;
}

/** YAML 语法错误 → 中文提示（保留行号，方便用户定位）。 */
function describeYamlError(error: unknown): string {
  if (!(error instanceof Error)) return 'YAML 语法错误：无法解析文件内容';
  const position = (error as Error & { linePos?: Array<{ line: number; col: number }> }).linePos?.[0];
  const where = position ? `第 ${position.line} 行第 ${position.col} 列：` : '';
  const code = (error as Error & { code?: string }).code;
  if (code === 'DUPLICATE_KEY') return `YAML 字段重复（${where}同一个键被定义了两次），请删除重复字段后重试`;
  const reason = error.message.split('\n')[0]?.trim() || error.name;
  return `YAML 语法错误（${where}${reason}）`;
}

type TimeParse = { ok: true; time: string } | { ok: false; message: string };

/** `HHMMSS` / `HH:mm` / `HH:mm:ss`（秒必须为 00）→ 规范化 `HH:mm`。 */
function readTime(value: unknown): TimeParse {
  // YAML 未加引号的 080000 会解析为数字 80000，按六位补齐后再校验。
  const raw =
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 235959
      ? String(value).padStart(6, '0')
      : value;
  if (typeof raw !== 'string') return { ok: false, message: '应为 HHMMSS、HH:mm 或 HH:mm:ss' };
  const trimmed = raw.trim();
  const text = /^\d{6}$/.test(trimmed)
    ? `${trimmed.slice(0, 2)}:${trimmed.slice(2, 4)}:${trimmed.slice(4)}`
    : trimmed;
  const match = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/.exec(text);
  if (!match) return { ok: false, message: '应为 HHMMSS、HH:mm 或 HH:mm:ss（例如 080000）' };
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = match[3] === undefined ? 0 : Number(match[3]);
  if (hour > 23 || minute > 59 || second > 59)
    return { ok: false, message: '不是合法时间（小时 0–23，分钟/秒 0–59）' };
  if (second !== 0) return { ok: false, message: '秒必须为 00（课表只支持到分钟）' };
  const pad = (part: number) => String(part).padStart(2, '0');
  return { ok: true, time: `${pad(hour)}:${pad(minute)}` };
}

/** weeks 字段 → 单双周；兼容中文「每周 / 单周 / 双周」。 */
function readWeeks(value: unknown): WeekParity | null {
  if (value === undefined || value === null) return 'ALL';
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!text || text === 'all' || text === '每周' || text === '全周' || text === '每周课表') return 'ALL';
  if (text === 'odd' || text === '单周') return 'ODD';
  if (text === 'even' || text === '双周') return 'EVEN';
  return null;
}

/** 单双周 → ClassIsland 的 WeekCountDiv（总数固定 2）。 */
function parityDiv(parity: WeekParity): number {
  return parity === 'ALL' ? 0 : parity === 'ODD' ? 1 : 2;
}

/** 单条课表里出现过的字段白名单，额外字段给提示而不是静默忽略。 */
const SCHEDULE_FIELDS = new Set(['name', 'enable_day', 'weeks', 'classes']);
const ROOT_FIELDS = new Set(['version', 'subjects', 'schedules']);

/** 兼容用户示例的省略冒号写法；仅 version 1 开头时转换，标准 YAML 原样解析。 */
function normalizeExampleSyntax(text: string): { text: string; converted: boolean } {
  const first = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .find((line) => line.trim() && !line.trimStart().startsWith('#'));
  if (!first || !/^version[\t ]+1(?:[\t ]*(?:#.*)?)$/.test(first.trim())) return { text, converted: false };
  const fields =
    /^(\s*(?:-\s+)?)(version|subjects|schedules|name|simplified_name|teacher|room|enable_day|weeks|classes|subject|start_time|end_time)(?:[\t ]+(.*))?$/;
  return {
    converted: true,
    text: text
      .split(/\r?\n/)
      .map((line) => line.replace(fields, '$1$2: $3'))
      .join('\n'),
  };
}

/** 解析并校验 YAML 文本；不抛异常，所有问题都放进 errors/warnings。 */
export function parseClassPlanYaml(text: string): YamlClassPlanParseResult {
  const issues = new ParseIssues();
  const result: YamlClassPlanParseResult = {
    schedules: [],
    subjects: [],
    layout: [],
    entries: [],
    subjectNames: [],
    planCount: 0,
    errors: issues.errors,
    warnings: issues.warnings,
  };

  if (!text.trim()) {
    issues.error('课表 YAML 内容为空：请粘贴或选择非空的 .yaml / .yml 文件');
    issues.finish();
    return result;
  }

  let document: unknown;
  try {
    const normalized = normalizeExampleSyntax(text);
    document = parseYaml(normalized.text, { maxAliasCount: 100 });
    if (normalized.converted) issues.warn('已兼容示例中省略冒号的写法；下载示例使用标准 YAML 格式');
  } catch (error) {
    issues.error(describeYamlError(error));
    issues.finish();
    return result;
  }

  const root = asRecord(document);
  if (!root) {
    issues.error('YAML 根节点必须是对象：需要包含 version / subjects / schedules');
    issues.finish();
    return result;
  }
  for (const key of Object.keys(root)) {
    if (!ROOT_FIELDS.has(key))
      issues.warn(`未识别的顶层字段「${key}」已忽略（仅支持 version / subjects / schedules）`);
  }

  if ('version' in root) {
    const version = integerValue(root.version);
    if (version !== 1)
      issues.error(`仅支持 version: 1（当前为 ${displayValue(root.version)}），请检查文件格式`);
  }

  // ---------- subjects（可缺省：从 schedules 里收集） ----------
  const declared = new Map<string, YamlSubject>();
  const subjectsProvided = root.subjects !== undefined && root.subjects !== null;
  if (subjectsProvided) {
    if (!Array.isArray(root.subjects)) {
      issues.error('subjects 必须是数组（每项包含 name / simplified_name / teacher / room）');
    } else {
      root.subjects.forEach((item, index) => {
        const label = `subjects 第 ${index + 1} 项`;
        const record = asRecord(item);
        if (!record) {
          issues.error(`${label}必须是对象（例如 - name: 语文）`);
          return;
        }
        const nameText = scalarText(record.name);
        const name = (nameText ?? '').trim();
        if (!nameText || !name) {
          issues.error(`${label}缺少 name（科目全称）`);
          return;
        }
        if (name.length > 64) {
          issues.warn(`科目「${name.slice(0, 20)}…」超过 64 个字符，导入时会截断`);
        }
        const key = name.slice(0, 64);
        if (declared.has(key)) {
          issues.warn(`subjects 中「${key}」重复声明，已保留第一条`);
          return;
        }
        const simplifiedText = scalarText(record.simplified_name);
        const teacherText = scalarText(record.teacher);
        const roomText = scalarText(record.room);
        if (simplifiedText === null || teacherText === null || roomText === null) {
          issues.error(`${label}的 simplified_name / teacher / room 必须是字符串`);
          return;
        }
        const simplified = simplifiedText.trim();
        declared.set(key, {
          name: key,
          initial: simplified ? Array.from(simplified).slice(0, 8).join('') : null,
          room: roomText.trim().slice(0, 64),
          teacher: teacherText.trim(),
        });
      });
    }
  }

  // ---------- schedules ----------
  const rawSchedules = root.schedules;
  if (rawSchedules === undefined || rawSchedules === null) {
    issues.error('YAML 中没有 schedules（课表）：请至少填写一条课表');
    issues.finish();
    return result;
  }
  if (!Array.isArray(rawSchedules)) {
    issues.error('schedules 必须是数组：每项包含 name / enable_day / weeks / classes');
    issues.finish();
    return result;
  }
  if (rawSchedules.length === 0) {
    issues.error('schedules 为空：请至少填写一条包含 classes 的课表');
    issues.finish();
    return result;
  }
  if (rawSchedules.length > MAX_SCHEDULES) {
    issues.error(`课表数量过多（${rawSchedules.length} 条），最多支持 ${MAX_SCHEDULES} 条`);
  }

  const parsedSchedules: YamlSchedule[] = [];
  rawSchedules.slice(0, MAX_SCHEDULES).forEach((item, index) => {
    const position = index + 1;
    const record = asRecord(item);
    if (!record) {
      issues.error(`第 ${position} 条课表必须是对象`);
      return;
    }
    const nameText = scalarText(record.name);
    if (nameText === null) {
      issues.error(`第 ${position} 条课表的 name 必须是字符串`);
      return;
    }
    const fallbackName = `第 ${position} 条课表`;
    const name = nameText.trim() || fallbackName;
    const label = `第 ${position} 条课表（${name}）`;
    for (const key of Object.keys(record)) {
      if (!SCHEDULE_FIELDS.has(key))
        issues.warn(`${label}的未识别字段「${key}」已忽略（仅支持 name / enable_day / weeks / classes）`);
    }

    const rawDay = record.enable_day;
    if (rawDay === undefined || rawDay === null) {
      issues.error(`${label}缺少 enable_day（1=周一 … 7=周日）`);
      return;
    }
    const weekday = integerValue(rawDay);
    if (weekday === null || !Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
      issues.error(
        `${label}的 enable_day 非法（${displayValue(rawDay)}）：应为 1–7 的整数（1=周一 … 7=周日）`,
      );
      return;
    }

    const parity = readWeeks(record.weeks);
    if (parity === null) {
      issues.error(
        `${label}的 weeks 非法（${displayValue(record.weeks)}）：仅支持 all（每周）/ odd（单周）/ even（双周）`,
      );
      return;
    }

    const rawClasses = record.classes;
    if (rawClasses === undefined || rawClasses === null) {
      issues.error(`${label}缺少 classes（课程列表），空课请写 subject: ''`);
      return;
    }
    if (!Array.isArray(rawClasses)) {
      issues.error(`${label}的 classes 必须是数组`);
      return;
    }
    if (rawClasses.length === 0) {
      issues.warn(`${label}没有任何课程（classes 为空），已跳过`);
      return;
    }
    if (rawClasses.length > MAX_CLASSES_PER_DAY) {
      issues.error(`${label}的课程过多（${rawClasses.length} 节），单日最多 ${MAX_CLASSES_PER_DAY} 节`);
      return;
    }

    const lessons: YamlLesson[] = [];
    const timeKeys = new Set<string>();
    rawClasses.forEach((classItem, classIndex) => {
      const classLabel = `${label}第 ${classIndex + 1} 节`;
      const classRecord = asRecord(classItem);
      if (!classRecord) {
        issues.error(`${classLabel}必须是对象（包含 subject / start_time / end_time）`);
        return;
      }
      if (!('subject' in classRecord)) {
        issues.error(`${classLabel}缺少 subject（空课请写 subject: ''）`);
        return;
      }
      const subjectText = scalarText(classRecord.subject);
      if (subjectText === null) {
        issues.error(`${classLabel}的 subject 必须是字符串（空课请写 ''）`);
        return;
      }
      const subject = subjectText.trim().slice(0, 64);

      const rawStart = classRecord.start_time;
      if (rawStart === undefined || rawStart === null) {
        issues.error(`${classLabel}缺少 start_time（例如 08:00:00）`);
        return;
      }
      const start = readTime(rawStart);
      if (!start.ok) {
        issues.error(`${classLabel}的 start_time 非法（${displayValue(rawStart)}）：${start.message}`);
        return;
      }
      const rawEnd = classRecord.end_time;
      if (rawEnd === undefined || rawEnd === null) {
        issues.error(`${classLabel}缺少 end_time（例如 08:45:00）`);
        return;
      }
      const end = readTime(rawEnd);
      if (!end.ok) {
        issues.error(`${classLabel}的 end_time 非法（${displayValue(rawEnd)}）：${end.message}`);
        return;
      }
      if (start.time >= end.time) {
        issues.error(`${classLabel}结束时间必须晚于开始时间（${start.time}–${end.time}）`);
        return;
      }
      const timeKey = `${start.time}-${end.time}`;
      if (timeKeys.has(timeKey)) {
        issues.error(`${classLabel}与同一课表里的其他节时间重复（${timeKey}），请改为不同时间`);
        return;
      }
      timeKeys.add(timeKey);
      lessons.push({ subject, startTime: start.time, endTime: end.time, location: '' });
    });

    if (lessons.length === 0) {
      // 有 classes 但全部解析失败/全为空课时，不重复刷屏；错误已在上面给出。
      return;
    }
    if (lessons.every((lesson) => !lesson.subject)) {
      issues.warn(`${label}没有任何有科目的课程，已跳过`);
      return;
    }
    parsedSchedules.push({ index, name: name.slice(0, 64), weekday, parity, lessons });
  });

  if (parsedSchedules.length === 0) {
    if (issues.errors.length === 0)
      issues.error('没有解析出任何课程：请检查 schedules 里的 classes 是否包含 subject 与合法时间');
    issues.finish();
    return result;
  }

  // ---------- 同日同相位去重 / 相位冲突 ----------
  const kept: YamlSchedule[] = [];
  const seen = new Map<string, YamlSchedule>();
  for (const schedule of parsedSchedules) {
    const key = `${schedule.weekday}|${schedule.parity}`;
    const previous = seen.get(key);
    if (previous) {
      issues.error(
        `enable_day=${schedule.weekday}、weeks=${schedule.parity.toLowerCase()} 存在多条有课程的课表` +
          `（${previous.name}、${schedule.name}），请合并为一条后再导入`,
      );
      continue;
    }
    seen.set(key, schedule);
    kept.push(schedule);
  }
  const phasesByDay = new Map<number, Set<WeekParity>>();
  for (const schedule of kept) {
    const set = phasesByDay.get(schedule.weekday) ?? new Set<WeekParity>();
    set.add(schedule.parity);
    phasesByDay.set(schedule.weekday, set);
  }
  for (const [weekday, phases] of phasesByDay) {
    if (phases.has('ALL') && phases.size > 1) {
      issues.error(
        `${WEEKDAY_LABELS[weekday - 1]}同时存在每周（all）与单/双周课表，` +
          '启用周次会互相覆盖；请只保留一种相位，或把内容合并进同一张课表',
      );
    }
  }
  if (kept.length > MAX_SCHEDULES) {
    issues.error(`有效课表数量过多（${kept.length} 张），最多支持 ${MAX_SCHEDULES} 张`);
  }

  // ---------- 科目收集（声明优先，未声明按课表顺序补建） ----------
  const usedNames: string[] = [];
  for (const schedule of kept) {
    for (const lesson of schedule.lessons) {
      if (lesson.subject && !usedNames.includes(lesson.subject)) usedNames.push(lesson.subject);
    }
  }
  const subjects: YamlSubject[] = [];
  // 保留 subjects 里的声明顺序，再追加课表里出现但未声明的科目。
  for (const subject of declared.values()) {
    if (usedNames.includes(subject.name)) subjects.push(subject);
  }
  for (const schedule of kept) {
    for (const lesson of schedule.lessons) {
      if (!lesson.subject) continue;
      if (subjects.some((item) => item.name === lesson.subject)) continue;
      if (subjectsProvided) issues.warn(`科目「${lesson.subject}」未在 subjects 中声明，将按科目名自动补建`);
      subjects.push({ name: lesson.subject, initial: null, room: '', teacher: '' });
    }
  }
  const subjectByName = new Map(subjects.map((subject) => [subject.name, subject]));
  const hasTeacher = subjects.some((subject) => subject.teacher);
  if (hasTeacher) {
    issues.warn('subjects 里的 teacher 仅作备注，不参与课程任课授权；自动补建的课程会挂在本班班主任名下');
  }

  // 教室写进课次地点（YAML 的 room 是科目级默认值）。
  for (const schedule of kept) {
    for (const lesson of schedule.lessons) {
      if (!lesson.subject) continue;
      lesson.location = subjectByName.get(lesson.subject)?.room ?? '';
    }
  }

  // ---------- 时间表：所有 (start,end) 去重并按时间排序 ----------
  const layoutKeys = new Map<string, YamlLayoutPoint>();
  for (const schedule of kept) {
    for (const lesson of schedule.lessons) {
      const key = `${lesson.startTime}-${lesson.endTime}`;
      if (!layoutKeys.has(key)) layoutKeys.set(key, { startTime: lesson.startTime, endTime: lesson.endTime });
    }
  }
  const layout = [...layoutKeys.values()].sort(
    (a, b) => a.startTime.localeCompare(b.startTime) || a.endTime.localeCompare(b.endTime),
  );
  if (layout.length > MAX_LAYOUT_LESSONS) {
    issues.error(
      `需要 ${layout.length} 个不同的上课时间点，超过单份时间表 ${MAX_LAYOUT_LESSONS} 个的上限；请核对时间`,
    );
  }

  // ---------- 预览行 ----------
  const parityOrder: Record<WeekParity, number> = { ALL: 0, ODD: 1, EVEN: 2 };
  const sorted = [...kept].sort(
    (a, b) => a.weekday - b.weekday || parityOrder[a.parity] - parityOrder[b.parity],
  );
  const entries: ClassPlanYamlEntryDto[] = [];
  for (const schedule of sorted) {
    const lessons = [...schedule.lessons].sort((a, b) => a.startTime.localeCompare(b.startTime));
    for (const lesson of lessons) {
      if (!lesson.subject) continue;
      const subject = subjectByName.get(lesson.subject);
      entries.push({
        dayOfWeek: schedule.weekday,
        weekdayLabel: WEEKDAY_LABELS[schedule.weekday - 1],
        startTime: lesson.startTime,
        endTime: lesson.endTime,
        subject: lesson.subject,
        teacherName: subject?.teacher ?? '',
        weekParity: schedule.parity,
        weekCountDiv: parityDiv(schedule.parity),
        weekCountDivTotal: 2,
        planName: schedule.name,
        location: lesson.location,
      });
    }
  }

  // 同名课表（不同星期/相位）给出提示，方便核对是否把内容复制重了。
  const nameCount = new Map<string, number>();
  for (const schedule of kept) nameCount.set(schedule.name, (nameCount.get(schedule.name) ?? 0) + 1);
  for (const [name, count] of nameCount) {
    if (count > 1) issues.warn(`课表名称「${name}」出现 ${count} 次，将分别导入，请确认不是重复内容`);
  }

  result.schedules = sorted;
  result.subjects = subjects;
  result.layout = layout;
  result.entries = entries;
  result.subjectNames = subjects.map((subject) => subject.name);
  result.planCount = sorted.length;
  issues.finish();
  return result;
}

/** 把 YAML 解析结果归一化成 `importProfile()` 认识的 ClassIsland 档案载荷。 */
export function buildClassIslandProfile(
  parsed: YamlClassPlanParseResult,
  weekEnd: number,
): Record<string, unknown> {
  const subjects: Record<string, unknown> = {};
  for (const subject of parsed.subjects) {
    subjects[`yaml-subject-${subject.name}`] = {
      Name: subject.name,
      ...(subject.initial ? { Initial: subject.initial } : {}),
    };
  }
  const layouts: Record<string, unknown> = {
    'yaml-layout': {
      Name: LAYOUT_NAME,
      Layouts: parsed.layout.map((point) => ({
        StartTime: point.startTime,
        EndTime: point.endTime,
        TimeType: 0,
        Name: '',
      })),
    },
  };
  const plans: Record<string, unknown> = {};
  for (const schedule of parsed.schedules) {
    const lessonByTime = new Map(
      schedule.lessons
        .filter((lesson) => lesson.subject)
        .map((lesson) => [`${lesson.startTime}-${lesson.endTime}`, lesson]),
    );
    const classes = parsed.layout.map((point) => {
      const lesson = lessonByTime.get(`${point.startTime}-${point.endTime}`);
      if (!lesson) return { IsEmpty: true, IsEnabled: true };
      return {
        SubjectId: `yaml-subject-${lesson.subject}`,
        IsEnabled: true,
        Location: lesson.location || '',
      };
    });
    plans[`yaml-plan-${schedule.weekday}-${schedule.parity.toLowerCase()}`] = {
      Name: schedule.name,
      TimeLayoutId: 'yaml-layout',
      TimeRule: {
        WeekDay: schedule.weekday,
        WeekCountDiv: parityDiv(schedule.parity),
        WeekCountDivTotal: 2,
      },
      WeekStart: 1,
      WeekEnd: weekEnd,
      IsEnabled: true,
      Classes: classes,
    };
  }
  return { TimeLayouts: layouts, ClassPlans: plans, Subjects: subjects };
}

/** 预览：只解析校验 + 比对缺失科目，不写库。 */
export async function previewYamlClassPlan(
  user: TokenPayload,
  input: ClassPlanYamlImportInput,
): Promise<ClassPlanYamlPreviewDto> {
  await assertCanImportSchedule(user, input.classId);
  assertYamlSize(input.text);
  const parsed = parseClassPlanYaml(input.text);
  const courses = await prisma.course.findMany({
    where: { classId: input.classId },
    select: { name: true },
  });
  const existing = new Set(courses.map((item) => item.name));
  return {
    format: 'yaml',
    entries: parsed.entries,
    subjects: parsed.subjectNames,
    missingSubjects: parsed.subjectNames.filter((name) => !existing.has(name)),
    layoutNames: parsed.layout.length > 0 ? [LAYOUT_NAME] : [],
    planCount: parsed.planCount,
    errors: parsed.errors,
    warnings: parsed.warnings,
  };
}

/** 导入：解析校验通过后归一化成完整档案，复用 importProfile 的事务与稳定 id。 */
export async function importYamlClassPlan(
  user: TokenPayload,
  input: ClassPlanYamlImportInput,
): Promise<ClassPlanYamlImportResultDto> {
  await assertCanImportSchedule(user, input.classId);
  assertYamlSize(input.text);
  const parsed = parseClassPlanYaml(input.text);
  if (parsed.errors.length > 0) {
    const shown = parsed.errors.slice(0, 3).join('；');
    const more = parsed.errors.length > 3 ? `；……共 ${parsed.errors.length} 个问题` : '';
    throw ApiError.badRequest(`课表 YAML 解析失败：${shown}${more}`);
  }

  const cls = await prisma.class.findUnique({ where: { id: input.classId } });
  if (!cls) throw ApiError.badRequest('目标班级不存在');
  const maxWeeks = await getMaxTermWeeks();
  const weekEnd = Math.max(1, Math.min(cls.termWeeks || maxWeeks, maxWeeks));
  const payload = buildClassIslandProfile(parsed, weekEnd);
  const imported = await importProfile(user, input.classId, payload, input.mode);
  return { ...imported, warnings: [...parsed.warnings, ...imported.warnings] };
}
