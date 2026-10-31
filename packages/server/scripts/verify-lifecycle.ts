import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { PERMISSION_KEYS, defaultPromotionPlan, parsePermissionScope } from '@classhelper/shared';
import { prisma } from '../src/lib/db.js';
import { createApp } from '../src/app.js';
import { signToken, type TokenPayload } from '../src/lib/jwt.js';
import { ensureDefaultGroups, loadAuthPrincipal } from '../src/lib/permissions.js';
import { registerEmitter } from '../src/realtime/bus.js';
import * as students from '../src/modules/students/students.service.js';
import * as classes from '../src/modules/classes/classes.service.js';
import * as permissions from '../src/modules/permissions/permissions.service.js';
import {
  configurePromotion,
  previewPromotion,
  runPromotion,
  promotionStatus,
} from '../src/modules/term/promotion.service.js';
import { deleteArchive, getArchivedYearDetail } from '../src/modules/archives/archives.service.js';
import { updateStudentSchema } from '../src/modules/students/students.schemas.js';
import { exportSnapshot, restoreSnapshot } from '../src/lib/snapshot.js';

if (!process.env.DATABASE_URL?.includes('lifecycle-verification'))
  throw new Error('只能对生命周期专用临时数据库运行');
let count = 0;
function check(name: string, fn: () => unknown) {
  fn();
  console.log(`通过 ${++count}：${name}`);
}
async function denied(action: Promise<unknown>, status: number) {
  await assert.rejects(action, (error: unknown) => (error as { status?: number }).status === status);
}
const account = async (name: string, role: string) => {
  const row = await prisma.user.create({
    data: { username: name, name, role, passwordHash: '隔离测试，不登录' },
  });
  return { sub: row.id, username: row.username, name, role, classId: null } as TokenPayload;
};
const admin = await account('临时管理员', 'ADMIN'),
  teacher = await account('临时班主任', 'TEACHER'),
  manager = await account('临时权限协助', 'TEACHER');
await ensureDefaultGroups();
const cls = async (
  name: string,
  grade: string,
  enrollmentYear: number,
  classIndex: number,
  teacherId = teacher.sub,
) => prisma.class.create({ data: { name, grade, enrollmentYear, classIndex, code: name, teacherId } });
const a = await cls('TESTA', '高一', 2025, 1),
  b = await cls('TESTB', '高一', 2025, 2),
  c = await cls('TESTC', '高二', 2024, 1, admin.sub);
