/**
 * 动效令牌 —— 移植自 beUI（https://beui.dev）的 `lib/ease.ts`。
 *
 * 移植范围与理由：
 * - beUI 的组件本身是 React（`motion/react` + Tailwind），无法在本项目的 Vue 两端直接使用；
 *   **但它的动效语言与框架无关**，这部分完整搬过来。
 * - 原文注释一并保留（"默认的 ease-in / ease-out 太弱，需要更强的自定义曲线"）——
 *   这条判断是本文件所有取值的出发点。
 *
 * **本文件必须保持"纯常量 + 纯函数"**：`packages/shared` 会被后端（Express）一起消费，
 * 它的 tsconfig 是 `lib: ["ES2023"]`（不含 DOM），所以这里不碰 `document`、不碰 `window`、
 * 也不依赖 vue。DOM 注入与 Vue 组合式函数在两端各自的 `composables/motion.ts` 里。
 *
 * 用法见 `motionCssVars()`：动效的**数值**只写在这里一份，两端在 `app.mount()` 之前
 * 把它写进 `:root` 的自定义属性，CSS 只引用 `var(--ch-…)` —— 避免"两端各抄一份、日久必漂"。
 */

/* ------------------------------------------------------------------ 缓动曲线 */

/** 四段式贝塞尔的两个控制点（与 CSS `cubic-bezier()` 同参）。 */
export type EasingCurve = readonly [number, number, number, number];

/** 主缓动：绝大多数进出场用它。收得干脆、尾巴长，是"贵"的那种手感。 */
export const EASE_OUT: EasingCurve = [0.16, 1, 0.3, 1];
/** 对称的来回动（抽屉推拉、内容互换）。 */
export const EASE_IN_OUT: EasingCurve = [0.77, 0, 0.175, 1];
/** 侧向抽屉专用：起步快、落位缓，从屏幕边缘滑入时比 EASE_OUT 更有"质量"。 */
export const EASE_DRAWER: EasingCurve = [0.32, 0.72, 0, 1];

/** 把曲线元组转成 CSS 字面量。 */
export function cubicBezierCss(curve: EasingCurve): string {
  return `cubic-bezier(${curve[0]}, ${curve[1]}, ${curve[2]}, ${curve[3]})`;
}

/* -------------------------------------------------------------------- 弹簧 */

/**
 * 弹簧参数，取自 beUI。语义与 `motion/react` 的 spring 一致：
 * 加速度 = (stiffness × 剩余距离 − damping × 当前速度) / mass。
 */
export interface SpringConfig {
  stiffness: number;
  damping: number;
  mass: number;
}

/** 按压反馈：按钮、可点表面。beUI 的 `whileTap: { scale: 0.93 }` 配它。 */
export const SPRING_PRESS: SpringConfig = { stiffness: 500, damping: 30, mass: 0.6 };
/** 控件内的内容互换（文字/图标换位）——比 PRESS 稍柔，避免小面积元素显得"抖"。 */
export const SPRING_SWAP: SpringConfig = { stiffness: 460, damping: 30, mass: 0.55 };
/** 浮层进场：弹窗、抽屉、气泡。刻意偏阻尼，落位不晃。 */
export const SPRING_PANEL: SpringConfig = { stiffness: 420, damping: 40, mass: 0.5 };
/** 共享布局滑动（药丸指示器、标签指示条）。 */
export const SPRING_LAYOUT: SpringConfig = { stiffness: 360, damping: 32, mass: 0.6 };
/** 光标跟随类装饰动效（磁吸、倾斜）。 */
export const SPRING_MOUSE: SpringConfig = { stiffness: 200, damping: 15, mass: 0.3 };
/** 拖拽的滑块与填充：临界阻尼，跟手但绝不回弹。 */
export const SPRING_GLIDE: SpringConfig = { stiffness: 700, damping: 50, mass: 0.5 };

/**
 * 由弹簧参数推出的固有角频率与阻尼比（`ζ ≥ 1` 表示不过冲）。
 * beUI 这六组里 PRESS / SWAP / MOUSE 欠阻尼，PANEL / LAYOUT / GLIDE 过阻尼。
 */
export function springDynamics(spring: SpringConfig): { omega0: number; zeta: number } {
  const omega0 = Math.sqrt(spring.stiffness / spring.mass);
  const zeta = spring.damping / (2 * Math.sqrt(spring.stiffness * spring.mass));
  return { omega0, zeta };
}

/* ---------------------------------------------------------------- 弹簧积分 */

