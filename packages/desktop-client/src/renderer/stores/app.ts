import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { STORAGE_KEYS, formatDate } from '@classhelper/shared';
import { pingHealth, setApiBaseUrl, setReachabilityReporter } from '../api/http.js';
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
    init,
    ping,
    applyServerUrl,
    refreshCacheStats,
    clearCache,
    markSynced,
    onServerRecovered,
    offServerRecovered,
    stopHealthPolling,
  };
});
