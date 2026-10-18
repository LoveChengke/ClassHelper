import {
  CLIENT_COMMAND_EXPIRE_MS,
  CLIENT_COMMAND_LABELS,
  CLIENT_ONLINE_WINDOW_MS,
  compareVersions,
  type ClientUpdateProgressDto,
  type ClientUpdateMode,
  type ClientCommandAckRequest,
  type ClientCommandDto,
  type ClientCommandKind,
  type ClientDeviceDto,
  type ClientHeartbeatResponse,
  type ClientPushResult,
  type ClientTargetResult,
} from '@classhelper/shared';
import { resolveActiveClassPlan } from '../../lib/class-plan.js';
import { resolveClassScope, classScopeWhere } from '../../lib/access.js';
import { prisma } from '../../lib/db.js';
import { ApiError } from '../../lib/http.js';
import type { TokenPayload } from '../../lib/jwt.js';
import { logger } from '../../lib/logger.js';
import * as clientReleases from '../update/client-releases.service.js';
import type {
  ClientHeartbeatInput,
  CreateClientCommandInput,
  PushClientUpdateInput,
} from './clients.schemas.js';

/**
 * ClassHelper 桌面客户端设备的心跳 / 远控命令 / 更新下发。
 *
 * 范式（AGENTS.md 的现行工程约定）：**DB 记状态 + 客户端定时拉取** ——
 * 因此本文件里没有任何"推送"动作：所有下发都只是改 `ClientDevice` / `ClientCommand` 的字段，
 * 由客户端下一次心跳（30 秒内）带走。
 */

type DeviceRow = {
  id: string;
  classId: string | null;
  deviceKey: string;
  name: string;
  clientVersion: string;
  platform: string;
  autoUpdate: boolean;
  updateTargetVersion: string;
  updateMode: ClientUpdateMode;
  updateNotBefore: Date | null;
  pendingVersion: string;
  lastHeartbeatAt: Date | null;
  lastIp: string;
  stateNote: string;
  updateProgress: string;
  createdAt: Date;
  updatedAt: Date;
  class?: { id: string; name: string } | null;
};

type CommandRow = {
  id: string;
  deviceId: string;
  kind: string;
  payload: string;
  createdAt: Date;
  expiresAt: Date | null;
  ackedAt: Date | null;
  result: string;
};

/** 备注存 JSON 文本（`payload` 字段是预留结构，见 schema 注释） */
function encodePayload(note: string): string {
  return JSON.stringify({ note });
}

function decodePayload(raw: string): string {
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw) as { note?: unknown };
    return typeof parsed.note === 'string' ? parsed.note : '';
  } catch {
    // 兼容手工写进库的纯文本
    return raw;
  }
}

function toCommandDto(row: CommandRow): ClientCommandDto {
  const kind = row.kind as ClientCommandKind;
  const label = CLIENT_COMMAND_LABELS[kind] ?? row.kind;
  const note = decodePayload(row.payload);
  return {
    id: row.id,
    deviceId: row.deviceId,
    kind,
    payload: note ? `${label}（${note}）` : label,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    ackedAt: row.ackedAt ? row.ackedAt.toISOString() : null,
    result: row.result,
  };
}

/** 待执行的命令：未回执、未撤销、未过期 */
function pendingCommandWhere(deviceIds: string[], now: Date) {
  return {
    deviceId: { in: deviceIds },
    ackedAt: null,
    cancelledAt: null,
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
  };
}

function summarize(results: ClientTargetResult[]): ClientPushResult {
  const succeeded = results.filter((item) => item.ok).length;
  return { total: results.length, succeeded, failed: results.length - succeeded, results };
}

/** 班级端会话（含班级账号）的代表主体就是那个班；教师/管理员个人电脑不绑定班级 */
function resolveClassId(user: TokenPayload): string | null {
  return user.classSession || user.role === 'CLASS_DEVICE' ? user.sub : null;
}

async function findPendingCommand(deviceId: string, now: Date): Promise<CommandRow | null> {
  const rows = (await prisma.clientCommand.findMany({
    where: pendingCommandWhere([deviceId], now),
    orderBy: { createdAt: 'asc' },
    take: 1,
  })) as unknown as CommandRow[];
  return rows[0] ?? null;
}

/**
 * POST /api/clients/heartbeat - 客户端上报心跳，服务端在同一响应里带回
 * 「要不要更新 + 目标版本的安装包信息 + 一条待执行命令」。
 */
