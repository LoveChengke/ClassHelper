import fs from 'node:fs';
import path from 'node:path';
import { app, safeStorage } from 'electron';
import {
  CLASSISLAND_NOTIFICATION_CHANNELS,
  DEFAULT_CLASSISLAND_NOTIFICATION_CHANNEL,
  DEFAULT_ISLAND_APPEARANCE,
  DEFAULT_SERVER_URL,
  HOMEWORK_PHRASE_DEFAULTS,
  HOMEWORK_PHRASE_MAX_COUNT,
  HOMEWORK_PHRASE_MAX_LENGTH,
  type ClassIslandNotificationChannel,
  type IslandAppearance,
} from '@classhelper/shared';
import { logger } from './logger.js';
import type { DesktopStoredConfig, HomeworkBoardSettings } from '../types/desktop.js';

/** 作业页展示偏好默认值（看板 + 不显示时间 + 15px） */
const DEFAULT_HOMEWORK_BOARD: HomeworkBoardSettings = {
  mode: 'board',
  showTime: false,
  fontSize: 15,
};

interface PersistedConfig {
  serverUrl: string;
  username: string;
  /** 加密后的 token（base64）或明文（当系统不支持加密时） */
  token: string | null;
  tokenEncrypted: boolean;
  /** 个性化设置：灵动岛外观（向后兼容：旧配置文件没有该字段时用默认值补齐） */
  island?: Partial<IslandAppearance>;
  /** 作业页展示偏好（向后兼容：旧配置文件没有该字段时用默认值补齐） */
  homeworkBoard?: Partial<HomeworkBoardSettings>;
  /** 通知显示位置（向后兼容：旧配置文件没有该字段时按默认 both 补齐） */
  notificationChannel?: ClassIslandNotificationChannel;
  /** 作业录入快捷短语（向后兼容：旧配置没有该字段时用默认那一组） */
  homeworkPhrases?: string[];
  /** 是否已看过初次启动引导（向后兼容：旧配置没有该字段视为没看过，首启弹一次） */
  onboardingDone?: boolean;
  /** 界面主题（向后兼容：旧配置没有该字段用浅色） */
  theme?: 'light' | 'dark';
  /** 主侧边栏是否折叠（向后兼容：旧配置没有该字段视为展开） */
  sidebarCollapsed?: boolean;
  /** 用户选择「忽略此版本」的版本号（向后兼容：旧配置没有该字段视为没忽略过任何版本） */
  ignoredUpdateVersion?: string;
}

const DEFAULT_CONFIG: PersistedConfig = {
  serverUrl: DEFAULT_SERVER_URL,
  username: '',
  token: null,
  tokenEncrypted: false,
  island: { ...DEFAULT_ISLAND_APPEARANCE },
  homeworkBoard: { ...DEFAULT_HOMEWORK_BOARD },
  notificationChannel: DEFAULT_CLASSISLAND_NOTIFICATION_CHANNEL,
  homeworkPhrases: [...HOMEWORK_PHRASE_DEFAULTS],
  onboardingDone: false,
  theme: 'light',
  sidebarCollapsed: false,
  ignoredUpdateVersion: '',
};

/** 主题白名单：非法值一律回落浅色 */
function normalizeTheme(input?: 'light' | 'dark'): 'light' | 'dark' {
  return input === 'dark' ? 'dark' : 'light';
}

/**
 * 作业快捷短语的合法化：去空白、去重、限长限量。
 * 空数组是**合法值**（老师把短语全删了 = 不想用快捷短语），因此不能拿默认值顶回去。
 */
function normalizeHomeworkPhrases(input?: string[]): string[] {
  if (!Array.isArray(input)) return [...HOMEWORK_PHRASE_DEFAULTS];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const value = raw.trim().slice(0, HOMEWORK_PHRASE_MAX_LENGTH);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
    if (result.length >= HOMEWORK_PHRASE_MAX_COUNT) break;
  }
  return result;
}

