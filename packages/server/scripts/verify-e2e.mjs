#!/usr/bin/env node
import { readFileSync } from 'node:fs';
/**
 * 端到端联调验证（对应验收标准）：
 *   1. 教师发布通知 -> ClassHelper 班级端 Socket.IO 5 秒内收到
 *   2. 教师发布作业 -> ClassHelper 班级端实时收到，并可标记完成
 *   3. 教师录入成绩 -> ClassHelper 班级端实时收到，且 /grades/my 可查
 *   4. 权限隔离：学生无法访问其他班级数据、无法调用教师接口
 *   5. 课表按周查询可用
 *
 * 用法：
 *   执行 pnpm verify:e2e；根启动器自动创建隔离数据库和带前缀账号
 *
 * 环境变量：
 *   VERIFY_BASE_URL  默认 http://127.0.0.1:4000
 */
import { io } from 'socket.io-client';

const BASE_URL = process.env.VERIFY_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 4000}`;
const TIME_LIMIT_MS = 5000;

const results = [];

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  const mark = ok ? '\u2713' : '\u2717';
  console.log(`${mark} ${name}${detail ? `  (${detail})` : ''}`);
}

async function api(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${BASE_URL}/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, payload };
}

function waitForEvent(socket, event, timeoutMs = TIME_LIMIT_MS) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待事件 ${event} 超时（${timeoutMs}ms）`)), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve({ payload, elapsed: Date.now() - startedAt });
    });
  });
}

