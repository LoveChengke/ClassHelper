import { Router } from 'express';
import { ApiError, sendOk } from '../../lib/http.js';
import { authenticate, getAuthUser, requireRole } from '../../middleware/auth.js';
import { validate, validatedBody, validatedQuery } from '../../middleware/validate.js';
import { defineModule } from '../module.types.js';
import {
  tableCommitSchema,
  tableFileSchema,
  timeLayoutImportSchema,
  classPlanImportSchema,
  timeLayoutQuerySchema,
  type TableCommitInput,
  type TableFileInput,
  type TimeLayoutImportInput,
  type ClassPlanImportInput,
} from './imports.schemas.js';
import { buildTemplateCsv, buildTemplateXlsx, commitTable, previewTable } from './table-import.service.js';
import { importClassPlan, previewClassPlan } from './class-plan.service.js';
import {
  deleteTimeLayout,
  importTimeLayout,
  listTimeLayouts,
  previewClassIslandTimeLayout,
} from './time-layout.service.js';

const router = Router();
router.use(authenticate());

/**
 * GET /api/imports/template?kind=grades|students&format=csv|xlsx - 下载导入模板
 * 成绩模板：管理员或班主任（空白模板，不含任何业务数据）；名单模板：仅管理员
 */
router.get('/template', requireRole('ADMIN', 'TEACHER'), (req, res) => {
  if (req.query.kind === 'students' && getAuthUser(req).role !== 'ADMIN') {
    throw ApiError.forbidden('只有管理员可以导入学生名单');
  }
  const kind = req.query.kind === 'students' ? 'students' : 'grades';
  const format = req.query.format === 'xlsx' ? 'xlsx' : 'csv';
  if (format === 'xlsx') {
    const base64 = buildTemplateXlsx(kind);
    res.setHeader('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('content-disposition', `attachment; filename="template-${kind}.xlsx"`);
    res.send(Buffer.from(base64, 'base64'));
    return;
  }
  sendOk(
    res,
    { kind, format, fileName: `template-${kind}.csv`, content: buildTemplateCsv(kind) },
    '模板生成成功',
  );
});

/**
 * POST /api/imports/table/preview - 上传表格并预览（解析 + 必填列校验 + 建议字段映射）
 * 成绩：管理员或班主任；学生名单：仅管理员（与写入权限保持一致）
 */
router.post(
  '/table/preview',
  requireRole('ADMIN', 'TEACHER'),
  validate({ body: tableFileSchema }),
  (req, res) => {
    const input = validatedBody<TableFileInput>(req);
    if (input.kind === 'students' && getAuthUser(req).role !== 'ADMIN') {
      throw ApiError.forbidden('只有管理员可以导入学生名单');
    }
    sendOk(res, previewTable(input), '表格解析成功');
  },
);

/**
 * POST /api/imports/table/commit - 执行导入（字段映射 + 写入模式 + 结果统计）
 *
 * 路由放行 ADMIN|TEACHER，真正的权限在 service 内按 kind + 班级二次校验：
 * 成绩 → 管理员或本班班主任；学生名单 → 仅管理员；科任老师一律 403（需求 7）。
 */
router.post(
  '/table/commit',
  requireRole('ADMIN', 'TEACHER'),
  validate({ body: tableCommitSchema }),
  async (req, res) => {
    const result = await commitTable(getAuthUser(req), validatedBody<TableCommitInput>(req));
    sendOk(
      res,
      result,
      `导入完成：新增 ${result.inserted} / 更新 ${result.updated} / 跳过 ${result.skipped} / 失败 ${result.failed}`,
    );
  },
);

/**
 * POST /api/imports/time-layout/preview - 预览 ClassIsland 课表时间 JSON（只解析不写库）
 * 权限与"课表管理"一致：管理员或本班班主任
 */
router.post('/time-layout/preview', validate({ body: timeLayoutImportSchema }), async (req, res) => {
  const input = validatedBody<TimeLayoutImportInput>(req);
  // 预览也要校验班级权限（与导入一致），避免越权探测
  const { assertCanManageSchedule } = await import('../../lib/access.js');
  await assertCanManageSchedule(getAuthUser(req), input.classId);
  sendOk(res, previewClassIslandTimeLayout(input.payload), '解析完成');
});

/** GET /api/imports/time-layout?classId= - 查看该班已导入的时间配置 */
router.get('/time-layout', validate({ query: timeLayoutQuerySchema }), async (req, res) => {
  const { classId } = validatedQuery<{ classId: string }>(req);
  sendOk(res, await listTimeLayouts(getAuthUser(req), classId), '获取时间配置成功');
});

/**
 * POST /api/imports/time-layout - 导入 ClassIsland 时间配置
 * mode=replace 覆盖 / merge 按开始时间合并；解析失败返回 400 且不修改原配置。
 */
router.post('/time-layout', validate({ body: timeLayoutImportSchema }), async (req, res) => {
  const result = await importTimeLayout(getAuthUser(req), validatedBody<TimeLayoutImportInput>(req));
  sendOk(
    res,
    result,
    result.mode === 'merge'
      ? `合并导入成功：合并 ${result.merged} 节 / 新增 ${result.replaced} 节`
      : `覆盖导入成功：共 ${result.replaced} 节`,
  );
});

/** DELETE /api/imports/time-layout/:id - 删除某份时间配置 */
router.delete('/time-layout/:id', async (req, res) => {
  await deleteTimeLayout(getAuthUser(req), req.params.id ?? '');
  sendOk(res, { id: req.params.id }, '时间配置已删除');
});

/**
 * POST /api/imports/class-plan/preview - 预览 ClassIsland 课程表 JSON（只解析不写库）
 * 真实档案里单双周由 ClassPlan.TimeRule.WeekCountDiv / WeekCountDivTotal 表达。
 */
router.post('/class-plan/preview', validate({ body: classPlanImportSchema }), async (req, res) => {
  const result = await previewClassPlan(getAuthUser(req), validatedBody<ClassPlanImportInput>(req));
  sendOk(
    res,
    result,
    `解析出 ${result.entries.length} 节课（${result.subjects.length} 个科目，缺 ${result.missingSubjects.length} 个待建课程）`,
  );
});

/**
 * POST /api/imports/class-plan - 导入 ClassIsland 课程表（支持单双周）
 * replace 清空后写入 / merge 按 星期+开始时间+单双周 去重；解析失败返回 400 且不改动现有课表。
 */
router.post('/class-plan', validate({ body: classPlanImportSchema }), async (req, res) => {
  const result = await importClassPlan(getAuthUser(req), validatedBody<ClassPlanImportInput>(req));
  sendOk(
    res,
    result,
    `导入成功：新增 ${result.created} 节 / 更新 ${result.updated} 节` +
      `${result.createdCourses.length > 0 ? `（自动补建课程：${result.createdCourses.join('、')}）` : ''}`,
  );
});

export const importsModule = defineModule({
  name: 'imports',
  basePath: '/imports',
  router,
});