/** 通知显示位置的白名单校验：非法值一律回落到默认值，避免坏配置把提醒"静默吞掉" */
function normalizeNotificationChannel(
  input?: ClassIslandNotificationChannel,
): ClassIslandNotificationChannel {
  return CLASSISLAND_NOTIFICATION_CHANNELS.includes(input as ClassIslandNotificationChannel)
    ? (input as ClassIslandNotificationChannel)
    : DEFAULT_CLASSISLAND_NOTIFICATION_CHANNEL;
}

/** 作业页偏好的合法化（模式白名单、字号夹紧） */
function normalizeHomeworkBoard(input?: Partial<HomeworkBoardSettings>): HomeworkBoardSettings {
  const mode = input?.mode === 'list' ? 'list' : 'board';
  const rawFont =
    typeof input?.fontSize === 'number' && Number.isFinite(input.fontSize)
      ? input.fontSize
      : DEFAULT_HOMEWORK_BOARD.fontSize;
  return {
    mode,
    showTime: input?.showTime === true,
    fontSize: Math.min(28, Math.max(11, Math.round(rawFont))),
  };
}

/** 外观字段的合法区间校验（越界值直接夹紧，避免用户配置破坏灵动岛布局） */
function normalizeIslandAppearance(input?: Partial<IslandAppearance>): IslandAppearance {
  const clamp = (value: unknown, min: number, max: number, fallback: number): number => {
    const numeric = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    return Math.min(max, Math.max(min, Math.round(numeric * 100) / 100));
  };
  const positions: IslandAppearance['position'][] = [
    'top-center',
    'top-left',
    'top-right',
    'bottom-center',
    'bottom-left',
    'bottom-right',
  ];
  const styles: IslandAppearance['style'][] = ['black', 'glass', 'tinted'];
  return {
    height: clamp(input?.height, 36, 72, DEFAULT_ISLAND_APPEARANCE.height),
    width: clamp(input?.width, 220, 420, DEFAULT_ISLAND_APPEARANCE.width),
    radius: clamp(input?.radius, 8, 32, DEFAULT_ISLAND_APPEARANCE.radius),
    opacity: clamp(input?.opacity, 0.4, 1, DEFAULT_ISLAND_APPEARANCE.opacity),
    accent:
      typeof input?.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(input.accent)
        ? input.accent
        : DEFAULT_ISLAND_APPEARANCE.accent,
    fontSize: clamp(input?.fontSize, 11, 20, DEFAULT_ISLAND_APPEARANCE.fontSize),
    animations: input?.animations !== false,
    speed: clamp(input?.speed, 0.5, 2, DEFAULT_ISLAND_APPEARANCE.speed),
    position: positions.includes(input?.position as IslandAppearance['position'])
      ? (input?.position as IslandAppearance['position'])
      : DEFAULT_ISLAND_APPEARANCE.position,
    alwaysOnTop: input?.alwaysOnTop !== false,
    style: styles.includes(input?.style as IslandAppearance['style'])
      ? (input?.style as IslandAppearance['style'])
      : DEFAULT_ISLAND_APPEARANCE.style,
    idleSliver: input?.idleSliver === true,
    marginX: clamp(input?.marginX, 0, 200, DEFAULT_ISLAND_APPEARANCE.marginX),
    marginY: clamp(input?.marginY, 0, 160, DEFAULT_ISLAND_APPEARANCE.marginY),
    followCursorDisplay: input?.followCursorDisplay === true,
  };
}

function configFilePath(): string {
  return path.join(app.getPath('userData'), 'config.json');
}

