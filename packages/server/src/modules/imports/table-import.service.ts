import * as XLSX from 'xlsx';
import { prisma } from '../../lib/db.js';
import { env } from '../../config/env.js';
import { ApiError } from '../../lib/http.js';
import type { TokenPayload } from '../../lib/jwt.js';
import { logger } from '../../lib/logger.js';
import { hashPassword } from '../../lib/password.js';
import { assertCanManageGrades, assertCanManageRoster } from '../../lib/access.js';
import type { TableCommitInput, TableFileInput } from './imports.schemas.js';

/**
 * 表格导入（xlsx / xls / csv）。
 *
 * 流程：上传(base64) → 解析首个工作表 → 预览（列名/前 N 行/校验问题/建议映射）
 *      → 前端确认字段映射与写入模式 → 提交（逐行校验，重复按模式处理）→ 结果统计。
 *
 * 异常处理：空文件、超大文件、格式错误、缺列、非法数值、重复数据、未知学生等
 * 都会给出明确原因与行号，绝不静默失败。
 */
const MAX_IMPORT_BYTES = 8 * 1024 * 1024; // 8MB
const PREVIEW_ROWS = 20;

export type ImportKind = TableFileInput['kind'];

/** 规范字段定义（预览、模板、映射提示共用） */
export const IMPORT_FIELDS: Record<
  ImportKind,
  { key: string; label: string; required: boolean; synonyms: string[] }[]
> = {
  grades: [
    {
      key: 'username',
      label: '学生用户名',
      required: false,
      synonyms: ['用户名', 'username', '学号', '账号'],
    },
    { key: 'name', label: '学生姓名', required: false, synonyms: ['姓名', 'name', '学生', '学生姓名'] },
    {
      key: 'examName',
      label: '考试名称',
      required: true,
      synonyms: ['考试', '考试名称', 'exam', 'examName', '测验'],
    },
    { key: 'score', label: '分数', required: true, synonyms: ['分数', 'score', '成绩', '得分'] },
    { key: 'totalScore', label: '总分', required: false, synonyms: ['总分', 'totalScore', '满分'] },
    { key: 'courseName', label: '课程', required: false, synonyms: ['课程', '科目', 'course', 'courseName'] },
  ],
  students: [
    // 学生只有名单没有账号（不能登录、无密码），模板不再有"初始密码"列
    { key: 'username', label: '用户名', required: true, synonyms: ['用户名', 'username', '学号', '账号'] },
    { key: 'name', label: '姓名', required: true, synonyms: ['姓名', 'name', '学生', '学生姓名'] },
  ],
  teachers: [
    { key: 'username', label: '用户名', required: true, synonyms: ['用户名', 'username', '工号', '账号'] },
    { key: 'name', label: '姓名', required: true, synonyms: ['姓名', 'name', '教师', '教师姓名'] },
    { key: 'password', label: '初始密码', required: false, synonyms: ['密码', 'password', '初始密码'] },
    {
      key: 'role',
      label: '角色',
      required: false,
      synonyms: ['角色', 'role', '身份', '权限', '管理员'],
    },
  ],
};

export interface TablePreview {
  kind: ImportKind;
  columns: string[];
  rows: string[][];
  totalRows: number;
  suggestedMapping: Record<string, string>;
  errors: string[];
  warnings: string[];
  templateCsv: string;
}

interface ParsedTable {
  columns: string[];
  rows: string[][];
}

function decodeBase64(contentBase64: string): Buffer {
  const cleaned = contentBase64.includes(',')
    ? contentBase64.slice(contentBase64.indexOf(',') + 1)
    : contentBase64;
  const buffer = Buffer.from(cleaned, 'base64');
  if (buffer.length === 0) throw new ApiError(400, 'IMPORT_EMPTY_FILE', '文件内容为空，请确认导出后重新上传');
  if (buffer.length > MAX_IMPORT_BYTES) {
    throw new ApiError(
      413,
      'IMPORT_TOO_LARGE',
      `文件过大（${(buffer.length / 1024 / 1024).toFixed(1)}MB），请拆分后分批导入（上限 ${MAX_IMPORT_BYTES / 1024 / 1024}MB）`,
    );
  }
  return buffer;
}

