/** 只针对独立测试服务：验证审查发现的越权、导入、日期和广播缺陷，不访问外网。 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { SOCKET_EVENTS, SOCKET_ROOMS, dayKeyLocal } from '../packages/shared/dist/index.js';
const { io } = createRequire(path.resolve('packages/desktop-client/package.json'))('socket.io-client');
const base = process.env.VERIFY_BASE_URL ?? 'http://127.0.0.1:4199';
const stamp = Date.now();
const extraGroups = [];
let passed = 0;
async function api(route, token, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(`${base}/api${route}`, {
    method,
    signal: AbortSignal.timeout(8000),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, ...(await response.json()) };
}
function check(name, value) {
  assert.ok(value, name);
  passed++;
  console.log(`✓ ${name}`);
}
function event(socket, name, accepts = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(name, onEvent);
      reject(new Error(`未收到 ${name}`));
    }, 5000);
    const onEvent = (value) => {
      if (!accepts(value)) return;
      clearTimeout(timer);
      socket.off(name, onEvent);
      resolve(value);
    };
    socket.on(name, onEvent);
  });
}
const admin = (await api('/auth/login', null, { username: 'admin', password: 'admin123' })).data.token;
const classIds = [],
  users = [],
  sockets = [];
let groupId, previousAi;
try {
  const staff = (
    await api('/teachers', admin, {
      username: `review_${stamp}`,
      password: 'review-test-123',
      name: '审查验证教师',
      role: 'TEACHER',
    })
  ).data;
  assert.ok(staff?.id);
  users.push(staff.id);
  const staffToken = (
    await api('/auth/login', null, { username: staff.username, password: 'review-test-123' })
  ).data.token;
  for (const [index, teacherId] of [
    [0, staff.id],
    [1, null],
  ]) {
    const created = await api('/classes', admin, {
      name: `审查验证班${index}`,
      grade: '验证',
      enrollmentYear: 2098,
      classIndex: index + 1,
      code: `RV${stamp}${index}`,
      ...(teacherId ? { teacherId } : {}),
      termWeeks: 10,
    });
    assert.ok(created.data?.id, JSON.stringify(created));
    classIds.push(created.data.id);
    await api(
      `/classes/${created.data.id}/class-account`,
      admin,
      { code: `RV${stamp}${index}`, password: 'review-test-123' },
      'PATCH',
    );
  }
  const [a, b] = classIds;
  const courseA = (await api('/courses', admin, { classId: a, name: '语文', teacherId: staff.id })).data;
  const courseB = (await api('/courses', admin, { classId: b, name: '语文' })).data;
  const students = [];
  for (let index = 0; index < 3; index++) {
    const student = await api('/students', admin, {
      classId: index < 2 ? a : b,
      name: index < 2 ? '同名同学' : '别班同学',
      studentNo: `R${stamp}${index}`,
    });
    assert.ok(student.data?.id, JSON.stringify(student));
    students.push(student.data);
  }
  const group = (
    await api('/permissions/groups', admin, { name: `审查只读组${stamp}`, keys: ['dashboard:read'] })
  ).data;
  groupId = group.id;
  await api(`/permissions/users/${staff.id}/groups`, admin, { groupIds: [groupId] }, 'PUT');
  check(
    '移除成绩查询权限后员工不能按学号查询',
    (await api(`/grades/student/${students[0].studentNo}?classId=${a}`, staffToken)).status === 403,
  );
  check(
    '移除更新检查权限后直接接口被拒绝且不发起外网请求',
    (await api('/update/check', staffToken)).status === 403,
  );
  await api(
    `/permissions/groups/${groupId}`,
    admin,
    { keys: ['roster:read', 'teacher:read', 'call:create', 'ai:use', 'student:grade-query'] },
    'PATCH',
  );
  check('看板读取权限可以真正收回', (await api('/dashboard/summary', staffToken)).status === 403);
  check('只读名单权限可以读取本班', (await api(`/students?classId=${a}`, staffToken)).status === 200);
  check(
    '只读名单权限不能新增学生',
    (await api('/students', staffToken, { classId: a, name: '不应创建', studentNo: `NO${stamp}` })).status ===
      403,
  );
  check('教师只读权限可以读取教师列表', (await api('/teachers', staffToken)).status === 200);
  check(
    '教师只读权限不能创建教师',
    (await api('/teachers', staffToken, { username: `no_${stamp}`, name: '不应创建' })).status === 403,
  );
  check(
    '按别班学生 ID 查询调班历史仍会拒绝',
    (await api(`/students/transfers?studentId=${students[2].id}`, staffToken)).status === 403,
  );
  const ownLogin = (
    await api('/auth/class-login', null, { code: `RV${stamp}0`, password: 'review-test-123' })
  ).data;
  const otherLogin = (
    await api('/auth/class-login', null, { code: `RV${stamp}1`, password: 'review-test-123' })
  ).data;
  for (const token of [ownLogin.token, otherLogin.token]) {
    const socket = io(base, { auth: { token }, transports: ['websocket'], autoConnect: false });
    sockets.push(socket);
    const ready = event(socket, SOCKET_EVENTS.connected);
    socket.connect();
    const payload = await ready;
    check(
      '班级端连接后自动加入自己的班级房间',
      payload.rooms.some(
        (room) => room === SOCKET_ROOMS.classChannel(token === ownLogin.token ? a : b, 'notification'),
      ),
    );
  }
  const join = await new Promise((resolve) =>
    sockets[0].timeout(3000).emit('class:join', a, (error, result) => resolve(error ? null : result)),
  );
  check('班级端显式加入本班成功', join?.ok === true);
  const forbiddenJoin = await new Promise((resolve) =>
    sockets[0].timeout(3000).emit('class:join', b, (error, result) => resolve(error ? null : result)),
  );
  check('班级端不能显式加入别班', forbiddenJoin?.ok === false);
  const call = await api('/calls', staffToken, {
    classId: a,
    studentId: students[0].id,
    message: '审查验证叫人',
  });
  check('叫人记录写入本地所属日期', call.data?.assignDate === dayKeyLocal(new Date()));
  const dayList = await api(`/notifications?classId=${a}&date=${dayKeyLocal(new Date())}`, admin);
  check(
    '按日期查看时能找到叫人记录',
    dayList.data?.some((item) => item.id === call.data.id),
  );
  const removed = event(sockets[0], SOCKET_EVENTS.notificationDeleted);
  await api(`/notifications/${call.data.id}`, admin, undefined, 'DELETE');
  check('删除通知会广播给对应班级', (await removed).id === call.data.id);
  const badSchedule = await api('/schedules', admin, {
    classId: a,
    courseId: courseA.id,
    dayOfWeek: 1,
    startTime: '08:00',
    endTime: '08:45',
    weekStart: 15,
  });
  check('按班级学期兜底后仍检查起始周不能越过结束周', badSchedule.status === 400);
  await api(`/classes/${a}/settings`, admin, { termWeeks: 30 }, 'PATCH');
  const imported = await api('/imports/class-plan', admin, {
    classId: a,
    mode: 'merge',
    payload: {
      Subjects: { s: { Name: '语文' } },
      TimeLayouts: { t: { Layouts: [{ TimeType: 0, StartTime: '08:00:00', EndTime: '08:45:00' }] } },
      ClassPlans: {
        p: {
          Name: '周一',
          TimeLayoutId: 't',
          TimeRule: { WeekDay: 1, WeekCountDiv: 1, WeekCountDivTotal: 1 },
          Classes: [{ SubjectId: 's', IsEnabled: true }],
        },
      },
    },
  });
  check('导入课表采用班级配置的 30 周', imported.data?.weekEnd === 30);
  const className = (await api(`/classes/${a}`, admin)).data.name;
  const relations = await api('/imports/table/commit', admin, {
    kind: 'classTeachers',
    fileName: 'relations.csv',
    mode: 'upsert',
    useTeacherNo: true,
    mapping: { className: '班级', subjectName: '科目', teacherNo: '工号', teacherName: '姓名', role: '角色' },
    contentBase64: Buffer.from(
      `\ufeff班级,科目,工号,姓名,角色\n${className},语文,${staff.username},审查验证教师,科任`,
    ).toString('base64'),
  });
  check(
    '任课关系导入可按表格班级列提交，无需额外单选班级',
    relations.status === 200 &&
      relations.data?.errors.length === 0 &&
      relations.data.inserted + relations.data.updated > 0,
  );
  const csv = `\ufeff学号,姓名,考试,分数\n,同名同学,审查考试,80`;
  const importBase = {
    kind: 'grades',
    classId: a,
    fileName: 'review.csv',
    mode: 'upsert',
    mapping: { studentNo: '学号', name: '姓名', examName: '考试', score: '分数' },
  };
  const ambiguous = await api('/imports/table/commit', admin, {
    ...importBase,
    contentBase64: Buffer.from(csv).toString('base64'),
  });
  check(
    '成绩导入遇到同名学生返回行级消歧提示',
    ambiguous.data?.errors?.some((item) => item.message.includes('同名')),
  );
  const exact = await api('/imports/table/commit', admin, {
    ...importBase,
    contentBase64: Buffer.from(csv.replace('\n,', `\n${students[0].studentNo},`)).toString('base64'),
  });
  check('提供正确学号后同名学生也能精确导入', exact.data?.inserted === 1);
  const gradeA = (
    await api('/grades', admin, {
      classId: a,
      courseId: courseA.id,
      studentId: students[0].id,
      examName: '批改等级',
      score: 80,
    })
  ).data;
  const gradeB = (
    await api('/grades', admin, {
      classId: b,
      courseId: courseB.id,
      studentId: students[2].id,
      examName: '批改等级',
      score: 75,
    })
  ).data;
  const updateA = event(sockets[0], SOCKET_EVENTS.gradeUpdated, (value) => value.bulk),
    updateB = event(sockets[1], SOCKET_EVENTS.gradeUpdated, (value) => value.bulk);
  await api(
    '/grades/levels',
    admin,
    {
      items: [
        { id: gradeA.id, level: '优秀' },
        { id: gradeB.id, level: '良好' },
      ],
    },
    'PATCH',
  );
  check('跨班修改等级时两个班都会收到广播', (await updateA).count === 1 && (await updateB).count === 1);
  const custom = await api(
    '/grades/levels',
    admin,
    { classId: a, examName: '批改等级', levelType: 'custom' },
    'PATCH',
  );
  check('自定义等级没有规则时禁止整批猜算', custom.status === 400);
  const roleUser = (
    await api('/teachers', admin, {
      username: `review_admin_${stamp}`,
      password: 'review-test-123',
      name: '保留管理员',
      role: 'ADMIN',
    })
  ).data;
  users.push(roleUser.id);
  const roleImport = await api('/imports/table/commit', admin, {
    kind: 'teachers',
    fileName: 'role.csv',
    mode: 'upsert',
    mapping: { username: '工号', name: '姓名', role: '角色' },
    contentBase64: Buffer.from(`\ufeff工号,姓名,角色\n${roleUser.username},保留管理员,未知角色`).toString(
      'base64',
    ),
  });
  assert.ok(roleImport.status < 300, JSON.stringify(roleImport));
  check(
    '教师批量导入不会更新管理员账号，须使用管理员账号维护入口',
    roleImport.data?.updated === 0 && roleImport.data.errors.length === 1,
  );
  const teachers = (await api('/teachers', admin)).data;
  check(
    '教师导入不能因未知角色静默降级管理员',
    teachers.find((item) => item.id === roleUser.id)?.role === 'ADMIN',
  );
  const baseKeys = [
    'roster:read',
    'teacher:read',
    'call:create',
    'ai:use',
    'student:grade-query',
    'update:check',
  ];
  await api(`/permissions/groups/${groupId}`, admin, { keys: baseKeys }, 'PATCH');
  const initialUpdate = (await api('/update/check', admin)).data;
  check(
    '未授予强制检查时教师的 force 参数不能绕过缓存',
    (await api('/update/check?force=1', staffToken)).data.checkedAt === initialUpdate.checkedAt,
  );
  check(
    '教师模板不能保存管理员强制更新键',
    (await api(`/permissions/groups/${groupId}`, admin, { keys: [...baseKeys, 'update:force'] }, 'PATCH'))
      .status === 400,
  );
  const forcedUpdate = (await api('/update/check?force=1', staffToken)).data;
  check('教师即使尝试授予管理员能力也不能绕过更新缓存', forcedUpdate.checkedAt === initialUpdate.checkedAt);
  const readUpdateGroup = (
    await api('/permissions/groups', admin, { name: `审查管理员只读更新${stamp}`, keys: ['update:check'] })
  ).data;
  extraGroups.push(readUpdateGroup.id);
  check(
    '管理员不接受模板分配',
    (await api(`/permissions/users/${roleUser.id}/groups`, admin, { groupIds: [readUpdateGroup.id] }, 'PUT'))
      .status === 400,
  );
  const limitedAdmin = (
    await api('/auth/login', null, { username: roleUser.username, password: 'review-test-123' })
  ).data.token;
  check(
    '管理员固定拥有强制检查能力',
    (await api('/update/check?force=1', limitedAdmin)).data.checkedAt !== forcedUpdate.checkedAt,
  );
  previousAi = (await api('/ai/settings', admin)).data;
  await api('/ai/settings', admin, { enabled: true, provider: 'mock' }, 'PUT');
  check(
    '助手不能用别班上下文查询科目',
    (await api('/ai/interpret', staffToken, { classId: b, text: '发布通知测试' })).status === 403,
  );
  const interpreted = await api('/ai/interpret', staffToken, { classId: a, text: '发布通知，明天带书' });
  check('自己的班级可以离线解析', interpreted.status === 200);
  const audits = (await api('/ai/audit', admin)).data;
  check('解析审计使用明确的解析状态', ['interpreted', 'unrecognized'].includes(audits[0]?.status));
  check(
    '协议相对附件地址不能写入作业',
    (
      await api('/homeworks', admin, {
        classId: a,
        title: '链接测试',
        content: '链接测试',
        attachmentUrl: '//invalid.example/file',
      })
    ).status === 422,
  );
  console.log(`审查专项接口回归：${passed}/${passed} 项通过`);
} finally {
  for (const socket of sockets) socket.disconnect();
  if (previousAi) await api('/ai/settings', admin, previousAi, 'PUT');
  for (const id of [...classIds].reverse()) await api(`/classes/${id}`, admin, undefined, 'DELETE');
  for (const id of users) await api(`/teachers/${id}`, admin, undefined, 'DELETE');
  if (groupId) await api(`/permissions/groups/${groupId}`, admin, undefined, 'DELETE');
  for (const id of extraGroups) await api(`/permissions/groups/${id}`, admin, undefined, 'DELETE');
}
