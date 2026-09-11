import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { NotificationDto } from '@classhelper/shared';
import { notificationApi } from '../api/index.js';
import { cacheSet } from '../cache/db.js';
import { fetchWithCache } from '../cache/index.js';
import { useAppStore } from './app.js';

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
    loading.value = true;
    try {
      const result = await fetchWithCache<NotificationDto[]>(
        'notifications',
        currentKey(),
        () => notificationApi.list(),
        [],
      );
      items.value = result.data;
      fromCache.value = result.fromCache;
      updatedAt.value = result.updatedAt;
      error.value = result.error;
      recount();
      if (!result.fromCache) useAppStore().markSynced();
    } finally {
      loading.value = false;
    }
  }

  /** 实时推送：插入到列表头部并写回缓存 */
  async function pushRealtime(payload: NotificationDto): Promise<void> {
    if (items.value.some((item) => item.id === payload.id)) return;
    items.value = [{ ...payload, read: false }, ...items.value];
    recount();
    await persist();
  }

  async function markRead(id: string): Promise<void> {
    await notificationApi.markRead(id);
    const target = items.value.find((item) => item.id === id);
    if (target) {
      target.read = true;
      target.readAt = new Date().toISOString();
    }
    recount();
    await persist();
  }

  async function markAllRead(): Promise<number> {
    const result = await notificationApi.markAllRead();
    const now = new Date().toISOString();
    items.value = items.value.map((item) => ({ ...item, read: true, readAt: item.readAt ?? now }));
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
    markRead,
    markAllRead,
    refreshUnreadCount,
  };
});
