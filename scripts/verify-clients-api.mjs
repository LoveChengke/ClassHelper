/** 针对独立测试服务验证默认权限、远控回执与更新时机；不运行系统指令。 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const base = process.env.VERIFY_BASE_URL ?? 'http://127.0.0.1:4199';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
async function api(route, token, body, method = body === undefined ? 'GET' : 'POST') {
  const res = await fetch(`${base}/api${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, ...(await res.json()) };
}
function check(name, value) {
  assert.ok(value, name);
  passed++;
  console.log(`✓ ${name}`);
}
const admin = (await api('/auth/login', null, { username: 'admin', password: 'admin123' })).data.token;
const teacher = (await api('/auth/login', null, { username: 'teacher1', password: 'teacher123' })).data.token;
const classLogin = await api('/auth/class-login', null, { code: 'G101', password: '123456' });
const classToken = classLogin.data.token;
const groups = (await api('/permissions/groups', admin)).data;
const teacherDefault = groups.find((g) => g.defaultRole === 'TEACHER');
const adminDefault = groups.find((g) => g.defaultRole === 'ADMIN');
const key = `api-regression-${Date.now()}`;
let deviceId, scheduleId, staffDeviceId;
const version = `99.0.0-regression-${Date.now()}`;
const releaseDir = path.join(root, 'packages/data/client-releases', version);
const releaseName = `ClassHelper-${version}-x64-client-setup.exe`;
try {
  check('角色默认组已创建且可以识别对应角色', teacherDefault && adminDefault);
  await api(`/permissions/groups/${teacherDefault.id}`, admin, { name: '回归教师默认组', keys: [] }, 'PATCH');
  let mine = await api('/permissions/me', teacher);
  check('未分组教师使用数据库默认组，空组真正收回权限', mine.data.permissions.length === 0);
  check('默认组收权后路由实时拒绝', (await api('/clients/devices', teacher)).status === 403);
  await api(
    `/permissions/groups/${teacherDefault.id}`,
    admin,
    { keys: ['client:read', 'client:manage', 'client:update-push', 'remote:control', 'class:read'] },
    'PATCH',
  );
  mine = await api('/permissions/me', teacher);
  check('默认组改名后继续生效，可赋予远控与推送权限', mine.data.permissions.includes('remote:control'));
  check('拥有推送权限的教师可读取安装包列表', (await api('/update/client/releases', teacher)).status === 200);
  await api(`/permissions/groups/${adminDefault.id}`, admin, { keys: [] }, 'PATCH');
  mine = await api('/permissions/me', admin);
  check(
    '管理员默认组可收权，保留两个防锁死入口',
    mine.data.permissions.length === 2 &&
      mine.data.permissions.includes('permission:manage') &&
      mine.data.permissions.includes('system:manage'),
  );
  await api(`/permissions/groups/${adminDefault.id}`, admin, { keys: adminDefault.keys }, 'PATCH');

  const beat = await api('/clients/heartbeat', classToken, {
    agentProtocol: 2,
    deviceKey: key,
    name: '回归设备',
    clientVersion: '1.0.0',
    platform: 'win32-x64',
    autoUpdate: false,
  });
  deviceId = beat.data.deviceId;
  check('班级端心跳返回统一响应与设备编号', beat.success && deviceId);
  let devices = (await api('/clients/devices', admin)).data;
  check(
    '设备是否接受自动更新与客户端真实配置一致',
    devices.find((d) => d.id === deviceId)?.autoUpdate === false,
  );
  const cmd = await api('/clients/commands', admin, {
    deviceIds: [deviceId],
    kind: 'lock',
    note: '回归，不执行真实锁屏',
  });
  check('指令成功入队', cmd.data.succeeded === 1);
  const received = (await api('/clients/heartbeat', classToken, { agentProtocol: 2, deviceKey: key })).data;
  check('下次心跳带回待执行指令', received.command?.kind === 'lock');
  const legacy = await api('/clients/heartbeat', classToken, { deviceKey: key });
  check(
    '兼容旧客户端读取顶层指令',
    legacy.command?.id === received.command.id && legacy.data.command.id === legacy.command.id,
  );
  const wrong = await api(`/clients/commands/${received.command.id}/ack`, classToken, {
    deviceKey: 'wrong-device-key',
    ok: true,
  });
  check('回执拒绝其他设备身份', wrong.status === 403);
  await api(`/clients/commands/${received.command.id}/ack`, classToken, {
    agentProtocol: 2,
    deviceKey: key,
    ok: false,
    result: '模拟系统拒绝',
  });
  await api(`/clients/commands/${received.command.id}/ack`, classToken, {
    agentProtocol: 2,
    deviceKey: key,
    ok: true,
    result: '不应覆盖',
  });
  devices = (await api('/clients/devices', admin)).data;
  check(
    '回执幂等并在设备页保留失败原因',
    devices.find((d) => d.id === deviceId)?.lastCommand?.result.includes('模拟系统拒绝'),
  );

  fs.mkdirSync(releaseDir, { recursive: true });
  fs.writeFileSync(path.join(releaseDir, releaseName), '用于下载校验的测试载荷，不是安装器');
  const registered = await api('/update/client/releases', admin, { version, fileName: releaseName });
  check('本地缓存安装包可登记', registered.status === 201);
  staffDeviceId = (await api('/clients/heartbeat', admin, { agentProtocol: 2, deviceKey: `${key}-staff` }))
    .data.deviceId;
  const deniedCommand = await api('/clients/commands', teacher, { deviceIds: [staffDeviceId], kind: 'lock' });
  check(
    '教师获远控权限后仍不能操作班级范围外设备',
    deniedCommand.data.failed === 1 && deniedCommand.data.succeeded === 0,
  );
  check(
    '教师获更新权限后不能越过班级范围推送',
    (await api('/clients/updates', teacher, { deviceIds: [staffDeviceId], version, mode: 'immediate' }))
      .status === 400,
  );
  check(
    '教师获设备管理权限后不能删除范围外设备',
    (await api(`/clients/devices/${staffDeviceId}`, teacher, undefined, 'DELETE')).status === 404,
  );
  let pushed = await api('/clients/updates', teacher, {
    deviceIds: [deviceId],
    version,
    mode: 'after-school',
    afterSchoolTime: '23:45',
  });
  check('教师获授权后可推送放学后更新', pushed.status === 200);
  let scheduled = (await api('/clients/heartbeat', classToken, { agentProtocol: 2, deviceKey: key })).data;
  check(
    '更新策略与下载信息随心跳返回',
    scheduled.updateMode === 'after-school' &&
      scheduled.update?.sha256?.length === 64 &&
      new Date(scheduled.updateNotBefore).getHours() === 23,
  );
  const legacyScheduled = await api('/clients/heartbeat', classToken, { deviceKey: key });
  const downloaded = await fetch(`${base}${scheduled.update.url}`, {
    headers: { authorization: `Bearer ${classToken}` },
  });
  const downloadedBytes = Buffer.from(await downloaded.arrayBuffer());
  check(
    '班级端可下载安装包，文件长度与 SHA256 匹配',
    downloaded.ok &&
      downloadedBytes.length === scheduled.update.size &&
      crypto.createHash('sha256').update(downloadedBytes).digest('hex') === scheduled.update.sha256,
  );
  check(
    '旧客户端放学前不拿到安装包',
    Date.now() >= Date.parse(scheduled.updateNotBefore) || legacyScheduled.update === null,
  );
  await api('/clients/updates', admin, { deviceIds: [deviceId], version, mode: 'immediate' });
  scheduled = (await api('/clients/heartbeat', classToken, { agentProtocol: 2, deviceKey: key })).data;
  check(
    '同一版本可从延后改成立即安装',
    scheduled.updateMode === 'immediate' && scheduled.updateNotBefore === null,
  );
  check(
    '非法放学时间被拒绝',
    (
      await api('/clients/updates', admin, {
        deviceIds: [deviceId],
        version,
        mode: 'after-school',
        afterSchoolTime: '29:99',
      })
    ).status === 422,
  );
  const testClassId = classLogin.data.user.classId;
  const courses = (await api(`/courses?classId=${testClassId}`, admin)).data;
  const schedule = await api('/schedules', admin, {
    classId: testClassId,
    courseId: courses[0].id,
    dayOfWeek: new Date().getDay() || 7,
    startTime: '23:58',
    endTime: '23:59',
    weekStart: 1,
    weekEnd: 20,
  });
  scheduleId = schedule.data?.id;
  check('创建放学时间回归课表', schedule.status === 201 && scheduleId);
  await api('/clients/updates', admin, {
    all: true,
    version,
    mode: 'after-school',
    afterSchoolTime: '00:01',
  });
  const allScheduled = (await api('/clients/heartbeat', classToken, { agentProtocol: 2, deviceKey: key }))
    .data;
  check(
    '全部设备推送仍按各班当天最后一节课计算放学时间',
    new Date(allScheduled.updateNotBefore).getHours() === 23 &&
      new Date(allScheduled.updateNotBefore).getMinutes() === 59,
  );
  await api('/clients/updates', admin, { deviceIds: [deviceId], clear: true });
  scheduled = (await api('/clients/heartbeat', classToken, { agentProtocol: 2, deviceKey: key })).data;
  check(
    '取消推送会清除目标版本与时间',
    scheduled.updateTargetVersion === null && scheduled.updateNotBefore === null && scheduled.update === null,
  );
  check('退役联动接口返回 404', (await api('/integrations/classisland/status', admin)).status === 404);
  check(
    '退役通知渠道接口返回 404',
    (await api(`/classes/${classLogin.data.user.classId}/notification-channel`, classToken)).status === 404,
  );
} finally {
  await api(
    `/permissions/groups/${adminDefault.id}`,
    admin,
    { name: adminDefault.name, keys: adminDefault.keys },
    'PATCH',
  );
  await api(
    `/permissions/groups/${teacherDefault.id}`,
    admin,
    { name: teacherDefault.name, keys: teacherDefault.keys },
    'PATCH',
  );
  if (deviceId) await api(`/clients/devices/${deviceId}`, admin, undefined, 'DELETE');
  if (staffDeviceId) await api(`/clients/devices/${staffDeviceId}`, admin, undefined, 'DELETE');
  if (scheduleId) await api(`/schedules/${scheduleId}`, admin, undefined, 'DELETE');
  await api(`/update/client/releases/${version}`, admin, undefined, 'DELETE');
  fs.rmSync(releaseDir, { recursive: true, force: true });
}
console.log(`客户端 API 回归：${passed}/${passed} 项通过`);
