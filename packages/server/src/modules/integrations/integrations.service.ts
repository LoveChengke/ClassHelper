import {
  CLASS_HELPER_ONLINE_WINDOW_MS,
  SOCKET_EVENTS,
  weekDivFromParity,
  type ClassDto,
  type ClassHelperDeviceStatusDto,
  type ClassHelperStatusListDto,
  type ClassIslandPendingResult,
  type ClassIslandPushNotification,
  type ClassIslandReportResult,
  type ClassIslandScheduleEntry,
  type IntegrationDeviceDto,
  type IntegrationDeviceTokenDto,
  type SendClassIslandNotificationResult,
  type TimeLayoutEntry,
  type NotificationDto,
} from '@classhelper/shared';
import { assertCanManageSchedule, assertCanPublishNotification, resolveClassScope } from '../../lib/access.js';
import { loadTermContext, resolveCurrentWeek } from '../../lib/term.js';
import { prisma } from '../../lib/db.js';
import { ApiError } from '../../lib/http.js';
import type { TokenPayload } from '../../lib/jwt.js';
import { logger } from '../../lib/logger.js';
import { toNotificationChannel, toNotificationDto } from '../../lib/mappers.js';
import { emitToClass, emitToRooms } from '../../realtime/bus.js';
import { SOCKET_ROOMS } from '@classhelper/shared';
import type { DeviceContext } from './device-auth.js';
import { generateDeviceToken, hashDeviceToken, tokenHintOf } from './device-auth.js';
import type {
  ClassIslandReportInput,
  CreateDeviceInput,
  SendNotificationInput,
  UpdateDeviceInput,
} from './integrations.schemas.js';
import { REPORT_DEFAULTS } from './integrations.schemas.js';
import {
  applyReportedSchedule,
  applyReportedTimeLayout,
  toClassIslandWeekDay,
  type MirrorClassPlan,
} from './write-back.service.js';

/**
 * ClassIsland 联动服务。
 *
 * 两条链路：
 * 1) **ClassHelper → ClassIsland**：教师发通知 → 落库 + Socket.IO 广播 →
 *    教室机器上的插件弹出全屏提醒（离线时先落库，插件重连后拉取补发）；
 * 2) **ClassIsland → ClassHelper**：插件把"当前上什么课 + 全量课表"上报 →
 *    本服务按设备令牌解析出所属班级并写库 → 广播 `classisland:state` 给 Web 端实时展示。
 *
 * 权限口径：
 * - 设备管理（创建/重置令牌/启停）：与"课表管理"一致（管理员或本班班主任）；
 * - 下发提醒：与"发通知"一致（管理员 / 班主任 / 科任老师）。
 */

/* ------------------------------------------------------------------ 设备管理（Web 端，JWT 鉴权） */

/**
 * 设备记录 -> DTO（tokenHash 永不出库）。
 *
 * `online` 由**最后一次心跳**（`lastHeartbeatAt`）与共享的
 * `CLASS_HELPER_ONLINE_WINDOW_MS`（60 秒）算出，而不是最后一次带状态的上报 ——
 * 插件每 60 秒打一次心跳，因此"最近一分钟内有心跳"才是最贴合的口径。
 */
