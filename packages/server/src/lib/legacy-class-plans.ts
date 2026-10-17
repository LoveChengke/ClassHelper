import { prisma } from './db.js';

/** 种子初始化时将旧行物化到按周展开的完整日课表，保留周次范围，最多 60 周，绝不改原表作迁移来源。 */
export async function syncLegacyClassPlans(classId: string) {
  await prisma.$transaction(
    async (tx) => {
      const rows = await tx.schedule.findMany({ where: { classId }, orderBy: { createdAt: 'asc' } });
      await tx.classPlan.deleteMany({ where: { classId, id: { startsWith: `legacy-plan-${classId}-` } } });
      for (const row of rows) {
        const key = 'schedule.compat.' + row.id,
          value = JSON.stringify({
            weekStart: row.weekStart,
            weekEnd: row.weekEnd,
            weekParity: row.weekParity,
          });
        await tx.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
      }
      const days = [...new Set(rows.map((r) => r.dayOfWeek))];
      for (const day of days) {
        const layoutId = `legacy-layout-${classId}-${day}`;
        await tx.timeLayout.upsert({
          where: { id: layoutId },
          create: { id: layoutId, classId, name: `兼容作息 ${day}`, source: 'manual' },
          update: {},
        });
        const points = new Map<string, string>();
        for (const row of rows.filter((r) => r.dayOfWeek === day)) {
          const key = `${row.startTime}-${row.endTime}`;
          if (points.has(key)) continue;
          const id = `${layoutId}-${key}`;
          points.set(key, id);
          await tx.timeLayoutItem.upsert({
            where: { id },
            create: {
              id,
              timeLayoutId: layoutId,
              position: points.size,
              startTime: row.startTime,
              endTime: row.endTime,
            },
            update: {},
          });
        }
        for (let week = 1; week <= 60; week++) {
          const active = rows.filter(
            (r) =>
              r.dayOfWeek === day &&
              r.weekStart <= week &&
              r.weekEnd >= week &&
              (r.weekParity === 'ALL' || r.weekParity === (week % 2 ? 'ODD' : 'EVEN')),
          );
          if (!active.length) continue;
          const occupied = new Set<string>();
          await tx.classPlan.create({
            data: {
              id: `legacy-plan-${classId}-${day}-${week}`,
              classId,
              name: `兼容第 ${week} 周星期 ${day}`,
              timeLayoutId: layoutId,
              weekday: day,
              weekStart: week,
              weekEnd: week,
              entries: {
                create: active
                  .filter((r) => {
                    const point = points.get(`${r.startTime}-${r.endTime}`)!;
                    if (occupied.has(point)) return false;
                    occupied.add(point);
                    return true;
                  })
                  .map((r) => ({
                    courseId: r.courseId,
                    timeLayoutItemId: points.get(`${r.startTime}-${r.endTime}`)!,
                    legacyScheduleId: r.id,
                    location: r.location,
                  })),
              },
            },
          });
        }
      }
    },
    { timeout: 30000 },
  );
}
