/**
 * 冒烟 / 验收专用的**临时班级**。
 *
 * 为什么必须新开一个班（而不是复用仓库里的第一个班）：
 * 验证会真发通知 —— 实时链路用例必须把通知打到"冒烟客户端所在的班级"，
 * 若这个班就是用户正在用的班，那些探针通知会**弹到用户自己的客户端与灵动岛上**，
 * 用户会以为"屏幕上出现了第二个灵动岛 / 客户端出问题了"（实测被投诉过好几次）。
 *
 * 做法：用管理员账号建一个随机班级码的临时班级 → 设为冒烟客户端的登录账号 →
 * 顺手给它备一份"当天的作业"（新班没有种子数据，作业看板用例要有东西可看）→ 收尾删掉。
 * 拿不到管理员账号时返回 null，调用方应中止联网验收，不得回退到真实班级或重置其密码。
 */
export async function provisionSmokeClass(options = {}) {
  const cleanups = [];
  const cleanup = async () => {
    for (const remove of [...cleanups].reverse()) await remove().catch(() => undefined);
    cleanups.length = 0;
  };
  const base = options.base ?? process.env.ELECTRON_SMOKE_API ?? 'http://127.0.0.1:4000/api';
  const admin = options.admin ?? process.env.ELECTRON_SMOKE_ADMIN ?? 'admin';
  const adminPassword = options.adminPassword ?? process.env.ELECTRON_SMOKE_ADMIN_PASSWORD ?? 'admin123';
  const password = options.password ?? process.env.ELECTRON_SMOKE_CLASS_PASSWORD ?? 'smoke123456';
  const className = options.className ?? '冒烟验证班';
  const code = `SMOKE${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  const todayKey = () => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
      now.getDate(),
    ).padStart(2, '0')}`;
  };

  try {
    const login = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: admin, password: adminPassword }),
    }).then((response) => response.json());
    const token = login?.data?.token;
    if (!token) return null;
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    const teacherUsername = `smoke_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const teacherPassword = 'smoke-test-password';
    const teacher = await fetch(`${base}/teachers`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        username: teacherUsername,
        password: teacherPassword,
        name: '冒烟验证老师',
        role: 'TEACHER',
      }),
    }).then((response) => response.json());
    const teacherId = teacher?.data?.id;
    if (!teacherId) throw new Error('无法创建独立验证教师');
    cleanups.push(() => fetch(`${base}/teachers/${teacherId}`, { method: 'DELETE', headers }));

    const created = await fetch(`${base}/classes`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: className,
        grade: '验证',
        code,
        teacherId,
        enrollmentYear: 2099,
        classIndex: 1 + Math.floor(Math.random() * 99),
      }),
    }).then((response) => response.json());
    const classId = created?.data?.id;
    if (!classId) throw new Error('无法创建独立验证班级');
    cleanups.push(() => fetch(`${base}/classes/${classId}`, { method: 'DELETE', headers }));

    await fetch(`${base}/classes/${classId}/class-account`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ code, password }),
    });
    const course = await fetch(`${base}/courses`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ classId, name: '语文', teacherId }),
    }).then((response) => response.json());
    const courseId = course?.data?.id;
    if (!courseId) throw new Error('无法创建验证课程');
    const student = await fetch(`${base}/students`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ classId, studentNo: code, name: '冒烟验证同学' }),
    }).then((response) => response.json());
    const studentId = student?.data?.id;
    if (!studentId) throw new Error('无法创建验证学生');
    for (const [route, body] of [
      ['/grades', { classId, courseId, studentId, examName: '冒烟验证', score: 80, totalScore: 100 }],
      [
        '/schedules',
        {
          classId,
          courseId,
          dayOfWeek: new Date().getDay() || 7,
          startTime: '08:00',
          endTime: '08:45',
          weekStart: 1,
          weekEnd: 20,
        },
      ],
    ]) {
      const response = await fetch(`${base}${route}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`无法创建验证数据：${route}`);
    }
    // 图表回归需要不同科目的得分率及不同人数的等级分布。
    for (const [name, score] of [
      ['英语', 80],
      ['历史', 40],
    ]) {
      const extra = await fetch(`${base}/courses`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ classId, name, teacherId }),
      }).then((response) => response.json());
      if (!extra?.data?.id) throw new Error('无法创建图表验证课程');
      const response = await fetch(`${base}/grades`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          classId,
          courseId: extra.data.id,
          studentId,
          examName: '冒烟验证',
          score,
          totalScore: 100,
        }),
      });
      if (!response.ok) throw new Error('无法创建图表验证成绩');
    }

    // 作业看板用例需要"某天有作业"：临时班没有种子数据，这里补一条当天的
    await fetch(`${base}/homeworks`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        classId,
        title: '冒烟看板作业',
        content: '自动化验证用作业（随临时班级一起删除）。',
        assignDate: todayKey(),
      }),
    }).catch(() => undefined);

    return {
      code,
      password,
      classId,
      className,
      teacherUsername,
      teacherPassword,
      /** 收尾：删掉临时班级（连带它的班级账号/作业/通知） */
      cleanup,
    };
  } catch {
    await cleanup();
    return null;
  }
}
