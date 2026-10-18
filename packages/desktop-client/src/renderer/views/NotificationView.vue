<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import {
  NOTIFICATION_PRIORITIES,
  PRIORITY_LABELS,
  PRIORITY_TAG_TYPES,
  dayKeyLocal,
  formatDate,
  relativeTime,
  shiftDayKey,
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

/* ------------------------------------------------------- 按天归档 / 按发布人 / 按类型 */
/**
 * 三个筛选都在**已加载的列表**上做，不再请求服务端：
 * 客户端是离线优先的（AGENTS.md 的现行工程约定），断网回退缓存时归档功能必须照常可用。
 * 口径与服务端一致：按 `assignDate`（本地日期）分组 —— 用 createdAt 的 UTC 切片会把晚上
 * 发出来的通知算到第二天（AGENTS.md 的现行工程约定）。
 */
const dayFilter = ref('');
const creatorFilter = ref('');
const priorityFilter = ref('');

/**
 * 一条通知归到哪一天。
 * `assignDate` 是服务端新加的字段，但**离线缓存里可能还留着加字段之前的旧数据**，
 * 所以这里按 createdAt 的本地日期兜底，避免分组头显示成 "undefined"。
 */
function assignDay(item: NotificationDto): string {
  return item.assignDate || dayKeyLocal(new Date(item.createdAt));
}

const dayOptions = computed(() => {
  const map = new Map<string, number>();
  for (const item of store.items) {
    const day = assignDay(item);
    map.set(day, (map.get(day) ?? 0) + 1);
  }
  return [...map.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, count]) => ({ date, count }));
});

const creatorOptions = computed(() => {
  const map = new Map<string, { name: string; count: number }>();
  for (const item of store.items) {
    const previous = map.get(item.createdBy);
    map.set(item.createdBy, {
      name: item.creator?.name ?? '未知',
      count: (previous?.count ?? 0) + 1,
    });
  }
  return [...map.entries()].map(([id, value]) => ({ id, ...value }));
});

const hasFilter = computed(() => Boolean(dayFilter.value || creatorFilter.value || priorityFilter.value));

const filteredItems = computed(() =>
  visibleItems.value.filter(
    (item) =>
      (!dayFilter.value || assignDay(item) === dayFilter.value) &&
      (!creatorFilter.value || item.createdBy === creatorFilter.value) &&
      (!priorityFilter.value || item.priority === priorityFilter.value),
  ),
);

/** 按所属日期分块（同一天一块，块头显示"今天/昨天 + 日期 + 条数"） */
const groupedItems = computed(() => {
  const groups = new Map<string, NotificationDto[]>();
  for (const item of filteredItems.value) {
    const day = assignDay(item);
    const list = groups.get(day);
    if (list) list.push(item);
    else groups.set(day, [item]);
  }
  return [...groups.entries()].map(([date, items]) => ({ date, items }));
});

function dayLabel(date: string): string {
  const today = dayKeyLocal(new Date());
  if (date === today) return '今天';
  if (date === shiftDayKey(today, -1)) return '昨天';
  return date;
}

function resetFilters(): void {
  dayFilter.value = '';
  creatorFilter.value = '';
  priorityFilter.value = '';
}

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
          <span v-if="hasFilter">· 筛选后 {{ filteredItems.length }} 条</span>
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
      <!-- 按天归档 + 按发布人 + 按类型；都在本地已加载的列表上筛（离线也能用） -->
      <div class="notice-filters">
        <el-select v-model="dayFilter" placeholder="按天归档" clearable size="small" style="width: 150px">
          <el-option
            v-for="item in dayOptions"
            :key="item.date"
            :label="`${item.date}（${item.count}）`"
            :value="item.date"
          />
        </el-select>
        <el-select
          v-model="creatorFilter"
          placeholder="全部发布人"
          clearable
          size="small"
          style="width: 150px"
        >
          <el-option
            v-for="item in creatorOptions"
            :key="item.id"
            :label="`${item.name}（${item.count}）`"
            :value="item.id"
          />
        </el-select>
        <el-select
          v-model="priorityFilter"
          placeholder="全部类型"
          clearable
          size="small"
          style="width: 130px"
        >
          <el-option
            v-for="item in NOTIFICATION_PRIORITIES"
            :key="item"
            :label="PRIORITY_LABELS[item]"
            :value="item"
          />
        </el-select>
        <el-button v-if="hasFilter" link type="primary" size="small" @click="resetFilters">
          清除筛选
        </el-button>
      </div>

      <el-empty v-if="filteredItems.length === 0" description="暂无通知" />
      <div v-else class="notice-groups">
        <section v-for="group in groupedItems" :key="group.date" class="notice-group">
          <div class="notice-group__header">
            <span>{{ dayLabel(group.date) }}</span>
            <span class="text-muted">{{ group.date }} · {{ group.items.length }} 条</span>
          </div>
          <ul class="notice-list">
            <li
              v-for="item in group.items"
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
        </section>
      </div>
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
.notice-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.notice-group + .notice-group {
  margin-top: 10px;
}

.notice-group__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 6px 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--ch-text-secondary);
  border-bottom: 1px solid var(--ch-border);
}

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
