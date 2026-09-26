<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  DEFAULT_ISLAND_APPEARANCE,
  ISLAND_SHADOW_PAD,
  ISLAND_SIZE_DELTA,
  ISLAND_SLIVER_WIDTH,
  type IslandAppearance,
  PRIORITY_LABELS,
  formatDate,
  type IslandNotification,
  type IslandNotificationKind,
  type IslandState,
} from '@classhelper/shared';
import { SpringValue } from './spring.js';
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

/**
 * 未处理消息的**类型汇总**（当前展示的 + 队列里的）：
 * 用户要求收起后的胶囊直接说明这批消息里都有什么，例如
 * 「新消息：叫人/作业/通知（共 3 条）」+「点击查看」。
 */
const TYPE_LABELS: Record<IslandNotificationKind, string> = {
  call: '叫人',
  homework: '作业',
  notification: '通知',
};
/** 汇总展示顺序：叫人 > 作业 > 通知（与用户示例一致） */
const TYPE_ORDER: IslandNotificationKind[] = ['call', 'homework', 'notification'];

const pendingNotifications = computed<IslandNotification[]>(() => {
  const list: IslandNotification[] = [];
  if (state.value.active) list.push(state.value.active);
  for (const item of state.value.queued) {
    if (!list.some((existing) => existing.id === item.id)) list.push(item);
  }
  return list;
});

/** 这批未处理消息覆盖了哪些类型（按"叫人/作业/通知"顺序） */
const pendingTypes = computed<string[]>(() => {
  const kinds = new Set(pendingNotifications.value.map((item) => item.kind ?? 'notification'));
  return TYPE_ORDER.filter((item) => kinds.has(item)).map((item) => TYPE_LABELS[item]);
});

const pendingCount = computed(() => pendingNotifications.value.length);

