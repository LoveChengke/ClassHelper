import {
  SOCKET_EVENTS,
  buildScheduleWeekView,
  type ScheduleDto,
  type ScheduleWeekView,
} from '@classhelper/shared';
import { assertClassWritable, classScopeWhere, resolveClassScope } from '../../lib/access.js';
import { prisma } from '../../lib/db.js';
import { ApiError } from '../../lib/http.js';
import type { TokenPayload } from '../../lib/jwt.js';
import { toScheduleDto } from '../../lib/mappers.js';
import { resolveCurrentWeek } from '../../lib/term.js';
import { emitToClass } from '../../realtime/bus.js';
import type { CreateScheduleInput, UpdateScheduleInput } from './schedules.schemas.js';

const courseSelect = { select: { id: true, name: true } } as const;

export interface ListScheduleOptions {
  classId?: string;
  week?: number;
  dayOfWeek?: number;
}

/** 课表列表：按班级权限过滤，week 过滤 weekStart <= week <= weekEnd */
export async function listSchedules(
  user: TokenPayload,
  options: ListScheduleOptions,
): Promise<ScheduleDto[]> {
  const scope = await resolveClassScope(user, options.classId);
  const week = options.week;

  const schedules = await prisma.schedule.findMany({
    where: {
      ...classScopeWhere(scope),
      ...(week ? { weekStart: { lte: week }, weekEnd: { gte: week } } : {}),
      ...(options.dayOfWeek ? { dayOfWeek: options.dayOfWeek } : {}),
    },
    include: { course: courseSelect },
    orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
  });

  return schedules.map(toScheduleDto);
}

/** 周视图：7 列固定结构，供 Web / EXE 直接渲染 */
export async function getScheduleGrid(
  user: TokenPayload,
  options: { classId?: string; week?: number },
): Promise<ScheduleWeekView> {
  const week = options.week ?? resolveCurrentWeek();
  const items = await listSchedules(user, { classId: options.classId, week });
  return buildScheduleWeekView(items, week);
}

export async function createSchedule(user: TokenPayload, input: CreateScheduleInput): Promise<ScheduleDto> {
  await assertClassWritable(user, input.classId);
  await assertCourseInClass(input.courseId, input.classId);

  const created = await prisma.schedule.create({
    data: {
      classId: input.classId,
      courseId: input.courseId,
      dayOfWeek: input.dayOfWeek,
      startTime: input.startTime,
      endTime: input.endTime,
      location: input.location ?? null,
      weekStart: input.weekStart ?? 1,
      weekEnd: input.weekEnd ?? 20,
    },
    include: { course: courseSelect },
  });

  const dto = toScheduleDto(created);
  emitToClass(created.classId, SOCKET_EVENTS.scheduleUpdated, {
    classId: created.classId,
    action: 'created',
    schedule: dto,
  });
  return dto;
}

export async function updateSchedule(
  user: TokenPayload,
  scheduleId: string,
  input: UpdateScheduleInput,
): Promise<ScheduleDto> {
  const current = await prisma.schedule.findUnique({ where: { id: scheduleId } });
  if (!current) throw ApiError.notFound('课表记录不存在');
  await assertClassWritable(user, current.classId);

  if (input.courseId) await assertCourseInClass(input.courseId, current.classId);

  const startTime = input.startTime ?? current.startTime;
  const endTime = input.endTime ?? current.endTime;
  if (startTime >= endTime) throw ApiError.badRequest('结束时间必须晚于开始时间');

  const weekStart = input.weekStart ?? current.weekStart;
  const weekEnd = input.weekEnd ?? current.weekEnd;
  if (weekStart > weekEnd) throw ApiError.badRequest('起始周次不能大于结束周次');

  const updated = await prisma.schedule.update({
    where: { id: scheduleId },
    data: {
      ...(input.courseId ? { courseId: input.courseId } : {}),
      ...(input.dayOfWeek ? { dayOfWeek: input.dayOfWeek } : {}),
      startTime,
      endTime,
      ...(input.location !== undefined ? { location: input.location ?? null } : {}),
      weekStart,
      weekEnd,
    },
    include: { course: courseSelect },
  });

  const dto = toScheduleDto(updated);
  emitToClass(updated.classId, SOCKET_EVENTS.scheduleUpdated, {
    classId: updated.classId,
    action: 'updated',
    schedule: dto,
  });
  return dto;
}

export async function deleteSchedule(user: TokenPayload, scheduleId: string): Promise<void> {
  const current = await prisma.schedule.findUnique({ where: { id: scheduleId } });
  if (!current) throw ApiError.notFound('课表记录不存在');
  await assertClassWritable(user, current.classId);

  await prisma.schedule.delete({ where: { id: scheduleId } });
  emitToClass(current.classId, SOCKET_EVENTS.scheduleUpdated, {
    classId: current.classId,
    action: 'deleted',
  });
}

/** 校验课程确实属于该班级，避免把 A 班课程排进 B 班课表 */
async function assertCourseInClass(courseId: string, classId: string): Promise<void> {
  const course = await prisma.course.findUnique({ where: { id: courseId }, select: { classId: true } });
  if (!course) throw ApiError.badRequest('课程不存在');
  if (course.classId !== classId) throw ApiError.badRequest('该课程不属于所选班级');
}
