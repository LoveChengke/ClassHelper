<script setup lang="ts">
const props = defineProps<{ embedded?: boolean; suspended?: boolean }>();
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import {
  DEFAULT_ISLAND_APPEARANCE,
  ISLAND_SHADOW_PAD,
  ISLAND_SIZE_DELTA,
  ISLAND_SLIVER_WIDTH,
  PRIORITY_RANK,
  islandListLayout,
  type IslandAppearance,
  type IslandListLayout,
  type IslandNotification,
  type IslandNotificationKind,
  type IslandState,
} from '@classhelper/shared';
import { SpringValue } from './spring.js';
import { squirclePath } from './squircle.js';
import ClassicNotifications from './ClassicNotifications.vue';
import LessonReminderContent from './LessonReminderContent.vue';
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval>;
onUnmounted(() => clearInterval(clock));

/**
 * 灵动岛渲染进程 —— 视觉与排版参考 WinIsland（Rust/Direct2D 的 Windows 动态岛）。
 *
 * 对齐点（详见 docs/winisland-design-tokens.md）：
 * - 造型：**连续圆角（超椭圆 squircle）**而不是 border-radius（WinIsland `utils/shape.rs`）；
 *   展开卡半径取 `min(48 * 圆角系数, w/2, h/2)`，胶囊半径取 `h/2`（满圆角）；
 * - 底色：默认纯黑（WinIsland `default` 风格），可选半透明毛玻璃（`glass`；
 *   **纯 CSS 实现**，取 WinIsland 拿不到 host backdrop 时的降级色 `rgba(32,32,36,.804)`——
 *   Electron 的 `setBackgroundMaterial()` 不能用在逐像素透明窗口上，原因见 `main/island.ts`）；
 * - 描边：1px 白、alpha 30（纯黑）/ 40（玻璃、主题色），与 WinIsland `BORDER_*_ALPHA` 同值；
 * - 阴影：只在展开态，`0 2px 3px rgba(0,0,0,.11)`（WinIsland `draw_expanded_shadow`）；
 * - 排版：白字 + alpha 分级（.92/.72/.58），**所有文本 = 基础字号 × 排版系数**，
 *   因此「字号」设置一改，岛内文字整体等比缩放（WinIsland `font_size` 模型）；
 * - 动效：**单调缓动（无过冲、无回弹）**，只有淡入淡出与窗口形变，符合"开合不震动"。
 *   曲线取自共享令牌（`--ch-ease-out`，见 packages/shared/src/motion.ts）；
 *   刻意**不用** beUI 那几组带过冲的弹簧 —— 理由写在文件末尾"悬停微交互"那段。
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
  listExpanded: false,
  maxCardHeight: 1024,
  updatedAt: 0,
});

/**
 * 渲染状态直接来自主进程（**与仓库版一致，不再有"收回"快照层**）。
 *
 * 早先这里有一层 `closing`/`closingSnapshot`：点"知道了 / 标为已读"后把卡片按"胶囊摘要"收回再淡出。
 * 那套是自研的形变状态机，实测在触摸屏（窗口贴合岛体、形变时要动窗口）上会露出旧帧/重影，
 * 用户明确要求"动画就用仓库里那套"—— 于是整段删掉：收起一律走主进程的 `hide()`（窗口淡出），
 * 展开/收缩仍是弹簧形变（仓库机制，见 targetSize/progress）。
 */
const bridge = window.island;

const notification = computed<IslandNotification | null>(() => state.value.active);
const mode = computed(() => state.value.mode);
const isUrgent = computed(() => notification.value?.priority === 'URGENT');
const kind = computed<IslandNotificationKind>(() => notification.value?.kind ?? 'notification');
const isCall = computed(() => kind.value === 'call');
const isHomework = computed(() => kind.value === 'homework');

/**
 * 是不是"点了知道了 / 标为已读"之后的**收回动画**阶段（`reason === 'closing'`）。
 *
 * 这一阶段主进程已经把状态清空（`active` 为 null、`queued` 为空），形态却切回了胶囊：
 * 卡片正沿既有的形变路径收回，**胶囊里不该显示任何文字** —— 否则会闪出一句
 * "新消息 · 点击查看"（那是"有新消息"的语义，与"正在消失"正好相反）。
 */
const isClosing = computed(() => state.value.reason === 'closing');

/**
 * 这一批**未处理**的消息（正在展示的 + 队列里的），按「重要程度 → 时间」排序。
 * 与主进程 `pendingNotifications()` 同一口径（同一份 `PRIORITY_RANK`）。
 */
const pendingNotifications = computed<IslandNotification[]>(() => {
  const list: IslandNotification[] = [];
  if (state.value.active) list.push(state.value.active);
  for (const item of state.value.queued) {
    if (!list.some((existing) => existing.id === item.id)) list.push(item);
  }
  return list.sort((a, b) => {
    const rank = (PRIORITY_RANK[b.priority] ?? 0) - (PRIORITY_RANK[a.priority] ?? 0);
    if (rank !== 0) return rank;
    return String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''));
  });
});

const pendingCount = computed(() => pendingNotifications.value.length);