/** 多条消息时把类型摊开：`新消息：叫人/作业/通知（共 3 条）` */
const pillSummaryTitle = computed(() => {
  if (pendingCount.value <= 1) return pillTitle.value;
  const types = pendingTypes.value.join('/');
  return types ? `新消息：${types}（共 ${pendingCount.value} 条）` : `新消息（共 ${pendingCount.value} 条）`;
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

/** 各形态相对"胶囊"的尺寸增量（与主进程共用同一常量表，避免两边漂移） */
const EXTRA = ISLAND_SIZE_DELTA;

/**
 * 岛的目标尺寸（**岛本身**，不是窗口）：
 * - 胶囊：外观设置里的 width/height
 * - 展开/紧急/叫人：胶囊 + `EXTRA`
 * - 空闲细缝：6px 宽竖条（WinIsland hidden_width 的思路）
 * 全部由下面的弹簧逐帧逼近，窗口（固定包围盒）全程不动。
 */
function targetSize(): { width: number; height: number } {
  const width = appearance.value.width;
  const height = appearance.value.height;
  if (mode.value === 'hidden') {
    // 有"空闲细缝"时才收成细缝；否则保持胶囊尺寸——
    // 窗口此时是隐藏的，没必要缩到细缝（否则下次弹出会从细缝"长大"，多出入场动画）。
    if (!appearance.value.idleSliver) return { width, height };
    return { width: ISLAND_SLIVER_WIDTH, height: Math.max(12, Math.min(28, height - 22)) };
  }
  if (mode.value !== 'expanded') return { width, height };
  const extra = isCall.value ? EXTRA.call : isUrgent.value ? EXTRA.urgent : EXTRA.expanded;
  return { width: width + extra.width, height: height + extra.height };
}

/** 圆角：胶囊取 h/2（满圆角），展开卡取 min(48*系数, w/2, h/2)（WinIsland expanded_island_radius） */
function targetRadius(size: { width: number; height: number }): number {
  if (mode.value !== 'expanded') return Math.min(appearance.value.radius, size.height / 2);
  const scaled = (48 * appearance.value.radius) / 20;
  return Math.max(0, Math.min(scaled, size.width / 2, size.height / 2));
}

/* ---------------------------------------------------------------- 弹簧形变 */

const springs = {
  width: new SpringValue(DEFAULT_ISLAND_APPEARANCE.width),
  height: new SpringValue(DEFAULT_ISLAND_APPEARANCE.height),
  radius: new SpringValue(DEFAULT_ISLAND_APPEARANCE.radius),
};

/** 当前正在播放的形变值（渲染用） */
const morph = ref<{ width: number; height: number; radius: number }>({
  width: DEFAULT_ISLAND_APPEARANCE.width,
  height: DEFAULT_ISLAND_APPEARANCE.height,
  radius: DEFAULT_ISLAND_APPEARANCE.radius,
});
/** 形变进度 0（胶囊）→ 1（展开）：用于内容交叉淡入（WinIsland expanded_alpha / mini_alpha） */
const progress = ref(0);

let rafHandle: number | null = null;
let lastFrameAt = 0;

function syncTargets(snap = false): void {
  const size = targetSize();
  const radius = targetRadius(size);
  if (snap || !appearance.value.animations) {
    springs.width.snap(size.width);
    springs.height.snap(size.height);
    springs.radius.snap(radius);
    morph.value = { width: size.width, height: size.height, radius };
    progress.value = mode.value === 'expanded' ? 1 : 0;
    refreshInteractive();
    return;
  }
  springs.width.setTarget(size.width);
  springs.height.setTarget(size.height);
  springs.radius.setTarget(radius);
  startFrameLoop();
  // 目标几何变了：立刻按新尺寸重算一次命中（形变过程中每帧也会重算）
  refreshInteractive();
}

function startFrameLoop(): void {
  if (rafHandle !== null) return;
  lastFrameAt = performance.now();
  const frame = (now: number): void => {
    const delta = now - lastFrameAt;
    lastFrameAt = now;
    // 个性化"动画速度"：直接缩放 dt（WinIsland 没有该设置，这是我们的扩展）
    const scaled = delta * appearance.value.speed;
    const moving = springs.width.step(scaled) || springs.height.step(scaled) || springs.radius.step(scaled);

    morph.value = {
      width: springs.width.value,
      height: springs.height.value,
      radius: springs.radius.value,
    };

    // 内容交叉淡入：胶囊层先淡出（进度 2/3 前退净），展开层按平方淡入（WinIsland 的做法）
    const pill = appearance.value.height;
    const expanded = targetSize().height;
    const span = Math.abs(expanded - pill);
    progress.value =
      span < 1 ? (mode.value === 'expanded' ? 1 : 0) : Math.abs(morph.value.height - pill) / span;

    if (moving || !springs.width.settled || !springs.height.settled || !springs.radius.settled) {
      // 形变过程中岛的可点区域在变：每帧按缓存指针位置重算命中（值不变时不发 IPC）
      refreshInteractive();
      rafHandle = requestAnimationFrame(frame);
      return;
    }
    // 收尾对齐（避免浮点残差）
    const size = targetSize();
    springs.width.snap(size.width);
    springs.height.snap(size.height);
    springs.radius.snap(targetRadius(size));
    morph.value = { width: size.width, height: size.height, radius: springs.radius.value };
    progress.value = mode.value === 'expanded' ? 1 : 0;
    refreshInteractive();
    rafHandle = null;
  };
  rafHandle = requestAnimationFrame(frame);
}

/**
 * 实际生效的圆角：始终钳制到 `min(圆角, w/2, h/2)`。
 * 弹簧对"尺寸"与"圆角"是各自独立推进的，形变过程中圆角可能短暂大于 h/2；
 * 统一钳制既保证形状合法，也让 CSS 变量与真实绘制一致（便于断言）。
 */
const effectiveRadius = computed(() =>
  Math.max(0, Math.min(morph.value.radius, morph.value.width / 2, morph.value.height / 2)),
);

/** 连续圆角路径（超椭圆角，见 squircle.ts） */
const cardPath = computed(() => squirclePath(morph.value.width, morph.value.height, effectiveRadius.value));

/** 胶囊内容透明度：进度到 2/3 时完全退净（WinIsland MINI_FADE_RATE = 1.5） */
const pillAlpha = computed(() => Math.max(0, Math.min(1, 1 - progress.value * 1.5)));
/** 展开内容透明度：进度平方（WinIsland expanded_alpha = progress²） */
const expandedAlpha = computed(() => progress.value * progress.value);

/**
 * 岛在**固定窗口**内的定位（照搬 WinIsland：窗口不动，岛在画布内居中/贴边形变）。
 * 水平：居中锚点用 `left: 50% + translateX(-50%)`；左/右锚点贴边（留阴影余量）。
 */
const islandStyle = computed(() => {
  const position = appearance.value.position;
  const style: Record<string, string> = {
    width: `${morph.value.width}px`,
    height: `${morph.value.height}px`,
    '--card-path': `path("${cardPath.value}")`,
    '--card-r': `${morph.value.radius}px`,
    '--state-color': stateColor.value || 'transparent',
  };
  if (position.endsWith('left')) {
    style.left = `${ISLAND_SHADOW_PAD}px`;
  } else if (position.endsWith('right')) {
    style.right = `${ISLAND_SHADOW_PAD}px`;
  } else {
    style.left = '50%';
    style.transform = 'translateX(-50%)';
  }
  if (position.startsWith('bottom')) style.bottom = `${ISLAND_SHADOW_PAD}px`;
  else style.top = `${ISLAND_SHADOW_PAD}px`;
  return style;
});

/** 当前形态的样式类（供既有断言与样式复用） */
const islandClass = computed(() => ({
  pill: mode.value === 'pill' || (mode.value === 'hidden' && !appearance.value.idleSliver),
  expanded: mode.value === 'expanded',
  'hidden-placeholder': mode.value === 'hidden' && !appearance.value.idleSliver,
  sliver: mode.value === 'hidden' && appearance.value.idleSliver,
  urgent: isUrgent.value,
  call: isCall.value,
  homework: isHomework.value,
  'after-class': showAfterClassHint.value,
}));

/**
 * 鼠标命中测试（照搬 WinIsland 的 set_cursor_hittest 思路）：
 * 指针在岛体上（或可交互控件上）时才让窗口接收鼠标，否则穿透，保证不吞桌面点击。
 */
let lastInteractive: boolean | null = null;
/** 最近一次已知的指针位置：岛收起/变大后用它重算命中，避免"鼠标没动就点不到" */
let lastPointer: { x: number; y: number } | null = null;
/** 最近一次上报给主进程的岛体矩形（去重 + 限流，避免形变期间刷屏 IPC 拖慢渲染） */
let lastHitRectKey: string | null = null;
let lastHitRectAt = 0;
/**
 * 岛体矩形上报的最小间隔：主进程按它做命中判定，限流太大就会在形变结束后留下
 * 一段"矩形比实际卡片大"的死区（那段时间窗口会吃掉看不见区域的点击）。
 * 50ms 既不会刷爆 IPC，也能让死区短到无感。
 */
const HIT_RECT_MIN_INTERVAL_MS = 50;
let hitRectTrailingTimer: number | null = null;

/** 把岛体矩形上报给主进程：主进程按光标位置兜底校正命中（不依赖 mousemove 转发） */
function reportHitRect(rect: DOMRect | null): void {
  const payload = rect ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height } : null;
  const key = payload
    ? `${Math.round(payload.x)},${Math.round(payload.y)},${Math.round(payload.width)},${Math.round(payload.height)}`
    : 'none';
  if (key === lastHitRectKey) return;
  lastHitRectKey = key;
  const now = performance.now();
  const elapsed = now - lastHitRectAt;
  if (elapsed >= HIT_RECT_MIN_INTERVAL_MS) {
    lastHitRectAt = now;
    bridge?.setHitRect?.(payload);
    return;
  }
  // 限流：形变过程中每帧都发会挤占主进程（实测拖慢到采样都变少），
  // 这里保证"最后一次形状"一定会送达（尾随发送）。
  if (hitRectTrailingTimer !== null) window.clearTimeout(hitRectTrailingTimer);
  hitRectTrailingTimer = window.setTimeout(() => {
    hitRectTrailingTimer = null;
    lastHitRectAt = performance.now();
    const node = document.querySelector('.island-card') as HTMLElement | null;
    const fullyHidden = state.value?.mode === 'hidden' && !appearance.value.idleSliver;
    const latest = node && !fullyHidden ? node.getBoundingClientRect() : null;
    const latestPayload = latest
      ? { x: latest.left, y: latest.top, width: latest.width, height: latest.height }
      : null;
    lastHitRectKey = latestPayload
      ? `${Math.round(latestPayload.x)},${Math.round(latestPayload.y)},${Math.round(latestPayload.width)},${Math.round(latestPayload.height)}`
      : 'none';
    bridge?.setHitRect?.(latestPayload);
  }, HIT_RECT_MIN_INTERVAL_MS);
}

/**
 * 命中测试：把"指针在岛上"告诉主进程（照搬 WinIsland 的 set_cursor_hittest 思路）。
 *
 * **只上报 true**：窗口关闭命中一律由主进程按真实光标位置（60ms 轮询）决定。
 * 为什么不能两边都下发：渲染进程与主进程的几何不可能逐帧一致（弹簧形变 + 岛体矩形上报限流），
 * 两边都下发 true/false 时会互相覆盖，窗口就在"接收鼠标 / 穿透"之间来回抖动 ——
 * 用户点下去时窗口恰好处于穿透态，表现就是**点了没反应**（实测日志里 true/false 每几毫秒翻转一次）。
 */
function updateInteractive(clientX: number, clientY: number): void {
  lastPointer = { x: clientX, y: clientY };
  const node = document.querySelector('.island-card') as HTMLElement | null;
  let inside = false;
  if (node) {
    const rect = node.getBoundingClientRect();
    const margin = 2;
    inside =
      clientX >= rect.left - margin &&
      clientX <= rect.right + margin &&
      clientY >= rect.top - margin &&
      clientY <= rect.bottom + margin;
  }
  if (!inside) {
    // 离开岛体不做任何下发：交给主进程轮询关闭；这里只复位本地标记，
    // 保证下次指针进入时能立刻重新打开命中（不必等下一次轮询）。
    lastInteractive = false;
    return;
  }
  if (lastInteractive === true) return;
  lastInteractive = true;
  bridge?.setInteractive?.(true);
}

/**
 * 状态 / 外观变化后主动重算一次命中测试。
 *
 * 为什么必须主动算：窗口默认 `setIgnoreMouseEvents(true, {forward:true})`，
 * 只有在收到 mousemove 时才会打开命中。岛"收起 / 展开 / 换形态"时几何变了，
 * 但指针可能一动没动（没有新的 mousemove）—— 此时窗口会一直保持"穿透"，
 * 表现就是**收起后怎么点都打不开**（用户反馈）。所以每次状态变化都用缓存的指针位置重算一次。
 *
 * 另外这里会把当前岛体矩形上报主进程（`setHitRect`）：即使 Windows 下 mousemove 转发丢失，
 * 主进程也能按光标位置把命中校正回来 —— 这是"点开→收起→再也点不开"的兜底修复。
 * 注意：关闭命中（穿透）不由这里下发，见 updateInteractive 的说明。
 */
function refreshInteractive(): void {
  const node = document.querySelector('.island-card') as HTMLElement | null;
  const fullyHidden = state.value?.mode === 'hidden' && !appearance.value.idleSliver;
  reportHitRect(node && !fullyHidden ? node.getBoundingClientRect() : null);
  if (fullyHidden) {
    // 完全隐藏：本地复位即可（不下发关闭，窗口隐藏后由主进程轮询兜底关掉命中）
    lastInteractive = false;
    return;
  }
  if (!lastPointer) return;
  const pointer = lastPointer;
  lastInteractive = null; // 强制按新几何再算一次
  updateInteractive(pointer.x, pointer.y);
}

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
  style.setProperty('--island-dur', `${Math.round(320 / Math.max(0.25, next.speed))}ms`);
}

