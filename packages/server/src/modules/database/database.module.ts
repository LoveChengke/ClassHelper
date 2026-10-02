import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { sendCreated, sendOk } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { validate, validatedBody, validatedParams } from '../../middleware/validate.js';
import { defineModule } from '../module.types.js';
import {
  backupNameParamSchema,
  backupScheduleSchema,
  importSnapshotSchema,
  jobIdParamSchema,
  switchDatabaseSchema,
  testConnectionSchema,
  type BackupScheduleInput,
  type ImportSnapshotInput,
  type SwitchDatabaseInput,
  type TestConnectionInput,
} from './database.schemas.js';
import * as databaseService from './database.service.js';

/**
 * 数据库管理（仅管理员）：状态检测 / 连接测试 / 备份恢复 / 导入导出 / 定时备份 / 一键切换。
 *
 * 改动数据库属于最高危操作，全部接口挂在 requireRole('ADMIN') 之下；
 * 前端入口同样只对 ADMIN 显示（Web 端「数据库管理」页）。
 *
 * 一键切换是异步任务：POST /switch 返回 jobId，前端轮询 GET /switch/jobs/:id 展示步骤进度。
 * Redis 是键值库，不是 Prisma 支持的主数据库，因此不在此模块范围内。
 */
const router = Router();

router.use(authenticate());
router.use(requireRole('ADMIN'));

/** GET /api/database/status - 当前数据库状态（连接/版本/大小/各表行数/备份与定时配置） */
router.get('/status', async (_req, res) => {
  sendOk(res, await databaseService.getDatabaseStatus());
});

/** POST /api/database/test-connection - 测试任意目标库连通性（切换前的前置检查） */
router.post('/test-connection', validate({ body: testConnectionSchema }), async (req, res) => {
  const result = await databaseService.testConnection(validatedBody<TestConnectionInput>(req));
  sendOk(res, result, result.ok ? '连接成功' : '连接失败');
});

/** GET /api/database/backups - 备份列表 */
router.get('/backups', (_req, res) => {
  sendOk(res, databaseService.listBackups());
});

/** POST /api/database/backups - 立即创建一份手动备份 */
router.post('/backups', async (_req, res) => {
  sendCreated(res, await databaseService.createBackup('manual'), '备份已创建');
});

/** POST /api/database/backups/:name/restore - 从备份恢复（整库覆盖） */
router.post('/backups/:name/restore', validate({ params: backupNameParamSchema }), async (req, res) => {
  const { name } = validatedParams<{ name: string }>(req);
  sendOk(res, await databaseService.restoreBackup(name), '已从备份恢复');
});

/** DELETE /api/database/backups/:name - 删除备份 */
router.delete('/backups/:name', validate({ params: backupNameParamSchema }), async (req, res) => {
  const { name } = validatedParams<{ name: string }>(req);
  databaseService.deleteBackup(name);
  sendOk(res, { name }, '备份已删除');
});

/** GET /api/database/export - 下载当前库的 JSON 快照 */
router.get('/export', async (_req, res) => {
  const json = await databaseService.exportSnapshotJson();
  const filename = `classhelper-snapshot-${new Date().toISOString().slice(0, 19).replaceAll(':', '')}.json`;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.status(200).send(json);
});

/** GET /api/database/sqlite-file - 下载数据库文件（仅 SQLite 模式） */
router.get('/sqlite-file', (_req, res) => {
  const filePath = databaseService.sqliteFilePathForDownload();
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
  res.status(200).send(fs.readFileSync(filePath));
});

/** POST /api/database/import - 导入快照（整库覆盖；base64 随 JSON 请求体） */
router.post('/import', validate({ body: importSnapshotSchema }), async (req, res) => {
  const { data } = validatedBody<ImportSnapshotInput>(req);
  sendOk(res, await databaseService.importSnapshotBase64(data), '快照已导入（原数据已被覆盖）');
});

/** GET /api/database/backup-schedule - 定时备份配置 */
router.get('/backup-schedule', (_req, res) => {
  sendOk(res, databaseService.getBackupSchedule());
});

/** PUT /api/database/backup-schedule - 更新定时备份配置（立即生效，重启后仍有效） */
router.put('/backup-schedule', validate({ body: backupScheduleSchema }), async (req, res) => {
  sendOk(
    res,
    databaseService.saveSchedulePatch(validatedBody<BackupScheduleInput>(req)),
    '定时备份配置已保存',
  );
});

/** POST /api/database/switch - 一键切换数据库（异步任务，返回 jobId） */
router.post('/switch', validate({ body: switchDatabaseSchema }), async (req, res) => {
  const job = databaseService.startSwitch(validatedBody<SwitchDatabaseInput>(req));
  sendCreated(res, { jobId: job.id }, '切换任务已启动');
});

/** GET /api/database/switch/jobs/:id - 查询切换任务进度 */
router.get('/switch/jobs/:id', validate({ params: jobIdParamSchema }), async (req, res) => {
  const { id } = validatedParams<{ id: string }>(req);
  const job = databaseService.getSwitchJob(id);
  sendOk(res, job, job ? 'ok' : '任务不存在');
});

export const databaseModule = defineModule({
  name: 'database',
  basePath: '/database',
  router,
});
