import * as XLSX from 'xlsx';
import { formatClassName, normalizeStudentNo, type TableImportKind } from '@classhelper/shared';
import { prisma } from '../../lib/db.js';
import { env } from '../../config/env.js';
import { ApiError } from '../../lib/http.js';
import type { TokenPayload } from '../../lib/jwt.js';
import { logger } from '../../lib/logger.js';
import { hashPassword } from '../../lib/password.js';
import { resolveUserClassRole } from '../../lib/access.js';
import { canImport } from '@classhelper/shared';
import type { TableCommitInput, TableFileInput } from './imports.schemas.js';

/**
 * 表格导入（xlsx / xls / csv）。
 *
 * 流程：上传(base64) → 解析首个工作表 → 预览（列名/前 N 行/校验问题/建议映射）
 *      → 前端确认字段映射与写入模式 → 提交（逐行校验，重复按模式处理）→ 结果统计。
 *
 * 异常处理：空文件、超大文件、格式错误、缺列、非法数值、重复数据、未知学生等
 * 都会给出明确原因与行号，绝不静默失败。
 *
 * **学生一律按「学号」匹配**（原「用户名」列已改名）：
 * 学生不是账号，导入只生成班级名单，不产生任何登录凭证。
 */
const MAX_IMPORT_BYTES = 8 * 1024 * 1024; // 8MB
const PREVIEW_ROWS = 20;

export type ImportKind = TableFileInput['kind'];

interface ImportField {
  key: string;
  label: string;
  required: boolean;
  synonyms: string[];
}

