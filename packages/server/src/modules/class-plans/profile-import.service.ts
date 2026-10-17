import { createHash } from 'node:crypto';
import { z } from 'zod';
import { isDayKey, dayKeyLocal } from '@classhelper/shared';
import { prisma } from '../../lib/db.js';
import { assertCanManageSchedule } from '../../lib/access.js';
import { ApiError } from '../../lib/http.js';
import type { TokenPayload } from '../../lib/jwt.js';
import { notifyScheduleChanged } from './class-plans.service.js';
const record = z.record(z.string(), z.unknown());
function object(value: unknown): Record<string, unknown> {
  const parsed = record.safeParse(value);
  return parsed.success ? parsed.data : {};
}
function time(value: unknown) {
  const match = String(value ?? '').match(/(?:^|T)(\d{1,2}):(\d{2})/);
  if (!match) throw ApiError.badRequest('时间点缺少合法起止时间');
  const result = `${match[1]!.padStart(2, '0')}:${match[2]}`;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(result)) throw ApiError.badRequest('时间不合法');
  return result;
}
/** 直接保留上游三元组/四种时间点/显式课程位置，绝不经过单双周的有损中间格式。 */
export async function importProfile(user: TokenPayload, classId: string, payload: unknown, mode = 'merge') {
  await assertCanManageSchedule(user, classId);
  let parsed = payload;
  if (typeof payload === 'string') {
    try {
      parsed = JSON.parse(payload);
    } catch {
      throw ApiError.badRequest('JSON 格式不正确');
    }
  }
  const root = object(parsed),
    layouts = object(root.TimeLayouts),
    plans = object(root.ClassPlans),
    subjects = object(root.Subjects),
    groups = object(root.ClassPlanGroups);
  if (!Object.keys(layouts).length || !Object.keys(plans).length)
    throw ApiError.badRequest('需要包含 TimeLayouts 与 ClassPlans 的 ClassIsland JSON');
  if (Object.keys(plans).length > 500 || Object.keys(layouts).length > 100)
    throw ApiError.badRequest('导入课表过多');
  const cls = await prisma.class.findUniqueOrThrow({ where: { id: classId } });
  const warnings: string[] = [];
  const stable = (kind: string, id: string) =>
    `profile-${kind}-${createHash('sha256')
      .update(classId + '|' + id)
      .digest('hex')
      .slice(0, 32)}`;
  const result = await prisma.$transaction(
    async (tx) => {
      const courses = new Map<string, string>();
      const createdCourses: string[] = [];
      for (const [id, value] of Object.entries(subjects)) {
        const subject = object(value),
          name = String(subject.Name || '')
            .trim()
            .slice(0, 64);
        if (!name) continue;
        let course = await tx.course.findUnique({ where: { classId_name: { classId, name } } });
        if (!course) {
          if (!cls.teacherId) throw ApiError.badRequest('请先为新班指定班主任或建立科目任课关系');
          course = await tx.course.create({
            data: {
              classId,
              name,
              teacherId: cls.teacherId,
              initial: String(subject.Initial || Array.from(name)[0] || '').slice(0, 8),
              isOutDoor: subject.IsOutDoor === true,
            },
          });
          createdCourses.push(name);
        } else if (subject.Initial !== undefined || subject.IsOutDoor !== undefined)
          course = await tx.course.update({
            where: { id: course.id },
            data: {
              ...(subject.Initial !== undefined
                ? { initial: String(subject.Initial || Array.from(name)[0] || '').slice(0, 8) }
                : {}),
              ...(subject.IsOutDoor !== undefined ? { isOutDoor: subject.IsOutDoor === true } : {}),
            },
          });
        courses.set(id, course.id);
      }
      const groupIds = new Map<string, string>();
      for (const [id, value] of Object.entries(groups)) {
        const g = object(value);
        const data = {
          classId,
          name: String(g.Name || '导入群组').slice(0, 64),
          isGlobal: g.IsGlobal === true,
          isDefault: id === root.SelectedClassPlanGroupId,
        };
        const created = await tx.classPlanGroup.upsert({
          where: { id: stable('group', id) },
          create: { id: stable('group', id), ...data },
          update: data,
        });
        groupIds.set(id, created.id);
      }
      if (mode === 'replace') {
        await tx.scheduledClassPlan.deleteMany({ where: { classId } });
        await tx.classPlan.deleteMany({ where: { classId } });
      }
      const layoutIds = new Map<string, { id: string; lessons: string[] }>();
      for (const [id, value] of Object.entries(layouts)) {
        const l = object(value),
          points = Array.isArray(l.Layouts) ? l.Layouts : [];
        if (points.length > 100) throw ApiError.badRequest('每份时间表最多100个时间点');
        const data = {
          classId,
          name: String(l.Name || '导入时间表').slice(0, 64),
          source: 'classisland',
          isOverlay: l.IsOverlay === true,
        };
        const created = await tx.timeLayout.upsert({
          where: { id: stable('layout', id) },
          create: { id: stable('layout', id), ...data },
          update: data,
        });
        const lessons: string[] = [],
          pointIds: string[] = [];
        for (const [position, value] of points.entries()) {
          const p = object(value),
            timeType = (['LESSON', 'BREAK', 'DIVIDER', 'ACTION'] as const)[Number(p.TimeType || 0)];
          if (!timeType) throw ApiError.badRequest('未知时间点类型');
          const startTime = time(p.StartTime),
            endTime = time(p.EndTime);
          if (timeType !== 'DIVIDER' && startTime >= endTime)
            throw ApiError.badRequest('时间点结束必须晚于开始');
          const pointData = {
            timeLayoutId: created.id,
            position,
            name: String(p.Name || '').slice(0, 64),
            startTime,
            endTime,
            timeType,
            isHideDefault: p.IsHideDefault === true,
            defaultClassId: courses.get(String(p.DefaultClassId)) || null,
            breakName: String(p.BreakNameText || p.BreakName || '').slice(0, 64),
            actionSet: JSON.stringify(p.ActionSet || {}),
          };
          const point = await tx.timeLayoutItem.upsert({
            where: { id: stable('point', id + '|' + position) },
            create: { id: stable('point', id + '|' + position), ...pointData },
            update: pointData,
          });
          pointIds.push(point.id);
          if (timeType === 'LESSON') lessons.push(point.id);
        }
        await tx.timeLayoutItem.deleteMany({ where: { timeLayoutId: created.id, id: { notIn: pointIds } } });
        layoutIds.set(id, { id: created.id, lessons });
      }
      for (const [id, value] of Object.entries(layouts)) {
        const source = layoutIds.get(String(object(value).OverlaySourceId)),
          target = layoutIds.get(id);
        if (source && target)
          await tx.timeLayout.update({ where: { id: target.id }, data: { overlaySourceId: source.id } });
      }
      const planIds = new Map<string, string>();
      let created = 0,
        updated = 0;
      for (const [id, value] of Object.entries(plans)) {
        const p = object(value),
          rule = object(p.TimeRule),
          layout = layoutIds.get(String(p.TimeLayoutId));
        if (!layout) {
          warnings.push(`课表 ${p.Name} 的时间表不存在，已跳过`);
          continue;
        }
        const weekday = Number(rule.WeekDay || 0),
          weekCountDiv = Number(rule.WeekCountDiv || 0),
          weekCountDivTotal = Number(rule.WeekCountDivTotal || 2);
        if (
          !Number.isInteger(weekday) ||
          weekday < 0 ||
          weekday > 7 ||
          !Number.isInteger(weekCountDiv) ||
          weekCountDiv < 0 ||
          weekCountDiv > 9 ||
          !Number.isInteger(weekCountDivTotal) ||
          weekCountDivTotal < 1 ||
          weekCountDivTotal > 9 ||
          weekCountDiv > weekCountDivTotal
        )
          throw ApiError.badRequest('导入启用规则不合法（支持1–9周轮换）');
        const previous = await tx.classPlan.findUnique({ where: { id: stable('plan', id) } });
        const data = {
          classId,
          name: String(p.Name || '导入课表').slice(0, 64),
          timeLayoutId: layout.id,
          associatedGroup: groupIds.get(String(p.AssociatedGroup)) || null,
          weekday,
          weekCountDiv,
          weekCountDivTotal,
          isEnabled: p.IsEnabled !== false,
          isOverlay: p.IsOverlay === true,
        };
        const plan = await tx.classPlan.upsert({
          where: { id: stable('plan', id) },
          create: { id: stable('plan', id), ...data },
          update: data,
        });
        planIds.set(id, plan.id);
        if (previous) updated += layout.lessons.length;
        else created += layout.lessons.length;
        await tx.classPlanEntry.deleteMany({ where: { classPlanId: plan.id } });
        const entries = Array.isArray(p.Classes) ? p.Classes : [];
        for (const [index, pointId] of layout.lessons.entries()) {
          const entry = object(entries[index]);
          await tx.classPlanEntry.create({
            data: {
              classPlanId: plan.id,
              timeLayoutItemId: pointId,
              courseId: entry.IsEmpty === true ? null : courses.get(String(entry.SubjectId)) || null,
              isEnabled: entry.IsEnabled !== false,
              isChangedClass: entry.IsChangedClass === true,
            },
          });
        }
      }
      for (const [id, value] of Object.entries(plans)) {
        const p = object(value),
          planId = planIds.get(id),
          sourceId = planIds.get(String(p.OverlaySourceId));
        if (planId && sourceId)
          await tx.classPlan.update({ where: { id: planId }, data: { overlaySourceId: sourceId } });
      }
      for (const [dateKey, value] of Object.entries(object(root.OrderedSchedules))) {
        const date = isDayKey(dateKey) ? dateKey : dayKeyLocal(new Date(dateKey)),
          planId = planIds.get(String(object(value).ClassPlanId));
        if (date && isDayKey(date) && planId)
          await tx.scheduledClassPlan.upsert({
            where: { classId_date: { classId, date } },
            create: { classId, date, classPlanId: planId },
            update: { classPlanId: planId },
          });
      }
      const dateOf = (value: unknown) => {
        const parsed = new Date(String(value || ''));
        return Number.isNaN(parsed.getTime()) ? dayKeyLocal(new Date()) : dayKeyLocal(parsed);
      };
      const overlayId = planIds.get(String(root.OverlayClassPlanId));
      if (root.IsOverlayClassPlanEnabled === true && overlayId)
        await tx.classPlan.update({
          where: { id: overlayId },
          data: { isOverlay: true, isEnabled: true, overlayDate: dateOf(root.TempClassPlanSetupTime) },
        });
      const temporaryPlan = planIds.get(String(root.TempClassPlanId)),
        selected = groupIds.get(String(root.SelectedClassPlanGroupId)),
        temporary =
          root.IsTempClassPlanGroupEnabled === true
            ? groupIds.get(String(root.TempClassPlanGroupId))
            : undefined;
      if (temporaryPlan || selected || temporary) {
        const key = `schedule.group.${classId}`,
          value = JSON.stringify({
            selected,
            temporary,
            expireTime: root.TempClassPlanGroupExpireTime,
            temporaryPlan,
            temporaryPlanDate: temporaryPlan ? dateOf(root.TempClassPlanSetupTime) : undefined,
          });
        await tx.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
      }
      return {
        imported: created + updated,
        created,
        updated,
        createdCourses,
        weekStart: 1,
        weekEnd: cls.termWeeks,
      };
    },
    { timeout: 30000 },
  );
  await notifyScheduleChanged(classId);
  return { ...result, warnings };
}
