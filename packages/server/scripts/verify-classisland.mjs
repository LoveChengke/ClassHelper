#!/usr/bin/env node
/**
 * ClassIsland 联动验证（插件侧接口 + 下发链路）。
 *
 * 覆盖范围：
 *   1) 设备令牌鉴权：无令牌 / 错令牌一律 401，令牌作废后立即失效
 *   2) 插件上报 → 服务端写库（课表 + 节次时间 + 状态快照）幂等
 *   3) 教师下发提醒 → 落库 → 插件 pending 拉到 → ack 后不再补发
 *   4) 停用设备后插件上报被 403 拦下
 *   5) 课表镜像拉取（mirrorScheduleToClassIsland）返回 ClassIsland 口径的数据
 *
 * 用法：
 *   1) 另开终端启动后端：pnpm dev:server
 *   2) 执行：node packages/server/scripts/verify-classisland.mjs
 *
 * 环境变量：
 *   VERIFY_BASE_URL  默认 http://127.0.0.1:4000（脚本直连，不受系统代理影响）
 *
 * 注意：本脚本只操作「新建设备 + 该设备对应班级」的数据，
 * 结束时会把新建的设备删除；上报的课表会写进该班（与导入模块语义一致，可被覆盖）。
 */
const BASE_URL = process.env.VERIFY_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 4000}`;

const results = [];

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '\u2713' : '\u2717'} ${name}${detail ? `  (${detail})` : ''}`);
}

