import { Router } from 'express';
import { sendOk } from '../../lib/http.js';
import { authenticate, getAuthUser, requireRole } from '../../middleware/auth.js';
import { validate, validatedBody, validatedQuery } from '../../middleware/validate.js';
import { defineModule } from '../module.types.js';
import {
  tableCommitSchema,
  tableFileSchema,
  timeLayoutImportSchema,
  timeLayoutQuerySchema,
  type TableCommitInput,
  type TableFileInput,
  type TimeLayoutImportInput,
} from './imports.schemas.js';
import { buildTemplateCsv, buildTemplateXlsx, commitTable, previewTable } from './table-import.service.js';
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
 * 成绩模板=管理员；名单模板=管理员（与写入权限一致，不额外开入口）
 */
router.get('/template', requireRole('ADMIN'), (req, res) => {
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
 * 仅管理员：与"成绩录入 / 名单管理"权限一致
 */
router.post('/table/preview', requireRole('ADMIN'), validate({ body: tableFileSchema }), (req, res) => {
  sendOk(res, previewTable(validatedBody<TableFileInput>(req)), '表格解析成功');
});

/** POST /api/imports/table/commit - 执行导入（字段映射 + 写入模式 + 结果统计） */
router.post(
  '/table/commit',
  requireRole('ADMIN'),
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

export const importsModule = defineModule({
  name: 'imports',
  basePath: '/imports',
  router,
});