/**
 * 多条消息时的**列表布局**：显示几条、要不要"展开更多"、卡片多高。
 * 与主进程用同一个 `islandListLayout`（同一份度量）—— 主进程据此把窗口长高，两边必须算出一个数。
 */
const listLayout = computed<IslandListLayout | null>(() => {
  if (mode.value !== 'expanded' || pendingCount.value < 2) return null;
  return islandListLayout({
    count: pendingCount.value,
    fontSize: appearance.value.fontSize,
    maxHeight: state.value.maxCardHeight,
    expanded: state.value.listExpanded,
  });
});

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

/** 这批未处理消息覆盖了哪些类型（按"叫人/作业/通知"顺序） */
const pendingTypes = computed<string[]>(() => {
  const kinds = new Set(pendingNotifications.value.map((item) => item.kind ?? 'notification'));
  return TYPE_ORDER.filter((item) => kinds.has(item)).map((item) => TYPE_LABELS[item]);
});

/** 多条消息时把类型摊开：`新消息：叫人/作业/通知（共 3 条）` */
const pillSummaryTitle = computed(() => {
  if (pendingCount.value <= 1) return pillTitle.value;
  const types = pendingTypes.value.join('/');
  return types ? `新消息：${types}（共 ${pendingCount.value} 条）` : `新消息（共 ${pendingCount.value} 条）`;
});

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
  if (state.value.lessonReminder) return { width: width + EXTRA.expanded.width, height: 40 };
  if (mode.value === 'hidden') {
    // 有"空闲细缝"时才收成细缝；否则保持胶囊尺寸——
    // 窗口此时是隐藏的，没必要缩到细缝（否则下次弹出会从细缝"长大"，多出入场动画）。
    if (!appearance.value.idleSliver) return { width, height };
    return { width: ISLAND_SLIVER_WIDTH, height: Math.max(12, Math.min(28, height - 22)) };
  }
  if (mode.value !== 'expanded') return { width, height };
  // 多条消息的列表：高度由共享的列表布局算出（与主进程算的窗口包围盒同一个数）
  const layout = listLayout.value;
  if (layout) return { width: width + EXTRA.expanded.width, height: layout.height };
  const extra = isCall.value ? EXTRA.call : isUrgent.value ? EXTRA.urgent : EXTRA.expanded;
  return { width: width + extra.width, height: height + extra.height };
}

