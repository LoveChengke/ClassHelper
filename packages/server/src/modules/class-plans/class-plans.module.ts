import { importProfile } from './profile-import.service.js';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/db.js';
import { assertCanManageSchedule, assertClassAccess } from '../../lib/access.js';
import { sendOk, sendCreated, ApiError } from '../../lib/http.js';
import { idParamSchema } from '../../lib/schemas.js';
import { authenticate, getAuthUser, requirePermission } from '../../middleware/auth.js';
import { validate, validatedQuery } from '../../middleware/validate.js';
import { defineModule } from '../module.types.js';
import * as schemas from './class-plans.schemas.js';
import * as service from './class-plans.service.js';

const layouts = Router();
layouts.use(authenticate());
layouts.get('/', validate({ query: schemas.scopeQuery }), async (req, res) =>
  sendOk(res, await service.listLayouts(getAuthUser(req), validatedQuery<{ classId?: string }>(req).classId)),
);
layouts.post(
  '/',
  requirePermission('timetable:manage'),
  validate({ body: schemas.layoutSchema }),
  async (req, res) => sendCreated(res, await service.saveLayout(req.body)),
);
layouts.put(
  '/:id',
  requirePermission('timetable:manage'),
  validate({ params: idParamSchema, body: schemas.layoutSchema }),
  async (req, res) => sendOk(res, await service.saveLayout(req.body, String(req.params.id))),
);
layouts.post(
  '/:id/clone',
  requirePermission('timetable:manage'),
  validate({ params: idParamSchema, body: schemas.cloneSchema }),
  async (req, res) => {
    const current = (await service.listLayouts(getAuthUser(req))).find((p) => p.id === req.params.id);
    if (!current) throw ApiError.notFound('时间表不存在');
    sendCreated(
      res,
      await service.saveLayout({
        ...current,
        name: req.body.name || `${current.name} 副本`,
        points: current.points.map((p) => ({ ...p, id: undefined, timeType: p.timeType as 'LESSON' })),
      }),
    );
  },
);
layouts.post(
  '/:id/import',
  requirePermission('timetable:manage'),
  validate({ params: idParamSchema, body: schemas.importLayoutSchema }),
  async (req, res) => {
    const all = await service.listLayouts(getAuthUser(req));
    const target = all.find((p) => p.id === req.params.id),
      source = all.find((p) => p.id === req.body.sourceId);
    if (!target || !source) throw ApiError.notFound('时间表不存在');
    sendOk(
      res,
      await service.saveLayout(
        {
          ...target,
          points: source.points.map((p) => ({ ...p, id: undefined, timeType: p.timeType as 'LESSON' })),
        },
        target.id,
      ),
    );
  },
);
layouts.delete(
  '/:id',
  requirePermission('timetable:manage'),
  validate({ params: idParamSchema }),
  async (req, res) => {
    const id = String(req.params.id);
    if (await prisma.classPlan.count({ where: { timeLayoutId: id } }))
      throw ApiError.conflict('仍有课表使用该时间表');
    await prisma.timeLayout.delete({ where: { id } });
    await service.notifyScheduleChanged();
    sendOk(res, { id });
  },
);

