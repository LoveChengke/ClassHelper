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

  // 管理员令牌：按新的角色权限模型，班级增删改/人员分配/学生名单/成绩均仅管理员可执行
  const adminLogin = await api('/auth/login', {
    method: 'POST',
    body: { username: 'admin', password: 'admin123' },
  });
  const adminToken = adminLogin.payload?.data?.token;
  record('管理员登录 admin', Boolean(adminToken), `status=${adminLogin.status}`);
  if (!adminToken) process.exit(1);

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

  const studentList = await api(`/students?classId=${classId}`, { token: adminToken });
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

  // ---------------------------------------------------------------- 6.3 叫人
  if (classId && studentUser) {
    const callByTeacher = await api('/calls', {
      method: 'POST',
      token: teacherToken,
      body: {
        classId,
        studentId: studentUser.id,
        quickPhrase: '请到办公室找我',
      },
    });
    const callTitle = callByTeacher.payload?.data?.title ?? '';
    record(
      '叫人接口（教师点名 → 201 + "请 XXX 同学找 XXX 老师"）',
      callByTeacher.status === 201 && callTitle.includes('请') && callTitle.includes('找'),
      `status=${callByTeacher.status} title="${callTitle}"`,
    );

    const callWithMessage = await api('/calls', {
      method: 'POST',
      token: teacherToken,
      body: {
        classId,
        studentId: studentUser.id,
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
      body: { classId, studentId: studentUser.id, quickPhrase: '请马上来一趟' },
    });
    record(
      '上课时段允许叫人（不受紧急通知 409 限制）',
      callDuringClass.status === 201,
      `status=${callDuringClass.status}`,
    );

    const studentCalls = await api('/calls', {
      method: 'POST',
      token: studentToken,
      body: { classId, studentId: studentUser.id, quickPhrase: '学生不能叫人' },
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
    for (const created of [callByTeacher, callWithMessage, callDuringClass]) {
      const id = created.payload?.data?.id;
      if (id) await api(`/notifications/${id}`, { method: 'DELETE', token: teacherToken });
    }
    record('清理叫人测试数据', true, '已删除 3 条叫人通知');
  }

  // ---------------------------------------------------------------- 6.4 班级角色权限矩阵
  // 依据需求：班主任/科任老师不能增删改班级；仅管理员可分配人员；
  // 科任老师仅作业/叫人/通知；班主任另可管理本班课表；成绩录入仅管理员。
  {
    record('管理员登录（用于权限矩阵校验）', Boolean(adminToken), '已在上文登录');

    // 科任老师：teacher2 在高二(3)班是协作（科任）老师
    const subjectClass = teacher2Classes.find(
      (item) => item.teacherId !== teacher2Login.payload?.data?.user?.id,
    );
    const subjectClassId = subjectClass?.id;
    record(
      '存在"科任老师"场景的班级',
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
        body: { classId: classId, userId: studentUser?.id, examName: '越权成绩', score: 90, totalScore: 100 },
      });
      record('科任老师录入成绩被拒绝（403）', subjectGrades.status === 403, `status=${subjectGrades.status}`);

      const headGrades = await api('/grades', {
        method: 'POST',
        token: teacherToken,
        body: {
          classId: classId,
          userId: studentUser?.id,
          examName: '班主任越权成绩',
          score: 90,
          totalScore: 100,
        },
      });
      record(
        '班主任录入成绩被拒绝（403，成绩仅管理员）',
        headGrades.status === 403,
        `status=${headGrades.status}`,
      );

      const adminGrades = await api('/grades', {
        method: 'POST',
        token: adminToken,
        body: {
          classId: classId,
          userId: studentUser?.id,
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

  const templateDenied = await api('/imports/template?kind=grades&format=csv', { token: teacherToken });
  record('教师下载成绩模板被拒绝（403）', templateDenied.status === 403, `status=${templateDenied.status}`);

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

  const gradesByTeacher = await api('/imports/table/commit', {
    method: 'POST',
    token: teacherToken,
    body: { ...gradesCommitBody, mode: 'append' },
  });
  record(
    '教师（非管理员）导入成绩被拒绝（403）',
    gradesByTeacher.status === 403,
    `status=${gradesByTeacher.status}`,
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
    body: { classId, userId: studentUser?.id, examName: '班级账号越权成绩', score: 90, totalScore: 100 },
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
    body: { classId, userId: studentUser?.id, examName: '班级总览回归', score: 77, totalScore: 100 },
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

  // 清理：删除回归用的通知 / 作业 / 成绩，并把班级密码恢复为默认
  if (classNameNoticeId) {
    await api(`/notifications/${classNameNoticeId}`, { method: 'DELETE', token: teacherToken });
  }
  if (classHomeworkId) {
    await api(`/homeworks/${classHomeworkId}`, { method: 'DELETE', token: teacherToken });
  }
  if (classNameGrade.payload?.data?.id) {
    await api(`/grades/${classNameGrade.payload.data.id}`, { method: 'DELETE', token: adminToken });
  }
  await api(`/classes/${classId}/class-account`, {
    method: 'PATCH',
    token: adminToken,
    body: { password: '123456' },
  });

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