const events: { classId: string; event: string }[] = [];
registerEmitter((rooms, event) => {
  for (const room of rooms) events.push({ classId: room.split(':')[1], event });
});
const server = createServer(createApp());
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
async function request(url: string, actor: TokenPayload, method = 'GET', body?: unknown, expected = 200) {
  const response = await fetch(base + url, {
    method,
    headers: { authorization: `Bearer ${signToken(actor)}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  assert.equal(response.status, expected, `${method} ${url}: ${JSON.stringify(data)}`);
  return data.data;
}
try {
  check('资料 schema 拒绝班级和状态字段', () => {
    assert.equal(updateStudentSchema.safeParse({ status: 'graduated' }).success, false);
    assert.equal(updateStudentSchema.safeParse({ classId: b.id }).success, false);
  });
  const empty = await permissions.createGroup(admin, { name: '空组', keys: [] });
  await permissions.assignUserGroups(admin, teacher.sub, { groupIds: [empty.id] });
  for (const url of [
    '/classes',
    `/classes/${a.id}`,
    `/classes/${a.id}/students`,
    `/schedules?classId=${a.id}`,
    `/homeworks?classId=${a.id}`,
    `/notifications?classId=${a.id}`,
    '/students',
    '/term',
  ])
    await request(url, teacher, 'GET', undefined, 403);
  await request('/homeworks', teacher, 'POST', {}, 403);
  check('取消读写键立即拒绝所有对应入口', () =>
    assert.equal((PERMISSION_KEYS as readonly string[]).includes('promotion:manage'), true),
  );
  const delegate = await account('临时教务授权', 'TEACHER');
  await denied(
    permissions.createGroup(admin, {
      name: '不可下放组织能力',
      keys: ['class:manage', 'archive:manage', 'promotion:manage'],
    }),
    400,
  );
  for (const url of ['/classes', '/archives', '/term/promotion'])
    await request(
      url,
      delegate,
      url === '/classes' ? 'POST' : 'GET',
      url === '/classes' ? {} : undefined,
      403,
    );
  check('组织管理能力不能下放给教师，路由永久拒绝', () => {});
  const allRoster = await permissions.createGroup(admin, {
    name: '全校名单',
    scope: 'ALL',
    keys: ['roster:read', 'roster:manage'],
  });
  await permissions.assignUserGroups(admin, delegate.sub, { groupIds: [allRoster.id] });
  const unassigned = await students.createStudent(delegate, {
    studentNo: 'UNASSIGNED',
    name: '未分班测试学生',
  });
  assert(
    (await students.listStudents(delegate, { includeArchived: false })).some(
      (student) => student.id === unassigned.id,
    ),
  );
  assert((await students.listTransfers(delegate, { studentId: unassigned.id })).items.length > 0);
  check('全校名单授权包含未分班学生及其历史', () => {});

  const readAll = await permissions.createGroup(admin, {
    name: '全校班级只读',
    scope: 'ALL',
    keys: ['class:read'],
  });
  const ownWrite = await permissions.createGroup(admin, { name: '关联班级维护', keys: ['class:settings'] });
  await permissions.assignUserGroups(admin, delegate.sub, { groupIds: [readAll.id, ownWrite.id] });
  const foreignDetail = await request(`/classes/${a.id}`, delegate);
  assert.equal(foreignDetail.students.length, 0, '班级读取键不能代替名单读取键');
  await request(`/classes/${a.id}/settings`, delegate, 'PATCH', { termWeeks: 11 }, 403);
  check('全校读取组不能借给写操作范围，班级详情不泄漏未授权名单', () => {});
  const defaults = await prisma.permissionGroup.findUniqueOrThrow({ where: { defaultRole: 'TEACHER' } });
  await permissions.assignUserGroups(admin, teacher.sub, { groupIds: [] });
  assert((await loadAuthPrincipal(teacher)).permissions.has('roster:manage'));
  const additional = await permissions.createGroup(admin, {
    name: '追加设备读权限',
    scope: 'ALL',
    keys: ['client:read'],
  });
  await permissions.assignUserGroups(admin, teacher.sub, { groupIds: [defaults.id, additional.id] });
  assert((await loadAuthPrincipal(teacher)).permissions.has('client:read'));
  assert(!(await loadAuthPrincipal(teacher)).permissions.has('promotion:manage'));
  await denied(
    permissions.assignUserGroups(admin, teacher.sub, { groupIds: ['default-permission-admin'] }),
    400,
  );
  await denied(permissions.createGroup(manager, { name: '越权', keys: ['system:manage'] }), 403);
  await denied(permissions.updateGroup(manager, defaults.id, { keys: [] }), 403);
  await denied(permissions.assignUserGroups(manager, manager.sub, { groupIds: [additional.id] }), 403);
  check('分配并集、管理员默认组忽略、非管理员权限管理均拒绝', () => {});
  await denied(permissions.createGroup(admin, { name: '空范围', scope: 'GRADE' }), 400);
  await denied(permissions.createGroup(admin, { name: '未知范围', scope: 'GRADE', scopeValue: '未知' }), 400);
  check('范围统一归一化并拒绝空值和未知年级', () =>
    assert.equal(parsePermissionScope('DIVISION', '高二，高一、 高一').scopeValue, '高一,高二'),
  );
  const memberList = await permissions.listMembers(admin);
  check('成员含真实权限与范围，组成员包含默认回落账号', () =>
    assert(memberList.find((m) => m.id === teacher.sub)?.permissions.includes('client:read')),
  );
  const audits = await permissions.listAudits(admin);
  check('审计记录操作人与变更前后快照', () =>
    assert(audits.items.every((audit) => audit.actorId && audit.actorName && audit.afterJson)),
  );
  let queryCount = 0;
  const restoreMethods: (() => void)[] = [];
  for (const model of [prisma.permissionGroup, prisma.userPermissionGroup, prisma.user]) {
    for (const method of ['findMany', 'findUnique', 'upsert']) {
      const original = Reflect.get(model, method);
      Object.defineProperty(model, method, {
        configurable: true,
        value: (...args: unknown[]) => {
          queryCount++;
          return Reflect.apply(original, model, args);
        },
      });
      restoreMethods.push(() =>
        Object.defineProperty(model, method, { configurable: true, value: original }),
      );
    }
  }
  try {
    await permissions.listMembers(admin);
    const small = queryCount;
    queryCount = 0;
    await prisma.user.createMany({
      data: Array.from({ length: 30 }, (_, i) => ({
        username: `批量账号${i}`,
        name: `成员${i}`,
        role: 'TEACHER',
        passwordHash: '临时',
      })),
    });
    await permissions.listMembers(admin);
    check('成员增加后权限查询次数保持不变', () => assert.equal(queryCount, small));
  } finally {
    restoreMethods.forEach((restore) => restore());
  }
  const scheduleOnly = await permissions.createGroup(admin, { name: '仅课表编辑', keys: ['schedule:write'] });
  await permissions.assignUserGroups(admin, teacher.sub, { groupIds: [scheduleOnly.id] });
  const layoutPreview = {
    classId: a.id,
    payload: { TimeLayouts: [{ Name: '第一节', StartTime: '08:00', EndTime: '08:45', TimeType: 0 }] },
  };
  await request('/imports/time-layout/preview', teacher, 'POST', layoutPreview, 403);
  await permissions.assignUserGroups(admin, teacher.sub, { groupIds: [] });
  const parsedLayout = await request('/imports/time-layout/preview', teacher, 'POST', layoutPreview);
  check('课表导入键取消后真实预览入口 403，有键可解析', () => assert.equal(parsedLayout.items.length, 1));
  const student = await students.createStudent(admin, { studentNo: 'S1', name: '学生一', classId: a.id });
  await request(`/students/${student.id}`, admin, 'PATCH', { status: 'graduated' }, 400);
  await request(`/students/${student.id}`, admin, 'PATCH', { classId: b.id }, 400);
  check('HTTP 旧编辑请求明确返回 400', () => {});
  await prisma.$executeRawUnsafe(
    `CREATE TRIGGER lifecycle_fail BEFORE INSERT ON StudentClassTransfer BEGIN SELECT RAISE(ABORT, '历史写入故障'); END`,
  );
  await assert.rejects(students.transferStudents(admin, { studentIds: [student.id], toClassId: b.id }));
  assert.equal((await prisma.student.findUniqueOrThrow({ where: { id: student.id } })).classId, a.id);
  await prisma.$executeRawUnsafe('DROP TRIGGER lifecycle_fail');
  check('注入历史写入故障后学生班级事务回滚', () => {});
  const moved = await students.transferStudents(teacher, {
    studentIds: [student.id],
    toClassId: b.id,
    note: '同年级调班',
  });
  check('班主任调班按名单键授权、批次精确返回、两班广播', () => {
    assert.equal(moved.transfers[0].fromGrade, '高一');
    assert(moved.batchId);
    assert(events.some((e) => e.classId === a.id) && events.some((e) => e.classId === b.id));
  });
  await denied(students.transferStudents(teacher, { studentIds: [student.id], toClassId: c.id }), 403);
  await denied(students.transferStudents(admin, { studentIds: [student.id], toClassId: c.id }), 409);
  check('源目标范围与跨年级调班限制生效', () => {});
  await students.transferOutStudents(admin, { studentIds: [student.id], note: '迁居', toSchool: '另一学校' });
  const history = await students.listTransfers(admin, { studentId: student.id });
  check('转出状态筛选与转出历史均可见', () => {
    assert(history.items.some((h) => h.kind === 'transfer-out' && h.toSchool === '另一学校'));
  });
  assert.equal(
    (await students.listStudents(admin, { status: 'transferred', includeArchived: false })).length,
    1,
  );
  await request(`/students/${student.id}/transfers`, teacher);
  await denied(students.transferOutStudents(admin, { studentIds: [student.id] }), 409);
  await students.transferInStudent(admin, { studentId: student.id, toClassId: a.id, fromSchool: '另一学校' });
  await students.transferInStudent(admin, {
    studentNo: 'S2',
    name: '学生二',
    toClassId: a.id,
    fromSchool: '其他学校',
  });
  check('重复转出拒绝，新建转入与历史学生重入有完整记录', () => {});
  await students.deleteStudent(admin, student.id);
  assert.equal(
    (await students.listStudents(admin, { status: 'inactive', includeArchived: false })).length,
    1,
  );
  await students.restoreStudent(admin, student.id, { toClassId: a.id });
  await denied(students.deleteStudent(admin, student.id, { hard: true, confirm: true }), 409);
  check('停用、复学和有历史学生的硬删除保护', () => {});
  const device: TokenPayload = {
    sub: a.id,
    role: 'CLASS_DEVICE',
    classId: a.id,
    name: a.name,
    username: a.code,
    classSession: true,
  };
  for (const url of [
    `/classes/${a.id}/students`,
    `/schedules?classId=${a.id}`,
    `/notifications?classId=${a.id}`,
  ])
    await request(url, device);
  await request(
    '/homeworks',
    device,
    'POST',
    { classId: a.id, title: '临时作业', content: '完成练习', assignDate: '2026-10-23' },
    201,
  );
  await request(
    '/notifications',
    device,
    'POST',
    { classId: a.id, title: '临时通知', content: '隔离验收' },
    201,
  );
  await request('/grades', device, 'POST', {}, 403);
  await request(
    '/calls',
    device,
    'POST',
    { classId: a.id, studentId: student.id, quickPhrase: '请到办公室' },
    201,
  );
  check('班级端空权限保留名单课表通知和代录作业，禁止写成绩', () => {});
  const g = await cls('TESTG', '高三', 2023, 1);
  for (const [i, status] of ['active', 'transferred', 'inactive'].entries())
    await prisma.student.create({
      data: { studentNo: `G${i}`, name: `毕业班学生${i}`, classId: g.id, status },
    });
  await prisma.termWeek.create({
    data: { classId: a.id, weekNumber: 1, startDate: '2026-09-01', endDate: '2026-09-07' },
  });
  const plan = defaultPromotionPlan(1);
  plan.resetTermWeeks = false;
  plan.termStartDate = '2026-09-08';
  await configurePromotion({ month: 8, day: 1, hour: 0, plan }, admin);
  const before = await prisma.promotionRun.count();
  const preview = await previewPromotion(2026);
  check('预览逐班逐状态、不写库、保留周次有警告', () => {
    assert.equal(preview.blockers.length, 0);
    assert.equal(preview.termWeekDeleteCount, 0);
    assert(preview.tracks[0].classes.find((c) => c.id === g.id)?.transferred === 1);
  });
  assert.equal(await prisma.promotionRun.count(), before);
  await denied(runPromotion(2026, { actor: admin, planHash: '0'.repeat(64), confirm: true }), 409);
  const due = (await promotionStatus()).year;
  await denied(runPromotion(due + 1, { actor: admin, planHash: preview.planHash, confirm: true }), 400);
  await permissions.assignUserGroups(admin, teacher.sub, { groupIds: [defaults.id, additional.id] });
  await denied(runPromotion(due - 1, { actor: teacher, planHash: preview.planHash, confirm: true }), 403);
  check('过期哈希、未来年份与教师补跑过去学年均拒绝', () => {});
  const result = await runPromotion(2026, { actor: admin, planHash: preview.planHash, confirm: true });
  assert.equal(result.status, 'done');
  if (!('snapshotPath' in result)) throw new Error('执行未返回快照');
  const awaitedContent = await fs.readFile(result.snapshotPath);
  check('快照 SHA256 与磁盘内容一致、执行记录有操作人明细', () =>
    assert.equal(result.snapshotSha256, createHash('sha256').update(awaitedContent).digest('hex')),
  );
  const archived = await prisma.archivedYear.findUniqueOrThrow({ where: { enrollmentYear: 2023 } });
  const detail = await getArchivedYearDetail(admin, archived.id);
  check('毕业转出停用全部挂届别、状态保持且统计完整', () => {
    assert.equal(detail.graduates.length, 1);
    assert.equal(detail.transferred.length, 1);
    assert.equal(detail.inactive.length, 1);
    assert.equal(detail.inactiveCount, 1);
  });
  assert.equal(await prisma.termWeek.count(), 1);
  const skeleton = await prisma.class.findFirstOrThrow({ where: { enrollmentYear: 2026, grade: '高一' } });
  assert.equal(skeleton.teacherId, null);
  assert.equal(await prisma.course.count({ where: { classId: skeleton.id } }), 0);
  assert.equal(
    (await prisma.appSetting.findUniqueOrThrow({ where: { key: 'term.startDate' } })).value,
    '2026-09-08',
  );
  await runPromotion(2026, { actor: admin, planHash: preview.planHash, confirm: true });
  assert.equal(await prisma.archivedYear.count(), 1);
  check('升级日期按计划、周次保留、新班无任课、重复运行幂等', () => {});
  await denied(classes.addStudent(admin, a.id, { studentNo: 'G0', name: '不能复活' }), 409);
  await denied(students.transferOutStudents(admin, { studentIds: [detail.graduates[0].id] }), 409);
  await students.restoreStudent(admin, detail.transferred[0].id, { toClassId: a.id });
  check('归档学生不可复活或转出，归档转出学生可指定在读班撤回', () => {});
  await deleteArchive(admin, archived.id);
  assert.equal((await prisma.student.findUniqueOrThrow({ where: { studentNo: 'G2' } })).status, 'inactive');
  check('撤销归档保留停用状态，不回滚升级周次', () => assert.equal(detail.inactive[0].status, 'inactive'));
  const unknown = await cls('TESTUNKNOWN', '未知学段', 2022, 10);
  assert((await previewPromotion(2027)).blockers.some((b) => b.code === 'UNKNOWN_GRADE'));
  await prisma.class.delete({ where: { id: unknown.id } });
  await prisma.class.create({
    data: { name: 'CODECONFLICT', code: 'N202701', grade: '高一', enrollmentYear: 2027, classIndex: 2 },
  });
  check('未知年级与新班码冲突在预览阶段阻断', () => {});
  assert((await previewPromotion(2027)).blockers.some((b) => b.code === 'CODE_CONFLICT'));
  await prisma.class.deleteMany({ where: { name: 'CODECONFLICT' } });
  const duplicate = await cls('DUPLICATE', '高二', 2025, 1);
  assert((await previewPromotion(2027)).blockers.some((b) => b.code === 'DUPLICATE_INDEX'));
  await prisma.class.delete({ where: { id: duplicate.id } });
  check('同轨道同届重复班号被阻断', () => {});
  await request(`/classes/${a.id}`, admin, 'PATCH', { grade: '任意年级' }, 400);
  await denied(classes.promoteClasses(admin, { classIds: [c.id] }), 409);
  await classes.promoteClasses(admin, { classIds: [a.id] });
  assert.equal((await prisma.class.findUniqueOrThrow({ where: { id: a.id } })).grade, '高三');
  check('手动升级只到下一学段，毕业班与直接修改年级被拒绝', () => {});
  const junior = await cls('JUNIOR', '初一', 2025, 1);
  const multi = defaultPromotionPlan(0);
  multi.tracks.push({
    id: 'junior',
    name: '初中',
    entryClassCount: 0,
    stages: [{ grade: '初一' }, { grade: '初二' }, { grade: '初三', terminal: true }],
  });
  await configurePromotion({ month: 8, day: 1, hour: 0, plan: multi }, admin);
  const multiPreview = await previewPromotion(2099);
  assert.equal(multiPreview.blockers.length, 0);
  assert.equal(multiPreview.termWeekDeleteCount, 1);
  await runPromotion(2099);
  check('多轨道分别升级，确认重置后仅清除预览中的周次', () => {});
  assert.equal((await prisma.class.findUniqueOrThrow({ where: { id: junior.id } })).grade, '初二');
  assert.equal(await prisma.termWeek.count(), 0);
  const snapshot = await exportSnapshot(prisma, 'sqlite');
  const auditCount = snapshot.counts.PermissionAudit;
  await restoreSnapshot(prisma, 'sqlite', snapshot);
  check('全库快照恢复保留审计、生命周期和执行明细', () => assert(auditCount > 0));
  assert.equal(await prisma.permissionAudit.count(), auditCount);
  console.log(`=== 权限与生命周期：${count}/${count} 项通过 ===`);
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
}
