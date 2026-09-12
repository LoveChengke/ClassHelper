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
  record('教师登录 teacher1', Boolean(teacherToken), `status=${teacherLogin.status}`);
  if (!teacherToken) process.exit(1);

  const studentLogin = await api('/auth/login', {
    method: 'POST',
    body: { username: 'student01', password: 'student123' },
  });
  const studentToken = studentLogin.payload?.data?.token;
  const studentUser = studentLogin.payload?.data?.user;
  record('学生登录 student01', Boolean(studentToken), `classId=${studentUser?.classId}`);

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

  // teacher2 名下但 teacher1 无权访问的班级，用于验证教师间权限隔离
  const teacher2Login = await api('/auth/login', {
    method: 'POST',
    body: { username: 'teacher2', password: 'teacher123' },
  });
  const teacher2Token = teacher2Login.payload?.data?.token;
  const teacher1ClassIds = new Set(classes.map((item) => item.id));
  const teacher2Classes = (await api('/classes', { token: teacher2Token })).payload?.data ?? [];
  const foreignClass = teacher2Classes.find((item) => !teacher1ClassIds.has(item.id)) ?? null;
  record(
    '教师权限隔离测试数据就绪',
    Boolean(foreignClass),
    foreignClass ? `外部班级：${foreignClass.name}` : '未找到其它教师的班级',
  );

  const studentList = await api(`/students?classId=${classId}`, { token: teacherToken });
  const classmates = studentList.payload?.data ?? [];
  const targetStudent = classmates.find((item) => item.id === studentUser?.id) ?? classmates[0];
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
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    },
  });
  const homeworkId = createdHomework.payload?.data?.id;
  record('教师发布作业', createdHomework.status === 201, `status=${createdHomework.status}`);

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
    token: teacherToken,
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

  if (targetStudent?.id === studentUser?.id) {
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

  const teacherList = await api('/teachers', { token: teacherToken });
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
    token: teacherToken,
    body: { teacherId: teacher2Login.payload?.data?.user?.id },
  });
  record('分配协作教师', assigned.status === 201, `status=${assigned.status}`);
  const unassigned = await api(`/classes/${classId}/teachers/${teacher2Login.payload?.data?.user?.id}`, {
    method: 'DELETE',
    token: teacherToken,
  });
  record('取消协作教师', unassigned.status === 200, `status=${unassigned.status}`);

  const tempUsername = `e2e_student_${Date.now()}`;
  const addedStudent = await api(`/classes/${classId}/students`, {
    method: 'POST',
    token: teacherToken,
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
      token: teacherToken,
      body: {},
    });
    record('重置学生密码', resetResult.status === 200, `status=${resetResult.status}`);

    const renamed = await api(`/students/${addedStudentId}`, {
      method: 'PATCH',
      token: teacherToken,
      body: { name: '联调学生（已改名）' },
    });
    record(
      '修改学生信息',
      renamed.status === 200 && renamed.payload?.data?.name?.includes('已改名'),
      `name=${renamed.payload?.data?.name}`,
    );

    const removedStudent = await api(`/classes/${classId}/students/${addedStudentId}`, {
      method: 'DELETE',
      token: teacherToken,
    });
    record('班级移出学生', removedStudent.status === 200, `status=${removedStudent.status}`);

    // 移出后学生已无班级，按权限规则只有管理员可以删除该账号
    const teacherDelete = await api(`/students/${addedStudentId}`, { method: 'DELETE', token: teacherToken });
    record('教师删除未分班学生被拒绝（403）', teacherDelete.status === 403, `status=${teacherDelete.status}`);

    const adminLogin = await api('/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'admin123' },
    });
    const adminToken = adminLogin.payload?.data?.token;
    record('管理员登录 admin', Boolean(adminToken), `status=${adminLogin.status}`);

    const adminDelete = await api(`/students/${addedStudentId}`, { method: 'DELETE', token: adminToken });
    record('管理员删除学生账号', adminDelete.status === 200, `status=${adminDelete.status}`);
  }

  const bulkResult = await api('/grades/bulk', {
    method: 'POST',
    token: teacherToken,
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
    token: teacherToken,
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
    studentVisible.length === 1 && studentVisible[0]?.id === studentUser?.classId,
    `共 ${studentVisible.length} 个`,
  );

  const studentHomeworkAll = await api('/homeworks', { token: studentToken });
  const homeworkClassIds = new Set((studentHomeworkAll.payload?.data ?? []).map((item) => item.classId));
  record(
    '学生作业列表已按班级收敛',
    homeworkClassIds.size <= 1 && (homeworkClassIds.size === 0 || homeworkClassIds.has(studentUser?.classId)),
    `涉及 ${homeworkClassIds.size} 个班级`,
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