function encryptToken(token: string | null): { token: string | null; tokenEncrypted: boolean } {
  if (!token) return { token: null, tokenEncrypted: false };
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return { token: safeStorage.encryptString(token).toString('base64'), tokenEncrypted: true };
    }
  } catch {
    // 见下方降级分支
  }
  // 降级为明文存储（DPAPI 不可用，一般只在本地开发环境出现）。
  // 必须留下日志：明文 token 代表该班的全班身份，任何能读用户目录的进程/备份/同步盘都能拿到，
  // 静默降级会让"为什么换个环境就得重新登录/凭据是怎么泄露的"无从查起。
  logger.warn(
    `系统加密存储不可用，登录令牌将以**明文**写入配置（${configFilePath()}）；` +
      '如需加密请确认 Windows 凭据保护（DPAPI）可用',
  );
  return { token, tokenEncrypted: false };
}

function decryptToken(raw: PersistedConfig): string | null {
  if (!raw.token) return null;
  if (!raw.tokenEncrypted) return raw.token;
  try {
    return safeStorage.decryptString(Buffer.from(raw.token, 'base64'));
  } catch {
    return null;
  }
}

function readPersistedFromDisk(): PersistedConfig {
  try {
    const content = fs.readFileSync(configFilePath(), 'utf8');
    const parsed = JSON.parse(content) as Partial<PersistedConfig>;
    return {
      serverUrl:
        typeof parsed.serverUrl === 'string' && parsed.serverUrl
          ? (normalizeServerUrl(parsed.serverUrl) ?? DEFAULT_CONFIG.serverUrl)
          : DEFAULT_CONFIG.serverUrl,
      username: typeof parsed.username === 'string' ? parsed.username : '',
      token: typeof parsed.token === 'string' ? parsed.token : null,
      tokenEncrypted: parsed.tokenEncrypted === true,
      island: normalizeIslandAppearance(parsed.island),
      homeworkBoard: normalizeHomeworkBoard(parsed.homeworkBoard),
      notificationChannel: normalizeNotificationChannel(parsed.notificationChannel),
      homeworkPhrases: normalizeHomeworkPhrases(parsed.homeworkPhrases),
      onboardingDone: parsed.onboardingDone === true,
      theme: normalizeTheme(parsed.theme),
      sidebarCollapsed: parsed.sidebarCollapsed === true,
      ignoredUpdateVersion:
        typeof parsed.ignoredUpdateVersion === 'string' ? parsed.ignoredUpdateVersion : '',
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/* ------------------------------------------------------------ 内存缓存 + 异步合并写
 *
 * 为什么不能每次 saveConfig 都同步读写盘（原来的写法）：
 * 侧栏折叠（`stores/ui.ts` 的 toggleSidebar）、主题切换、通知渠道、作业看板偏好、登录/登出
 * 全都走 `saveConfig`，而它一次调用要做「readFileSync + JSON.parse + 8 个 normalize」**两遍**
 * （开头读一遍、结尾 `getConfig()` 又读一遍）+ `writeFileSync` 一遍 + DPAPI 解密一遍，
 * **全部同步跑在主进程主线程上**。主进程是 Electron 的消息泵进程，被它摁住的那一拍
 * 渲染进程也跟着掉帧 —— 用户反馈的"点汉堡展开/收回侧栏时卡一下"就是这一拍。
 *
 * 现在：配置常驻内存（连已解密的 token 一起缓存），写盘改成**异步 + 合并** ——
 * 同一拍内的多次改动只落最后一次，写入串行不会互相覆盖；退出前由 `flushConfigSync()` 兜底。
 *
 * **语义变化（有意为之）**：`saveConfig()` 返回时数据可能还没落盘（延迟 CONFIG_WRITE_DEBOUNCE_MS）。
 * 正常退出（托盘 → 退出）会走 `flushConfigSync()`，不会丢最后一次改动；只有进程被强杀
 * 才可能丢这最后 120ms 内的改动。
 */

/** 写入合并窗口：拖动同类控件（滑块/连续点击）时的连续改动只落最后一次 */
const CONFIG_WRITE_DEBOUNCE_MS = 120;

interface ConfigCache {
  config: PersistedConfig;
  /** 已解密的登录令牌（null = 未登录 / 解密失败）。缓存它是为了不再每次都走一遍 DPAPI */
  token: string | null;
}

/**
 * 内存配置。**必须懒初始化**：`main/index.ts` 会先 `app.setPath('userData', smokeProfile)`
 * 把配置目录指到冒烟专用 profile，之后才第一次读配置；在模块顶层立即读盘会读错文件。
 */
let cache: ConfigCache | null = null;

function loadCache(): ConfigCache {
  if (cache) return cache;
  const config = readPersistedFromDisk();
  cache = { config, token: decryptToken(config) };
  return cache;
}

/** 待写入的配置快照（合并窗口内只保留最后一次） */
let pendingWrite: PersistedConfig | null = null;
let writeTimer: ReturnType<typeof setTimeout> | null = null;
/** 是否有一次异步写入正在进行（用它把写入串行化，避免两次写互相覆盖） */
let writing = false;

/** 排一次落盘。合并窗口内的多次调用只会写最后一次；`immediate` 用于不该被延迟的场景 */
function scheduleWrite(config: PersistedConfig, immediate = false): void {
  pendingWrite = config;
  if (immediate) {
    if (writeTimer !== null) {
      clearTimeout(writeTimer);
      writeTimer = null;
    }
    void flushConfigAsync();
    return;
  }
  // 已有待写任务（定时器在跑或正在写）：内容已经记在 pendingWrite 里，等它自己收尾即可。
  // 正在写的那次结束后会再检查一次 pendingWrite（见 flushConfigAsync 的 finally）。
  if (writeTimer !== null || writing) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    void flushConfigAsync();
  }, CONFIG_WRITE_DEBOUNCE_MS);
}

/** 异步落盘（不阻塞主进程消息泵）。失败只记日志 —— 与 readPersistedFromDisk 的容错口径一致 */
async function flushConfigAsync(): Promise<void> {
  if (writing) return;
  const target = pendingWrite;
  if (!target) return;
  pendingWrite = null;
  writing = true;
  // 先把内容序列化下来：写入期间的后续改动由 pendingWrite 负责补一次，
  // 不会出现"这一次写的是半新半旧的对象"
  const payload = JSON.stringify(target, null, 2);
  try {
    const file = configFilePath();
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, payload, 'utf8');
  } catch (error) {
    logger.warn(`写入配置失败（${configFilePath()}）：${error instanceof Error ? error.message : error}`);
  } finally {
    writing = false;
    // 写入期间又有改动：再写一次（内容已被 pendingWrite 合并成最后一次）
    if (pendingWrite) void flushConfigAsync();
  }
}

