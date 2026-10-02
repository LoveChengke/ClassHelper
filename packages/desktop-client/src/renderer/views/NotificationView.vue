<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import {
  PRIORITY_LABELS,
  PRIORITY_TAG_TYPES,
  formatDate,
  relativeTime,
  type NotificationDto,
  type NotificationPriority,
} from '@classhelper/shared';
import { useAppStore } from '../stores/app.js';
import { useNotificationStore } from '../stores/notifications.js';

const appStore = useAppStore();
const store = useNotificationStore();

const filter = ref<'all' | 'unread'>('all');
const detailVisible = ref(false);
const current = ref<NotificationDto | null>(null);
const marking = ref(false);

const visibleItems = computed(() =>
  filter.value === 'unread' ? store.items.filter((item) => !item.read) : store.items,
);

async function openDetail(item: NotificationDto): Promise<void> {
  current.value = item;
  detailVisible.value = true;
  if (!item.read) await markRead(item);
}

async function markRead(item: NotificationDto): Promise<void> {
  if (appStore.offline || item.read) return;
  marking.value = true;
  try {
    await store.markRead(item.id);
    if (current.value?.id === item.id) current.value = { ...item, read: true };
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '标记已读失败');
  } finally {
    marking.value = false;
  }
}

async function markAll(): Promise<void> {
  if (appStore.offline) {
    ElMessage.warning('离线状态下无法同步已读状态');
    return;
  }
  marking.value = true;
  try {
    const marked = await store.markAllRead();
    ElMessage.success(`已将 ${marked} 条通知标为已读`);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '操作失败');
  } finally {
    marking.value = false;
  }
}

onMounted(async () => {
  await store.load().catch(() => undefined);
  await store.refreshUnreadCount();
});

onUnmounted(() => {
  // store 是全局的，这里无需清理；保留钩子以便将来取消订阅
});
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">通知</h2>
        <p class="page-subtitle">
          共 {{ store.items.length }} 条 · 未读 {{ store.unreadCount }} 条
          <el-tag v-if="store.fromCache" size="small" type="warning" effect="plain">离线缓存</el-tag>
        </p>
      </div>
      <div class="toolbar">
        <el-radio-group v-model="filter">
          <el-radio-button value="all">全部</el-radio-button>
          <el-radio-button value="unread">未读</el-radio-button>
        </el-radio-group>
        <el-button :loading="marking" :disabled="store.unreadCount === 0" @click="markAll">
          全部已读
        </el-button>
        <el-button :icon="'Refresh'" @click="store.load()">刷新</el-button>
      </div>
    </div>

    <el-card v-loading="store.loading" shadow="never">
      <el-empty v-if="visibleItems.length === 0" description="暂无通知" />
      <ul v-else class="notice-list">
        <li
          v-for="item in visibleItems"
          :key="item.id"
          class="notice-item"
          :class="{ unread: !item.read }"
          @click="openDetail(item)"
        >
          <div class="notice-main">
            <div class="notice-title">
              <span v-if="!item.read" class="unread-dot"></span>
              <el-tag
                :type="PRIORITY_TAG_TYPES[item.priority as NotificationPriority]"
                size="small"
                effect="light"
              >
                {{ PRIORITY_LABELS[item.priority as NotificationPriority] }}
              </el-tag>
              <span class="title-text">{{ item.title }}</span>
            </div>
            <div class="notice-content">{{ item.content }}</div>
          </div>
          <div class="notice-meta">
            <div>{{ relativeTime(item.createdAt) }}</div>
            <div class="text-muted">{{ formatDate(item.createdAt, true) }}</div>
            <el-tag v-if="item.read" size="small" type="info" effect="plain">已读</el-tag>
            <el-tag v-else size="small" type="danger" effect="plain">未读</el-tag>
          </div>
        </li>
      </ul>
    </el-card>

    <el-drawer v-model="detailVisible" size="46%" :title="current?.title ?? '通知详情'">
      <template v-if="current">
        <div class="drawer-meta">
          <el-tag :type="PRIORITY_TAG_TYPES[current.priority as NotificationPriority]" size="small">
            {{ PRIORITY_LABELS[current.priority as NotificationPriority] }}
          </el-tag>
          <span class="text-muted">{{ formatDate(current.createdAt, true) }}</span>
          <span class="text-muted">发布人：{{ current.creator?.name ?? '-' }}</span>
        </div>
        <p class="content-block">{{ current.content }}</p>
        <el-alert
          v-if="!current.read && appStore.offline"
          type="warning"
          :closable="false"
          title="离线状态：已读状态将在恢复网络后同步"
        />
      </template>
    </el-drawer>
  </div>
</template>

<style scoped>
.notice-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.notice-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 6px;
  border-bottom: 1px dashed var(--ch-border);
  cursor: pointer;
  border-radius: 6px;
}

.notice-item:hover {
  background: var(--ch-hover-soft);
}

.notice-item.unread {
  background: var(--ch-accent-soft);
}

.notice-item:last-child {
  border-bottom: none;
}

.notice-main {
  flex: 1;
  min-width: 0;
}

.notice-title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.title-text {
  font-weight: 600;
}

.notice-content {
  margin-top: 6px;
  font-size: 13px;
  color: var(--ch-text-secondary);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.notice-meta {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  font-size: 12px;
  white-space: nowrap;
}

.drawer-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
}

.content-block {
  white-space: pre-wrap;
  line-height: 1.8;
  background: var(--ch-layer-alt);
  border-radius: 8px;
  padding: 14px;
  margin: 0 0 16px;
}
</style>
