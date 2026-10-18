import type { AddressInfo } from 'node:net';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/db.js';
import { signToken } from '../src/lib/jwt.js';
import { exportSnapshot, assertValidSnapshot, restoreSnapshot } from '../src/lib/snapshot.js';
import { ensureDefaultGroups } from '../src/lib/permissions.js';
import { registerEmitter } from '../src/realtime/bus.js';
import {
  COURSEWARE_MAX_BYTES,
  SOCKET_EVENTS,
  coursewareCategory,
  dayKeyLocal,
  type CoursewareDto,
} from '@classhelper/shared';
if (
  !process.env.DATABASE_URL?.includes('v14-verification') ||
  !process.env.COURSEWARE_DIR?.includes('v14-verification')
)
  throw new Error('课件验收只能使用临时库和文件目录');
let count = 0;
function check(name: string, value: unknown) {
  assert.ok(value, name);
  console.log(`通过 ${++count}：${name}`);
}
const emitted: { rooms: string[]; event: string; payload: unknown }[] = [];
registerEmitter((rooms, event, payload) => emitted.push({ rooms, event, payload }));
const staff = await Promise.all(
  ['课件教师甲', '课件教师乙', '仅班主任', '临时管理员'].map((name, i) =>
    prisma.user.create({
      data: {
        name,
        username: `cw-${Date.now()}-${i}`,
        passwordHash: '仅签发临时令牌',
        role: i === 3 ? 'ADMIN' : 'TEACHER',
      },
    }),
  ),
);
const tokens = staff.map((user) =>
  signToken({
    sub: user.id,
    username: user.username,
    name: user.name,
    role: user.role as 'ADMIN' | 'TEACHER',
    classId: null,
  }),
);
const classes = await Promise.all(
  [0, 1, 2].map((i) =>
    prisma.class.create({
      data: {
        name: `课件验证班${i + 1}`,
        grade: '验证',
        code: `CW${Date.now()}${i}`,
        teacherId: staff[2]!.id,
      },
    }),
  ),
);
await prisma.course.createMany({
  data: classes.map((c, i) => ({ name: '语文', classId: c.id, teacherId: staff[i === 2 ? 1 : 0]!.id })),
});
const classTokens = classes.map((c) =>
  signToken({
    sub: c.id,
    classId: c.id,
    username: c.code,
    name: c.name,
    role: 'CLASS_DEVICE',
    classSession: true,
  }),
);
await ensureDefaultGroups();
let server = http.createServer(createApp());
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
async function request(route: string, token = tokens[0], body?: unknown, method = body ? 'POST' : 'GET') {
  const res = await fetch(`${base()}${route}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  return { status: res.status, ...(await res.json()) };
}
const bytes = Buffer.from('ClassHelper 课件流式上传验收\n'.repeat(3000));
async function upload(
  options: Partial<{ name: string; size: number; classIds: string[]; mode: string }> = {},
  token = tokens[0],
  data = bytes,
) {
  const meta = {
    name: '第1课 演示.pptx',
    size: data.length,
    classIds: [classes[0]!.id],
    mode: 'cloud',
    ...options,
  };
  const res = await fetch(
    `${base()}/courseware/upload?metadata=${encodeURIComponent(JSON.stringify(meta))}`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
      body: data,
      signal: AbortSignal.timeout(10000),
    },
  );
  return { status: res.status, ...(await res.json()) };
}
const list = async (token: string) => (await request('/courseware', token)).data as CoursewareDto[];
const heartbeat = async (i: number, key: string) =>
  request('/clients/heartbeat', classTokens[i], {
    deviceKey: key,
    clientVersion: '1.4.0',
    platform: 'verification',
  });
const pending = async (i: number, key: string) =>
  request(`/courseware/transfers?deviceKey=${key}`, classTokens[i]);
async function files(dir = process.env.COURSEWARE_DIR!): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
      ),
    )
  ).flat();
}
try {
  check('未登录不能列出课件', (await request('/courseware', '')).status === 401);
  const ownClasses = (await request('/courseware/classes')).data;
  check(
    '只能选择自己的授课班级',
    ownClasses.length === 2 && !ownClasses.some((c: { id: string }) => c.id === classes[2]!.id),
  );
  check(
    '仅班主任而无任课关系不能选择班级',
    (await request('/courseware/classes', tokens[2])).data.length === 0,
  );
  check('管理员上传同样只能选择本人任课班级', (await upload({}, tokens[3])).status === 403);
  check('班级端不能上传', (await upload({}, classTokens[0])).status === 403);
  check('拒绝非任课班级上传', (await upload({ classIds: [classes[2]!.id] })).status === 403);
  check('拒绝目录穿越文件名', (await upload({ name: '../secret.pptx' })).status === 422);
  check('拒绝空文件', (await upload({ size: 0 }, tokens[0], Buffer.alloc(0))).status === 422);
  check('拒绝超过 512 MB 的课件', (await upload({ size: COURSEWARE_MAX_BYTES + 1 })).status === 422);
  check('拒绝错误文件长度', (await upload({ size: 1 })).status === 400);
  check('推送不能不选班级', (await upload({ mode: 'push', classIds: [] })).status === 422);
  const created = await upload();
  const item = created.data as CoursewareDto;
  check(
    '完整上传后创建课件元数据',
    created.status === 201 && item.size === bytes.length && item.name === '第1课 演示.pptx',
  );
  check(
    '摘要、日期与类型正确',
    item.sha256 === createHash('sha256').update(bytes).digest('hex') &&
      item.archiveDate === dayKeyLocal(new Date()) &&
      item.category === 'presentation',
  );
  check('API 不暴露服务端路径', !('storagePath' in item));
  const stored = await prisma.courseware.findUniqueOrThrow({ where: { id: item.id } });
  check(
    '文件按日期和类型保存',
    stored.storagePath.startsWith(path.join(item.archiveDate, 'presentation')) &&
      (await fs.readFile(path.join(process.env.COURSEWARE_DIR!, stored.storagePath))).equals(bytes),
  );
  check(
    '班级仅看到自己可见的课件',
    (await list(classTokens[0]!)).length === 1 && (await list(classTokens[1]!)).length === 0,
  );
  check('其他教师不能访问本人文件', (await request(`/courseware/${item.id}`, tokens[1])).status === 403);
  check(
    '其他班级不能绕过列表下载',
    (await request(`/courseware/${item.id}/download`, classTokens[1])).status === 403,
  );
  const downloaded = await fetch(`${base()}/courseware/${item.id}/download`, {
    headers: { authorization: `Bearer ${classTokens[0]}` },
  });
  check(
    '中文文件按附件下载且内容一致',
    downloaded.headers.get('content-disposition')?.includes('attachment') &&
      Buffer.from(await downloaded.arrayBuffer()).equals(bytes),
  );
  check('下载响应禁止共享缓存', downloaded.headers.get('cache-control')?.includes('no-store'));
  await heartbeat(0, 'courseware-device-1');
  await heartbeat(0, 'courseware-device-2');
  await heartbeat(1, 'courseware-device-3');
  check('仅存云端不会自动发送任务', (await pending(0, 'courseware-device-1')).data.length === 0);
  check('未登记设备不能拉取传输', (await pending(0, 'unknown-device')).status === 403);
  check('不能使用其他班级设备标识', (await pending(1, 'courseware-device-1')).status === 403);
  const privateItem = (await upload({ classIds: [], name: '私有讲义.pdf' })).data as CoursewareDto;
  check('仅自己可见文件不向班级披露', !(await list(classTokens[0]!)).some((c) => c.id === privateItem.id));
  check(
    '无法推送到课件可见范围以外',
    (await request(`/courseware/${item.id}/push`, tokens[0], { classIds: [classes[1]!.id] })).status === 400,
  );
  check(
    '他人不能改可见范围',
    (await request(`/courseware/${item.id}/visibility`, tokens[1], { classIds: [] }, 'PATCH')).status === 403,
  );
  const pushed = (
    await upload({ mode: 'push', name: '课堂练习.docx', classIds: classes.slice(0, 2).map((c) => c.id) })
  ).data as CoursewareDto;
  check(
    '推送模式先存云端实体',
    !!(await prisma.courseware.findUnique({ where: { id: pushed.id } })) &&
      (await list(tokens[0]!)).some((c) => c.id === pushed.id),
  );
  check(
    '班级端不泄露其他可见班级',
    (await list(classTokens[0]!)).every((c) => c.classes.every((v) => v.id === classes[0]!.id)),
  );
  const task = (await pending(0, 'courseware-device-1')).data[0];
  check('推送任务可由离线班级下次上线拉取', task.courseware.id === pushed.id);
  check(
    '实时提示只发送到所选班级房间',
    emitted
      .filter((e) => e.event === SOCKET_EVENTS.coursewareChanged)
      .every((e) =>
        e.rooms.every((room) => [classes[0]!.id, classes[1]!.id].some((id) => room === `class:${id}`)),
      ),
  );
  await new Promise<void>((resolve) => server.close(() => resolve()));
  server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  check('重启服务端后仍保留未完成传输', (await pending(0, 'courseware-device-1')).data[0].id === task.id);
  const ackRoute = `/courseware/transfers/${task.id}/ack`;
  check(
    '其他班级不能回执任务',
    (await request(ackRoute, classTokens[1], { deviceKey: 'courseware-device-3' })).status === 404,
  );
  check(
    '接收完成后可回执',
    (await request(ackRoute, classTokens[0], { deviceKey: 'courseware-device-1' })).status === 200,
  );
  check(
    '重复回执幂等',
    (await request(ackRoute, classTokens[0], { deviceKey: 'courseware-device-1' })).status === 200,
  );
  check(
    '回执仅清除本设备任务',
    (await pending(0, 'courseware-device-1')).data.length === 0 &&
      (await pending(0, 'courseware-device-2')).data.length === 1,
  );
  await request(`/courseware/${pushed.id}/visibility`, tokens[0], { classIds: [classes[0]!.id] }, 'PATCH');
  check(
    '撤回班级可见范围同时取消其待传任务',
    (await pending(1, 'courseware-device-3')).data.length === 0 &&
      !(await list(classTokens[1]!)).some((c) => c.id === pushed.id),
  );
  check(
    '撤回后不能通过直链下载',
    (await request(`/courseware/${pushed.id}/download`, classTokens[1])).status === 403,
  );
  await request(`/courseware/${pushed.id}/push`, tokens[0], { classIds: [classes[0]!.id] });
  check('已归档课件可再次推送', (await pending(0, 'courseware-device-1')).data.length === 1);
  const defaultGroup = await prisma.permissionGroup.findUniqueOrThrow({ where: { defaultRole: 'TEACHER' } });
  await prisma.permissionGroupItem.deleteMany({
    where: { groupId: defaultGroup.id, key: 'courseware:write' },
  });
  check('收回写权限立即禁止上传', (await upload()).status === 403);
  await prisma.permissionGroupItem.create({ data: { groupId: defaultGroup.id, key: 'courseware:write' } });
  const snapshot = await exportSnapshot(prisma, 'sqlite');
  check(
    '备份包含课件、可见范围、推送和回执',
    snapshot.data.Courseware.length === 3 &&
      snapshot.data.CoursewareReceipt.length === 1 &&
      snapshot.data.CoursewarePush.length > 0 &&
      snapshot.data.CoursewareVisibility.length > 0,
  );
  const oldSnapshot = structuredClone(snapshot);
  for (const key of ['Courseware', 'CoursewarePush', 'CoursewareReceipt', 'CoursewareVisibility'])
    delete (oldSnapshot.data as Record<string, unknown>)[key];
  assertValidSnapshot(oldSnapshot);
  check('允许读取升级前的旧版快照', true);
  await request(`/courseware/${pushed.id}`, tokens[0], undefined, 'DELETE');
  check(
    '删除课件级联清理推送任务',
    (await pending(0, 'courseware-device-1')).data.length === 0 &&
      (await pending(0, 'courseware-device-2')).data.length === 0,
  );
  check('删除实体后无残余文件', (await files()).length === 2);
  const before = (await files()).length;
  await new Promise<void>((resolve) => {
    const metadata = { name: '中断上传.zip', size: 100000, classIds: [], mode: 'cloud' };
    const req = http.request(
      `${base()}/courseware/upload?metadata=${encodeURIComponent(JSON.stringify(metadata))}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tokens[0]}`,
          'content-type': 'application/octet-stream',
          'content-length': '100000',
        },
      },
    );
    req.on('error', () => resolve());
    req.write(Buffer.alloc(1000));
    setTimeout(() => req.destroy(), 250);
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  check(
    '上传中断自动清理临时文件',
    (await files()).length === before && !(await files()).some((file) => file.endsWith('.part')),
  );
  check(
    '文件分类覆盖演示、文档、媒体与压缩包',
    coursewareCategory('A.PPTX') === 'presentation' &&
      coursewareCategory('a.pdf') === 'document' &&
      coursewareCategory('v.mp4') === 'video' &&
      coursewareCategory('a.7z') === 'archive',
  );
  await restoreSnapshot(prisma, 'sqlite', snapshot);
  check(
    '恢复数据库后保留课件共享和回执数据',
    (await prisma.courseware.count()) === 3 && (await prisma.coursewareReceipt.count()) === 1,
  );
  console.log(`=== 课件隔离验收：${count}/${count} 项通过 ===`);
} finally {
  server.closeAllConnections();
  server.close();
  await once(server, 'close').catch(() => undefined);
  await prisma.$disconnect();
}
