import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Request } from 'express';
import {
  COURSEWARE_MAX_BYTES,
  coursewareCategory,
  coursewareArchivePath,
  dayKeyLocal,
  SOCKET_EVENTS,
  type CoursewareDto,
  type CoursewareUploadRequest,
} from '@classhelper/shared';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/db.js';
import { ApiError } from '../../lib/http.js';
import { assertCanManageSubjectContent, requireClassDeviceClassId } from '../../lib/access.js';
import type { TokenPayload } from '../../lib/jwt.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { emitToClass } from '../../realtime/bus.js';

export const coursewareRoot = path.resolve(
  process.env.COURSEWARE_DIR || path.join(env.serverRoot, '..', 'data', 'courseware'),
);
const include = {
  owner: { select: { id: true, name: true } },
  visibility: { include: { class: { select: { id: true, name: true } } } },
} as const;
type RecordWithRelations = Prisma.CoursewareGetPayload<{ include: typeof include }>;
function dto(row: RecordWithRelations): CoursewareDto {
  return {
    id: row.id,
    name: row.name,
    size: row.size,
    category: row.category as CoursewareDto['category'],
    extension: row.extension,
    archiveDate: row.archiveDate,
    archivePath: row.archivePath || coursewareArchivePath(row.owner.name, row.createdAt, row.name),
    folderPath: row.folderPath,
    sha256: row.sha256,
    createdAt: row.createdAt.toISOString(),
    teacher: row.owner,
    classes: row.visibility.map((item) => item.class),
  };
}
export async function teachingClasses(user: TokenPayload) {
  return prisma.class.findMany({
    where: { archivedYearId: null, courses: { some: { teacherId: user.sub } } },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
}
async function validateClasses(user: TokenPayload, ids: string[]) {
  const classIds = [...new Set(ids)];
  const allowed = new Set((await teachingClasses(user)).map((item) => item.id));
  if (classIds.some((id) => !allowed.has(id))) throw ApiError.forbidden('只能选择自己任教的在读班级');
  for (const classId of classIds) {
    const course = await prisma.course.findFirst({
      where: { classId, teacherId: user.sub },
      select: { id: true },
    });
    await assertCanManageSubjectContent(user, classId, course?.id, '发布课件');
  }
  return classIds;
}
export async function readable(user: TokenPayload, id: string) {
  const row = await prisma.courseware.findUnique({ where: { id }, include });
  if (!row) throw ApiError.notFound('课件不存在');
  if (user.role === 'CLASS_DEVICE') {
    if (!row.visibility.some((item) => item.classId === requireClassDeviceClassId(user)))
      throw ApiError.forbidden('课件不在本班可见范围内');
  } else if (row.ownerId !== user.sub && user.role !== 'ADMIN')
    throw ApiError.forbidden('只能访问自己的课件');
  return row;
}
async function owned(user: TokenPayload, id: string) {
  const row = await readable(user, id);
  if (row.ownerId !== user.sub) throw ApiError.forbidden('只能修改自己的课件');
  return row;
}
export async function getCourseware(user: TokenPayload, id: string) {
  const item = dto(await readable(user, id));
  if (user.role === 'CLASS_DEVICE')
    item.classes = item.classes.filter((c) => c.id === requireClassDeviceClassId(user));
  return item;
}
export async function listCourseware(user: TokenPayload) {
  const classId = user.role === 'CLASS_DEVICE' ? requireClassDeviceClassId(user) : null;
  const rows = await prisma.courseware.findMany({
    where: classId
      ? { visibility: { some: { classId } } }
      : user.role === 'ADMIN'
        ? {}
        : { ownerId: user.sub },
    include,
    orderBy: { createdAt: 'desc' },
  });
  // 班级端只暴露本班的可见关系。
  return rows.map((row) => {
    const item = dto(row);
    if (classId) item.classes = item.classes.filter((c) => c.id === classId);
    return item;
  });
}
export async function uploadCourseware(user: TokenPayload, input: CoursewareUploadRequest, req: Request) {
  const classIds = await validateClasses(user, input.classIds);
  await assertFolder(user, input.folderPath || '');
  if (!req.is('application/octet-stream')) throw ApiError.badRequest('请使用二进制文件上传');
  if (req.headers['content-length'] && Number(req.headers['content-length']) !== input.size)
    throw ApiError.badRequest('文件长度与上传信息不符');
  const uploadedAt = new Date();
  const owner = await prisma.user.findUniqueOrThrow({ where: { id: user.sub }, select: { name: true } });
  const archivePath = coursewareArchivePath(owner.name, uploadedAt, input.name);
  const category = coursewareCategory(input.name),
    archiveDate = dayKeyLocal(uploadedAt);
  const extension = path.extname(input.name).slice(1).toLowerCase();
  // UUID 隔离同名教师或同秒上传；对外归档路径始终使用上传时的教师名和时间。
  const relative = path.join(randomUUID(), archivePath);
  const file = path.join(coursewareRoot, relative),
    partial = `${file}.part`;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  let bytes = 0;
  const hash = createHash('sha256');
  try {
    await pipeline(
      req,
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > COURSEWARE_MAX_BYTES || bytes > input.size)
            return callback(ApiError.badRequest('课件超过上传大小限制'));
          hash.update(chunk);
          callback(null, chunk);
        },
      }),
      fs.createWriteStream(partial, { flags: 'wx' }),
    );
    if (bytes !== input.size) throw ApiError.badRequest('文件上传不完整，请重试');
    await fsp.rename(partial, file);
    // 上传耗时较长，完成后重新验证任课关系。
    await validateClasses(user, classIds);
    const row = await prisma.courseware.create({
      data: {
        ownerId: user.sub,
        name: input.name,
        size: bytes,
        category,
        extension,
        archiveDate,
        archivePath,
        folderPath: input.folderPath || '',
        createdAt: uploadedAt,
        storagePath: relative,
        sha256: hash.digest('hex'),
        visibility: { create: classIds.map((classId) => ({ classId })) },
        pushes: input.mode === 'push' ? { create: classIds.map((classId) => ({ classId })) } : undefined,
      },
      include,
    });
    for (const classId of classIds) emitToClass(classId, SOCKET_EVENTS.coursewareChanged, { id: row.id });
    return dto(row);
  } catch (error) {
    await Promise.all([fsp.rm(partial, { force: true }), fsp.rm(file, { force: true })]);
    throw error;
  }
}
async function assertFolder(user: TokenPayload, folderPath: string) {
  if (
    folderPath &&
    !(await prisma.coursewareFolder.findUnique({
      where: { ownerId_path: { ownerId: user.sub, path: folderPath } },
    }))
  )
    throw ApiError.badRequest('请选择自己创建的文件夹');
}
export async function listFolders(user: TokenPayload) {
  const rows = await prisma.coursewareFolder.findMany({
    where: { ownerId: user.sub },
    orderBy: { path: 'asc' },
  });
  return rows.map((row) => ({ id: row.id, path: row.path }));
}
export async function createFolder(user: TokenPayload, folderPath: string) {
  const row = await prisma.coursewareFolder.upsert({
    where: { ownerId_path: { ownerId: user.sub, path: folderPath } },
    create: { ownerId: user.sub, path: folderPath },
    update: {},
  });
  return { id: row.id, path: row.path };
}
export async function moveCourseware(user: TokenPayload, id: string, folderPath: string) {
  await owned(user, id);
  await assertFolder(user, folderPath);
  return dto(await prisma.courseware.update({ where: { id }, data: { folderPath }, include }));
}
export async function setVisibility(user: TokenPayload, id: string, ids: string[]) {
  await owned(user, id);
  const classIds = await validateClasses(user, ids);
  const old = await prisma.coursewareVisibility.findMany({ where: { coursewareId: id } });
  const row = await prisma.$transaction(async (tx) => {
    await tx.coursewarePush.deleteMany({ where: { coursewareId: id, classId: { notIn: classIds } } });
    await tx.coursewareVisibility.deleteMany({ where: { coursewareId: id } });
    return tx.courseware.update({
      where: { id },
      data: { visibility: { create: classIds.map((classId) => ({ classId })) } },
      include,
    });
  });
  for (const classId of new Set([...classIds, ...old.map((v) => v.classId)]))
    emitToClass(classId, SOCKET_EVENTS.coursewareChanged, { id });
  return dto(row);
}
export async function pushCourseware(user: TokenPayload, id: string, ids: string[]) {
  const row = await owned(user, id);
  const classIds = await validateClasses(user, ids);
  if (!classIds.length || classIds.some((classId) => !row.visibility.some((v) => v.classId === classId)))
    throw ApiError.badRequest('推送班级必须在课件可见范围内');
  await prisma.$transaction(
    classIds.map((classId) => prisma.coursewarePush.create({ data: { coursewareId: id, classId } })),
  );
  for (const classId of classIds) emitToClass(classId, SOCKET_EVENTS.coursewareChanged, { id });
}
export async function deleteCourseware(user: TokenPayload, id: string) {
  const row = await owned(user, id);
  await prisma.courseware.delete({ where: { id } });
  await fsp.rm(path.join(coursewareRoot, row.storagePath), { force: true });
  for (const v of row.visibility) emitToClass(v.classId, SOCKET_EVENTS.coursewareChanged, { id });
}
export async function deviceFor(user: TokenPayload, deviceKey: string) {
  const classId = requireClassDeviceClassId(user);
  const device = await prisma.clientDevice.findUnique({ where: { deviceKey } });
  if (!device || device.classId !== classId) throw ApiError.forbidden('设备未登记或不属于当前班级');
  return { ...device, classId };
}
export async function pendingTransfers(user: TokenPayload, deviceKey: string) {
  const device = await deviceFor(user, deviceKey);
  const rows = await prisma.coursewarePush.findMany({
    where: {
      classId: device.classId,
      receipts: { none: { deviceId: device.id } },
      courseware: { visibility: { some: { classId: device.classId } } },
    },
    include: { courseware: { include } },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });
  return rows.map((row) => ({
    id: row.id,
    courseware: {
      ...dto(row.courseware),
      classes: dto(row.courseware).classes.filter((c) => c.id === device.classId),
    },
  }));
}
export async function acknowledgeTransfer(user: TokenPayload, pushId: string, deviceKey: string) {
  const device = await deviceFor(user, deviceKey);
  const push = await prisma.coursewarePush.findFirst({ where: { id: pushId, classId: device.classId } });
  if (!push) throw ApiError.notFound('传输任务不存在');
  await readable(user, push.coursewareId);
  await prisma.coursewareReceipt.upsert({
    where: { pushId_deviceId: { pushId, deviceId: device.id } },
    create: { pushId, deviceId: device.id },
    update: {},
  });
}