const plans = Router();
plans.use(authenticate());
plans.post(
  '/import/profile',
  requirePermission('schedule:write'),
  validate({
    body: z.object({
      classId: z.string().min(1),
      payload: z.unknown(),
      mode: z.enum(['merge', 'replace']).default('merge'),
    }),
  }),
  async (req, res) =>
    sendCreated(
      res,
      await importProfile(getAuthUser(req), req.body.classId, req.body.payload, req.body.mode),
    ),
);
plans.get('/', validate({ query: schemas.scopeQuery }), async (req, res) => {
  const q = validatedQuery<{ classId?: string; week?: number }>(req);
  sendOk(res, await service.listPlans(getAuthUser(req), q.classId, q.week));
});
plans.post(
  '/',
  requirePermission('schedule:write'),
  validate({ body: schemas.planSchema }),
  async (req, res) => sendCreated(res, await service.savePlan(getAuthUser(req), req.body)),
);
plans.put(
  '/:id',
  requirePermission('schedule:write'),
  validate({ params: idParamSchema, body: schemas.planSchema }),
  async (req, res) => sendOk(res, await service.savePlan(getAuthUser(req), req.body, String(req.params.id))),
);
plans.patch(
  '/:id/enabled',
  requirePermission('schedule:write'),
  validate({ params: idParamSchema, body: z.object({ enabled: z.boolean() }) }),
  async (req, res) => {
    const p = await service.requirePlan(getAuthUser(req), String(req.params.id));
    sendOk(
      res,
      await prisma.classPlan.update({ where: { id: p.id }, data: { isEnabled: req.body.enabled } }),
    );
    await service.notifyScheduleChanged(p.classId);
  },
);
plans.put(
  '/:id/entries',
  requirePermission('schedule:write'),
  validate({ params: idParamSchema, body: schemas.entriesSchema }),
  async (req, res) =>
    sendOk(res, await service.saveEntries(getAuthUser(req), String(req.params.id), req.body)),
);
plans.post(
  '/:id/clone',
  requirePermission('schedule:write'),
  validate({ params: idParamSchema, body: schemas.cloneSchema }),
  async (req, res) =>
    sendCreated(res, await service.clonePlan(getAuthUser(req), String(req.params.id), req.body.name)),
);
plans.get('/:id/export', validate({ params: idParamSchema }), async (req, res) => {
  const p = await service.requirePlan(getAuthUser(req), String(req.params.id), false);
  sendOk(res, { format: 'classhelper-class-plan', plan: p, timeLayout: p.layout });
});
plans.post(
  '/import',
  requirePermission('schedule:write'),
  validate({ body: z.object({ plan: schemas.planSchema, entries: schemas.entriesSchema.shape.entries }) }),
  async (req, res) => {
    const p = await service.savePlan(getAuthUser(req), req.body.plan);
    sendCreated(res, await service.saveEntries(getAuthUser(req), p.id, { entries: req.body.entries }));
  },
);
plans.delete(
  '/:id',
  requirePermission('schedule:write'),
  validate({ params: idParamSchema }),
  async (req, res) => {
    const p = await service.requirePlan(getAuthUser(req), String(req.params.id));
    await prisma.classPlan.delete({ where: { id: p.id } });
    await service.notifyScheduleChanged(p.classId);
    sendOk(res, { id: p.id });
  },
);

const groups = Router();
groups.use(authenticate());
groups.get('/selection', validate({ query: z.object({ classId: z.string().min(1) }) }), async (req, res) => {
  const { classId } = validatedQuery<{ classId: string }>(req);
  await assertClassAccess(getAuthUser(req), classId);
  const value = await prisma.appSetting.findUnique({ where: { key: `schedule.group.${classId}` } });
  sendOk(res, value ? JSON.parse(value.value) : {});
});
groups.get('/', validate({ query: z.object({ classId: z.string().min(1) }) }), async (req, res) => {
  const { classId } = validatedQuery<{ classId: string }>(req);
  await assertClassAccess(getAuthUser(req), classId);
  sendOk(res, await prisma.classPlanGroup.findMany({ where: { classId } }));
});
groups.post(
  '/',
  requirePermission('schedule:write'),
  validate({ body: schemas.groupSchema }),
  async (req, res) => sendCreated(res, await service.saveGroup(getAuthUser(req), req.body)),
);
groups.put(
  '/:id',
  requirePermission('schedule:write'),
  validate({ params: idParamSchema, body: schemas.groupSchema }),
  async (req, res) => sendOk(res, await service.saveGroup(getAuthUser(req), req.body, String(req.params.id))),
);
groups.delete(
  '/:id',
  requirePermission('schedule:write'),
  validate({ params: idParamSchema }),
  async (req, res) => {
    const p = await prisma.classPlanGroup.findUnique({ where: { id: String(req.params.id) } });
    if (!p) throw ApiError.notFound('群组不存在');
    await assertCanManageSchedule(getAuthUser(req), p.classId);
    await prisma.classPlanGroup.delete({ where: { id: p.id } });
    await service.notifyScheduleChanged(p.classId);
    sendOk(res, { id: p.id });
  },
);
groups.post(
  '/select',
  requirePermission('schedule:write'),
  validate({ body: schemas.groupSelectionSchema }),
  async (req, res) => {
    const { classId, ...value } = schemas.groupSelectionSchema.parse(req.body);
    await assertCanManageSchedule(getAuthUser(req), classId);
    for (const id of [value.selected, value.temporary].filter(Boolean))
      if (!(await prisma.classPlanGroup.findFirst({ where: { id, classId } })))
        throw ApiError.badRequest('群组不属于本班');
    if (value.temporary && !value.expireTime) throw ApiError.badRequest('临时群组必须指定过期时间');
    await prisma.appSetting.upsert({
      where: { key: `schedule.group.${classId}` },
      create: { key: `schedule.group.${classId}`, value: JSON.stringify(value) },
      update: { value: JSON.stringify(value) },
    });
    await service.notifyScheduleChanged(classId);
    sendOk(res, value);
  },
);
export const timeLayoutsModule = defineModule({
  name: 'time-layouts',
  basePath: '/time-layouts',
  router: layouts,
});
export const classPlansModule = defineModule({
  name: 'class-plans',
  basePath: '/class-plans',
  router: plans,
});
export const classPlanGroupsModule = defineModule({
  name: 'class-plan-groups',
  basePath: '/class-plan-groups',
  router: groups,
});