/** 规范字段定义（预览、模板、映射提示共用） */
export const IMPORT_FIELDS: Record<ImportKind, ImportField[]> = {
  grades: [
    {
      key: 'studentNo',
      label: '学生学号',
      required: false,
      // 「用户名 / username」保留为兼容别名：老模板导出的文件还能直接导入，
      // 但界面上、提示里一律叫「学号」。
      synonyms: ['学号', 'studentNo', '用户名', 'username', '账号', '编号'],
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
    { key: 'courseName', label: '科目', required: false, synonyms: ['科目', '课程', 'course', 'courseName'] },
    {
      key: 'level',
      label: '等级',
      required: false,
      synonyms: ['等级', 'level', '档次', '评级'],
    },
  ],
  students: [
    // 学生只有名单没有账号（不能登录、无密码），模板里既没有密码列也不该有
    {
      key: 'studentNo',
      label: '学号',
      required: true,
      synonyms: ['学号', 'studentNo', '用户名', 'username', '账号', '学籍号', '编号'],
    },
    { key: 'name', label: '姓名', required: true, synonyms: ['姓名', 'name', '学生', '学生姓名'] },
    {
      key: 'className',
      label: '班级',
      required: false,
      synonyms: ['班级', 'class', 'className', '班', '所在班级'],
    },
    { key: 'gender', label: '性别', required: false, synonyms: ['性别', 'gender', 'sex'] },
    {
      key: 'guardianPhone',
      label: '家长手机号',
      required: false,
      synonyms: ['家长手机号', '家长电话', '手机号', '联系电话', 'phone', '电话', '家长联系方式'],
    },
  ],
  teachers: [
    {
      key: 'username',
      label: '工号',
      required: true,
      synonyms: ['工号', '用户名', 'username', '账号', '教师工号'],
    },
    { key: 'name', label: '姓名', required: true, synonyms: ['姓名', 'name', '教师', '教师姓名'] },
    { key: 'phone', label: '手机号', required: false, synonyms: ['手机号', '电话', 'phone', '联系方式'] },
    { key: 'password', label: '初始密码', required: false, synonyms: ['密码', 'password', '初始密码'] },
    {
      key: 'role',
      label: '角色',
      required: false,
      synonyms: ['角色', 'role', '身份', '权限', '管理员'],
    },
  ],
  classTeachers: [
    {
      key: 'className',
      label: '班级',
      required: true,
      synonyms: ['班级', 'class', 'className', '班', '班级名称'],
    },
    {
      key: 'subjectName',
      label: '科目',
      required: false,
      // 班主任行没有科目；科任行必须有
      synonyms: ['科目', '课程', '学科', 'subject', 'subjectName'],
    },
    {
      key: 'teacherNo',
      label: '教师工号',
      required: true,
      synonyms: ['工号', '教师工号', '用户名', 'teacherNo', 'username', '账号'],
    },
    {
      key: 'teacherName',
      label: '教师姓名',
      required: false,
      synonyms: ['姓名', '教师姓名', '教师', 'name', 'teacherName'],
    },
    {
      key: 'role',
      label: '角色',
      required: true,
      synonyms: ['角色', 'role', '身份', '职务'],
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
      { fileName },
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

/** 各类导入的模板示例行（与 IMPORT_FIELDS 的顺序一一对应） */
const TEMPLATE_SAMPLES: Record<ImportKind, (string | number)[]> = {
  grades: ['202601', '王小明', '期中考试', 92, 100, '数学', 'A'],
  students: ['202601', '王小明', '2026级1班', '男', '13800000000'],
  teachers: ['T1001', '王老师', '13800000000', 'teacher123', '教师'],
  classTeachers: ['2026级1班', '数学', 'T1001', '王老师', '科任'],
};

const TEMPLATE_SHEET_NAMES: Record<ImportKind, string> = {
  grades: '成绩',
  students: '学生名单',
  teachers: '教师名单',
  classTeachers: '班级任课老师',
};

/** 生成模板 CSV（同时用于预览弹窗的"下载模板"） */
export function buildTemplateCsv(kind: ImportKind): string {
  const fields = IMPORT_FIELDS[kind];
  const header = fields.map((field) => field.label).join(',');
  const sample = TEMPLATE_SAMPLES[kind];
  const sampleLine = fields.map((_, index) => sample[index] ?? '').join(',');
  return `﻿${header}\n${sampleLine}\n`;
}

/** 生成模板 XLSX（Base64），让老师可以直接下载后填写 */
export function buildTemplateXlsx(kind: ImportKind): string {
  const fields = IMPORT_FIELDS[kind];
  const header = fields.map((field) => field.label);
  const sheet = XLSX.utils.aoa_to_sheet([header, TEMPLATE_SAMPLES[kind]]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, TEMPLATE_SHEET_NAMES[kind]);
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

/** 性别文本归一：男/M/1 → MALE；女/F/2 → FEMALE；其余空 */
function parseGender(value: string): '' | 'MALE' | 'FEMALE' {
  const text = value.trim();
  if (!text) return '';
  if (/^(男|male|m|1)$/i.test(text)) return 'MALE';
  if (/^(女|female|f|2)$/i.test(text)) return 'FEMALE';
  return '';
}

/* ------------------------------------------------------------------ 成绩 */

/** 导入成绩：学生按**学号**匹配（学号缺失时退化为按姓名匹配） */
export async function commitGrades(user: TokenPayload, input: TableCommitInput): Promise<ImportResult> {
  const classId = input.classId;
  if (!classId) throw ApiError.badRequest('导入成绩需要先选择班级');
  await assertImportAllowed(user, classId, 'grades');

  const buffer = decodeBase64(input.contentBase64);
  const parsed = parseTable(buffer, input.fileName);

  const students = await prisma.student.findMany({
    where: { classId },
    select: { id: true, studentNo: true, name: true },
  });
  // 学号在库里已归一化为大写，比对前统一一次
  const byStudentNo = new Map(students.map((item) => [normalizeStudentNo(item.studentNo), item]));
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
    const studentNo = cellValue(row, parsed.columns, input.mapping, 'studentNo');
    const name = cellValue(row, parsed.columns, input.mapping, 'name');
    const examName = cellValue(row, parsed.columns, input.mapping, 'examName');
    const scoreText = cellValue(row, parsed.columns, input.mapping, 'score');
    const totalText = cellValue(row, parsed.columns, input.mapping, 'totalScore');
    const courseName = cellValue(row, parsed.columns, input.mapping, 'courseName');
    const levelText = cellValue(row, parsed.columns, input.mapping, 'level');

    if (!studentNo && !name) {
      errors.push({ row: rowNumber, message: '缺少学生标识（学号与姓名至少填写一个）' });
      continue;
    }
    const student =
      (studentNo ? byStudentNo.get(normalizeStudentNo(studentNo)) : undefined) ??
      (name ? byName.get(name.toLowerCase()) : undefined);
    if (!student) {
      errors.push({ row: rowNumber, message: `找不到该班学生：${studentNo || name}` });
      continue;
    }
    if (!examName) {
      errors.push({ row: rowNumber, message: '缺少考试名称' });
      continue;
    }
    const score = Number(scoreText);
    if (scoreText === '' || !Number.isFinite(score)) {
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
      warnings.push(`第 ${rowNumber} 行：科目「${courseName}」不存在，已按"不指定科目"导入`);

    // 表格里带等级列就按"自定义等级"落库（教师明确给了等级），否则按百分制换算
    const levelType = levelText ? 'custom' : 'percent';
    const existing = await prisma.grade.findFirst({
      where: { classId, studentId: student.id, examName, courseId: course?.id ?? null },
      select: { id: true },
    });

    if (existing) {
      if (input.mode === 'append') {
        skipped += 1;
        continue;
      }
      await prisma.grade.update({
        where: { id: existing.id },
        data: { score, totalScore, levelType, level: levelText, publishedAt: new Date() },
      });
      updated += 1;
    } else {
      await prisma.grade.create({
        data: {
          classId,
          studentId: student.id,
          courseId: course?.id ?? null,
          examName,
          score,
          totalScore,
          levelType,
          level: levelText,
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

/* ------------------------------------------------------------------ 学生名单 */

/**
 * 导入学生名单：**按学号**去重（append 跳过 / upsert 更新姓名、班级、性别、家长手机号）。
 *
 * 只写 `Student`（名单记录），**不创建任何账号** —— 学生没有密码、不能登录。
 * 班级列可选：填了按班级名解析（重名报错），否则用弹窗里选中的班级。
 */
export async function commitStudents(user: TokenPayload, input: TableCommitInput): Promise<ImportResult> {
  const buffer = decodeBase64(input.contentBase64);
  const parsed = parseTable(buffer, input.fileName);

  // 班级列可用时按名字解析；同名班级（跨年级）会让导入变得含糊，直接报错让老师改用班级码
  const hasClassColumn = Boolean(input.mapping.className);
  const fallbackClassId = input.classId ?? null;
  if (fallbackClassId) await assertImportAllowed(user, fallbackClassId, 'students');
  else if (!hasClassColumn) throw ApiError.badRequest('导入学生名单需要选择班级，或在表格里提供「班级」列');

  const allClasses = await prisma.class.findMany({
    where: { archivedYearId: null },
    select: { id: true, name: true, enrollmentYear: true, classIndex: true },
  });
  const classByName = new Map<string, { id: string; name: string }>();
  for (const item of allClasses) {
    const key = item.name.toLowerCase();
    if (classByName.has(key)) classByName.delete(key); // 重名 → 标记为不可用
    else classByName.set(key, item);
  }

  const errors: ImportRowError[] = [];
  const warnings: string[] = [];
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const [index, row] of parsed.rows.entries()) {
    const rowNumber = index + 2;
    const studentNoRaw = cellValue(row, parsed.columns, input.mapping, 'studentNo');
    const name = cellValue(row, parsed.columns, input.mapping, 'name');
    const className = cellValue(row, parsed.columns, input.mapping, 'className');
    const gender = parseGender(cellValue(row, parsed.columns, input.mapping, 'gender'));
    const guardianPhone = cellValue(row, parsed.columns, input.mapping, 'guardianPhone');

    if (!studentNoRaw || !name) {
      errors.push({ row: rowNumber, message: '学号与姓名都必须填写' });
      continue;
    }
    const studentNo = normalizeStudentNo(studentNoRaw);
    if (!/^[A-Za-z0-9._-]{1,32}$/.test(studentNo)) {
      errors.push({ row: rowNumber, message: `学号「${studentNoRaw}」格式不合法（1~32 位字母/数字/._-）` });
      continue;
    }

    // 目标班级：表格里的班级列优先，其次弹窗选的班级
    let classId = fallbackClassId;
    if (className) {
      const matched = classByName.get(className.toLowerCase());
      if (!matched) {
        errors.push({
          row: rowNumber,
          message: `找不到班级「${className}」（可能已毕业归档或名称重复，请核对后在班级管理里查看）`,
        });
        continue;
      }
      classId = matched.id;
      if (fallbackClassId && fallbackClassId !== matched.id) {
        // 表格里写了班级就以表格为准，只是提醒一下
        warnings.push(`第 ${rowNumber} 行：按表格里的班级「${className}」导入（与所选班级不同）`);
      }
    }
    if (!classId) {
      errors.push({ row: rowNumber, message: '该行没有班级信息，请填写「班级」列或在上一步选择班级' });
      continue;
    }
    await assertImportAllowed(user, classId, 'students');

    const existing = await prisma.student.findUnique({
      where: { studentNo },
      select: { id: true, classId: true },
    });

    if (existing) {
      if (input.mode === 'append') {
        skipped += 1;
        continue;
      }
      if (existing.classId !== classId) {
        // 换班要留痕，与手动调班同一种历史
        const [from, to] = await Promise.all([
          classNameOf(existing.classId),
          classNameOf(classId),
        ]);
        await prisma.studentClassTransfer.create({
          data: {
            studentId: existing.id,
            studentNo,
            studentName: name,
            fromClassId: existing.classId,
            fromClassName: from,
            toClassId: classId,
            toClassName: to,
            operatorId: user.sub,
            operatorName: user.name,
            mode: 'batch',
            note: '学生名单导入',
          },
        });
      }
      await prisma.student.update({
        where: { id: existing.id },
        data: {
          name,
          classId,
          status: 'active',
          ...(gender ? { gender } : {}),
          ...(guardianPhone ? { guardianPhone } : {}),
        },
      });
      updated += 1;
    } else {
      await prisma.student.create({
        data: { studentNo, name, classId, gender, guardianPhone },
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
    `学生名单导入：模式=${input.mode} 新增=${inserted} 更新=${updated} 跳过=${skipped} 失败=${errors.length}`,
  );
  return result;
}

/* ------------------------------------------------------------------ 教师名单 */

/**
 * 导入教师名单：按**工号**去重（append 跳过 / upsert 更新姓名与角色），**仅管理员**可用。
 * 与班级无关（教师不属于班级），因此不需要 classId。
 */
export async function commitTeachers(user: TokenPayload, input: TableCommitInput): Promise<ImportResult> {
  await assertImportAllowed(user, undefined, 'teachers');
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
    const phone = cellValue(row, parsed.columns, input.mapping, 'phone');
    const password = cellValue(row, parsed.columns, input.mapping, 'password');
    const roleCell = cellValue(row, parsed.columns, input.mapping, 'role');

    if (!username || !name) {
      errors.push({ row: rowNumber, message: '工号与姓名都必须填写' });
      continue;
    }
    if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
      errors.push({ row: rowNumber, message: `工号「${username}」格式不合法（3~32 位字母/数字/._-）` });
      continue;
    }

    const existing = await prisma.user.findUnique({ where: { username }, select: { id: true, role: true } });
    if (existing) {
      if (input.mode === 'append') {
        skipped += 1;
        continue;
      }
      const nextRole = parseTeacherRole(roleCell) ?? existing.role;
      await prisma.user.update({
        where: { id: existing.id },
        data: { name, role: nextRole, ...(phone ? { phone } : {}) },
      });
      updated += 1;
    } else {
      const initialPassword = password || env.defaultTeacherPassword;
      await prisma.user.create({
        data: {
          username,
          name,
          phone,
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
  logger.info(`教师名单导入：模式=${input.mode} 新增=${inserted} 更新=${updated} 跳过=${skipped} 失败=${errors.length}`);
  return result;
}

/* ------------------------------------------------------------------ 班级任课老师 */

/**
 * 导入班级任课老师（班级 + 科目 + 工号 + 姓名 + 角色），**仅管理员**。
 *
 * 角色列：
 * - 「班主任」→ 写 `Class.teacherId`（每班 1 人，后导入的覆盖先导入的）；
 * - 「科任」  → 写 `Course.teacherId`（该班该科的任课老师，没有该科目就自动建课）。
 *
 * **不产生重复教师**：同一工号在表格里出现多次（班主任行 + 科任行）时，
 * 后面几行指向的还是同一个账号（`useTeacherNo` 打开时按工号匹配，关闭时按姓名唯一匹配），
 * 因此"班主任同时是科任老师"只会有一条教师记录，权限在 `resolveClassRole` 里合并。
 */
export async function commitClassTeachers(user: TokenPayload, input: TableCommitInput): Promise<ImportResult> {
  await assertImportAllowed(user, undefined, 'classTeachers');
  const buffer = decodeBase64(input.contentBase64);
  const parsed = parseTable(buffer, input.fileName);

  const useTeacherNo = input.useTeacherNo !== false; // 默认开：有工号就优先按工号匹配

  const errors: ImportRowError[] = [];
  const warnings: string[] = [];
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  const classes = await prisma.class.findMany({
    where: { archivedYearId: null },
    select: { id: true, name: true, teacherId: true },
  });
  const classByName = new Map<string, { id: string; name: string; teacherId: string }>();
  for (const item of classes) {
    const key = item.name.toLowerCase();
    if (classByName.has(key)) classByName.delete(key);
    else classByName.set(key, item);
  }

  // 本次导入新建的教师账号（同一份表格里再遇到同名/同工号时复用，避免重复建号）
  const createdTeachers = new Map<string, string>();

  for (const [index, row] of parsed.rows.entries()) {
    const rowNumber = index + 2;
    const className = cellValue(row, parsed.columns, input.mapping, 'className');
    const subjectName = cellValue(row, parsed.columns, input.mapping, 'subjectName');
    const teacherNo = cellValue(row, parsed.columns, input.mapping, 'teacherNo');
    const teacherName = cellValue(row, parsed.columns, input.mapping, 'teacherName');
    const roleCell = cellValue(row, parsed.columns, input.mapping, 'role');

    if (!className || !teacherNo) {
      errors.push({ row: rowNumber, message: '班级与教师工号都必须填写' });
      continue;
    }

    const targetClass = classByName.get(className.toLowerCase());
    if (!targetClass) {
      errors.push({ row: rowNumber, message: `找不到班级「${className}」（可能已毕业归档或名称重复）` });
      continue;
    }

    const role = parseClassTeacherRole(roleCell);
    if (!role) {
      errors.push({ row: rowNumber, message: `角色「${roleCell}」无法识别，请填「班主任」或「科任」` });
      continue;
    }
    if (role === 'SUBJECT' && !subjectName) {
      errors.push({ row: rowNumber, message: '科任老师必须填写科目' });
      continue;
    }

    // ---- 匹配或新建教师账号
    let teacherId = createdTeachers.get(teacherNo.toLowerCase());
    if (!teacherId) {
      if (useTeacherNo) {
        const byNo = await prisma.user.findUnique({
          where: { username: teacherNo },
          select: { id: true },
        });
        if (byNo) {
          teacherId = byNo.id;
        }
      } else if (teacherName) {
        const byName = await prisma.user.findMany({
          where: { name: teacherName, role: { in: ['TEACHER', 'ADMIN'] } },
          select: { id: true },
          take: 2,
        });
        if (byName.length === 1) {
          teacherId = byName[0]!.id;
        } else if (byName.length > 1) {
          errors.push({
            row: rowNumber,
            message: `姓名「${teacherName}」对应多个教师账号，无法确定是哪一个；请打开「使用工号匹配」再导入`,
          });
          continue;
        }
      }
    }

    if (!teacherId) {
      if (!useTeacherNo) {
        errors.push({
          row: rowNumber,
          message: `按姓名找不到教师「${teacherName || teacherNo}」；请打开「使用工号匹配」以便按工号新建账号`,
        });
        continue;
      }
      const created = await prisma.user.create({
        data: {
          username: teacherNo,
          name: teacherName || teacherNo,
          role: 'TEACHER',
          passwordHash: await hashPassword(env.defaultTeacherPassword),
        },
        select: { id: true },
      });
      teacherId = created.id;
      inserted += 1;
      warnings.push(
        `第 ${rowNumber} 行：工号 ${teacherNo} 没有对应账号，已新建教师「${teacherName || teacherNo}」（初始密码见部署配置）`,
      );
    }
    createdTeachers.set(teacherNo.toLowerCase(), teacherId);

    // ---- 写入角色
    if (role === 'HEAD') {
      if (targetClass.teacherId === teacherId) {
        skipped += 1;
        continue;
      }
      await prisma.class.update({ where: { id: targetClass.id }, data: { teacherId } });
      targetClass.teacherId = teacherId;
      updated += 1;
    } else {
      const existing = await prisma.course.findUnique({
        where: { classId_name: { classId: targetClass.id, name: subjectName } },
        select: { id: true, teacherId: true },
      });
      if (existing) {
        if (existing.teacherId === teacherId) {
          skipped += 1;
          continue;
        }
        await prisma.course.update({ where: { id: existing.id }, data: { teacherId } });
      } else {
        await prisma.course.create({
          data: { name: subjectName, classId: targetClass.id, teacherId },
        });
      }
      updated += 1;
    }
  }

  const result: ImportResult = {
    kind: 'classTeachers',
    total: parsed.rows.length,
    inserted,
    updated,
    skipped,
    failed: errors.length,
    errors,
    warnings,
  };
  logger.info(
    `班级任课老师导入：用工号匹配=${useTeacherNo} 新建教师=${inserted} 更新关系=${updated} 跳过=${skipped} 失败=${errors.length}`,
  );
  return result;
}

export async function commitTable(user: TokenPayload, input: TableCommitInput): Promise<ImportResult> {
  if (input.kind === 'teachers') return commitTeachers(user, input);
  if (input.kind === 'classTeachers') return commitClassTeachers(user, input);
  if (input.kind === 'grades') return commitGrades(user, input);
  return commitStudents(user, input);
}

/** 供预览接口复用的模板生成（Web 端「下载模板」） */
export function templateFor(kind: TableImportKind): { csv: string; xlsx: string } {
  return { csv: buildTemplateCsv(kind), xlsx: buildTemplateXlsx(kind) };
}

/* ------------------------------------------------------------------ 内部工具 */

/** 导入权限：与学生名单/成绩同一套口径（见 shared 的 canImport） */
async function assertImportAllowed(
  user: TokenPayload,
  classId: string | undefined,
  kind: 'grades' | 'students' | 'teachers' | 'classTeachers' | 'scheduleTimes',
): Promise<void> {
  const classRole = classId ? await resolveUserClassRole(user, classId) : 'NONE';
  if (canImport(user.role, classRole, kind)) return;
  if (kind === 'students' || kind === 'grades') {
    throw ApiError.forbidden(
      classRole === 'SUBJECT' || classRole === 'CLASS_DEVICE'
        ? '科任老师与 ClassHelper 班级端不能导入名单或成绩，请联系班主任或管理员'
        : '只能导入自己担任班主任的班级的数据',
    );
  }
  throw ApiError.forbidden('该导入仅限管理员使用');
}

async function classNameOf(classId: string | null): Promise<string> {
  if (!classId) return '';
  const record = await prisma.class.findUnique({ where: { id: classId }, select: { name: true } });
  return record?.name ?? '';
}

/** 角色列解析：只认「管理员」类词；其余（含空）返回 null 交给调用方取默认值 */
function parseTeacherRole(cell: string): 'TEACHER' | 'ADMIN' | null {
  const value = cell.trim().toUpperCase();
  if (!value) return null;
  if (value === 'ADMIN' || cell.includes('管理员') || value === '管理员') return 'ADMIN';
  return 'TEACHER';
}

/** 班级任课老师的角色列：班主任 / 科任 */
function parseClassTeacherRole(cell: string): 'HEAD' | 'SUBJECT' | null {
  const value = cell.trim();
  if (!value) return null;
  if (value.includes('班主任') || value.toUpperCase() === 'HEAD') return 'HEAD';
  if (value.includes('科任') || value.includes('任课') || value.toUpperCase() === 'SUBJECT') return 'SUBJECT';
  return null;
}

/** 导出：把班级名与入学年份生成统一称呼（供未来导出功能复用） */
export { formatClassName };