function toDeviceDto(record: {
  id: string;
  classId: string;
  name: string;
  deviceKey: string;
  mode: string;
  enabled: boolean;
  syncScheduleToServer: boolean;
  mirrorScheduleToClassIsland: boolean;
  requestScheduleReport: boolean;
  classIslandVersion: string | null;
  pluginVersion: string | null;
  lastSeenAt: Date | null;
  lastHeartbeatAt: Date | null;
  classPlanLoaded: boolean;
  currentSubject: string | null;
  currentTimeState: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  nextSubject: string | null;
  tokenHint: string;
  createdAt: Date;
  updatedAt: Date;
  class?: { name: string } | null;
}): IntegrationDeviceDto {
  const heartbeat = record.lastHeartbeatAt ?? record.lastSeenAt;
  return {
    id: record.id,
    classId: record.classId,
    className: record.class?.name ?? null,
    name: record.name,
    deviceKey: record.deviceKey,
    mode: record.mode === 'import' ? 'import' : 'plugin',
    enabled: record.enabled,
    syncScheduleToServer: record.syncScheduleToServer,
    mirrorScheduleToClassIsland: record.mirrorScheduleToClassIsland,
    requestScheduleReport: record.requestScheduleReport,
    classIslandVersion: record.classIslandVersion,
    pluginVersion: record.pluginVersion,
    lastSeenAt: record.lastSeenAt ? record.lastSeenAt.toISOString() : null,
    lastHeartbeatAt: heartbeat ? heartbeat.toISOString() : null,
    online: Boolean(record.enabled && heartbeat && Date.now() - heartbeat.getTime() < CLASS_HELPER_ONLINE_WINDOW_MS),
    classPlanLoaded: record.classPlanLoaded,
    currentSubject: record.currentSubject,
    currentTimeState: record.currentTimeState,
    currentPeriodStart: record.currentPeriodStart,
    currentPeriodEnd: record.currentPeriodEnd,
    nextSubject: record.nextSubject,
    tokenHint: record.tokenHint,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/**
 * GET /api/integrations/classisland/status —— **ClassHelper 班级端在线状态**（教师网页）。
 *
 * 范围：管理员看全部班级，普通教师看自己担任班主任的班级 ∪ 任课（有 Course）的班级。
 * 这是「教师网页可查看班级 ClassHelper 在线状态」这条需求的落点。
 */
export async function listClassHelperStatus(user: TokenPayload): Promise<ClassHelperStatusListDto> {
  const scope = await resolveClassScope(user);
  const classes = await prisma.class.findMany({
    where: {
      ...(scope.mode === 'all' ? {} : { id: { in: scope.classIds } }),
      // 归档班级的班级端已经停用，不列出来
      archivedYearId: null,
    },
    orderBy: [{ enrollmentYear: 'desc' }, { classIndex: 'asc' }],
    select: {
      id: true,
      name: true,
      grade: true,
      studentGradeQueryEnabled: true,
      integrationDevices: {
        where: { mode: 'plugin' },
        orderBy: [{ lastHeartbeatAt: 'desc' }],
        select: {
          id: true,
          name: true,
          deviceKey: true,
          enabled: true,
          lastSeenAt: true,
          lastHeartbeatAt: true,
          pluginVersion: true,
          classIslandVersion: true,
        },
      },
    },
  });

  const now = Date.now();
  return {
    serverTime: new Date().toISOString(),
    onlineWindowMs: CLASS_HELPER_ONLINE_WINDOW_MS,
    classes: classes.map((item) => {
      const devices: ClassHelperDeviceStatusDto[] = item.integrationDevices.map((device) => {
        const heartbeat = device.lastHeartbeatAt ?? device.lastSeenAt;
        return {
          deviceId: device.id,
          deviceName: device.name,
          deviceKey: device.deviceKey,
          enabled: device.enabled,
          online: Boolean(device.enabled && heartbeat && now - heartbeat.getTime() < CLASS_HELPER_ONLINE_WINDOW_MS),
          lastSeenAt: device.lastSeenAt ? device.lastSeenAt.toISOString() : null,
          lastHeartbeatAt: heartbeat ? heartbeat.toISOString() : null,
          pluginVersion: device.pluginVersion,
          classIslandVersion: device.classIslandVersion,
        };
      });
      return {
        classId: item.id,
        className: item.name,
        grade: item.grade,
        devices,
        online: devices.some((device) => device.online),
        studentGradeQueryEnabled: item.studentGradeQueryEnabled ?? true,
      };
    }),
  };
}

export async function listDevices(user: TokenPayload, classId?: string): Promise<IntegrationDeviceDto[]> {
  // 管理员不传 classId 时看全部；教师只看自己可访问的班级
  const scope = await resolveClassScope(user, classId);
  const records = await prisma.integrationDevice.findMany({
    where: scope.mode === 'all' ? {} : { classId: { in: scope.classIds } },
    include: { class: { select: { name: true } } },
    orderBy: [{ classId: 'asc' }, { createdAt: 'asc' }],
  });
  return records.map(toDeviceDto);
}

/**
 * 新建设备：一次性返回明文令牌。
 * deviceKey 由插件上报的机器码决定，但创建时还不知道机器码，
 * 因此这里用随机值占位，插件首次上报时按 token 找到记录并回填真实机器码。
 */
export async function createDevice(
  user: TokenPayload,
  input: CreateDeviceInput,
): Promise<IntegrationDeviceTokenDto> {
  await assertCanManageSchedule(user, input.classId);
  const classRecord = await prisma.class.findUnique({
    where: { id: input.classId },
    select: { id: true, name: true },
  });
  if (!classRecord) throw ApiError.notFound('班级不存在');

  const token = generateDeviceToken();
  const created = await prisma.integrationDevice.create({
    data: {
      classId: input.classId,
      name: input.name?.trim() || `${classRecord.name} ClassHelper 班级端`,
      deviceKey: `pending-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      mode: input.mode ?? 'plugin',
      tokenHash: hashDeviceToken(token),
      tokenHint: tokenHintOf(token),
      // 同步方向（2026-10-06 起）：课表以服务端为准，**服务端 → 教室自动下发**；
      // 「把教室课表传上来」改成 Web 端的一次性人工动作，所以默认关掉自动回传。
      syncScheduleToServer: input.syncScheduleToServer === true,
      mirrorScheduleToClassIsland: input.mirrorScheduleToClassIsland !== false,
    },
    include: { class: { select: { name: true } } },
  });

  logger.info(`ClassIsland 联动设备已创建：班级=${classRecord.name} 设备=${created.name}`);
  return { device: toDeviceDto(created), token };
}

async function findDeviceOrFail(id: string): Promise<{
  id: string;
  classId: string;
  name: string;
  enabled: boolean;
}> {
  const record = await prisma.integrationDevice.findUnique({
    where: { id },
    select: { id: true, classId: true, name: true, enabled: true },
  });
  if (!record) throw ApiError.notFound('设备不存在或已被删除');
  return record;
}

export async function updateDevice(
  user: TokenPayload,
  deviceId: string,
  input: UpdateDeviceInput,
): Promise<IntegrationDeviceDto> {
  const current = await findDeviceOrFail(deviceId);
  await assertCanManageSchedule(user, current.classId);

  const updated = await prisma.integrationDevice.update({
    where: { id: deviceId },
    data: {
      ...(input.name !== undefined ? { name: input.name.trim() || current.name } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.mode !== undefined ? { mode: input.mode } : {}),
      ...(input.syncScheduleToServer !== undefined
        ? { syncScheduleToServer: input.syncScheduleToServer }
        : {}),
      ...(input.mirrorScheduleToClassIsland !== undefined
        ? { mirrorScheduleToClassIsland: input.mirrorScheduleToClassIsland }
        : {}),
    },
    include: { class: { select: { name: true } } },
  });
  logger.info(`ClassIsland 联动设备已更新：${updated.name} enabled=${updated.enabled}`);
  return toDeviceDto(updated);
}

/**
 * 「**从教室机器获取一次课表**」的待办（Web 端手动动作）。
 *
 * 为什么是"待办"而不是直接拉：课表由**插件主动上报**，服务端没有反向通道去催它。
 * 所以这里只置一个标记，插件在下一次上报（默认 60 秒一次的心跳）看到
 * `settings.scheduleRequested = true` 就立刻把当前课表推上来并完成待办。
 *
 * 它独立于 `syncScheduleToServer`：后者是"允许自动回传"，现在默认**关闭**
 * （自动回传会在老师手排课之后被教室的旧课表悄悄覆盖）；
 * 管理员显式点"获取课表"时仍然应当能取到一次。
 */
export async function requestScheduleReport(
  user: TokenPayload,
  deviceId: string,
): Promise<{ requested: boolean; deviceName: string; nextHeartbeatHint: string }> {
  const current = await findDeviceOrFail(deviceId);
  await assertCanManageSchedule(user, current.classId);
  if (!current.enabled) throw ApiError.badRequest('该设备已停用，请先启用后再获取课表');

  await prisma.integrationDevice.update({
    where: { id: deviceId },
    data: { requestScheduleReport: true },
  });
  logger.info(`已请求设备上报课表：${current.name}（classId=${current.classId}）由 ${user.name} 发起`);
  return {
    requested: true,
    deviceName: current.name,
    nextHeartbeatHint: '教室机器会在下一次心跳（约 1 分钟内）把当前课表上报上来',
  };
}

/** 重置令牌：旧令牌立即失效（插件侧需要重新填写） */
export async function resetDeviceToken(
  user: TokenPayload,
  deviceId: string,
): Promise<IntegrationDeviceTokenDto> {
  const current = await findDeviceOrFail(deviceId);
  await assertCanManageSchedule(user, current.classId);

  const token = generateDeviceToken();
  const updated = await prisma.integrationDevice.update({
    where: { id: deviceId },
    data: { tokenHash: hashDeviceToken(token), tokenHint: tokenHintOf(token) },
    include: { class: { select: { name: true } } },
  });
  logger.warn(`ClassIsland 联动设备令牌已重置：${updated.name}（旧令牌立即失效）`);
  return { device: toDeviceDto(updated), token };
}

export async function deleteDevice(user: TokenPayload, deviceId: string): Promise<void> {
  const current = await findDeviceOrFail(deviceId);
  await assertCanManageSchedule(user, current.classId);
  await prisma.integrationDevice.delete({ where: { id: deviceId } });
  logger.info(`ClassIsland 联动设备已删除：${current.name}`);
}

/* ------------------------------------------------------------------ 提醒下发（Web 端 → ClassIsland） */

function toPushDto(
  record: {
    id: string;
    classId: string;
    title: string;
    content: string;
    durationSeconds: number;
    speechContent: string | null;
    urgent: boolean;
    kind?: string | null;
    createdAt: Date;
  },
  extras: { className?: string | null; teacherName?: string | null } = {},
): ClassIslandPushNotification {
  return {
    id: record.id,
    title: record.title,
    content: record.content,
    durationSeconds: record.durationSeconds,
    speechContent: record.speechContent,
    createdAt: record.createdAt.toISOString(),
    urgent: record.urgent,
    // 老数据（迁移前）kind 为空：按普通通知处理
    kind: record.kind === 'call' ? 'call' : 'notification',
    classId: record.classId,
    className: extras.className ?? null,
    teacherName: extras.teacherName ?? null,
  };
}

/**
 * 下发一条提醒到该班级的 ClassIsland 设备。
 *
 * - 落库（ClassIslandPush）→ 在线设备通过 Socket.IO 立即收到；离线设备重连后走
 *   `GET /api/integrations/classisland/pending` 补齐，保证"老师按了发送就一定送到"；
 * - `saveToNotifications` 默认 true：同时写一条班级通知，ClassHelper 班级端通知中心/灵动岛也能看到，
 *   避免"只在 ClassIsland 上弹了一下，事后查无此事"。
 */
export async function sendNotification(
  user: TokenPayload,
  input: SendNotificationInput,
): Promise<SendClassIslandNotificationResult> {
  await assertCanPublishNotification(user, input.classId);

  const teacher = await prisma.user.findUnique({
    where: { id: user.sub },
    select: { name: true, username: true },
  });
  const teacherName = teacher?.name ?? teacher?.username ?? null;

  const priority = input.priority ?? 'NORMAL';
  let notificationId: string | null = null;

  // 教室在客户端里选了"只在 ClassHelper 客户端显示"时，**任何入口**都不再推 ClassIsland
  // （包括这个专门发给 ClassIsland 的入口）—— 规则只有一条，老师不用记"哪个页面有例外"。
  // 仍然把通知落库，并把跳过原因回给调用方，由 Web 端提示"不是没送达，是教室没要"。
  const allowed = await shouldPushToClassIsland(input.classId);

  if (input.saveToNotifications !== false) {
    const created = await prisma.notification.create({
      data: {
        classId: input.classId,
        title: input.title,
        content: input.content,
        priority,
        createdBy: user.sub,
      },
      include: { creator: { select: { id: true, name: true, username: true } }, reads: true },
    });
    notificationId = created.id;
    const dto: NotificationDto = toNotificationDto(created, { withStatus: true });
    // ClassHelper 班级端照旧收到通知中心的实时推送
    emitToClass(input.classId, SOCKET_EVENTS.notificationNew, dto);
  }

  if (!allowed) {
    logger.info(`ClassIsland 提醒被跳过：班级=${input.classId} 已选择"只在 ClassHelper 客户端显示"`);
    return { delivered: 0, targetCount: 0, notificationId, skipped: 'channel-client' };
  }

  const result = await pushToClassIsland({
    classId: input.classId,
    title: input.title,
    content: input.content,
    durationSeconds: input.durationSeconds,
    speechContent: input.speech
      ? input.speechContent?.trim() || `${input.title}。${input.content}`
      : null,
    urgent: priority === 'URGENT',
    createdBy: user.sub,
    notificationId,
    teacherName,
  });

  return { ...result, notificationId, skipped: null };
}

/** 推送所需的入参：三个发布入口（联动页 / 通知发布 / 叫人）共用同一套语义 */
export interface PushToClassIslandInput {
  classId: string;
  title: string;
  content: string;
  /** 显示时长（秒），留空用默认值 */
  durationSeconds?: number;
  /** 语音朗读内容；null = 不朗读 */
  speechContent?: string | null;
  urgent?: boolean;
  createdBy?: string | null;
  /** 若这次提醒也落了通知中心的库，把通知 id 带上，便于事后追溯 */
  notificationId?: string | null;
  /** 覆盖落库/广播时附带的教师名（三个入口的取法不同） */
  teacherName?: string | null;
  /** 提醒类型：notification（默认）/ call（叫人，算「主动通知」） */
  kind?: 'notification' | 'call';
}

/**
 * 把一条提醒推给某个班的 ClassIsland 设备（落库 + 广播）。
 *
 * 这是**三个发布入口的唯一共用实现**：
 * 1. 联动页的「下发提醒」（sendNotification）；
 * 2. 通知发布页的 POST /notifications；
 * 3. 叫人 POST /calls。
 * 因此"换个页面发通知就联动不到 ClassIsland"这类不一致不会再出现。
 *
 * 调用方负责权限校验与（必要时）显示位置开关判断。
 */
export async function pushToClassIsland(
  input: PushToClassIslandInput,
): Promise<{ delivered: number; targetCount: number }> {
  const classRecord = await prisma.class.findUnique({
    where: { id: input.classId },
    select: { id: true, name: true },
  });
  if (!classRecord) throw ApiError.notFound('班级不存在');

  const devices = await prisma.integrationDevice.findMany({
    where: { classId: input.classId, enabled: true, mode: 'plugin' },
    select: { id: true },
  });

  // 一个已接入的设备都没有时**不落推送记录**：
  // 否则任何"发通知"的动作（通知发布 / 叫人 / 冒烟脚本）都会给该班堆一条待提醒，
  // 等这台教室真的装上插件时被一次性补发一堆过期内容。
  // 教室机器只是离线（设备存在但没上报）的情况不受影响 —— 那正是"离线补齐"要覆盖的场景。
  if (devices.length === 0) {
    logger.info(`跳过 ClassIsland 推送：班级=${classRecord.name} 还没有已接入的设备`);
    return { delivered: 0, targetCount: 0 };
  }

  const push = await prisma.classIslandPush.create({
    data: {
      classId: input.classId,
      title: input.title,
      content: input.content,
      durationSeconds: input.durationSeconds ?? REPORT_DEFAULTS.notificationDuration,
      speechContent: input.speechContent ?? null,
      urgent: input.urgent === true,
      kind: input.kind ?? 'notification',
      createdBy: input.createdBy ?? null,
      notificationId: input.notificationId ?? null,
      // 24 小时未送达/未确认的提醒不再补发，避免学生过几天突然看到旧提醒
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });

  emitToClass(input.classId, SOCKET_EVENTS.classislandNotification, {
    ...toPushDto(push, { className: classRecord.name, teacherName: input.teacherName ?? null }),
    targetCount: devices.length,
  });

  logger.info(
    `ClassIsland 提醒下发：班级=${classRecord.name} 设备数=${devices.length} 标题="${input.title}"`,
  );
  return { delivered: devices.length, targetCount: devices.length };
}

/**
 * 班级的通知显示位置（由教室的班级客户端在设置页里选）。
 *
 * - `client`：教室里选了"只在 ClassHelper 客户端弹"，因此**不要**推 ClassIsland；
 * - 其余（both / classisland / 非法值）都推 —— 非法值按默认 both 处理，宁可多送一次也不要静默丢提醒。
 */
export async function shouldPushToClassIsland(classId: string): Promise<boolean> {
  const record = await prisma.class.findUnique({
    where: { id: classId },
    select: { notificationChannel: true },
  });
  return toNotificationChannel(record?.notificationChannel) !== 'client';
}

/* ------------------------------------------------------------------ 插件侧（设备令牌鉴权） */

/**
 * 插件上报：状态 + 可选的全量课表/节次时间。
 *
 * 关键点：**班级由设备令牌决定**，插件无法指定 classId，
 * 因此一台被绑定到 A 班的机器不可能把课表写进 B 班。
 */
export async function applyReport(
  device: DeviceContext,
  input: ClassIslandReportInput,
): Promise<ClassIslandReportResult> {
  const now = new Date();
  // 周次口径按**本班**算（管理员可以给每个班单独配开学日期与逐周区间）
  const week = resolveCurrentWeek(now, await loadTermContext(device.classId));

  // 0) 机器码回填（设备创建时只能用 pending-… 占位，首次上报才知道它到底是哪台机器）
  if (input.deviceKey) await syncDeviceKey(device, input.deviceKey);

  // 1) 状态快照（无论课表是否上报都更新，Web 端据此显示"现在上什么课"）
  //
  // 心跳与"带状态的上报"分开记：`lastHeartbeatAt` 每次上报都刷（在线判定看它），
  // `lastSeenAt` 只在确实带了运行状态时刷 —— 这样"连得上但一直没上报状态"的设备
  // 不会被误判成一切正常。
  const state = input.state;
  const currentDevice = await prisma.integrationDevice.findUnique({
    where: { id: device.deviceId },
    select: { requestScheduleReport: true },
  });
  const scheduleRequested = currentDevice?.requestScheduleReport === true;
  await prisma.integrationDevice.update({
    where: { id: device.deviceId },
    data: {
      lastHeartbeatAt: now,
      // 这次真的带了课表上来 → 待办完成
      ...(input.schedule ? { requestScheduleReport: false } : {}),
      ...(state ? { lastSeenAt: now } : {}),
      ...(input.pluginVersion ? { pluginVersion: input.pluginVersion } : {}),
      ...(input.classIslandVersion ? { classIslandVersion: input.classIslandVersion } : {}),
      ...(state
        ? {
            classPlanLoaded: state.classPlanLoaded === true,
            currentSubject: state.subject ?? null,
            currentTimeState: state.timeState ?? null,
            currentPeriodStart: state.periodStart ?? null,
            currentPeriodEnd: state.periodEnd ?? null,
            nextSubject: state.nextSubject ?? null,
          }
        : {}),
    },
    select: { id: true },
  });

  if (state) {
    emitToRooms([SOCKET_ROOMS.class(device.classId), SOCKET_ROOMS.teachers], SOCKET_EVENTS.classislandState, {
      classId: device.classId,
      deviceId: device.deviceId,
      deviceName: device.name,
      inClass: state.inClass === true,
      subject: state.subject ?? null,
      nextSubject: state.nextSubject ?? null,
      timeState: state.timeState ?? null,
      periodStart: state.periodStart ?? null,
      periodEnd: state.periodEnd ?? null,
      week: state.week ?? week,
      classPlanLoaded: state.classPlanLoaded === true,
      at: now.toISOString(),
    });
  }

  // 2) 课表写入（受设备开关与班级设置双重约束）
  let scheduleApplied = false;
  let scheduleCreated = 0;
  let scheduleUpdated = 0;
  let courses: string[] = [];
  if (input.schedule && input.schedule.entries.length > 0) {
    if (!device.syncScheduleToServer) {
      logger.warn(`ClassIsland 上报课表被忽略：设备「${device.name}」的"回传课表到服务端"开关已关闭`);
    } else {
      const result = await applyReportedSchedule(
        device.classId,
        input.schedule.mode ?? REPORT_DEFAULTS.scheduleMode,
        input.schedule.entries,
      );
      scheduleApplied = result.applied;
      scheduleCreated = result.created;
      scheduleUpdated = result.updated;
      courses = result.courses;
      if (result.applied) {
        emitToClass(device.classId, SOCKET_EVENTS.scheduleUpdated, {
          classId: device.classId,
          action: 'imported',
        });
      }
    }
  }

  // 3) 节次时间表写入
  let timeLayoutApplied = false;
  if (input.timeLayout && input.timeLayout.items.length > 0) {
    const result = await applyReportedTimeLayout(
      device.classId,
      input.timeLayout.name?.trim() || REPORT_DEFAULTS.timeLayoutName,
      input.timeLayout.items,
    );
    timeLayoutApplied = result.applied;
  }

  // 4) 取出尚未确认的下发提醒（插件刚启动时把漏掉的提醒立刻弹出来）
  const pending = await pendingNotificationFor(device.deviceId, device.classId);

  return {
    scheduleApplied,
    scheduleCreated,
    scheduleUpdated,
    courses,
    timeLayoutApplied,
    week,
    serverTime: now.toISOString(),
    settings: {
      mirrorScheduleToClassIsland: device.mirrorScheduleToClassIsland,
      enabled: device.enabled,
      // 「从教室机器取一次课表」的待办：Web 端点过之后置位，插件看到就立刻推一次课表上来。
      // 注意它**独立于** syncScheduleToServer —— 后者是"允许自动回传"，现在默认关闭，
      // 但管理员显式点"获取课表"时仍然应当能取到。
      scheduleRequested: scheduleRequested,
    },
    pendingNotification: pending,
  };
}

/**
 * 把插件上报的机器码回填到设备记录。
 *
 * `IntegrationDevice` 上有 `@@unique([classId, deviceKey])`，因此要避开两个坑：
 * 1) 同一台机器在这个班已有另一条设备记录（例如管理员重复建过设备）时直接写会撞唯一约束 → 500，
 *    这里改为记 warning 并保留原值；
 * 2) 值没变时不必白写一次库。
 */
async function syncDeviceKey(device: DeviceContext, reportedKey: string): Promise<void> {
  const key = reportedKey.trim();
  if (!key) return;

  const current = await prisma.integrationDevice.findUnique({
    where: { id: device.deviceId },
    select: { deviceKey: true },
  });
  if (!current || current.deviceKey === key) return;

  const taken = await prisma.integrationDevice.findFirst({
    where: { classId: device.classId, deviceKey: key, id: { not: device.deviceId } },
    select: { name: true },
  });
  if (taken) {
    logger.warn(
      `ClassIsland 上报的机器码「${key}」已被本班设备「${taken.name}」占用，本次不回填（设备=${device.name}）`,
    );
    return;
  }

  await prisma.integrationDevice.update({ where: { id: device.deviceId }, data: { deviceKey: key } });
  logger.info(`ClassIsland 设备机器码已回填：${device.name} -> ${key}`);
}

/** 该设备/该班级最近一条尚未确认、未过期的下发提醒 */
async function pendingNotificationFor(
  deviceId: string,
  classId: string,
): Promise<ClassIslandPushNotification | null> {
  const record = await prisma.classIslandPush.findFirst({
    where: {
      classId,
      ackedAt: null,
      expiresAt: { gt: new Date() },
      OR: [{ deviceId: null }, { deviceId }],
    },
    orderBy: { createdAt: 'desc' },
  });
  if (!record) return null;
  return toPushDto(record);
}

/** 插件重连/定时轮询：拉取本班所有未确认的提醒 */
export async function listPendingNotifications(device: DeviceContext): Promise<ClassIslandPendingResult> {
  const now = new Date();
  const records = await prisma.classIslandPush.findMany({
    where: {
      classId: device.classId,
      ackedAt: null,
      expiresAt: { gt: now },
      OR: [{ deviceId: null }, { deviceId: device.deviceId }],
    },
    orderBy: { createdAt: 'asc' },
    take: 20,
  });
  return {
    notifications: records.map((item) => toPushDto(item)),
    serverTime: now.toISOString(),
    week: resolveCurrentWeek(now, await loadTermContext(device.classId)),
  };
}

/** 插件确认提醒已弹出（之后不再补发） */
export async function ackNotification(device: DeviceContext, id: string): Promise<void> {
  const record = await prisma.classIslandPush.findUnique({
    where: { id },
    select: { id: true, classId: true, deviceId: true },
  });
  if (!record) throw ApiError.notFound('提醒不存在');
  if (record.classId !== device.classId) throw ApiError.forbidden('该提醒不属于本设备所在班级');
  await prisma.classIslandPush.update({
    where: { id },
    data: { ackedAt: new Date(), ...(record.deviceId ? {} : { deviceId: device.deviceId }) },
  });
}

/**
 * 插件拉取本班课表（mirrorScheduleToClassIsland 打开时，
 * 插件把它转换后覆盖写入 ClassIsland，实现"教师在 Web 端排课 → 教室课表跟着变"）。
 */
export async function pullClassPlanForDevice(device: DeviceContext): Promise<{
  classPlan: MirrorClassPlan;
  week: number;
  /** 学期周次区间（管理员逐周配置的）；空数组 = 按学期开始日期线性推算 */
  weekRanges: Array<{ weekNumber: number; startDate: string; endDate: string }>;
  serverTime: string;
}> {
  const now = new Date();
  // 周次口径按**本班**算：管理员可以给每个班单独配开学日期与逐周区间（调休、错峰开学）
  const termContext = await loadTermContext(device.classId);
  const week = resolveCurrentWeek(now, termContext);

  const classRecord = await prisma.class.findUnique({
    where: { id: device.classId },
    select: { id: true, name: true, termWeeks: true, termStartDate: true },
  });
  if (!classRecord) throw ApiError.notFound('班级不存在');

  const [schedules, timeLayouts] = await Promise.all([
    prisma.schedule.findMany({
      where: { classId: device.classId },
      include: { course: { select: { id: true, name: true } } },
      orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
    }),
    prisma.timeLayout.findMany({
      where: { classId: device.classId },
      orderBy: { updatedAt: 'desc' },
    }),
  ]);

  // 节次时间表：优先用班级里已导入的 ClassIsland 时间表，其次按课表的开始时间合成
  const layoutId = `ch-${device.classId}`;
  const layoutName = timeLayouts[0]?.name ?? 'ClassHelper时间表';
  let layouts: { startTime: string; endTime: string; timeType: number }[] = [];
  if (timeLayouts.length > 0 && timeLayouts[0]) {
    layouts = parseStoredTimeLayout(timeLayouts[0].items).map((item) => ({
      startTime: item.startTime,
      endTime: item.endTime,
      // 本系统的 class->0（上课）、break->1（课间）、divider->2（分割线）
      timeType: item.type === 'break' ? 1 : item.type === 'divider' ? 2 : 0,
    }));
  } else {
    layouts = synthesizeTimeLayout(schedules);
  }

  const entries = schedules.map((item) => {
    const parity = weekDivFromParity((item.weekParity as 'ALL' | 'ODD' | 'EVEN' | null) ?? 'ALL');
    return {
      weekDay: toClassIslandWeekDay(item.dayOfWeek),
      weekCountDiv: parity.weekCountDiv,
      weekCountDivTotal: parity.weekCountDivTotal,
      subject: item.course?.name ?? '未命名科目',
      teacherName: null,
      startTime: item.startTime,
      endTime: item.endTime,
      timeLayoutId: layoutId,
    };
  });

  return {
    classPlan: {
      entries,
      timeLayouts: [{ id: layoutId, name: layoutName, layouts }],
      profileName: `ClassHelper-${classRecord.name}`,
      // 下发本班实际生效的开学日期（管理员可以为某个班单独配，优先级高于全局 .env）
      termStartDate: termContext.termStartDate,
    },
    week,
    weekRanges: termContext.weeks,
    serverTime: now.toISOString(),
  };
}

/**
 * 「课表/周次变了，请重新镜像」的轻量通知。
 *
 * 插件是**轮询**镜像的（不订阅 Socket.IO），所以这里只做两件事：
 * 广播给 Web 端让页面刷新，以及把该班的设备标记为"有新版本"。
 * 真正的下发发生在插件下一次拉取课表时 —— 它会把新的开学日期与周次区间一并带走。
 */
export async function notifyScheduleChanged(classId: string): Promise<void> {
  emitToRooms([SOCKET_ROOMS.class(classId), SOCKET_ROOMS.teachers], SOCKET_EVENTS.scheduleUpdated, {
    classId,
    action: 'imported',
  });
  logger.info(`课表/周次已变更，等待教室机器下次镜像时下发：classId=${classId}`);
}

/** 解析库里存的节次 JSON（容错：坏数据不抛异常，退化为空） */
function parseStoredTimeLayout(raw: string): { startTime: string; endTime: string; type: string }[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => item as Partial<TimeLayoutEntry>)
      .filter(
        (item): item is Partial<TimeLayoutEntry> & { startTime: string; endTime: string } =>
          typeof item.startTime === 'string' && typeof item.endTime === 'string',
      )
      .map((item) => ({
        startTime: item.startTime,
        endTime: item.endTime,
        type: typeof item.type === 'string' ? item.type : 'class',
      }));
  } catch {
    return [];
  }
}

/**
 * 没有导入节次时间表时，用课表里出现过的起止时间合成一份（去重、按时间排序）。
 *
 * **每节课之间补一个课间**（timeType=1：上一节下课 → 下一节上课），最后一节之后不补（放学）。
 * ClassHelper这边的节次时间表与 ClassIsland 档案保持同一口径，镜像过去才不会缺课间。
 */
function synthesizeTimeLayout(
  schedules: { startTime: string; endTime: string }[],
): { startTime: string; endTime: string; timeType: number }[] {
  const seen = new Map<string, string>();
  for (const item of schedules) {
    if (!seen.has(item.startTime)) seen.set(item.startTime, item.endTime);
  }

  const classPoints = [...seen.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([startTime, endTime]) => ({ startTime, endTime, timeType: 0 }));

  const items: { startTime: string; endTime: string; timeType: number }[] = [];
  for (let index = 0; index < classPoints.length; index += 1) {
    const point = classPoints[index]!;
    items.push(point);
    const next = classPoints[index + 1];
    if (!next) continue; // 最后一节之后是放学，不插课间
    if (next.startTime > point.endTime) {
      items.push({ startTime: point.endTime, endTime: next.startTime, timeType: 1 });
    }
  }
  return items;
}

/* ------------------------------------------------------------------ 供仪表盘/统计使用 */

/** 某个班级当前是否已有在线设备（用于 Web 端提示"该班尚未接入 ClassIsland"） */
export async function countEnabledDevices(classIds: string[]): Promise<number> {
  if (classIds.length === 0) return 0;
  return prisma.integrationDevice.count({
    where: { classId: { in: classIds }, enabled: true, mode: 'plugin' },
  });
}

/** 供 ClassDto 附加"是否已接入 ClassIsland"（Web 端班级列表里显示徽标） */
export async function attachIntegrationFlag(classes: ClassDto[]): Promise<ClassDto[]> {
  if (classes.length === 0) return classes;
  const ids = classes.map((item) => item.id);
  const devices = await prisma.integrationDevice.findMany({
    where: { classId: { in: ids }, enabled: true },
    select: { classId: true },
  });
  const connected = new Set(devices.map((item) => item.classId));
  return classes.map((item) => ({ ...item, classIslandConnected: connected.has(item.id) }));
}

export type { ClassIslandScheduleEntry };
