import { prisma } from '../../lib/db.js';
import { logger } from '../../lib/logger.js';
import { weekParityFromDiv } from '@classhelper/shared';
import type { ReportScheduleEntry, ReportTimeLayoutItem } from './integrations.schemas.js';

/**
 * 插件上报的课表 / 节次时间 → 写入本服务。
 *
 * 设计要点：
 * 1) **复用导入模块的口径**：与 `modules/imports/class-plan.service.ts`、
 *    `time-layout.service.ts` 完全一致 —— 缺失的科目自动补建课程（任课老师取班主任）、
 *    merge 按 `星期 + 开始时间 + 单双周` 去重、replace 先清空再写入。
 *    这样"插件实时上报"和"手动导入 JSON"落到库里的结果是一样的，不会出现两套语义。
 * 2) **幂等**：插件每次上报（启动、课表变化、定时）都会带全量课表，
 *    因此 merge 必须是"存在则更新、不存在则新增"，重复上报不会产生重复行。
 * 3) 整个写入放在一个事务里：解析/校验失败的批次不会留下半截数据。
 */

export interface ScheduleWriteResult {
  applied: boolean;
  created: number;
  updated: number;
  courses: string[];
  weekStart: number;
  weekEnd: number;
}

/** 单双周口径：优先用插件显式给的 weekParity，否则从 WeekCountDiv/Total 推导 */
function resolveParity(entry: ReportScheduleEntry): 'ALL' | 'ODD' | 'EVEN' {
  if (entry.weekParity === 'ALL' || entry.weekParity === 'ODD' || entry.weekParity === 'EVEN') {
    return entry.weekParity;
  }
  const { weekCountDiv = 0, weekCountDivTotal = 0 } = entry;
  return weekParityFromDiv(weekCountDiv, weekCountDivTotal);
}

/**
 * 写入课表。classId 由**设备令牌**决定（不接受插件指定），因此插件无法越权写别的班级。
 */
export async function applyReportedSchedule(
  classId: string,
  mode: 'replace' | 'merge',
  entries: ReportScheduleEntry[],
): Promise<ScheduleWriteResult> {
  const empty: ScheduleWriteResult = {
    applied: false,
    created: 0,
    updated: 0,
    courses: [],
    weekStart: 1,
    weekEnd: 20,
  };
  if (entries.length === 0) return empty;

  const classRecord = await prisma.class.findUnique({
    where: { id: classId },
    select: { id: true, teacherId: true, termWeeks: true },
  });
  if (!classRecord) {
    logger.warn(`ClassIsland 上报：班级不存在，已丢弃本批课表（classId=${classId}）`);
    return empty;
  }

  // 起止周次：与导入模块保持一致（weekStart 由班级进度决定，weekEnd 取班级教学周数）
  const weekStart = 1;
  const weekEnd = classRecord.termWeeks > 0 ? classRecord.termWeeks : 20;

  const result = await prisma.$transaction(async (tx) => {
    // 1) 补齐缺失的课程（任课老师先用班主任占位，老师可在课表管理里改）
    const existingCourses = await tx.course.findMany({
      where: { classId },
      select: { id: true, name: true },
    });
    const courseIdByName = new Map(existingCourses.map((item) => [item.name, item.id]));
    const createdCourses: string[] = [];
    for (const name of new Set(entries.map((item) => item.subject))) {
      if (courseIdByName.has(name)) continue;
      const created = await tx.course.create({
        data: { classId, name, teacherId: classRecord.teacherId },
        select: { id: true, name: true },
      });
      courseIdByName.set(created.name, created.id);
      createdCourses.push(created.name);
    }

    // 2) replace：先清空该班课表（与导入模块的 replace 语义一致）
    if (mode === 'replace') {
      await tx.schedule.deleteMany({ where: { classId } });
    }

    // 3) 逐条 upsert：merge 的去重键是「星期 + 开始时间 + 单双周」
    let created = 0;
    let updated = 0;
    for (const entry of entries) {
      const courseId = courseIdByName.get(entry.subject);
      if (!courseId) continue;
      const weekParity = resolveParity(entry);
      const existing = await tx.schedule.findFirst({
        where: { classId, dayOfWeek: entry.dayOfWeek, startTime: entry.startTime, weekParity },
        select: { id: true },
      });
      if (existing) {
        await tx.schedule.update({
          where: { id: existing.id },
          data: { courseId, endTime: entry.endTime, weekStart, weekEnd },
        });
        updated += 1;
      } else {
        await tx.schedule.create({
          data: {
            classId,
            courseId,
            dayOfWeek: entry.dayOfWeek,
            startTime: entry.startTime,
            endTime: entry.endTime,
            location: null,
            weekStart,
            weekEnd,
            weekParity,
          },
        });
        created += 1;
      }
    }
    return { created, updated, createdCourses, allCourses: [...courseIdByName.keys()] };
  });

  logger.info(
    `ClassIsland 上报课表：班级=${classId} 模式=${mode} 新增=${result.created} 更新=${result.updated} ` +
      `补建科目=[${result.createdCourses.join(',')}]`,
  );
  return {
    applied: true,
    created: result.created,
    updated: result.updated,
    courses: result.allCourses,
    weekStart,
    weekEnd,
  };
}

