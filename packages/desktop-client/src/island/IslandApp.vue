<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { PRIORITY_LABELS, formatDate, type IslandNotification, type IslandState } from '@classhelper/shared';

/**
 * 灵动岛渲染进程。
 *
 * 窗口尺寸由主进程按状态缓动（见 src/main/island.ts），这里只负责：
 * - 按状态渲染 胶囊 / 展开卡片
 * - 内容交叉淡入与弹簧缩放（形变动画的"内容层"）
 * - 把用户点击（展开 / 收起 / 标为已读 / 打开应用）回传主进程
 */
const state = ref<IslandState>({
  mode: 'hidden',
  active: null,
  queued: [],
  inClass: false,
  currentPeriodEnd: null,
  reason: null,
  updatedAt: 0,
});

const bridge = window.island;

const notification = computed<IslandNotification | null>(() => state.value.active);
const mode = computed(() => state.value.mode);
const isUrgent = computed(() => notification.value?.priority === 'URGENT');
const queueCount = computed(() => state.value.queued.length);

const priorityLabel = computed(() =>
  notification.value ? (PRIORITY_LABELS[notification.value.priority] ?? notification.value.priority) : '',
);

const subtitle = computed(() => {
  if (!notification.value) return '';
  const teacher = notification.value.teacherName ? `${notification.value.teacherName} · ` : '';
  return `${teacher}${formatDate(notification.value.createdAt, true)}`;
});

/** 下课补发时提示"其实上课期间就到了" */
const showAfterClassHint = computed(() => state.value.reason === 'after-class' && !state.value.inClass);

function expand(): void {
  bridge?.sendAction('expand');
}

function collapse(): void {
  bridge?.sendAction('collapse');
}

function dismiss(): void {
  bridge?.sendAction('dismiss');
}

function markRead(): void {
  if (notification.value) bridge?.sendAction('mark-read', notification.value.id);
}

function openApp(): void {
  bridge?.sendAction('open-app');
}

onMounted(async () => {
  bridge?.onState((next) => {
    state.value = next;
  });
  const initial = await bridge?.getState();
  if (initial) state.value = initial;
});
</script>

<template>
  <div class="island-root">
    <Transition name="island-pop" :duration="{ enter: 240, leave: 150 }">
      <!-- 胶囊态：收到通知后先变成"新消息" -->
      <button
        v-if="mode === 'pill' && notification"
        key="pill"
        type="button"
        class="island-card pill"
        :class="{ urgent: isUrgent, 'after-class': showAfterClassHint }"
        @click="expand"
      >
        <span v-if="isUrgent" class="glow" aria-hidden="true"></span>
        <span class="pulse-dot" :class="{ urgent: isUrgent }"></span>
        <span class="pill-icon">
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
            <path
              fill="currentColor"
              d="M12 2a6 6 0 0 0-6 6v3.1L4.6 14a1 1 0 0 0 .9 1.5h13a1 1 0 0 0 .9-1.5L18 11.1V8a6 6 0 0 0-6-6Zm0 20a3 3 0 0 0 3-2.6H9A3 3 0 0 0 12 22Z"
            />
          </svg>
        </span>
        <span class="pill-text">
          <span class="pill-title">
            {{ isUrgent ? '紧急通知' : '新消息' }}
            <template v-if="queueCount > 0">· 共 {{ queueCount + 1 }} 条</template>
          </span>
          <span class="pill-sub">{{ notification.teacherName || '老师' }} · 点击查看</span>
        </span>
        <span class="pill-chevron" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="14" height="14">
            <path
              fill="none"
              stroke="currentColor"
              stroke-width="2.4"
              stroke-linecap="round"
              d="m9 6 6 6-6 6"
            />
          </svg>
        </span>
      </button>

      <!-- 展开态：显示通知详情 -->
      <section
        v-else-if="mode === 'expanded' && notification"
        key="expanded"
        class="island-card expanded"
        :class="{ urgent: isUrgent }"
      >
        <span v-if="isUrgent" class="glow" aria-hidden="true"></span>
        <header class="head">
          <span class="head-icon" :class="{ urgent: isUrgent }">
            <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
              <path
                fill="currentColor"
                d="M12 2a6 6 0 0 0-6 6v3.1L4.6 14a1 1 0 0 0 .9 1.5h13a1 1 0 0 0 .9-1.5L18 11.1V8a6 6 0 0 0-6-6Zm0 20a3 3 0 0 0 3-2.6H9A3 3 0 0 0 12 22Z"
              />
            </svg>
          </span>
          <div class="head-meta">
            <span class="badge" :class="`badge-${notification.priority.toLowerCase()}`">
              {{ priorityLabel }}
            </span>
            <span v-if="isUrgent" class="live-dot">需立即查看</span>
            <span v-else-if="showAfterClassHint" class="live-dot muted">下课后补发</span>
            <span class="head-sub">{{ subtitle }}</span>
          </div>
          <button type="button" class="icon-btn" title="收起" @click="collapse">
            <svg viewBox="0 0 24 24" width="14" height="14">
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

        <h3 class="title">{{ notification.title }}</h3>
        <div class="body">
          <p class="content">{{ notification.content }}</p>
        </div>

        <footer class="foot">
          <span v-if="queueCount > 0" class="more">还有 {{ queueCount }} 条通知</span>
          <span v-else class="more muted">来自班级小助手</span>
          <span class="actions">
            <button type="button" class="ghost-btn" @click="openApp">打开应用</button>
            <button type="button" class="ghost-btn" @click="markRead">标为已读</button>
            <button type="button" class="solid-btn" @click="dismiss">知道了</button>
          </span>
        </footer>
      </section>

      <!-- 隐藏态占位（窗口不可见，仅保证 DOM 结构稳定） -->
      <div v-else key="hidden" class="island-card hidden-placeholder"></div>
    </Transition>
  </div>
