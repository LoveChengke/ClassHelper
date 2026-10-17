<script setup lang="ts">
import { computed } from 'vue';
import {
  PRIORITY_RANK,
  PRIORITY_LABELS,
  formatDate,
  islandListLayout,
  ISLAND_SIZE_DELTA,
  type IslandState,
  type IslandAppearance,
  type IslandNotification,
  type IslandNotificationKind,
} from '@classhelper/shared';
const props = defineProps<{ state: IslandState; appearance: IslandAppearance; maxHeight: number }>();
const state = computed(() => props.state);
const appearance = computed(() => props.appearance);
const notification = computed(() => state.value.active);
const isUrgent = computed(() => notification.value?.priority === 'URGENT');
const isCall = computed(() => notification.value?.kind === 'call');
const isHomework = computed(() => notification.value?.kind === 'homework');
const pendingNotifications = computed(() =>
  [
    ...new Map(
      [state.value.active, ...state.value.queued]
        .filter((n): n is IslandNotification => !!n)
        .map((n) => [n.id, n]),
    ).values(),
  ].sort(
    (a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] || b.createdAt.localeCompare(a.createdAt),
  ),
);
const pendingCount = computed(() => pendingNotifications.value.length);
const queueCount = computed(() => state.value.queued.length);
const listLayout = computed(() =>
  pendingCount.value < 2
    ? null
    : islandListLayout({
        count: pendingCount.value,
        fontSize: appearance.value.fontSize,
        maxHeight: props.maxHeight,
        expanded: state.value.listExpanded,
      }),
);
const isListMode = computed(() => !!listLayout.value);
const listItems = computed(() => pendingNotifications.value.slice(0, listLayout.value?.rows ?? 0));
const hiddenCount = computed(() => pendingCount.value - listItems.value.length);
const listHint = computed(() => listLayout.value?.hint);
const size = computed(() => {
  const extra = isCall.value
    ? ISLAND_SIZE_DELTA.call
    : isUrgent.value
      ? ISLAND_SIZE_DELTA.urgent
      : ISLAND_SIZE_DELTA.expanded;
  return {
    width: appearance.value.width + (isListMode.value ? ISLAND_SIZE_DELTA.expanded.width : extra.width),
    height: listLayout.value?.height ?? appearance.value.height + extra.height,
  };
});
const TYPE_ORDER: IslandNotificationKind[] = ['call', 'homework', 'notification'];
const TYPE_LABELS = { call: '叫人', homework: '作业', notification: '通知' };
const pendingTypes = computed(() =>
  TYPE_ORDER.filter((k) => pendingNotifications.value.some((n) => (n.kind ?? 'notification') === k)).map(
    (k) => TYPE_LABELS[k],
  ),
);
function rowKind(n: IslandNotification) {
  return n.kind ?? 'notification';
}
function rowBadgeText(n: IslandNotification) {
  return n.kind === 'call' ? '叫人' : n.kind === 'homework' ? '新作业' : PRIORITY_LABELS[n.priority];
}
function rowBadgeClass(n: IslandNotification) {
  return n.kind === 'call'
    ? 'badge-call'
    : n.kind === 'homework'
      ? 'badge-homework'
      : `badge-${n.priority.toLowerCase()}`;
}
function rowSubText(n: IslandNotification) {
  return `${n.teacherName ? n.teacherName + ' · ' : ''}${formatDate(n.createdAt, true)}`;
}
const badgeText = computed(() => (notification.value ? rowBadgeText(notification.value) : '通知'));
const badgeClass = computed(() => (notification.value ? rowBadgeClass(notification.value) : 'badge-normal'));
const subtitle = computed(() => (notification.value ? rowSubText(notification.value) : ''));
const callHint = computed(() => notification.value?.subtitle ?? '');
const showAfterClassHint = computed(() => state.value.reason === 'after-class' && !state.value.inClass);
const canMarkRead = computed(() => pendingNotifications.value.some((n) => n.kind !== 'homework'));
function collapse() {
  window.island?.sendAction('collapse');
}
function openApp() {
  window.island?.sendAction('open-app');
}
function expandList() {
  window.island?.sendAction('expand-list');
}
function dismiss() {
  window.island?.sendAction(isListMode.value ? 'dismiss-all' : 'dismiss');
}
function markRead() {
  window.island?.sendAction(isListMode.value ? 'mark-all-read' : 'mark-read', notification.value?.id);
}
</script>
<template>
  <span
    class="expanded-layer classic-notifications"
    :class="{ 'list-mode': isListMode }"
    :style="{ width: `${size.width}px`, height: `${size.height}px` }"
  >
    <header class="head">
      <span
        class="head-icon"
        :class="{ urgent: isUrgent, call: isCall, homework: isHomework, list: isListMode }"
      >
        <svg v-if="isHomework" viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="currentColor"
            d="M6 3h9a3 3 0 0 1 3 3v13.5a.5.5 0 0 1-.75.43L15 18.5l-2.25 1.43a.5.5 0 0 1-.53 0L10 18.5l-2.25 1.43a.5.5 0 0 1-.53 0L5 18.5V5a2 2 0 0 1 1-2Zm2 4v1.6h7V7H8Zm0 3.4V12h7v-1.6H8Z"
          />
        </svg>
        <svg v-else-if="isCall" viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="currentColor"
            d="M4 10v4a1 1 0 0 0 1 1h2l4 3.5a1 1 0 0 0 1.65-.76V5.26A1 1 0 0 0 11 4.5L7 8H5a1 1 0 0 0-1 1Zm12.5-2.9a1 1 0 0 1 1.4.1 8 8 0 0 1 0 9.6 1 1 0 1 1-1.5-1.3 6 6 0 0 0 0-7 1 1 0 0 1 .1-1.4Z"
          />
        </svg>
        <svg v-else viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="currentColor"
            d="M12 2a6 6 0 0 0-6 6v3.1L4.6 14a1 1 0 0 0 .9 1.5h13a1 1 0 0 0 .9-1.5L18 11.1V8a6 6 0 0 0-6-6Zm0 20a3 3 0 0 0 3-2.6H9A3 3 0 0 0 12 22Z"
          />
        </svg>
      </span>
      <div class="head-meta">
        <span class="badge" :class="isListMode ? 'badge-normal' : badgeClass">
          {{ isListMode ? `共 ${pendingCount} 条` : badgeText }}
        </span>
        <template v-if="isListMode">
          <span v-if="pendingTypes.length > 1" class="head-sub">{{ pendingTypes.join(' / ') }}</span>
          <span v-else class="head-sub">按重要程度排列</span>
        </template>
        <template v-else>
          <span v-if="isCall" class="live-dot call">老师正在等你</span>
          <span v-else-if="isUrgent" class="live-dot">需立即查看</span>
          <span v-else-if="showAfterClassHint" class="live-dot muted">下课后补发</span>
          <span class="head-sub">{{ subtitle }}</span>
        </template>
      </div>
      <button type="button" class="icon-btn" title="收起" @click.stop="collapse">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="none"
            stroke="currentColor"
            stroke-width="2.4"
            stroke-linecap="round"
            d="m6 15 6-6 6 6"
          />
        </svg>
      </button>
    </header>

    <!-- 多条消息：竖向排列，按重要程度排序，默认只显示前三条 -->
    <template v-if="isListMode">
      <h3 class="title">{{ pendingCount }} 条待处理通知</h3>
      <div class="body list-body">
        <button
          v-for="item in listItems"
          :key="item.id"
          type="button"
          class="list-row"
          :title="`打开应用查看：${item.title}`"
          @click.stop="openApp"
        >
          <span class="row-icon" :class="rowKind(item)">
            <svg v-if="rowKind(item) === 'homework'" viewBox="0 0 24 24" aria-hidden="true">
              <path
                fill="currentColor"
                d="M6 3h9a3 3 0 0 1 3 3v13.5a.5.5 0 0 1-.75.43L15 18.5l-2.25 1.43a.5.5 0 0 1-.53 0L10 18.5l-2.25 1.43a.5.5 0 0 1-.53 0L5 18.5V5a2 2 0 0 1 1-2Zm2 4v1.6h7V7H8Zm0 3.4V12h7v-1.6H8Z"
              />
            </svg>
            <svg v-else-if="rowKind(item) === 'call'" viewBox="0 0 24 24" aria-hidden="true">
              <path
                fill="currentColor"
                d="M4 10v4a1 1 0 0 0 1 1h2l4 3.5a1 1 0 0 0 1.65-.76V5.26A1 1 0 0 0 11 4.5L7 8H5a1 1 0 0 0-1 1Zm12.5-2.9a1 1 0 0 1 1.4.1 8 8 0 0 1 0 9.6 1 1 0 1 1-1.5-1.3 6 6 0 0 0 0-7 1 1 0 0 1 .1-1.4Z"
              />
            </svg>
            <svg v-else viewBox="0 0 24 24" aria-hidden="true">
              <path
                fill="currentColor"
                d="M12 2a6 6 0 0 0-6 6v3.1L4.6 14a1 1 0 0 0 .9 1.5h13a1 1 0 0 0 .9-1.5L18 11.1V8a6 6 0 0 0-6-6Zm0 20a3 3 0 0 0 3-2.6H9A3 3 0 0 0 12 22Z"
              />
            </svg>
          </span>
          <span class="row-text">
            <span class="row-title">{{ item.title }}</span>
            <span class="row-sub">{{ rowSubText(item) }}</span>
          </span>
          <span class="row-badge" :class="rowBadgeClass(item)">{{ rowBadgeText(item) }}</span>
        </button>
        <!-- 还有没显示出来的：能展开就"展开更多"，屏幕到任务栏了就只能去应用里看 -->
        <div v-if="listHint" class="list-hint">
          <button v-if="listHint === 'more'" type="button" class="more-btn" @click.stop="expandList">
            展开更多（还有 {{ hiddenCount }} 条）
          </button>
          <span v-else class="more-app">更多请前往应用内操作</span>
        </div>
      </div>
    </template>

    <template v-else>
      <h3 class="title">{{ notification?.title ?? '' }}</h3>
      <div class="body">
        <p class="content-text">{{ notification?.content ?? '' }}</p>
        <p v-if="callHint" class="call-hint">{{ callHint }}</p>
        <p v-else-if="notification?.subtitle" class="call-hint">{{ notification?.subtitle }}</p>
      </div>
    </template>

    <!-- 一排按钮（多条消息时也是这一排）：展开态的操作都收在这里 -->
    <footer class="foot">
      <span v-if="isListMode" class="more">共 {{ pendingCount }} 条待处理</span>
      <span v-else-if="queueCount > 0" class="more">还有 {{ queueCount }} 条通知</span>
      <span v-else class="more muted">来自 ClassHelper</span>
      <span class="actions">
        <button type="button" class="ghost-btn" @click.stop="openApp">打开应用</button>
        <button v-if="canMarkRead" type="button" class="ghost-btn" @click.stop="markRead">标为已读</button>
        <button type="button" class="solid-btn" @click.stop="dismiss">
          {{ isCall && !isListMode ? '收到' : '知道了' }}
        </button>
      </span>
    </footer>
  </span>
</template>
<style src="./classic-island.css"></style>
