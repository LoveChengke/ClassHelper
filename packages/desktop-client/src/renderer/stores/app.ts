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

  /** 请求拦截器会把每次请求的结果回报过来，这里据此维护可达性 */
  setReachabilityReporter((reachable) => {
    if (reachable && !serverReachable.value && initialized.value) {
      serverReachable.value = true;
      notifyRecovered();
      return;
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
