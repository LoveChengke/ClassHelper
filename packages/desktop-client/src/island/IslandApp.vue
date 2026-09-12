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
import { squirclePath } from './squircle.js';

/**
 * 灵动岛渲染进程 —— 视觉与排版参考 WinIsland（Rust/Direct2D 的 Windows 动态岛）。
 *
 * 对齐点（详见 docs/winisland-design-tokens.md）：
 * - 造型：**连续圆角（超椭圆 squircle）**而不是 border-radius（WinIsland `utils/shape.rs`）；
 *   展开卡半径取 `min(48 * 圆角系数, w/2, h/2)`，胶囊半径取 `h/2`（满圆角）；
 * - 底色：默认纯黑（WinIsland `default` 风格），可选亚克力毛玻璃（`glass` → 主进程
 *   `setBackgroundMaterial('acrylic')`，等价于 WinIsland 的 HostBackdropBrush）；
 * - 描边：1px 白、alpha 30（纯黑）/ 40（玻璃、主题色），与 WinIsland `BORDER_*_ALPHA` 同值；
 * - 阴影：只在展开态，`0 2px 3px rgba(0,0,0,.11)`（WinIsland `draw_expanded_shadow`）；
 * - 排版：白字 + alpha 分级（.92/.72/.58），**所有文本 = 基础字号 × 排版系数**，
 *   因此「字号」设置一改，岛内文字整体等比缩放（WinIsland `font_size` 模型）；
 * - 动效：单调缓动（无过冲、无回弹），只有淡入淡出与窗口形变，符合"开合不震动"。
 *
 * 窗口尺寸仍由主进程按状态缓动（见 src/main/island.ts），渲染进程负责形状、排版与交互回传。
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

/** 状态色（WinIsland 资源占用色板同源）：危险红 / 警告橙 / 强调蓝 */
const stateColor = computed(() => {
  if (isUrgent.value) return '#ff453a';
  if (isCall.value) return '#ff9f0a';
  if (isHomework.value) return appearance.value.accent;
  return '';
});

/**
 * 入场动画：胶囊直接出现（WinIsland 的 compact 没有入场动画），
 * 展开 / 紧急只用透明度淡入，形变完全交给窗口尺寸（因此不会出现缩放回弹）。
 */