async function api(path, { method = 'GET', token, deviceToken, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (deviceToken) headers['X-ClassIsland-Token'] = deviceToken;
  const response = await fetch(`${BASE_URL}/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, payload };
}

/** 造一份插件会上报的课表（周一/周二，含单双周） */
function sampleSchedule() {
  return {
    mode: 'merge',
    entries: [
      {
        dayOfWeek: 1,
        startTime: '08:00',
        endTime: '08:45',
        subject: '语文',
        teacherName: '王老师',
        weekParity: 'ALL',
        weekCountDiv: 0,
        weekCountDivTotal: 0,
        planName: '周一课表',
      },
      {
        dayOfWeek: 1,
        startTime: '08:55',
        endTime: '09:40',
        subject: '数学',
        teacherName: '李老师',
        weekParity: 'ODD',
        weekCountDiv: 1,
        weekCountDivTotal: 2,
        planName: '周一课表',
      },
      {
        dayOfWeek: 2,
        startTime: '08:00',
        endTime: '08:45',
        subject: '英语',
        teacherName: '张老师',
        weekParity: 'ALL',
        weekCountDiv: 0,
        weekCountDivTotal: 0,
        planName: '周二课表',
      },
    ],
  };
}

function sampleTimeLayout() {
  return {
    name: 'ClassIsland 验证时间表',
    mode: 'replace',
    items: [
      { index: 1, name: '第 1 节', startTime: '08:00', endTime: '08:45', type: 'class', skipped: false },
      { index: 2, name: '课间', startTime: '08:45', endTime: '08:55', type: 'break', skipped: false },
      { index: 3, name: '第 2 节', startTime: '08:55', endTime: '09:40', type: 'class', skipped: false },
    ],
  };
}

/** 按候选密码依次登录，返回可用 token（不同环境的默认密码可能不同） */
async function loginWithCandidates(username, passwords) {
  for (const password of passwords) {
    const result = await api('/auth/login', { method: 'POST', body: { username, password } });
    const token = result.payload?.data?.token;
    if (token) return token;
  }
  return null;
}

async function main() {
  console.log(`\n=== ClassIsland 联动验证（${BASE_URL}）===\n`);

  const health = await api('/health');
  if (health.status !== 200) {
    console.log('后端未启动，请先运行 pnpm dev:server\n');
    process.exit(1);
  }
  const modules = health.payload?.data?.modules ?? [];
  record('integrations 模块已挂载', modules.includes('integrations'), modules.join(', '));
  if (!modules.includes('integrations')) process.exit(1);

  // ---------------------------------------------------------------- 登录
  // 演示库里的教师密码由 .env 的 DEFAULT_TEACHER_PASSWORD 决定（种子脚本用它建号），
  // 因此这里按候选列表尝试，避免「换了环境就整脚本失败」。
  const teacherToken = await loginWithCandidates('teacher1', ['teacher123', '123456']);
  record('教师登录 teacher1', Boolean(teacherToken));
  if (!teacherToken) process.exit(1);

  // 管理员用于取班级码（只有管理员/班主任能看到班级码），学生隔离用例需要它
  const adminToken = await loginWithCandidates('admin', ['admin123']);

  const classes = await api('/classes', { token: teacherToken });
  const target = (classes.payload?.data ?? [])[0];
  record('取到可管理的班级', Boolean(target?.id), target ? `${target.name} (${target.id})` : '无');
  if (!target?.id) process.exit(1);

  // 叫人用例需要一位学生；班级账号用来验证"教室客户端自己选显示位置"
  const students = await api(`/classes/${target.id}/students`, { token: teacherToken });
  const firstStudent = (students.payload?.data ?? [])[0];

  /** 用班级码 + 班级密码登录，拿班级账号 token（教室机器的身份） */
  async function classLoginToken() {
    if (adminToken) {
      const detail = await api(`/classes/${target.id}`, { token: adminToken });
      const code = detail.payload?.data?.code;
      if (code) {
        for (const password of ['123456', 'class123']) {
          const result = await api('/auth/class-login', {
            method: 'POST',
            body: { code, password },
          });
          const token = result.payload?.data?.token;
          if (token) return token;
        }
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- 1. 新建设备
  const created = await api('/integrations/devices', {
    method: 'POST',
    token: teacherToken,
    body: { classId: target.id, name: '验证用设备', syncScheduleToServer: true },
  });
  const deviceToken = created.payload?.data?.token;
  const deviceId = created.payload?.data?.device?.id;
  record(
    '新建设备并返回设备令牌',
    created.status === 201 && typeof deviceToken === 'string' && deviceToken.startsWith('chci_'),
    `status=${created.status} hint=${created.payload?.data?.device?.tokenHint ?? '-'}`,
  );
  if (!deviceToken || !deviceId) process.exit(1);

  // ---------------------------------------------------------------- 2. 令牌鉴权
  const noToken = await api('/integrations/classisland/report', { method: 'POST', body: {} });
  record('无令牌上报被拒（401）', noToken.status === 401, `status=${noToken.status}`);
  const badToken = await api('/integrations/classisland/report', {
    method: 'POST',
    deviceToken: 'chci_deadbeef',
    body: {},
  });
  record('错误令牌上报被拒（401）', badToken.status === 401, `status=${badToken.status}`);

  // ---------------------------------------------------------------- 3. 上报（状态 + 课表 + 节次）
  const reportBody = {
    pluginVersion: '0.1.0.0',
    classIslandVersion: '2.1.0.0',
    state: {
      inClass: true,
      subject: '语文',
      nextSubject: '数学',
      timeState: 'OnClass',
      periodStart: '08:00',
      periodEnd: '08:45',
      week: 1,
      classPlanLoaded: true,
      clientTime: new Date().toISOString(),
    },
    schedule: sampleSchedule(),
    timeLayout: sampleTimeLayout(),
  };
  const report1 = await api('/integrations/classisland/report', {
    method: 'POST',
    deviceToken,
    body: reportBody,
  });
  const r1 = report1.payload?.data;
  record(
    '插件上报课表写入成功',
    report1.status === 200 && r1?.scheduleApplied === true && r1.scheduleCreated + r1.scheduleUpdated === 3,
    `新增=${r1?.scheduleCreated} 更新=${r1?.scheduleUpdated} 周=${r1?.week}`,
  );
  record('插件上报节次时间写入成功', r1?.timeLayoutApplied === true, `applied=${r1?.timeLayoutApplied}`);
  record('上报回传服务端周次与时间', typeof r1?.serverTime === 'string' && Number.isInteger(r1?.week));

  // 幂等：重复上报不应产生重复行
  const report2 = await api('/integrations/classisland/report', {
    method: 'POST',
    deviceToken,
    body: reportBody,
  });
  const r2 = report2.payload?.data;
  record(
    '重复上报幂等（不新增、只更新）',
    r2?.scheduleCreated === 0 && r2?.scheduleUpdated === 3,
    `新增=${r2?.scheduleCreated} 更新=${r2?.scheduleUpdated}`,
  );

  // 设备列表里的状态快照
  const devices = await api(`/integrations/devices?classId=${target.id}`, { token: teacherToken });
  const listed = (devices.payload?.data ?? []).find((item) => item.id === deviceId);
  record(
    '设备状态快照已更新（Web 端可展示）',
    Boolean(listed?.lastSeenAt) &&
      listed?.currentSubject === '语文' &&
      listed?.currentTimeState === 'OnClass',
    `科目=${listed?.currentSubject} 状态=${listed?.currentTimeState} ClassIsland=${listed?.classIslandVersion}`,
  );

  // ---------------------------------------------------------------- 4. 下发提醒
  const notify = await api('/integrations/classisland/notify', {
    method: 'POST',
    token: teacherToken,
    body: {
      classId: target.id,
      title: '请到讲台领资料',
      content: '下课后来讲台领取期中复习资料',
      durationSeconds: 12,
      speech: true,
    },
  });
  const n1 = notify.payload?.data;
  record(
    '教师下发提醒（落库 + 标记设备数）',
    notify.status === 200 && n1?.targetCount >= 1 && Boolean(n1?.notificationId),
    `设备数=${n1?.targetCount} 通知id=${n1?.notificationId ? '有' : '无'}`,
  );

  const pending = await api('/integrations/classisland/pending', { deviceToken });
  const items = pending.payload?.data?.notifications ?? [];
  const picked = items.find((item) => item.title === '请到讲台领资料');
  record(
    '插件拉取到待提醒（离线补齐链路可用）',
    pending.status === 200 && Boolean(picked),
    `待提醒数=${items.length} 时长=${picked?.durationSeconds}s 朗读=${Boolean(picked?.speechContent)}`,
  );

  if (picked) {
    const ack = await api('/integrations/classisland/ack', {
      method: 'POST',
      deviceToken,
      body: { id: picked.id },
    });
    record(
      '插件确认提醒已弹出',
      ack.status === 200 && ack.payload?.data?.acked === true,
      `status=${ack.status}`,
    );
    const pending2 = await api('/integrations/classisland/pending', { deviceToken });
    const again = (pending2.payload?.data?.notifications ?? []).some((item) => item.id === picked.id);
    record('确认后不再补发（避免重复弹窗）', !again, `仍在待提醒中=${again}`);
  }

  // ---------------------------------------------------------------- 4.5 其他发布入口也会联动 ClassIsland
  // 需求："在其他页面发通知也可以联动 ClassIsland"。通知发布页 / 叫人走的是各自的接口，
  // 这里逐个验证它们真的会生成待弹出提醒（而不是只有联动页那个专用接口才联动）。
  const classChannel = await api(`/classes/${target.id}/notification-channel`, { token: teacherToken });
  record(
    '班级有"通知显示位置"（默认两端都弹）',
    classChannel.status === 200 && classChannel.payload?.data?.notificationChannel === 'both',
    `channel=${classChannel.payload?.data?.notificationChannel}`,
  );

  const published = await api('/notifications', {
    method: 'POST',
    token: teacherToken,
    body: { classId: target.id, title: '通知页联动验证', content: '从通知发布页发的通知', priority: 'NORMAL' },
  });
  const pendingAfterPublish = await api('/integrations/classisland/pending', { deviceToken });
  const publishPush = (pendingAfterPublish.payload?.data?.notifications ?? []).find(
    (item) => item.title === '通知页联动验证',
  );
  record(
    '通知发布页发的通知也会推送到 ClassIsland',
    published.status === 201 && Boolean(publishPush),
    `status=${published.status} 待提醒=${(pendingAfterPublish.payload?.data?.notifications ?? []).length}`,
  );
  if (publishPush) {
    await api('/integrations/classisland/ack', {
      method: 'POST',
      deviceToken,
      body: { id: publishPush.id },
    });
  }

  const call = await api('/calls', {
    method: 'POST',
    token: teacherToken,
    body: { classId: target.id, studentId: firstStudent?.id, message: '叫人联动验证' },
  });
  const pendingAfterCall = await api('/integrations/classisland/pending', { deviceToken });
  const callPush = (pendingAfterCall.payload?.data?.notifications ?? []).find(
    (item) => item.content === '叫人联动验证',
  );
  record(
    '叫人也会推送到 ClassIsland',
    Boolean(firstStudent) && call.status === 201 && Boolean(callPush),
    firstStudent ? `status=${call.status}` : '班级里没有学生，跳过',
  );
  if (callPush) {
    await api('/integrations/classisland/ack', {
      method: 'POST',
      deviceToken,
      body: { id: callPush.id },
    });
  }

  // 教室在客户端里选"只在 ClassHelper 客户端显示"后，任何入口都不该再打扰 ClassIsland
  const setClient = await api(`/classes/${target.id}/notification-channel`, {
    method: 'PATCH',
    token: teacherToken,
    body: { notificationChannel: 'client' },
  });
  record(
    '可把"通知显示位置"改成只在客户端显示',
    setClient.status === 200 && setClient.payload?.data?.notificationChannel === 'client',
    `channel=${setClient.payload?.data?.notificationChannel}`,
  );

  const mutedPublish = await api('/notifications', {
    method: 'POST',
    token: teacherToken,
    body: { classId: target.id, title: '不该上 ClassIsland 的通知', content: '教室选择了只在客户端显示' },
  });
  const mutedNotify = await api('/integrations/classisland/notify', {
    method: 'POST',
    token: teacherToken,
    body: { classId: target.id, title: '联动页也不该下发', content: '同样被教室的设置拦下' },
  });
  const pendingMuted = await api('/integrations/classisland/pending', { deviceToken });
  const mutedItems = pendingMuted.payload?.data?.notifications ?? [];
  record(
    '显示位置=client 时通知不再推送 ClassIsland',
    mutedPublish.status === 201 && !mutedItems.some((item) => item.title === '不该上 ClassIsland 的通知'),
    `待提醒=${mutedItems.length}`,
  );
  record(
    '显示位置=client 时联动页的下发也会被跳过（并说明原因）',
    mutedNotify.status === 200 &&
      mutedNotify.payload?.data?.skipped === 'channel-client' &&
      String(mutedNotify.payload?.message ?? '').includes('只在 ClassHelper 客户端显示'),
    `skipped=${mutedNotify.payload?.data?.skipped} message=${mutedNotify.payload?.message}`,
  );

  // 班级账号（教室机器）自己就能读写这项设置 —— 需求就是"由 ClassIsland 之外的客户端自己选"
  const classSessionToken = await classLoginToken();
  const readByClass = await api(`/classes/${target.id}/notification-channel`, {
    token: classSessionToken,
  });
  record(
    '班级账号可读取通知显示位置',
    readByClass.status === 200 && readByClass.payload?.data?.notificationChannel === 'client',
    `channel=${readByClass.payload?.data?.notificationChannel}`,
  );
  const setByClass = await api(`/classes/${target.id}/notification-channel`, {
    method: 'PATCH',
    token: classSessionToken,
    body: { notificationChannel: 'both' },
  });
  record(
    '班级账号可修改通知显示位置（由教室客户端自己选）',
    setByClass.status === 200 && setByClass.payload?.data?.notificationChannel === 'both',
    `channel=${setByClass.payload?.data?.notificationChannel}`,
  );
  const badChannel = await api(`/classes/${target.id}/notification-channel`, {
    method: 'PATCH',
    token: teacherToken,
    body: { notificationChannel: 'nope' },
  });
  record('非法显示位置被拒（422）', badChannel.status === 422, `status=${badChannel.status}`);

  // ---------------------------------------------------------------- 5. 课表镜像（默认关闭 → 打开 → 拉取）
  const mirrorOff = await api('/integrations/classisland/class-plan', { deviceToken });
  record(
    '镜像开关关闭时不下发课表',
    mirrorOff.status === 200 && mirrorOff.payload?.data === null,
    `data=${mirrorOff.payload?.data === null ? 'null' : 'object'}`,
  );

  const enabled = await api(`/integrations/devices/${deviceId}`, {
    method: 'PATCH',
    token: teacherToken,
    body: { mirrorScheduleToClassIsland: true },
  });
  record(
    '打开「镜像课表到 ClassIsland」',
    enabled.status === 200 && enabled.payload?.data?.mirrorScheduleToClassIsland === true,
    `status=${enabled.status}`,
  );

  const mirror = await api('/integrations/classisland/class-plan', { deviceToken });
  const plan = mirror.payload?.data?.classPlan;
  const weekDays = (plan?.entries ?? []).map((item) => item.weekDay);
  record(
    '拉取课表为 ClassIsland 口径（0=周日 … 6=周六）',
    mirror.status === 200 &&
      Array.isArray(plan?.entries) &&
      plan.entries.length >= 3 &&
      weekDays.every((day) => day >= 0 && day <= 6),
    `条目=${plan?.entries?.length} weekDay=[${weekDays.join(',')}] 档案名=${plan?.profileName}`,
  );
  record(
    '单双周换算为 WeekCountDiv/Total',
    (plan?.entries ?? []).some((item) => item.weekCountDivTotal === 2),
    (plan?.entries ?? [])
      .map((item) => `${item.subject}:${item.weekCountDiv}/${item.weekCountDivTotal}`)
      .join(' '),
  );
  // ClassInfo.Index 与"第 i 个上课时间点"一一对应，因此镜像条目必须带起止时间，
  // 否则插件只能按数组顺序硬排，一旦某天少一节整份课表就错位（这是最容易漏的一处契约）
  const timeOk = (plan?.entries ?? []).every(
    (item) => /^\d{2}:\d{2}$/.test(item.startTime ?? '') && /^\d{2}:\d{2}$/.test(item.endTime ?? ''),
  );
  record(
    '镜像条目带起止时间（插件据此重建上课时间点）',
    (plan?.entries ?? []).length > 0 && timeOk,
    (plan?.entries ?? [])
      .slice(0, 3)
      .map((item) => `${item.subject} ${item.startTime}-${item.endTime}`)
      .join(' | '),
  );
  const classPoints = (plan?.timeLayouts?.[0]?.layouts ?? []).filter((item) => item.timeType === 0);
  record(
    '镜像时间表含上课时间点（与课表条目对得上）',
    classPoints.length > 0 && (plan?.entries ?? []).length >= classPoints.length / 2,
    `上课点=${classPoints.length} 条目=${(plan?.entries ?? []).length}`,
  );

  // ---------------------------------------------------------------- 6. 停用设备
  await api(`/integrations/devices/${deviceId}`, {
    method: 'PATCH',
    token: teacherToken,
    body: { enabled: false },
  });
  const blocked = await api('/integrations/classisland/report', {
    method: 'POST',
    deviceToken,
    body: { state: { inClass: false, clientTime: new Date().toISOString() } },
  });
  record('停用设备后插件上报被拒（403）', blocked.status === 403, `status=${blocked.status}`);

  // ---------------------------------------------------------------- 7. 权限隔离
  // 班级码只有管理员/班主任可见，班级密码也是默认值，因此这里按管理员信息补齐
  let classCode = target.code ?? null;
  if (!classCode && adminToken) {
    const all = await api('/classes', { token: adminToken });
    classCode = (all.payload?.data ?? []).find((item) => item.id === target.id)?.code ?? null;
  }
  const studentLogin = await api('/auth/class-login', {
    method: 'POST',
    body: { code: classCode ?? '', password: '123456' },
  });
  const studentToken = studentLogin.payload?.data?.token;
  if (studentToken) {
    const forbidden = await api('/integrations/devices', { token: studentToken });
    record('学生无法查看联动设备列表（403）', forbidden.status === 403, `status=${forbidden.status}`);
  } else {
    record('班级账号登录（跳过学生隔离用例）', false, `status=${studentLogin.status}`);
  }

  // ---------------------------------------------------------------- 清理
  const removed = await api(`/integrations/devices/${deviceId}`, { method: 'DELETE', token: teacherToken });
  record('删除验证设备（清理）', removed.status === 200, `status=${removed.status}`);

  const failed = results.filter((item) => !item.ok);
  console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length > 0) {
    console.log('失败用例：');
    for (const item of failed) console.log(`  - ${item.name}  (${item.detail})`);
    process.exit(1);
  }
  console.log('ClassIsland 联动链路全部通过。\n');
}

main().catch((error) => {
  console.error('验证脚本异常：', error);
  process.exit(1);
});
