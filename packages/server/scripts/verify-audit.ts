import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../src/lib/db.js';
import { env } from '../src/config/env.js';
import type { TokenPayload } from '../src/lib/jwt.js';
import { ensureDefaultGroups } from '../src/lib/permissions.js';
import { createCourse } from '../src/modules/courses/courses.service.js';
import { bulkCreateGrades, createGrade, updateGradeLevels } from '../src/modules/grades/grades.service.js';
import { pushUpdate } from '../src/modules/clients/clients.service.js';
import { markAsRead } from '../src/modules/notifications/notifications.service.js';
import { exportSnapshot, restoreSnapshot, SNAPSHOT_TABLES } from '../src/lib/snapshot.js';
import { heartbeat } from '../src/modules/clients/clients.service.js';

if (!process.env.DATABASE_URL?.includes('authz-verification')) throw new Error('审计验收只能使用隔离数据库');
Reflect.set(env, 'serverRoot', path.join(path.dirname(process.env.DATABASE_URL.slice(5)), 'server'));

const counters: Record<string, number> = {};
const restorers: Array<() => void> = [];
for (const model of [
  'permissionGroup',
  'class',
  'course',
  'student',
  'grade',
  'classPlan',
  'scheduledClassPlan',
  'termWeek',
  'timeLayout',
  'timeLayoutItem',
  'appSetting',
]) {
  const delegate = Reflect.get(prisma, model) as object;
  for (const method of ['findUnique', 'findFirst', 'findMany', 'count', 'upsert', 'create', 'update']) {
    const original: unknown = Reflect.get(delegate, method);
    if (typeof original !== 'function') continue;
    const key = `${model}.${method}`;
    Reflect.set(delegate, method, (...args: unknown[]) => {
      counters[key] = (counters[key] ?? 0) + 1;
      return Reflect.apply(original, delegate, args);
    });
    restorers.push(() => Reflect.set(delegate, method, original));
  }
}
const metrics: Record<string, unknown> = {};
const failures: string[] = [];
let passed = 0;
async function check(name: string, run: () => Promise<void>) {
  try {
    await run();
    console.log(`通过 ${++passed}：${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`失败：${name}：${error instanceof Error ? error.message : String(error)}`);
  }
}
function resetCounts() {
  for (const key of Object.keys(counters)) delete counters[key];
}
async function account(name: string, role: TokenPayload['role']): Promise<TokenPayload> {
  const row = await prisma.user.create({ data: { name, username: name, role, passwordHash: '隔离夹具' } });
  return { sub: row.id, name, username: name, role, classId: null };
}
try {
  await check('快照清单覆盖 schema 与迁移后实际业务表', async () => {
    const schema = fs.readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
    const models = [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((match) => match[1]);
    const tables = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '_prisma_migrations'",
    );
    assert.deepEqual([...SNAPSHOT_TABLES].sort(), models.sort());
    assert.deepEqual([...SNAPSHOT_TABLES].sort(), tables.map((row) => row.name).sort());
  });
  const admin = await account('audit-admin', 'ADMIN');
  const head = await account('audit-head', 'TEACHER');
  const lead = await account('audit-lead', 'TEACHER');
  const cls = await prisma.class.create({
    data: {
      name: '审计班级',
      grade: '高一',
      enrollmentYear: 2026,
      classIndex: 91,
      code: 'AUDIT91',
      teacherId: head.sub,
    },
  });
  const other = await prisma.class.create({
    data: {
      name: '审计外班',
      grade: '高二',
      enrollmentYear: 2026,
      classIndex: 92,
      code: 'AUDIT92',
      teacherId: head.sub,
    },
  });
  const course = await prisma.course.create({ data: { classId: cls.id, name: '数学', teacherId: head.sub } });
  const students = await Promise.all(
    Array.from({ length: 50 }, (_, i) =>
      prisma.student.create({ data: { classId: cls.id, name: `临时${i}`, studentNo: `AUDIT-${i}` } }),
    ),
  );
  const outsider = await prisma.student.create({
    data: { classId: other.id, name: '外班', studentNo: 'AUDIT-OUT' },
  });
  await ensureDefaultGroups();
  await check('默认组成功初始化后不重复写库', async () => {
    resetCounts();
    await ensureDefaultGroups();
    await ensureDefaultGroups();
    const operations = Object.values(counters).reduce((sum, n) => sum + n, 0);
    metrics.defaultGroupOperationsForTwoCalls = operations;
    assert.equal(operations, 0);
  });
  const group = await prisma.permissionGroup.create({
    data: {
      name: '审计年级岗',
      items: { create: ['schedule:write', 'grade:write'].map((key) => ({ key })) },
    },
  });
  await prisma.userPermissionGroup.create({
    data: { userId: lead.sub, groupId: group.id, scope: 'GRADE', scopeValue: '高一' },
  });
  await check('年级课表维护者不能通过建课取得任课关系', async () => {
    let created;
    try {
      created = await createCourse(lead, { classId: cls.id, name: '自授权科目' });
    } catch (error) {
      assert.equal(Reflect.get(error as object, 'status'), 403);
      return;
    }
    await createGrade(lead, {
      classId: cls.id,
      courseId: created.id,
      studentId: students[0]!.id,
      examName: '攻击链',
      score: 99,
    });
    assert.fail('仅有年级课表维护范围的教师已自建任课并写入成绩');
  });
  await check('批量成绩的末行越班不会留下首行', async () => {
    await assert.rejects(
      bulkCreateGrades(admin, {
        classId: cls.id,
        courseId: course.id,
        examName: '末行无效',
        items: [
          { studentId: students[0]!.id, score: 80 },
          { studentId: outsider.id, score: 90 },
        ],
      }),
    );
    assert.equal(await prisma.grade.count({ where: { examName: '末行无效' } }), 0);
  });
  await check('批量成绩中途数据库失败整批回滚', async () => {
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER audit_grade_failure BEFORE INSERT ON Grade WHEN NEW.examName = '事务失败' AND NEW.studentId = '${students[1]!.id}' BEGIN SELECT RAISE(ABORT, 'audit injected failure'); END`,
    );
    try {
      await assert.rejects(
        bulkCreateGrades(admin, {
          classId: cls.id,
          courseId: course.id,
          examName: '事务失败',
          items: students.slice(0, 2).map((s) => ({ studentId: s.id, score: 80 })),
        }),
      );
      assert.equal(await prisma.grade.count({ where: { examName: '事务失败' } }), 0);
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER audit_grade_failure');
    }
  });
  await check('同班同科50条等级修改只授权一次', async () => {
    const rows = await bulkCreateGrades(admin, {
      classId: cls.id,
      courseId: course.id,
      examName: '性能测量',
      items: students.map((s) => ({ studentId: s.id, score: 80 })),
    });
    resetCounts();
    await updateGradeLevels({ ...head }, { items: rows.map((r) => ({ id: r.id, level: 'A' })) });
    const calls = counters['course.findUnique'] ?? 0;
    metrics.gradeLevelCourseLookupsFor50Rows = calls;
    assert.equal(calls, 1);
    assert.equal(await prisma.grade.count({ where: { examName: '性能测量', level: 'A' } }), 50);
  });
  await check('同班20设备放学更新仅解析一次课表', async () => {
    const version = 'audit-1.0.0';
    const fileName = 'audit-fixture.exe';
    const dir = path.join(env.serverRoot, '..', 'data', 'client-releases', version);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, fileName);
    fs.writeFileSync(file, '隔离夹具，不是可执行安装器');
    try {
      await prisma.clientRelease.create({
        data: { version, fileName, size: fs.statSync(file).size, sha256: '0'.repeat(64) },
      });
      const devices = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          prisma.clientDevice.create({ data: { deviceKey: `audit-device-${i}`, classId: cls.id } }),
        ),
      );
      resetCounts();
      await pushUpdate(admin, {
        version,
        mode: 'after-school',
        afterSchoolTime: '17:00',
        deviceIds: devices.map((d) => d.id),
      });
      metrics.afterSchoolClassLookupsFor20Devices = counters['class.findUnique'] ?? 0;
      assert.equal(counters['class.findUnique'], 1);
      const updated = await prisma.clientDevice.findMany({ where: { classId: cls.id } });
      assert.equal(new Set(updated.map((d) => d.updateNotBefore?.toISOString())).size, 1);
    } finally {
      fs.unlinkSync(file);
      fs.rmdirSync(dir);
    }
  });
  await check('并发标记同一通知已读均成功且记录唯一', async () => {
    const notice = await prisma.notification.create({
      data: { classId: cls.id, title: '竞态', content: '临时', createdBy: head.sub },
    });
    const device: TokenPayload = {
      sub: cls.id,
      name: cls.name,
      username: cls.code,
      role: 'CLASS_DEVICE',
      classId: cls.id,
      classSession: true,
    };
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => markAsRead({ ...device }, notice.id)),
    );
    assert.equal(results.filter((r) => r.status === 'rejected').length, 0);
    assert.equal(await prisma.notificationRead.count({ where: { notificationId: notice.id } }), 50);
  });
  await check('并发首次心跳保持设备归属并全部成功', async () => {
    const actor: TokenPayload = {
      sub: cls.id,
      name: cls.name,
      username: cls.code,
      role: 'CLASS_DEVICE',
      classId: cls.id,
      classSession: true,
    };
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        heartbeat({ ...actor }, { deviceKey: 'audit-first-heartbeat' }, '127.0.0.1'),
      ),
    );
    assert.equal(results.filter((r) => r.status === 'rejected').length, 0);
    assert.equal(
      await prisma.clientDevice.count({ where: { deviceKey: 'audit-first-heartbeat', classId: cls.id } }),
      1,
    );
  });
  await check('快照恢复写入失败时原库完整保留', async () => {
    const before = await exportSnapshot(prisma, 'sqlite');
    const broken = structuredClone(before);
    broken.data.Grade[0]!.score = 'invalid-score';
    await assert.rejects(restoreSnapshot(prisma, 'sqlite', broken));
    assert.equal(await prisma.grade.count(), before.counts.Grade);
    assert.equal(await prisma.user.count(), before.counts.User);
  });
  console.log(`审计指标（Prisma 模型操作数，不等同底层 SQL 数）：${JSON.stringify(metrics)}`);
  console.log(`审计专项：${passed} 通过，${failures.length} 失败`);
  if (failures.length) process.exitCode = 1;
} finally {
  for (const restore of restorers) restore();
  await prisma.$disconnect();
}
