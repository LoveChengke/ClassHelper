import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import {
  DEFAULT_CLASSISLAND_NOTIFICATION_CHANNEL,
  STORAGE_KEYS,
  formatDate,
  type ClassIslandNotificationChannel,
} from '@classhelper/shared';
import { pingHealth, setApiBaseUrl, setReachabilityReporter } from '../api/http.js';
import { classChannelApi } from '../api/index.js';
import { cacheClearAll, cacheStats, type CacheStoreStat } from '../cache/db.js';
import { DEFAULT_SERVER, normalizeServerUrl } from '../config.js';

type RecoveryHandler = () => void;

/**
 * 「本次离线从什么时候开始」的本地时间戳键（需求 11）。
 *
 * 为什么用 localStorage 而不是主进程配置（config.json）：
 * 它是一个**瞬时状态**，只描述"当前这一轮断网"，一旦补弹完成（或进程重启后重新联网）就作废，
 * 不需要跨进程读、也不需要跟着设备身份走。放 localStorage 有三点好处：
 *  - 写入发生在每次请求的**可达性回调**里（高频路径），localStorage 是同步内存写，
 *    不会像 saveConfig 那样排一次主进程 IPC + 120ms 合并窗口；
 *  - 它是**渲染进程自己**的读-改-清闭环（bridge.ts 读它 → 补弹 → 清掉），不跨越 contextBridge；
 *  - 跨重启也够用：网页存储随 profile 持久化，补弹窗口本来就只关心"最近一次离线"。
 */
const OFFLINE_SINCE_KEY = 'classhelper.offlineSince';

/**
 * 记下"本次离线从什么时候开始"（ISO 字符串）。
 * 读不到 / 写不进（隐私模式、存储被清）时静默跳过 —— 补弹只是锦上添花，不该影响可达性上报。
 */
function markOfflineSince(): void {
  try {
    const now = new Date().toISOString();
    localStorage.setItem(OFFLINE_SINCE_KEY, now);
    console.info(`[离线] 已记录本次离线起点：${now}`);
  } catch {
    // 存储不可用：这次不补弹，但联网后的恢复流程照常
  }
}

/** 读本次离线起点（ISO 字符串）；没有记录（首次启动 / 一直在线）返回 null */
export function readOfflineSince(): string | null {
  try {
    return localStorage.getItem(OFFLINE_SINCE_KEY);
  } catch {
    return null;
  }
}

/** 清掉离线起点：补弹完成后调用，避免同一次离线被重复补弹 */
export function clearOfflineSince(): void {
  try {
    localStorage.removeItem(OFFLINE_SINCE_KEY);
  } catch {
    // 清不掉也不影响功能：下一次"由可达变不可达"会覆盖它
  }
}

/**
 * 应用级状态：服务器地址、可达性、离线缓存统计、同步时间。
 * 「联网后自动同步」的触发点就在 ping() 里：不可达 -> 可达 时通知所有订阅者刷新数据。
 */
