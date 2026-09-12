/**
 * UI 冒烟测试用「真实上课时段探针」。
 *
 * 为了验证「上课时段发布紧急通知 → 全屏警告 + 3 秒倒计时」这条链路，
 * 测试必须先让服务端真实认定"现在正在上课"。本模块直接用 HTTP 调后端接口：
 *
 *   1. 登录（拿到 token）
 *   2. 取该教师第一个班级 + 该班级第一门课程
 *   3. 新建一条"今天 00:00-23:59、第 1-30 教学周"的课表 —— 覆盖当前时刻
 *   4. 调 /api/schedules/current 确认服务端确实返回 inClass = true
 *
 * 测试结束后 cleanup 会删除这条探针课表，并删除本次测试发布的通知，
 * 保证不污染演示数据。
 *
 * 注意：这里只使用 Node 内置 fetch（Node 20+），不引入额外依赖。
 */

const DEFAULT_TIMEOUT_MS = 10_000;

async function call(baseUrl, path, { method = 'GET', token, body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { raw: text.slice(0, 200) };
    }
    return { status: response.status, payload };
  } finally {
    clearTimeout(timer);
  }
}

/** 今天对应的课表星期（1=周一 … 7=周日） */
function todayDayOfWeek(now = new Date()) {
  const weekday = now.getDay();
  return weekday === 0 ? 7 : weekday;
}

/**
 * 制造一次真实的上课时段。
 * @returns {Promise<{token: string, classId: string, className: string, courseId: string,
 *   scheduleId: string, inClass: boolean, period: object|null}>}
 */
export async function setupInClassProbe({ baseUrl, username = 'teacher1', password = 'teacher123' } = {}) {
  const base = (baseUrl ?? 'http://127.0.0.1:4000').replace(/\/$/, '');

  const login = await call(base, '/api/auth/login', {
    method: 'POST',
    body: { username, password },
  });
  const token = login.payload?.data?.token;
  if (login.status !== 200 || !token) {
    throw new Error(`探针登录失败：HTTP ${login.status} ${JSON.stringify(login.payload)?.slice(0, 160)}`);
  }

  const classes = await call(base, '/api/classes', { token });
  const targetClass = Array.isArray(classes.payload?.data) ? classes.payload.data[0] : null;
  if (!targetClass) throw new Error('探针失败：该教师名下没有班级，无法制造上课时段');

  const courses = await call(base, `/api/courses?classId=${encodeURIComponent(targetClass.id)}`, {
    token,
  });
  const targetCourse = Array.isArray(courses.payload?.data) ? courses.payload.data[0] : null;
  if (!targetCourse) throw new Error(`探针失败：班级「${targetClass.name}」没有课程，无法制造上课时段`);

  const schedule = await call(base, '/api/schedules', {
    method: 'POST',
    token,
    body: {
      classId: targetClass.id,
      courseId: targetCourse.id,
      dayOfWeek: todayDayOfWeek(),
      startTime: '00:00',
      endTime: '23:59',
      weekStart: 1,
      weekEnd: 30,
      location: 'UI 冒烟探针',
    },
  });
  const scheduleId = schedule.payload?.data?.id;
  if (schedule.status !== 201 || !scheduleId) {
    throw new Error(
      `探针失败：创建课表返回 HTTP ${schedule.status} ${JSON.stringify(schedule.payload)?.slice(0, 200)}`,
    );
  }

  const status = await call(base, `/api/schedules/current?classId=${encodeURIComponent(targetClass.id)}`, {
    token,
  });

  return {
    baseUrl: base,
    token,
    classId: targetClass.id,
    className: targetClass.name,
    courseId: targetCourse.id,
    scheduleId,
    inClass: Boolean(status.payload?.data?.inClass),
    period: status.payload?.data?.current ?? null,
    statusCode: status.status,
  };
}

/** 删除探针课表 + 本次测试发布的通知，恢复原始数据 */
export async function cleanupInClassProbe(probe, { notificationTitle } = {}) {
  const removed = [];
  if (!probe?.baseUrl || !probe?.token) return removed;

  if (notificationTitle) {
    const list = await call(
      probe.baseUrl,
      `/api/notifications?classId=${encodeURIComponent(probe.classId)}&keyword=${encodeURIComponent(notificationTitle)}`,
      { token: probe.token },
    );
    const matched = Array.isArray(list.payload?.data)
      ? list.payload.data.filter((item) => item.title === notificationTitle)
      : [];
    for (const item of matched) {
      const result = await call(probe.baseUrl, `/api/notifications/${item.id}`, {
        method: 'DELETE',
        token: probe.token,
      });
      if (result.status === 200) removed.push(`notification:${item.id}`);
    }
  }

  if (probe.scheduleId) {
    const result = await call(probe.baseUrl, `/api/schedules/${probe.scheduleId}`, {
      method: 'DELETE',
      token: probe.token,
    });
    if (result.status === 200) removed.push(`schedule:${probe.scheduleId}`);
  }

  return removed;
}
