import { dayKeyLocal } from '@classhelper/shared';
import { prisma } from './db.js';

/** 旧叫人通知没有所属日期；用服务进程的本地日期口径幂等回填，兼容 SQLite 与 MySQL。 */
export async function backfillNotificationDates(): Promise<number> {
  let updated = 0;
  for (;;) {
    const rows = await prisma.notification.findMany({
      where: { assignDate: '' },
      select: { id: true, createdAt: true },
      take: 200,
    });
    if (!rows.length) return updated;
    await prisma.$transaction(
      rows.map((row) =>
        prisma.notification.update({
          where: { id: row.id },
          data: { assignDate: dayKeyLocal(row.createdAt) },
        }),
      ),
    );
    updated += rows.length;
  }
}