export const useAppStore = defineStore('app', () => {
  const serverUrl = ref(DEFAULT_SERVER);
  const serverReachable = ref(false);
  const lastSyncAt = ref<number | null>(null);
  const cacheStoreStats = ref<CacheStoreStat[]>([]);
  const currentWeek = ref(1);
  const maxWeek = ref(20);
  const initialized = ref(false);
  /**
   * 通知显示位置：这台教室机器把提醒弹在哪个端。
   *
   * 单一事实来源是**班级记录**（服务端），本地这份只是缓存：断网时也要能按上次的选择
   * 决定本机弹不弹，所以启动时先读本地配置、登录后再向服务器对齐一次。
   */
  const notificationChannel = ref<ClassIslandNotificationChannel>(DEFAULT_CLASSISLAND_NOTIFICATION_CHANNEL);

  const offline = computed(() => !serverReachable.value);
  const lastSyncText = computed(() => (lastSyncAt.value ? formatDate(lastSyncAt.value, true) : '尚未同步'));
  const cacheItemCount = computed(() => cacheStoreStats.value.reduce((sum, item) => sum + item.count, 0));

  const recoveryHandlers = new Set<RecoveryHandler>();
  let healthTimer: ReturnType<typeof setInterval> | null = null;

  function onServerRecovered(handler: RecoveryHandler): void {
    recoveryHandlers.add(handler);
  }

  function offServerRecovered(handler: RecoveryHandler): void {
    recoveryHandlers.delete(handler);
  }

  /**
   * 请求拦截器会把每次请求的结果回报过来，这里据此维护可达性。
   *
   * 「由可达变不可达」的那一刻顺手记下离线起点（需求 11 的补弹基准）：
   * 只在**边界**上写，不在"一直不可达"的每次请求上重复覆盖，否则补弹窗口会被不停地
   * 推迟到"最后一次失败"，离线期间收到的通知就永远落在窗口之外了。
   */
  setReachabilityReporter((reachable) => {
    if (reachable && !serverReachable.value && initialized.value) {
      serverReachable.value = true;
      notifyRecovered();
      return;
    }
    if (!reachable && serverReachable.value && initialized.value) {
      markOfflineSince();
    }
    serverReachable.value = reachable;
  });

  function notifyRecovered(): void {
    for (const handler of recoveryHandlers) handler();
  }

  async function ping(): Promise<void> {
    const result = await pingHealth();
    if (result.ok) {
      if (!serverReachable.value && initialized.value) notifyRecovered();
      serverReachable.value = true;
    } else {
      // 健康探针是机器**空闲时唯一**的可达性信号（没有任何业务请求在跑），
      // 所以这条路径也要记离线起点，否则空闲断网期间收到的通知补不回来。
      if (serverReachable.value && initialized.value) markOfflineSince();
      serverReachable.value = false;
    }
  }

  function startHealthPolling(): void {
    if (healthTimer) return;
    healthTimer = setInterval(() => {
      void ping();
    }, 20000);
  }

  function stopHealthPolling(): void {
    if (!healthTimer) return;
    clearInterval(healthTimer);
    healthTimer = null;
  }

  async function applyServerUrl(next: string): Promise<boolean> {
    const normalized = normalizeServerUrl(next);
    if (!normalized) return false;
    serverUrl.value = normalized;
    setApiBaseUrl(normalized);
    localStorage.setItem(STORAGE_KEYS.serverUrl, normalized);
    if (window.desktop) await window.desktop.saveConfig({ serverUrl: normalized });
    return true;
  }

  async function refreshCacheStats(): Promise<void> {
    try {
      cacheStoreStats.value = await cacheStats();
    } catch {
      cacheStoreStats.value = [];
    }
  }

  async function clearCache(): Promise<void> {
    await cacheClearAll();
    await refreshCacheStats();
  }

  async function init(serverFromConfig: string): Promise<void> {
    if (serverFromConfig) await applyServerUrl(serverFromConfig);
    await refreshCacheStats();
    await ping();
    startHealthPolling();
    initialized.value = true;
  }

  function markSynced(): void {
    lastSyncAt.value = Date.now();
    void refreshCacheStats();
  }

  /* ------------------------------------------------------------ 通知显示位置 */

  /** 启动时用本地配置兜底（此时可能还没登录/断网） */
  function applyLocalNotificationChannel(value: ClassIslandNotificationChannel): void {
    notificationChannel.value = value;
  }

  /**
   * 向服务器对齐显示位置。
   * 登录后调用：以服务端为准（多台机器/老师改过之后，本地缓存可能已经过期）。
   */
  async function loadNotificationChannel(classId: string | null): Promise<void> {
    if (!classId) return;
    try {
      const result = await classChannelApi.get(classId);
      notificationChannel.value = result.notificationChannel;
      await window.desktop?.saveConfig({ notificationChannel: result.notificationChannel });
    } catch {
      // 离线/无权限：保留本地值，不影响展示
    }
  }

  /**
   * 改显示位置：先落本地（立刻生效），再写回班级记录。
   * 服务端写失败时返回 false，由设置页提示"已保存在本机，联网后请重试"。
   */
  async function setNotificationChannel(
    classId: string | null,
    value: ClassIslandNotificationChannel,
  ): Promise<boolean> {
    notificationChannel.value = value;
    await window.desktop?.saveConfig({ notificationChannel: value });
    if (!classId) return false;
    try {
      const result = await classChannelApi.set(classId, value);
      notificationChannel.value = result.notificationChannel;
      return true;
    } catch {
      return false;
    }
  }

  /** 本次提醒是否要在本机弹（弹窗 + 灵动岛）；"只在 ClassIsland 上弹"时为 false */
  function shouldPopupLocally(): boolean {
    return notificationChannel.value !== 'classisland';
  }

  return {
    serverUrl,
    serverReachable,
    offline,
    lastSyncAt,
    lastSyncText,
    cacheStoreStats,
    cacheItemCount,
    currentWeek,
    maxWeek,
    initialized,
    notificationChannel,
    init,
    ping,
    applyServerUrl,
    applyLocalNotificationChannel,
    loadNotificationChannel,
    setNotificationChannel,
    shouldPopupLocally,
    refreshCacheStats,
    clearCache,
    markSynced,
    onServerRecovered,
    offServerRecovered,
    stopHealthPolling,
  };
});