/** 圆角：胶囊取 h/2（满圆角），展开卡取 min(48*系数, w/2, h/2)（WinIsland expanded_island_radius） */
function targetRadius(size: { width: number; height: number }): number {
  if (state.value.lessonReminder) return 8;
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
/** 形变兜底定时器：rAF 被系统限流时用它 snap 到目标几何（见 startFrameLoop） */
let morphFallbackTimer: number | null = null;
/** 兜底等待时长：正常形变约 300~500ms，超出这个时间说明帧被限流了 */
const MORPH_FALLBACK_MS = 1200;

function syncTargets(snap = false): void {
  // 常驻岛有独立的 ClassIsland 过渡；旧胶囊不得在隐藏处继续形变、测量或发送命中。
  if (props.suspended) {
    if (rafHandle !== null) cancelAnimationFrame(rafHandle);
    if (morphFallbackTimer !== null) clearTimeout(morphFallbackTimer);
    rafHandle = null;
    morphFallbackTimer = null;
    return;
  }
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
  // 形变兜底：某些情况下（Windows 把置顶透明小窗判定为"被遮挡/后台"、GPU 进程刚重启等）
  // requestAnimationFrame 会被 Chromium 压到 1 帧/秒 —— 实测打包版细缝态出现过 1.1fps。
  // 那种情况下"点击后形变"看起来就是**没反应**（用户反馈的"点不动"）。因此这里挂一个定时器，
  // 到点若还没收敛就直接 snap 到目标几何：宁可少一段动画，也不能让点击看上去无效。
  if (morphFallbackTimer !== null) window.clearTimeout(morphFallbackTimer);
  morphFallbackTimer = window.setTimeout(() => {
    morphFallbackTimer = null;
    if (rafHandle === null) return; // 已经收敛
    if (rafHandle !== null) window.cancelAnimationFrame(rafHandle);
    rafHandle = null;
    const size = targetSize();
    springs.width.snap(size.width);
    springs.height.snap(size.height);
    springs.radius.snap(targetRadius(size));
    morph.value = { width: size.width, height: size.height, radius: springs.radius.value };
    progress.value = mode.value === 'expanded' ? 1 : 0;
    refreshInteractive();
  }, MORPH_FALLBACK_MS);
  const frame = (now: number): void => {
    const delta = now - lastFrameAt;
    lastFrameAt = now;
    // 个性化"动画速度"：直接缩放 dt（WinIsland 没有该设置，这是我们的扩展）
    const scaled = delta * appearance.value.speed;
    const moving = [
      springs.width.step(scaled),
      springs.height.step(scaled),
      springs.radius.step(scaled),
    ].some(Boolean);

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
    if (morphFallbackTimer !== null) {
      window.clearTimeout(morphFallbackTimer);
      morphFallbackTimer = null;
    }
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
const pillAlpha = computed(() =>
  state.value.lessonReminder ? 0 : Math.max(0, Math.min(1, 1 - progress.value * 1.5)),
);
/** 展开内容透明度：进度平方（WinIsland expanded_alpha = progress²） */
const expandedAlpha = computed(() => (state.value.lessonReminder ? 0 : progress.value * progress.value));

/**
 * 岛在**固定窗口**内的定位（照搬 WinIsland：窗口不动，岛在画布内居中/贴边形变）。
 * 水平：居中锚点用 `left: 50% + translateX(-50%)`；左/右锚点贴边（留阴影余量）。
 */
/** 水平锚点（供 CSS 决定胶囊内容贴哪条边：左贴左、右贴右、居中则居中对齐） */
const anchorName = computed<'left' | 'center' | 'right'>(() => {
  const position = appearance.value.position;
  return position.endsWith('left') ? 'left' : position.endsWith('right') ? 'right' : 'center';
});

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
  'hidden-placeholder':
    mode.value === 'hidden' && !appearance.value.idleSliver && !state.value.lessonReminder,
  'ci-lesson-card': !!state.value.lessonReminder,
  'message-surface': !!state.value.active && mode.value !== 'hidden' && !state.value.lessonReminder,
  sliver: mode.value === 'hidden' && appearance.value.idleSliver && !state.value.lessonReminder,
  urgent: isUrgent.value,
  call: isCall.value,
  homework: isHomework.value,
  'after-class': showAfterClassHint.value,
  // 收回动画：胶囊里不显示内容（见 isClosing 与 .island-card.closing 的说明）
  closing: isClosing.value,
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
  if (props.embedded) return;
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
    const fullyHidden =
      state.value?.mode === 'hidden' && !appearance.value.idleSliver && !state.value.lessonReminder;
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
  if (props.embedded) return;
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
  if (props.suspended) return;
  const node = document.querySelector('.island-card') as HTMLElement | null;
  const fullyHidden =
    state.value?.mode === 'hidden' && !appearance.value.idleSliver && !state.value.lessonReminder;
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

watch(
  () => props.suspended,
  () => syncTargets(true),
);
onMounted(async () => {
  clock = setInterval(() => (now.value = Date.now()), 1000);
  window.addEventListener('mousemove', (event) => updateInteractive(event.clientX, event.clientY));
  /**
   * 触摸屏上报：主进程据此把窗口改为**贴合岛体**并始终接收输入。
   *
   * 为什么必须报：触摸屏上"点不开"是机制性的 —— 打开命中的两条链路（本进程的 mousemove 转发、
   * 主进程读系统光标）都以"鼠标指针移动"为前提，而手指触摸既不产生 mousemove、也不移动系统光标，
   * 窗口会永远停在 `setIgnoreMouseEvents(true)` 的穿透态，手指点下去只落到桌面。
   * Chromium 在带触摸数字化仪的机器上会把 `maxTouchPoints` 置为非 0，用它当判据。
   */
  const reportTouchMode = (): void => bridge?.setTouchMode?.(true);
  if ((navigator.maxTouchPoints ?? 0) > 0) reportTouchMode();
  // 兜底：个别设备 maxTouchPoints 判定不到（或接的是外接触摸屏），真收到触摸事件时再补报一次
  window.addEventListener('touchstart', reportTouchMode, { passive: true, once: true });
  // 心跳：主进程据此判断本渲染进程是否还活着。一旦卡死/崩溃，主进程会隐藏这扇"幽灵窗口"
  // 并重建（否则 Windows 会把最后一帧留在屏幕上：岛看着还在，怎么点都没反应）。
  bridge?.alive?.();
  // 心跳由 LayoutIslandApp 统一维护，避免布局切换重复注册。
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
  <div
    class="island-root"
    :class="{ embedded: props.embedded }"
    :style="props.embedded ? { width: `${morph.width}px`, height: `${morph.height}px` } : undefined"
  >
    <div
      class="island-card"
      :class="islandClass"
      :data-anchor="anchorName"
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
          <!--
            胶囊内容固定成"胶囊自己的几何"（宽 = 外观宽度、贴合停靠边/中线）：
            卡片在开合时会变宽变窄，若让内容跟着卡片宽度走，文字会先按宽卡片铺开、
            再随卡片变窄被省略号收回（用户反馈的"新消息那行字往右跳一下再缩回"）。
          -->
          <span class="pill-inner">
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
        </span>

        <!-- 展开层（WinIsland expanded）：进度²淡入 -->
        <ClassicNotifications
          :state="state"
          :appearance="appearance"
          :max-height="state.maxCardHeight"
          :style="{ opacity: expandedAlpha }"
          class="layer"
        />
        <LessonReminderContent
          v-if="state.lessonReminder"
          :reminder="state.lessonReminder"
          :now="now"
          :appearance="appearance"
          :motion="appearance.animations && !props.suspended"
          class="ci-fixed-lesson"
        />
      </span>
    </div>
  </div>
</template>

<style src="./classic-island.css"></style>
