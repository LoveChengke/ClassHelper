<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  DEFAULT_ISLAND_APPEARANCE,
  type IslandAppearance,
  PRIORITY_LABELS,
  formatDate,
  type IslandNotification,
  type IslandNotificationKind,
  type IslandState,
} from '@classhelper/shared';

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
const kind = computed<IslandNotificationKind>(() => notification.value?.kind ?? 'notification');
const isCall = computed(() => kind.value === 'call');
const isHomework = computed(() => kind.value === 'homework');
const queueCount = computed(() => state.value.queued.length);

/** 胶囊标题：按消息类型区分（新消息 / 新作业 / 叫人） */
const pillTitle = computed(() => {
  if (isCall.value) return '老师叫你';
  if (isHomework.value) return '新作业';
  return isUrgent.value ? '紧急通知' : '新消息';
});

/** 展开态徽标：叫人 / 新作业 / 优先级文案 */
const badgeText = computed(() => {
  if (isCall.value) return '叫人';
  if (isHomework.value) return '新作业';
  return priorityLabel.value;
});

const badgeClass = computed(() => {
  if (isCall.value) return 'badge-call';
  if (isHomework.value) return 'badge-homework';
  return `badge-${(notification.value?.priority ?? 'NORMAL').toLowerCase()}`;
});

const priorityLabel = computed(() =>
  notification.value ? (PRIORITY_LABELS[notification.value.priority] ?? notification.value.priority) : '',
);

const subtitle = computed(() => {
  if (!notification.value) return '';
  const teacher = notification.value.teacherName ? `${notification.value.teacherName} · ` : '';
  return `${teacher}${formatDate(notification.value.createdAt, true)}`;
});

/** 叫人消息下方的附加说明（例如"请到办公室找我"） */
const callHint = computed(() => notification.value?.subtitle ?? '');

/** 下课补发时提示"其实上课期间就到了" */
const showAfterClassHint = computed(() => state.value.reason === 'after-class' && !state.value.inClass);

/**
 * 入场动画：
 * - 胶囊（普通通知）：**没有入场动画**，直接出现在屏幕上
 * - 展开 / 紧急：弹簧缩放入场，配合窗口尺寸缓动形成"展开"效果
 */
const transitionName = computed(() => (mode.value === 'pill' ? 'island-instant' : 'island-pop'));
const transitionDuration = computed(() => ({
  enter: mode.value === 'pill' ? 0 : 260,
  leave: 140,
}));

function expand(): void {
  bridge?.sendAction('expand');
}

function collapse(): void {
  bridge?.sendAction('collapse');
}

/** 点击卡片空白处（非按钮、非选中文字）→ 回缩为灵动岛胶囊 */
function onCardClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  if (target?.closest('button')) return;
  if (window.getSelection()?.toString()) return;
  collapse();
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

/** 个性化外观：主进程下发后写入 CSS 变量，卡片尺寸/圆角/字号/主题色随之实时变化 */
const appearance = ref<IslandAppearance>({ ...DEFAULT_ISLAND_APPEARANCE });

function applyAppearance(next: IslandAppearance | null | undefined): void {
  if (!next) return;
  appearance.value = next;
  const style = document.documentElement.style;
  style.setProperty('--island-accent', next.accent);
  style.setProperty('--island-radius', `${next.radius}px`);
  style.setProperty('--island-font', `${next.fontSize}px`);
  style.setProperty('--island-w', `${next.width}px`);
  style.setProperty('--island-h', `${next.height}px`);
  style.setProperty('--island-anim', next.animations ? '1' : '0');
}

onMounted(async () => {
  bridge?.onState((next) => {
    state.value = next;
  });
  const initial = await bridge?.getState();
  if (initial) state.value = initial;
  // 外观：先同步一次，再订阅后续改动
  bridge?.onAppearance((next) => applyAppearance(next));
  const initialAppearance = await bridge?.getAppearance?.();
  applyAppearance(initialAppearance);
});
</script>

