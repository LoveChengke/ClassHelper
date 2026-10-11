import { spawn } from 'node:child_process';
import os from 'node:os';
import { BrowserWindow, app, dialog } from 'electron';
import {
  CLIENT_COMMAND_LABELS,
  CLIENT_HEARTBEAT_INTERVAL_MS,
  isNewerVersion,
  type ClientCommandDto,
  type ClientCommandKind,
  type ClientHeartbeatRequest,
  type ClientHeartbeatResponse,
  type ClientUpdateInfoDto,
} from '@classhelper/shared';
import { maybeInstallPendingUpdate, considerUpdate } from './auto-update.js';
import { getConfig } from './config.js';
import { island } from './island.js';
import { logger } from './logger.js';

/**
 * 桌面客户端的服务端联动代理（心跳上报）。
 *
 * **为什么是"客户端定时拉"而不是服务端推**：教室机的连接经常断（代理、休眠、重启），
 * 而「这台机器是什么版本、要不要更新、有没有待执行命令」必须下次上线就能补上 —— 所以统一用
 * 「服务端记状态 + 客户端定时上报」的范式（与 ClassIsland 插件的上报同一套路），不引入新的长连接握手。
 * 每次上报的响应里同时带回「服务端指定的目标版本 + 待执行命令」。
 *
 * 三条边界：
 * 1. **没有 token 就不上报**：未登录时静默跳过（登录后下一次自然就上报了），
 *    不能拿空令牌去打服务端，否则日志里会刷满 401；
 * 2. **401/403 退避到 5 分钟**：令牌可能已失效（班级密码被改 / 令牌过期），
 *    继续 30 秒一次只是白刷服务端与日志；
 * 3. **冒烟模式默认不上报**：每次冒烟都在服务端库里造一条设备记录没有意义，
 *    只有显式 `ELECTRON_SMOKE_CLIENT_AGENT=1` 时才照常跑（给需要验证这条链路的用例用）。
 */

/** 启动后第一次上报的延迟：等窗口、登录流程与灵动岛都就绪，也不跟首屏抢带宽 */
const FIRST_BEAT_DELAY_MS = 3_000;

/** 令牌失效（401/403）后的退避间隔：5 分钟一次，直到用户重新登录 */
const UNAUTHORIZED_BACKOFF_MS = 5 * 60_000;

/** 单次上报的超时：教室机网络慢，但也不能挂着不放 */
const HEARTBEAT_TIMEOUT_MS = 10_000;

/**
 * 远控命令的「本机二次确认」等待时长：60 秒内没人点确认就按取消处理。
 *
 * 为什么必须有这个超时：管理员在办公室下发关机，而教室里可能已经没人了 ——
 * 一个永远挂着等确认的对话框会让这条命令一直"待执行"，既没执行也看不出失败。
 */
const COMMAND_CONFIRM_TIMEOUT_MS = 60_000;

/**
 * 「在线」判定窗口：与 shared 的 `CLIENT_ONLINE_WINDOW_MS`（90 秒）同口径 ——
 * 连续丢两次心跳（30 秒 × 3）才算离线。这里不复用那个常量是因为它属于**服务端**的判定口径，
 * 客户端展示的是"我这边的上报还新不新"，单独留一个本地常量更容易看出两边的关系。
 */
const ONLINE_WINDOW_MS = 90_000;

/** 对外暴露的联动状态（设置页「服务端联动状态」与冒烟断言用） */
export interface ClientAgentStatus {
  /** 设备标识尾号（服务端设备列表里显示的那串用来对账，完整 UUID 不上界面） */
  deviceKeyTail: string;
  /** 最近一次上报成功的时刻（ISO 字符串；从未上报过为 null） */
  lastHeartbeatAt: string | null;
  /** 最近一次失败的原因（空串 = 最近一次是成功的） */
  lastError: string;
  /** 已下载待安装的版本（空串 = 无） */
  pendingUpdateVersion: string;
  /** 服务端最近一次要求升到的版本（空串 = 没要求） */
  updateTargetVersion: string;
  /** 是否接受服务端统一下发的自动更新（配置值，供设置页回显） */
  autoUpdate: boolean;
  /** 最近 90 秒内上报成功过（与服务端的在线口径一致） */
  online: boolean;
}

interface AgentState {
  running: boolean;
  /** 当前心跳定时器（退避期间与正常节奏共用它） */
  timer: ReturnType<typeof setTimeout> | null;
  /** 正在上报：避免手动「立即上报」与定时器撞在一起 */
  beating: boolean;
  lastHeartbeatAt: string | null;
  lastError: string;
  updateTargetVersion: string;
}