/** 数值积分步长（1ms）——比任何刷新率都细，采样出来足够平滑。 */
const SIMULATION_STEP = 0.001;
/** `linear()` 的采样点数。60 段肉眼已看不出折线，再密只是徒增样式表体积。 */
const LINEAR_SAMPLES = 60;
/**
 * 落定判据（归一化空间，位移全程记作 1）：
 * 位置误差 ≤1%、速度 ≤5%/秒。1% 的位移误差在任何真实尺寸下都不到 1px；
 * 5%/秒 意味着单帧（16ms）只移动 0.08% 的行程 —— 比显示器能分辨的还小。
 */
const SETTLE_DISTANCE = 0.01;
const SETTLE_SPEED = 0.05;
/** 模拟上限，任何弹簧都远达不到。 */
const MAX_SIMULATION_MS = 1500;

interface SpringCurve {
  /** 从静止到落定所需的毫秒数。 */
  durationMs: number;
  /** 每个积分步的位移（0 → 1，可能短暂越过 1）。 */
  positions: number[];
}

/** 同一组参数会被反复查询（每次注入 CSS 变量都会走一遍），算一次存下来。 */
const curveCache = new Map<string, SpringCurve>();

/**
 * 按物理积分弹簧，直到落定。
 *
 * ⚠️ **不要用"包络衰减到某个比例"的解析近似来算时长**：那个公式（`t = 6 / (ζ·ω0)`）
 * 只对欠阻尼成立。过阻尼系统的衰减由**较慢的那个实极点** `ω0(ζ − √(ζ²−1))` 决定，
 * 拿 `ζ·ω0` 去估会**严重偏短** —— 实测 `SPRING_PANEL` 会被截在 0.869、
 * `SPRING_LAYOUT` 截在 0.952，缓动曲线根本走不到终点，元素永远差一截没就位。
 * 按落定判据积分则对两种阻尼都成立。
 */
function simulateSpring(spring: SpringConfig): SpringCurve {
  const key = `${spring.stiffness}/${spring.damping}/${spring.mass}`;
  const cached = curveCache.get(key);
  if (cached) return cached;

  const steps = Math.round(MAX_SIMULATION_MS / 1000 / SIMULATION_STEP);
  const positions: number[] = [0];
  let value = 0;
  let velocity = 0;

  for (let step = 1; step <= steps; step += 1) {
    const acceleration = (spring.stiffness * (1 - value) - spring.damping * velocity) / spring.mass;
    velocity += acceleration * SIMULATION_STEP;
    value += velocity * SIMULATION_STEP;
    positions.push(value);

    if (Math.abs(1 - value) <= SETTLE_DISTANCE && Math.abs(velocity) <= SETTLE_SPEED) {
      // 吸附到 1：否则曲线尾巴停在 0.995 上，元素永远差那 0.5% 没到位
      positions[positions.length - 1] = 1;
      const curve = { durationMs: step * SIMULATION_STEP * 1000, positions };
      curveCache.set(key, curve);
      return curve;
    }
  }

  positions[positions.length - 1] = 1;
  const curve = { durationMs: MAX_SIMULATION_MS, positions };
  curveCache.set(key, curve);
  return curve;
}

/** 该弹簧从静止到落定所需的毫秒数。 */
export function springDurationMs(spring: SpringConfig): number {
  return Math.round(simulateSpring(spring).durationMs);
}

/**
 * 把弹簧积分成 CSS `linear()` 缓动字面量。
 *
 * 为什么值得这么做：CSS 的 `cubic-bezier()` 表达不了"过冲"与"按物理收敛"，
 * 而 `linear()` 允许逐点给定进度曲线，于是弹簧可以**纯 CSS 驱动**，
 * 不必给每个组件挂一个 rAF 循环去逐帧改样式（本项目刻意不引 rAF 弹簧引擎，
 * 唯一的例外是灵动岛，它有自己那套从 WinIsland 移植的物理）。
 *
 * ⚠️ 过冲的弹簧会产生 **大于 1 的进度值**：只能用在 `transform` / `clip-path` 这类
 * 越界无害的属性上，**不要用在 `opacity`**（会被裁剪在 [0,1]，观感变成"到顶就停"）。
 */