const transitionName = computed(() => (mode.value === 'pill' ? 'island-instant' : 'island-fade'));
const transitionDuration = computed(() => ({
  enter: mode.value === 'pill' ? 0 : Math.round(140 / appearance.value.speed),
  leave: Math.round(90 / appearance.value.speed),
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

/** 个性化外观：主进程下发后写入 CSS 变量，形状/排版/配色立即变化（无需重启） */
const appearance = ref<IslandAppearance>({ ...DEFAULT_ISLAND_APPEARANCE });

/** 卡片与窗口的内边距（必须与主进程 CARD_PAD_X / CARD_PAD_Y 一致） */
const CARD_PAD_X = 5;
const CARD_PAD_Y = 5;

/**
 * 各形态相对"胶囊窗口"的额外尺寸（必须与主进程 BASE.expanded/urgent/call 的增量一致）：
 * 卡片尺寸 = 窗口尺寸 - 内边距，因此卡片始终在窗口内居中、四周留白恒定。
 */
const EXTRA = {
  expanded: { width: 156, height: 186 },
  urgent: { width: 172, height: 202 },
  call: { width: 188, height: 218 },
} as const;

/** 当前形态的窗口尺寸（用于推出卡片尺寸） */
const windowSize = computed(() => {
  const width = appearance.value.width;
  const height = appearance.value.height;
  if (mode.value !== 'expanded') return { width, height };
  const extra = isCall.value ? EXTRA.call : isUrgent.value ? EXTRA.urgent : EXTRA.expanded;
  return { width: width + extra.width, height: height + extra.height };
});

/** 卡片像素尺寸（= 窗口 - 内边距） */
const cardSize = computed(() => ({
  width: Math.max(2, windowSize.value.width - CARD_PAD_X * 2),
  height: Math.max(2, windowSize.value.height - CARD_PAD_Y * 2),
}));

/** 圆角：胶囊取 h/2（满圆角），展开卡取 min(48*系数, w/2, h/2)（WinIsland expanded_island_radius） */
const cardRadius = computed(() => {
  const { width, height } = cardSize.value;
  if (mode.value !== 'expanded') return Math.min(appearance.value.radius, height / 2);
  const scaled = (48 * appearance.value.radius) / 20;
  return Math.max(0, Math.min(scaled, width / 2, height / 2));
});

/** 连续圆角路径（超椭圆角，见 squircle.ts） */
const cardPath = computed(() => squirclePath(cardSize.value.width, cardSize.value.height, cardRadius.value));

/**
 * 卡片内联样式：尺寸、形状、配色、排版全部由外观设置驱动。
 *
 * 注意 `left` 用 `calc(50% - 卡片宽/2)`（相对**当前窗口宽度**居中），而不是固定 padding：
 * 窗口在形变过程中宽度由主进程逐帧插值，卡片只有居中才能保证"卡片中心全程不动"（实测 0.00px）。
 */
const cardStyle = computed(() => {
  const card = cardSize.value;
  return {
    width: `${card.width}px`,
    height: `${card.height}px`,
    left: `calc(50% - ${card.width / 2}px)`,
    top: `${CARD_PAD_Y}px`,
    '--card-path': `path("${cardPath.value}")`,
    '--card-r': `${cardRadius.value}px`,
    '--state-color': stateColor.value || 'transparent',
  };
});

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
  // 形变时长（与主进程的缓动时长一致），用于内容淡入淡出的节奏对齐
  const morph = next.style === 'glass' ? 320 : 320;
  style.setProperty('--island-dur', `${Math.round(morph / Math.max(0.25, next.speed))}ms`);
}

onMounted(async () => {
  bridge?.onState((next) => {
    state.value = next;
  });
  const initial = await bridge?.getState();
  if (initial) state.value = initial;
  // 外观：先同步一次，再订阅后续改动（改设置立即生效）
  bridge?.onAppearance((next) => applyAppearance(next));
  const initialAppearance = await bridge?.getAppearance?.();
  applyAppearance(initialAppearance);
});
</script>

<template>
  <div class="island-root">
    <Transition :name="transitionName" :duration="transitionDuration">
      <!-- 胶囊态：WinIsland compact —— 小尺寸、满圆角、图标 + 文本 + 提示箭头 -->
      <button
        v-if="mode === 'pill' && notification"
        key="pill"
        type="button"
        class="island-card pill"
        :class="{ urgent: isUrgent, call: isCall, homework: isHomework, 'after-class': showAfterClassHint }"
        :data-style="appearance.style"
        :style="cardStyle"
        @click="expand"
      >
        <svg class="shape" :viewBox="`0 0 ${cardSize.width} ${cardSize.height}`" aria-hidden="true">
          <path :d="cardPath" />
        </svg>
        <span class="content">
          <span class="tint" aria-hidden="true"></span>
          <span class="pill-icon" :class="{ urgent: isUrgent, call: isCall, homework: isHomework }">
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
          <span class="pill-text">
            <span class="pill-title">
              {{ pillTitle }}
              <template v-if="queueCount > 0">· 共 {{ queueCount + 1 }} 条</template>
            </span>
            <span class="pill-sub">{{ notification.teacherName || '老师' }} · 点击查看</span>
          </span>
          <span class="pill-chevron" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path
                fill="none"
                stroke="currentColor"
                stroke-width="2.6"
                stroke-linecap="round"
                d="m9 6 6 6-6 6"
              />
            </svg>
          </span>
        </span>
      </button>

      <!-- 展开态：WinIsland expanded —— 大圆角卡片、白字分级、底部胶囊按钮 -->
      <section
        v-else-if="mode === 'expanded' && notification"
        key="expanded"
        class="island-card expanded"
        :class="{ urgent: isUrgent, call: isCall, homework: isHomework }"
        :data-style="appearance.style"
        :style="cardStyle"
        @click="onCardClick"
      >
        <svg class="shape" :viewBox="`0 0 ${cardSize.width} ${cardSize.height}`" aria-hidden="true">
          <path :d="cardPath" />
        </svg>
        <span class="content">
          <span class="tint" aria-hidden="true"></span>
          <header class="head">
            <span class="head-icon" :class="{ urgent: isUrgent, call: isCall, homework: isHomework }">
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
              <span class="badge" :class="badgeClass">{{ badgeText }}</span>
              <span v-if="isCall" class="live-dot call">老师正在等你</span>
              <span v-else-if="isUrgent" class="live-dot">需立即查看</span>
              <span v-else-if="showAfterClassHint" class="live-dot muted">下课后补发</span>
              <span class="head-sub">{{ subtitle }}</span>
            </div>
            <button type="button" class="icon-btn" title="收起" @click="collapse">
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

          <h3 class="title">{{ notification.title }}</h3>
          <div class="body">
            <p class="content-text">{{ notification.content }}</p>
            <p v-if="callHint" class="call-hint">{{ callHint }}</p>
            <p v-else-if="notification.subtitle" class="call-hint">{{ notification.subtitle }}</p>
          </div>

          <footer class="foot">
            <span v-if="queueCount > 0" class="more">还有 {{ queueCount }} 条通知</span>
            <span v-else class="more muted">来自班级小助手</span>
            <span class="actions">
              <button type="button" class="ghost-btn" @click="openApp">打开应用</button>
              <button type="button" class="ghost-btn" @click="markRead">标为已读</button>
              <button type="button" class="solid-btn" @click="dismiss">
                {{ isCall ? '收到' : '知道了' }}
              </button>
            </span>
          </footer>
        </span>
      </section>

      <!-- 隐藏态占位（窗口不可见，仅保证 DOM 结构稳定） -->
      <div v-else key="hidden" class="island-card hidden-placeholder"></div>
    </Transition>
  </div>
</template>

<style>
/*
 * 排版系数（必须与 @classhelper/shared 的 ISLAND_TYPE_SCALE 保持一致）：
 * title 1.08 / body 0.95 / meta 0.78 / badge 0.76 / pillTitle 0.92 / pillSub 0.74
 *
 * 关键：所有文本尺寸都由 --island-font 通过 calc() 推导，所以「字号」设置一改，
 * 岛内文字立即整体等比缩放（WinIsland 的 font_size 模型），不存在写死的字号。
 */
html,
body,
#app {
  margin: 0;
  padding: 0;
  width: 100%;
  height: 100%;
  background: transparent;
  overflow: hidden;
  -webkit-user-select: none;
  user-select: none;
}

body {
  font-family:
    -apple-system, 'Segoe UI Variable Display', 'Segoe UI', 'Microsoft YaHei', 'PingFang SC',
    'Helvetica Neue', sans-serif;
  -webkit-font-smoothing: antialiased;
}

* {
  box-sizing: border-box;
}

.island-root {
  width: 100%;
  height: 100%;
  position: relative;
  background: transparent;
}

/* ---------------------------------------------------------------- 卡片与形状 */

.island-card {
  position: absolute;
  display: block;
  padding: 0;
  margin: 0;
  border: none;
  background: none;
  color: rgba(255, 255, 255, 0.92);
  font-size: var(--island-font, 13px);
  text-align: left;
  cursor: pointer;
  /* 配色 token（默认：WinIsland 纯黑风格） */
  --wn-bg: #000000;
  --wn-border: rgba(255, 255, 255, 0.118);
  --wn-text-1: rgba(255, 255, 255, 0.92);
  --wn-text-2: rgba(255, 255, 255, 0.72);
  --wn-text-3: rgba(255, 255, 255, 0.58);
  --wn-surface: rgba(255, 255, 255, 0.1);
  --wn-surface-hover: rgba(255, 255, 255, 0.18);
  --wn-divider: rgba(255, 255, 255, 0.09);
}

.island-card[data-style='glass'] {
  --wn-bg: rgba(10, 10, 14, 0.588);
  --wn-border: rgba(255, 255, 255, 0.157);
  --wn-surface: rgba(255, 255, 255, 0.14);
  --wn-surface-hover: rgba(255, 255, 255, 0.22);
}

.island-card[data-style='tinted'] {
  --wn-bg: #0b0b0f;
  --wn-border: rgba(255, 255, 255, 0.14);
}

.island-card.hidden-placeholder {
  visibility: hidden;
}

/* 连续圆角形状：填充 + 1px 描边（描边画在裁切之外，与 WinIsland 一致） */
.island-card .shape {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
}

.island-card .shape path {
  fill: var(--wn-bg);
  stroke: var(--wn-border);
  stroke-width: 1;
}

/* 内容层裁切到同一形状内 */
.island-card .content {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  clip-path: var(--card-path);
  overflow: hidden;
}

/* 展开态投影（WinIsland: rgba(0,0,0,.11)、y+2、σ=3 → CSS 0 2px 3px） */
.island-card.expanded .shape path {
  filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.11));
}

