import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { NotificationDto } from '@classhelper/shared';
import { notificationApi } from '../api/index.js';
import { cacheSet } from '../cache/db.js';
import { fetchWithCache } from '../cache/index.js';
import { useAppStore } from './app.js';
import { getCacheScope, onCacheScopeChanged } from '../cache/scope.js';

/**
 * 通知状态：列表 + 未读数。
 * 抽成 store 是因为侧边栏红点与通知页共用同一份数据，
 * 同时所有变更都会同步写回 IndexedDB，保证离线可见。
 */
export const useNotificationStore = defineStore('notifications', () => {
  const items = ref<NotificationDto[]>([]);
  const unreadCount = ref(0);
  const loading = ref(false);
  const fromCache = ref(false);
  const updatedAt = ref<number | null>(null);
  const error = ref<string | null>(null);
  let requestId = 0;
  let revision = 0;
  const changes = new Map<string, { revision: number; value: NotificationDto | null }>();
  onCacheScopeChanged(() => {
    requestId += 1;
    revision = 0;
    changes.clear();
    items.value = [];
    unreadCount.value = 0;
    loading.value = false;
    fromCache.value = false;
    updatedAt.value = null;
    error.value = null;
  });
  function changed(id: string, value: NotificationDto | null): void {
    changes.set(id, { revision: ++revision, value });
  }

  const unreadItems = computed(() => items.value.filter((item) => !item.read));

  function currentKey(): string {
    return 'self';
  }

  async function persist(): Promise<void> {
    await cacheSet('notifications', currentKey(), items.value).catch(() => undefined);
  }

  function recount(): void {
    unreadCount.value = items.value.filter((item) => !item.read).length;
  }

  async function load(): Promise<void> {
    const request = ++requestId;
    const scope = getCacheScope();
    const startedAt = revision;
    loading.value = true;
    try {
      const result = await fetchWithCache<NotificationDto[]>(
        'notifications',
        currentKey(),
        () => notificationApi.list(),
        [],
      );
      if (request !== requestId || scope !== getCacheScope()) return;
      const merged = new Map(result.data.map((item) => [item.id, item]));
      for (const [id, change] of changes) {
        if (change.revision <= startedAt) continue;
        if (change.value) merged.set(id, change.value);
        else merged.delete(id);
      }
      items.value = [...merged.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      changes.clear();
      fromCache.value = result.fromCache;
      updatedAt.value = result.updatedAt;
      error.value = result.error;
      recount();
      await persist();
      if (!result.fromCache) useAppStore().markSynced();
    } finally {
      if (request === requestId) loading.value = false;
    }
  }

  /** 实时推送：插入到列表头部并写回缓存 */
  async function pushRealtime(payload: NotificationDto): Promise<void> {
    if (items.value.some((item) => item.id === payload.id)) return;
    items.value = [{ ...payload, read: false }, ...items.value];
    changed(payload.id, items.value[0]!);
    recount();
    await persist();
  }

  async function removeRealtime(id: string): Promise<void> {
    items.value = items.value.filter((item) => item.id !== id);
    changed(id, null);
    recount();
    await persist();
  }

  async function markRead(id: string): Promise<void> {
    await notificationApi.markRead(id);
    const target = items.value.find((item) => item.id === id);
    if (target) {
      target.read = true;
      target.readAt = new Date().toISOString();
      changed(id, { ...target });
    }
    recount();
    await persist();
  }

  async function markAllRead(): Promise<number> {
    const result = await notificationApi.markAllRead();
    const now = new Date().toISOString();
    items.value = items.value.map((item) => ({ ...item, read: true, readAt: item.readAt ?? now }));
    for (const item of items.value) changed(item.id, item);
    recount();
    await persist();
    return result.marked;
  }

  async function refreshUnreadCount(): Promise<void> {
    try {
      const result = await notificationApi.unreadCount();
      unreadCount.value = result.count;
    } catch {
      // 离线时保留缓存推算出的未读数
    }
  }

  return {
    items,
    unreadItems,
    unreadCount,
    loading,
    fromCache,
    updatedAt,
    error,
    load,
    pushRealtime,
    removeRealtime,
    markRead,
    markAllRead,
    refreshUnreadCount,
  };
});