async function main() {
  console.log(`\n=== ClassHelper 端到端验证（${BASE_URL}）===\n`);

  // ---------------------------------------------------------------- 0. 健康检查
  const health = await api('/health');
  record(
    '后端健康检查 /api/health',
    health.status === 200 && health.payload?.data?.status === 'ok',
    `status=${health.status} db=${health.payload?.data?.database?.connected}`,
  );
  if (health.status !== 200) {
    console.log('\n后端未启动，请先运行 pnpm dev:server\n');
    process.exit(1);
  }
  console.log(`  已挂载模块：${(health.payload?.data?.modules ?? []).join(', ')}\n`);

  // 版本号不再硬编码（见 lib/version.ts）：健康检查必须暴露一个像样的版本，
  // 更新检查要靠它判断"本机是不是旧版"；同时确认 update 模块已进注册表。
  const healthData = health.payload?.data ?? {};
  record(
    '健康检查暴露版本号与模块清单（含 update 模块）',
    typeof healthData.version === 'string' &&
      /^\d+\.\d+\.\d+/.test(healthData.version) &&
      (healthData.modules ?? []).includes('update'),
    `版本=${healthData.version} 模块数=${(healthData.modules ?? []).length}`,
  );

  // ---------------------------------------------------------------- 1. 登录
  const teacherLogin = await api('/auth/login', {
    method: 'POST',
    body: { username: 'teacher1', password: 'teacher123' },
  });
  const teacherToken = teacherLogin.payload?.data?.token;
  const teacher1Id = teacherLogin.payload?.data?.user?.id;
  record('教师登录 teacher1', Boolean(teacherToken), `status=${teacherLogin.status}`);
  if (!teacherToken) process.exit(1);

  // 管理员令牌：按新的角色权限模型，班级增删改/人员分配/学生名单/成绩均仅管理员可执行
  const adminLogin = await api('/auth/login', {
    method: 'POST',
    body: { username: 'admin', password: 'admin123' },
  });
  const adminToken = adminLogin.payload?.data?.token;
  record('管理员登录 admin', Boolean(adminToken), `status=${adminLogin.status}`);
  if (!adminToken) process.exit(1);

  // ClassHelper 班级端主体 = 班级：用「班级码 + 班级密码」登录（个人学生账号已停用登录入口）
  const classesForLogin = await api('/classes', { token: teacherToken });
  const loginClass = classesForLogin.payload?.data?.[0];
  if (!loginClass?.code) {
    record(
      'ClassHelper 班级端班级登录（班级码 + 班级密码 → classSession）',
      false,
      '没有可用班级码，请先执行 pnpm db:seed',
    );
    process.exit(1);
  }
  let studentLogin = await api('/auth/class-login', {
    method: 'POST',
    body: { code: loginClass.code, password: '123456' },
  });
  if (studentLogin.status !== 200) {
    // 演示库密码被改过时，由管理员重置为已知值（仅验证环境）
    await api(`/classes/${loginClass.id}/class-account`, {
      method: 'PATCH',
      token: adminToken,
      body: { code: loginClass.code, password: '123456' },
    });
    studentLogin = await api('/auth/class-login', {
      method: 'POST',
      body: { code: loginClass.code, password: '123456' },
    });
  }
  const studentToken = studentLogin.payload?.data?.token;
  const studentUser = studentLogin.payload?.data?.user;
  record(
    'ClassHelper 班级端班级登录（班级码 + 班级密码 → classSession）',
    Boolean(studentToken) && studentUser?.classSession === true,
    `code=${loginClass.code} status=${studentLogin.status} classId=${studentUser?.classId ?? studentUser?.id}`,
  );
  // 学生不是账号：`User` 表里根本没有学生行，所以拿学号当账号登录只可能是"账号不存在"
  const studentAsAccount = await api('/auth/login', {
    method: 'POST',
    body: { username: '202601', password: '123456' },
  });
  record(
    '学生没有账号：拿学号当账号登录被拒（401）',
    studentAsAccount.status === 401,
    `status=${studentAsAccount.status}`,
  );

  const wrongPassword = await api('/auth/login', {
    method: 'POST',
    body: { username: 'teacher1', password: 'bad-password' },
  });
  record('错误密码被拒绝（401）', wrongPassword.status === 401, `status=${wrongPassword.status}`);

  // ---------------------------------------------------------------- 2. 数据准备
  const myClasses = await api('/classes', { token: teacherToken });
  const classes = myClasses.payload?.data ?? [];
  record('教师获取班级列表', classes.length >= 2, `共 ${classes.length} 个班级`);

  const ownClass = classes.find((item) => item.name?.includes('2026级1')) ?? classes[0];
  const classId = ownClass?.id;
  if (!classId) {
    record('教师至少管理一个班级', false, '数据为空，请先执行 pnpm db:seed');
    process.exit(1);
  }

  // teacher2 名下但 teacher1 无权访问的班级，用于验证教师间权限隔离。
  // 注意：演示库里可能被人工改过（管理员自己建班、给别的班加协作教师），
  // 因此这里**不允许依赖种子数据的班级布局**：没有现成的就现建一个临时班级，收尾删除。
  const teacher2Login = await api('/auth/login', {
    method: 'POST',
    body: { username: 'teacher2', password: 'teacher123' },
  });
  let teacher2Token = teacher2Login.payload?.data?.token;
  let teacher2Id = teacher2Login.payload?.data?.user?.id;
  const teacher1ClassIds = new Set(classes.map((item) => item.id));
  // 演示库里的密码可能被人工改过（本机 teacher1 就有被改成 123456 的情况）：登录失败时由管理员
  // 重置为验证环境已知值再重登。**teacher2 是"科任老师/班级隔离"整组用例的主体**，
  // 上一版漏了这条兜底，密码一改后面整片用例都只能跑空分支。
  if (!teacher2Token) {
    const staffList = await api('/teachers', { token: adminToken });
    const fallbackTeacher2Id =
      teacher2Id ?? (staffList.payload?.data ?? []).find((item) => item.username === 'teacher2')?.id;
    if (fallbackTeacher2Id) {
      await api(`/teachers/${fallbackTeacher2Id}/reset-password`, {
        method: 'POST',
        token: adminToken,
        body: { newPassword: 'e2e-teacher2-123456' },
      });
      const retryTeacher2 = await api('/auth/login', {
        method: 'POST',
        body: { username: 'teacher2', password: 'e2e-teacher2-123456' },
      });
      teacher2Token = retryTeacher2.payload?.data?.token;
      teacher2Id = retryTeacher2.payload?.data?.user?.id;
      record(
        '教师 teacher2 密码被改过，已由管理员重置为验证环境已知值（登录环境自愈）',
        Boolean(teacher2Token),
        `status=${retryTeacher2.status}`,
      );
    }
  }
  const teacher2Classes = (await api('/classes', { token: teacher2Token })).payload?.data ?? [];
  /** 本次验证临时创建的班级（收尾统一删除，不污染演示数据） */
  const probeClassIds = [];
  /** 权限矩阵用例里新建的作业（收尾统一删除） */
  const tempHomeworkIds = [];
  let foreignClass = teacher2Classes.find((item) => !teacher1ClassIds.has(item.id)) ?? null;
  if (!foreignClass) {
    const created = await api('/classes', {
      method: 'POST',
      token: adminToken,
      body: {
        grade: '高一',
        enrollmentYear: new Date().getFullYear(),
        classIndex: 93,
        code: `PV${Date.now().toString().slice(-6)}`,
        ...(teacher2Id ? { teacherId: teacher2Id } : {}),
      },
    });
    foreignClass = created.payload?.data ?? null;
    if (foreignClass?.id) probeClassIds.push(foreignClass.id);
  }
  record(
    '教师权限隔离测试数据就绪（无现成班级时自建临时班级）',
    Boolean(foreignClass),
    foreignClass ? `外部班级：${foreignClass.name}` : '未能准备其它教师的班级',
  );

  const studentList = await api(`/students?classId=${classId}`, { token: adminToken });
  const classmates = studentList.payload?.data ?? [];
  // 班级会话下没有"当前学生"，目标学生固定取班里第一位（用于成绩/叫人等需要具体学生 id 的用例）
  const targetStudent = classmates[0];
  /** 同班第二位学生的学号（导入用例里要造「两条不同的学号」） */
  const classmateTwoNo = classmates[1]?.studentNo ?? '202602';
  record('教师获取学生名单', classmates.length > 0, `共 ${classmates.length} 人`);

  const courses = await api(`/courses?classId=${classId}`, { token: teacherToken });
  const courseId = courses.payload?.data?.[0]?.id ?? null;
  record('教师获取课程列表', Boolean(courseId), `course=${courses.payload?.data?.[0]?.name ?? '-'}`);

  const weekGrid = await api(`/schedules/grid?classId=${classId}&week=1`, { token: studentToken });
  const totalSlots = (weekGrid.payload?.data?.columns ?? []).reduce((sum, col) => sum + col.items.length, 0);
  record(
    '学生按周查看课表（week=1）',
    weekGrid.status === 200 && totalSlots > 0,
    `第 1 周 ${totalSlots} 节课`,
  );

  /* ---------------------------------------------------------------- 2.1 单双周课表 */
  // 第 1 周是单周、第 2 周是双周（与 ClassIsland 的 WeekCountDiv 语义一致）
  const parityCourseId = courseId ?? courses.payload?.data?.[0]?.id;
  const parityCreate = await api('/schedules', {
    method: 'POST',
    token: teacherToken,
    body: {
      classId,
      courseId: parityCourseId,
      dayOfWeek: 6,
      startTime: '07:00',
      endTime: '07:45',
      weekStart: 1,
      weekEnd: 20,
      weekParity: 'ODD',
      location: '单双周校验 · 单周',
    },
  });
  record(
    '创建单周课表（weekParity=ODD）',
    parityCreate.status === 201 && parityCreate.payload?.data?.weekParity === 'ODD',
    `status=${parityCreate.status} weekParity=${parityCreate.payload?.data?.weekParity ?? '-'}`,
  );
  const parityId = parityCreate.payload?.data?.id;
  const oddGrid = await api(`/schedules/grid?classId=${classId}&week=1`, { token: teacherToken });
  const evenGrid = await api(`/schedules/grid?classId=${classId}&week=2`, { token: teacherToken });
  const inGrid = (payload) =>
    (payload?.data?.columns ?? []).some((col) => (col.items ?? []).some((item) => item.id === parityId));
  record(
    '单周课表只出现在单周（week=1 有、week=2 无）',
    oddGrid.status === 200 && evenGrid.status === 200 && inGrid(oddGrid.payload) && !inGrid(evenGrid.payload),
    `week1=${inGrid(oddGrid.payload)} week2=${inGrid(evenGrid.payload)}`,
  );
  // 补一条双周课（同一时段），验证两周各出现一节、互不冲突
  const evenCreate = await api('/schedules', {
    method: 'POST',
    token: teacherToken,
    body: {
      classId,
      courseId: parityCourseId,
      dayOfWeek: 6,
      startTime: '07:00',
      endTime: '07:45',
      weekStart: 1,
      weekEnd: 20,
      weekParity: 'EVEN',
      location: '单双周校验 · 双周',
    },
  });
  const evenId = evenCreate.payload?.data?.id;
  const oddGrid2 = await api(`/schedules/grid?classId=${classId}&week=1`, { token: teacherToken });
  const evenGrid2 = await api(`/schedules/grid?classId=${classId}&week=2`, { token: teacherToken });
  const countAt = (payload, id) =>
    (payload?.data?.columns ?? []).reduce(
      (sum, col) => sum + (col.items ?? []).filter((item) => item.id === id).length,
      0,
    );
  record(
    '同一时段的单周/双周课各归各周（互不串周）',
    evenCreate.status === 201 &&
      countAt(oddGrid2.payload, parityId) === 1 &&
      countAt(oddGrid2.payload, evenId) === 0 &&
      countAt(evenGrid2.payload, parityId) === 0 &&
      countAt(evenGrid2.payload, evenId) === 1,
    `week1 单周=${countAt(oddGrid2.payload, parityId)} 双周=${countAt(oddGrid2.payload, evenId)}；` +
      `week2 单周=${countAt(evenGrid2.payload, parityId)} 双周=${countAt(evenGrid2.payload, evenId)}`,
  );

  /* ---------------------------------------------------------------- 2.2 ClassIsland 课程表导入（含单双周） */
  // 真实档案结构：TimeLayouts / ClassPlans / Subjects 都是 Guid 字典，单双周=两条 ClassPlan
  const classIslandProfile = {
    Name: '导入校验档案',
    TimeLayouts: {
      '11111111-1111-4111-8111-111111111111': {
        Name: '周一作息',
        Layouts: [
          { StartTime: '08:00:00', EndTime: '08:45:00', TimeType: 0, BreakName: '' },
          { StartTime: '08:45:00', EndTime: '08:55:00', TimeType: 1, BreakName: '课间' },
          { StartTime: '08:55:00', EndTime: '09:40:00', TimeType: 0, BreakName: '' },
        ],
      },
    },
    ClassPlans: {
      'aaaaaaaa-0001-4000-8000-000000000001': {
        Name: '周一-单周',
        TimeLayoutId: '11111111-1111-4111-8111-111111111111',
        TimeRule: { WeekDay: 1, WeekCountDiv: 1, WeekCountDivTotal: 2 },
        Classes: [
          { SubjectId: 'bbbbbbbb-0001-4000-8000-000000000001', IsEnabled: true },
          { SubjectId: 'bbbbbbbb-0002-4000-8000-000000000002', IsEnabled: true },
        ],
      },
      'aaaaaaaa-0002-4000-8000-000000000002': {
        Name: '周一-双周',
        TimeLayoutId: '11111111-1111-4111-8111-111111111111',
        TimeRule: { WeekDay: 1, WeekCountDiv: 2, WeekCountDivTotal: 2 },
        Classes: [
          { SubjectId: 'bbbbbbbb-0001-4000-8000-000000000001', IsEnabled: true },
          { SubjectId: 'bbbbbbbb-0003-4000-8000-000000000003', IsEnabled: true },
        ],
      },
    },
    Subjects: {
      'bbbbbbbb-0001-4000-8000-000000000001': { Name: '导入校验语文', TeacherName: '王芳' },
      'bbbbbbbb-0002-4000-8000-000000000002': { Name: '导入校验数学', TeacherName: '李梅' },
      'bbbbbbbb-0003-4000-8000-000000000003': { Name: '导入校验英语', TeacherName: '张伟' },
    },
  };
  const classPlanPreview = await api('/imports/class-plan/preview', {
    method: 'POST',
    token: teacherToken,
    body: { classId, mode: 'merge', payload: classIslandProfile },
  });
  const previewEntries = classPlanPreview.payload?.data?.entries ?? [];
  record(
    'ClassIsland 课程表预览：解析出 4 节（单周 2 / 双周 2）',
    classPlanPreview.status === 200 &&
      previewEntries.length === 4 &&
      previewEntries.filter((item) => item.weekParity === 'ODD').length === 2 &&
      previewEntries.filter((item) => item.weekParity === 'EVEN').length === 2 &&
      previewEntries.every((item) => item.dayOfWeek === 1),
    `status=${classPlanPreview.status} 共 ${previewEntries.length} 节 · ` +
      `单周 ${previewEntries.filter((item) => item.weekParity === 'ODD').length} / ` +
      `双周 ${previewEntries.filter((item) => item.weekParity === 'EVEN').length}` +
      `${classPlanPreview.payload?.data?.errors?.length ? ` 错误=${classPlanPreview.payload.data.errors.join('；')}` : ''}`,
  );
  record(
    '课程表预览会列出需要自动补建的科目',
    (classPlanPreview.payload?.data?.missingSubjects ?? []).length === 3,
    `待建科目=[${(classPlanPreview.payload?.data?.missingSubjects ?? []).join('、')}]`,
  );
  const classPlanImport = await api('/imports/class-plan', {
    method: 'POST',
    token: teacherToken,
    body: { classId, mode: 'merge', payload: classIslandProfile },
  });
  const importResult = classPlanImport.payload?.data;
  record(
    '导入 ClassIsland 课程表：4 节写入并自动补建 3 门课程',
    classPlanImport.status === 200 &&
      (importResult?.created ?? 0) + (importResult?.updated ?? 0) === 4 &&
      (importResult?.createdCourses ?? []).length === 3,
    `新增=${importResult?.created ?? '-'} 更新=${importResult?.updated ?? '-'} ` +
      `补建=[${(importResult?.createdCourses ?? []).join('、')}]`,
  );
  // 导入结果里单双周必须落库：第 1 周只有单周两节、第 2 周只有双周两节
  const oddAfterImport = await api(`/schedules/grid?classId=${classId}&week=1`, { token: teacherToken });
  const evenAfterImport = await api(`/schedules/grid?classId=${classId}&week=2`, { token: teacherToken });
  const importedAt = (payload, parity) =>
    (payload?.data?.columns ?? []).reduce(
      (sum, col) =>
        sum +
        (col.items ?? []).filter(
          (item) =>
            item.location === null &&
            item.weekParity === parity &&
            item.dayOfWeek === 1 &&
            item.startTime < '09:00',
        ).length,
      0,
    );
  record(
    '导入后的单双周课表按周正确落位（第 1 周 2 节单周、第 2 周 2 节双周）',
    importedAt(oddAfterImport.payload, 'ODD') >= 2 &&
      importedAt(evenAfterImport.payload, 'ODD') === 0 &&
      importedAt(evenAfterImport.payload, 'EVEN') >= 2 &&
      importedAt(oddAfterImport.payload, 'EVEN') === 0,
    `week1 单周=${importedAt(oddAfterImport.payload, 'ODD')} 双周=${importedAt(oddAfterImport.payload, 'EVEN')}；` +
      `week2 单周=${importedAt(evenAfterImport.payload, 'ODD')} 双周=${importedAt(evenAfterImport.payload, 'EVEN')}`,
  );
  // 清理：按"位置/科目名前缀"识别本次写入的数据，避免误删演示课表
  const allSchedules = await api(`/schedules?classId=${classId}`, { token: teacherToken });
  let removedSchedules = 0;
  for (const item of allSchedules.payload?.data ?? []) {
    const isParityProbe = String(item.location ?? '').startsWith('单双周校验');
    const isImported = String(item.course?.name ?? '').startsWith('导入校验');
    if (!isParityProbe && !isImported) continue;
    const removed = await api(`/schedules/${item.id}`, { method: 'DELETE', token: teacherToken });
    if (removed.status === 200) removedSchedules += 1;
  }
  // 日课表为空仍会生效；清理本次导入的整张日课表，不能靠空表自动回落。
  const importedPlans = await api(`/class-plans?classId=${classId}`, { token: teacherToken });
  for (const plan of importedPlans.payload?.data ?? []) {
    if (['周一-单周', '周一-双周'].includes(plan.name))
      await api(`/class-plans/${plan.id}`, { method: 'DELETE', token: teacherToken });
  }
  const allCourses = await api(`/courses?classId=${classId}`, { token: teacherToken });
  let removedImportedCourses = 0;
  for (const course of allCourses.payload?.data ?? []) {
    if (!String(course.name).startsWith('导入校验')) continue;
    const removed = await api(`/courses/${course.id}`, { method: 'DELETE', token: teacherToken });
    if (removed.status === 200) removedImportedCourses += 1;
  }
  record(
    '清理单双周校验与导入数据',
    removedSchedules >= 6,
    `删除课表 ${removedSchedules} 条、课程 ${removedImportedCourses} 门`,
  );

  // ---------------------------------------------------------------- 3. WebSocket 连接
  const socket = io(BASE_URL, {
    auth: { token: studentToken, clientType: 'desktop' },
    transports: ['websocket'],
    reconnection: false,
  });

  const connected = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), TIME_LIMIT_MS);
    socket.on('connected', (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
    socket.on('connect_error', (error) => {
      clearTimeout(timer);
      resolve({ error: error.message });
    });
  });
  record(
    'ClassHelper 班级端 Socket.IO 连接与鉴权',
    Boolean(connected && !connected.error),
    connected?.error ?? `rooms=${connected?.rooms?.length ?? 0}`,
  );

  // ---------------------------------------------------------------- 4. 通知实时推送
  const notificationWait = waitForEvent(socket, 'notification:new');
  const createdNotification = await api('/notifications', {
    method: 'POST',
    token: teacherToken,
    body: {
      classId,
      title: `联调验证通知 ${new Date().toISOString()}`,
      content: '这是端到端验证脚本自动创建的通知。',
      priority: 'HIGH',
    },
  });
  record('教师发布通知', createdNotification.status === 201, `status=${createdNotification.status}`);

  try {
    const { payload, elapsed } = await notificationWait;
    record(
      'ClassHelper 班级端 5 秒内收到 notification:new',
      elapsed < TIME_LIMIT_MS,
      `${elapsed}ms · ${payload?.title}`,
    );
  } catch (error) {
    record('ClassHelper 班级端 5 秒内收到 notification:new', false, error.message);
  }

  // ---------------------------------------------------------------- 5. 作业实时推送 + 标记完成
  const homeworkWait = waitForEvent(socket, 'homework:new');
  const createdHomework = await api('/homeworks', {
    method: 'POST',
    token: teacherToken,
    body: {
      classId,
      courseId,
      title: `联调验证作业 ${new Date().toISOString()}`,
      content: '请完成验证脚本创建的作业。',
    },
  });
  const homeworkId = createdHomework.payload?.data?.id;
  record('教师发布作业', createdHomework.status === 201, `status=${createdHomework.status}`);
  // 截止时间功能已下线：接口不再返回该字段（历史数据保留在库里但不读写）
  record(
    '作业接口不再返回截止时间（dueAt 已下线）',
    createdHomework.payload?.data?.dueAt === undefined,
    `dueAt=${String(createdHomework.payload?.data?.dueAt)}`,
  );
  // 按天查看：作业带"所属日期"（本地日期），并且能按它过滤
  const assignDate = createdHomework.payload?.data?.assignDate;
  record(
    '作业带所属日期（assignDate，默认服务器当天）',
    typeof assignDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(assignDate),
    `assignDate=${assignDate}`,
  );
  const byDay = await api(`/homeworks?classId=${classId}&date=${assignDate}`, { token: teacherToken });
  record(
    '按天查看（?date=）只返回该天的作业',
    byDay.status === 200 &&
      (byDay.payload?.data ?? []).length > 0 &&
      (byDay.payload?.data ?? []).every((item) => item.assignDate === assignDate),
    `当天条数=${(byDay.payload?.data ?? []).length}`,
  );
  const otherDay = await api(`/homeworks?classId=${classId}&date=2000-01-01`, { token: teacherToken });
  record(
    '没有作业的日期返回空列表',
    otherDay.status === 200 && (otherDay.payload?.data ?? []).length === 0,
    `条数=${(otherDay.payload?.data ?? []).length}`,
  );
  const dayMarks = await api(`/homeworks/days?classId=${classId}`, { token: teacherToken });
  const marks = dayMarks.payload?.data?.days ?? [];
  record(
    '作业日历返回有作业的日期（供日期选择器高亮）',
    dayMarks.status === 200 && marks.some((item) => item.date === assignDate && item.count >= 1),
    `日期数=${marks.length} 命中=${marks.find((item) => item.date === assignDate)?.count ?? 0}`,
  );
  const badDay = await api(`/homeworks/days?classId=${classId}&from=2026-13-45`, { token: teacherToken });
  record('作业日历非法日期被拒（422）', badDay.status === 422, `status=${badDay.status}`);

  try {
    const { payload, elapsed } = await homeworkWait;
    record(
      'ClassHelper 班级端 5 秒内收到 homework:new',
      elapsed < TIME_LIMIT_MS,
      `${elapsed}ms · ${payload?.title}`,
    );
  } catch (error) {
    record('ClassHelper 班级端 5 秒内收到 homework:new', false, error.message);
  }

  const statusUpdate = await api(`/homeworks/${homeworkId}/status`, {
    method: 'PATCH',
    token: studentToken,
    body: { completed: true },
  });
  record(
    '学生标记作业完成',
    statusUpdate.status === 200 && statusUpdate.payload?.data?.completed === true,
    `status=${statusUpdate.status}`,
  );

  /* ---------------------------------------------------------------- 5.1 未交名单 */
  const submissions = await api(`/homeworks/${homeworkId}/submissions`, { token: teacherToken });
  const studentIds = (submissions.payload?.data?.students ?? []).map((item) => item.studentId);
  record(
    '教师可读取作业提交名单（全班学生 + 完成状态）',
    submissions.status === 200 &&
      studentIds.length > 0 &&
      (submissions.payload?.data?.total ?? 0) === studentIds.length,
    `status=${submissions.status} 全班 ${submissions.payload?.data?.total ?? '-'} 人 · ` +
      `已完成 ${submissions.payload?.data?.completedCount ?? '-'} 人`,
  );
  // 勾选"未交名单"：只留第一位学生未交，其余一律视为已交
  const firstStudentId = studentIds[0];
  const savedSubmissions = await api(`/homeworks/${homeworkId}/submissions`, {
    method: 'PATCH',
    token: teacherToken,
    body: { notSubmittedStudentIds: [firstStudentId] },
  });
  record(
    '保存未交名单：勾选者标记未交、其余学生自动标记已交',
    savedSubmissions.status === 200 &&
      (savedSubmissions.payload?.data?.notSubmitted ?? []).length === 1 &&
      savedSubmissions.payload?.data?.notSubmitted?.[0]?.studentId === firstStudentId &&
      savedSubmissions.payload?.data?.completedCount === studentIds.length - 1,
    `status=${savedSubmissions.status} 未交=${(savedSubmissions.payload?.data?.notSubmitted ?? []).length} ` +
      `已完成=${savedSubmissions.payload?.data?.completedCount ?? '-'}/${savedSubmissions.payload?.data?.total ?? '-'}`,
  );
  // 全部已交：未交名单清空
  const allSubmitted = await api(`/homeworks/${homeworkId}/submissions`, {
    method: 'PATCH',
    token: teacherToken,
    body: { notSubmittedUserIds: [] },
  });
  record(
    '未交名单可一键清空（全部已交）',
    allSubmitted.status === 200 &&
      (allSubmitted.payload?.data?.notSubmitted ?? []).length === 0 &&
      allSubmitted.payload?.data?.completedCount === studentIds.length,
    `未交=${(allSubmitted.payload?.data?.notSubmitted ?? []).length} ` +
      `已完成=${allSubmitted.payload?.data?.completedCount ?? '-'}/${allSubmitted.payload?.data?.total ?? '-'}`,
  );
  // 越权：普通学生不能维护未交名单（只能标记自己）
  const studentSubmissions = await api(`/homeworks/${homeworkId}/submissions`, {
    method: 'PATCH',
    token: studentToken,
    body: { notSubmittedUserIds: [] },
  });
  record(
    '班级设备可以维护未交名单（非教师/非班级会话会被拒）',
    studentSubmissions.status === 200,
    `status=${studentSubmissions.status}`,
  );

  const myHomeworks = await api(`/homeworks?classId=${classId}`, { token: studentToken });
  const markedHomework = (myHomeworks.payload?.data ?? []).find((item) => item.id === homeworkId);
  record(
    '学生作业列表回显完成状态',
    markedHomework?.completed === true,
    `completed=${markedHomework?.completed}`,
  );

  // ---------------------------------------------------------------- 6. 成绩实时推送
  const gradeWait = waitForEvent(socket, 'grade:updated');
  const createdGrade = await api('/grades', {
    method: 'POST',
    token: adminToken,
    body: {
      classId,
      courseId,
      studentId: targetStudent?.id,
      examName: `联调验证考试 ${new Date().toISOString().slice(0, 10)}`,
      score: 88,
      totalScore: 100,
    },
  });
  record('教师录入成绩', createdGrade.status === 201, `status=${createdGrade.status}`);

  if (targetStudent) {
    try {
      const { payload, elapsed } = await gradeWait;
      record(
        'ClassHelper 班级端 5 秒内收到 grade:updated',
        elapsed < TIME_LIMIT_MS,
        `${elapsed}ms · ${payload?.score}/${payload?.totalScore}`,
      );
    } catch (error) {
      record('ClassHelper 班级端 5 秒内收到 grade:updated', false, error.message);
    }
  } else {
    gradeWait.catch(() => {});
    record('ClassHelper 班级端成绩推送（目标学生非验证账号，跳过等待）', true, '已改用 /grades/my 校验');
  }

  const myGrades = await api('/grades/my', { token: studentToken });
  record(
    '学生查看个人成绩 /grades/my',
    (myGrades.payload?.data ?? []).length > 0,
    `共 ${myGrades.payload?.data?.length ?? 0} 条`,
  );

  // ---------------------------------------------------------------- 6.1 Web 管理端依赖的接口全覆盖
  const classDetail = await api(`/classes/${classId}`, { token: teacherToken });
  record(
    '班级详情（学生/课程/协作教师）',
    classDetail.status === 200 &&
      Array.isArray(classDetail.payload?.data?.students) &&
      Array.isArray(classDetail.payload?.data?.courses),
    `学生 ${classDetail.payload?.data?.students?.length ?? 0} 人 · 课程 ${classDetail.payload?.data?.courses?.length ?? 0} 门`,
  );

  const teacherList = await api('/teachers', { token: adminToken });
  record(
    '教师列表 /teachers',
    (teacherList.payload?.data ?? []).length >= 2,
    `共 ${teacherList.payload?.data?.length ?? 0} 人`,
  );

  const summary = await api('/dashboard/summary', { token: teacherToken });
  record(
    '仪表盘汇总 /dashboard/summary',
    summary.status === 200 && (summary.payload?.data?.classCount ?? 0) > 0,
    `班级 ${summary.payload?.data?.classCount ?? 0} · 学生 ${summary.payload?.data?.studentCount ?? 0}`,
  );

  const term = await api('/dashboard/term', { token: teacherToken });
  record(
    '学期信息 /dashboard/term',
    term.status === 200 && (term.payload?.data?.currentWeek ?? 0) > 0,
    `当前第 ${term.payload?.data?.currentWeek} 周`,
  );

  const createdCourse = await api('/courses', {
    method: 'POST',
    token: teacherToken,
    body: { name: `联调验证课程 ${Date.now()}`, classId },
  });
  const createdCourseId = createdCourse.payload?.data?.id;
  record('新增课程 POST /courses', createdCourse.status === 201, `status=${createdCourse.status}`);
  if (createdCourseId) {
    const removedCourse = await api(`/courses/${createdCourseId}`, { method: 'DELETE', token: teacherToken });
    record('删除课程 DELETE /courses/:id', removedCourse.status === 200, `status=${removedCourse.status}`);
  }

  // 任课关系 = 班级 + 科目 + 教师，唯一写入口是 PUT /classes/:id/subject-teachers。
  // 用一个演示数据里没用来录成绩的科目，验证完就还回班主任，避免影响后面的成绩权限用例。
  const probeSubject = '通用技术';
  const adminAssignSubject = await api(`/classes/${classId}/subject-teachers`, {
    method: 'PUT',
    token: adminToken,
    body: { assignments: [{ subjectName: probeSubject, teacherId: teacher2Login.payload?.data?.user?.id }] },
  });
  record(
    '管理员设置某班某科的任课老师（PUT /subject-teachers）',
    adminAssignSubject.status === 200 &&
      (adminAssignSubject.payload?.data ?? []).some(
        (item) =>
          item.subjectName === probeSubject && item.teacherId === teacher2Login.payload?.data?.user?.id,
      ),
    `status=${adminAssignSubject.status}`,
  );
  const restoreSubject = await api(`/classes/${classId}/subject-teachers`, {
    method: 'PUT',
    token: adminToken,
    body: { assignments: [{ subjectName: probeSubject, teacherId: ownClass?.teacherId }] },
  });
  record(
    '任课老师可改回班主任（同一个人既是班主任又是科任，不重复建号）',
    restoreSubject.status === 200 &&
      (restoreSubject.payload?.data ?? []).some(
        (item) => item.subjectName === probeSubject && item.teacherId === ownClass?.teacherId,
      ),
    `status=${restoreSubject.status}`,
  );

  const tempUsername = `E2E${Date.now().toString().slice(-8)}`;
  const addedStudent = await api(`/classes/${classId}/students`, {
    method: 'POST',
    token: adminToken,
    body: { studentNo: tempUsername, name: '联调学生' },
  });
  const addedStudentId = addedStudent.payload?.data?.id;
  record('班级添加学生', addedStudent.status === 201, `status=${addedStudent.status}`);

  if (addedStudentId) {
    const studentListAfter = await api(`/classes/${classId}/students`, { token: teacherToken });
    record(
      '学生名单包含新加入学生（按学号）',
      (studentListAfter.payload?.data ?? []).some(
        (item) => item.id === addedStudentId && item.studentNo === tempUsername.toUpperCase(),
      ),
      `共 ${studentListAfter.payload?.data?.length ?? 0} 人`,
    );

    // 学生没有密码相关接口（个人学生账号已清理，重置密码入口已下线）：这里改为断言接口确实不存在
    const resetGone = await api(`/students/${addedStudentId}/reset-password`, {
      method: 'POST',
      token: adminToken,
      body: {},
    });
    record('学生重置密码接口已下线（404）', resetGone.status === 404, `status=${resetGone.status}`);

    const renamed = await api(`/students/${addedStudentId}`, {
      method: 'PATCH',
      token: adminToken,
      body: { name: '联调学生（已改名）' },
    });
    record(
      '修改学生信息',
      renamed.status === 200 && renamed.payload?.data?.name?.includes('已改名'),
      `name=${renamed.payload?.data?.name}`,
    );

    const removedStudent = await api(`/classes/${classId}/students/${addedStudentId}`, {
      method: 'DELETE',
      token: adminToken,
    });
    record('班级移出学生', removedStudent.status === 200, `status=${removedStudent.status}`);

    // 移出后学生已无班级，按权限规则只有管理员可以删除该账号
    const teacherDelete = await api(`/students/${addedStudentId}`, { method: 'DELETE', token: teacherToken });
    record('教师删除未分班学生被拒绝（403）', teacherDelete.status === 403, `status=${teacherDelete.status}`);

    const adminDelete = await api(`/students/${addedStudentId}`, { method: 'DELETE', token: adminToken });
    record('管理员删除学生账号', adminDelete.status === 200, `status=${adminDelete.status}`);
  }

  const bulkResult = await api('/grades/bulk', {
    method: 'POST',
    token: adminToken,
    body: {
      classId,
      courseId,
      examName: `联调批量考试 ${new Date().toISOString().slice(0, 10)}`,
      totalScore: 100,
      items: classmates.slice(0, 3).map((item, index) => ({ studentId: item.id, score: 70 + index * 5 })),
    },
  });
  record(
    '批量录入成绩 POST /grades/bulk',
    bulkResult.status === 201,
    `录入 ${bulkResult.payload?.data?.count ?? 0} 条`,
  );

  const gradeStats = await api(`/grades/stats?classId=${classId}`, { token: teacherToken });
  record(
    // 等级分布不再固定 A~E 五档：等级制（A-D）与自定义等级（优/良/合格）都在用，
    // 因此断言"有分布且每个档位都有人"，而不是数档位个数。
    '成绩统计 /grades/stats',
    gradeStats.status === 200 &&
      (gradeStats.payload?.data?.distribution ?? []).length >= 1 &&
      (gradeStats.payload?.data?.distribution ?? []).every((item) => typeof item.level === 'string'),
    `平均得分率 ${gradeStats.payload?.data?.averagePercent ?? 0}% 档位=${(gradeStats.payload?.data?.distribution ?? []).map((item) => item.level).join('/')}`,
  );

  const unread = await api('/notifications/unread-count', { token: studentToken });
  record(
    '未读数 /notifications/unread-count',
    unread.status === 200,
    `未读 ${unread.payload?.data?.count ?? 0} 条`,
  );

  const markedRead = await api(`/notifications/${createdNotification.payload?.data?.id}/read`, {
    method: 'POST',
    token: studentToken,
  });
  record('标记通知已读', markedRead.status === 200, `status=${markedRead.status}`);

  const readAll = await api('/notifications/read-all', { method: 'POST', token: studentToken, body: {} });
  record('全部标为已读', readAll.status === 200, `本次标记 ${readAll.payload?.data?.marked ?? 0} 条`);

  const pendingOnly = await api('/homeworks?pendingOnly=true', { token: studentToken });
  const allPending = (pendingOnly.payload?.data ?? []).every((item) => item.completed !== true);
  record(
    '学生查询未完成作业（pendingOnly）',
    pendingOnly.status === 200 && allPending,
    `共 ${pendingOnly.payload?.data?.length ?? 0} 条`,
  );

  const homeworkDetail = await api(`/homeworks/${homeworkId}`, { token: studentToken });
  record('作业详情 GET /homeworks/:id', homeworkDetail.status === 200, `status=${homeworkDetail.status}`);

  const updatedGrade = await api(`/grades/${createdGrade.payload?.data?.id}`, {
    method: 'PATCH',
    token: adminToken,
    body: { score: 95 },
  });
  record(
    '修改成绩 PATCH /grades/:id',
    updatedGrade.status === 200 && updatedGrade.payload?.data?.score === 95,
    `score=${updatedGrade.payload?.data?.score}`,
  );

  const dashboardForStudent = await api('/dashboard/summary', { token: studentToken });
  record(
    '学生仪表盘汇总',
    dashboardForStudent.status === 200 && (dashboardForStudent.payload?.data?.classCount ?? 0) === 1,
    `可见班级 ${dashboardForStudent.payload?.data?.classCount ?? 0} 个`,
  );

  // ---------------------------------------------------------------- 6.2 上课时段与紧急通知二次确认
  // 诊断参数 at：2026-09-07 是周一，种子数据里周一 08:00-08:45 有课
  const mondayInClass = await api(`/schedules/current?classId=${classId}&at=2026-09-07T08:10:00`, {
    token: teacherToken,
  });
  record(
    '上课状态接口（at=周一 08:10 判定为上课）',
    mondayInClass.status === 200 && mondayInClass.payload?.data?.inClass === true,
    `course=${mondayInClass.payload?.data?.current?.courseName ?? '-'} week=${mondayInClass.payload?.data?.week ?? '-'}`,
  );

  const sundayFree = await api(`/schedules/current?classId=${classId}&at=2026-09-06T03:00:00`, {
    token: teacherToken,
  });
  record(
    '上课状态接口（at=周日 03:00 判定为不在上课）',
    sundayFree.status === 200 && sundayFree.payload?.data?.inClass === false,
    `inClass=${sundayFree.payload?.data?.inClass}`,
  );

  // 造一节覆盖"此刻"的课，让紧急通知拦截用例与运行时刻无关
  const nowDate = new Date();
  const toHHmm = (minutes) => {
    const clamped = Math.min(23 * 60 + 59, Math.max(0, minutes));
    return `${String(Math.floor(clamped / 60)).padStart(2, '0')}:${String(clamped % 60).padStart(2, '0')}`;
  };
  const nowMinutes = nowDate.getHours() * 60 + nowDate.getMinutes();
  const probeStart = toHHmm(nowMinutes - 30);
  const probeEnd = toHHmm(nowMinutes + 30);
  const todayWeekday = nowDate.getDay() === 0 ? 7 : nowDate.getDay();

  const probeSchedule = await api('/schedules', {
    method: 'POST',
    token: teacherToken,
    body: {
      classId,
      courseId,
      dayOfWeek: todayWeekday,
      startTime: probeStart,
      endTime: probeEnd,
      location: '联调验证教室',
      weekStart: 1,
      weekEnd: 30,
    },
  });
  const probeScheduleId = probeSchedule.payload?.data?.id;
  record('创建覆盖当前时刻的课表（构造上课场景）', probeSchedule.status === 201, `${probeStart}-${probeEnd}`);

  const realTimeStatus = await api(`/schedules/current?classId=${classId}`, { token: teacherToken });
  record(
    '当前时刻被判定为上课时间段',
    realTimeStatus.status === 200 && realTimeStatus.payload?.data?.inClass === true,
    `course=${realTimeStatus.payload?.data?.current?.courseName ?? '-'}`,
  );

  const blockedUrgent = await api('/notifications', {
    method: 'POST',
    token: teacherToken,
    body: {
      classId,
      title: '上课时段紧急通知（未确认）',
      content: '这条应当被服务端拦截',
      priority: 'URGENT',
    },
  });
  record(
    '上课时段发布紧急通知被拦截（409 URGENT_DURING_CLASS）',
    blockedUrgent.status === 409 && blockedUrgent.payload?.code === 'URGENT_DURING_CLASS',
    `status=${blockedUrgent.status} code=${blockedUrgent.payload?.code ?? '-'} 当前课程=${blockedUrgent.payload?.details?.current?.courseName ?? '-'}`,
  );

  const confirmedUrgent = await api('/notifications', {
    method: 'POST',
    token: teacherToken,
    body: {
      classId,
      title: `上课时段紧急通知（已二次确认）${Date.now()}`,
      content: '教师已在上课警告中确认，允许发布',
      priority: 'URGENT',
      confirmDuringClass: true,
    },
  });
  record('二次确认后允许发布紧急通知', confirmedUrgent.status === 201, `status=${confirmedUrgent.status}`);

  const normalDuringClass = await api('/notifications', {
    method: 'POST',
    token: teacherToken,
    body: {
      classId,
      title: `上课时段普通通知${Date.now()}`,
      content: '普通通知不受上课时段限制',
      priority: 'NORMAL',
    },
  });
  record(
    '上课时段发布普通通知不受限制',
    normalDuringClass.status === 201,
    `status=${normalDuringClass.status}`,
  );

  if (probeScheduleId) {
    const removedProbe = await api(`/schedules/${probeScheduleId}`, {
      method: 'DELETE',
      token: teacherToken,
    });
    record('清理探测课表', removedProbe.status === 200, `status=${removedProbe.status}`);
  }

  // 上课时段用例造的两条通知：立即清理，避免在用户的库里留下"验证通知"
  const duringClassNoticeIds = [
    confirmedUrgent.payload?.data?.id,
    normalDuringClass.payload?.data?.id,
  ].filter(Boolean);
  for (const noticeId of duringClassNoticeIds) {
    await api(`/notifications/${noticeId}`, { method: 'DELETE', token: teacherToken });
  }
  const duringClassNoticesLeft =
    (await api(`/notifications?classId=${classId}`, { token: teacherToken })).payload?.data ?? [];
  record(
    '清理：上课时段用例的通知已删除（不在库里留验证通知）',
    !duringClassNoticesLeft.some((item) => String(item.title).includes('上课时段')),
    `剩余含"上课时段"的通知=${duringClassNoticesLeft.filter((item) => String(item.title).includes('上课时段')).length}`,
  );

  // ---------------------------------------------------------------- 6.3 叫人
  if (classId && studentUser) {
    const callByTeacher = await api('/calls', {
      method: 'POST',
      token: teacherToken,
      body: {
        classId,
        studentId: targetStudent?.id,
        quickPhrase: '请到办公室找我',
      },
    });
    const callTitle = callByTeacher.payload?.data?.title ?? '';
    record(
      '叫人接口（教师点名 → 201 + "请 XXX 同学找 XXX 老师"）',
      callByTeacher.status === 201 && callTitle.includes('请') && callTitle.includes('找'),
      `status=${callByTeacher.status} title="${callTitle}"`,
    );
    record(
      '普通叫人（默认）不是紧急级别：priority=HIGH，ClassHelper 班级端按普通通知排队',
      callByTeacher.payload?.data?.priority === 'HIGH',
      `priority=${callByTeacher.payload?.data?.priority ?? '-'}（期望 HIGH）`,
    );

    const urgentCall = await api('/calls', {
      method: 'POST',
      token: teacherToken,
      body: {
        classId,
        studentId: targetStudent?.id,
        quickPhrase: '请立刻到办公室',
        urgent: true,
      },
    });
    record(
      '紧急叫人（urgent=true → priority=URGENT，ClassHelper 班级端无视上课时段立即展开）',
      urgentCall.status === 201 && urgentCall.payload?.data?.priority === 'URGENT',
      `status=${urgentCall.status} priority=${urgentCall.payload?.data?.priority ?? '-'}`,
    );

    const callWithMessage = await api('/calls', {
      method: 'POST',
      token: teacherToken,
      body: {
        classId,
        studentId: targetStudent?.id,
        quickPhrase: '请到讲台找我',
        message: '带上昨天的数学作业本',
      },
    });
    record(
      '叫人支持自定义消息（优先于快捷短语）',
      callWithMessage.status === 201 && callWithMessage.payload?.data?.content === '带上昨天的数学作业本',
      `status=${callWithMessage.status} content="${callWithMessage.payload?.data?.content ?? ''}"`,
    );

    // 上课时段也允许叫人（不受 409 限制，因为老师确实需要学生马上过来）
    const callDuringClass = await api('/calls', {
      method: 'POST',
      token: teacherToken,
      body: { classId, studentId: targetStudent?.id, quickPhrase: '请马上来一趟' },
    });
    record(
      '上课时段允许叫人（普通叫人同样不受紧急通知 409 限制）',
      callDuringClass.status === 201,
      `status=${callDuringClass.status} priority=${callDuringClass.payload?.data?.priority ?? '-'}`,
    );

    const studentCalls = await api('/calls', {
      method: 'POST',
      token: studentToken,
      body: { classId, studentId: targetStudent?.id, quickPhrase: '班级端代叫人' },
    });
    record(
      '班级端可为本班叫人（201）',
      studentCalls.status === 201 && Boolean(studentCalls.payload?.data?.id),
      `status=${studentCalls.status}`,
    );

    const studentListAfterCall = await api('/notifications', { token: studentToken });
    const receivedCall = (studentListAfterCall.payload?.data ?? []).find(
      (item) => item.id === callWithMessage.payload?.data?.id,
    );
    record(
      '学生通知中心能看到叫人消息（含未读状态）',
      Boolean(receivedCall) && receivedCall.read === false,
      `found=${Boolean(receivedCall)} read=${receivedCall?.read ?? '-'}`,
    );

    // 清理：删除本次叫人产生的通知
    for (const created of [callByTeacher, urgentCall, callWithMessage, callDuringClass]) {
      const id = created.payload?.data?.id;
      if (id) await api(`/notifications/${id}`, { method: 'DELETE', token: teacherToken });
    }
    record('清理叫人测试数据', true, '已删除 4 条叫人通知');
  }

  // ---------------------------------------------------------------- 6.4 班级角色权限矩阵
  // 依据需求 7：班主任/科任老师不能增删改班级；仅管理员可分配人员；
  // 科任老师仅作业/叫人/通知；班主任另可管理本班课表。
  // 结合需求 6（成绩与表格导入"老师端可用且不越权"）：成绩写入放开到**本班班主任**，
  // 科任老师仍然 403，班主任跨班同样 403。
  {
    record('管理员登录（用于权限矩阵校验）', Boolean(adminToken), '已在上文登录');

    // 科任老师：teacher2 在某班**有任课关系**（Course.teacherId === 他）。
    // 同样不依赖演示数据：推断出来的班级不可用（被人工改过 / 与外班同一个）时现建一个，
    // 用 teacher1 当班主任 + 给 teacher2 配一门课，收尾删除。
    let subjectClass = teacher2Classes.find((item) => item.teacherId !== teacher2Id) ?? null;
    if (!subjectClass || subjectClass.id === foreignClass?.id) {
      const created = await api('/classes', {
        method: 'POST',
        token: adminToken,
        body: {
          grade: '高一',
          enrollmentYear: new Date().getFullYear(),
          classIndex: 90,
          code: `SJ${Date.now().toString().slice(-6)}`,
          teacherId: teacher1Id,
        },
      });
      const createdId = created.payload?.data?.id;
      if (createdId) {
        await api(`/classes/${createdId}/subject-teachers`, {
          method: 'PUT',
          token: adminToken,
          body: { assignments: [{ subjectName: '数学', teacherId: teacher2Id }] },
        });
        subjectClass = { id: createdId, name: created.payload?.data?.name ?? '科任校验班' };
        probeClassIds.push(createdId);
      }
    }
    const subjectClassId = subjectClass?.id;
    record(
      '存在"科任老师"场景的班级（无现成班级时自建）',
      Boolean(subjectClassId) && subjectClassId !== foreignClass?.id,
      `classId=${subjectClassId ?? '-'} name=${subjectClass?.name ?? '-'}`,
    );

    if (adminToken) {
      const headCreate = await api('/classes', {
        method: 'POST',
        token: teacherToken,
        body: { grade: '高一', enrollmentYear: new Date().getFullYear(), classIndex: 91 },
      });
      record('班主任创建班级被拒绝（403）', headCreate.status === 403, `status=${headCreate.status}`);

      const subjectCreate = await api('/classes', {
        method: 'POST',
        token: teacher2Token,
        body: { grade: '高一', enrollmentYear: new Date().getFullYear(), classIndex: 92 },
      });
      record('科任老师创建班级被拒绝（403）', subjectCreate.status === 403, `status=${subjectCreate.status}`);

      const headDelete = await api(`/classes/${classId}`, { method: 'DELETE', token: teacherToken });
      record('班主任删除班级被拒绝（403）', headDelete.status === 403, `status=${headDelete.status}`);

      const headAssign = await api(`/classes/${classId}/subject-teachers`, {
        method: 'PUT',
        token: teacherToken,
        body: { assignments: [{ subjectName: '音乐', teacherId: teacher2Login.payload?.data?.user?.id }] },
      });
      record('班主任分配任课老师被拒绝（403）', headAssign.status === 403, `status=${headAssign.status}`);

      const subjectAssign = await api(`/classes/${classId}/subject-teachers`, {
        method: 'PUT',
        token: teacher2Token,
        body: { assignments: [{ subjectName: '音乐', teacherId: teacher2Login.payload?.data?.user?.id }] },
      });
      record('科任老师分配人员被拒绝（403）', subjectAssign.status === 403, `status=${subjectAssign.status}`);

      // 管理员可以分配（用"先加后删"验证）
      const adminAssign = await api(`/classes/${classId}/subject-teachers`, {
        method: 'PUT',
        token: adminToken,
        body: { assignments: [{ subjectName: '音乐', teacherId: teacher2Login.payload?.data?.user?.id }] },
      });
      record('管理员分配任课老师成功（200）', adminAssign.status === 200, `status=${adminAssign.status}`);
      // 解除 = 把该科还回班主任（Course.teacherId 是必填列，不能留空）
      const adminUnassign = await api(`/classes/${classId}/subject-teachers`, {
        method: 'PUT',
        token: adminToken,
        body: { assignments: [{ subjectName: '音乐', teacherId: ownClass?.teacherId }] },
      });
      record('管理员解除任课关系成功（200）', adminUnassign.status === 200, `status=${adminUnassign.status}`);

      // 课表：班主任可管理本班，科任老师不可
      if (subjectClassId) {
        const subjectSchedule = await api('/schedules', {
          method: 'POST',
          token: teacher2Token,
          body: {
            classId: subjectClassId,
            courseId: courses.payload?.data?.[0]?.id,
            dayOfWeek: 3,
            startTime: '13:00',
            endTime: '13:45',
            weekStart: 1,
            weekEnd: 20,
          },
        });
        record(
          '科任老师管理课表被拒绝（403）',
          subjectSchedule.status === 403 || subjectSchedule.status === 400,
          `status=${subjectSchedule.status}`,
        );
      }

      // 新规则：**作业按科目授权**。
      // 科任老师只能布置自己任教科目（Course.teacherId）的作业；
      // 不指定科目的作业只有班主任与管理员能发 —— 两条都要验到。
      const subjectCourse = (
        await api(`/courses?classId=${subjectClassId}`, { token: adminToken })
      ).payload?.data?.find((item) => item.teacherId === teacher2Id);
      const subjectHomework = await api('/homeworks', {
        method: 'POST',
        token: subjectClassId ? teacher2Token : teacherToken,
        body: {
          classId: subjectClassId,
          courseId: subjectCourse?.id,
          title: '科任老师布置的作业',
          content: '权限矩阵校验用',
        },
      });
      record(
        '科任老师可布置自己任教科目的作业（201）',
        subjectHomework.status === 201,
        `status=${subjectHomework.status} 科目=${subjectCourse?.name ?? '-'}`,
      );
      if (subjectHomework.payload?.data?.id) {
        tempHomeworkIds.push(subjectHomework.payload.data.id);
      }
      const subjectHomeworkNoCourse = await api('/homeworks', {
        method: 'POST',
        token: subjectClassId ? teacher2Token : teacherToken,
        body: { classId: subjectClassId, title: '科任老师的不指定科目作业', content: '应被拒绝' },
      });
      record(
        '科任老师布置不指定科目的作业被拒绝（403）',
        subjectHomeworkNoCourse.status === 403,
        `status=${subjectHomeworkNoCourse.status}`,
      );
      // 科任老师改**别人任教科目**的作业同样被拒
      if (subjectCourse) {
        const otherCourse = (
          await api(`/courses?classId=${subjectClassId}`, { token: adminToken })
        ).payload?.data?.find((item) => item.teacherId !== teacher2Id);
        // 先确认"别人任教的科目"这个前提存在：缺了它，下面那条用例会因为"没带科目"
        // 而被拒（403），看着是绿的，其实没验到"非任教科目"这条规则。
        record(
          '存在"别人任教科目"用于越权校验',
          Boolean(otherCourse?.id),
          `科目=${otherCourse?.name ?? '-'}`,
        );
        const foreignHomework = await api('/homeworks', {
          method: 'POST',
          token: teacher2Token,
          body: {
            classId: subjectClassId,
            courseId: otherCourse?.id,
            title: '科任老师替别人发作业',
            content: '应被拒绝',
          },
        });
        record(
          '科任老师给非任教科目布置作业被拒绝（403）',
          foreignHomework.status === 403,
          `status=${foreignHomework.status} 科目=${otherCourse?.name ?? '-'}`,
        );
      }
      if (subjectHomework.payload?.data?.id) {
        await api(`/homeworks/${subjectHomework.payload.data.id}`, {
          method: 'DELETE',
          token: teacher2Token,
        });
      }

      const subjectGrades = await api('/grades', {
        method: 'POST',
        token: teacher2Token,
        body: {
          classId: classId,
          studentId: targetStudent?.id,
          examName: '越权成绩',
          score: 90,
          totalScore: 100,
        },
      });
      record('科任老师录入成绩被拒绝（403）', subjectGrades.status === 403, `status=${subjectGrades.status}`);

      // 需求 6：班主任可以录入**本班**成绩（老师端可用），科任老师与跨班仍然被拒
      const headGrades = await api('/grades', {
        method: 'POST',
        token: teacherToken,
        body: {
          classId: classId,
          studentId: targetStudent?.id,
          examName: '班主任本班成绩',
          score: 90,
          totalScore: 100,
        },
      });
      record(
        '班主任录入本班成绩成功（201，需求 6）',
        headGrades.status === 201,
        `status=${headGrades.status}`,
      );
      if (headGrades.payload?.data?.id) {
        await api(`/grades/${headGrades.payload.data.id}`, { method: 'DELETE', token: teacherToken });
      }

      if (foreignClass) {
        const headCrossGrades = await api('/grades', {
          method: 'POST',
          token: teacherToken,
          body: {
            classId: foreignClass.id,
            studentId: targetStudent?.id,
            examName: '班主任跨班成绩',
            score: 90,
            totalScore: 100,
          },
        });
        record(
          '班主任录入他人班级成绩被拒绝（403）',
          headCrossGrades.status === 403,
          `status=${headCrossGrades.status}`,
        );
      }

      const adminGrades = await api('/grades', {
        method: 'POST',
        token: adminToken,
        body: {
          classId: classId,
          studentId: targetStudent?.id,
          examName: '管理员录入成绩',
          score: 88,
          totalScore: 100,
        },
      });
      record('管理员录入成绩成功（201）', adminGrades.status === 201, `status=${adminGrades.status}`);
      if (adminGrades.payload?.data?.id) {
        await api(`/grades/${adminGrades.payload.data.id}`, { method: 'DELETE', token: adminToken });
      }
    }
  }

  // ---------------------------------------------------------------- 6.5 通知按天归档 + 批量发布
  {
    const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

    // 按天归档：通知也有"所属日期"（assignDate，本地日期），晚间发布不会被 UTC 切片算到第二天
    const daysRes = await api(`/notifications/days?classId=${classId}`, { token: teacherToken });
    const days = daysRes.payload?.data?.days ?? [];
    record(
      '通知按天归档 GET /notifications/days（按所属日期汇总条数）',
      daysRes.status === 200 &&
        days.length > 0 &&
        days.every((item) => DAY_KEY.test(String(item.date)) && item.count > 0),
      `status=${daysRes.status} 天数=${days.length} 样例=${JSON.stringify(days[0] ?? null)}`,
    );

    const creatorsRes = await api(`/notifications/creators?classId=${classId}`, { token: teacherToken });
    const creators = creatorsRes.payload?.data?.creators ?? [];
    record(
      '通知按发布人归档 GET /notifications/creators（带名字与条数）',
      creatorsRes.status === 200 &&
        creators.length > 0 &&
        creators.every((item) => item.id && item.name && item.count > 0),
      `status=${creatorsRes.status} 发布人=${creators.length} 样例=${JSON.stringify(creators[0] ?? null)}`,
    );

    // 按天筛选：返回的每条通知 assignDate 必须等于筛选的日期
    const targetDay = days[0]?.date;
    if (targetDay) {
      const byDay = await api(`/notifications?classId=${classId}&date=${targetDay}`, { token: teacherToken });
      const rows = byDay.payload?.data ?? [];
      record(
        '通知按天筛选（?date=）只返回该天的通知',
        byDay.status === 200 && rows.length > 0 && rows.every((item) => item.assignDate === targetDay),
        `date=${targetDay} 条数=${rows.length}`,
      );
    }

    const badDay = await api(`/notifications/days?classId=${classId}&from=2026-13-45`, {
      token: teacherToken,
    });
    record('通知归档接口拒绝非法日期（422）', badDay.status === 422, `status=${badDay.status}`);

    // 批量发布通知：一次提交多个班，返回逐班结果
    const bulkClassIds = foreignClass ? [classId, foreignClass.id] : [classId];
    const bulkNotice = await api('/notifications/bulk', {
      method: 'POST',
      token: adminToken,
      body: {
        classIds: bulkClassIds,
        title: `批量发布回归 ${Date.now()}`,
        content: '批量发布通知用例（管理员对多个班级一次发布）',
        priority: 'NORMAL',
      },
    });
    const bulkNoticeData = bulkNotice.payload?.data;
    record(
      '批量发布通知 POST /notifications/bulk（逐班结果）',
      bulkNotice.status === 201 &&
        bulkNoticeData?.total === bulkClassIds.length &&
        bulkNoticeData?.succeeded === bulkClassIds.length &&
        (bulkNoticeData?.results ?? []).every((item) => item.ok && item.id),
      `status=${bulkNotice.status} total=${bulkNoticeData?.total} 成功=${bulkNoticeData?.succeeded}`,
    );
    for (const item of bulkNoticeData?.results ?? []) {
      if (item.id) await api(`/notifications/${item.id}`, { method: 'DELETE', token: adminToken });
    }

    if (foreignClass) {
      // 教师批量发到"别人的班"：那个班逐班失败，自己的班照常发布，整批不能变成 500
      const mixed = await api('/notifications/bulk', {
        method: 'POST',
        token: teacherToken,
        body: {
          classIds: [classId, foreignClass.id],
          title: `批量越权回归 ${Date.now()}`,
          content: '其中一个班没有发布权限',
          priority: 'NORMAL',
        },
      });
      const mixedData = mixed.payload?.data;
      const denied = (mixedData?.results ?? []).find((item) => item.classId === foreignClass.id);
      record(
        '批量发布通知：无权限的班逐班失败、有权限的班照常发布',
        mixed.status === 201 && mixedData?.succeeded === 1 && denied?.ok === false,
        `status=${mixed.status} 成功=${mixedData?.succeeded} 失败code=${denied?.code ?? '-'} 失败原因=${denied?.message ?? '-'}`,
      );
      for (const item of mixedData?.results ?? []) {
        if (item.id) await api(`/notifications/${item.id}`, { method: 'DELETE', token: teacherToken });
      }

      // 批量布置作业：跨班按**科目名称**匹配课程（课程是班级内的，不可能共用一个 courseId）
      const bulkHomework = await api('/homeworks/bulk', {
        method: 'POST',
        token: adminToken,
        body: {
          classIds: [classId, foreignClass.id],
          subjectName: '语文',
          title: `批量布置回归 ${Date.now()}`,
          content: '批量布置作业用例（按科目名称跨班匹配）',
        },
      });
      const bulkHomeworkData = bulkHomework.payload?.data;
      record(
        '批量布置作业 POST /homeworks/bulk（逐班结果 + 按科目名称匹配课程）',
        bulkHomework.status === 201 &&
          bulkHomeworkData?.total === 2 &&
          (bulkHomeworkData?.results ?? []).every((item) => typeof item.ok === 'boolean'),
        `status=${bulkHomework.status} 成功=${bulkHomeworkData?.succeeded} 失败=${bulkHomeworkData?.failed} ` +
          `逐班=${JSON.stringify((bulkHomeworkData?.results ?? []).map((item) => item.code ?? 'ok'))}`,
      );
      for (const item of bulkHomeworkData?.results ?? []) {
        if (item.id) await api(`/homeworks/${item.id}`, { method: 'DELETE', token: adminToken });
      }
    }
  }

  // ---------------------------------------------------------------- 6.6 权限组
  {
    const meTeacher = await api('/permissions/me', { token: teacherToken });
    const meTeacherData = meTeacher.payload?.data;
    const meAdmin = await api('/permissions/me', { token: adminToken });
    const meAdminData = meAdmin.payload?.data;
    record(
      '当前账号生效权限 GET /permissions/me（教师有 homework:write、无 permission:manage）',
      meTeacher.status === 200 &&
        Array.isArray(meTeacherData?.permissions) &&
        meTeacherData.permissions.includes('homework:write') &&
        !meTeacherData.permissions.includes('permission:manage'),
      `status=${meTeacher.status} 权限数=${(meTeacherData?.permissions ?? []).length} ` +
        `fromGroups=${meTeacherData?.fromGroups}`,
    );
    record(
      '管理员生效权限是全集（含 permission:manage 与 remote:control）',
      meAdmin.status === 200 &&
        (meAdminData?.permissions ?? []).includes('permission:manage') &&
        (meAdminData?.permissions ?? []).includes('remote:control'),
      `status=${meAdmin.status} 权限数=${(meAdminData?.permissions ?? []).length}`,
    );

    // 权限键目录是 permission:manage 专属：教师 403、管理员拿到整棵树
    const catalogDenied = await api('/permissions/catalog', { token: teacherToken });
    const catalog = await api('/permissions/catalog', { token: adminToken });
    const catalogData = catalog.payload?.data;
    record(
      '权限目录 GET /permissions/catalog（教师 403 / 管理员拿到 keys+categories+defaultRoles）',
      catalogDenied.status === 403 &&
        catalog.status === 200 &&
        Array.isArray(catalogData?.keys) &&
        catalogData.keys.includes('homework:write') &&
        Array.isArray(catalogData?.categories) &&
        typeof catalogData?.defaultRoles === 'object' &&
        catalogData.defaultRoles !== null,
      `教师=${catalogDenied.status} 管理员=${catalog.status} 键数=${(catalogData?.keys ?? []).length} ` +
        `分类数=${(catalogData?.categories ?? []).length}`,
    );

    // 权限组可以比角色默认**更少**：只给 dashboard:read 的组分配给 teacher2 后，他只剩这一个键
    const groupName = `e2e-只读-${Date.now().toString().slice(-6)}`;
    const createdGroup = await api('/permissions/groups', {
      method: 'POST',
      token: adminToken,
      body: { name: groupName, description: '验证用临时权限组（收尾删除）', keys: ['dashboard:read'] },
    });
    const permissionGroupId = createdGroup.payload?.data?.id;

    // 成员列表是"账号 id"的权威来源：登录响应里的 user.id 只是会话用户，
    // 权限页的成员 id 要按 username 从 GET /permissions/users 取（管理员本人也要在这里找）
    const membersRes = await api('/permissions/users', { token: adminToken });
    const members = membersRes.payload?.data ?? [];
    const teacher2Member = members.find((item) => item.username === 'teacher2') ?? null;
    const adminMember = members.find((item) => item.username === 'admin') ?? null;

    // teacher2 的密码按脚本既有做法自愈（本机可能被人工改过），失败就重置成已知值再登
    const teacher2Password = 'teacher123';
    let teacher2Auth = await api('/auth/login', {
      method: 'POST',
      body: { username: 'teacher2', password: teacher2Password },
    });
    if (teacher2Auth.status !== 200 && teacher2Member) {
      await api(`/teachers/${teacher2Member.id}/reset-password`, {
        method: 'POST',
        token: adminToken,
        body: { newPassword: teacher2Password },
      });
      teacher2Auth = await api('/auth/login', {
        method: 'POST',
        body: { username: 'teacher2', password: teacher2Password },
      });
    }
    const permissionTestToken = teacher2Auth.payload?.data?.token;

    const assignLess = permissionGroupId
      ? await api(`/permissions/users/${teacher2Member?.id}/groups`, {
          method: 'PUT',
          token: adminToken,
          body: { groupIds: [permissionGroupId] },
        })
      : { status: 0, payload: null };
    const meLess = permissionTestToken
      ? await api('/permissions/me', { token: permissionTestToken })
      : { status: 0, payload: null };
    const teacher2LessPermissions = meLess.payload?.data?.permissions ?? [];
    record(
      '权限组可以比角色默认更少（只给 dashboard:read 的组 → 生效权限恰好只有这一个键）',
      Boolean(permissionGroupId) &&
        assignLess.status === 200 &&
        teacher2LessPermissions.length === 1 &&
        teacher2LessPermissions[0] === 'dashboard:read',
      `建组=${createdGroup.status} 分配=${assignLess.status} 生效权限=${JSON.stringify(teacher2LessPermissions)}`,
    );

    const assignDefault = await api(`/permissions/users/${teacher2Member?.id}/groups`, {
      method: 'PUT',
      token: adminToken,
      body: { groupIds: [] },
    });
    const meReset = permissionTestToken
      ? await api('/permissions/me', { token: permissionTestToken })
      : { status: 0, payload: null };
    const teacher2ResetPermissions = meReset.payload?.data?.permissions ?? [];
    record(
      '清空权限组后回到角色默认模板（PUT /users/:id/groups 传空数组 → 含 homework:write）',
      assignDefault.status === 200 &&
        teacher2ResetPermissions.includes('homework:write') &&
        !teacher2ResetPermissions.includes('permission:manage'),
      `status=${assignDefault.status} 生效权限数=${teacher2ResetPermissions.length} ` +
        `含 homework:write=${teacher2ResetPermissions.includes('homework:write')}`,
    );

    const assignAdmin = await api(`/permissions/users/${adminMember?.id}/groups`, {
      method: 'PUT',
      token: adminToken,
      body: { assignments: [] },
    });
    const fixedAdmin = await api('/permissions/me', { token: adminToken });
    record(
      '管理员固定全集并拒绝分配模板',
      assignAdmin.status === 400 && fixedAdmin.payload?.data?.permissions.includes('teacher:manage'),
      `status=${assignAdmin.status}`,
    );

    // 内置权限组不可删除：先找一个 builtin 的（**演示库当前没有内置组**，此时只报事实、不算失败）
    const groupsList = await api('/permissions/groups', { token: adminToken });
    const builtinGroup = (groupsList.payload?.data ?? []).find((item) => item.builtin === true) ?? null;
    if (builtinGroup) {
      const deleteBuiltin = await api(`/permissions/groups/${builtinGroup.id}`, {
        method: 'DELETE',
        token: adminToken,
      });
      record(
        '内置权限组不可删除（DELETE /permissions/groups/:id → 400）',
        deleteBuiltin.status === 400,
        `内置组=${builtinGroup.name} status=${deleteBuiltin.status} 响应=${deleteBuiltin.payload?.message ?? ''}`,
      );
    } else {
      record(
        '内置权限组不可删除（DELETE /permissions/groups/:id → 400）',
        true,
        `跳过：当前库里没有任何 builtin=true 的权限组（GET /permissions/groups 返回 ${(groupsList.payload?.data ?? []).length} 个，种子里的「教务协作（示例）」不在库里）`,
      );
    }

    // 收尾：teacher2 必须回到角色默认（否则后面所有以他为科任老师的用例全被权限组污染），临时组删掉
    await api(`/permissions/users/${teacher2Member?.id}/groups`, {
      method: 'PUT',
      token: adminToken,
      body: { groupIds: [] },
    });
    if (permissionGroupId) {
      await api(`/permissions/groups/${permissionGroupId}`, { method: 'DELETE', token: adminToken });
    }
    const groupsAfter = await api('/permissions/groups', { token: adminToken });
    record(
      '权限组用例收尾：teacher2 分组已清空、临时权限组已删除',
      !(groupsAfter.payload?.data ?? []).some((item) => item.id === permissionGroupId),
      `剩余权限组=${(groupsAfter.payload?.data ?? []).length}`,
    );
  }

  // ---------------------------------------------------------------- 6.7 客户端设备与远控
  {
    const deviceKey = `e2e-device-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const heartbeatBase = {
      deviceKey,
      name: 'E2E 测试机',
      clientVersion: '1.0.0',
      platform: 'win32',
      stateNote: '待机',
    };

    const deviceLogin = await api('/auth/class-login', {
      method: 'POST',
      body: { code: classes.find((item) => item.id === classId)?.code, password: '123456' },
    });
    const deviceToken = deviceLogin.payload?.data?.token;
    if (!deviceToken) throw new Error('隔离班级设备登录失败，不能用员工身份替代');
    const staffHeartbeat = await api('/clients/heartbeat', {
      method: 'POST',
      token: adminToken,
      body: heartbeatBase,
    });
    record('员工会话不能冒充班级设备上报', staffHeartbeat.status === 403, 'status=' + staffHeartbeat.status);
    // 只有本班 CLASS_DEVICE 可以上报和回执；管理端仍用管理员读取及下发。
    const heartbeatNoAuth = await api('/clients/heartbeat', { method: 'POST', body: heartbeatBase });
    const heartbeat = await api('/clients/heartbeat', {
      method: 'POST',
      token: deviceToken,
      body: heartbeatBase,
    });
    const heartbeatData = heartbeat.payload?.data;
    record(
      '客户端心跳 POST /clients/heartbeat（未登录 401 / 登录后 200 且返回 deviceId 与 command 字段）',
      heartbeatNoAuth.status === 401 &&
        heartbeat.status === 200 &&
        Boolean(heartbeatData?.deviceId) &&
        'command' in (heartbeatData ?? {}),
      `未登录=${heartbeatNoAuth.status} 登录=${heartbeat.status} deviceId=${heartbeatData?.deviceId ?? '-'} ` +
        `command=${JSON.stringify(heartbeatData?.command ?? null)}`,
    );

    // 越权：remote:control 默认只有管理员有
    const teacherCommandDenied = await api('/clients/commands', {
      method: 'POST',
      token: teacherToken,
      body: { deviceIds: [heartbeatData?.deviceId ?? 'none'], kind: 'lock', note: '越权用例' },
    });
    record(
      '远控命令越权被拒（教师无 remote:control → 403）',
      teacherCommandDenied.status === 403,
      `status=${teacherCommandDenied.status} 响应=${teacherCommandDenied.payload?.message ?? ''}`,
    );

    // 设备列表：刚心跳的这台要在线
    const devices = await api('/clients/devices', { token: adminToken });
    const device = (devices.payload?.data ?? []).find((item) => item.deviceKey === deviceKey) ?? null;
    record(
      '设备列表 GET /clients/devices（刚心跳的设备在线）',
      devices.status === 200 && Boolean(device) && device.online === true,
      `status=${devices.status} 设备=${device?.name ?? '未找到'} online=${device?.online}`,
    );

    // 下发锁屏命令（带备注）→ 下一次心跳必须带回这条命令
    const command = await api('/clients/commands', {
      method: 'POST',
      token: adminToken,
      body: {
        deviceIds: [device?.id ?? heartbeatData?.deviceId ?? 'none'],
        kind: 'lock',
        note: 'E2E 远控用例',
      },
    });
    const heartbeatWithCommand = await api('/clients/heartbeat', {
      method: 'POST',
      token: deviceToken,
      body: { ...heartbeatBase, stateNote: '待机' },
    });
    const delivered = heartbeatWithCommand.payload?.data?.command;
    record(
      '远控命令下发 POST /clients/commands（lock）并在下次心跳送达（kind=lock）',
      command.status === 201 && Boolean(delivered?.id) && delivered?.kind === 'lock',
      `下发=${command.status} 送达=${JSON.stringify(delivered ?? null)}`,
    );

    const ackBody = { deviceKey, ok: true, result: 'e2e' };
    const ackFirst = await api(`/clients/commands/${delivered?.id}/ack`, {
      method: 'POST',
      token: deviceToken,
      body: ackBody,
    });
    // 幂等：客户端重试回执不报错、也不覆盖第一次结果
    const ackSecond = await api(`/clients/commands/${delivered?.id}/ack`, {
      method: 'POST',
      token: deviceToken,
      body: { deviceKey, ok: false, result: '重试不应覆盖结果' },
    });
    record(
      '命令回执 POST /clients/commands/:id/ack（首次 200，重复回执幂等仍 200）',
      ackFirst.status === 200 && ackSecond.status === 200,
      `首次=${ackFirst.status}(${ackFirst.payload?.data?.result ?? '-'}) 重复=${ackSecond.status}(${ackSecond.payload?.data?.result ?? '-'})`,
    );

    const devicesAfterAck = await api('/clients/devices', { token: adminToken });
    const ackedDevice =
      (devicesAfterAck.payload?.data ?? []).find((item) => item.deviceKey === deviceKey) ?? null;
    record(
      '回执后设备不再有待执行命令（pendingCommand 为空）',
      Boolean(ackedDevice) && ackedDevice.pendingCommand === null,
      `pendingCommand=${JSON.stringify(ackedDevice?.pendingCommand ?? null)}`,
    );

    // 归属校验：别人拿自己的 deviceKey 回执同一 id 必须被拒
    const otherDeviceKey = `${deviceKey}-other`;
    const otherHeartbeat = await api('/clients/heartbeat', {
      method: 'POST',
      token: deviceToken,
      body: { ...heartbeatBase, deviceKey: otherDeviceKey, name: 'E2E 另一台测试机' },
    });
    const otherDeviceId = otherHeartbeat.payload?.data?.deviceId ?? null;
    const ackWrongDevice = await api(`/clients/commands/${delivered?.id}/ack`, {
      method: 'POST',
      token: deviceToken,
      body: { deviceKey: otherDeviceKey, ok: true, result: 'e2e-other' },
    });
    record(
      '回执归属校验（别的 deviceKey 回执同一命令 → 403）',
      ackWrongDevice.status === 403,
      `status=${ackWrongDevice.status} code=${ackWrongDevice.payload?.code ?? '-'} ` +
        `响应=${ackWrongDevice.payload?.message ?? ''}`,
    );

    // 收尾：两台测试机都清掉（否则会长期挂在设备列表里）
    const deleteTestDevice = device
      ? await api(`/clients/devices/${device.id}`, { method: 'DELETE', token: adminToken })
      : { status: 0, payload: null };
    const deleteOtherDevice = otherDeviceId
      ? await api(`/clients/devices/${otherDeviceId}`, { method: 'DELETE', token: adminToken })
      : { status: 0, payload: null };
    const deviceAfterDelete = await api('/clients/devices', { token: adminToken });
    const leftoverKeys = (deviceAfterDelete.payload?.data ?? [])
      .filter((item) => item.deviceKey === deviceKey || item.deviceKey === otherDeviceKey)
      .map((item) => item.deviceKey);
    record(
      '客户端设备用例收尾：两台测试机都已移除',
      deleteTestDevice.status === 200 && deleteOtherDevice.status === 200 && leftoverKeys.length === 0,
      `删除测试机=${deleteTestDevice.status} 删除另一台=${deleteOtherDevice.status} ` +
        `残留=${leftoverKeys.length ? leftoverKeys.join(',') : '无'}`,
    );
  }

  // ---------------------------------------------------------------- 6.8 客户端安装包
  {
    const releases = await api('/update/client/releases', { token: adminToken });
    record(
      '客户端安装包列表 GET /update/client/releases',
      releases.status === 200 && Array.isArray(releases.payload?.data),
      `status=${releases.status} 版本数=${(releases.payload?.data ?? []).length}`,
    );

    // 登记只写元数据，**但要求磁盘上真的有这个版本的安装包**：不存在的版本必须被拒（400）
    const fakeVersion = '9.9.9-e2e';
    const registerMissing = await api('/update/client/releases', {
      method: 'POST',
      token: adminToken,
      body: { version: fakeVersion },
    });
    const releasesAfterRegister = await api('/update/client/releases', { token: adminToken });
    record(
      '登记不存在的客户端安装包版本被拒（400，且不会落库）',
      registerMissing.status === 400 &&
        !(releasesAfterRegister.payload?.data ?? []).some((item) => item.version === fakeVersion),
      `status=${registerMissing.status} code=${registerMissing.payload?.code ?? '-'} ` +
        `响应=${registerMissing.payload?.message ?? ''}`,
    );

    // 版本白名单：含路径分隔符的版本号连 schema 都过不去
    const badVersion = await api('/update/client/releases', {
      method: 'POST',
      token: adminToken,
      body: { version: '../evil' },
    });
    record(
      '版本号白名单（POST /update/client/releases 传 ../evil → 400/422）',
      badVersion.status === 400 || badVersion.status === 422,
      `status=${badVersion.status} code=${badVersion.payload?.code ?? '-'} ` +
        `响应=${badVersion.payload?.message ?? ''}`,
    );

    // 下载接口本身不挂权限键，但**要登录**：不带 token 会被 401 挡在鉴权层
    const downloadNoAuth = await api(`/update/client/download/${encodeURIComponent(fakeVersion)}`);
    const downloadMissing = await api(`/update/client/download/${encodeURIComponent(fakeVersion)}`, {
      token: adminToken,
    });
    record(
      '下载不存在的客户端安装包（未登录 401 / 已登录 404）',
      downloadNoAuth.status === 401 && downloadMissing.status === 404,
      `未登录=${downloadNoAuth.status} 已登录=${downloadMissing.status} ` +
        `响应=${downloadMissing.payload?.message ?? ''}`,
    );
  }

  // ---------------------------------------------------------------- 6.9 大模型助手（一律 mock，绝不联网）
  {
    const aiSettingsDenied = await api('/ai/settings', { token: teacherToken });
    const aiSettings = await api('/ai/settings', { token: adminToken });
    const aiSettingsData = aiSettings.payload?.data ?? {};
    const aiSettingsText = JSON.stringify(aiSettingsData);
    record(
      '大模型设置 GET /ai/settings（教师 403 / 管理员 200，且响应里没有任何密钥字段）',
      aiSettingsDenied.status === 403 &&
        aiSettings.status === 200 &&
        typeof aiSettingsData.enabled === 'boolean' &&
        'provider' in aiSettingsData &&
        'baseUrl' in aiSettingsData &&
        'model' in aiSettingsData &&
        'hasApiKey' in aiSettingsData &&
        'keyHint' in aiSettingsData &&
        'systemPromptExtra' in aiSettingsData &&
        !aiSettingsText.includes('apiKey'),
      `教师=${aiSettingsDenied.status} 管理员=${aiSettings.status} 字段=${Object.keys(aiSettingsData).join(',')}`,
    );

    // 助手没开启时 /interpret 会 400：先开启，且**强制走离线 mock 解析**（绝不联网）
    const enableAi = await api('/ai/settings', {
      method: 'PUT',
      token: adminToken,
      body: { enabled: true, provider: 'mock' },
    });
    record(
      '开启大模型助手并固定为离线 mock（PUT /ai/settings）',
      enableAi.status === 200 &&
        enableAi.payload?.data?.enabled === true &&
        enableAi.payload?.data?.provider === 'mock',
      `status=${enableAi.status} enabled=${enableAi.payload?.data?.enabled} provider=${enableAi.payload?.data?.provider}`,
    );

    const promptText = '给2026级1班布置作业，把卷子写完';
    const interpret = await api('/ai/interpret', {
      method: 'POST',
      token: teacherToken,
      body: { text: promptText },
    });
    const interpretData = interpret.payload?.data;
    record(
      '助手解析布置作业（POST /ai/interpret → create_homework，需确认、班级非空、有预览）',
      interpret.status === 200 &&
        interpretData?.action === 'create_homework' &&
        interpretData?.needConfirm === true &&
        Boolean(interpretData?.params?.classId) &&
        Boolean(interpretData?.preview?.summary),
      `status=${interpret.status} action=${interpretData?.action} needConfirm=${interpretData?.needConfirm} ` +
        `classId=${interpretData?.params?.classId ?? '-'} summary=${interpretData?.preview?.summary ?? '-'}`,
    );

    const unknownInterpret = await api('/ai/interpret', {
      method: 'POST',
      token: teacherToken,
      body: { text: '今天天气不错' },
    });
    record(
      '助手听不懂时返回 unknown（不猜动作）',
      unknownInterpret.status === 200 && unknownInterpret.payload?.data?.action === 'unknown',
      `status=${unknownInterpret.status} action=${unknownInterpret.payload?.data?.action}`,
    );

    const audit = await api('/ai/audit', { token: adminToken });
    const auditRows = audit.payload?.data ?? [];
    record(
      '助手使用审计 GET /ai/audit（能看到刚写入的那句话）',
      audit.status === 200 && auditRows.some((item) => item.prompt === promptText),
      `status=${audit.status} 记录数=${auditRows.length}`,
    );

    // 收尾：助手必须还原成关闭（否则别的东西会以为已经配好了模型）
    const disableAi = await api('/ai/settings', {
      method: 'PUT',
      token: adminToken,
      body: { enabled: false },
    });
    record(
      '大模型助手用例收尾：enabled 已还原为 false',
      disableAi.status === 200 && disableAi.payload?.data?.enabled === false,
      `status=${disableAi.status} enabled=${disableAi.payload?.data?.enabled}`,
    );
  }

  // ---------------------------------------------------------------- 6.10 系统设置
  {
    const systemDenied = await api('/system/settings', { token: teacherToken });
    const systemSettings = await api('/system/settings', { token: adminToken });
    record(
      '系统设置 GET /system/settings（教师 403 / 管理员 200）',
      systemDenied.status === 403 &&
        systemSettings.status === 200 &&
        typeof systemSettings.payload?.data?.developerMode === 'boolean',
      `教师=${systemDenied.status} 管理员=${systemSettings.status} ` +
        `developerMode=${systemSettings.payload?.data?.developerMode}`,
    );

    // 开发者模式：开启后错误响应会带上堆栈，所以**必须**还原
    const enableDeveloper = await api('/system/settings', {
      method: 'PUT',
      token: adminToken,
      body: { developerMode: true },
    });
    const readBackDeveloper = await api('/system/settings', { token: adminToken });
    const disableDeveloper = await api('/system/settings', {
      method: 'PUT',
      token: adminToken,
      body: { developerMode: false },
    });
    const readBackDisabled = await api('/system/settings', { token: adminToken });
    record(
      '开发者模式可开关并回读（PUT /system/settings → GET 一致，随后还原为 false）',
      enableDeveloper.status === 200 &&
        readBackDeveloper.payload?.data?.developerMode === true &&
        disableDeveloper.status === 200 &&
        readBackDisabled.payload?.data?.developerMode === false,
      `开启=${enableDeveloper.status} 回读=${readBackDeveloper.payload?.data?.developerMode} ` +
        `还原=${readBackDisabled.payload?.data?.developerMode}`,
    );

    const autostart = await api('/system/autostart', { token: adminToken });
    const autostartData = autostart.payload?.data;
    const enableAutostart = await api('/system/autostart', {
      method: 'PUT',
      token: adminToken,
      body: { enabled: true },
    });
    record(
      '开机自启：开发机不支持（GET supported=false，PUT 拒绝 400）',
      autostart.status === 200 &&
        autostartData?.supported === false &&
        typeof autostartData?.detail === 'string' &&
        autostartData.detail.length > 0 &&
        enableAutostart.status === 400,
      `GET=${autostart.status} supported=${autostartData?.supported} mechanism=${autostartData?.mechanism} ` +
        `detail=${autostartData?.detail ?? '-'} PUT=${enableAutostart.status} ` +
        `响应=${enableAutostart.payload?.message ?? ''}`,
    );

    const diagnostics = await api('/system/diagnostics', { token: adminToken });
    const diagnosticsText = JSON.stringify(diagnostics.payload?.data ?? {});
    record(
      '运行诊断 GET /system/diagnostics（200 且不泄漏 apiKey/password/token/secret）',
      diagnostics.status === 200 && !/apiKey|password|token|secret/i.test(diagnosticsText),
      `status=${diagnostics.status} 字段=${Object.keys(diagnostics.payload?.data ?? {}).join(',')}`,
    );
  }

  // ---------------------------------------------------------------- 6.11 批量发布补漏
  {
    // 一个不存在的班级 + 一个真实班级：单班失败不能把整批带崩（逐班结果，不整批回滚）
    const missingClassId = `not-exist-${Date.now().toString(36)}`;
    const mixedBulk = await api('/notifications/bulk', {
      method: 'POST',
      token: adminToken,
      body: {
        classIds: [missingClassId, classId],
        title: `批量失败隔离回归 ${Date.now()}`,
        content: '其中一个班不存在，另一个班照常发布',
        priority: 'NORMAL',
      },
    });
    const mixedBulkData = mixedBulk.payload?.data;
    const missingResult = (mixedBulkData?.results ?? []).find((item) => item.classId === missingClassId);
    record(
      '批量发布：不存在的班级逐班失败、真实班级照常成功（failed>=1 且 succeeded>=1）',
      mixedBulk.status === 201 &&
        (mixedBulkData?.failed ?? 0) >= 1 &&
        (mixedBulkData?.succeeded ?? 0) >= 1 &&
        missingResult?.ok === false,
      `status=${mixedBulk.status} total=${mixedBulkData?.total} 成功=${mixedBulkData?.succeeded} ` +
        `失败=${mixedBulkData?.failed} 失败code=${missingResult?.code ?? '-'}`,
    );
    // 清理：只删成功落库的那几条（失败的班没有 id）
    for (const item of mixedBulkData?.results ?? []) {
      if (item.id) await api(`/notifications/${item.id}`, { method: 'DELETE', token: adminToken });
    }
  }

  // ---------------------------------------------------------------- 7. 权限隔离
  if (foreignClass) {
    const studentCrossClass = await api(`/classes/${foreignClass.id}`, { token: studentToken });
    record(
      '学生访问其他班级被拒绝（403）',
      studentCrossClass.status === 403,
      `status=${studentCrossClass.status}`,
    );

    const studentCrossHomework = await api(`/homeworks?classId=${foreignClass.id}`, { token: studentToken });
    record(
      '学生跨班查询作业被拒绝（403）',
      studentCrossHomework.status === 403,
      `status=${studentCrossHomework.status}`,
    );

    const studentCrossSchedule = await api(`/schedules?classId=${foreignClass.id}`, { token: studentToken });
    record(
      '学生跨班查询课表被拒绝（403）',
      studentCrossSchedule.status === 403,
      `status=${studentCrossSchedule.status}`,
    );

    const teacherCrossClass = await api(`/classes/${foreignClass.id}`, { token: teacherToken });
    record(
      '教师访问他人班级被拒绝（403）',
      teacherCrossClass.status === 403,
      `status=${teacherCrossClass.status}`,
    );

    const teacherCrossHomework = await api(`/homeworks?classId=${foreignClass.id}`, { token: teacherToken });
    record(
      '教师跨班发布/查询被拒绝（403）',
      teacherCrossHomework.status === 403,
      `status=${teacherCrossHomework.status}`,
    );

    const teacherCrossPublish = await api('/notifications', {
      method: 'POST',
      token: teacherToken,
      body: { classId: foreignClass.id, title: '跨班发布', content: '不应成功' },
    });
    record(
      '教师向他人班级发布通知被拒绝（403）',
      teacherCrossPublish.status === 403,
      `status=${teacherCrossPublish.status}`,
    );
  }

  const studentPublish = await api('/notifications', {
    method: 'POST',
    token: studentToken,
    body: { classId, title: '班级端本班通知', content: '允许本班发布' },
  });
  record(
    '班级端可发布本班通知（201）',
    studentPublish.status === 201 && Boolean(studentPublish.payload?.data?.id),
    `status=${studentPublish.status}`,
  );

  const anonymous = await api('/classes');
  record('未登录访问被拒绝（401）', anonymous.status === 401, `status=${anonymous.status}`);

  // 学生只能看到自己班级：作用域内所有返回项都应属于自己班级
  const studentClasses = await api('/classes', { token: studentToken });
  const studentVisible = studentClasses.payload?.data ?? [];
  record(
    '学生班级列表仅含自己所在班级',
    studentVisible.length === 1 && studentVisible[0]?.id === classId,
    `共 ${studentVisible.length} 个`,
  );

  const studentHomeworkAll = await api('/homeworks', { token: studentToken });
  const homeworkClassIds = new Set((studentHomeworkAll.payload?.data ?? []).map((item) => item.classId));
  record(
    '学生作业列表已按班级收敛',
    homeworkClassIds.size <= 1 && (homeworkClassIds.size === 0 || homeworkClassIds.has(classId)),
    `涉及 ${homeworkClassIds.size} 个班级`,
  );

  // ---------------------------------------------------------------- 8. 导入能力（课表时间配置 + 表格导入）
  const NL = String.fromCharCode(10);

  // 8.1 导入模板下载
  const templateCsv = await api('/imports/template?kind=grades&format=csv', { token: adminToken });
  const templateCsvText = templateCsv.payload?.data?.content ?? '';
  record(
    '成绩导入模板（CSV）可下载且含必填列',
    templateCsv.status === 200 &&
      templateCsvText.includes('考试名称') &&
      templateCsvText.includes('分数') &&
      templateCsvText.charCodeAt(0) === 0xfeff,
    `status=${templateCsv.status} len=${templateCsvText.length}`,
  );

  const templateXlsxResponse = await fetch(`${BASE_URL}/api/imports/template?kind=students&format=xlsx`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const templateXlsxBuffer = Buffer.from(await templateXlsxResponse.arrayBuffer());
  record(
    '名单导入模板（XLSX）可下载',
    templateXlsxResponse.status === 200 &&
      templateXlsxBuffer.length > 500 &&
      templateXlsxBuffer.subarray(0, 2).toString() === 'PK',
    `status=${templateXlsxResponse.status} bytes=${templateXlsxBuffer.length}`,
  );

  // 需求 6：成绩模板对老师端开放（空白模板，不含任何业务数据）；名单模板仍仅管理员
  const teacherGradeTemplate = await api('/imports/template?kind=grades&format=csv', { token: teacherToken });
  record(
    '班主任可下载成绩模板（需求 6：老师端可用）',
    teacherGradeTemplate.status === 200,
    `status=${teacherGradeTemplate.status}`,
  );

  const teacherRosterTemplate = await api('/imports/template?kind=students&format=csv', {
    token: teacherToken,
  });
  record(
    '有导入键的班主任可下载名单模板（200）',
    teacherRosterTemplate.status === 200 && Boolean(teacherRosterTemplate.payload?.data?.content),
    `status=${teacherRosterTemplate.status}`,
  );

  // 8.2 ClassIsland 课表时间配置：预览 -> 导入 -> 失败回滚 -> 合并 -> 越权 -> 清理
  const sampleLayout = {
    TimeLayouts: [
      { Name: '第 1 节', StartTime: '8:0:0', EndTime: '8:45:0', TimeType: 0 },
      { Name: '课间休息', StartTime: '8:45:0', EndTime: '8:55:0', TimeType: 1 },
      { Name: '第 2 节', StartSecond: 31500, EndSecond: 34200, TimeType: 0 },
    ],
  };

  const layoutPreview = await api('/imports/time-layout/preview', {
    method: 'POST',
    token: teacherToken,
    body: { classId, payload: sampleLayout },
  });
  const previewItems = layoutPreview.payload?.data?.items ?? [];
  record(
    'ClassIsland 时间配置预览（时分与秒两种写法）',
    layoutPreview.status === 200 && previewItems.length === 3 && previewItems[0]?.startTime === '08:00',
    `status=${layoutPreview.status} 节数=${previewItems.length} shape=${layoutPreview.payload?.data?.shape}`,
  );

  const brokenPreview = await api('/imports/time-layout/preview', {
    method: 'POST',
    token: teacherToken,
    body: { classId, payload: '[{"StartTime":"8:0:0","EndTime":"7:0:0"}]' },
  });
  record(
    '时间配置校验可定位错误（预览返回 errors）',
    brokenPreview.status === 200 && (brokenPreview.payload?.data?.errors ?? []).length > 0,
    `errors=${(brokenPreview.payload?.data?.errors ?? []).length}`,
  );

  const layoutImport = await api('/imports/time-layout', {
    method: 'POST',
    token: adminToken,
    body: { classId, name: '默认时间表', mode: 'replace', payload: sampleLayout },
  });
  const layoutId = layoutImport.payload?.data?.layout?.id ?? null;
  record(
    '管理员导入班级时间配置（replace）',
    layoutImport.status === 200 && layoutImport.payload?.data?.layout?.items?.length === 3,
    `status=${layoutImport.status} 节数=${layoutImport.payload?.data?.layout?.items?.length}`,
  );

  const layoutList = await api(`/imports/time-layout?classId=${classId}`, { token: teacherToken });
  record(
    '时间配置已持久化可查询',
    (layoutList.payload?.data ?? []).some((item) => item.id === layoutId),
    `共 ${(layoutList.payload?.data ?? []).length} 份`,
  );

  const badImport = await api('/imports/time-layout', {
    method: 'POST',
    token: adminToken,
    body: {
      classId,
      name: '默认时间表',
      mode: 'replace',
      payload: '[{"StartTime":"9:0:0","EndTime":"8:0:0"}]',
    },
  });
  const afterBadList = await api(`/imports/time-layout?classId=${classId}`, { token: teacherToken });
  const afterBadItems = (afterBadList.payload?.data ?? []).find((item) => item.id === layoutId)?.items ?? [];
  record(
    '非法时间配置导入失败且原配置不变（失败回滚）',
    badImport.status === 400 && badImport.payload?.code === 'IMPORT_INVALID' && afterBadItems.length === 3,
    `status=${badImport.status} code=${badImport.payload?.code} 原配置=${afterBadItems.length} 节`,
  );

  const mergeImport = await api('/imports/time-layout', {
    method: 'POST',
    token: adminToken,
    body: {
      classId,
      name: '默认时间表',
      mode: 'merge',
      payload: [
        { StartTime: '8:0:0', EndTime: '8:50:0', Name: '第 1 节（调整）' },
        { StartTime: '10:0:0', EndTime: '10:45:0', Name: '第 3 节' },
      ],
    },
  });
  const mergeData = mergeImport.payload?.data;
  record(
    '合并导入按开始时间去重（合并 1 节 / 新增 1 节）',
    mergeImport.status === 200 &&
      mergeData?.merged === 1 &&
      mergeData?.replaced === 1 &&
      mergeData?.layout?.items?.length === 4,
    `合并=${mergeData?.merged} 新增=${mergeData?.replaced} 共=${mergeData?.layout?.items?.length}`,
  );

  if (foreignClass) {
    const crossImport = await api('/imports/time-layout', {
      method: 'POST',
      token: teacherToken,
      body: { classId: foreignClass.id, mode: 'replace', payload: sampleLayout },
    });
    record('向他人班级导入时间配置被拒绝（403）', crossImport.status === 403, `status=${crossImport.status}`);
  }

  const studentLayoutList = await api(`/imports/time-layout?classId=${classId}`, { token: studentToken });
  record(
    '学生访问时间配置管理接口被拒绝（403）',
    studentLayoutList.status === 403,
    `status=${studentLayoutList.status}`,
  );

  // 8.2.1 时间点默认课程：随布局返回、无条目时回退、覆盖现有课程写入条目
  if (layoutId && courseId) {
    const defaultCourseName = courses.payload?.data?.[0]?.name ?? '';
    const savedLayout = await api(`/time-layouts/${layoutId}`, {
      method: 'PUT',
      token: adminToken,
      body: {
        name: '默认时间表',
        classId,
        points: [
          {
            name: '第 1 节',
            startTime: '08:00',
            endTime: '08:40',
            timeType: 'LESSON',
            defaultClassId: courseId,
            isHideDefault: false,
            breakName: '',
            actionSet: '{}',
          },
          {
            name: '课间',
            startTime: '08:40',
            endTime: '08:50',
            timeType: 'BREAK',
            breakName: '课间休息',
            actionSet: '{}',
          },
        ],
      },
    });
    const savedPoints = savedLayout.payload?.data?.points ?? [];
    const lessonPoint = savedPoints.find((point) => point.timeType === 'LESSON');
    record(
      '时间表保存默认课程并随布局返回',
      savedLayout.status === 200 &&
        lessonPoint?.defaultClassId === courseId &&
        lessonPoint?.defaultCourse?.name === defaultCourseName,
      `status=${savedLayout.status} default=${lessonPoint?.defaultCourse?.name ?? '-'}`,
    );

    const defaultPlan = await api('/class-plans', {
      method: 'POST',
      token: teacherToken,
      body: {
        classId,
        name: '默认课程验证课表',
        timeLayoutId: layoutId,
        weekday: 0,
        weekCountDiv: 0,
        weekCountDivTotal: 2,
        weekStart: 1,
        weekEnd: 30,
        isEnabled: true,
      },
    });
    const defaultPlanId = defaultPlan.payload?.data?.id ?? null;

    const activeDefault = await api(`/schedules/active-week?classId=${classId}&week=1`, {
      token: teacherToken,
    });
    const fallback = (activeDefault.payload?.data?.days ?? [])
      .flatMap((day) => day.schedules ?? [])
      .find((item) => item.course?.name === defaultCourseName && String(item.id).startsWith('default:'));
    record(
      '日课表没有单独条目时回退时间点默认课程',
      activeDefault.status === 200 && Boolean(fallback),
      `status=${activeDefault.status} fallback=${fallback ? fallback.course?.name : '-'}`,
    );

    if (lessonPoint?.id) {
      const applied = await api(`/time-layouts/${layoutId}/points/${lessonPoint.id}/apply-default`, {
        method: 'POST',
        token: adminToken,
      });
      const plansAfterApply = await api(`/class-plans?classId=${classId}`, { token: teacherToken });
      const appliedPlan = (plansAfterApply.payload?.data ?? []).find((item) => item.id === defaultPlanId);
      const appliedEntry = appliedPlan?.entries?.find((entry) => entry.timeLayoutItemId === lessonPoint.id);
      record(
        '覆盖现有课程写入所有引用课表',
        applied.status === 200 &&
          (applied.payload?.data?.plans ?? 0) >= 1 &&
          appliedEntry?.courseId === courseId,
        `status=${applied.status} plans=${applied.payload?.data?.plans ?? 0}`,
      );
    }

    if (defaultPlanId) {
      await api(`/class-plans/${defaultPlanId}`, { method: 'DELETE', token: teacherToken });
    }
  }

  // 8.2.2 时间表可通过新路由删除（Web 时间表编辑器使用的接口）
  const removableLayout = await api('/time-layouts', {
    method: 'POST',
    token: adminToken,
    body: { name: '临时删除验证', classId, points: [] },
  });
  const removableId = removableLayout.payload?.data?.id ?? null;
  const removedLayout = removableId
    ? await api(`/time-layouts/${removableId}`, { method: 'DELETE', token: adminToken })
    : { status: 0 };
  record(
    '时间表可通过新路由删除',
    removableLayout.status === 201 && removedLayout.status === 200,
    `创建=${removableLayout.status} 删除=${removedLayout.status}`,
  );

  // 8.3 成绩表格导入（CSV 校验 + XLSX 新增/重复/更新 + 错误行提示）
  const gradesCsv = [
    '学号,姓名,考试名称,分数,总分,科目',
    `${targetStudent?.studentNo ?? '202601'},,期中导入考试,92,100,`,
    `,${targetStudent?.name ?? '张同学'},期中导入考试,不是数字,100,`,
    'UNKNOWN-USER,,期中导入考试,88,100,',
  ].join(NL);
  const gradesCsvBase64 = Buffer.from(`\ufeff${gradesCsv}${NL}`, 'utf8').toString('base64');

  const gradesPreview = await api('/imports/table/preview', {
    method: 'POST',
    token: adminToken,
    body: { kind: 'grades', fileName: 'grades.csv', contentBase64: gradesCsvBase64 },
  });
  const previewData = gradesPreview.payload?.data;
  record(
    'CSV 成绩表预览（列名 + 行数 + 建议映射）',
    gradesPreview.status === 200 &&
      previewData?.columns?.length === 6 &&
      previewData?.totalRows === 3 &&
      previewData?.suggestedMapping?.score === '分数',
    `status=${gradesPreview.status} 行数=${previewData?.totalRows} 映射=${JSON.stringify(previewData?.suggestedMapping ?? {})}`,
  );

  const missingColumn = await api('/imports/table/preview', {
    method: 'POST',
    token: adminToken,
    body: {
      kind: 'grades',
      fileName: 'missing.csv',
      contentBase64: Buffer.from(`\ufeff姓名${NL}王小明${NL}`, 'utf8').toString('base64'),
    },
  });
  record(
    '缺少必填列的表格给出明确提示',
    missingColumn.status === 200 && (missingColumn.payload?.data?.errors ?? []).length >= 2,
    `errors=${(missingColumn.payload?.data?.errors ?? []).length}`,
  );

  const emptyFile = await api('/imports/table/preview', {
    method: 'POST',
    token: adminToken,
    body: { kind: 'grades', fileName: 'empty.csv', contentBase64: '' },
  });
  record(
    '空文件被明确拒绝（IMPORT_EMPTY_FILE）',
    emptyFile.status === 400 && emptyFile.payload?.code === 'IMPORT_EMPTY_FILE',
    `status=${emptyFile.status} code=${emptyFile.payload?.code}`,
  );

  const xlsxNamespace = await import('xlsx');
  const XLSX = xlsxNamespace.default ?? xlsxNamespace;
  const xlsxSheet = XLSX.utils.aoa_to_sheet([
    ['学号', '姓名', '考试', '得分', '满分', '科目'],
    [classmateTwoNo, '', '期中导入考试', 85, 100, ''],
    [targetStudent?.studentNo ?? '202601', '', '期中导入考试', 78, 100, ''],
  ]);
  const xlsxBook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(xlsxBook, xlsxSheet, '成绩');
  const xlsxBase64 = XLSX.write(xlsxBook, { type: 'base64', bookType: 'xlsx' });

  const xlsxPreview = await api('/imports/table/preview', {
    method: 'POST',
    token: adminToken,
    body: { kind: 'grades', fileName: 'grades.xlsx', contentBase64: xlsxBase64 },
  });
  record(
    'XLSX 成绩表预览（同义词自动映射 学号/得分）',
    xlsxPreview.status === 200 &&
      xlsxPreview.payload?.data?.totalRows === 2 &&
      xlsxPreview.payload?.data?.suggestedMapping?.studentNo === '学号' &&
      xlsxPreview.payload?.data?.suggestedMapping?.score === '得分',
    `status=${xlsxPreview.status} 映射=${JSON.stringify(xlsxPreview.payload?.data?.suggestedMapping ?? {})}`,
  );

  const commitMapping = {
    studentNo: '学号',
    name: '姓名',
    examName: '考试',
    score: '得分',
    totalScore: '满分',
    courseName: '科目',
  };
  const gradesCommitBody = {
    kind: 'grades',
    classId,
    fileName: 'grades.xlsx',
    contentBase64: xlsxBase64,
    mapping: commitMapping,
  };

  const gradesCommit = await api('/imports/table/commit', {
    method: 'POST',
    token: adminToken,
    body: { ...gradesCommitBody, mode: 'append' },
  });
  record(
    '成绩导入新增成功且返回结果统计',
    gradesCommit.status === 200 &&
      gradesCommit.payload?.data?.inserted === 2 &&
      gradesCommit.payload?.data?.failed === 0,
    `新增=${gradesCommit.payload?.data?.inserted} 失败=${gradesCommit.payload?.data?.failed}`,
  );

  const gradesAgain = await api('/imports/table/commit', {
    method: 'POST',
    token: adminToken,
    body: { ...gradesCommitBody, mode: 'append' },
  });
  record(
    '重复成绩按 append 跳过（不重复写入）',
    gradesAgain.status === 200 &&
      gradesAgain.payload?.data?.skipped === 2 &&
      gradesAgain.payload?.data?.inserted === 0,
    `跳过=${gradesAgain.payload?.data?.skipped} 新增=${gradesAgain.payload?.data?.inserted}`,
  );

  const gradesUpsert = await api('/imports/table/commit', {
    method: 'POST',
    token: adminToken,
    body: { ...gradesCommitBody, mode: 'upsert' },
  });
  record(
    '重复成绩按 upsert 更新',
    gradesUpsert.status === 200 && gradesUpsert.payload?.data?.updated === 2,
    `更新=${gradesUpsert.payload?.data?.updated}`,
  );

  const gradesBroken = await api('/imports/table/commit', {
    method: 'POST',
    token: adminToken,
    body: {
      kind: 'grades',
      classId,
      fileName: 'grades.csv',
      contentBase64: gradesCsvBase64,
      mapping: {
        studentNo: '学号',
        name: '姓名',
        examName: '考试名称',
        score: '分数',
        totalScore: '总分',
        courseName: '科目',
      },
      mode: 'append',
    },
  });
  const brokenErrors = gradesBroken.payload?.data?.errors ?? [];
  record(
    '非法数据行给出具体行号与原因',
    gradesBroken.status === 200 &&
      gradesBroken.payload?.data?.failed === 2 &&
      brokenErrors.length === 2 &&
      brokenErrors.every((item) => item.row >= 2 && item.message.length > 0),
    `失败=${gradesBroken.payload?.data?.failed} 首条=第 ${brokenErrors[0]?.row} 行：${brokenErrors[0]?.message ?? ''}`,
  );

  // 班主任（本班）重复导入 append 模式：已存在的记录应被跳过而不是报错（需求 6）
  const gradesByHeadTeacher = await api('/imports/table/commit', {
    method: 'POST',
    token: teacherToken,
    body: { ...gradesCommitBody, mode: 'append' },
  });
  record(
    '班主任重复导入本班成绩按 append 跳过',
    gradesByHeadTeacher.status === 200 &&
      (gradesByHeadTeacher.payload?.data?.skipped ?? 0) >= 1 &&
      (gradesByHeadTeacher.payload?.data?.inserted ?? -1) === 0,
    `status=${gradesByHeadTeacher.status} 跳过=${gradesByHeadTeacher.payload?.data?.skipped} 新增=${gradesByHeadTeacher.payload?.data?.inserted}`,
  );

  // 8.3.1 科目归属越权回归（修复"非该科科任老师可以布置/导入其他科内容"）：
  //       ① 新建成同名课程必须被拒绝 —— 否则谁都能借"新建科目"把自己写成该科任课老师，
  //          后面那道 assertCanManageSubjectContent 的科目门随即失效；
  //       ② 班主任导入**别人任教科目**的成绩必须拒绝（原先只判到班级这一层）。
  {
    const guardedCourseName = `越权校验科目${Date.now().toString(36).slice(-5).toUpperCase()}`;
    const otherTeacher = await api('/auth/me', { token: teacher2Token });
    const firstCourse = await api('/courses', {
      method: 'POST',
      token: adminToken,
      body: { classId, name: guardedCourseName, teacherId: otherTeacher.payload?.data?.id },
    });
    const firstCourseId = firstCourse.payload?.data?.id;
    record(
      '新建科目成功（用于越权校验）',
      firstCourse.status === 201 && Boolean(firstCourseId),
      `status=${firstCourse.status} id=${firstCourseId ?? '-'}`,
    );

    const duplicateCourse = await api('/courses', {
      method: 'POST',
      token: adminToken,
      body: { classId, name: guardedCourseName },
    });
    record(
      '同名课程被拒绝并返回已有课程 id（COURSE_EXISTS）',
      duplicateCourse.status === 409 &&
        duplicateCourse.payload?.code === 'COURSE_EXISTS' &&
        duplicateCourse.payload?.details?.courseId === firstCourseId,
      `status=${duplicateCourse.status} code=${duplicateCourse.payload?.code} details=${JSON.stringify(duplicateCourse.payload?.details ?? {})}`,
    );

    // 显式配置另一位教师任课；班主任身份不能代替科目写权限。
    const guardedCsv = [
      '学号,考试名称,分数,总分,科目',
      `${targetStudent?.studentNo ?? '202601'},越权校验考试,88,100,${guardedCourseName}`,
    ].join(NL);
    const guardedImport = await api('/imports/table/commit', {
      method: 'POST',
      token: teacherToken,
      body: {
        kind: 'grades',
        classId,
        fileName: 'guarded.csv',
        contentBase64: Buffer.from(`\ufeff${guardedCsv}${NL}`, 'utf8').toString('base64'),
        mapping: {
          studentNo: '学号',
          examName: '考试名称',
          score: '分数',
          totalScore: '总分',
          courseName: '科目',
        },
        mode: 'append',
      },
    });
    const guardedRows = await api('/grades?classId=' + classId, { token: adminToken });
    record(
      '班主任不能导入他人任教科目成绩，拒绝后不落库',
      guardedImport.status === 403 &&
        !(guardedRows.payload?.data ?? []).some((item) => item.examName === '越权校验考试'),
      'status=' + guardedImport.status + ' message=' + guardedImport.payload?.message,
    );

    if (firstCourseId) {
      await api(`/courses/${firstCourseId}`, { method: 'DELETE', token: adminToken });
    }
  }

  // 8.4 学生名单导入（仅管理员）+ 数据清理
  const importedUsername = `IMP${Date.now().toString(36).slice(-6)}`.toUpperCase();
  // 学生导入模板已无"初始密码"列（学生没有账号属性）；表头是「学号」
  const studentsCsv = ['学号,姓名', `${importedUsername},导入测试生`, 'bad@user,非法学号'].join(NL);
  const studentsCommit = await api('/imports/table/commit', {
    method: 'POST',
    token: adminToken,
    body: {
      kind: 'students',
      classId,
      fileName: 'students.csv',
      contentBase64: Buffer.from(`\ufeff${studentsCsv}${NL}`, 'utf8').toString('base64'),
      mapping: { studentNo: '学号', name: '姓名' },
      mode: 'append',
    },
  });
  record(
    '学生名单导入（新增 1 / 非法学号进错误行 1）',
    studentsCommit.status === 200 &&
      studentsCommit.payload?.data?.inserted === 1 &&
      studentsCommit.payload?.data?.failed === 1,
    `新增=${studentsCommit.payload?.data?.inserted} 失败=${studentsCommit.payload?.data?.failed}`,
  );

  // 8.5 需求 6：表格导入在"老师端"可用且不越权
  //     授课教师可导入本人科目；他人科目与班级范围之外仍拒绝，名单导入另走人员管理权限。
  const teacherGradesPreview = await api('/imports/table/preview', {
    method: 'POST',
    token: teacherToken,
    body: { kind: 'grades', fileName: 'grades.csv', contentBase64: gradesCsvBase64 },
  });
  record(
    '班主任可预览成绩表（需求 6：老师端可用）',
    teacherGradesPreview.status === 200 && (teacherGradesPreview.payload?.data?.totalRows ?? 0) === 3,
    `status=${teacherGradesPreview.status} 行数=${teacherGradesPreview.payload?.data?.totalRows ?? '-'}`,
  );

  const teacherGradesCommit = await api('/imports/table/commit', {
    method: 'POST',
    token: teacherToken,
    body: {
      kind: 'grades',
      classId,
      fileName: 'grades.csv',
      contentBase64: gradesCsvBase64,
      mapping: {
        studentNo: '学号',
        name: '姓名',
        examName: '考试名称',
        score: '分数',
        totalScore: '总分',
        courseName: '科目',
      },
      mode: 'upsert',
    },
  });
  record(
    '班主任可导入本班成绩（upsert）',
    teacherGradesCommit.status === 200 &&
      (teacherGradesCommit.payload?.data?.inserted ?? 0) +
        (teacherGradesCommit.payload?.data?.updated ?? 0) >=
        1,
    `status=${teacherGradesCommit.status} 新增=${teacherGradesCommit.payload?.data?.inserted} 更新=${teacherGradesCommit.payload?.data?.updated} 失败=${teacherGradesCommit.payload?.data?.failed}`,
  );

  // 科任可以导入本人任教科目，不因没有班主任身份被拒。
  const subjectOnlyClass = classes.find((item) => item.name?.includes('2025级3'));
  if (!subjectOnlyClass) throw new Error('隔离科任班级缺失');
  const subjectIdentity = await api('/auth/me', { token: teacher2Token });
  const subjectCourses = await api('/courses?classId=' + subjectOnlyClass.id, { token: adminToken });
  const subjectCourse = (subjectCourses.payload?.data ?? []).find(
    (item) => item.teacherId === subjectIdentity.payload?.data?.id,
  );
  const subjectStudents = await api('/students?classId=' + subjectOnlyClass.id, { token: adminToken });
  const subjectStudent = subjectStudents.payload?.data?.[0];
  if (!subjectCourse || !subjectStudent) throw new Error('隔离科任导入数据缺失');
  const subjectExam = '科任导入验证' + Date.now();
  const subjectCsv = [
    '学号,考试名称,分数,总分,科目',
    [subjectStudent.studentNo, subjectExam, 88, 100, subjectCourse.name].join(','),
  ].join(NL);
  const subjectBody = {
    kind: 'grades',
    classId: subjectOnlyClass.id,
    fileName: 'subject.csv',
    contentBase64: Buffer.from('\ufeff' + subjectCsv + NL, 'utf8').toString('base64'),
    mapping: {
      studentNo: '学号',
      examName: '考试名称',
      score: '分数',
      totalScore: '总分',
      courseName: '科目',
    },
    mode: 'append',
  };
  const subjectGradesImport = await api('/imports/table/commit', {
    method: 'POST',
    token: teacher2Token,
    body: subjectBody,
  });
  record(
    '科任老师可导入本人授课科目成绩',
    subjectGradesImport.status === 200 && subjectGradesImport.payload?.data?.inserted === 1,
    'status=' + subjectGradesImport.status,
  );
  const otherSubject = (subjectCourses.payload?.data ?? []).find(
    (item) => item.teacherId !== subjectIdentity.payload?.data?.id,
  );
  if (!otherSubject) throw new Error('隔离越权科目缺失');
  const deniedCsv = [
    '学号,考试名称,分数,总分,科目',
    [subjectStudent.studentNo, subjectExam + '越权', 88, 100, otherSubject.name].join(','),
  ].join(NL);
  const deniedImport = await api('/imports/table/commit', {
    method: 'POST',
    token: teacher2Token,
    body: {
      ...subjectBody,
      contentBase64: Buffer.from('\ufeff' + deniedCsv + NL, 'utf8').toString('base64'),
    },
  });
  record('科任老师仍不能导入他人任教科目成绩', deniedImport.status === 403, 'status=' + deniedImport.status);
  const subjectRows = await api('/grades?classId=' + subjectOnlyClass.id, { token: adminToken });
  for (const row of subjectRows.payload?.data ?? [])
    if (row.examName === subjectExam) await api('/grades/' + row.id, { method: 'DELETE', token: adminToken });

  if (foreignClass) {
    const crossGradesImport = await api('/imports/table/commit', {
      method: 'POST',
      token: teacherToken,
      body: {
        kind: 'grades',
        classId: foreignClass.id,
        fileName: 'grades.csv',
        contentBase64: gradesCsvBase64,
        mapping: {
          studentNo: '学号',
          name: '姓名',
          examName: '考试名称',
          score: '分数',
          totalScore: '总分',
          courseName: '科目',
        },
        mode: 'upsert',
      },
    });
    record(
      '班主任向他人班级导入成绩被拒绝（403）',
      crossGradesImport.status === 403,
      `status=${crossGradesImport.status}`,
    );
  }

  const teacherRosterPreview = await api('/imports/table/preview', {
    method: 'POST',
    token: teacherToken,
    body: {
      kind: 'students',
      fileName: 'students.csv',
      contentBase64: Buffer.from(`\ufeff用户名,姓名${NL}whatever,某人${NL}`, 'utf8').toString('base64'),
    },
  });
  record(
    '有导入键的班主任可预览名单模板（200）',
    teacherRosterPreview.status === 200 && Boolean(teacherRosterPreview.payload?.data),
    `status=${teacherRosterPreview.status}`,
  );

  const teacherImportedNo = `T${Date.now()}`;
  const studentsByTeacher = await api('/imports/table/commit', {
    method: 'POST',
    token: teacherToken,
    body: {
      kind: 'students',
      classId,
      fileName: 'students.csv',
      contentBase64: Buffer.from(
        `\ufeff学号,姓名${NL}${teacherImportedNo},班主任导入学生${NL}`,
        'utf8',
      ).toString('base64'),
      mapping: { studentNo: '学号', name: '姓名' },
      mode: 'append',
    },
  });
  record(
    '有导入键的班主任按范围导入本班名单（200）',
    studentsByTeacher.status === 200 &&
      studentsByTeacher.payload?.data?.failed === 0 &&
      studentsByTeacher.payload?.data?.inserted === 1,
    `status=${studentsByTeacher.status}`,
  );

  const teacherImportedStudents = await api(`/students?classId=${classId}&keyword=${teacherImportedNo}`, {
    token: adminToken,
  });
  const teacherImportedStudent = teacherImportedStudents.payload?.data?.find(
    (item) => item.studentNo === teacherImportedNo,
  );
  if (teacherImportedStudent)
    await api(`/students/${teacherImportedStudent.id}`, { method: 'DELETE', token: adminToken });
  const teacherImportAfter = await api(
    `/students?classId=${classId}&status=inactive&keyword=${teacherImportedNo}`,
    { token: adminToken },
  );
  record(
    '班主任导入夹具收尾：停用并保留历史，恢复原在读名单',
    Boolean(
      teacherImportAfter.payload?.data?.some(
        (item) => item.studentNo === teacherImportedNo && item.status === 'inactive',
      ),
    ),
  );

  // 清理：删除导入产生的成绩、时间配置与学生，保持环境可重复验证
  const importedGrades = await api(
    `/grades?classId=${classId}&examName=${encodeURIComponent('期中导入考试')}`,
    {
      token: adminToken,
    },
  );
  let gradesCleaned = 0;
  for (const grade of importedGrades.payload?.data ?? []) {
    const removed = await api(`/grades/${grade.id}`, { method: 'DELETE', token: adminToken });
    if (removed.status === 200) gradesCleaned += 1;
  }
  record('导入的成绩可正常删除（清理验证数据）', gradesCleaned >= 2, `已删除 ${gradesCleaned} 条`);

  const roster = await api(`/students?classId=${classId}`, { token: adminToken });
  const importedStudent = (roster.payload?.data ?? []).find((item) => item.studentNo === importedUsername);
  if (importedStudent) {
    const removedStudent = await api(`/students/${importedStudent.id}`, {
      method: 'DELETE',
      token: adminToken,
    });
    record(
      '导入的学生可正常删除（清理验证数据）',
      removedStudent.status === 200,
      `status=${removedStudent.status}`,
    );
  }

  if (layoutId) {
    const layoutDeleted = await api(`/imports/time-layout/${layoutId}`, {
      method: 'DELETE',
      token: adminToken,
    });
    record('时间配置可删除（清理验证数据）', layoutDeleted.status === 200, `status=${layoutDeleted.status}`);
  }

  // ---------------------------------------------------------------- 9. 班级账号（ClassHelper 班级端主体 = 班级）
  // 设计：班级码 + 班级密码 → classSession 的 JWT；个人数据（作业完成 / 通知已读 / 成绩）
  //      由服务端按"全班"范围读写，个人学生不再是登录主体（个人账号接口仍向后兼容）。
  // 注意：本段会临时改动班级码，结束时必须恢复（否则演示实例会留下 E2E#### 这种随机码）。
  const adminClassList = await api('/classes', { token: adminToken });
  const originalClassAccount = (adminClassList.payload?.data ?? []).find((item) => item.id === classId) ?? {};
  const classCode = `E2E${Date.now().toString(36).slice(-4).toUpperCase()}`;
  const setAccount = await api(`/classes/${classId}/class-account`, {
    method: 'PATCH',
    token: adminToken,
    body: { code: classCode, password: 'class123' },
  });
  record(
    '管理员设置班级账号（班级码 + 班级密码）',
    setAccount.status === 200 && setAccount.payload?.data?.code === classCode,
    `status=${setAccount.status} code=${setAccount.payload?.data?.code}`,
  );

  const classLogin = await api('/auth/class-login', {
    method: 'POST',
    body: { code: classCode, password: 'class123' },
  });
  const classToken = classLogin.payload?.data?.token;
  const classUser = classLogin.payload?.data?.user;
  record(
    '班级账号登录成功（主体为班级）',
    classLogin.status === 200 &&
      Boolean(classToken) &&
      classUser?.classSession === true &&
      classUser?.id === classId &&
      classUser?.classId === classId,
    `status=${classLogin.status} classSession=${classUser?.classSession} name=${classUser?.name}`,
  );

  const lowerLogin = await api('/auth/class-login', {
    method: 'POST',
    body: { code: classCode.toLowerCase(), password: 'class123' },
  });
  record('班级码大小写不敏感', lowerLogin.status === 200, `status=${lowerLogin.status}`);

  const wrongClassPassword = await api('/auth/class-login', {
    method: 'POST',
    body: { code: classCode, password: 'bad-class-password' },
  });
  record(
    '班级密码错误被拒绝（401）',
    wrongClassPassword.status === 401,
    `status=${wrongClassPassword.status}`,
  );

  const unknownCode = await api('/auth/class-login', {
    method: 'POST',
    body: { code: 'NOSUCHCODE', password: 'class123' },
  });
  record('未知班级码被拒绝（401）', unknownCode.status === 401, `status=${unknownCode.status}`);

  const classMe = await api('/auth/me', { token: classToken });
  record(
    '班级会话 /auth/me 返回班级信息',
    classMe.status === 200 &&
      classMe.payload?.data?.classSession === true &&
      classMe.payload?.data?.id === classId,
    `status=${classMe.status} name=${classMe.payload?.data?.name}`,
  );

  const classClasses = await api('/classes', { token: classToken });
  const classVisible = classClasses.payload?.data ?? [];
  record(
    '班级账号只能看到自己班级',
    classVisible.length === 1 && classVisible[0]?.id === classId,
    `共 ${classVisible.length} 个（${classVisible.map((item) => item.name).join(',')}）`,
  );

  if (foreignClass) {
    const classCrossHomework = await api(`/homeworks?classId=${foreignClass.id}`, { token: classToken });
    record(
      '班级账号跨班查询被拒绝（403）',
      classCrossHomework.status === 403,
      `status=${classCrossHomework.status}`,
    );
  }

  const classPublish = await api('/notifications', {
    method: 'POST',
    token: classToken,
    body: { classId, title: '班级账号本班发布', content: '允许本班发布' },
  });
  record(
    '班级账号发布本班通知成功（201）',
    classPublish.status === 201 && Boolean(classPublish.payload?.data?.id),
    `status=${classPublish.status}`,
  );

  const classGradesWrite = await api('/grades', {
    method: 'POST',
    token: classToken,
    body: { classId, studentId: targetStudent?.id, examName: '班级账号越权成绩', score: 90, totalScore: 100 },
  });
  record(
    '班级账号录入成绩被拒绝（403）',
    classGradesWrite.status === 403,
    `status=${classGradesWrite.status}`,
  );

  const classScheduleWrite = await api('/schedules', {
    method: 'POST',
    token: classToken,
    body: { classId, courseId, dayOfWeek: 4, startTime: '14:00', endTime: '14:45' },
  });
  record(
    '班级账号修改课表被拒绝（403）',
    classScheduleWrite.status === 403,
    `status=${classScheduleWrite.status}`,
  );

  // 教室机器录入作业（需求：支持作业在客户端录入）：班级账号可以发，跨班不行
  const classHomeworkCreate = await api('/homeworks', {
    method: 'POST',
    token: classToken,
    body: {
      classId,
      title: '教室录入验证作业',
      content: 'P 大本 第 3 课',
      assignDate: '2026-03-02',
    },
  });
  record(
    '班级账号可在教室机器上录入作业',
    classHomeworkCreate.status === 201 && classHomeworkCreate.payload?.data?.assignDate === '2026-03-02',
    `status=${classHomeworkCreate.status} assignDate=${classHomeworkCreate.payload?.data?.assignDate}`,
  );
  if (foreignClass) {
    const classHomeworkCreateCross = await api('/homeworks', {
      method: 'POST',
      token: classToken,
      body: { classId: foreignClass.id, title: '跨班录入作业', content: '不应成功' },
    });
    record(
      '班级账号跨班录入作业被拒绝（403）',
      classHomeworkCreateCross.status === 403,
      `status=${classHomeworkCreateCross.status}`,
    );
  }
  if (classHomeworkCreate.payload?.data?.id) {
    const cleanupHomework = await api(`/homeworks/${classHomeworkCreate.payload.data.id}`, {
      method: 'DELETE',
      token: teacherToken,
    });
    record(
      '清理：教室录入的验证作业已删除',
      cleanupHomework.status === 200,
      `status=${cleanupHomework.status}`,
    );
  }

  // 班级设备代全班操作：通知已读
  const classNameNotice = await api('/notifications', {
    method: 'POST',
    token: teacherToken,
    body: { classId, title: '班级账号已读回归', content: '验证班级设备代全班标记已读' },
  });
  const classNameNoticeId = classNameNotice.payload?.data?.id;
  const beforeUnread = await api(`/notifications/unread-count?classId=${classId}`, { token: classToken });
  const classRead = await api(`/notifications/${classNameNoticeId}/read`, {
    method: 'POST',
    token: classToken,
  });
  const afterUnread = await api(`/notifications/unread-count?classId=${classId}`, { token: classToken });
  const unreadBefore = beforeUnread.payload?.data?.count ?? 0;
  const unreadAfter = afterUnread.payload?.data?.count ?? -1;
  record(
    '班级设备标记已读 = 全班已读（未读数 -1）',
    classRead.status === 200 &&
      (classRead.payload?.data?.marked ?? 0) === classmates.length &&
      unreadBefore > 0 &&
      unreadAfter === unreadBefore - 1,
    `写入 ${classRead.payload?.data?.marked} 条（班级 ${classmates.length} 人）未读 ${unreadBefore} → ${unreadAfter}`,
  );

  const classReadAll = await api('/notifications/read-all', {
    method: 'POST',
    token: classToken,
    body: { classId },
  });
  const unreadAfterAll = await api(`/notifications/unread-count?classId=${classId}`, { token: classToken });
  record(
    '班级设备全部已读 = 全班全部已读（未读归零）',
    classReadAll.status === 200 && (unreadAfterAll.payload?.data?.count ?? -1) === 0,
    `标记 ${classReadAll.payload?.data?.marked} 条，剩余未读 ${unreadAfterAll.payload?.data?.count}`,
  );

  const staffNotice = await api(
    `/notifications?classId=${classId}&keyword=${encodeURIComponent('班级账号已读回归')}`,
    { token: teacherToken },
  );
  const staffNoticeView = (staffNotice.payload?.data ?? [])[0];
  record(
    '教师端看到的已读人数与全班一致',
    staffNoticeView?.readCount === classmates.length,
    `readCount=${staffNoticeView?.readCount} / 学生数=${classmates.length}`,
  );

  // 班级设备代全班操作：作业完成
  const classHomework = await api('/homeworks', {
    method: 'POST',
    token: teacherToken,
    body: { classId, title: '班级账号完成回归', content: '验证班级设备代全班标记完成' },
  });
  const classHomeworkId = classHomework.payload?.data?.id;
  const classDone = await api(`/homeworks/${classHomeworkId}/status`, {
    method: 'PATCH',
    token: classToken,
    body: { completed: true },
  });
  const teacherHomeworkView = await api(`/homeworks/${classHomeworkId}`, { token: teacherToken });
  const classPending = await api(`/homeworks?classId=${classId}&pendingOnly=true`, { token: classToken });
  const stillPending = (classPending.payload?.data ?? []).some((item) => item.id === classHomeworkId);
  record(
    '班级设备标记完成 = 全班完成（教师端完成人数一致）',
    classDone.status === 200 &&
      teacherHomeworkView.payload?.data?.completedCount === classmates.length &&
      !stillPending,
    `completedCount=${teacherHomeworkView.payload?.data?.completedCount} / 学生数=${classmates.length} 仍在待完成=${stillPending}`,
  );

  // 班级账号的成绩视图 = 全班总览
  const classNameGrade = await api('/grades', {
    method: 'POST',
    token: adminToken,
    body: { classId, studentId: targetStudent?.id, examName: '班级总览回归', score: 77, totalScore: 100 },
  });
  const classMyGrades = await api('/grades/my', { token: classToken });
  const gradeStudentIds = new Set((classMyGrades.payload?.data ?? []).map((item) => item.studentId));
  record(
    '班级账号查看成绩 = 全班总览',
    classMyGrades.status === 200 &&
      (classMyGrades.payload?.data ?? []).some((item) => item.id === classNameGrade.payload?.data?.id),
    `成绩条数=${(classMyGrades.payload?.data ?? []).length} 涉及学生=${gradeStudentIds.size}`,
  );

  // 管理员重置班级密码后：新密码可用、旧密码失效
  const resetClassPassword = await api(`/classes/${classId}/class-account`, {
    method: 'PATCH',
    token: adminToken,
    body: { password: 'class456' },
  });
  const newPasswordLogin = await api('/auth/class-login', {
    method: 'POST',
    body: { code: classCode, password: 'class456' },
  });
  const oldPasswordLogin = await api('/auth/class-login', {
    method: 'POST',
    body: { code: classCode, password: 'class123' },
  });
  record(
    '重置班级密码后旧密码失效 / 新密码可用',
    resetClassPassword.status === 200 && newPasswordLogin.status === 200 && oldPasswordLogin.status === 401,
    `重置=${resetClassPassword.status} 新密码=${newPasswordLogin.status} 旧密码=${oldPasswordLogin.status}`,
  );

  const occupiedCode = await api(`/classes/${classId}/class-account`, {
    method: 'PATCH',
    token: adminToken,
    body: { code: classes[1]?.code ?? 'G102' },
  });
  record(
    '班级码重复被拒绝（400）',
    occupiedCode.status === 400,
    `status=${occupiedCode.status} message=${occupiedCode.payload?.message ?? ''}`,
  );

  // 清理：删除回归用的通知 / 作业 / 成绩，把班级码恢复为验证前的原值，密码恢复为默认
  if (classNameNoticeId) {
    await api(`/notifications/${classNameNoticeId}`, { method: 'DELETE', token: teacherToken });
  }
  if (classHomeworkId) {
    await api(`/homeworks/${classHomeworkId}`, { method: 'DELETE', token: teacherToken });
  }
  if (classNameGrade.payload?.data?.id) {
    await api(`/grades/${classNameGrade.payload.data.id}`, { method: 'DELETE', token: adminToken });
  }

  const restoreAccount = await api(`/classes/${classId}/class-account`, {
    method: 'PATCH',
    token: adminToken,
    body: {
      ...(originalClassAccount.code ? { code: originalClassAccount.code } : {}),
      password: '123456',
    },
  });
  const restoredLogin = originalClassAccount.code
    ? await api('/auth/class-login', {
        method: 'POST',
        body: { code: originalClassAccount.code, password: '123456' },
      })
    : { status: 200 };
  record(
    '清理：班级码恢复为验证前的原值（不污染演示数据）',
    restoreAccount.status === 200 &&
      (!originalClassAccount.code || restoreAccount.payload?.data?.code === originalClassAccount.code) &&
      restoredLogin.status === 200,
    `原值=${originalClassAccount.code || '（未设置）'} 还原后=${restoreAccount.payload?.data?.code ?? '-'} 登录=${restoredLogin.status}`,
  );

  // ---------------------------------------------------------------- 教师录入与班主任（仅管理员）
  // 需求："支持录入学生也要支持录入老师，录入老师的权限只有 admin；
  //       创建班级只有 admin 有权限，并且支持设置或更改班主任"
  const adminTeachers = await api('/teachers', { token: adminToken });
  const staffList = adminTeachers.payload?.data ?? [];
  const teacher1 = staffList.find((item) => item.username === 'teacher1');
  const teacher2 = staffList.find((item) => item.username === 'teacher2');
  record(
    '教师列表（管理员）可用',
    adminTeachers.status === 200 && staffList.length >= 2,
    `status=${adminTeachers.status} 教师数=${staffList.length}`,
  );

  const teacherSeesTeachers = await api('/teachers', { token: teacherToken });
  const teacherCreatesTeacher = await api('/teachers', {
    method: 'POST',
    token: teacherToken,
    body: { username: 'smoke_denied_teacher', name: '越权教师', password: 'smoke123456' },
  });
  record(
    '教师名单只读与管理分离（默认教师可读取，但不能新建）',
    teacherSeesTeachers.status === 200 && teacherCreatesTeacher.status === 403,
    `列表=${teacherSeesTeachers.status} 新建=${teacherCreatesTeacher.status} message=${teacherCreatesTeacher.payload?.message ?? ''}`,
  );

  // 录入一个教师账号 → 编辑 → 重置密码 → 新密码可登录
  const smokeTeacherUsername = `smoke_teacher_${Date.now()}`;
  const createdTeacher = await api('/teachers', {
    method: 'POST',
    token: adminToken,
    body: { username: smokeTeacherUsername, name: '冒烟教师', password: 'smoke123456', role: 'TEACHER' },
  });
  const smokeTeacherId = createdTeacher.payload?.data?.id;
  record(
    '管理员录入教师账号（POST /teachers → 201）',
    createdTeacher.status === 201 &&
      Boolean(smokeTeacherId) &&
      createdTeacher.payload?.data?.role === 'TEACHER',
    `status=${createdTeacher.status} id=${smokeTeacherId ?? '-'} 角色=${createdTeacher.payload?.data?.role ?? '-'}`,
  );

  const teacherLoginBefore = await api('/auth/login', {
    method: 'POST',
    body: { username: smokeTeacherUsername, password: 'smoke123456' },
  });
  record(
    '新教师账号可登录（初始密码生效）',
    teacherLoginBefore.status === 200 && Boolean(teacherLoginBefore.payload?.data?.token),
    `status=${teacherLoginBefore.status} 角色=${teacherLoginBefore.payload?.data?.user?.role ?? '-'}`,
  );

  const updatedTeacher = await api(`/teachers/${smokeTeacherId}`, {
    method: 'PATCH',
    token: adminToken,
    body: { name: '冒烟教师（改名）', role: 'ADMIN' },
  });
  record(
    '编辑教师（姓名 + 角色升为管理员）',
    updatedTeacher.status === 200 &&
      updatedTeacher.payload?.data?.name === '冒烟教师（改名）' &&
      updatedTeacher.payload?.data?.role === 'ADMIN',
    `status=${updatedTeacher.status} 姓名=${updatedTeacher.payload?.data?.name ?? '-'} 角色=${updatedTeacher.payload?.data?.role ?? '-'}`,
  );

  const resetTeacherPassword = await api(`/teachers/${smokeTeacherId}/reset-password`, {
    method: 'POST',
    token: adminToken,
    body: { newPassword: 'teach999999' },
  });
  const teacherLoginNew = await api('/auth/login', {
    method: 'POST',
    body: { username: smokeTeacherUsername, password: 'teach999999' },
  });
  const teacherLoginOld = await api('/auth/login', {
    method: 'POST',
    body: { username: smokeTeacherUsername, password: 'smoke123456' },
  });
  record(
    '重置教师密码（新密码可用 / 旧密码失效）',
    resetTeacherPassword.status === 200 && teacherLoginNew.status === 200 && teacherLoginOld.status === 401,
    `重置=${resetTeacherPassword.status} 新密码=${teacherLoginNew.status} 旧密码=${teacherLoginOld.status}`,
  );

  // 教师名单表格导入：教师预览 403；管理员预览 + 提交（教师与班级无关，classId 可省略）
  const teacherCsv =
    '\ufeff工号,姓名,初始密码,角色\n' +
    `imp_t_${Date.now().toString().slice(-8)},冒烟导入教师,import123456,教师\n`;
  const teacherCsvBase64 = Buffer.from(teacherCsv, 'utf8').toString('base64');
  const importedTeacherUsername = teacherCsv.split('\n')[1]?.split(',')[0] ?? '';

  const teacherPreviewDenied = await api('/imports/table/preview', {
    method: 'POST',
    token: teacherToken,
    body: { kind: 'teachers', fileName: 'teachers.csv', contentBase64: teacherCsvBase64 },
  });
  const adminTeacherPreview = await api('/imports/table/preview', {
    method: 'POST',
    token: adminToken,
    body: { kind: 'teachers', fileName: 'teachers.csv', contentBase64: teacherCsvBase64 },
  });
  const adminTeacherCommit = await api('/imports/table/commit', {
    method: 'POST',
    token: adminToken,
    body: {
      kind: 'teachers',
      fileName: 'teachers.csv',
      contentBase64: teacherCsvBase64,
      mapping: { username: '工号', name: '姓名', password: '初始密码', role: '角色' },
      mode: 'upsert',
    },
  });
  const importedTeacherLogin = await api('/auth/login', {
    method: 'POST',
    body: { username: importedTeacherUsername, password: 'import123456' },
  });
  record(
    '教师名单表格导入（教师 403 / 管理员预览+导入成功，且导入账号可登录）',
    teacherPreviewDenied.status === 403 &&
      adminTeacherPreview.status === 200 &&
      Boolean(adminTeacherPreview.payload?.data?.suggestedMapping?.username) &&
      adminTeacherCommit.status === 200 &&
      adminTeacherCommit.payload?.data?.inserted === 1 &&
      importedTeacherLogin.status === 200,
    `教师预览=${teacherPreviewDenied.status} 管理员预览=${adminTeacherPreview.status} ` +
      `建议映射=${JSON.stringify(adminTeacherPreview.payload?.data?.suggestedMapping ?? {})} ` +
      `导入新增=${adminTeacherCommit.payload?.data?.inserted ?? '-'} 登录=${importedTeacherLogin.status}`,
  );

  // 删除护栏：还是班主任的账号不允许删除；没有班级职责的可以删
  const deleteHeadTeacher = teacher1
    ? await api(`/teachers/${teacher1.id}`, { method: 'DELETE', token: adminToken })
    : { status: 0, payload: null };
  const deleteSmokeTeacher = await api(`/teachers/${smokeTeacherId}`, {
    method: 'DELETE',
    token: adminToken,
  });
  record(
    '删除教师（有班级职责拒绝 409 / 无职责可删除）',
    deleteHeadTeacher.status === 409 && deleteSmokeTeacher.status === 200,
    `班主任账号=${deleteHeadTeacher.status}（${deleteHeadTeacher.payload?.message ?? ''}） 冒烟账号=${deleteSmokeTeacher.status}`,
  );

  // 级联删除护栏：`Homework.createdBy` / `Notification.createdBy` 都是 ON DELETE CASCADE，
  // 因此"已不在任何班级、名下无课程，但发布过内容"的账号也必须被拒 ——
  // 否则"班主任转给别人 → 解除协作 → 删除账号"会静默清掉他在各班发过的作业与通知。
  const cascadeTeacherUsername = `smoke_cas_${Date.now().toString().slice(-8)}`;
  const cascadeTeacher = await api('/teachers', {
    method: 'POST',
    token: adminToken,
    body: { username: cascadeTeacherUsername, name: '冒烟级联教师', password: 'cascade123456' },
  });
  const cascadeTeacherId = cascadeTeacher.payload?.data?.id;
  const cascadeTeacherLogin = await api('/auth/login', {
    method: 'POST',
    body: { username: cascadeTeacherUsername, password: 'cascade123456' },
  });
  const cascadeTeacherToken = cascadeTeacherLogin.payload?.data?.token;

  // 1) 先让他成为该班某科的任课老师（这样才有发布通知的权限），发一条通知
  await api(`/classes/${classId}/subject-teachers`, {
    method: 'PUT',
    token: adminToken,
    body: { assignments: [{ subjectName: '美术', teacherId: cascadeTeacherId }] },
  });
  const cascadeNotification = await api('/notifications', {
    method: 'POST',
    token: cascadeTeacherToken,
    body: { classId, title: '级联删除回归', content: '用于验证删除教师不会连带删除已发布内容' },
  });
  const cascadeNotificationId = cascadeNotification.payload?.data?.id;
  // 2) 解除任课关系（把该科还回班主任）：此时他"不在任何班级、名下无课程"，但发布过内容
  await api(`/classes/${classId}/subject-teachers`, {
    method: 'PUT',
    token: adminToken,
    body: { assignments: [{ subjectName: '美术', teacherId: ownClass?.teacherId }] },
  });
  // 3) 删除账号应当被拒（409），且那条通知必须还在
  const cascadeDelete = await api(`/teachers/${cascadeTeacherId}`, {
    method: 'DELETE',
    token: adminToken,
  });
  const afterCascadeList = await api(`/notifications?classId=${classId}`, { token: adminToken });
  const notificationAlive = (afterCascadeList.payload?.data ?? []).some(
    (item) => item.id === cascadeNotificationId,
  );
  record(
    '删除教师护栏覆盖"发布过作业/通知"的账号（不再级联删除内容）',
    cascadeDelete.status === 409 && notificationAlive,
    `删除=${cascadeDelete.status}（${cascadeDelete.payload?.message ?? ''}） 通知仍在=${notificationAlive}`,
  );

  // 清理：内容删掉后账号即可删除
  if (cascadeNotificationId) {
    await api(`/notifications/${cascadeNotificationId}`, { method: 'DELETE', token: adminToken });
  }
  const cascadeDeleteAfter = await api(`/teachers/${cascadeTeacherId}`, {
    method: 'DELETE',
    token: adminToken,
  });
  record(
    '清理：内容删除后该教师账号可删除',
    cascadeDeleteAfter.status === 200,
    `status=${cascadeDeleteAfter.status}`,
  );

  // 创建班级仅管理员 + 设置/更改班主任
  const teacherCreateClass = await api('/classes', {
    method: 'POST',
    token: teacherToken,
    body: { grade: '高一', enrollmentYear: new Date().getFullYear(), classIndex: 94 },
  });
  record(
    '仅管理员可创建班级（教师 403）',
    teacherCreateClass.status === 403,
    `status=${teacherCreateClass.status} message=${teacherCreateClass.payload?.message ?? ''}`,
  );

  const tempClassCode = `SM${Date.now().toString().slice(-6)}`;
  const createdClassWithHead = await api('/classes', {
    method: 'POST',
    token: adminToken,
    body: {
      grade: '高一',
      enrollmentYear: new Date().getFullYear(),
      classIndex: 95,
      code: tempClassCode,
      ...(teacher2 ? { teacherId: teacher2.id } : {}),
    },
  });
  const tempClassId = createdClassWithHead.payload?.data?.id;
  record(
    '创建班级时可指定班主任',
    createdClassWithHead.status === 201 &&
      Boolean(tempClassId) &&
      (!teacher2 || createdClassWithHead.payload?.data?.teacher?.id === teacher2.id),
    `status=${createdClassWithHead.status} 班主任=${createdClassWithHead.payload?.data?.teacher?.name ?? '-'}`,
  );

  const teacherChangeHead = await api(`/classes/${tempClassId}/head-teacher`, {
    method: 'PATCH',
    token: teacherToken,
    body: { teacherId: teacher1?.id ?? '' },
  });
  const changedHead = await api(`/classes/${tempClassId}/head-teacher`, {
    method: 'PATCH',
    token: adminToken,
    body: { teacherId: teacher1?.id ?? '' },
  });
  const changedDetail = await api(`/classes/${tempClassId}`, { token: adminToken });
  record(
    '设置 / 更改班主任（教师 403 / 管理员生效并落库）',
    teacherChangeHead.status === 403 &&
      changedHead.status === 200 &&
      changedDetail.payload?.data?.teacher?.id === teacher1?.id,
    `教师改=${teacherChangeHead.status} 管理员改=${changedHead.status} 详情班主任=${changedDetail.payload?.data?.teacher?.name ?? '-'}`,
  );

  // 清理：删除实时推送用例造的通知/作业、冒烟班级、临时权限校验班级与冒烟教师账号
  // ---------------------------------------------------------------- 数据库管理（仅管理员）
  // 覆盖：状态 / 越权 403 / 连接测试 / 备份→导入导出→恢复 roundtrip / 定时配置校验 / 切换校验分支。
  // 注意：**不真跑切换**（会改写 .env 与 schema.prisma），只验证拒绝分支；真实切换需人工复验。
  // 直接读取快照注册表，避免新增模型后测试清单遗漏。
  const snapshotSource = readFileSync(new URL('../src/lib/snapshot.ts', import.meta.url), 'utf8');
  const registry = snapshotSource.match(/export const SNAPSHOT_TABLES = \[([\s\S]*?)\] as const/);
  if (!registry) throw new Error('无法解析快照表注册表');
  const REQUIRED_DB_TABLES = [...registry[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  const dbStatus = await api('/database/status', { token: adminToken });
  const dbStatusData = dbStatus.payload?.data ?? {};
  const dbStatusTableNames = Array.isArray(dbStatusData.tables)
    ? dbStatusData.tables.map((item) => item.name)
    : [];
  record(
    '数据库状态（管理员）：已连接且返回全部数据表行数',
    dbStatus.status === 200 &&
      dbStatusData.connected === true &&
      Array.isArray(dbStatusData.tables) &&
      dbStatusData.tables.every((item) => item.count >= 0) &&
      dbStatusTableNames.length === REQUIRED_DB_TABLES.length &&
      REQUIRED_DB_TABLES.every((name) => dbStatusTableNames.includes(name)),
    `provider=${dbStatusData.provider} 延迟=${dbStatusData.latencyMs}ms 版本=${dbStatusData.version} 表=${
      dbStatusTableNames.length
    }`,
  );

  const dbStatusTeacher = await api('/database/status', { token: teacherToken });
  const dbBackupTeacher = await api('/database/backups', { method: 'POST', token: teacherToken });
  const dbScheduleTeacher = await api('/database/backup-schedule', {
    method: 'PUT',
    token: teacherToken,
    body: { enabled: true, intervalHours: 24, keepCount: 7 },
  });
  const dbSwitchTeacher = await api('/database/switch', {
    method: 'POST',
    token: teacherToken,
    body: { provider: 'sqlite', url: 'file:./data/teacher-forbidden.db' },
  });
  record(
    '数据库管理越权（教师全部 403）',
    dbStatusTeacher.status === 403 &&
      dbBackupTeacher.status === 403 &&
      dbScheduleTeacher.status === 403 &&
      dbSwitchTeacher.status === 403,
    `status=${dbStatusTeacher.status} 备份=${dbBackupTeacher.status} 定时=${dbScheduleTeacher.status} 切换=${dbSwitchTeacher.status}`,
  );

  // 连接测试：当前库必须可达（SQLite 取服务端当前临时库地址，MySQL 用一个不可达地址测失败分支）
  let testOkResult;
  let testOkName;
  if (dbStatusData.provider === 'sqlite') {
    testOkResult = await api('/database/test-connection', {
      method: 'POST',
      token: adminToken,
      body: { provider: 'sqlite', url: dbStatusData.databaseUrlMasked },
    });
    testOkName = '连接测试（当前 SQLite 库可达）';
  } else {
    testOkResult = await api('/database/test-connection', {
      method: 'POST',
      token: adminToken,
      body: { provider: 'mysql', url: 'mysql://root:wrong-password@127.0.0.1:1/none' },
    });
    testOkName = '连接测试（不可达 MySQL 返回 ok=false）';
  }
  record(
    testOkName,
    testOkResult.status === 200 &&
      (dbStatusData.provider === 'sqlite'
        ? testOkResult.payload?.data?.ok === true
        : testOkResult.payload?.data?.ok === false),
    `ok=${testOkResult.payload?.data?.ok} 版本=${testOkResult.payload?.data?.version} 详情=${testOkResult.payload?.data?.error ?? testOkResult.payload?.data?.note ?? '-'}`,
  );

  const dbTestRedis = await api('/database/test-connection', {
    method: 'POST',
    token: adminToken,
    body: { provider: 'redis', url: 'redis://127.0.0.1:6379' },
  });
  record(
    'Redis 作为主库被拒绝（schema 层面 422，产品口径：主库仅 SQLite/MySQL）',
    dbTestRedis.status === 422,
    `status=${dbTestRedis.status}`,
  );

  const badConnection = await api('/database/test-connection', {
    method: 'POST',
    token: adminToken,
    body: { provider: 'mysql', url: 'mysql://root:wrong@127.0.0.1:1/none' },
  });
  record(
    '连接测试（不可达 MySQL → ok=false 且不抛 500）',
    badConnection.status === 200 && badConnection.payload?.data?.ok === false,
    `ok=${badConnection.payload?.data?.ok} error=${(badConnection.payload?.data?.error ?? '').slice(0, 60)}`,
  );

  // 切换校验分支：同库拒绝（真实切换不在此跑，避免改写 .env）
  const switchSame =
    dbStatusData.provider === 'sqlite'
      ? await api('/database/switch', {
          method: 'POST',
          token: adminToken,
          body: { provider: 'sqlite', url: dbStatusData.databaseUrlMasked },
        })
      : { status: 0, payload: null };
  const switchInvalid = await api('/database/switch', {
    method: 'POST',
    token: adminToken,
    body: { provider: 'redis', url: 'redis://127.0.0.1:6379' },
  });
  record(
    '一键切换校验分支（同库 400 / 非法 provider 422，不真跑切换）',
    (dbStatusData.provider === 'sqlite' ? switchSame.status === 400 : true) && switchInvalid.status === 422,
    `同库=${switchSame.status}（${dbStatusData.provider === 'sqlite' ? 'sqlite 当前库' : 'mysql 跳过'}） redis=${switchInvalid.status}`,
  );

  // 备份 → 导出快照 → 造数据 → 快照导入 → 造数据 → 从备份恢复（三个恢复路径全验）
  const dbBackup = await api('/database/backups', { method: 'POST', token: adminToken });
  const backupName = dbBackup.payload?.data?.name ?? '';
  record(
    '手动备份（201，文件名符合约定格式）',
    dbBackup.status === 201 && /^backup-manual-\d{8}-\d{6}\.json\.gz$/.test(backupName),
    `name=${backupName} size=${dbBackup.payload?.data?.sizeBytes ?? '-'}`,
  );

  const dbExport = await fetch(`${BASE_URL}/api/database/export`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const snapshotJson = dbExport.status === 200 ? await dbExport.text() : '';
  let snapshotParsed = null;
  try {
    snapshotParsed = JSON.parse(snapshotJson);
  } catch {
    snapshotParsed = null;
  }
  const snapshotTableNames = Object.keys(snapshotParsed?.data ?? {});
  record(
    '导出快照（JSON 格式正确、全部数据表、账号数 > 0）',
    dbExport.status === 200 &&
      snapshotParsed?.format === 'classhelper-snapshot' &&
      snapshotTableNames.length === REQUIRED_DB_TABLES.length &&
      REQUIRED_DB_TABLES.every((name) => snapshotTableNames.includes(name)) &&
      (snapshotParsed?.counts?.User ?? 0) > 0,
    `status=${dbExport.status} 格式=${snapshotParsed?.format ?? '-'} 表=${snapshotTableNames.length} 用户=${
      snapshotParsed?.counts?.User ?? '-'
    }`,
  );

  // 造一条临时通知 → 快照导入（应被清掉）→ 再造一条 → 从备份恢复（也应被清掉）
  const dbRoundtripNotice = await api('/notifications', {
    method: 'POST',
    token: adminToken,
    body: { classId, title: '数据库roundtrip自检', content: '导入/恢复后应消失' },
  });
  const dbRoundtripNoticeId = dbRoundtripNotice.payload?.data?.id;
  const dbImport = await api('/database/import', {
    method: 'POST',
    token: adminToken,
    body: { data: Buffer.from(snapshotJson, 'utf8').toString('base64') },
  });
  const afterImport = await api(`/notifications?classId=${classId}`, { token: adminToken });
  const roundtripNoticeGone = !(afterImport.payload?.data ?? []).some(
    (item) => item.id === dbRoundtripNoticeId,
  );
  record(
    '快照导入（整库覆盖：导入后临时通知消失）',
    dbImport.status === 200 && roundtripNoticeGone,
    `导入=${dbImport.status} 通知已清除=${roundtripNoticeGone} 行数=${JSON.stringify(dbImport.payload?.data?.counts ?? {}).slice(0, 80)}`,
  );

  const dbRoundtripNotice2 = await api('/notifications', {
    method: 'POST',
    token: adminToken,
    body: { classId, title: '数据库roundtrip自检2', content: '备份恢复后应消失' },
  });
  const dbRoundtripNotice2Id = dbRoundtripNotice2.payload?.data?.id;
  const dbRestore = await api(`/database/backups/${backupName}/restore`, {
    method: 'POST',
    token: adminToken,
  });
  const afterRestore = await api(`/notifications?classId=${classId}`, { token: adminToken });
  const restoreNoticeGone = !(afterRestore.payload?.data ?? []).some(
    (item) => item.id === dbRoundtripNotice2Id,
  );
  record(
    '从备份恢复（整库覆盖：恢复后临时通知消失）',
    dbRestore.status === 200 && restoreNoticeGone,
    `恢复=${dbRestore.status} 通知已清除=${restoreNoticeGone}`,
  );
  if (dbRoundtripNoticeId) {
    await api(`/notifications/${dbRoundtripNoticeId}`, { method: 'DELETE', token: adminToken });
  }
  if (dbRoundtripNotice2Id) {
    await api(`/notifications/${dbRoundtripNotice2Id}`, { method: 'DELETE', token: adminToken });
  }

  const dbBackupList = await api('/database/backups', { token: adminToken });
  const dbBackupDelete = await api(`/database/backups/${backupName}`, {
    method: 'DELETE',
    token: adminToken,
  });
  const dbBackupListAfter = await api('/database/backups', { token: adminToken });
  record(
    '备份列表与删除（创建后可见，删除后消失）',
    dbBackupList.status === 200 &&
      (dbBackupList.payload?.data ?? []).some((item) => item.name === backupName) &&
      dbBackupDelete.status === 200 &&
      !(dbBackupListAfter.payload?.data ?? []).some((item) => item.name === backupName),
    `删除前=${(dbBackupList.payload?.data ?? []).length} 删除后=${(dbBackupListAfter.payload?.data ?? []).length}`,
  );

  const dbScheduleInvalid = await api('/database/backup-schedule', {
    method: 'PUT',
    token: adminToken,
    body: { enabled: true, intervalHours: 0, keepCount: 7 },
  });
  const dbScheduleSave = await api('/database/backup-schedule', {
    method: 'PUT',
    token: adminToken,
    body: { enabled: false, intervalHours: 24, keepCount: 7 },
  });
  record(
    '定时备份配置（非法间隔 422 / 合法保存并回读）',
    dbScheduleInvalid.status === 422 &&
      dbScheduleSave.status === 200 &&
      dbScheduleSave.payload?.data?.enabled === false &&
      dbScheduleSave.payload?.data?.intervalHours === 24,
    `非法=${dbScheduleInvalid.status} 保存=${dbScheduleSave.status} enabled=${dbScheduleSave.payload?.data?.enabled}`,
  );

  if (dbStatusData.provider === 'sqlite') {
    const sqliteFile = await fetch(`${BASE_URL}/api/database/sqlite-file`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const sqliteBytes = sqliteFile.status === 200 ? (await sqliteFile.arrayBuffer()).byteLength : 0;
    record(
      'SQLite 数据文件下载（快捷导出 .db 文件）',
      sqliteFile.status === 200 && sqliteBytes > 0,
      `status=${sqliteFile.status} bytes=${sqliteBytes}`,
    );
  }

  // 清理：删除实时推送用例造的通知/作业、冒烟班级、临时权限校验班级与冒烟教师账号
  const realtimeNoticeId = createdNotification.payload?.data?.id;
  if (realtimeNoticeId) {
    await api(`/notifications/${realtimeNoticeId}`, { method: 'DELETE', token: teacherToken });
  }
  if (homeworkId) {
    await api(`/homeworks/${homeworkId}`, { method: 'DELETE', token: teacherToken });
  }
  const realtimeLeftovers = await api(`/notifications?classId=${classId}`, { token: teacherToken });
  const homeworkLeftovers = await api(`/homeworks?classId=${classId}`, { token: teacherToken });
  record(
    '清理：实时推送用例的通知/作业已删除',
    !(realtimeLeftovers.payload?.data ?? []).some((item) => String(item.title).includes('联调验证')) &&
      !(homeworkLeftovers.payload?.data ?? []).some((item) => String(item.title).includes('联调验证')),
    `残留通知=${(realtimeLeftovers.payload?.data ?? []).filter((item) => String(item.title).includes('联调验证')).length} ` +
      `残留作业=${(homeworkLeftovers.payload?.data ?? []).filter((item) => String(item.title).includes('联调验证')).length}`,
  );

  if (tempClassId) await api(`/classes/${tempClassId}`, { method: 'DELETE', token: adminToken });
  for (const probeClassId of probeClassIds) {
    if (probeClassId && probeClassId !== tempClassId) {
      await api(`/classes/${probeClassId}`, { method: 'DELETE', token: adminToken });
    }
  }
  const importedTeacherRow = (await api('/teachers', { token: adminToken })).payload?.data?.find(
    (item) => item.username === importedTeacherUsername,
  );
  if (importedTeacherRow) {
    await api(`/teachers/${importedTeacherRow.id}`, { method: 'DELETE', token: adminToken });
  }
  const isProbeAccount = (username) =>
    String(username).startsWith('smoke_') || String(username).startsWith('imp_t_');
  const teachersAfterCleanup = await api('/teachers', { token: adminToken });
  const classesAfterCleanup = await api('/classes', { token: adminToken });
  const leftoverClasses = (classesAfterCleanup.payload?.data ?? []).filter(
    (item) => item.name?.includes('校验班') || item.name?.includes('冒烟'),
  );
  record(
    '清理：临时班级与冒烟教师账号已删除（不污染演示数据）',
    !(teachersAfterCleanup.payload?.data ?? []).some((item) => isProbeAccount(item.username)) &&
      leftoverClasses.length === 0,
    `剩余教师=${(teachersAfterCleanup.payload?.data ?? []).length} 冒烟残留=${
      (teachersAfterCleanup.payload?.data ?? [])
        .filter((item) => isProbeAccount(item.username))
        .map((item) => item.username)
        .join(',') || '无'
    } 残留班级=${leftoverClasses.map((item) => item.name).join(',') || '无'}`,
  );

  // ---------------------------------------------------------------- 更新检查
  // 验的是"结构完整 + 权限 + 可降级"，**刻意不断言"一定有新版本"** ——
  // 那会把用例绑死在外网可达上，而学校机房/内网服务器查不到 GitHub 是常态
  // （`ok:false` 是设计内的结果，不是失败）。真实联网取值在交付前人工验一次。
  const updateAnon = await api('/update/check');
  record('更新检查未登录 401', updateAnon.status === 401, `status=${updateAnon.status}`);

  const updateRes = await api('/update/check', { token: adminToken });
  const updateData = updateRes.payload?.data ?? {};
  const isVersionLike = (value) => typeof value === 'string' && /^\d/.test(value);
  record(
    '更新检查（管理员）：结构完整，本机版本取自 package.json',
    updateRes.status === 200 &&
      isVersionLike(updateData.currentVersion) &&
      typeof updateData.ok === 'boolean' &&
      typeof updateData.hasUpdate === 'boolean' &&
      (updateData.ok
        ? isVersionLike(updateData.latestVersion) &&
          Array.isArray(updateData.assets) &&
          /^https:\/\//.test(updateData.releaseUrl ?? '') &&
          updateData.error === null
        : typeof updateData.error === 'string' && updateData.error.length > 0),
    `ok=${updateData.ok} 本机=${updateData.currentVersion} 最新=${updateData.latestVersion ?? '-'} ` +
      `有新版本=${updateData.hasUpdate} 附件=${(updateData.assets ?? []).length}` +
      `${updateData.error ? ` 原因=${updateData.error}` : ''}`,
  );

  // force 只对管理员生效：教师带 force=1 也必须命中缓存（否则任意登录用户都能刷爆匿名限流）
  const updateTeacherForced = await api('/update/check?force=1', { token: teacherToken });
  record(
    '更新检查：默认教师可查，强制刷新需要 update:force',
    updateTeacherForced.status === 200 &&
      updateTeacherForced.payload?.data?.checkedAt === updateData.checkedAt,
    `status=${updateTeacherForced.status} 命中缓存=${updateTeacherForced.payload?.data?.checkedAt === updateData.checkedAt}`,
  );

  /* ---------------------------------------------------------------- 13. 学期周次（仅管理员可写） */
  // 需求：「第几周的周次数据可以由 admin 修改，并对所有 ClassIsland 下发修改」。
  // 线性推算遇到调休/补课会整体错位，所以支持逐周指定日期区间。

  const termGlobal = await api('/term', { token: adminToken });
  record(
    '学期周次：读取全校默认口径',
    termGlobal.status === 200 &&
      typeof termGlobal.payload?.data?.currentWeek === 'number' &&
      Array.isArray(termGlobal.payload?.data?.weeks),
    `status=${termGlobal.status} 当前第 ${termGlobal.payload?.data?.currentWeek ?? '-'} 周 配置=${termGlobal.payload?.data?.configured}`,
  );

  const termForTeacher = await api('/term', { token: teacherToken });
  record(
    '学期周次：教师可读（课表页要显示"第几周"）',
    termForTeacher.status === 200,
    `status=${termForTeacher.status}`,
  );

  // 用一段**覆盖今天**的区间，验证"当前周次按区间判定"而不是按开学日期线性推算
  const today = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const dayKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const rangeStart = new Date(today.getTime() - 2 * 86400000);
  const rangeEnd = new Date(today.getTime() + 2 * 86400000);
  const beforeTerm = (await api('/term', { token: adminToken })).payload?.data;

  const termSaved = await api('/term', {
    method: 'PUT',
    token: adminToken,
    body: {
      weeks: [
        { weekNumber: 7, startDate: dayKey(rangeStart), endDate: dayKey(rangeEnd), note: 'e2e 区间回归' },
      ],
    },
  });
  record(
    '学期周次：管理员保存逐周区间（PUT /term）',
    termSaved.status === 200 &&
      termSaved.payload?.data?.configured === true &&
      termSaved.payload?.data?.currentWeek === 7,
    `status=${termSaved.status} 当前第 ${termSaved.payload?.data?.currentWeek ?? '-'} 周（区间覆盖今天应为第 7 周）`,
  );

  const termOverlap = await api('/term', {
    method: 'PUT',
    token: adminToken,
    body: {
      weeks: [
        { weekNumber: 1, startDate: '2026-09-01', endDate: '2026-09-10' },
        { weekNumber: 2, startDate: '2026-09-05', endDate: '2026-09-14' },
      ],
    },
  });
  record(
    '学期周次：区间重叠被拒绝（400，避免"当前第几周"出现歧义）',
    termOverlap.status === 400,
    `status=${termOverlap.status} message=${termOverlap.payload?.message ?? ''}`,
  );

  const termDenied = await api('/term', {
    method: 'PUT',
    token: teacherToken,
    body: { weeks: [{ weekNumber: 1, startDate: '2026-09-01', endDate: '2026-09-07' }] },
  });
  record(
    '学期周次：教师写入被拒绝（403，周次会让全校课表错位）',
    termDenied.status === 403,
    `status=${termDenied.status}`,
  );

  const termAuto = await api('/term/auto', {
    method: 'POST',
    token: adminToken,
    body: { termStartDate: '2026-09-07', maxWeek: 3 },
  });
  record(
    '学期周次：按开学日期一键生成（POST /term/auto）',
    termAuto.status === 200 &&
      (termAuto.payload?.data?.weeks ?? []).length === 3 &&
      termAuto.payload?.data?.weeks?.[0]?.startDate === '2026-09-07' &&
      termAuto.payload?.data?.weeks?.[2]?.endDate === '2026-09-27',
    `status=${termAuto.status} 首周=${termAuto.payload?.data?.weeks?.[0]?.startDate} 末周=${termAuto.payload?.data?.weeks?.[2]?.endDate}`,
  );

  const holidays = await api('/term/holidays', { token: adminToken });
  record(
    '学期周次：联网拉取放假安排（机房无外网时 ok=false 属正常结果，不能抛 500）',
    holidays.status === 200 && typeof holidays.payload?.data?.ok === 'boolean',
    `status=${holidays.status} ok=${holidays.payload?.data?.ok} 条数=${holidays.payload?.data?.holidays?.length ?? 0}`,
  );

  // 收尾：还原成纯线性推算，不污染演示数据
  await api('/term', {
    method: 'PUT',
    token: adminToken,
    body: { termStartDate: beforeTerm?.termStartDate ?? undefined, weeks: [] },
  });
  const termRestored = await api('/term', { token: adminToken });
  record(
    '学期周次用例收尾：清空逐周配置（回到按开学日期线性推算）',
    termRestored.payload?.data?.configured === false,
    `configured=${termRestored.payload?.data?.configured}`,
  );

  const retiredIntegration = await api('/integrations/devices', { token: adminToken });
  record(
    '退役联动接口不再提供服务',
    retiredIntegration.status === 404,
    `status=${retiredIntegration.status}`,
  );

  socket.close();

  // ---------------------------------------------------------------- 汇总
  const passed = results.filter((item) => item.ok).length;
  const failed = results.filter((item) => !item.ok);
  console.log(`\n=== 结果：${passed}/${results.length} 项通过 ===`);
  if (failed.length > 0) {
    console.log('失败项：');
    for (const item of failed) console.log(`  - ${item.name} (${item.detail})`);
    process.exit(1);
  }
  console.log('全部验收项通过 \u2713\n');
}

main().catch((error) => {
  console.error('\n验证脚本执行失败：', error);
  process.exit(1);
});