/* 状态色：只做"内层微染 + 描边"，不外溢（保持桌面干净，也不会有光晕硬边） */
.island-card.urgent .shape path,
.island-card.call .shape path {
  stroke: color-mix(in srgb, var(--state-color) 62%, rgba(255, 255, 255, 0.2));
}

.island-card .tint {
  position: absolute;
  inset: 0;
  pointer-events: none;
  opacity: 0;
}

.island-card.urgent .tint {
  opacity: 1;
  background: radial-gradient(120% 90% at 50% 0%, rgba(255, 69, 58, 0.22), transparent 68%);
}

.island-card.call .tint {
  opacity: 1;
  background: radial-gradient(120% 90% at 50% 0%, rgba(255, 159, 10, 0.2), transparent 68%);
}

.island-card[data-style='tinted'] .tint {
  opacity: 1;
  background: linear-gradient(
    135deg,
    color-mix(in srgb, var(--island-accent) 30%, transparent),
    transparent 62%
  );
}

/* ---------------------------------------------------------------- 胶囊（compact） */

.island-card.pill .content {
  flex-direction: row;
  align-items: center;
  gap: calc(var(--island-font, 13px) * 0.62);
  padding: 0 calc(var(--island-font, 13px) * 0.78);
}

.pill-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: calc(var(--island-font, 13px) * 1.24);
  height: calc(var(--island-font, 13px) * 1.24);
  border-radius: 50%;
  background: var(--wn-surface);
  color: var(--wn-text-1);
}