/**
 * 写入节次时间表（TimeLayout）。
 * 与 `modules/imports/time-layout.service.ts` 的口径保持一致：
 * 同一班级同名配置整体替换；没有则新建。
 * 注意：`action`（ClassIsland TimeType=3，行动）在本系统里没有对应节次类型，
 * 写入时降级为 `divider`（不占课时，只做视觉分隔），避免类型校验失败。
 */
export async function applyReportedTimeLayout(
  classId: string,
  name: string,
  items: ReportTimeLayoutItem[],
): Promise<{ applied: boolean; count: number }> {
  if (items.length === 0) return { applied: false, count: 0 };

  const normalized = items.map((item, index) => ({
    index: item.index && item.index > 0 ? item.index : index + 1,
    name: item.name?.trim() || `第 ${index + 1} 节`,
    startTime: item.startTime,
    endTime: item.endTime,
    type: item.type === 'action' ? 'divider' : (item.type ?? 'class'),
    skipped: item.skipped === true,
  }));

  const current = await prisma.timeLayout.findFirst({
    where: { classId, name },
    orderBy: { updatedAt: 'desc' },
    select: { id: true },
  });

  if (current) {
    await prisma.timeLayout.update({
      where: { id: current.id },
      data: { items: JSON.stringify(normalized), source: 'classisland' },
    });
  } else {
    await prisma.timeLayout.create({
      data: { classId, name, source: 'classisland', items: JSON.stringify(normalized) },
    });
  }

  logger.info(`ClassIsland 上报节次时间表：班级=${classId} 名称=${name} 共 ${normalized.length} 节`);
  return { applied: true, count: normalized.length };
}

/**
 * 把本服务的课表转换成 ClassIsland 的档案口径（供插件拉回去镜像）。
 *
 * 关键换算：
 * - 星期：本系统 1=周一…7=周日 → ClassIsland 0=周日、1=周一…6=周六；
 * - 节次：ClassIsland 的 Classes[i] 对应 Layouts 里第 i 个 TimeType=0（上课）的点，
 *   因此这里必须**按节次顺序**生成 layouts，并把每个 Schedule 归到"开始时间最接近且不晚于它"的节次上；
 * - 单双周：ALL→(0,0)；ODD→(1,2)；EVEN→(2,2)，与导入模块的解析互逆。
 */
export interface MirrorClassPlan {
  entries: {
    weekDay: number;
    weekCountDiv: number;
    weekCountDivTotal: number;
    subject: string;
    teacherName: string | null;
    /**
     * 该课目的起止时间（HH:mm）。插件靠它重建 ClassIsland 的时间表：
     * `ClassPlan.Classes[i]` 必须与时间表里第 i 个上课点一一对应，缺了时间就整份错位。
     */
    startTime: string;
    endTime: string;
    timeLayoutId: string;
  }[];
  timeLayouts: {
    id: string;
    name: string;
    layouts: { startTime: string; endTime: string; timeType: number }[];
  }[];
  profileName: string;
  termStartDate: string;
}

/** 本系统 dayOfWeek（1=周一…7=周日）→ ClassIsland WeekDay（0=周日…6=周六） */
export function toClassIslandWeekDay(dayOfWeek: number): number {
  return dayOfWeek % 7;
}
