import type { Prisma } from '../../generated/prisma/client.js';
export async function fillLayoutBreaks(tx: Prisma.TransactionClient, id: string) {
  await tx.timeLayoutItem.deleteMany({ where: { timeLayoutId: id, isAutoBreak: true } });
  const points = await tx.timeLayoutItem.findMany({
    where: { timeLayoutId: id },
    orderBy: [{ startTime: 'asc' }, { position: 'asc' }],
  });
  const lessons = points.filter((p) => p.timeType === 'LESSON');
  for (let i = 0; i < lessons.length; i++)
    if (!lessons[i]!.slotKey)
      await tx.timeLayoutItem.update({ where: { id: lessons[i]!.id }, data: { slotKey: `lesson-${i + 1}` } });
  for (let i = 1; i < lessons.length; i++) {
    const left = lessons[i - 1]!,
      right = lessons[i]!;
    let cursor = left.endTime;
    for (const occupied of points
      .filter((p) => p.timeType !== 'DIVIDER' && p.startTime < right.startTime && p.endTime > left.endTime)
      .sort((a, b) => a.startTime.localeCompare(b.startTime))) {
      const end = occupied.startTime < right.startTime ? occupied.startTime : right.startTime;
      if (cursor < end) await add(cursor, end, i);
      if (occupied.endTime > cursor) cursor = occupied.endTime;
    }
    if (cursor < right.startTime) await add(cursor, right.startTime, i);
  }
  async function add(startTime: string, endTime: string, index: number) {
    await tx.timeLayoutItem.create({
      data: {
        timeLayoutId: id,
        position: index * 2 - 1,
        startTime,
        endTime,
        timeType: 'BREAK',
        breakName: '课间休息',
        isAutoBreak: true,
        slotKey: `break-${index}-${startTime}`,
      },
    });
  }
  const ordered = await tx.timeLayoutItem.findMany({
    where: { timeLayoutId: id },
    orderBy: [{ startTime: 'asc' }, { position: 'asc' }],
  });
  for (const [position, p] of ordered.entries())
    await tx.timeLayoutItem.update({ where: { id: p.id }, data: { position } });
}
