import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { io as connect, type Socket } from 'socket.io-client';
import {
  PERMISSION_KEYS,
  PERMISSION_META,
  SOCKET_CHANNELS,
  SOCKET_ROOMS,
  SOCKET_EVENTS,
  parsePermissionScope,
} from '@classhelper/shared';
import { prisma } from '../src/lib/db.js';
import { createApp } from '../src/app.js';
import { signToken, type TokenPayload } from '../src/lib/jwt.js';
import { ensureDefaultGroups } from '../src/lib/permissions.js';
import { classIdsFor } from '../src/lib/authz/index.js';
import { initRealtime } from '../src/realtime/socket.js';
import { emitToClass } from '../src/realtime/bus.js';
import { exportSnapshot, restoreSnapshot } from '../src/lib/snapshot.js';

if (!process.env.DATABASE_URL?.includes('authz-verification'))
  throw new Error('只能在授权验收临时数据库运行');
let count = 0;
const check = (name: string) => console.log(`通过 ${++count}：${name}`);
async function account(name: string, role: TokenPayload['role'] = 'TEACHER'): Promise<TokenPayload> {
  const row = await prisma.user.create({
    data: { username: name, name, role, passwordHash: '隔离夹具，不使用真实账号' },
  });
  return { sub: row.id, username: name, name, role, classId: null };
}
const admin = await account('authz-admin', 'ADMIN'),
  aTeacher = await account('authz-A'),
  bTeacher = await account('authz-B'),
  unrelated = await account('authz-C'),
  lead = await account('authz-grade'),
  division = await account('authz-division');
await ensureDefaultGroups();
const cls = async (name: string, grade: string, teacherId: string, index: number) =>
  prisma.class.create({
    data: {
      name,
      grade,
      teacherId,
      classIndex: index,
      enrollmentYear: 2026,
      code: `AUTHZ${index}`,
      passwordHash: '隔离',
    },
  });
const A = await cls('授权A', '高一', aTeacher.sub, 1),
  B = await cls('授权B', '高一', bTeacher.sub, 2),
  _C = await cls('授权C', '高二', bTeacher.sub, 3);
const course = async (classId: string, name: string, teacherId: string) =>
  prisma.course.create({ data: { classId, name, teacherId } });
const mathB = await course(B.id, '数学', aTeacher.sub),
  chineseB = await course(B.id, '语文', bTeacher.sub),
  mathA = await course(A.id, '数学', aTeacher.sub);
const studentA = await prisma.student.create({ data: { studentNo: 'AUTHZA', name: '临时A', classId: A.id } }),
  studentB = await prisma.student.create({ data: { studentNo: 'AUTHZB', name: '临时B', classId: B.id } });
const device = (c: typeof A): TokenPayload => ({
  sub: c.id,
  username: c.code,
  name: c.name,
  role: 'CLASS_DEVICE',
  classId: c.id,
  classSession: true,
  classCode: c.code,
});
const aDevice = device(A),
  bDevice = device(B);