const state: AgentState = {
  running: false,
  timer: null,
  beating: false,
  lastHeartbeatAt: null,
  lastError: '',
  updateTargetVersion: '',
};

/** 设备标识尾号：取后 8 位（足够对账，又不至于把完整 UUID 贴到界面上） */
export function deviceKeyTail(deviceKey: string): string {
  const trimmed = deviceKey.trim();
  if (!trimmed) return '';
  return trimmed.length > 8 ? trimmed.slice(-8) : trimmed;
}

/** 冒烟模式且没有显式打开联动开关时，一律不上报（避免每次冒烟都在库里造设备记录） */
function isAgentSuppressed(): boolean {
  return process.env.ELECTRON_SMOKE_TEST === '1' && process.env.ELECTRON_SMOKE_CLIENT_AGENT !== '1';
}

/**
 * 上报里的"这台机器现在在干什么"。
 *
 * 取值就三种（服务端设备列表直接展示这段文字）：
 * - `上课中` —— 灵动岛按渲染进程上报的课表状态判定正在上课（此时绝不安装更新）；
 * - `使用中` —— 主窗口可见，人正在用；
 * - `待机` —— 窗口隐藏（最小化到托盘），机器空闲。
 */
function currentStateNote(): string {
  if (island.getState().inClass) return '上课中';
  const win = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed());
  return win?.isVisible() ? '使用中' : '待机';
}

/** 已下载待安装的版本；没有则 null（服务端把它记进设备的 `pendingVersion`） */
function pendingVersionOrNull(): string | null {
  const pending = getConfig().pendingUpdateVersion.trim();
  return pending ? pending : null;
}

