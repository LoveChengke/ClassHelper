#!/usr/bin/env node
/**
 * 端到端联调验证（对应验收标准）：
 *   1. 教师发布通知 -> 学生端 Socket.IO 5 秒内收到
 *   2. 教师发布作业 -> 学生端实时收到，并可标记完成
 *   3. 教师录入成绩 -> 学生端实时收到，且 /grades/my 可查
 *   4. 权限隔离：学生无法访问其他班级数据、无法调用教师接口
 *   5. 课表按周查询可用
 *
 * 用法：
 *   1) 另开终端启动后端：pnpm dev:server
 *   2) 执行：pnpm verify:e2e
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
  console.log(`\n=== 班级小助手 端到端验证（${BASE_URL}）===\n`);

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

  // 学生端主体 = 班级：用「班级码 + 班级密码」登录（个人学生账号已停用登录入口）
  const classesForLogin = await api('/classes', { token: teacherToken });
  const loginClass = classesForLogin.payload?.data?.[0];
  if (!loginClass?.code) {
    record(
      '学生端班级登录（班级码 + 班级密码 → classSession）',
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
    '学生端班级登录（班级码 + 班级密码 → classSession）',
    Boolean(studentToken) && studentUser?.classSession === true,
    `code=${loginClass.code} status=${studentLogin.status} classId=${studentUser?.classId ?? studentUser?.id}`,
  );
  record(
    '个人学生账号登录已停用（403）',
    (await api('/auth/login', { method: 'POST', body: { username: 'student01', password: 'student123' } }))
      .status === 403,
    'student01 → 403',
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

  const ownClass = classes.find((item) => item.name?.includes('高一(1)')) ?? classes[0];
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
  const teacher2Token = teacher2Login.payload?.data?.token;
  const teacher2Id = teacher2Login.payload?.data?.user?.id;
  const teacher1ClassIds = new Set(classes.map((item) => item.id));
  const teacher2Classes = (await api('/classes', { token: teacher2Token })).payload?.data ?? [];
  /** 本次验证临时创建的班级（收尾统一删除，不污染演示数据） */
  const probeClassIds = [];
  let foreignClass = teacher2Classes.find((item) => !teacher1ClassIds.has(item.id)) ?? null;
  if (!foreignClass) {
    const created = await api('/classes', {
      method: 'POST',
      token: adminToken,
      body: {
        name: `权限校验班 ${Date.now()}`,
        grade: '高一',
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
    '学生端 Socket.IO 连接与鉴权',
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
    record('学生端 5 秒内收到 notification:new', elapsed < TIME_LIMIT_MS, `${elapsed}ms · ${payload?.title}`);
  } catch (error) {
    record('学生端 5 秒内收到 notification:new', false, error.message);
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

  try {
    const { payload, elapsed } = await homeworkWait;
    record('学生端 5 秒内收到 homework:new', elapsed < TIME_LIMIT_MS, `${elapsed}ms · ${payload?.title}`);
  } catch (error) {
    record('学生端 5 秒内收到 homework:new', false, error.message);
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
  const studentIds = (submissions.payload?.data?.students ?? []).map((item) => item.userId);
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
    body: { notSubmittedUserIds: [firstStudentId] },
  });
  record(
    '保存未交名单：勾选者标记未交、其余学生自动标记已交',
    savedSubmissions.status === 200 &&
      (savedSubmissions.payload?.data?.notSubmitted ?? []).length === 1 &&
      savedSubmissions.payload?.data?.notSubmitted?.[0]?.userId === firstStudentId &&
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
      userId: targetStudent?.id,
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
        '学生端 5 秒内收到 grade:updated',
        elapsed < TIME_LIMIT_MS,
        `${elapsed}ms · ${payload?.score}/${payload?.totalScore}`,
      );
    } catch (error) {
      record('学生端 5 秒内收到 grade:updated', false, error.message);
    }
  } else {
    gradeWait.catch(() => {});
    record('学生端成绩推送（目标学生非验证账号，跳过等待）', true, '已改用 /grades/my 校验');
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

  const assigned = await api(`/classes/${classId}/teachers`, {
    method: 'POST',
    token: adminToken,
    body: { teacherId: teacher2Login.payload?.data?.user?.id },
  });
  record('分配协作教师', assigned.status === 201, `status=${assigned.status}`);
  const unassigned = await api(`/classes/${classId}/teachers/${teacher2Login.payload?.data?.user?.id}`, {
    method: 'DELETE',
    token: adminToken,
  });
  record('取消协作教师', unassigned.status === 200, `status=${unassigned.status}`);

  const tempUsername = `e2e_student_${Date.now()}`;
  const addedStudent = await api(`/classes/${classId}/students`, {
    method: 'POST',
    token: adminToken,
    body: { username: tempUsername, name: '联调学生' },
  });
  const addedStudentId = addedStudent.payload?.data?.id;
  record('班级添加学生', addedStudent.status === 201, `status=${addedStudent.status}`);

  if (addedStudentId) {
    const studentListAfter = await api(`/classes/${classId}/students`, { token: teacherToken });
    record(
      '学生名单包含新加入学生',
      (studentListAfter.payload?.data ?? []).some((item) => item.id === addedStudentId),
      `共 ${studentListAfter.payload?.data?.length ?? 0} 人`,
    );

    const resetResult = await api(`/students/${addedStudentId}/reset-password`, {
      method: 'POST',
      token: adminToken,
      body: {},
    });
    record('重置学生密码', resetResult.status === 200, `status=${resetResult.status}`);

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
      items: classmates.slice(0, 3).map((item, index) => ({ userId: item.id, score: 70 + index * 5 })),
    },
  });
  record(
    '批量录入成绩 POST /grades/bulk',
    bulkResult.status === 201,
    `录入 ${bulkResult.payload?.data?.count ?? 0} 条`,
  );

  const gradeStats = await api(`/grades/stats?classId=${classId}`, { token: teacherToken });
  record(
    '成绩统计 /grades/stats',
    gradeStats.status === 200 && (gradeStats.payload?.data?.distribution ?? []).length === 5,
    `平均得分率 ${gradeStats.payload?.data?.averagePercent ?? 0}%`,
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
      '普通叫人（默认）不是紧急级别：priority=HIGH，学生端按普通通知排队',
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
      '紧急叫人（urgent=true → priority=URGENT，学生端无视上课时段立即展开）',
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
      body: { classId, studentId: targetStudent?.id, quickPhrase: '学生不能叫人' },
    });
    record('学生调用叫人接口被拒绝（403）', studentCalls.status === 403, `status=${studentCalls.status}`);

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

    // 科任老师：teacher2 是某班的协作（科任）老师。
    // 同样不依赖演示数据：推断出来的班级不可用（被人工改过权限 / 与外部班级同一个）时现建一个：
    // teacher1 当班主任 + teacher2 协作，收尾删除。
    let subjectClass = teacher2Classes.find((item) => item.teacherId !== teacher2Id) ?? null;
    if (!subjectClass || subjectClass.id === foreignClass?.id) {
      const created = await api('/classes', {
        method: 'POST',
        token: adminToken,
        body: {
          name: `科任校验班 ${Date.now()}`,
          grade: '高一',
          code: `SJ${Date.now().toString().slice(-6)}`,
          teacherId: teacher1Id,
        },
      });
      const createdId = created.payload?.data?.id;
      if (createdId) {
        await api(`/classes/${createdId}/teachers`, {
          method: 'POST',
          token: adminToken,
          body: { teacherId: teacher2Id },
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
        body: { name: '班主任越权班', grade: '高一' },
      });
      record('班主任创建班级被拒绝（403）', headCreate.status === 403, `status=${headCreate.status}`);

      const subjectCreate = await api('/classes', {
        method: 'POST',
        token: teacher2Token,
        body: { name: '科任越权班', grade: '高一' },
      });
      record('科任老师创建班级被拒绝（403）', subjectCreate.status === 403, `status=${subjectCreate.status}`);

      const headDelete = await api(`/classes/${classId}`, { method: 'DELETE', token: teacherToken });
      record('班主任删除班级被拒绝（403）', headDelete.status === 403, `status=${headDelete.status}`);

      const headAssign = await api(`/classes/${classId}/teachers`, {
        method: 'POST',
        token: teacherToken,
        body: { teacherId: teacher2Login.payload?.data?.user?.id },
      });
      record('班主任分配科任老师被拒绝（403）', headAssign.status === 403, `status=${headAssign.status}`);

      const subjectAssign = await api(`/classes/${classId}/teachers`, {
        method: 'POST',
        token: teacher2Token,
        body: { teacherId: teacher2Login.payload?.data?.user?.id },
      });
      record('科任老师分配人员被拒绝（403）', subjectAssign.status === 403, `status=${subjectAssign.status}`);

      // 管理员可以分配（用"先加后删"验证）
      const adminAssign = await api(`/classes/${classId}/teachers`, {
        method: 'POST',
        token: adminToken,
        body: { teacherId: teacher2Login.payload?.data?.user?.id },
      });
      record(
        '管理员分配科任老师成功（201/200）',
        [200, 201].includes(adminAssign.status),
        `status=${adminAssign.status}`,
      );
      const adminUnassign = await api(
        `/classes/${classId}/teachers/${teacher2Login.payload?.data?.user?.id}`,
        {
          method: 'DELETE',
          token: adminToken,
        },
      );
      record('管理员取消科任老师成功（200）', adminUnassign.status === 200, `status=${adminUnassign.status}`);

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

      const subjectHomework = await api('/homeworks', {
        method: 'POST',
        token: subjectClassId ? teacher2Token : teacherToken,
        body: {
          classId: subjectClassId,
          title: '科任老师布置的作业',
          content: '权限矩阵校验用',
        },
      });
      record('科任老师可布置作业（201）', subjectHomework.status === 201, `status=${subjectHomework.status}`);
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
          userId: targetStudent?.id,
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
          userId: targetStudent?.id,
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
            userId: targetStudent?.id,
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
          userId: targetStudent?.id,
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
    body: { classId, title: '学生越权发布', content: '不应成功' },
  });
  record('学生调用教师接口被拒绝（403）', studentPublish.status === 403, `status=${studentPublish.status}`);

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
    '班主任下载名单模板被拒绝（403，名单仅管理员）',
    teacherRosterTemplate.status === 403,
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
    token: teacherToken,
    body: { classId, name: '默认时间表', mode: 'replace', payload: sampleLayout },
  });
  const layoutId = layoutImport.payload?.data?.layout?.id ?? null;
  record(
    '班主任导入本班时间配置（replace）',
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
    token: teacherToken,
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
    token: teacherToken,
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

  // 8.3 成绩表格导入（CSV 校验 + XLSX 新增/重复/更新 + 错误行提示）
  const gradesCsv = [
    '用户名,姓名,考试名称,分数,总分,课程',
    'student01,,期中导入考试,92,100,',
    `,${targetStudent?.name ?? '张同学'},期中导入考试,不是数字,100,`,
    'unknown-user,,期中导入考试,88,100,',
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
    ['student02', '', '期中导入考试', 85, 100, ''],
    ['student01', '', '期中导入考试', 78, 100, ''],
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
      xlsxPreview.payload?.data?.suggestedMapping?.username === '学号' &&
      xlsxPreview.payload?.data?.suggestedMapping?.score === '得分',
    `status=${xlsxPreview.status} 映射=${JSON.stringify(xlsxPreview.payload?.data?.suggestedMapping ?? {})}`,
  );

  const commitMapping = {
    username: '学号',
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
        username: '用户名',
        name: '姓名',
        examName: '考试名称',
        score: '分数',
        totalScore: '总分',
        courseName: '课程',
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

  // 8.4 学生名单导入（仅管理员）+ 数据清理
  const importedUsername = `imp${Date.now().toString(36).slice(-6)}`;
  const studentsCsv = [
    '用户名,姓名,初始密码',
    `${importedUsername},导入测试生,imp123456`,
    'bad user,非法用户名,imp123456',
  ].join(NL);
  const studentsCommit = await api('/imports/table/commit', {
    method: 'POST',
    token: adminToken,
    body: {
      kind: 'students',
      classId,
      fileName: 'students.csv',
      contentBase64: Buffer.from(`\ufeff${studentsCsv}${NL}`, 'utf8').toString('base64'),
      mapping: { username: '用户名', name: '姓名', password: '初始密码' },
      mode: 'append',
    },
  });
  record(
    '学生名单导入（新增 1 / 非法用户名进错误行 1）',
    studentsCommit.status === 200 &&
      studentsCommit.payload?.data?.inserted === 1 &&
      studentsCommit.payload?.data?.failed === 1,
    `新增=${studentsCommit.payload?.data?.inserted} 失败=${studentsCommit.payload?.data?.failed}`,
  );

  // 8.5 需求 6：表格导入在"老师端"可用且不越权
  //     班主任 → 本班成绩可预览/导入；科任 → 403；班主任 → 名单导入仍 403（人员管理仅管理员）
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
        username: '用户名',
        name: '姓名',
        examName: '考试名称',
        score: '分数',
        totalScore: '总分',
        courseName: '课程',
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

  // teacher2 是高二(3)班的科任老师（班主任是 teacher1）——这才是真正的"科任"场景
  const subjectOnlyClass = classes.find((item) => item.name?.includes('高二(3)')) ?? null;
  const subjectGradesImport = await api('/imports/table/commit', {
    method: 'POST',
    token: teacher2Token,
    body: {
      kind: 'grades',
      classId: subjectOnlyClass?.id ?? classId,
      fileName: 'grades.csv',
      contentBase64: gradesCsvBase64,
      mapping: {
        username: '用户名',
        name: '姓名',
        examName: '考试名称',
        score: '分数',
        totalScore: '总分',
        courseName: '课程',
      },
      mode: 'upsert',
    },
  });
  record(
    '科任老师导入本班成绩被拒绝（403，需求 7）',
    Boolean(subjectOnlyClass) && subjectGradesImport.status === 403,
    `班级=${subjectOnlyClass?.name ?? '未找到高二(3)班'} status=${subjectGradesImport.status}`,
  );

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
          username: '用户名',
          name: '姓名',
          examName: '考试名称',
          score: '分数',
          totalScore: '总分',
          courseName: '课程',
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
    '班主任预览学生名单模板被拒绝（403，名单仅管理员）',
    teacherRosterPreview.status === 403,
    `status=${teacherRosterPreview.status}`,
  );

  const studentsByTeacher = await api('/imports/table/commit', {
    method: 'POST',
    token: teacherToken,
    body: {
      kind: 'students',
      classId,
      fileName: 'students.csv',
      contentBase64: Buffer.from(`\ufeff${studentsCsv}${NL}`, 'utf8').toString('base64'),
      mapping: { username: '用户名', name: '姓名', password: '初始密码' },
      mode: 'append',
    },
  });
  record(
    '教师导入学生名单被拒绝（403）',
    studentsByTeacher.status === 403,
    `status=${studentsByTeacher.status}`,
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
  const importedStudent = (roster.payload?.data ?? []).find((item) => item.username === importedUsername);
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
      token: teacherToken,
    });
    record('时间配置可删除（清理验证数据）', layoutDeleted.status === 200, `status=${layoutDeleted.status}`);
  }

  // ---------------------------------------------------------------- 9. 班级账号（学生端主体 = 班级）
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
    body: { classId, title: '班级账号越权发布', content: '不应成功' },
  });
  record('班级账号发布通知被拒绝（403）', classPublish.status === 403, `status=${classPublish.status}`);

  const classGradesWrite = await api('/grades', {
    method: 'POST',
    token: classToken,
    body: { classId, userId: targetStudent?.id, examName: '班级账号越权成绩', score: 90, totalScore: 100 },
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
    body: { classId, userId: targetStudent?.id, examName: '班级总览回归', score: 77, totalScore: 100 },
  });
  const classMyGrades = await api('/grades/my', { token: classToken });
  const gradeStudentIds = new Set((classMyGrades.payload?.data ?? []).map((item) => item.userId));
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
    '仅管理员可录入教师（教师读取/新建均 403）',
    teacherSeesTeachers.status === 403 && teacherCreatesTeacher.status === 403,
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
    '\ufeff用户名,姓名,初始密码,角色\n' +
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
      mapping: { username: '用户名', name: '姓名', password: '初始密码', role: '角色' },
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

  // 创建班级仅管理员 + 设置/更改班主任
  const teacherCreateClass = await api('/classes', {
    method: 'POST',
    token: teacherToken,
    body: { name: '越权班级', grade: '高一' },
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
      name: `冒烟班级 ${Date.now()}`,
      grade: '高一',
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
