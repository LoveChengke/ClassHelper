import {
  SOCKET_EVENTS,
  type ArchivedClassContentDto,
  type ArchivedYearDetailDto,
  type ArchivedYearDto,
} from '@classhelper/shared';
import { assertGlobalPermission } from '../../lib/access.js';
import { prisma } from '../../lib/db.js';
import { ApiError } from '../../lib/http.js';
import type { TokenPayload } from '../../lib/jwt.js';
import {
  toArchivedClassDto,
  toArchivedYearDto,
  toHomeworkDto,
  toNotificationDto,
  toStudentDto,
} from '../../lib/mappers.js';
import { emitToClass } from '../../realtime/bus.js';
import { logger } from '../../lib/logger.js';

/**
 * 毕业归档。
 *
 * **归档 = 打标记 + 只读，不删任何数据**：
 * - `ArchivedYear` 是一届的档案（入学年份、毕业年份、归档时的统计快照）；
 * - `Class.archivedYearId` / `Student.archivedYearId` 指向它，常规列表据此过滤掉归档项；
 * - 毕业班级发过的作业与通知**原样留在库里**，通过归档详情只读查看
 *   —— 「记录每个年度毕业班级的消息和作业」就是这么满足的。
 *
 * **未毕业而升级的班级不归档**：升级只改 `Class.grade`（高一 → 高二），
 * 班级记录、学生名单、学号、作业成绩全部沿用（见 `classes.service.promoteClasses`）。
 *
 * 全部接口受 archive:manage 与全校范围保护。
 */

/** 届别列表（按入学年份倒序） */
export async function listArchivedYears(user: TokenPayload): Promise<ArchivedYearDto[]> {
  await assertGlobalPermission(user, 'archive:manage');
  const records = await prisma.archivedYear.findMany({ orderBy: { enrollmentYear: 'desc' } });
  return records.map(toArchivedYearDto);
}

/** 某届的详情：班级 + 毕业生 + 转出的学生 */
export async function getArchivedYearDetail(
  user: TokenPayload,
  archiveId: string,
): Promise<ArchivedYearDetailDto> {
  await assertGlobalPermission(user, 'archive:manage');
  const record = await prisma.archivedYear.findUnique({ where: { id: archiveId } });
  if (!record) throw ApiError.notFound('该届别档案不存在');

  const [classes, students] = await Promise.all([
    prisma.class.findMany({
      where: { archivedYearId: archiveId },
      orderBy: { classIndex: 'asc' },
      include: {
        teacher: { select: { name: true } },
        _count: { select: { students: true, homeworks: true, notifications: true } },
      },
    }),
    prisma.student.findMany({
      where: { archivedYearId: archiveId },
      orderBy: [{ status: 'asc' }, { studentNo: 'asc' }],
      include: { class: { select: { name: true, grade: true } } },
    }),
  ]);

  const dtos = students.map(toStudentDto);
  const transferredIn = await prisma.studentClassTransfer.findMany({
    where: { kind: 'transfer-in', student: { archivedYearId: archiveId } },
    distinct: ['studentId'],
    select: { studentId: true },
  });
  return {
    ...toArchivedYearDto(record),
    transferInCount: transferredIn.length,
    classes: classes.map(toArchivedClassDto),
    graduates: dtos.filter((item) => item.status === 'graduated'),
    transferred: dtos.filter((item) => item.status === 'transferred'),
    inactive: dtos.filter((item) => item.status === 'inactive'),
  };
}

/**
 * 归档班级的作业与通知（只读）。
 *
 * 归档不删数据，所以这里就是普通的按 classId 查询；单独开一个接口是为了让
 * 「归档详情 → 查看这个班发过什么」有一个明确的、只读的入口。
 */
export async function getArchivedClassContent(
  user: TokenPayload,
  archiveId: string,
  classId: string,
  limit = 200,
): Promise<ArchivedClassContentDto> {
  await assertGlobalPermission(user, 'archive:manage');
  const record = await prisma.class.findUnique({
    where: { id: classId },
    select: { id: true, name: true, archivedYearId: true },
  });
  if (!record) throw ApiError.notFound('班级不存在');
  if (record.archivedYearId !== archiveId) {
    throw ApiError.badRequest('该班级不属于这个届别档案');
  }

  const [homeworks, notifications] = await Promise.all([
    prisma.homework.findMany({
      where: { classId },
      include: {
        course: { select: { id: true, name: true } },
        creator: { select: { id: true, name: true, username: true } },
        statuses: true,
      },
      orderBy: [{ assignDate: 'desc' }, { createdAt: 'desc' }],
      take: limit,
    }),
    prisma.notification.findMany({
      where: { classId },
      include: {
        creator: { select: { id: true, name: true, username: true } },
        reads: true,
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    }),
  ]);

  return {
    classId: record.id,
    className: record.name,
    homeworks: homeworks.map((item) => toHomeworkDto(item, { withStatus: true })),
    notifications: notifications.map((item) => toNotificationDto(item, { withStatus: true })),
  };
}

/**
 * 撤销归档（管理员误操作的退路）。
 *
 * 把该届的班级与学生的归档标记清掉：班级回到在读列表，学生状态 `graduated → active`。
 * **不会删除任何作业或通知** —— 它们本来就没被删过。
 */
export async function deleteArchive(user: TokenPayload, archiveId: string): Promise<void> {
  await assertGlobalPermission(user, 'archive:manage');
  const record = await prisma.archivedYear.findUnique({ where: { id: archiveId } });
  if (!record) throw ApiError.notFound('该届别档案不存在');

  const classes = await prisma.class.findMany({
    where: { archivedYearId: archiveId },
    select: { id: true },
  });

  await prisma.$transaction([
    prisma.class.updateMany({
      where: { archivedYearId: archiveId },
      data: { archivedYearId: null, archivedAt: null },
    }),
    // 毕业的还原成在读；转出的保持转出（那是事实，不是归档造成的）
    prisma.student.updateMany({
      where: { archivedYearId: archiveId, status: 'graduated' },
      data: { status: 'active', archivedYearId: null, archivedAt: null },
    }),
    prisma.student.updateMany({
      where: { archivedYearId: archiveId, status: { not: 'graduated' } },
      data: { archivedYearId: null, archivedAt: null },
    }),
    prisma.archivedYear.delete({ where: { id: archiveId } }),
  ]);

  for (const item of classes) {
    emitToClass(item.id, SOCKET_EVENTS.classUpdated, { classId: item.id, action: 'updated' });
  }
  logger.info(`撤销毕业归档：${record.name} 由 ${user.name} 执行`);
}

/** 归档页顶部的汇总（一届一行之外的全局数字） */
export async function getArchiveSummary(user: TokenPayload): Promise<{
  archiveCount: number;
  classCount: number;
  graduateCount: number;
  transferredCount: number;
}> {
  await assertGlobalPermission(user, 'archive:manage');
  const [archiveCount, classCount, graduateCount, transferredCount] = await Promise.all([
    prisma.archivedYear.count(),
    prisma.class.count({ where: { NOT: { archivedYearId: null } } }),
    prisma.student.count({ where: { status: 'graduated' } }),
    prisma.student.count({ where: { status: 'transferred' } }),
  ]);
  return { archiveCount, classCount, graduateCount, transferredCount };
}