/** 解析表格：xlsx/xls 走 SheetJS，csv/tsv 也走 SheetJS（自动识别分隔符） */
function parseTable(buffer: Buffer, fileName: string): ParsedTable {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer', raw: false, cellDates: false });
  } catch (error) {
    throw new ApiError(
      400,
      'IMPORT_FORMAT_INVALID',
      `文件解析失败：${(error as Error).message}（支持 .xlsx/.xls/.csv）`,
      {
        fileName,
      },
    );
  }
  const sheetName = workbook.SheetNames[0];
  const sheet = sheetName ? workbook.Sheets[sheetName] : undefined;
  if (!sheet) throw new ApiError(400, 'IMPORT_EMPTY_FILE', '表格里没有工作表，请确认文件内容');

  const matrix = XLSX.utils.sheet_to_json<string[]>(sheet, {
    header: 1,
    blankrows: false,
    defval: '',
    raw: false,
  });
  const cleaned = matrix
    .map((row) => (Array.isArray(row) ? row.map((cell) => String(cell ?? '').trim()) : []))
    .filter((row) => row.some((cell) => cell !== ''));

  if (cleaned.length === 0) throw new ApiError(400, 'IMPORT_EMPTY_FILE', '表格是空的（没有任何数据行）');

  const headerRow = cleaned[0] ?? [];
  const columns = headerRow.map((cell, index) => (cell === '' ? `第 ${index + 1} 列` : cell));
  const rows = cleaned.slice(1).map((row) => {
    const values = [...row];
    while (values.length < columns.length) values.push('');
    return values.slice(0, columns.length);
  });
  if (rows.length === 0) throw new ApiError(400, 'IMPORT_EMPTY_FILE', '表格只有表头，没有数据行');
  return { columns, rows };
}

/** 生成模板 CSV（同时用于预览弹窗的"下载模板"） */
export function buildTemplateCsv(kind: ImportKind): string {
  const fields = IMPORT_FIELDS[kind];
  const header = fields.map((field) => field.label).join(',');
  const sample =
    kind === 'grades'
      ? ['student01', '王小明', '期中考试', '92', '100', '数学']
      : kind === 'teachers'
        ? ['teacher3', '王老师', 'teacher123', '教师']
        : ['student01', '王小明', 'student123'];
  const sampleLine = fields
    .map((field) => sample[fields.findIndex((item) => item.key === field.key)] ?? '')
    .join(',');
  return `\ufeff${header}\n${sampleLine}\n`;
}

/** 生成模板 XLSX（Base64），让老师可以直接下载后填写 */
export function buildTemplateXlsx(kind: ImportKind): string {
  const fields = IMPORT_FIELDS[kind];
  const header = fields.map((field) => field.label);
  const sample =
    kind === 'grades'
      ? ['student01', '王小明', '期中考试', 92, 100, '数学']
      : kind === 'teachers'
        ? ['teacher3', '王老师', 'teacher123', '教师']
        : ['student01', '王小明', 'student123'];
  const sheet = XLSX.utils.aoa_to_sheet([header, sample]);
  const workbook = XLSX.utils.book_new();
  const sheetName = kind === 'grades' ? '成绩' : kind === 'teachers' ? '教师名单' : '学生名单';
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
  return XLSX.write(workbook, { type: 'base64', bookType: 'xlsx' });
}

/** 按同义词自动建议列映射 */
function suggestMapping(kind: ImportKind, columns: string[]): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const field of IMPORT_FIELDS[kind]) {
    const match = columns.find(
      (column) =>
        field.synonyms.some((synonym) => column.toLowerCase() === synonym.toLowerCase()) ||
        field.synonyms.some((synonym) => column.toLowerCase().includes(synonym.toLowerCase())),
    );
    if (match) mapping[field.key] = match;
  }
  return mapping;
}

/** 预览：解析 + 必填列校验 + 建议映射（不写库） */
export function previewTable(input: TableFileInput): TablePreview {
  const buffer = decodeBase64(input.contentBase64);
  const parsed = parseTable(buffer, input.fileName);
  const errors: string[] = [];
  const warnings: string[] = [];
  const suggestedMapping = suggestMapping(input.kind, parsed.columns);

  for (const field of IMPORT_FIELDS[input.kind]) {
    if (field.required && !suggestedMapping[field.key]) {
      errors.push(`缺少必填列「${field.label}」：请在表格里补上该列，或在下一步手动映射到某一列`);
    }
  }
  if (parsed.rows.length > 2000) warnings.push(`数据行较多（${parsed.rows.length} 行），导入可能需要几秒钟`);

  return {
    kind: input.kind,
    columns: parsed.columns,
    rows: parsed.rows.slice(0, PREVIEW_ROWS),
    totalRows: parsed.rows.length,
    suggestedMapping,
    errors,
    warnings,
    templateCsv: buildTemplateCsv(input.kind),
  };
}

export interface ImportRowError {
  row: number;
  message: string;
}

export interface ImportResult {
  kind: ImportKind;
  total: number;
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
  errors: ImportRowError[];
  warnings: string[];
}

function cellValue(row: string[], columns: string[], mapping: Record<string, string>, key: string): string {
  const column = mapping[key];
  if (!column) return '';
  const index = columns.indexOf(column);
  if (index < 0) return '';
  return (row[index] ?? '').trim();
}