export async function heartbeat(
  user: TokenPayload,
  input: ClientHeartbeatInput,
  ip: string,
): Promise<ClientHeartbeatResponse> {
  const now = new Date();
  const heartbeatAt = {
    classId: resolveClassId(user),
    name: input.name?.trim() || '未命名设备',
    clientVersion: input.clientVersion?.trim() ?? '',
    platform: input.platform?.trim() ?? '',
    autoUpdate: input.autoUpdate !== false,
    pendingVersion: input.pendingVersion?.trim() ?? '',
    stateNote: input.stateNote?.trim() ?? '',
    lastHeartbeatAt: now,
    lastIp: ip,
  };

  const device = (await prisma.clientDevice.upsert({
    where: { deviceKey: input.deviceKey },
    create: { deviceKey: input.deviceKey, ...heartbeatAt },
    update: heartbeatAt,
  })) as unknown as DeviceRow;

  const targetVersion = device.updateTargetVersion.trim();
  if (targetVersion && input.clientVersion && compareVersions(input.clientVersion, targetVersion) >= 0) {
    await prisma.clientDevice.updateMany({
      where: { id: device.id, updateTargetVersion: targetVersion },
      data: {
        pendingVersion: '',
        updateProgress: JSON.stringify({
          version: input.clientVersion,
          stage: 'completed',
          downloadedBytes: 0,
          totalBytes: 0,
          percent: 100,
          error: '',
          updatedAt: now.toISOString(),
        }),
      },
    });
  } else if (input.updateProgress && input.updateProgress.stage !== 'idle') {
    await reportUpdateProgress(user, input.deviceKey, input.updateProgress);
  }
  const [command, update] = await Promise.all([
    findPendingCommand(device.id, now),
    targetVersion ? clientReleases.resolveUpdateInfo(targetVersion) : Promise.resolve(null),
  ]);

  return {
    deviceId: device.id,
    serverTime: now.toISOString(),
    updateTargetVersion: targetVersion || null,
    updateMode: device.updateMode,
    updateNotBefore: device.updateNotBefore?.toISOString() ?? null,
    // 旧客户端没有时机判断：到放学时间前不提供包，避免它提前安装。
    update:
      input.agentProtocol !== 2 &&
      device.updateMode === 'after-school' &&
      device.updateNotBefore &&
      now < device.updateNotBefore
        ? null
        : update,
    command: command ? toCommandDto(command) : null,
  };
}