onMounted(async () => {
  window.addEventListener('mousemove', (event) => updateInteractive(event.clientX, event.clientY));
  bridge?.onState((next) => {
    state.value = next;
    syncTargets();
  });
  const initial = await bridge?.getState();
  if (initial) state.value = initial;
  // 外观：先同步一次，再订阅后续改动（改设置立即生效）
  bridge?.onAppearance((next) => {
    applyAppearance(next);
    syncTargets();
  });
  const initialAppearance = await bridge?.getAppearance?.();
  applyAppearance(initialAppearance);
  syncTargets(true);
  // 初始状态可能是 hidden（窗口未显示），此时同步一次目标即可
  syncTargets();
});
</script>

<template>
  <!--
    固定包围盒窗口内的**单个**灵动岛（照搬 WinIsland）：
    岛的宽高/圆角由弹簧逐帧逼近，窗口本身不动；胶囊层与展开层在里面交叉淡入。
  -->
  <div class="island-root">
    <div
      class="island-card"
      :class="islandClass"
      :data-style="appearance.style"
      :style="islandStyle"
      @click="mode === 'expanded' ? onCardClick($event) : expand()"
    >
      <!--
        形状层：显式给像素宽高 + preserveAspectRatio="none"。
        只写 width/height:100% 时 SVG 会按 viewBox 比例做 preserveAspectRatio 缩放，
        形变过程中 viewBox 与元素尺寸不同步就会出现形状错位/残留角（实测肉眼可见）。
      -->
      <svg
        class="shape"
        :width="Math.max(1, morph.width)"
        :height="Math.max(1, morph.height)"
        :viewBox="`0 0 ${Math.max(1, morph.width)} ${Math.max(1, morph.height)}`"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path :d="cardPath" />
      </svg>
      <span class="content">
        <span class="tint" aria-hidden="true"></span>

        <!-- 胶囊层（WinIsland compact）：进度 > 2/3 时完全退净 -->
        <span class="layer pill-layer" :style="{ opacity: pillAlpha }">
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
            <span class="pill-title">{{ pillSummaryTitle }}</span>
            <span class="pill-sub">
              <template v-if="pendingCount > 1">点击查看</template>
              <template v-else>{{ notification?.teacherName || '老师' }} · 点击查看</template>
            </span>
          </span>
          <!-- 多类型时把类型也做成小圆点，收起状态一眼看出有什么 -->
          <span v-if="pendingCount > 1 && pendingTypes.length > 1" class="pill-types" aria-hidden="true">
            <span v-for="item in pendingTypes" :key="item" class="pill-type">{{ item }}</span>
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

        <!-- 展开层（WinIsland expanded）：进度²淡入 -->
        <span class="layer expanded-layer" :style="{ opacity: expandedAlpha }">
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

          <h3 class="title">{{ notification?.title ?? '' }}</h3>
          <div class="body">
            <p class="content-text">{{ notification?.content ?? '' }}</p>
            <p v-if="callHint" class="call-hint">{{ callHint }}</p>
            <p v-else-if="notification?.subtitle" class="call-hint">{{ notification?.subtitle }}</p>
          </div>

          <footer class="foot">
            <span v-if="queueCount > 0" class="more">还有 {{ queueCount }} 条通知</span>
            <span v-else class="more muted">来自班级小助手</span>
            <span class="actions">
              <button type="button" class="ghost-btn" @click.stop="openApp">打开应用</button>
              <button type="button" class="ghost-btn" @click.stop="markRead">标为已读</button>
              <button type="button" class="solid-btn" @click.stop="dismiss">
                {{ isCall ? '收到' : '知道了' }}
              </button>
            </span>
          </footer>
        </span>
      </span>
    </div>
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
  left: 0;
  top: 0;
  display: block;
}

