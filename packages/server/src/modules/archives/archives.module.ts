import { Router } from 'express';
import { sendCreated, sendOk } from '../../lib/http.js';
import { idParamSchema } from '../../lib/schemas.js';
import { authenticate, getAuthUser, requireRole } from '../../middleware/auth.js';
import { validate, validatedBody, validatedParams, validatedQuery } from '../../middleware/validate.js';
import { defineModule } from '../module.types.js';
import {
  archiveClassParamSchema,
  archivedContentQuerySchema,
  createArchiveSchema,
  listArchivesQuerySchema,
  suggestedEnrollmentYears,
} from './archives.schemas.js';
import * as archiveService from './archives.service.js';

const router = Router();
router.use(authenticate());

/**
 * 毕业归档（**全部接口仅管理员**）。
 *
 * 归档是**打标记 + 只读**：毕业班级的作业与通知原样留在库里，
 * 通过 `GET /:id/classes/:classId/content` 只读查看。
 * 「未毕业而升级的班级不归档」—— 升级走 `POST /api/classes/promote`，只改年级。
 */

/** GET /api/archives - 届别列表 */
router.get('/', requireRole('ADMIN'), validate({ query: listArchivesQuerySchema }), async (req, res) => {
  const user = getAuthUser(req);
  sendOk(res, await archiveService.listArchivedYears(user), '获取届别列表成功');
});

/** GET /api/archives/summary - 归档页顶部汇总 + 可归档的届别建议 */
router.get('/summary', requireRole('ADMIN'), async (req, res) => {
  sendOk(
    res,
    {
      ...(await archiveService.getArchiveSummary()),
      suggestedEnrollmentYears: suggestedEnrollmentYears(),
    },
    '获取归档汇总成功',
  );
});

/** GET /api/archives/:id - 某届详情（班级 + 毕业生 + 转出的学生） */
router.get('/:id', requireRole('ADMIN'), validate({ params: idParamSchema }), async (req, res) => {
  const user = getAuthUser(req);
  const { id } = validatedParams<{ id: string }>(req);
  sendOk(res, await archiveService.getArchivedYearDetail(user, id), '获取届别详情成功');
});

/** GET /api/archives/:id/classes/:classId/content - 归档班级的作业与通知（只读） */
router.get(
  '/:id/classes/:classId/content',
  requireRole('ADMIN'),
  validate({ params: archiveClassParamSchema, query: archivedContentQuerySchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const { id, classId } = validatedParams<{ id: string; classId: string }>(req);
    const { limit } = validatedQuery<{ limit?: number }>(req);
    sendOk(
      res,
      await archiveService.getArchivedClassContent(user, id, classId, limit ?? 200),
      '获取归档班级内容成功',
    );
  },
);

/** POST /api/archives - 执行毕业归档（按届别整届归档） */
router.post('/', requireRole('ADMIN'), validate({ body: createArchiveSchema }), async (req, res) => {
  const user = getAuthUser(req);
  const result = await archiveService.createArchive(user, validatedBody(req));
  sendCreated(res, result, `${result.name} 已归档，共 ${result.classCount} 个班级`);
});

/** DELETE /api/archives/:id - 撤销归档（管理员误操作的退路，不删任何数据） */
router.delete('/:id', requireRole('ADMIN'), validate({ params: idParamSchema }), async (req, res) => {
  const user = getAuthUser(req);
  const { id } = validatedParams<{ id: string }>(req);
  await archiveService.deleteArchive(user, id);
  sendOk(res, { id }, '已撤销归档，班级与学生回到在读状态');
});

export const archivesModule = defineModule({
  name: 'archives',
  basePath: '/archives',
  router,
});
