import { registerEmitter } from '../src/realtime/bus.js';
import { existsSync as awaitedSnapshotPath } from 'node:fs';
/** 独立临时数据库上的新增能力验收；不导入 index.ts，不运行自动升级或系统命令。 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { prisma } from '../src/lib/db.js';
import { createApp } from '../src/app.js';
import { signToken } from '../src/lib/jwt.js';
import { ensureDefaultGroups } from '../src/lib/permissions.js';
import { runPromotion } from '../src/modules/term/promotion.service.js';
import { exportSnapshot } from '../src/lib/snapshot.js';
import { createAutostartController } from '../src/modules/system/autostart.js';
import { getMaxTermWeeks } from '../src/lib/term.js';
import { setSetting, SETTING_KEYS } from '../src/lib/settings.js';
import {
  CLASSISLAND_ISLAND_METRICS,
  normalizeIslandLayouts,
  defaultIslandLayouts,
  buildAutoTermWeeks,
} from '@classhelper/shared';
if (!process.env.DATABASE_URL?.includes('v14-verification')) throw new Error('只能对专用临时验证数据库运行');
let count = 0;
function check(name: string, fn: () => void) {
  fn();
  count++;
  console.log(`通过 ${count}：${name}`);
}
const prefix = `v14-${Date.now()}`;
const admin = await prisma.user.create({
  data: {
    username: `${prefix}-admin`,
    name: '临时管理员',
    passwordHash: '无登录口令，仅本次签发测试令牌',
    role: 'ADMIN',
  },
});
const teacher = await prisma.user.create({
  data: {
    username: `${prefix}-teacher`,
    name: '临时教师',
    passwordHash: '无登录口令，仅本次签发测试令牌',
    role: 'TEACHER',
  },
});
const lead = await prisma.user.create({
  data: {
    username: `${prefix}-lead`,
    name: '临时级长',
    passwordHash: '无登录口令，仅本次签发测试令牌',
    role: 'TEACHER',
  },
});
const division = await prisma.user.create({
  data: {
    username: `${prefix}-division`,
    name: '临时部长',
    passwordHash: '无登录口令，仅本次签发测试令牌',
    role: 'TEACHER',
  },
});
const head = await prisma.user.create({
  data: {
    username: `${prefix}-head`,
    name: '临时班主任',
    passwordHash: '无登录口令，仅本次签发测试令牌',
    role: 'TEACHER',
  },
});
const token = (u: { id: string; username: string; name: string; role: string }) =>
  signToken({
    sub: u.id,
    username: u.username,
    name: u.name,
    role: u.role as 'ADMIN' | 'TEACHER',
    classId: null,
  });
await ensureDefaultGroups();
await setSetting(SETTING_KEYS.termMaxWeeks, '60');
const cls = await prisma.class.create({
  data: {
    name: '临时高一班',
    grade: '高一',
    enrollmentYear: 2090,
    classIndex: 1,
    code: `V${Date.now()}A`,
    teacherId: teacher.id,
    termWeeks: 60,
    termStartDate: '2026-09-07',
  },
});
const other = await prisma.class.create({
  data: {
    name: '临时高二班',
    grade: '高二',
    enrollmentYear: 2089,
    classIndex: 1,
    code: `V${Date.now()}B`,
    teacherId: head.id,
    termWeeks: 60,
    termStartDate: '2026-09-07',
  },
});
const third = await prisma.class.create({
  data: { name: '临时其他部班', grade: '初一', code: `V${Date.now()}C`, teacherId: head.id },
});
const course = await prisma.course.create({ data: { name: '语文', classId: cls.id, teacherId: teacher.id } }),
  math = await prisma.course.create({ data: { name: '数学', classId: cls.id, teacherId: teacher.id } });
const outsider = await prisma.course.create({
  data: { name: '英语', classId: other.id, teacherId: head.id },
});
for (const [userId, id, scopeValue] of [
  [lead.id, 'builtin-grade', '高一'],
  [division.id, 'builtin-division', '高一,高二'],
  [head.id, 'builtin-head', 'HEAD'],
  [teacher.id, 'builtin-teacher', ''],
] as const) {
  const scope =
    id === 'builtin-grade'
      ? 'GRADE'
      : id === 'builtin-division'
        ? 'DIVISION'
        : id === 'builtin-head'
          ? 'HEAD'
          : 'TEACHING';
  await prisma.userPermissionGroup.create({
    data: { userId, groupId: id, scope, scopeValue: ['GRADE', 'DIVISION'].includes(scope) ? scopeValue : '' },
  });
}
const server = createServer(createApp());
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as { port: number }).port;
async function request(path: string, method = 'GET', data?: unknown, auth = token(admin), expected = 200) {
  const res = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const value = await res.json();
  assert.equal(res.status, expected, `${method} ${path}：${JSON.stringify(value)}`);
  return value.data;
}
try {
  const points = [
    { name: '第一节', startTime: '08:00', endTime: '08:45', timeType: 'LESSON' },
    { name: '课间', startTime: '08:45', endTime: '09:00', timeType: 'BREAK' },
    { name: '分隔', startTime: '09:00', endTime: '09:00', timeType: 'DIVIDER' },
    {
      name: '行动',
      startTime: '09:00',
      endTime: '09:05',
      timeType: 'ACTION',
      actionSet: '{"测试":"不执行"}',
    },
    { name: '第二节', startTime: '09:05', endTime: '09:50', timeType: 'LESSON' },
  ];
  await request('/time-layouts', 'POST', { name: '越权', points }, token(teacher), 403);
  check('教师不能管理全校时间表', () => {});
  const layout = await request('/time-layouts', 'POST', { name: `${prefix}作息`, points }, undefined, 201);
  check('四种时间点均保存', () =>
    assert.equal(new Set(layout.points.map((p: { timeType: string }) => p.timeType)).size, 4),
  );
  const plan = await request(
    '/class-plans',
    'POST',
    {
      classId: cls.id,
      name: '四周轮换第3周周三',
      timeLayoutId: layout.id,
      weekday: 3,
      weekCountDiv: 3,
      weekCountDivTotal: 4,
      weekEnd: 60,
    },
    undefined,
    201,
  );
  const entryPoints = layout.points.filter((p: { timeType: string }) => p.timeType === 'LESSON');
  await request(`/class-plans/${plan.id}/entries`, 'PUT', {
    entries: entryPoints.map((p: { id: string }, i: number) => ({
      timeLayoutItemId: p.id,
      courseId: i ? math.id : course.id,
    })),
  });
  const at = encodeURIComponent('2026-09-23T08:10:00+08:00');
  let status = await request(`/schedules/current?classId=${cls.id}&at=${at}`);
  check('第3周周三唯一解析器上课', () => {
    assert.equal(status.week, 3);
    assert.equal(status.current.courseName, '语文');
    assert.equal(status.inClass, true);
  });
  const week2 = await request(
    `/schedules/current?classId=${cls.id}&at=${encodeURIComponent('2026-09-16T08:10:00+08:00')}`,
  );
  check('4周轮换不误命中第2周', () => assert.equal(week2.inClass, false));
  await request(`/time-layouts/${layout.id}`, 'PUT', { ...layout, points: [...layout.points].reverse() });
  status = await request(`/schedules/current?classId=${cls.id}&at=${at}`);
  check('排序后显式外键保持语文时段', () => assert.equal(status.current.courseName, '语文'));
  const beforeFirst = await request(
    `/schedules/current?classId=${cls.id}&at=${encodeURIComponent('2026-09-23T07:00:00+08:00')}`,
  );
  check('时间点排序后下一节仍按实际时间选择', () => assert.equal(beforeFirst.next.courseName, '语文'));
  await request(
    `/class-plans/${plan.id}/entries`,
    'PUT',
    { entries: [{ timeLayoutItemId: entryPoints[0].id, courseId: outsider.id }] },
    undefined,
    400,
  );
  check('跨班课程拒绝写入', () => {});
  await request(
    '/schedules/swap',
    'POST',
    {
      classId: cls.id,
      classPlanId: plan.id,
      date: '2026-09-23',
      first: entryPoints[0].id,
      second: entryPoints[1].id,
    },
    undefined,
    201,
  );
  status = await request(`/schedules/current?classId=${cls.id}&at=${at}`);
  check('换课叠加层生效', () => assert.equal(status.current.courseName, '数学'));
  const original = await request(`/class-plans/${plan.id}/export`);
  check('换课不修改原表', () =>
    assert.equal(
      original.plan.entries.find(
        (e: { timeLayoutItemId: string }) => e.timeLayoutItemId === entryPoints[0].id,
      ).courseId,
      course.id,
    ),
  );
  await request(
    '/schedules/scheduled',
    'POST',
    { classId: cls.id, classPlanId: plan.id, date: '2026-09-23' },
    undefined,
    201,
  );
  status = await request(`/schedules/current?classId=${cls.id}&at=${at}`);
  check('预定课表优先于临时层', () => assert.equal(status.current.courseName, '语文'));
  await request(
    '/schedules/overlay',
    'POST',
    { classId: cls.id, classPlanId: plan.id, date: '2026-09-24' },
    undefined,
    201,
  );
  check('临时课表可以预定到指定日期', () => {});
  for (let i = 0; i < 6; i++) {
    const student = await prisma.student.create({
      data: {
        studentNo: `${prefix}-${i}`.toUpperCase(),
        name: `临时学生${i}`,
        classId: cls.id,
        status: i === 5 ? 'transferred' : 'active',
      },
    });
    await prisma.grade.create({
      data: {
        studentId: student.id,
        classId: cls.id,
        courseId: course.id,
        examName: '临时月考',
        score: 60 + i,
        totalScore: 100,
      },
    });
  }
  const classToken = signToken({
    sub: cls.id,
    classId: cls.id,
    name: cls.name,
    username: cls.code,
    role: 'CLASS_DEVICE',
    classSession: true,
  });
  await prisma.class.update({ where: { id: cls.id }, data: { studentGradeQueryEnabled: false } });
  const overview = await request('/grades/overview', 'GET', undefined, classToken);
  check('关闭个人成绩仍可看集体分析且不含身份/极值', () => {
    assert.equal(overview.mode, 'collective');
    assert(!/studentNo|studentId|studentName|rank|highest|lowest|临时学生/.test(JSON.stringify(overview)));
  });
  let gradeEvent: unknown;
  registerEmitter((_rooms, event, payload) => {
    if (event === 'grade:updated') gradeEvent = payload;
  });
  const gradeProbe = await prisma.grade.findFirstOrThrow({
    where: { classId: cls.id, student: { status: 'active' } },
  });
  await request(`/grades/${gradeProbe.id}`, 'PATCH', { score: 65 });
  check('个人查询关闭时实时广播也不含任何个人成绩', () =>
    assert.deepEqual(gradeEvent, { classId: cls.id, collective: true }),
  );
  await request('/grades/my', 'GET', undefined, classToken, 403);
  await request(`/grades/student/${prefix}-0`, 'GET', undefined, classToken, 403);
  await request(`/grades/ranking?classId=${cls.id}&examName=临时月考`, 'GET', undefined, classToken, 403);
  check('个人成绩三个入口均不可绕过关闭开关', () => {});
  const students = await request(`/classes/${cls.id}/students`, 'GET', undefined, classToken);
  check('班级端名单不含转出学生', () => assert.equal(students.length, 5));
  const roster = await request(`/students?classId=${cls.id}`, 'GET', undefined, token(teacher));
  check('教师名单服务端排除转出', () => assert.equal(roster.length, 5));
  const transferred = await prisma.student.findUniqueOrThrow({
    where: { studentNo: (prefix + '-5').toUpperCase() },
  });
  const visibleGrades = await request(`/grades?classId=${cls.id}`);
  assert(!visibleGrades.some((r: { studentId: string }) => r.studentId === transferred.id));
  await request(
    '/calls',
    'POST',
    { classId: cls.id, studentId: transferred.id, message: '仅验证转出过滤' },
    undefined,
    404,
  );
  const homework = await request(
    '/homeworks',
    'POST',
    { classId: cls.id, courseId: course.id, title: '转出过滤验收', content: '仅临时库，不向真实班级发布' },
    undefined,
    201,
  );
  const submissions = await request(`/homeworks/${homework.id}/submissions`, 'GET', undefined, classToken);
  assert.equal(submissions.total, 5);
  assert(!submissions.students.some((r: { studentId: string }) => r.studentId === transferred.id));
  await prisma.class.update({ where: { id: cls.id }, data: { studentGradeQueryEnabled: true } });
  await request(`/grades/student/${transferred.studentNo}`, 'GET', undefined, classToken, 404);
  await prisma.class.update({ where: { id: cls.id }, data: { studentGradeQueryEnabled: false } });
  check('转出学生不可录入叫人、查询成绩或进入作业未交名单', () => {});
  await request(`/classes/${other.id}/students`, 'GET', undefined, token(teacher), 403);
  check('普通教师不可跨班读名单', () => {});
  await request(`/grades?classId=${other.id}`, 'GET', undefined, token(lead), 403);
  await request(`/classes/${cls.id}/students`, 'GET', undefined, token(lead));
  check('级长只可读本年级', () => {});
  await request(`/classes/${other.id}/students`, 'GET', undefined, token(division));
  await request(`/classes/${third.id}/students`, 'GET', undefined, token(division), 403);
  check('部长只可读配置部范围', () => {});
  for (const u of [head, teacher, lead, division]) {
    await request('/system/settings', 'GET', undefined, token(u), 403);
    await request('/permissions/groups', 'GET', undefined, token(u), 403);
    await request('/update/client/fetch', 'POST', { version: '9.9.9' }, token(u), 403);
  }
  check('四岗位组均无系统/权限/下发更新权限', () => {});
  check('总周数可到60，生成41周不再截成30', () =>
    assert.equal(buildAutoTermWeeks('2026-09-07', 41).length, 41),
  );
  assert.equal(await getMaxTermWeeks(), 60);
  const dry = await runPromotion(2099, true);
  check('升级预览不写执行记录、不改变年级', () => assert.equal(dry.status, 'dry-run'));
  assert.equal((await prisma.class.findUniqueOrThrow({ where: { id: cls.id } })).grade, '高一');
  const snapshot = await exportSnapshot(prisma, 'sqlite');
  check('快照包含日课表/时间点/升级记录与周次', () =>
    assert(
      snapshot.data.ClassPlan &&
        snapshot.data.TimeLayoutItem &&
        snapshot.data.PromotionRun &&
        snapshot.data.TermWeek,
    ),
  );
  check('岛默认固定；非法配置有界回落', () => {
    assert.equal(defaultIslandLayouts().layout, 'fixed');
    const invalid = normalizeIslandLayouts({
      layout: 'custom',
      schemes: [
        { id: 'x', rows: [{ nodes: [], main: true }], scale: 999, color: 'url(https://example.com)' },
      ],
    });
    assert.equal(invalid.schemes[0]!.scale, CLASSISLAND_ISLAND_METRICS.scaleMax);
    assert.equal(invalid.schemes[0]!.color, defaultIslandLayouts().schemes[0]!.color);
  });

  const legacy = await request(
    '/schedules',
    'POST',
    {
      classId: cls.id,
      courseId: math.id,
      dayOfWeek: 1,
      startTime: '10:00',
      endTime: '10:45',
      weekStart: 1,
      weekEnd: 3,
    },
    undefined,
    201,
  );
  check('旧 POST 兼容门面写入日课表', () => assert.equal(legacy.courseId, math.id));
  await request(`/schedules/${legacy.id}`, 'PATCH', { weekStart: 2, weekEnd: 4 });
  const firstWeek = await request(`/schedules?classId=${cls.id}&week=1`),
    fourthWeek = await request(`/schedules?classId=${cls.id}&week=4`);
  check('旧 PATCH 原子调整单节范围，不改变整日其它课程', () => {
    assert(!firstWeek.some((r: { id: string }) => r.id === legacy.id));
    assert(fourthWeek.some((r: { id: string }) => r.id === legacy.id));
  });
  await request(`/schedules/${legacy.id}`, 'PATCH', { startTime: '11:00', endTime: '11:45' });
  const moved = await request(`/schedules?classId=${cls.id}&week=4`);
  check('旧时间编辑投影新时间点', () =>
    assert.equal(moved.find((r: { id: string }) => r.id === legacy.id).startTime, '11:00'),
  );
  await request(`/schedules/${legacy.id}`, 'DELETE');
  check('旧 DELETE 不从遗留 Schedule 复活', () => {});
  const payload = {
    Subjects: { subject: { Name: '语文' } },
    TimeLayouts: {
      layout: {
        Name: '上游测试',
        Layouts: [
          { StartTime: '08:00:00', EndTime: '08:45:00', TimeType: 0 },
          { StartTime: '08:45:00', EndTime: '09:00:00', TimeType: 1 },
          { StartTime: '09:00:00', EndTime: '09:00:00', TimeType: 2 },
          { StartTime: '09:00:00', EndTime: '09:01:00', TimeType: 3 },
        ],
      },
    },
    ClassPlans: {
      plan: {
        Name: '上游四周',
        TimeLayoutId: 'layout',
        TimeRule: { WeekDay: 4, WeekCountDiv: 3, WeekCountDivTotal: 4 },
        Classes: [{ SubjectId: 'subject' }],
      },
    },
  };
  await request('/class-plans/import/profile', 'POST', { classId: cls.id, payload }, undefined, 201);
  await request('/class-plans/import/profile', 'POST', { classId: cls.id, payload }, undefined, 201);
  const imported = await request(`/class-plans?classId=${cls.id}`);
  check('ClassIsland 导入保留4周轮换，merge重复导入不复制课表', () => {
    const rows = imported.filter((p: { name: string }) => p.name === '上游四周');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].weekCountDivTotal, 4);
    assert.equal(rows[0].layout.points.length, 4);
  });
  const archive = await request(`/class-plans/profile?classId=${cls.id}`);
  const beforeArchive = imported.find((p: { name: string }) => p.name === '上游四周');
  const exportedPlan = archive.ClassPlans[beforeArchive.id];
  check('完整档案导出保留四种时间点、空课位置与轮换规则', () => {
    assert.equal(archive.TimeLayouts[exportedPlan.TimeLayoutId].Layouts.length, 4);
    assert.equal(exportedPlan.TimeRule.WeekCountDivTotal, 4);
    assert.equal(
      exportedPlan.Classes.length,
      beforeArchive.layout.points.filter((p: { timeType: string }) => p.timeType === 'LESSON').length,
    );
  });
  await request('/class-plans/import/profile', 'POST', { classId: cls.id, payload: archive }, undefined, 201);
  const afterArchive = await request(`/class-plans?classId=${cls.id}`);
  check('导出档案可重新导入且保留课程与周次范围', () => {
    const restored = afterArchive.find(
      (p: { id: string; name: string }) => p.name === '上游四周' && p.id !== beforeArchive.id,
    );
    assert.equal(restored.weekStart, beforeArchive.weekStart);
    assert.equal(restored.weekEnd, beforeArchive.weekEnd);
    assert.equal(restored.entries.length, beforeArchive.entries.length);
  });
  let enabled = false;
  const os = {
    platform: 'win32',
    root: 'F:\\fake-installed-server',
    exists: () => true,
    run: (_file: string, args: string[]) => {
      if (args.includes('InstallDir'))
        return { ok: true, output: 'InstallDir    REG_SZ    F:\\fake-installed-server' };
      if (args[0] === 'add') {
        enabled = true;
        return { ok: true, output: '' };
      }
      if (args[0] === 'delete') {
        enabled = false;
        return { ok: true, output: '' };
      }
      return {
        ok: enabled,
        output: enabled ? 'ClassHelperServer    REG_SZ    "F:\\fake-installed-server\\start.cmd"' : '',
      };
    },
  };
  const autostart = createAutostartController(os);
  check('安装形态自启动开启/关闭且回读一致（假系统适配器）', () => {
    assert.equal(autostart.read().supported, true);
    assert.equal(autostart.write(true).enabled, true);
    assert.equal(createAutostartController(os).read().enabled, true);
    assert.equal(autostart.write(false).enabled, false);
  });
  check('非安装形态返回不可用原因', () => {
    const value = createAutostartController({ ...os, exists: () => false }).read();
    assert.equal(value.supported, false);
    assert(value.detail.length > 10);
  });
  // 范围测试的初中班不属于默认高中计划，结束该测试夹具后再升级高中；未知年级阻断另由 lifecycle 验收。
  await prisma.class.delete({ where: { id: third.id } });
  // 此文件开头已强制临时库，实际升级不会触及演示或业务数据。
  await prisma.class.create({
    data: {
      name: '临时高三班',
      grade: '高三',
      enrollmentYear: 2088,
      classIndex: 1,
      code: prefix + 'G',
      teacherId: head.id,
    },
  });
  const [promotion, repeated] = await Promise.all([runPromotion(2099), runPromotion(2099)]);
  check('临时库并发升级同年幂等且执行前快照存在', () => {
    assert.equal(promotion.status, 'done');
    assert.equal(repeated.snapshotPath, promotion.snapshotPath);
    assert.equal(awaitedSnapshotPath(promotion.snapshotPath), true);
  });
  const skeleton = await prisma.class.findFirstOrThrow({ where: { enrollmentYear: 2099, grade: '高一' } });
  check('新高一骨架不复制班主任或任课授权', () => assert.equal(skeleton.teacherId, null));
  assert.equal(await prisma.course.count({ where: { classId: skeleton.id } }), 0);
  check('临时高三已归档，其余只升一级', () => assert.equal(repeated.classCount, 3));
  assert.equal((await prisma.class.findUniqueOrThrow({ where: { id: cls.id } })).grade, '高二');
  assert.equal((await prisma.class.findUniqueOrThrow({ where: { id: other.id } })).grade, '高三');
  console.log(`=== V1.4 新增能力：${count}/${count} 项通过 ===`);
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
}
