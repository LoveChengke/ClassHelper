<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  DEFAULT_ISLAND_APPEARANCE,
  ISLAND_SHADOW_PAD,
  ISLAND_SIZE_DELTA,
  ISLAND_SLIVER_WIDTH,
  PRIORITY_RANK,
  islandListLayout,
  type IslandAppearance,
  PRIORITY_LABELS,
  formatDate,
  type IslandListLayout,
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
const queueCount = computed(() => state.value.queued.length);

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

const isListMode = computed(() => listLayout.value !== null);
/** 列表里实际渲染出来的通知 */
const listItems = computed<IslandNotification[]>(() =>
  listLayout.value ? pendingNotifications.value.slice(0, listLayout.value.rows) : [],
);
/** 没能展示出来的条数（点"展开更多"能看到一部分，剩下的只能去应用里看） */
const hiddenCount = computed(() => Math.max(0, pendingCount.value - listItems.value.length));
const listHint = computed<IslandListLayout['hint']>(() => listLayout.value?.hint ?? null);

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

/**
 * 是否显示「标为已读」。
 *
 * 作业卡片的 id 是本地合成的 `homework-<作业id>`（见 renderer/island/bridge.ts），
 * 库里并没有这条通知，点它会让通知中心去调 `POST /notifications/homework-xxx/read` 并弹「通知不存在」。
 * 因此作业卡不提供该按钮（它本来也不是"通知"，用「知道了」收起即可）。
 * 列表形态下只要**至少有一条真通知**就提供（作业行会被主进程按 kind 过滤掉）。
 */
const canMarkRead = computed(() => {
  if (isListMode.value) {
    return pendingNotifications.value.some((item) => item.kind !== 'homework');
  }
  return notification.value?.kind !== 'homework';
});

/** 列表里单行的类型（徽标/图标配色） */
function rowKind(item: IslandNotification): IslandNotificationKind {
  return item.kind ?? 'notification';
}

function rowBadgeText(item: IslandNotification): string {
  const itemKind = rowKind(item);
  if (itemKind === 'call') return '叫人';
  if (itemKind === 'homework') return '新作业';
  return PRIORITY_LABELS[item.priority] ?? item.priority;
}

function rowBadgeClass(item: IslandNotification): string {
  const itemKind = rowKind(item);
  if (itemKind === 'call') return 'badge-call';
  if (itemKind === 'homework') return 'badge-homework';
  return `badge-${item.priority.toLowerCase()}`;
}

function rowSubText(item: IslandNotification): string {
  const teacher = item.teacherName ? `${item.teacherName} · ` : '';
  return `${teacher}${formatDate(item.createdAt, true)}`;
}

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
  // 多条消息时"知道了"是**整批**处理：卡片上就一排按钮，点它就是把这批都放下去
  bridge?.sendAction(isListMode.value ? 'dismiss-all' : 'dismiss');
}

/** "展开更多"：把列表铺到屏幕放得下的程度（主进程负责把窗口长高） */
function expandList(): void {
  bridge?.sendAction('expand-list');
}