</template>

<style>
html,
body,
#app {
  margin: 0;
  padding: 0;
  width: 100%;
  height: 100%;
  background: transparent;
  overflow: hidden;
  font-family: 'PingFang SC', 'Microsoft YaHei', 'Helvetica Neue', Arial, sans-serif;
  -webkit-user-select: none;
  user-select: none;
}

.island-root {
  position: relative;
  width: 100%;
  height: 100%;
  padding: 2px 4px;
  box-sizing: border-box;
}

/* 三态卡片绝对定位，使交叉淡入淡出（并行 Transition）不会互相挤压 */
.island-card {
  position: absolute;
  top: 2px;
  right: 4px;
  bottom: 2px;
  left: 4px;
  box-sizing: border-box;
  border-radius: 24px;
  color: #f7f8fa;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background:
    radial-gradient(120% 140% at 50% -20%, rgba(255, 255, 255, 0.14), rgba(255, 255, 255, 0) 55%),
    linear-gradient(180deg, #23242a 0%, #0c0d10 100%);
  box-shadow:
    0 12px 28px rgba(0, 0, 0, 0.45),
    inset 0 1px 0 rgba(255, 255, 255, 0.08);
  transition:
    border-color 0.28s ease,
    box-shadow 0.28s ease,
    background 0.28s ease;
}

/* 紧急通知：红色描边 + 独立光晕层呼吸
   注意：无限动画必须放在内部 .glow 上，否则会让 Vue <Transition> 的
   transitionend/animationend 判定失效，导致DOM 卡在离场状态。 */
.island-card.urgent {
  border-color: rgba(255, 92, 92, 0.55);
  box-shadow:
    0 12px 30px rgba(0, 0, 0, 0.5),
    0 0 0 1px rgba(255, 92, 92, 0.25),
    inset 0 1px 0 rgba(255, 255, 255, 0.1);
}

.glow {
  position: absolute;
  inset: -1px;
  border-radius: inherit;
  pointer-events: none;
  animation: urgent-breath 2.2s ease-in-out infinite;
}

@keyframes urgent-breath {
  0%,
  100% {
    box-shadow:
      0 0 0 1px rgba(255, 92, 92, 0.22),
      0 0 18px rgba(255, 72, 72, 0.28);
  }
  50% {
    box-shadow:
      0 0 0 1px rgba(255, 92, 92, 0.38),
      0 0 34px rgba(255, 72, 72, 0.5);
  }
}

/* ---------------------------------------------------------------- 胶囊态 */

.island-card.pill {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 12px;
  border-radius: 22px;
  cursor: pointer;
  font: inherit;
  text-align: left;
  outline: none;
  transition:
    transform 0.18s cubic-bezier(0.34, 1.56, 0.64, 1),
    background 0.2s ease;
}

.island-card.pill:hover {
  transform: translateY(-1px) scale(1.015);
}

.island-card.pill:active {
  transform: scale(0.985);
}

.hidden-placeholder {
  opacity: 0;
  cursor: default;
}

.pulse-dot {
  position: absolute;
  top: 9px;
  left: 14px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #4facfe;
  box-shadow: 0 0 0 0 rgba(79, 172, 254, 0.6);
  animation: dot-pulse 1.8s ease-out infinite;
}

.pulse-dot.urgent {
  background: #ff5c5c;
  box-shadow: 0 0 0 0 rgba(255, 92, 92, 0.7);
}

@keyframes dot-pulse {
  0% {
    box-shadow: 0 0 0 0 rgba(79, 172, 254, 0.55);
  }
  70% {
    box-shadow: 0 0 0 9px rgba(79, 172, 254, 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(79, 172, 254, 0);
  }
}

.pill-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  color: #9fd0ff;
  background: rgba(79, 172, 254, 0.14);
  flex: 0 0 auto;
}

.island-card.pill.urgent .pill-icon {
  color: #ffb3b3;
  background: rgba(255, 92, 92, 0.18);
}

.pill-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
  line-height: 1.25;
}