/** 导入成绩：学生按用户名/姓名匹配；重复（同班级+学生+考试+课程）按 mode 处理 */
export async function commitGrades(user: TokenPayload, input: TableCommitInput): Promise<ImportResult> {
  const classId = input.classId;
  if (!classId) throw ApiError.badRequest('导入成绩需要先选择班级');
  // 成绩导入：管理员或本班班主任（需求 6）；科任 403
  await assertCanManageGrades(user, classId);
  const buffer = decodeBase64(input.contentBase64);
  const parsed = parseTable(buffer, input.fileName);

  const students = await prisma.user.findMany({
    where: { classId, role: 'STUDENT' },
    select: { id: true, username: true, name: true },
  });
  const byUsername = new Map(students.map((item) => [item.username.toLowerCase(), item]));
  const byName = new Map(students.map((item) => [item.name.toLowerCase(), item]));
  const courses = await prisma.course.findMany({
    where: { classId },
    select: { id: true, name: true },
  });

  const errors: ImportRowError[] = [];
  const warnings: string[] = [];
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const [index, row] of parsed.rows.entries()) {
    const rowNumber = index + 2; // 含表头，从 Excel 视角的行号
    const username = cellValue(row, parsed.columns, input.mapping, 'username');
    const name = cellValue(row, parsed.columns, input.mapping, 'name');
    const examName = cellValue(row, parsed.columns, input.mapping, 'examName');
    const scoreText = cellValue(row, parsed.columns, input.mapping, 'score');
    const totalText = cellValue(row, parsed.columns, input.mapping, 'totalScore');
    const courseName = cellValue(row, parsed.columns, input.mapping, 'courseName');

    if (!username && !name) {
      errors.push({ row: rowNumber, message: '缺少学生标识（用户名与姓名至少填写一个）' });
      continue;
    }
    const student =
      (username ? byUsername.get(username.toLowerCase()) : undefined) ??
      (name ? byName.get(name.toLowerCase()) : undefined);
    if (!student) {
      errors.push({ row: rowNumber, message: `找不到该班学生：${username || name}` });
      continue;
    }
    if (!examName) {
      errors.push({ row: rowNumber, message: '缺少考试名称' });
      continue;
    }
    const score = Number(scoreText);
    if (!Number.isFinite(score)) {
      errors.push({ row: rowNumber, message: `分数「${scoreText}」不是数字` });
      continue;
    }
    const totalScore = totalText ? Number(totalText) : 100;
    if (!Number.isFinite(totalScore) || totalScore <= 0) {
      errors.push({ row: rowNumber, message: `总分「${totalText || '100'}」不合法` });
      continue;
    }
    if (score < 0 || score > totalScore) {
      errors.push({ row: rowNumber, message: `分数 ${score} 超出 0~${totalScore} 范围` });
      continue;
    }

    const course = courseName ? courses.find((item) => item.name === courseName) : null;
    if (courseName && !course)
      warnings.push(`第 ${rowNumber} 行：课程「${courseName}」不存在，已按"不指定课程"导入`);

    const existing = await prisma.grade.findFirst({
      where: { classId: classId, userId: student.id, examName, courseId: course?.id ?? null },
      select: { id: true },
    });

    if (existing) {
      if (input.mode === 'append') {
        skipped += 1;
        continue;
      }
      await prisma.grade.update({
        where: { id: existing.id },
        data: { score, totalScore, publishedAt: new Date() },
      });
      updated += 1;
    } else {
      await prisma.grade.create({
        data: {
          classId: classId,
          userId: student.id,
          courseId: course?.id ?? null,
          examName,
          score,
          totalScore,
        },
      });
      inserted += 1;
    }
  }

  const result: ImportResult = {
    kind: 'grades',
    total: parsed.rows.length,
    inserted,
    updated,
    skipped,
    failed: errors.length,
    errors,
    warnings,
  };
  logger.info(
    `成绩导入：班级=${classId} 模式=${input.mode} 新增=${inserted} 更新=${updated} 跳过=${skipped} 失败=${errors.length}`,
  );
  return result;
}