/**
 * 退出前同步落地一次（`main/index.ts` 的 shutdownResources 调用）。
 *
 * 即使没有待写内容也把内存里的配置重写一遍：那一时刻可能正有一次异步写在进行中，
 * 它未必来得及完成；退出时多写一次的代价可以忽略。
 */
export function flushConfigSync(): void {
  if (writeTimer !== null) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  const target = pendingWrite ?? cache?.config ?? null;
  if (!target) return;
  pendingWrite = null;
  try {
    const file = configFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(target, null, 2), 'utf8');
  } catch (error) {
    logger.warn(
      `退出前写入配置失败（${configFilePath()}）：${error instanceof Error ? error.message : error}`,
    );
  }
}

/**
 * 服务器地址只接受 http/https 绝对地址。
 *
 * 渲染进程的输入框走 `normalizeServerUrl` 校验过，但 IPC（`saveConfig`）与手工改过的
 * config.json 都会绕过它，而该值随后会作为 axios baseURL 与 Socket.IO 地址使用 ——
 * 因此必须在**主进程这一侧也收口**，非法值一律丢弃（保留原值）。
 */
function normalizeServerUrl(input: string): string | null {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return trimmed;
  } catch {
    return null;
  }
}

/** 由内存缓存组装对渲染进程暴露的配置（不再读盘、不再解密） */
function toDesktopConfig(state: ConfigCache): DesktopStoredConfig {
  const persisted = state.config;
  return {
    serverUrl: persisted.serverUrl,
    username: persisted.username,
    token: state.token,
    island: normalizeIslandAppearance(persisted.island),
    homeworkBoard: normalizeHomeworkBoard(persisted.homeworkBoard),
    notificationChannel: normalizeNotificationChannel(persisted.notificationChannel),
    homeworkPhrases: normalizeHomeworkPhrases(persisted.homeworkPhrases),
    onboardingDone: persisted.onboardingDone === true,
    theme: normalizeTheme(persisted.theme),
    sidebarCollapsed: persisted.sidebarCollapsed === true,
    ignoredUpdateVersion: persisted.ignoredUpdateVersion ?? '',
  };
}