.pill-title {
  font-size: 13px;
  font-weight: 650;
  letter-spacing: 0.2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pill-sub {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.55);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pill-chevron {
  color: rgba(255, 255, 255, 0.4);
  flex: 0 0 auto;
}

/* ---------------------------------------------------------------- 展开态 */

.island-card.expanded {
  display: flex;
  flex-direction: column;
  padding: 12px 14px 12px;
  border-radius: 24px;
  gap: 8px;
}

.head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.head-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 8px;
  color: #9fd0ff;
  background: rgba(79, 172, 254, 0.16);
  flex: 0 0 auto;
}

.head-icon.urgent {
  color: #ffc0c0;
  background: rgba(255, 92, 92, 0.2);
}

.head-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 1;
}

.badge {
  font-size: 10px;
  padding: 1px 7px;
  border-radius: 999px;
  font-weight: 650;
  letter-spacing: 0.3px;
}

.badge-urgent {
  color: #fff;
  background: #ff4d4f;
}

.badge-high {
  color: #3a2a00;
  background: #ffc53d;
}

.badge-normal {
  color: #06263f;
  background: #6cc4ff;
}

.badge-low {
  color: #23262b;
  background: #c9ced6;
}

.live-dot {
  font-size: 10px;
  color: #ffb3b3;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.live-dot::before {
  content: '';
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
  animation: dot-pulse 1.6s ease-out infinite;
}

.live-dot.muted {
  color: rgba(255, 255, 255, 0.45);
}

.head-sub {
  margin-left: auto;
  font-size: 10px;
  color: rgba(255, 255, 255, 0.42);
  white-space: nowrap;
}

.icon-btn {
  border: none;
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.7);
  width: 22px;
  height: 22px;
  border-radius: 50%;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition:
    background 0.18s ease,
    transform 0.18s ease;
  flex: 0 0 auto;
}

.icon-btn:hover {
  background: rgba(255, 255, 255, 0.16);
  transform: scale(1.06);
}

.title {
  margin: 0;
  font-size: 15px;
  font-weight: 680;
  line-height: 1.35;
  letter-spacing: 0.2px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  background: rgba(255, 255, 255, 0.045);
  border-radius: 12px;
  padding: 9px 11px;
}

.body::-webkit-scrollbar {
  width: 5px;
}

.body::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.18);
  border-radius: 3px;
}

.content {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.72;
  color: rgba(255, 255, 255, 0.82);
  white-space: pre-wrap;
  word-break: break-word;
}

.foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.more {
  font-size: 11px;
  color: #9fd0ff;
}

.more.muted {
  color: rgba(255, 255, 255, 0.38);
}

.actions {
  display: inline-flex;
  gap: 6px;
}

.ghost-btn,
.solid-btn {
  font: inherit;
  font-size: 11.5px;
  border-radius: 999px;
  padding: 4px 11px;
  cursor: pointer;
  border: 1px solid transparent;
  transition:
    background 0.18s ease,
    border-color 0.18s ease,
    transform 0.18s ease;
}

.ghost-btn {
  color: rgba(255, 255, 255, 0.78);
  background: rgba(255, 255, 255, 0.08);
}

.ghost-btn:hover {
  background: rgba(255, 255, 255, 0.16);
  transform: translateY(-1px);
}

.solid-btn {
  color: #06263f;
  background: #6cc4ff;
  font-weight: 650;
}

.island-card.expanded.urgent .solid-btn {
  color: #fff;
  background: #ff4d4f;
}

.solid-btn:hover {
  transform: translateY(-1px);
}

/* ---------------------------------------------------------------- 形变动画 */

.island-pop-enter-active {
  transition:
    opacity 0.22s ease,
    transform 0.34s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.island-pop-leave-active {
  transition:
    opacity 0.16s ease,
    transform 0.2s ease;
}

.island-pop-enter-from {
  opacity: 0;
  transform: scale(0.86) translateY(-8px);
}

.island-pop-leave-to {
  opacity: 0;
  transform: scale(0.9);
}
</style>