function markRead(): void {
  if (isListMode.value) {
    bridge?.sendAction('mark-all-read');
    return;
  }
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
  // 多条消息的列表：高度由共享的列表布局算出（与主进程算的窗口包围盒同一个数）
  const layout = listLayout.value;
  if (layout) return { width: width + EXTRA.expanded.width, height: layout.height };
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
/** 形变兜底定时器：rAF 被系统限流时用它 snap 到目标几何（见 startFrameLoop） */
let morphFallbackTimer: number | null = null;
/** 兜底等待时长：正常形变约 300~500ms，超出这个时间说明帧被限流了 */
const MORPH_FALLBACK_MS = 1200;

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
const pillAlpha = computed(() => Math.max(0, Math.min(1, 1 - progress.value * 1.5)));
/** 展开内容透明度：进度平方（WinIsland expanded_alpha = progress²） */
const expandedAlpha = computed(() => progress.value * progress.value);

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
  window.setInterval(() => bridge?.alive?.(), 5000);
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
        <span
          class="layer expanded-layer"
          :class="{ 'list-mode': isListMode }"
          :style="{ opacity: expandedAlpha }"
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
            <span v-else class="more muted">来自班级小助手</span>
            <span class="actions">
              <button type="button" class="ghost-btn" @click.stop="openApp">打开应用</button>
              <button v-if="canMarkRead" type="button" class="ghost-btn" @click.stop="markRead">
                标为已读
              </button>
              <button type="button" class="solid-btn" @click.stop="dismiss">
                {{ isCall && !isListMode ? '收到' : '知道了' }}
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
  /* WinIsland「glass 无 host backdrop」降级色：比纯黑透一点，但保证任何桌面下都不是白底 */
  --wn-bg: rgba(32, 32, 36, 0.804);
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
  /*
    投影**始终声明**，形态切换只改参数 —— 不要写成"只在 .expanded 上挂 filter"。
    给元素加 / 去 CSS filter 会让 Chromium 新建或销毁它的渲染表面（effect node），
    而首帧的合成可能发生在新表面栅格化完成之前，那一帧会被当作空内容画出去；
    卡片的底色恰恰就画在这个被过滤的元素上（fill 在本元素），于是**开/合的那一瞬间
    底座会闪掉一帧、只剩未过滤的文字层**（用户反馈的"开合时一瞬间的闪动"）。
    胶囊态用 0 0 0：硬轮廓投影正好压在路径底下，肉眼等同无投影，与 WinIsland
    "只有展开态有投影"的观感一致。
  */
  filter: drop-shadow(0 var(--card-shadow-y, 0px) var(--card-shadow-blur, 0px) rgba(0, 0, 0, 0.11));
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

/* 展开态投影（WinIsland: rgba(0,0,0,.11)、y+2、σ=3 → CSS 0 2px 3px）。
   只改参数、不动 filter 声明本身，理由见上面的 .shape path。 */
.island-card.expanded .shape path {
  --card-shadow-y: 2px;
  --card-shadow-blur: 3px;
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
  /* 水平对齐交给 .pill-inner（它固定为胶囊几何，且按停靠方式贴边/居中） */
  justify-content: flex-start;
}

/**
 * 胶囊内容盒：**固定为胶囊自己的宽高与内边距**，不随卡片形变重排。
 *
 * 为什么必须固定：卡片在开合时 268 ⇄ 424 变宽变窄，而中心停靠下卡片的左右边都会动。
 * 内容若跟着卡片宽度走，就会出现"文字先按宽卡片铺开、再随卡片收窄被省略号收回"
 * （用户反馈的"新消息那行字往右跳一下再缩回"），底部也会被收缩的形状裁掉一块。
 * 固定成胶囊几何后：文字在整段动画里位置与省略号都不变，只是随卡片一起淡出/淡入。
 *
 * 贴哪条边与卡片停靠方式一致（左停靠贴左、右停靠贴右、居中则居中对齐）——
 * 这样卡片变宽时内容也不会横移，静止态外观与之前完全一致。
 */
.pill-inner {
  display: inline-flex;
  flex-direction: row;
  align-items: center;
  flex: 0 0 auto;
  gap: calc(var(--island-font, 13px) * 0.62);
  width: var(--island-w, 268px);
  height: 100%;
  padding: 0 calc(var(--island-font, 13px) * 0.78);
}

.island-card[data-anchor='center'] .pill-layer {
  justify-content: center;
}

.island-card[data-anchor='right'] .pill-layer {
  justify-content: flex-end;
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

/*
 * 多条通知的列表形态。
 *
 * 这里的每个尺寸都必须与 @classhelper/shared 的 `ISLAND_LIST_METRICS` 一一对应：
 * 主进程按那份度量算出**窗口包围盒**（列表比普通展开卡高，窗口不够高会把底部按钮裁掉），
 * 渲染进程按同一份度量排布。改这里就必须改那里，否则会出现"最后一行被切掉"。
 * 选择器一律写成 `.expanded-layer.list-mode ...`（比基类的单类选择器更具体），
 * 免得被后面定义的 `.title` / `.body` 覆盖掉尺寸——那样高度就对不上算出来的值了。
 */
.expanded-layer.list-mode {
  /* 高度已经算准，改 flex-start：居中排版一旦有像素级误差会把上下两端同时切掉 */
  justify-content: flex-start;
}

.expanded-layer.list-mode .head {
  height: calc(var(--island-font, 13px) * 1.7);
}

.expanded-layer.list-mode .title {
  flex: 0 0 auto;
  display: block;
  height: calc(var(--island-font, 13px) * 1.4);
  line-height: 1.4;
  -webkit-line-clamp: unset;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.expanded-layer.list-mode .body {
  flex: 1 1 auto;
  min-height: 0;
  gap: calc(var(--island-font, 13px) * 0.4);
  justify-content: flex-start;
  overflow: hidden;
}

.head-icon.list {
  background: color-mix(in srgb, var(--island-accent) 20%, transparent);
  color: var(--island-accent);
}

.list-row {
  display: flex;
  align-items: center;
  gap: calc(var(--island-font, 13px) * 0.55);
  flex: 0 0 auto;
  width: 100%;
  height: calc(var(--island-font, 13px) * 2.7);
  padding: 0 calc(var(--island-font, 13px) * 0.6);
  border: none;
  border-radius: calc(var(--island-font, 13px) * 0.5);
  background: rgba(255, 255, 255, 0.045);
  color: var(--wn-text-1);
  text-align: left;
  cursor: pointer;
  transition: background var(--ch-dur-fast) var(--ch-ease-out);
}

.row-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: calc(var(--island-font, 13px) * 1.3);
  height: calc(var(--island-font, 13px) * 1.3);
  border-radius: calc(var(--island-font, 13px) * 0.36);
  background: var(--wn-surface);
  color: var(--wn-text-2);
}

.row-icon svg {
  width: calc(var(--island-font, 13px) * 0.86);
  height: calc(var(--island-font, 13px) * 0.86);
}

.row-icon.call {
  color: #ff9f0a;
}

.row-icon.homework {
  color: var(--island-accent);
}

.row-text {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 1px;
  min-width: 0;
  flex: 1 1 auto;
}

.row-title {
  font-size: calc(var(--island-font, 13px) * 0.9);
  font-weight: 600;
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.row-sub {
  font-size: calc(var(--island-font, 13px) * 0.68);
  line-height: 1.1;
  color: var(--wn-text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.row-badge {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  height: calc(var(--island-font, 13px) * 1.25);
  padding: 0 calc(var(--island-font, 13px) * 0.5);
  border-radius: 999px;
  font-size: calc(var(--island-font, 13px) * 0.68);
  font-weight: 600;
  background: rgba(255, 255, 255, 0.12);
  color: rgba(255, 255, 255, 0.78);
}

/* 列表底部的提示行：能展开时是按钮，屏幕到任务栏了就是一句"去应用里看" */
.list-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  height: calc(var(--island-font, 13px) * 2.1);
}

.more-btn {
  border: none;
  background: var(--wn-surface);
  color: var(--wn-text-1);
  height: 100%;
  width: 100%;
  border-radius: calc(var(--island-font, 13px) * 0.5);
  font-size: calc(var(--island-font, 13px) * 0.76);
  font-weight: 600;
  cursor: pointer;
  transition: background var(--ch-dur-fast) var(--ch-ease-out);
}

.more-app {
  font-size: calc(var(--island-font, 13px) * 0.76);
  color: var(--wn-text-3);
  white-space: nowrap;
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
    background var(--ch-dur-fast) var(--ch-ease-out),
    color var(--ch-dur-fast) var(--ch-ease-out);
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
    background var(--ch-dur-fast) var(--ch-ease-out),
    transform var(--ch-dur-instant) var(--ch-ease-out);
}

.ghost-btn {
  background: var(--wn-surface);
  color: var(--wn-text-1);
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

/* --------------------------------------------------------------- 悬停微交互
 *
 * **必须关在 `@media (hover: hover) and (pointer: fine)` 里**：教室机器上的希沃触摸屏
 * 点一下会产生"幽灵 hover"并**一直粘着**，直到点别处才消失 —— 不关的话，点过「知道了」
 * 的按钮会永远保持高亮（同 AGENTS.md §5 第 30 条那类问题）。
 * 这是 beUI `useHoverCapable` 的 CSS 版：纯样式效果用媒体查询就够，不必挂 composable。
 */
@media (hover: hover) and (pointer: fine) {
  .list-row:hover {
    background: var(--wn-surface);
  }

  .more-btn:hover,
  .ghost-btn:hover {
    background: var(--wn-surface-hover);
  }

  .icon-btn:hover {
    background: var(--wn-surface-hover);
    color: #ffffff;
  }
}

/*
 * 关于本岛的动效：**只有单调缓动（无过冲、无回弹）**，曲线取自共享令牌
 * （`--ch-ease-out`，见 packages/shared/src/motion.ts）。
 *
 * 这里刻意**不用** beUI 那几组弹簧：弹簧带过冲，而本岛的形变由主进程按状态缓动窗口尺寸
 * （`src/main/island.ts`），任何回弹都会让"开合"看起来在震动 ——
 * 冒烟断言「展开过程不震动」「收回过程不抖动」逐帧采样岛体几何，正是为这条立的规矩。
 * 岛的物理是自己的一套（`./spring.ts`，从 WinIsland 逐行移植），不该被换掉。
 *
 * （这里原本还有 `.island-instant-*` / `.island-fade-*` 两组过渡类 —— 它们**是死规则**：
 * 全包只有 `<style>` 里出现，没有任何地方挂类名，是 §5 第 34 条删掉"收回快照"动画后的残留。
 * 已删除，免得后人以为岛上存在一层 Vue `<Transition>`。）
 */
</style>