const server = createServer(createApp()),
  realtime = initRealtime(server);
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`,
  base = origin + '/api';
async function request(url: string, actor: TokenPayload, method = 'GET', body?: unknown, expected = 200) {
  const res = await fetch(base + url, {
    method,
    headers: { authorization: `Bearer ${signToken(actor)}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = await res.json();
  assert.equal(res.status, expected, `${method} ${url} ${JSON.stringify(json)}`);
  return json.data;
}
async function group(name: string, keys: string[], scope = 'TEACHING', scopeValue = '') {
  return prisma.permissionGroup.create({
    data: { name, scope, scopeValue, items: { create: keys.map((key) => ({ key })) } },
  });
}
async function assign(actor: TokenPayload, rows: { groupId: string; scope: string; scopeValue?: string }[]) {
  await prisma.userPermissionGroup.deleteMany({ where: { userId: actor.sub } });
  if (rows.length)
    await prisma.userPermissionGroup.createMany({
      data: rows.map((r) => ({ userId: actor.sub, ...r, scopeValue: r.scopeValue ?? '' })),
    });
}
const sockets: Socket[] = [];
async function socket(actor: TokenPayload) {
  const s = connect(origin, {
    auth: { token: signToken(actor) },
    transports: ['websocket'],
    reconnection: false,
  });
  sockets.push(s);
  const info = await new Promise<{ rooms: string[] }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('实时连接超时')), 5000);
    s.once('connected', (data) => {
      clearTimeout(timer);
      resolve(data);
    });
    s.once('connect_error', reject);
  });
  return { s, rooms: info.rooms };
}
try {
  // 旧残留管理员键全部装备给科任，管理员能力仍永久无效。
  const old = await group('旧残留全能力', [...PERMISSION_KEYS], 'ALL');
  await assign(aTeacher, [{ groupId: old.id, scope: 'ALL' }]);
  const mine = await request('/permissions/me', aTeacher);
  assert(
    !mine.permissions.some((key: keyof typeof PERMISSION_META) => PERMISSION_META[key].kind === 'admin'),
  );
  assert.equal((await request('/permissions/me', admin)).permissions.length, PERMISSION_KEYS.length);
  check('管理员全集；旧组残留管理员键对教师无效');
  for (const [url, method, body] of [
    [`/classes/${B.id}/class-account`, 'PATCH', { password: 'authz-test' }],
    [`/classes/${B.id}/settings`, 'PATCH', { termWeeks: 12 }],
    [`/classes/${B.id}/head-teacher`, 'PATCH', { teacherId: aTeacher.sub }],
    [
      `/classes/${B.id}/subject-teachers`,
      'PUT',
      { assignments: [{ subjectName: '语文', teacherId: aTeacher.sub }] },
    ],
    ['/classes', 'POST', { grade: '高一', enrollmentYear: 2029, classIndex: 99 }],
    ['/teachers', 'POST', { username: 'intruder', name: '攻击', role: 'ADMIN' }],
    [`/teachers/${admin.sub}`, 'PATCH', { role: 'TEACHER' }],
    [`/teachers/${admin.sub}/reset-password`, 'POST', {}],
    [`/teachers/${admin.sub}`, 'DELETE', undefined],
    ['/permissions/groups', 'POST', { name: '越权', keys: [] }],
    ['/system/settings', 'PUT', {}],
    ['/database/status', 'GET', undefined],
    ['/term', 'PUT', { weeks: [] }],
    ['/term/promotion', 'GET', undefined],
    [
      '/imports/table/commit',
      'POST',
      { kind: 'classTeachers', fileName: 'authz.csv', contentBase64: '', mapping: {}, mode: 'append' },
    ],
  ] as const)
    await request(url, aTeacher, method, body, 403);
  assert.equal((await request(`/classes/${B.id}`, aTeacher)).code, undefined);
  check('科任不能接管班级账号、学期设置、人员关系或组织写入口，班级码不泄漏');
  await request(`/classes/${A.id}/class-account`, aTeacher, 'PATCH', { code: 'AUTHZA1' });
  await request(`/classes/${A.id}/settings`, aTeacher, 'PATCH', { termWeeks: 12 });
  await request(`/classes/${B.id}/class-account`, admin, 'PATCH', { code: 'AUTHZB1' });
  check('本班班主任可改账号与学期设置；管理员可改其他班');
  await request(`/teachers/${admin.sub}`, admin, 'PATCH', { role: 'TEACHER' }, 409);
  await request(`/teachers/${admin.sub}`, admin, 'DELETE', undefined, 409);
  check('最后一个管理员不可降级或删除');
  const helper = await request(
    '/teachers',
    admin,
    'POST',
    { username: 'authz-new', name: '新增教师', password: 'authz-pass' },
    201,
  );
  await request(`/teachers/${helper.id}/reset-password`, admin, 'POST', { newPassword: 'authz-pass-2' });
  await request(`/teachers/${helper.id}`, admin, 'DELETE');
  check('管理员账号写入口正常且产生审计');
  const readA = await group(
    'A的关联读取',
    [
      'class:read',
      'homework:read',
      'notification:read',
      'grade:read',
      'dashboard:read',
      'schedule:read',
      'roster:read',
    ],
    'HEAD',
  );
  const otherAll = await group('无关全校键', ['client:read'], 'ALL');
  await assign(aTeacher, [
    { groupId: readA.id, scope: 'HEAD' },
    { groupId: otherAll.id, scope: 'ALL' },
  ]);
  for (const url of [
    `/grades/ranking?classId=${B.id}&examName=测试`,
    `/grades/exams?classId=${B.id}`,
    `/grades/collective?classId=${B.id}`,
    `/homeworks?classId=${B.id}`,
    `/notifications?classId=${B.id}`,
  ])
    await request(url, aTeacher, 'GET', undefined, 403);
  assert.deepEqual(
    (await request('/classes', aTeacher)).map((c: { id: string }) => c.id),
    [A.id],
  );
  const dashboard = await request('/dashboard/summary', aTeacher);
  assert.equal(dashboard.classCount, 1);
  assert.equal((await classIdsFor({ ...aTeacher }, undefined as never)).length, 0);
  check('按键独立计算，设备全校读不能扩大内容读取；无键范围为空');
  await assign(unrelated, [{ groupId: otherAll.id, scope: 'ALL' }]);
  for (const url of ['/homeworks', '/notifications', '/dashboard/summary', `/grades/exams?classId=${B.id}`])
    await request(url, unrelated, 'GET', undefined, 403);
  const onlyDashboard = await group('仅看板', ['dashboard:read'], 'ALL');
  await assign(unrelated, [{ groupId: onlyDashboard.id, scope: 'ALL' }]);
  const hidden = await request('/dashboard/summary', unrelated);
  assert.equal(hidden.gradeCount, 0);
  assert.equal(hidden.studentCount, 0);
  assert.equal(hidden.sections.grades, false);
  check('宽范围无关能力不授予读权限，看板各段独立受控');
  await assign(aTeacher, [{ groupId: old.id, scope: 'ALL' }]);
  const hw = await prisma.homework.create({
    data: {
      classId: B.id,
      courseId: chineseB.id,
      title: '同事语文',
      content: '隔离测试',
      createdBy: bTeacher.sub,
    },
  });
  const grade = await prisma.grade.create({
    data: { classId: B.id, courseId: chineseB.id, studentId: studentB.id, examName: '授权考试', score: 80 },
  });
  await request(`/homeworks/${hw.id}`, aTeacher, 'PATCH', { courseId: mathB.id }, 403);
  await request(`/grades/${grade.id}`, aTeacher, 'PATCH', { courseId: mathB.id }, 403);
  await request(
    `/homeworks/${hw.id}/status`,
    aTeacher,
    'PATCH',
    { completed: true, studentId: studentB.id },
    403,
  );
  await request(`/homeworks/${hw.id}/submissions`, aTeacher, 'GET', undefined, 403);
  await request(`/homeworks/${hw.id}/submissions`, aTeacher, 'PATCH', { notSubmittedStudentIds: [] }, 403);
  await request(`/grades/exams`, aTeacher, 'PUT', { classId: B.id, name: '授权考试', countInTotal: true });
  // 年级/全校授权可配置考试口径；仅任教范围的科任不能。
  await assign(aTeacher, [{ groupId: old.id, scope: 'TEACHING' }]);
  await request(
    `/grades/exams`,
    aTeacher,
    'PUT',
    { classId: B.id, name: '授权考试', countInTotal: false },
    403,
  );
  await request(`/classes/${B.id}/student-grade-query`, aTeacher, 'PATCH', { enabled: false }, 403);
  check('原/目标科目双校验；未交名单与完成状态需要科目关系；科任不能改考试配置');
  const ownHw = await request(
    '/homeworks',
    aTeacher,
    'POST',
    { classId: B.id, courseId: mathB.id, title: '本人数学', content: '隔离测试' },
    201,
  );
  await request(`/homeworks/${ownHw.id}/status`, bDevice, 'PATCH', { completed: true });
  check('科任可发布本科作业，班级端可维护本班作业');
  const layoutBody = {
    classId: A.id,
    name: '本班时间表',
    points: [{ name: '第一节', startTime: '08:00', endTime: '08:40', timeType: 'LESSON' }],
  };
  const layout = await request('/time-layouts', aTeacher, 'POST', layoutBody, 201);
  const foreign = await request(
    '/time-layouts',
    admin,
    'POST',
    { ...layoutBody, classId: B.id, name: '别班时间表' },
    201,
  );
  for (const method of ['PUT', 'DELETE'])
    await request(
      `/time-layouts/${foreign.id}`,
      aTeacher,
      method,
      method === 'PUT' ? { ...layoutBody, classId: A.id } : undefined,
      403,
    );
  await request(`/time-layouts/${foreign.id}/clone`, aTeacher, 'POST', { name: '偷复制' }, 403);
  await request('/time-layouts', aTeacher, 'POST', { ...layoutBody, classId: null }, 403);
  await request('/term', aTeacher, 'PUT', { classId: B.id, weeks: [] }, 403);
  await request('/term', aTeacher, 'PUT', { classId: A.id, weeks: [] });
  await request(`/time-layouts/${layout.id}`, aTeacher, 'DELETE');
  check('时间表按存储班级校验；本班可写、跨班与全局拒绝；班级周次要求班主任');
  const csv = `学号,姓名,班级\nAUTHZSAFE,首行,${A.name}\nAUTHZBAD,末行,${B.name}`;
  await request(
    '/imports/table/commit',
    aTeacher,
    'POST',
    {
      kind: 'students',
      fileName: 'authz.csv',
      contentBase64: Buffer.from('\ufeff' + csv).toString('base64'),
      mapping: { studentNo: '学号', name: '姓名', className: '班级' },
      mode: 'append',
    },
    403,
  );
  assert.equal(await prisma.student.count({ where: { studentNo: 'AUTHZSAFE' } }), 0);
  check('跨班学生导入预检全部范围，403 不留下首行数据');
  const defaults = await prisma.permissionGroup.findUniqueOrThrow({ where: { defaultRole: 'TEACHER' } });
  await request(`/permissions/groups/${defaults.id}`, admin, 'PATCH', { scope: 'ALL' }, 400);
  await request(`/permissions/groups/${defaults.id}`, admin, 'PATCH', { keys: ['teacher:manage'] }, 400);
  await request(
    '/permissions/groups',
    admin,
    'POST',
    { name: '非法年级', scope: 'GRADE', scopeValue: '不存在', keys: ['class:read'] },
    400,
  );
  await request('/permissions/groups', admin, 'POST', { name: '非法能力', keys: ['permission:manage'] }, 400);
  const legacyTemplate = await group('保留旧停用键', ['class:read', 'class:manage']);
  const updatedLegacyTemplate = await request(`/permissions/groups/${legacyTemplate.id}`, admin, 'PATCH', {
    keys: ['class:read', 'grade:read'],
  });
  assert(updatedLegacyTemplate.inactiveKeys.includes('class:manage'));
  assert.equal(
    await prisma.permissionGroupItem.count({ where: { groupId: legacyTemplate.id, key: 'class:manage' } }),
    1,
  );
  await assign(unrelated, [{ groupId: legacyTemplate.id, scope: 'ALL' }]);
  assert(!(await request('/permissions/me', unrelated)).permissions.includes('class:manage'));
  check('默认模板固定 TEACHING；不可保存管理员能力或未知年级');
  const scoped = await request(
    '/permissions/groups',
    admin,
    'POST',
    { name: '分配级范围', scope: 'HEAD', keys: ['class:read', 'grade:read', 'class:account'] },
    201,
  );
  await request(`/permissions/users/${lead.sub}/groups`, admin, 'PUT', {
    assignments: [{ groupId: scoped.id, scope: 'GRADE', scopeValue: '高一' }],
  });
  await request(`/permissions/users/${division.sub}/groups`, admin, 'PUT', {
    assignments: [{ groupId: scoped.id, scope: 'DIVISION', scopeValue: '高二,高一' }],
  });
  assert.equal((await request('/classes', lead)).length, 2);
  assert.equal((await request('/classes', division)).length, 3);
  const effective = await request(`/permissions/users/${lead.sub}/effective`, admin);
  assert.equal(effective.entries.find((e: { key: string }) => e.key === 'class:account').classCount, 0);
  const leadPermissions = await request('/permissions/me', lead);
  assert.deepEqual(leadPermissions.classScopes['grade:read'].sort(), [A.id, B.id].sort());
  await request(`/grades/ranking?classId=${B.id}&examName=授权考试`, lead);
  await request(`/permissions/groups/${scoped.id}`, admin, 'PATCH', { scope: 'ALL' });
  assert.equal((await request('/classes', lead)).length, 2);
  check('模板建议范围变更不影响已有分配；级长/部长范围与班主任关系独立');
  const query = encodeURIComponent(
    JSON.stringify([
      { groupId: scoped.id, scope: 'HEAD', scopeValue: '' },
      { groupId: scoped.id, scope: 'GRADE', scopeValue: '高二' },
    ]),
  );
  const merged = await request(`/permissions/users/${aTeacher.sub}/effective?assignments=${query}`, admin);
  assert.equal(merged.entries.find((e: { key: string }) => e.key === 'class:read').classCount, 2);
  assert(merged.conflicts.length > 0);
  await request(`/permissions/users/${admin.sub}/groups`, admin, 'PUT', { assignments: [] }, 400);
  check('同模板多范围正确合并并预览冲突，管理员不可分配');
  const beforeDefault = await request('/permissions/me', bTeacher);
  await request(`/permissions/users/${bTeacher.sub}/groups`, admin, 'PUT', { assignments: [] });
  assert.equal((await request('/permissions/me', bTeacher)).fromGroups, false);
  assert(beforeDefault.permissions.length > 0);
  check('空分配恢复默认，无隐式自动预选转换');
  await request(`/classes/${B.id}/student-grade-query`, admin, 'PATCH', { enabled: false });
  for (const url of [
    `/grades/ranking?classId=${B.id}&examName=授权考试`,
    `/grades/exams?classId=${B.id}`,
    `/grades/student/${studentB.studentNo}`,
    '/grades/my',
  ])
    await request(url, bDevice, 'GET', undefined, 403);
  assert.equal((await request(`/grades/collective?classId=${B.id}`, bDevice)).mode, 'collective');
  await request(`/grades/collective?classId=${B.id}`, aDevice, 'GET', undefined, 403);
  check('班级端关闭查询后拒绝个人/排名/原始列表，保留本班集体聚合');
  const hb = {
    deviceKey: 'authz-device-b',
    name: '临时设备',
    clientVersion: '1.0.0',
    platform: 'win32',
    agentProtocol: 2,
  };
  const d = await request('/clients/heartbeat', bDevice, 'POST', hb);
  await request('/clients/heartbeat', aTeacher, 'POST', hb, 403);
  await request('/clients/heartbeat', aDevice, 'POST', hb, 403);
  const command = await prisma.clientCommand.create({
    data: { deviceId: d.deviceId, kind: 'lock', createdBy: admin.sub, payload: '隔离假执行' },
  });
  for (const actor of [aTeacher, aDevice])
    await request(
      `/clients/commands/${command.id}/ack`,
      actor,
      'POST',
      { deviceKey: hb.deviceKey, ok: true },
      403,
    );
  await request(`/clients/commands/${command.id}/ack`, bDevice, 'POST', {
    deviceKey: hb.deviceKey,
    ok: true,
    result: '未执行任何系统操作',
  });
  await request(
    '/clients/update-progress',
    aTeacher,
    'POST',
    {
      deviceKey: hb.deviceKey,
      progress: {
        version: '1.1.0',
        stage: 'downloading',
        downloadedBytes: 0,
        totalBytes: 1,
        percent: 0,
        error: '',
      },
    },
    403,
  );
  check('心跳/进度/回执只接受本班班级端，教师知道 deviceKey 仍不能冒用');
  await request('/update/client/releases', admin, 'POST', { version: '..' }, 400);
  await request('/update/client/download/1.0.0', unrelated, 'GET', undefined, 403);
  check('更新路径拒绝 ..，下载要求班级端或设备读能力及范围');
  const readOnly = await group('只读作业实时', ['homework:read'], 'HEAD');
  await assign(aTeacher, [{ groupId: readOnly.id, scope: 'TEACHING' }]);
  const previousSubjectSocket = await socket(aTeacher);
  assert(previousSubjectSocket.rooms.includes(SOCKET_ROOMS.classChannel(B.id, 'homework')));
  const disconnected = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('任课导入后旧订阅未断开')), 5000);
    previousSubjectSocket.s.once('disconnect', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  await request('/imports/table/commit', admin, 'POST', {
    kind: 'classTeachers',
    fileName: 'relations.csv',
    mapping: { className: '班级', subjectName: '科目', teacherNo: '工号', teacherName: '姓名', role: '角色' },
    contentBase64: Buffer.from(
      `\ufeff班级,科目,工号,姓名,角色\n${B.name},数学,${bTeacher.username},临时教师,科任`,
    ).toString('base64'),
    mode: 'upsert',
  });
  await disconnected;
  const updatedSubjectSocket = await socket(aTeacher);
  assert(!updatedSubjectSocket.rooms.includes(SOCKET_ROOMS.classChannel(B.id, 'homework')));
  check('任课导入变更后旧房间立即失效，重连按现行关系订阅');

  await assign(aTeacher, [
    { groupId: readOnly.id, scope: 'HEAD' },
    { groupId: otherAll.id, scope: 'ALL' },
  ]);
  const { s, rooms } = await socket(aTeacher),
    deviceSocket = await socket(aDevice);
  assert(rooms.includes(SOCKET_ROOMS.classChannel(A.id, 'homework')));
  assert(!rooms.includes(SOCKET_ROOMS.classChannel(B.id, 'homework')));
  assert(!rooms.includes(SOCKET_ROOMS.classChannel(A.id, 'grade')));
  assert(SOCKET_CHANNELS.every((ch) => deviceSocket.rooms.includes(SOCKET_ROOMS.classChannel(A.id, ch))));
  const join = await new Promise<{ ok: boolean }>((resolve) =>
    s.emit('class:join', { classId: B.id, channels: ['homework'] }, resolve),
  );
  assert.equal(join.ok, false);
  const seen: string[] = [];
  s.on(SOCKET_EVENTS.gradeUpdated, () => seen.push('grade'));
  s.on(SOCKET_EVENTS.homeworkNew, () => seen.push('homework'));
  emitToClass(A.id, SOCKET_EVENTS.gradeUpdated, { classId: A.id });
  emitToClass(B.id, SOCKET_EVENTS.homeworkNew, { id: 'foreign' });
  emitToClass(A.id, SOCKET_EVENTS.homeworkNew, { id: 'own' });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(seen, ['homework']);
  check('实时按读域与范围订阅，跨班 join 和跨域事件均拒绝');
  const stale = signToken(admin);
  await prisma.user.update({ where: { id: admin.sub }, data: { role: 'TEACHER' } });
  const staleSocket = connect(origin, {
    auth: { token: stale },
    transports: ['websocket'],
    reconnection: false,
  });
  sockets.push(staleSocket);
  const staleInfo = await new Promise<{ role: string }>((resolve) => staleSocket.once('connected', resolve));
  assert.equal(staleInfo.role, 'TEACHER');
  await prisma.user.update({ where: { id: admin.sub }, data: { role: 'ADMIN' } });
  check('Socket 与 HTTP 共用数据库身份加载，旧管理员 JWT 不保留角色');
  const snapshot = await exportSnapshot(prisma, 'sqlite');
  const legacy = structuredClone(snapshot);
  for (const g of legacy.data.PermissionGroup)
    if (g.id === readOnly.id) {
      g.scope = 'SELF_CLASS';
      g.scopeValue = 'HEAD';
    }
  for (const a of legacy.data.UserPermissionGroup) {
    delete a.scope;
    delete a.scopeValue;
  }
  await restoreSnapshot(prisma, 'sqlite', legacy);
  assert.equal(
    (
      await prisma.userPermissionGroup.findFirstOrThrow({
        where: { userId: aTeacher.sub, groupId: readOnly.id },
      })
    ).scope,
    'HEAD',
  );
  assert.equal(
    (await prisma.permissionGroup.findUniqueOrThrow({ where: { defaultRole: 'TEACHER' } })).scope,
    'TEACHING',
  );
  assert.throws(() => parsePermissionScope('SELF_CLASS' as never, ''));
  check('旧快照按模板回填分配、默认模板归一化、运行时拒绝旧范围枚举');
  check(`授权攻击矩阵完成，夹具 ${studentA.id} / ${mathA.id} 均位于临时库`);
} finally {
  for (const s of sockets) s.disconnect();
  await new Promise<void>((resolve) => realtime.close(() => resolve()));
  server.closeAllConnections();
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
}