export function springLinearEasing(spring: SpringConfig): string {
  const { positions } = simulateSpring(spring);
  const lastStep = positions.length - 1;

  const points: string[] = ['0'];
  for (let sample = 1; sample <= LINEAR_SAMPLES; sample += 1) {
    const index = Math.min(lastStep, Math.round((sample * lastStep) / LINEAR_SAMPLES));
    const value = (positions[index] ?? 1).toFixed(4).replace(/\.?0+$/, '');
    const percent = ((sample / LINEAR_SAMPLES) * 100).toFixed(2).replace(/\.?0+$/, '');
    points.push(`${value} ${percent}%`);
  }
  return `linear(${points.join(', ')})`;
}

/* -------------------------------------------------------- 时长 / 比例 / 查询 */

/** 时长（毫秒）。`instant` 用于悬停这类高频反馈，`page` 用于路由切换。 */
export const MOTION_DURATION = {
  instant: 90,
  fast: 140,
  base: 200,
  slow: 320,
  page: 180,
} as const;

/** 按压时的缩放比例。beUI 用 0.93；管理端控件更密集，收到 0.97 免得整片表格跟着抖。 */
export const PRESS_SCALE = 0.97;

/** 降低动态效果的系统偏好。两端都必须响应（原先一处都没处理）。 */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * 是否有真正的悬停能力（鼠标 / 触控板）。
 * 触摸设备会在点按时触发"幽灵 hover"并**粘住**直到点别处 —— 教室里的希沃触摸屏正是这种，
 * 所有 hover-only 效果（抬升、磁吸、光标跟随）都必须先过这一关。
 */
export const HOVER_CAPABLE_QUERY = '(hover: hover) and (pointer: fine)';

/* ---------------------------------------------------------------- CSS 变量 */

export interface MotionCssVarOptions {
  /**
   * 运行环境是否支持 CSS `linear()`（Chrome 113+）。
   * 为 `false` 时弹簧变量回落到 `EASE_OUT` 的 cubic-bezier —— 手感略钝，但不会失效。
   * 调用方用 `CSS.supports('transition-timing-function', 'linear(0, 1)')` 探测后传入。
   */
  linear?: boolean;
}

/**
 * 令牌 → CSS 自定义属性表。两端在 `app.mount()` **之前**写入 `:root`，
 * 于是 CSS 里可以放心写 `var(--ch-spring-panel)`，首帧之前就已就位（无 FOUC，也不需要兜底值）。
 */
export function motionCssVars(options: MotionCssVarOptions = {}): Record<string, string> {
  const { linear = true } = options;
  const spring = (config: SpringConfig): string =>
    linear ? springLinearEasing(config) : cubicBezierCss(EASE_OUT);

  return {
    '--ch-ease-out': cubicBezierCss(EASE_OUT),
    '--ch-ease-in-out': cubicBezierCss(EASE_IN_OUT),
    '--ch-ease-drawer': cubicBezierCss(EASE_DRAWER),

    '--ch-spring-press': spring(SPRING_PRESS),
    '--ch-spring-swap': spring(SPRING_SWAP),
    '--ch-spring-panel': spring(SPRING_PANEL),
    '--ch-spring-layout': spring(SPRING_LAYOUT),
    '--ch-spring-glide': spring(SPRING_GLIDE),

    /*
     * 弹簧的**自然落定时间**，与上面那条曲线成对使用。
     *
     * ⚠️ 这两个值必须配成一对：CSS 的 `linear()` 是"把 [0,1] 的进度重映射"，
     * 若 `transition-duration` 短于弹簧的自然落定时间，整条曲线会被等比例压缩 ——
     * 形状还在，但已经不是这组 stiffness/damping 对应的手感了（等于偷偷换了一组参数）。
     */
    '--ch-spring-press-dur': `${springDurationMs(SPRING_PRESS)}ms`,
    '--ch-spring-swap-dur': `${springDurationMs(SPRING_SWAP)}ms`,
    '--ch-spring-panel-dur': `${springDurationMs(SPRING_PANEL)}ms`,
    '--ch-spring-layout-dur': `${springDurationMs(SPRING_LAYOUT)}ms`,
    '--ch-spring-glide-dur': `${springDurationMs(SPRING_GLIDE)}ms`,

    '--ch-dur-instant': `${MOTION_DURATION.instant}ms`,
    '--ch-dur-fast': `${MOTION_DURATION.fast}ms`,
    '--ch-dur-base': `${MOTION_DURATION.base}ms`,
    '--ch-dur-slow': `${MOTION_DURATION.slow}ms`,
    '--ch-dur-page': `${MOTION_DURATION.page}ms`,

    '--ch-press-scale': String(PRESS_SCALE),
  };
}