/** 清掉待执行的心跳定时器（幂等） */
function clearTimer(): void {
  if (state.timer !== null) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

/** 排下一次上报；`delayMs` 不传时用正常节奏 */
function scheduleNext(delayMs: number = CLIENT_HEARTBEAT_INTERVAL_MS): void {
  if (!state.running) return;
  clearTimer();
  state.timer = setTimeout(() => {
    state.timer = null;
    void beat();
  }, delayMs);
}

/**
 * 一次上报（含响应处理）。
 *
 * 失败一律**不抛**：网络抖动是教室机的常态，只记一行日志并按原节奏重试；
 * 只有 401/403 才退避（见文件头说明）。
 */
async function beat(): Promise<void> {
  if (state.beating) return;
  if (isAgentSuppressed()) {
    // 冒烟模式：照原节奏空转（不碰服务端，也不在库里造设备记录）
    state.lastError = '';
    scheduleNext();
    return;
  }
  const config = getConfig();
  const token = config.token?.trim() ?? '';
  if (!token) {
    // 未登录：不打服务端、不记错误，等下次心跳（登录后自然会带上令牌）
    logger.debug('客户端上报：尚未登录（没有令牌），本次跳过');
    scheduleNext();
    return;
  }

  state.beating = true;
  let backoff = false;
  try {
    const body: ClientHeartbeatRequest = {
      deviceKey: config.deviceKey,
      name: os.hostname(),
      clientVersion: app.getVersion(),
      platform: `${process.platform}-${process.arch}`,
      pendingVersion: pendingVersionOrNull(),
      stateNote: currentStateNote(),
    };
    const response = await fetch(`${config.serverUrl}/api/clients/heartbeat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS),
    });

    if (response.status === 401 || response.status === 403) {
      // 令牌失效：退避到 5 分钟一次，直到用户重新登录
      backoff = true;
      state.lastError = `上报被拒绝（HTTP ${response.status}），可能登录已过期，请重新登录`;
      logger.warn(`客户端上报：服务端返回 HTTP ${response.status}，退避为 5 分钟一次`);
      return;
    }
    if (!response.ok) {
      state.lastError = `服务端返回 HTTP ${response.status}`;
      logger.warn(`客户端上报失败：HTTP ${response.status}（${HEARTBEAT_INTERVAL_TEXT}）`);
      return;
    }

    const payload = (await response.json()) as ClientHeartbeatResponse;
    state.lastHeartbeatAt = new Date().toISOString();
    state.lastError = '';
    state.updateTargetVersion = payload.updateTargetVersion?.trim() ?? '';
    logger.debug(
      `客户端上报成功（设备尾号 ${deviceKeyTail(config.deviceKey)}，状态 ${body.stateNote ?? '-'}` +
        `${state.updateTargetVersion ? `，服务端要求升到 ${state.updateTargetVersion}` : ''}）`,
    );

    void handleCommand(payload.command);
    await handleUpdate(payload.update, payload.updateTargetVersion);
  } catch (error) {
    // 网络错误 / 超时 / JSON 解析失败：按原节奏重试
    state.lastError = error instanceof Error ? error.message : String(error);
    logger.warn(`客户端上报失败（将于 ${HEARTBEAT_INTERVAL_TEXT} 后重试）：${state.lastError}`);
  } finally {
    state.beating = false;
    // 每次心跳（无论成败）都顺手看一下有没有下载好的更新该装了 —— 上课/窗口可见时会自动跳过
    void maybeInstallPendingUpdate();
    scheduleNext(backoff ? UNAUTHORIZED_BACKOFF_MS : CLIENT_HEARTBEAT_INTERVAL_MS);
  }
}

const HEARTBEAT_INTERVAL_TEXT = `${Math.round(CLIENT_HEARTBEAT_INTERVAL_MS / 1000)} 秒`;

/**
 * 服务端下发的远控命令（关机 / 重启 / 注销 / 锁屏）。
 *
 * 两道护栏缺一不可（用户要求「必须二次确认」）：
 * 1. **本机二次确认**：弹一个默认选中「取消」的对话框，60 秒不确认按取消处理 ——
 *    服务端那边虽然也确认过，但真正会被关掉的机器上必须有人当场知道；
 * 2. **同一条命令只弹一次**：它随每次心跳重复下发，用内存集合去重，避免 30 秒弹一个框。
 *
 * 执行后**必须回执**（`POST /api/clients/commands/:id/ack`，body 带 deviceKey）：
 * 否则服务端那条命令会一直挂在"待执行"里，Web 端看不到结果。回执失败时把结果暂存，
 * 下一次心跳只重试回执、不重复弹窗。
 */
const inFlightCommands = new Set<string>();
const unackedResults = new Map<string, { ok: boolean; result: string }>();

async function handleCommand(command: ClientCommandDto | null): Promise<void> {
  if (!command) return;
  const label = CLIENT_COMMAND_LABELS[command.kind] ?? command.kind;

  const expired =
    command.expiresAt !== null && Number.isFinite(Date.parse(command.expiresAt))
      ? Date.parse(command.expiresAt) < Date.now()
      : false;
  if (expired) {
    logger.warn(`收到已过期的远控命令（${label}），已忽略：${command.payload || '无备注'}`);
    return;
  }

  // 处理过但回执没送达：只重试回执
  const pending = unackedResults.get(command.id);
  if (pending) {
    await ackCommand(command.id, pending.ok, pending.result);
    return;
  }
  // 正在等本机确认：不要再弹第二个框
  if (inFlightCommands.has(command.id)) return;

  inFlightCommands.add(command.id);
  try {
    const confirmed = await confirmCommand(label, command.payload);
    if (!confirmed) {
      const result = '本机用户取消（或 60 秒未确认）';
      logger.warn(`远控命令「${label}」未执行：${result}`);
      await ackCommand(command.id, false, result);
      return;
    }
    const outcome = await executeCommand(command.kind);
    logger.warn(`远控命令「${label}」执行${outcome.ok ? '成功' : '失败'}：${outcome.result}`);
    await ackCommand(command.id, outcome.ok, outcome.result);
  } finally {
    inFlightCommands.delete(command.id);
  }
}

/** 本机二次确认对话框：默认「取消」，60 秒未操作按取消处理 */
async function confirmCommand(label: string, note: string): Promise<boolean> {
  const answered = dialog
    .showMessageBox({
      type: 'warning',
      title: '来自管理员的远程指令',
      message: `管理员要求本机「${label}」`,
      detail: `${note ? `备注：${note}\n` : ''}确认后本机将立即${label}；60 秒内未确认视为取消。`,
      buttons: ['取消', '确认执行'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
    .then((result) => result.response === 1)
    .catch(() => false);

  return Promise.race([
    answered,
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), COMMAND_CONFIRM_TIMEOUT_MS)),
  ]);
}

/** 执行系统命令：只支持 Windows（本项目客户端只发 Windows 版） */
async function executeCommand(kind: ClientCommandKind): Promise<{ ok: boolean; result: string }> {
  if (process.platform !== 'win32') return { ok: false, result: '仅支持 Windows' };

  const commands: Record<ClientCommandKind, { file: string; args: string[] }> = {
    shutdown: { file: 'shutdown.exe', args: ['/s', '/t', '0'] },
    restart: { file: 'shutdown.exe', args: ['/r', '/t', '0'] },
    logoff: { file: 'shutdown.exe', args: ['/l'] },
    lock: { file: 'rundll32.exe', args: ['user32.dll,LockWorkStation'] },
  };
  const plan = commands[kind];

  try {
    // detached + unref：不能等它退出（关机/注销会把本进程一起带走）
    spawn(plan.file, plan.args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return { ok: true, result: '已下达系统命令' };
  } catch (error) {
    return { ok: false, result: error instanceof Error ? error.message : String(error) };
  }
}

/** 回执：服务端用 body 里的 deviceKey 校验"这条命令是发给这台机器的" */
async function ackCommand(commandId: string, ok: boolean, result: string): Promise<void> {
  const config = getConfig();
  if (!config.token) return;
  try {
    const response = await fetch(`${config.serverUrl}/api/clients/commands/${commandId}/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token}` },
      body: JSON.stringify({ deviceKey: config.deviceKey, ok, result }),
      signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS),
    });
    if (!response.ok) {
      logger.warn(`远控命令回执失败（HTTP ${response.status}），将在下次心跳重试`);
      unackedResults.set(commandId, { ok, result });
      return;
    }
    unackedResults.delete(commandId);
    logger.info(`远控命令回执已送达（${ok ? '成功' : '失败'}）：${result}`);
  } catch (error) {
    logger.warn(
      `远控命令回执失败（${error instanceof Error ? error.message : String(error)}），将在下次心跳重试`,
    );
    unackedResults.set(commandId, { ok, result });
  }
}

/** 响应里的更新信息：服务端指定了目标版本、且该版本确实比本机新，才交给 auto-update */
async function handleUpdate(info: ClientUpdateInfoDto | null, targetVersion: string | null): Promise<void> {
  const target = targetVersion?.trim() ?? '';
  if (!target) return;
  if (!info) {
    // 服务端指定了目标版本但还没有这份安装包：只记一行，客户端只能提示手动更新
    logger.warn(`服务端要求升到 ${target}，但服务端还没有这个版本的安装包（无法自动下载）`);
    return;
  }
  if (!isNewerVersion(app.getVersion(), target)) return;
  await considerUpdate(info, target);
}

/** 启动心跳（重复调用无副作用） */
export function startClientAgent(): void {
  if (state.running) return;
  state.running = true;
  logger.info(
    isAgentSuppressed()
      ? '客户端上报代理：冒烟模式下不上报（需要时设 ELECTRON_SMOKE_CLIENT_AGENT=1）'
      : `客户端上报代理已启动：${FIRST_BEAT_DELAY_MS / 1000} 秒后首次上报，之后每 ${HEARTBEAT_INTERVAL_TEXT} 一次`,
  );
  scheduleNext(FIRST_BEAT_DELAY_MS);
}

/** 停止心跳（退出清理调用；幂等） */
export function stopClientAgent(): void {
  if (!state.running) return;
  state.running = false;
  clearTimer();
  logger.info('客户端上报代理已停止');
}

/**
 * 手动触发一次上报并返回最新状态（设置页「立即上报」按钮）。
 * 返回的是**报告之后**的状态，界面直接照它刷新即可。
 */
export async function beatNow(): Promise<ClientAgentStatus> {
  if (!state.running) startClientAgent();
  if (isAgentSuppressed()) {
    logger.info('客户端上报：冒烟模式下跳过手动上报');
    return getClientAgentStatus();
  }
  clearTimer();
  await beat();
  return getClientAgentStatus();
}

/** 当前联动状态（纯数据，可直接跨 contextBridge 传给渲染进程） */
export function getClientAgentStatus(): ClientAgentStatus {
  const config = getConfig();
  const lastAt = state.lastHeartbeatAt ? Date.parse(state.lastHeartbeatAt) : Number.NaN;
  return {
    deviceKeyTail: deviceKeyTail(config.deviceKey),
    lastHeartbeatAt: state.lastHeartbeatAt,
    lastError: state.lastError,
    pendingUpdateVersion: config.pendingUpdateVersion ?? '',
    updateTargetVersion: state.updateTargetVersion,
    autoUpdate: config.autoUpdate !== false,
    online: Number.isFinite(lastAt) && Date.now() - lastAt < ONLINE_WINDOW_MS,
  };
}