export async function reportUpdateProgress(
  user: TokenPayload,
  deviceKey: string,
  progress: ClientUpdateProgressDto,
) {
  const device = await prisma.clientDevice.findUnique({ where: { deviceKey } });
  // 教师/管理员电脑不绑定班级（会话与设备两侧都是 null），同样允许上报自己的进度。
  if (!device || device.classId !== resolveClassId(user)) throw ApiError.forbidden('设备不属于当前班级');
  // 已取消或更换目标的迟到进度不得覆盖当前任务。
  if (progress.version !== device.updateTargetVersion || progress.stage === 'completed') return;
  const previous = readUpdateProgress(device.updateProgress);
  if (previous?.version === progress.version && previous.stage === 'completed') return;
  const stages = ['idle', 'downloading', 'verifying', 'ready', 'waiting', 'installing', 'completed'];
  if (
    previous?.version === progress.version &&
    previous.stage !== 'failed' &&
    progress.stage !== 'failed' &&
    !progress.error &&
    stages.indexOf(progress.stage) < stages.indexOf(previous.stage)
  )
    return;
  await prisma.clientDevice.updateMany({
    where: {
      id: device.id,
      updateTargetVersion: progress.version,
      updateProgress: device.updateProgress,
    },
    data: {
      updateProgress: JSON.stringify({ ...progress, updatedAt: new Date().toISOString() }),
    },
  });
}
function readUpdateProgress(raw: string): ClientUpdateProgressDto | null {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** POST /api/clients/commands/:id/ack - 客户端执行完远控命令后的回执 */
export async function ackCommand(
  commandId: string,
  input: ClientCommandAckRequest,
): Promise<ClientCommandDto> {
  const command = (await prisma.clientCommand.findUnique({
    where: { id: commandId },
    include: { device: { select: { deviceKey: true, name: true } } },
  })) as (CommandRow & { device: { deviceKey: string; name: string } }) | null;
  if (!command) throw ApiError.notFound('命令不存在');

  if (command.device.deviceKey !== input.deviceKey) {
    throw ApiError.forbidden('这条命令不是发给这台电脑的');
  }
  // 幂等：客户端重试回执不报错，也不覆盖第一次的结果
  if (command.ackedAt) return toCommandDto(command);

  const detail = input.result?.trim();
  const result = `${input.ok ? '已执行' : '执行失败'}${detail ? `：${detail}` : ''}`;
  const updated = (await prisma.clientCommand.update({
    where: { id: commandId },
    data: { ackedAt: new Date(), result },
  })) as unknown as CommandRow;

  logger.info(`远控命令回执：${command.device.name || command.device.deviceKey} ${result}`);
  return toCommandDto(updated);
}

/** GET /api/clients/devices - Web 端「客户端设备」列表（含待执行命令） */
export async function listDevices(
  user: TokenPayload,
  options: { classId?: string } = {},
): Promise<ClientDeviceDto[]> {
  const scope = await resolveClassScope(user, options.classId);
  const rows = (await prisma.clientDevice.findMany({
    where: classScopeWhere(scope),
    include: { class: { select: { id: true, name: true } } },
    orderBy: [{ lastHeartbeatAt: 'desc' }, { createdAt: 'desc' }],
  })) as unknown as DeviceRow[];

  const now = new Date();
  const commands = (await prisma.clientCommand.findMany({
    where: pendingCommandWhere(
      rows.map((row) => row.id),
      now,
    ),
    orderBy: { createdAt: 'asc' },
  })) as unknown as CommandRow[];

  // 每台设备只留最早的一条（与心跳取的是同一条，界面上看到的才是真会执行的那条）
  const pendingByDevice = new Map<string, CommandRow>();
  for (const command of commands) {
    if (!pendingByDevice.has(command.deviceId)) pendingByDevice.set(command.deviceId, command);
  }

  // 「最近一条命令」：待执行的那条在取消 / 超时之后就从 pendingCommand 里消失了，
  // Web 端于是看不出"我刚点的锁屏到底怎么了"。取最近 500 条（够覆盖一次批量下发）按设备分组。
  const recent = (await prisma.clientCommand.findMany({
    where: { deviceId: { in: rows.map((row) => row.id) } },
    orderBy: { createdAt: 'desc' },
    take: 500,
  })) as unknown as CommandRow[];
  const lastByDevice = new Map<string, CommandRow>();
  for (const command of recent) {
    if (!lastByDevice.has(command.deviceId)) lastByDevice.set(command.deviceId, command);
  }

  return rows.map((row) => {
    const heartbeat = row.lastHeartbeatAt;
    const pending = pendingByDevice.get(row.id);
    const last = lastByDevice.get(row.id);
    return {
      id: row.id,
      classId: row.classId,
      className: row.class?.name ?? null,
      deviceKey: row.deviceKey,
      name: row.name,
      clientVersion: row.clientVersion,
      platform: row.platform,
      autoUpdate: row.autoUpdate,
      updateTargetVersion: row.updateTargetVersion,
      updateMode: row.updateMode,
      updateNotBefore: row.updateNotBefore?.toISOString() ?? null,
      pendingVersion: row.pendingVersion,
      lastHeartbeatAt: heartbeat ? heartbeat.toISOString() : null,
      lastIp: row.lastIp,
      stateNote: row.stateNote,
      updateProgress: readUpdateProgress(row.updateProgress),
      online: Boolean(heartbeat && now.getTime() - heartbeat.getTime() < CLIENT_ONLINE_WINDOW_MS),
      pendingCommand: pending ? toCommandDto(pending) : null,
      lastCommand: last ? toCommandDto(last) : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  });
}

/** 命令去重后的目标设备（保持请求顺序，便于结果一一对应） */
async function findTargetDevices(user: TokenPayload, deviceIds: string[]): Promise<Map<string, DeviceRow>> {
  const wanted = [...new Set(deviceIds)];
  const scope = classScopeWhere(await resolveClassScope(user, undefined, 'remote:control'));
  const rows = (await prisma.clientDevice.findMany({
    where: { AND: [scope, { id: { in: wanted } }] },
    select: { id: true, name: true, deviceKey: true },
  })) as unknown as DeviceRow[];
  if (rows.length !== wanted.length) throw ApiError.forbidden('部分设备超出管理范围');
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * POST /api/clients/commands - 下发远控命令（关机/重启/注销/锁屏）
 *
 * 同一台机器上还没执行的旧命令会被**自动撤销**：否则"先关机、后重启"会排队执行，
 * 机器刚关就被下一条叫起来，看起来像失控。客户端收到即执行，并以设备标识回执真实结果。
 */
export async function createCommands(
  user: TokenPayload,
  input: CreateClientCommandInput,
): Promise<ClientPushResult> {
  const targets = await findTargetDevices(user, input.deviceIds);
  const expiresAt = new Date(Date.now() + CLIENT_COMMAND_EXPIRE_MS);
  const note = input.note?.trim() ?? '';
  const results: ClientTargetResult[] = [];

  for (const deviceId of [...new Set(input.deviceIds)]) {
    const device = targets.get(deviceId);
    if (!device) {
      results.push({
        deviceId,
        deviceName: '',
        ok: false,
        code: 'DEVICE_NOT_FOUND',
        message: '设备不存在（可能已被移除）',
      });
      continue;
    }

    await prisma.clientCommand.updateMany({
      where: { deviceId, ackedAt: null, cancelledAt: null },
      data: { cancelledAt: new Date(), result: '已被新的命令取代' },
    });
    await prisma.clientCommand.create({
      data: { deviceId, kind: input.kind, payload: encodePayload(note), createdBy: user.sub, expiresAt },
    });
    results.push({ deviceId, deviceName: device.name, ok: true });
  }

  const summary = summarize(results);
  logger.info(
    `下发远控命令 ${input.kind}：目标 ${summary.total} 台，成功 ${summary.succeeded} 台（发起人=${user.username}）`,
  );
  return summary;
}

/** 更新推送的目标集合：优先设备，其次班级，最后"全部" */
async function resolveUpdateTargets(user: TokenPayload, input: PushClientUpdateInput): Promise<DeviceRow[]> {
  const scope = classScopeWhere(await resolveClassScope(user, undefined, 'client:update'));
  const deviceIds = [...new Set(input.deviceIds ?? [])];
  if (deviceIds.length > 0) {
    const rows = (await prisma.clientDevice.findMany({
      where: { AND: [scope, { id: { in: deviceIds } }] },
      select: { id: true, name: true, classId: true },
    })) as unknown as DeviceRow[];
    return rows;
  }

  const classIds = [...new Set(input.classIds ?? [])];
  if (classIds.length > 0) {
    return (await prisma.clientDevice.findMany({
      where: { AND: [scope, { classId: { in: classIds } }] },
      select: { id: true, name: true, classId: true },
    })) as unknown as DeviceRow[];
  }

  if (input.all) {
    return (await prisma.clientDevice.findMany({
      where: scope,
      select: { id: true, name: true, classId: true },
    })) as unknown as DeviceRow[];
  }

  throw ApiError.badRequest('请选择要推送的设备、班级，或选择"全部设备"');
}

/**
 * POST /api/clients/updates - 统一下发客户端更新
 *
 * `version` 省略时用服务端缓存里最新的那个版本；`clear: true` 取消下发。
 * 保存目标版本和安装策略，下载、安装由客户端在心跳后执行。
 */
export async function pushUpdate(
  user: TokenPayload,
  input: PushClientUpdateInput,
): Promise<ClientPushResult> {
  const clear = input.clear === true;
  let target = '';

  if (!clear) {
    target = (input.version ?? '').trim() || (await clientReleases.latestReleaseVersion());
    if (!target) {
      throw ApiError.badRequest('服务端还没有缓存任何客户端安装包，请先下载或登记一份再推送');
    }
    const info = await clientReleases.resolveUpdateInfo(target);
    if (!info) throw ApiError.badRequest(`服务端缺少 v${target} 的安装包文件，请重新下载或登记`);
  }

  const devices = await resolveUpdateTargets(user, input);
  if (devices.length === 0) throw ApiError.badRequest('没有匹配到任何客户端设备');

  const results: ClientTargetResult[] = [];
  for (const device of devices) {
    await prisma.clientDevice.update({
      where: { id: device.id },
      data: {
        updateTargetVersion: target,
        updateProgress: '',
        updateMode: clear ? 'idle' : input.mode,
        updateNotBefore:
          !clear && input.mode === 'after-school'
            ? await afterSchoolAt(device.classId, input.afterSchoolTime)
            : null,
      },
    });
    results.push({ deviceId: device.id, deviceName: device.name, ok: true });
  }

  const summary = summarize(results);
  logger.info(
    clear
      ? `取消更新下发：${summary.total} 台设备（发起人=${user.username}）`
      : `推送客户端更新 v${target}：${summary.total} 台设备（发起人=${user.username}）`,
  );
  return summary;
}

/** 按当前教学周、单双周与星期计算今天放学时间；未绑定班级使用明确的兜底时间。 */
async function afterSchoolAt(classId: string | null, fallback = '17:00'): Promise<Date> {
  const now = new Date();
  let end = fallback;
  if (classId) {
    const active = await resolveActiveClassPlan(classId, now);
    const last = [...active.schedules].sort((a, b) => b.endTime.localeCompare(a.endTime))[0];
    if (last && last.endTime > end) end = last.endTime;
  }
  const [hours, minutes] = end.split(':').map(Number);
  const at = new Date(now);
  at.setHours(hours!, minutes!, 0, 0);
  return at;
}

/** DELETE /api/clients/devices/:id - 移除一台设备记录（换机 / 旧机器清理） */
export async function deleteDevice(user: TokenPayload, deviceId: string): Promise<{ id: string }> {
  const scope = classScopeWhere(await resolveClassScope(user, undefined, 'client:manage'));
  const device = await prisma.clientDevice.findFirst({
    where: { AND: [scope, { id: deviceId }] },
    select: { id: true, name: true, deviceKey: true },
  });
  if (!device) throw ApiError.notFound('设备不存在');
  await prisma.clientDevice.delete({ where: { id: deviceId } });
  logger.info(`移除客户端设备：${device.name || device.deviceKey}`);
  return { id: deviceId };
}