/** 导入学生名单：按用户名去重（append 跳过 / upsert 更新姓名与班级），仅管理员可用 */
export async function commitStudents(user: TokenPayload, input: TableCommitInput): Promise<ImportResult> {
  assertCanManageRoster(user);
  const classId = input.classId;
  if (!classId) throw ApiError.badRequest('导入学生名单需要先选择班级');
  const buffer = decodeBase64(input.contentBase64);
  const parsed = parseTable(buffer, input.fileName);

  const cls = await prisma.class.findUnique({ where: { id: classId }, select: { id: true } });
  if (!cls) throw ApiError.notFound('班级不存在');

  const errors: ImportRowError[] = [];
  const warnings: string[] = [];
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const [index, row] of parsed.rows.entries()) {
    const rowNumber = index + 2;
    const username = cellValue(row, parsed.columns, input.mapping, 'username');
    const name = cellValue(row, parsed.columns, input.mapping, 'name');

    if (!username || !name) {
      errors.push({ row: rowNumber, message: '用户名与姓名都必须填写' });
      continue;
    }
    if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
      errors.push({ row: rowNumber, message: `用户名「${username}」格式不合法（3~32 位字母/数字/_.-）` });
      continue;
    }

    const existing = await prisma.user.findUnique({ where: { username }, select: { id: true, role: true } });
    if (existing) {
      if (existing.role !== 'STUDENT') {
        errors.push({ row: rowNumber, message: `用户名「${username}」已被教师/管理员账号占用` });
        continue;
      }
      if (input.mode === 'append') {
        skipped += 1;
        continue;
      }
      await prisma.user.update({ where: { id: existing.id }, data: { name, classId: classId } });
      updated += 1;
    } else {
      await prisma.user.create({
        data: {
          username,
          name,
          role: 'STUDENT',
          classId: classId,
          // 学生不设密码（空串占位，登录 403 判定在密码校验之前），见"学生只有名单没有账号"
          passwordHash: '',
        },
      });
      inserted += 1;
    }
  }

  const result: ImportResult = {
    kind: 'students',
    total: parsed.rows.length,
    inserted,
    updated,
    skipped,
    failed: errors.length,
    errors,
    warnings,
  };
  logger.info(
    `学生名单导入：班级=${classId} 模式=${input.mode} 新增=${inserted} 更新=${updated} 跳过=${skipped} 失败=${errors.length}`,
  );
  return result;
}

/**
 * 导入教师名单：按用户名去重（append 跳过 / upsert 更新姓名与角色），**仅管理员**可用。
 *
 * 与班级无关（教师不属于班级），因此不需要 classId，模板里也没有班级列。
 * 角色列可选：填「管理员 / ADMIN / admin」建管理员账号，其余一律建教师账号。
 */
export async function commitTeachers(user: TokenPayload, input: TableCommitInput): Promise<ImportResult> {
  assertCanManageRoster(user);
  const buffer = decodeBase64(input.contentBase64);
  const parsed = parseTable(buffer, input.fileName);

  const errors: ImportRowError[] = [];
  const warnings: string[] = [];
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const [index, row] of parsed.rows.entries()) {
    const rowNumber = index + 2;
    const username = cellValue(row, parsed.columns, input.mapping, 'username');
    const name = cellValue(row, parsed.columns, input.mapping, 'name');
    const password = cellValue(row, parsed.columns, input.mapping, 'password');
    const roleCell = cellValue(row, parsed.columns, input.mapping, 'role');

    if (!username || !name) {
      errors.push({ row: rowNumber, message: '用户名与姓名都必须填写' });
      continue;
    }
    if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
      errors.push({ row: rowNumber, message: `用户名「${username}」格式不合法（3~32 位字母/数字/_.-）` });
      continue;
    }

    const existing = await prisma.user.findUnique({ where: { username }, select: { id: true, role: true } });
    if (existing) {
      if (existing.role === 'STUDENT') {
        errors.push({ row: rowNumber, message: `用户名「${username}」已被学生账号占用` });
        continue;
      }
      if (input.mode === 'append') {
        skipped += 1;
        continue;
      }
      const nextRole = parseTeacherRole(roleCell) ?? existing.role;
      await prisma.user.update({ where: { id: existing.id }, data: { name, role: nextRole } });
      updated += 1;
    } else {
      const initialPassword = password || env.defaultTeacherPassword;
      await prisma.user.create({
        data: {
          username,
          name,
          role: parseTeacherRole(roleCell) ?? 'TEACHER',
          passwordHash: await hashPassword(initialPassword),
        },
      });
      inserted += 1;
    }
  }

  const result: ImportResult = {
    kind: 'teachers',
    total: parsed.rows.length,
    inserted,
    updated,
    skipped,
    failed: errors.length,
    errors,
    warnings,
  };
  logger.info(
    `教师名单导入：模式=${input.mode} 新增=${inserted} 更新=${updated} 跳过=${skipped} 失败=${errors.length}`,
  );
  return result;
}

/** 角色列解析：只认「管理员」类词；其余（含空）返回 null 交给调用方取默认值 */
function parseTeacherRole(cell: string): 'TEACHER' | 'ADMIN' | null {
  const value = cell.trim().toUpperCase();
  if (!value) return null;
  if (value === 'ADMIN' || cell.includes('管理员') || value === '管理员') return 'ADMIN';
  return 'TEACHER';
}

export async function commitTable(user: TokenPayload, input: TableCommitInput): Promise<ImportResult> {
  if (input.kind === 'teachers') return commitTeachers(user, input);
  if (input.kind === 'grades') return commitGrades(user, input);
  return commitStudents(user, input);
}