<template>
  <div class="island-root" @click.self="collapse">
    <Transition :name="transitionName" :duration="transitionDuration">
      <!-- 胶囊态：收到通知后先变成"新消息" -->
      <button
        v-if="mode === 'pill' && notification"
        key="pill"
        type="button"
        class="island-card pill"
        :class="{ urgent: isUrgent, call: isCall, homework: isHomework, 'after-class': showAfterClassHint }"
        @click="expand"
      >
        <span v-if="isUrgent || isCall" class="glow" aria-hidden="true"></span>
        <span class="pulse-dot" :class="{ urgent: isUrgent, call: isCall, homework: isHomework }"></span>
        <span class="pill-icon">
          <!-- 铃铛（通知）/ 书本（作业）/ 喇叭（叫人） -->
          <svg v-if="isHomework" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
            <path
              fill="currentColor"
              d="M6 3h9a3 3 0 0 1 3 3v13.5a.5.5 0 0 1-.75.43L15 18.5l-2.25 1.43a.5.5 0 0 1-.53 0L10 18.5l-2.25 1.43a.5.5 0 0 1-.53 0L5 18.5V5a2 2 0 0 1 1-2Zm2 4v1.6h7V7H8Zm0 3.4V12h7v-1.6H8Z"
            />
          </svg>
          <svg v-else-if="isCall" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
            <path
              fill="currentColor"
              d="M4 10v4a1 1 0 0 0 1 1h2l4 3.5a1 1 0 0 0 1.65-.76V5.26A1 1 0 0 0 11 4.5L7 8H5a1 1 0 0 0-1 1Zm12.5-2.9a1 1 0 0 1 1.4.1 8 8 0 0 1 0 9.6 1 1 0 1 1-1.5-1.3 6 6 0 0 0 0-7 1 1 0 0 1 .1-1.4Z"
            />
          </svg>
          <svg v-else viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
            <path
              fill="currentColor"
              d="M12 2a6 6 0 0 0-6 6v3.1L4.6 14a1 1 0 0 0 .9 1.5h13a1 1 0 0 0 .9-1.5L18 11.1V8a6 6 0 0 0-6-6Zm0 20a3 3 0 0 0 3-2.6H9A3 3 0 0 0 12 22Z"
            />
          </svg>
        </span>
        <span class="pill-text">
          <span class="pill-title">
            {{ pillTitle }}
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

      <!-- 展开态：显示通知详情（点击空白处回缩为胶囊） -->
      <section
        v-else-if="mode === 'expanded' && notification"
        key="expanded"
        class="island-card expanded"
        :class="{ urgent: isUrgent, call: isCall, homework: isHomework }"
        @click="onCardClick"
      >
        <span v-if="isUrgent || isCall" class="glow" aria-hidden="true"></span>
        <header class="head">
          <span class="head-icon" :class="{ urgent: isUrgent, call: isCall, homework: isHomework }">
            <svg v-if="isHomework" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
              <path
                fill="currentColor"
                d="M6 3h9a3 3 0 0 1 3 3v13.5a.5.5 0 0 1-.75.43L15 18.5l-2.25 1.43a.5.5 0 0 1-.53 0L10 18.5l-2.25 1.43a.5.5 0 0 1-.53 0L5 18.5V5a2 2 0 0 1 1-2Zm2 4v1.6h7V7H8Zm0 3.4V12h7v-1.6H8Z"
              />
            </svg>
            <svg v-else-if="isCall" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
              <path
                fill="currentColor"
                d="M4 10v4a1 1 0 0 0 1 1h2l4 3.5a1 1 0 0 0 1.65-.76V5.26A1 1 0 0 0 11 4.5L7 8H5a1 1 0 0 0-1 1Zm12.5-2.9a1 1 0 0 1 1.4.1 8 8 0 0 1 0 9.6 1 1 0 1 1-1.5-1.3 6 6 0 0 0 0-7 1 1 0 0 1 .1-1.4Z"
              />
            </svg>
            <svg v-else viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
              <path
                fill="currentColor"
                d="M12 2a6 6 0 0 0-6 6v3.1L4.6 14a1 1 0 0 0 .9 1.5h13a1 1 0 0 0 .9-1.5L18 11.1V8a6 6 0 0 0-6-6Zm0 20a3 3 0 0 0 3-2.6H9A3 3 0 0 0 12 22Z"
              />
            </svg>
          </span>
          <div class="head-meta">
            <span class="badge" :class="badgeClass">{{ badgeText }}</span>
            <span v-if="isCall" class="live-dot call">老师正在等你</span>
            <span v-else-if="isUrgent" class="live-dot">需立即查看</span>
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
          <p v-if="callHint" class="call-hint">{{ callHint }}</p>
          <p v-if="notification.subtitle && !callHint" class="call-hint">{{ notification.subtitle }}</p>
        </div>

        <footer class="foot">
          <span v-if="queueCount > 0" class="more">还有 {{ queueCount }} 条通知</span>
          <span v-else class="more muted">来自班级小助手</span>
          <span class="actions">
            <button type="button" class="ghost-btn" @click="openApp">打开应用</button>
            <button type="button" class="ghost-btn" @click="markRead">标为已读</button>
            <button type="button" class="solid-btn" @click="dismiss">{{ isCall ? '收到' : '知道了' }}</button>
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
  /* 个性化外观默认值（主进程会通过 island:appearance 覆盖这些变量） */
  --island-accent: #6cc4ff;
  --island-radius: 20px;
  --island-font: 13px;
  --island-w: 268px;
  --island-h: 44px;
  font-size: var(--island-font);
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