.island-card .shape path {
  fill: var(--wn-bg);
  stroke: var(--wn-border);
  stroke-width: 1;
}

/* 内容层裁切到同一形状内；内部两层（胶囊层 / 展开层）交叉淡入 */
.island-card .content {
  position: absolute;
  inset: 0;
  display: block;
  clip-path: var(--card-path);
  overflow: hidden;
}

.island-card .layer {
  position: absolute;
  inset: 0;
  display: flex;
  pointer-events: none;
}

/* 只有"当前形态"的那一层响应鼠标，避免透明层的按钮被误点 */
.island-card.pill .pill-layer,
.island-card.expanded .expanded-layer {
  pointer-events: auto;
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

.pill-layer {
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

/* 多条消息时把类型做成胶囊小标签（叫人/作业/通知），收起状态也能一眼看出内容构成 */
.pill-types {
  display: inline-flex;
  align-items: center;
  gap: calc(var(--island-font, 13px) * 0.2);
  flex: 0 0 auto;
  padding-right: calc(var(--island-font, 13px) * 0.2);
}

.pill-type {
  font-size: calc(var(--island-font, 13px) * 0.6);
  line-height: 1.4;
  padding: 0 calc(var(--island-font, 13px) * 0.36);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.12);
  color: var(--wn-text-2);
  white-space: nowrap;
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

.expanded-layer {
  /* 关键：展开层必须纵向排列。此前把 flex-direction 从基类挪到分层时漏了这一条，
     导致展开卡内容横排（标题/元信息/按钮散落，实机可见） */
  flex-direction: column;
  padding: calc(var(--island-font, 13px) * 1.4) calc(var(--island-font, 13px) * 1.6);
  gap: calc(var(--island-font, 13px) * 0.7);
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