.pill-icon svg {
  width: calc(var(--island-font, 13px) * 0.86);
  height: calc(var(--island-font, 13px) * 0.86);
}

.pill-icon.call {
  color: #ff9f0a;
}

.pill-icon.urgent {
  color: #ff453a;
}

.pill-icon.homework {
  color: var(--island-accent);
}

.pill-text {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-width: 0;
  flex: 1 1 auto;
  gap: 1px;
}

.pill-title {
  font-size: calc(var(--island-font, 13px) * 0.92);
  font-weight: 600;
  line-height: 1.15;
  color: var(--wn-text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pill-sub {
  font-size: calc(var(--island-font, 13px) * 0.74);
  line-height: 1.15;
  color: var(--wn-text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pill-chevron {
  display: inline-flex;
  align-items: center;
  color: rgba(255, 255, 255, 0.34);
  flex: 0 0 auto;
}

.pill-chevron svg {
  width: calc(var(--island-font, 13px) * 0.86);
  height: calc(var(--island-font, 13px) * 0.86);
}

/* ---------------------------------------------------------------- 展开卡（expanded） */

.island-card.expanded .content {
  padding: calc(var(--island-font, 13px) * 1.4) calc(var(--island-font, 13px) * 1.6);
  gap: calc(var(--island-font, 13px) * 0.7);
  /* 内容块整体垂直居中：卡片尺寸固定（锚点稳定），留白上下均分比"底部一大块空"更自然 */
  justify-content: center;
}

.head {
  display: flex;
  align-items: center;
  gap: calc(var(--island-font, 13px) * 0.7);
  flex: 0 0 auto;
}

.head-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: calc(var(--island-font, 13px) * 1.62);
  height: calc(var(--island-font, 13px) * 1.62);
  border-radius: calc(var(--island-font, 13px) * 0.5);
  background: var(--wn-surface);
  color: var(--wn-text-1);
  flex: 0 0 auto;
}

.head-icon svg {
  width: calc(var(--island-font, 13px) * 1.05);
  height: calc(var(--island-font, 13px) * 1.05);
}

.head-icon.urgent {
  background: rgba(255, 69, 58, 0.2);
  color: #ff453a;
}

.head-icon.call {
  background: rgba(255, 159, 10, 0.2);
  color: #ff9f0a;
}

.head-icon.homework {
  background: color-mix(in srgb, var(--island-accent) 22%, transparent);
  color: var(--island-accent);
}

.head-meta {
  display: flex;
  align-items: center;
  gap: calc(var(--island-font, 13px) * 0.55);
  min-width: 0;
  flex: 1 1 auto;
}

.badge {
  display: inline-flex;
  align-items: center;
  height: calc(var(--island-font, 13px) * 1.5);
  padding: 0 calc(var(--island-font, 13px) * 0.62);
  border-radius: 999px;
  font-size: calc(var(--island-font, 13px) * 0.76);
  font-weight: 600;
  letter-spacing: 0.02em;
  background: color-mix(in srgb, var(--island-accent) 26%, transparent);
  color: color-mix(in srgb, var(--island-accent) 70%, #ffffff);
  flex: 0 0 auto;
}

.badge-urgent {
  background: rgba(255, 69, 58, 0.24);
  color: #ff6961;
}

.badge-high {
  background: rgba(255, 159, 10, 0.22);
  color: #ffb340;
}

.badge-low,
.badge-normal {
  background: rgba(255, 255, 255, 0.12);
  color: rgba(255, 255, 255, 0.78);
}

.badge-call {
  background: rgba(255, 159, 10, 0.24);
  color: #ffb340;
}

.badge-homework {
  background: color-mix(in srgb, var(--island-accent) 26%, transparent);
  color: color-mix(in srgb, var(--island-accent) 72%, #ffffff);
}

.live-dot {
  display: inline-flex;
  align-items: center;
  gap: calc(var(--island-font, 13px) * 0.32);
  font-size: calc(var(--island-font, 13px) * 0.76);
  color: #ff6961;
  white-space: nowrap;
}

.live-dot.call {
  color: #ffb340;
}

.live-dot.muted {
  color: var(--wn-text-3);
}

.head-sub {
  font-size: calc(var(--island-font, 13px) * 0.78);
  color: var(--wn-text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: calc(var(--island-font, 13px) * 1.7);
  height: calc(var(--island-font, 13px) * 1.7);
  border: none;
  border-radius: 50%;
  background: var(--wn-surface);
  color: rgba(255, 255, 255, 0.72);
  cursor: pointer;
  flex: 0 0 auto;
  transition:
    background 0.15s ease,
    color 0.15s ease;
}

.icon-btn:hover {
  background: var(--wn-surface-hover);
  color: #fff;
}

.icon-btn svg {
  width: calc(var(--island-font, 13px) * 0.8);
  height: calc(var(--island-font, 13px) * 0.8);
}

.title {
  margin: 0;
  font-size: calc(var(--island-font, 13px) * 1.08);
  font-weight: 700;
  line-height: 1.3;
  color: #fff;
  flex: 0 0 auto;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.body {
  flex: 0 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: calc(var(--island-font, 13px) * 0.35);
  overflow: hidden;
}

.content-text {
  margin: 0;
  font-size: calc(var(--island-font, 13px) * 0.95);
  line-height: 1.42;
  color: var(--wn-text-2);
  word-break: break-word;
}

.call-hint {
  margin: 0;
  font-size: calc(var(--island-font, 13px) * 0.85);
  line-height: 1.4;
  color: color-mix(in srgb, var(--state-color) 66%, #ffffff);
  word-break: break-word;
}

.foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: calc(var(--island-font, 13px) * 0.7);
  flex: 0 0 auto;
  margin-top: calc(var(--island-font, 13px) * 0.5);
  padding-top: calc(var(--island-font, 13px) * 0.7);
  border-top: 1px solid var(--wn-divider);
}

.more {
  font-size: calc(var(--island-font, 13px) * 0.78);
  color: var(--wn-text-2);
  white-space: nowrap;
}

.more.muted {
  color: var(--wn-text-3);
}

.actions {
  display: flex;
  align-items: center;
  gap: calc(var(--island-font, 13px) * 0.5);
  flex: 0 0 auto;
}

.ghost-btn,
.solid-btn {
  height: calc(var(--island-font, 13px) * 2.05);
  padding: 0 calc(var(--island-font, 13px) * 0.9);
  border: none;
  border-radius: 999px;
  font-size: calc(var(--island-font, 13px) * 0.76);
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition:
    background 0.15s ease,
    transform 0.12s ease;
}

.ghost-btn {
  background: var(--wn-surface);
  color: var(--wn-text-1);
}

.ghost-btn:hover {
  background: var(--wn-surface-hover);
}

.solid-btn {
  background: #ffffff;
  color: #0b0b0f;
}

.island-card.call .solid-btn {
  background: #ff9f0a;
  color: #1a1205;
}

.island-card.urgent .solid-btn {
  background: #ff453a;
  color: #ffffff;
}

.ghost-btn:active,
.solid-btn:active {
  transform: scale(0.97);
}

/* ---------------------------------------------------------------- 过渡（无缩放、无回弹） */

.island-instant-enter-active {
  transition: none;
}

.island-instant-enter-from {
  opacity: 1;
}

.island-instant-leave-active {
  transition: opacity calc(var(--island-dur, 320ms) * 0.28) ease-out;
}

.island-instant-leave-to {
  opacity: 0;
}

/* 展开 / 收回：只做淡入淡出，形变交给窗口尺寸（避免任何缩放回弹"震动"） */
.island-fade-enter-active {
  transition: opacity calc(var(--island-dur, 320ms) * 0.45) ease-out;
}

.island-fade-leave-active {
  transition: opacity calc(var(--island-dur, 320ms) * 0.3) ease-out;
}

.island-fade-enter-from,
.island-fade-leave-to {
  opacity: 0;
}
</style>