/* 三态卡片绝对定位 + **固定逻辑尺寸、水平居中锚定**。
   关键：卡片不能跟随窗口拉伸，否则窗口形变过程中会看到一块被拉扁的"方框"，
   胶囊里的图标/文字还会被垂直居中而"从上面瞬移到下面"。
   这里每种形态都是固定尺寸，窗口只负责露出/裁切这块透明区域，形变时卡片内容不缩放。
   另：窗口只比卡片大 2~4px，向外的 box-shadow/光晕会被窗口边界裁切，
   因此所有装饰只使用 inset 阴影。 */
.island-card {
  position: absolute;
  top: 2px;
  box-sizing: border-box;
  border-radius: 22px;
  color: #f7f8fa;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background:
    radial-gradient(120% 140% at 50% -20%, rgba(255, 255, 255, 0.14), rgba(255, 255, 255, 0) 55%),
    linear-gradient(180deg, #23242a 0%, #0c0d10 100%);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.08),
    inset 0 -1px 0 rgba(0, 0, 0, 0.35);
  transition:
    border-color 0.28s ease,
    background 0.28s ease;
}

/* 各形态固定尺寸（与主进程 ISLAND_SIZES 对齐：卡片刻意比窗口小 4~8px，四周留 2~4px 透明边） */
.island-card.pill {
  left: calc(50% - var(--island-w) / 2 + 4px);
  width: calc(var(--island-w) - 8px);
  height: calc(var(--island-h) - 6px);
  border-radius: var(--island-radius);
}

.island-card.expanded {
  left: calc(50% - (var(--island-w) + 136px) / 2 + 4px);
  width: calc(var(--island-w) + 128px);
  height: calc(var(--island-h) + 264px);
  border-radius: var(--island-radius);
}

.island-card.expanded.urgent {
  left: calc(50% - (var(--island-w) + 156px) / 2 + 4px);
  width: calc(var(--island-w) + 148px);
  height: calc(var(--island-h) + 292px);
}

/* 叫人：卡片略大（对应主进程 CALL_SIZE 440x360） */
.island-card.expanded.call {
  left: calc(50% - (var(--island-w) + 172px) / 2 + 4px);
  width: calc(var(--island-w) + 164px);
  height: calc(var(--island-h) + 308px);
}

/* 隐藏态占位：只保留结构，不占视觉空间 */
.hidden-placeholder {
  left: 0;
  width: 100%;
  height: 38px;
  opacity: 0;
  cursor: default;
}

/* 紧急通知：红色描边 + 内部光晕呼吸（不外扩，避免窗口边界裁切出光晕硬边） */
.island-card.urgent {
  border-color: rgba(255, 92, 92, 0.6);
}

/* 叫人：琥珀金描边（老师点名，需要学生动作） */
.island-card.call {
  border-color: rgba(255, 193, 94, 0.65);
  background:
    radial-gradient(120% 140% at 50% -20%, rgba(255, 193, 94, 0.18), rgba(255, 255, 255, 0) 55%),
    linear-gradient(180deg, #2a2417 0%, #0d0c09 100%);
}

.island-card.call .glow {
  animation: call-breath 2s ease-in-out infinite;
}

@keyframes call-breath {
  0%,
  100% {
    box-shadow:
      inset 0 0 14px rgba(255, 193, 94, 0.2),
      inset 0 0 0 1px rgba(255, 193, 94, 0.3);
  }
  50% {
    box-shadow:
      inset 0 0 26px rgba(255, 193, 94, 0.4),
      inset 0 0 0 1px rgba(255, 193, 94, 0.55);
  }
}

/* 新作业：青蓝描边 */
.island-card.homework {
  border-color: rgba(108, 196, 255, 0.55);
}

.glow {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  animation: urgent-breath 2.2s ease-in-out infinite;
}

@keyframes urgent-breath {
  0%,
  100% {
    box-shadow:
      inset 0 0 14px rgba(255, 72, 72, 0.22),
      inset 0 0 0 1px rgba(255, 92, 92, 0.3);
  }
  50% {
    box-shadow:
      inset 0 0 26px rgba(255, 72, 72, 0.45),
      inset 0 0 0 1px rgba(255, 92, 92, 0.55);
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
  color: var(--island-accent);
  background: color-mix(in srgb, var(--island-accent) 16%, transparent);
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
  color: var(--island-accent);
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
  background: var(--island-accent);
  font-weight: 650;
}

.island-card.expanded.urgent .solid-btn {
  color: #fff;
  background: #ff4d4f;
}

.solid-btn:hover {
  transform: translateY(-1px);
}

/* ---------------------------------------------------------------- 消息类型样式 */

/* "叫人"（老师点名，琥珀金）：图标底色、徽标、按钮 */
.island-card.pill.call .pill-icon {
  color: #ffd79a;
  background: rgba(255, 193, 94, 0.2);
}

.pulse-dot.call {
  background: #ffc15e;
  box-shadow: 0 0 0 0 rgba(255, 193, 94, 0.7);
}

.head-icon.call {
  color: #ffd79a;
  background: rgba(255, 193, 94, 0.22);
}

.badge-call {
  color: #3a2600;
  background: #ffc15e;
}

.live-dot.call {
  color: #ffd79a;
}

.island-card.expanded.call .solid-btn {
  color: #3a2600;
  background: #ffc15e;
}

.island-card.expanded.call .body {
  background: rgba(255, 193, 94, 0.08);
}

.call-hint {
  margin: 8px 0 0;
  font-size: 12px;
  color: #ffd79a;
  font-weight: 600;
}

/* 新作业（青蓝） */
.island-card.pill.homework .pill-icon {
  color: #b7e2ff;
  background: rgba(108, 196, 255, 0.18);
}

.pulse-dot.homework {
  background: #6cc4ff;
  box-shadow: 0 0 0 0 rgba(108, 196, 255, 0.6);
}

.head-icon.homework {
  color: #b7e2ff;
  background: rgba(108, 196, 255, 0.2);
}

.badge-homework {
  color: #06263f;
  background: #6cc4ff;
}

.island-card.expanded.homework .solid-btn {
  color: #06263f;
  background: #6cc4ff;
}

/* ---------------------------------------------------------------- 形变动画 */

/* 胶囊态：没有入场动画，直接出现 */
.island-instant-enter-active {
  transition: none;
}

.island-instant-enter-from {
  opacity: 1;
  transform: none;
}

.island-instant-leave-active {
  transition: opacity 0.12s ease;
}

.island-instant-leave-to {
  opacity: 0;
}

/* 展开态：弹簧缩放入场（配合窗口尺寸缓动） */
.island-pop-enter-active {
  transition:
    opacity 0.2s ease,
    transform 0.34s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.island-pop-leave-active {
  transition:
    opacity 0.14s ease,
    transform 0.2s ease;
}

.island-pop-enter-from {
  opacity: 0;
  transform: scale(0.88) translateY(-6px);
}

.island-pop-leave-to {
  opacity: 0;
  transform: scale(0.92);
}
</style>