/** 读取配置（token 已解密），供渲染进程使用 */
export function getConfig(): DesktopStoredConfig {
  return toDesktopConfig(loadCache());
}

/** 局部更新配置：只覆盖传入的字段 */
export function saveConfig(patch: Partial<DesktopStoredConfig>): DesktopStoredConfig {
  const state = loadCache();
  const persisted = state.config;

  if (typeof patch.serverUrl === 'string' && patch.serverUrl.trim()) {
    const normalized = normalizeServerUrl(patch.serverUrl);
    if (normalized) persisted.serverUrl = normalized;
    else logger.warn(`忽略非法的服务器地址（只接受 http/https）：${patch.serverUrl}`);
  }
  if (typeof patch.username === 'string') {
    persisted.username = patch.username;
  }
  if (patch.island !== undefined) {
    persisted.island = normalizeIslandAppearance({ ...persisted.island, ...patch.island });
  }
  if (patch.homeworkBoard !== undefined) {
    persisted.homeworkBoard = normalizeHomeworkBoard({
      ...persisted.homeworkBoard,
      ...patch.homeworkBoard,
    });
  }
  if (patch.homeworkPhrases !== undefined) {
    persisted.homeworkPhrases = normalizeHomeworkPhrases(patch.homeworkPhrases);
  }
  if (patch.notificationChannel !== undefined) {
    persisted.notificationChannel = normalizeNotificationChannel(patch.notificationChannel);
  }
  // 引导只接受"已看过"：重看入口不走这里（看过与否只有 true 与"没看过"两种状态，
  // 想 re-arm 只能清配置 clearConfig）。传 false 一律忽略，避免任何调用点误把用户退回首启状态。
  if (patch.onboardingDone === true) {
    persisted.onboardingDone = true;
  }
  if (patch.theme !== undefined) {
    persisted.theme = normalizeTheme(patch.theme);
  }
  if (patch.sidebarCollapsed !== undefined) {
    persisted.sidebarCollapsed = patch.sidebarCollapsed === true;
  }
  // 空串是合法值（= 没有忽略任何版本），因此这里只判类型不判空
  if (typeof patch.ignoredUpdateVersion === 'string') {
    persisted.ignoredUpdateVersion = patch.ignoredUpdateVersion;
  }
  if (patch.token !== undefined) {
    const encrypted = encryptToken(patch.token);
    persisted.token = encrypted.token;
    persisted.tokenEncrypted = encrypted.tokenEncrypted;
    // 明文一并进缓存：既省掉一次 DPAPI 解密，也保证紧接着的 getConfig() 读到的就是刚存的令牌
    state.token = patch.token;
  }

  scheduleWrite(persisted);
  return toDesktopConfig(state);
}

/** 清空为默认配置（退出登录 / 重置）。立即落盘：它对应退出登录，不该被合并窗口延迟 */
export function clearConfig(): DesktopStoredConfig {
  const state: ConfigCache = { config: { ...DEFAULT_CONFIG }, token: null };
  cache = state;
  scheduleWrite(state.config, true);
  return toDesktopConfig(state);
}

export function getConfigPath(): string {
  return configFilePath();
}
