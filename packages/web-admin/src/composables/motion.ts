/**
 * 动效组合式函数 —— beUI 那套动效语言在本端的落地层。
 *
 * 令牌的**数值**在 `@classhelper/shared` 的 `motion.ts`（单一来源，后端也引用得到）；
 * 这里只放需要 DOM / Vue 的部分。桌面客户端有一份对应的副本
 * （`packages/desktop-client/src/renderer/composables/motion.ts`）——
 * 与 `ScoreBarChart.vue` 一样，两端各一份是仓库既有做法，为一个百来行的文件
 * 新建 workspace 包不划算。
 */
import { computed, onUnmounted, ref, watch, type CSSProperties, type Ref } from 'vue';
import {
  EASE_OUT,
  HOVER_CAPABLE_QUERY,
  MOTION_DURATION,
  REDUCED_MOTION_QUERY,
  cubicBezierCss,
  motionCssVars,
} from '@classhelper/shared';

/**
 * 把动效令牌写进 `:root` 的自定义属性。
 *
 * **必须在 `app.mount()` 之前调用**：那样 CSS 里可以放心写 `var(--ch-spring-panel)`，
 * 首帧之前就已就位，既没有 FOUC，也不需要到处写兜底值。
 *
 * 弹簧用 CSS `linear()` 表达（见 shared 里 `springLinearEasing` 的说明）；
 * Chrome 113 以下不支持，此时回落到 `EASE_OUT` 的 cubic-bezier —— 手感略钝但不会失效。
 */
export function applyMotionTokens(): void {
  if (typeof document === 'undefined') return;
  const linear =
    typeof CSS !== 'undefined' &&
    typeof CSS.supports === 'function' &&
    CSS.supports('transition-timing-function', 'linear(0, 1)');

  for (const [name, value] of Object.entries(motionCssVars({ linear }))) {
    document.documentElement.style.setProperty(name, value);
  }
}

/**
 * 监听 `prefers-reduced-motion`。
 *
 * 三元表达式而非直接返回 `matchMedia(...)` 的结果：这条偏好可能在运行中被改动
 * （系统设置里一开关就生效），必须跟着变；JS 驱动的动画（数字滚动、位置测量）
 * 拿不到 CSS 那层自动降级，得自己看这个值。
 */
export function useReducedMotion(): Ref<boolean> {
  const matches = ref(false);
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return matches;

  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  matches.value = query.matches;

  const update = (): void => {
    matches.value = query.matches;
  };
  // Safari 14 以下只有已废弃的 addListener
  if (typeof query.addEventListener === 'function') {
    query.addEventListener('change', update);
    onUnmounted(() => query.removeEventListener('change', update));
  } else if (typeof query.addListener === 'function') {
    query.addListener(update);
    onUnmounted(() => query.removeListener(update));
  }
  return matches;
}

/**
 * 是否有真正的悬停能力（鼠标 / 触控板）。
 *
 * 触摸设备在点按时会触发**幽灵 hover** 并一直粘着，直到点别处才消失 ——
 * 教室里的希沃触摸屏正属于这种，所有 hover-only 效果（抬升、磁吸、光标跟随）
 * 都必须先过这一关，否则触摸屏上会出现"点一下，卡片就永远浮着"。
 */
export function useHoverCapable(): Ref<boolean> {
  const capable = ref(false);
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return capable;

  const query = window.matchMedia(HOVER_CAPABLE_QUERY);
  capable.value = query.matches;

  const update = (): void => {
    capable.value = query.matches;
  };
  if (typeof query.addEventListener === 'function') {
    query.addEventListener('change', update);
    onUnmounted(() => query.removeEventListener('change', update));
  } else if (typeof query.addListener === 'function') {
    query.addListener(update);
    onUnmounted(() => query.removeListener(update));
  }
  return capable;
}

/** 缓动函数：给定进度 t∈[0,1]，返回缓动后的进度。即 EASE_OUT 那条贝塞尔的求值。 */
function easeOutProgress(t: number): number {
  const [x1, y1, x2, y2] = EASE_OUT;
  // 牛顿迭代反解 x(u) = t，再用同一个 u 求 y —— 三次贝塞尔求值的标准做法
  let u = t;
  for (let i = 0; i < 6; i += 1) {
    const x = 3 * (1 - u) ** 2 * u * x1 + 3 * (1 - u) * u ** 2 * x2 + u ** 3;
    const dx = 3 * (1 - u) ** 2 * x1 + 6 * (1 - u) * u * (x2 - x1) + 3 * u ** 2 * (1 - x2);
    if (Math.abs(dx) < 1e-6) break;
    u = Math.min(1, Math.max(0, u - (x - t) / dx));
  }
  return 3 * (1 - u) ** 2 * u * y1 + 3 * (1 - u) * u ** 2 * y2 + u ** 3;
}

export interface CountUpOptions {
  /** 时长（毫秒）。默认 `MOTION_DURATION.slow`。 */
  duration?: number;
}

/**
 * 数字滚动：目标值变化时从当前显示值滚过去，而不是直接跳。
 *
 * 用于仪表盘的统计卡片。`reduced-motion` 下**直接落位**（不启动 rAF）。
 *
 * 刻意**不**给"首次变化"开豁免：统计页的数据是异步加载的，挂载那一刻目标值还是 0，
 * 真正想看到滚动的恰恰是"0 → 实际值"这第一跳；而如果数据在挂载时就已就位
 * （缓存命中），`displayed` 初始化即等于目标值、根本不会触发 watch，本来就不会滚。
 */
export function useCountUp(source: () => number, options: CountUpOptions = {}): Ref<number> {
  const reduce = useReducedMotion();
  const duration = options.duration ?? MOTION_DURATION.slow;
  const displayed = ref(source());
  let frame = 0;

  function stop(): void {
    if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
  }

  watch(source, (target) => {
    stop();
    if (reduce.value || duration <= 0) {
      displayed.value = target;
      return;
    }
    const from = displayed.value;
    const delta = target - from;
    if (delta === 0) return;

    const start = performance.now();
    const tick = (now: number): void => {
      const progress = Math.min(1, (now - start) / duration);
      displayed.value = from + delta * easeOutProgress(progress);
      if (progress < 1) frame = requestAnimationFrame(tick);
      else {
        displayed.value = target;
        frame = 0;
      }
    };
    frame = requestAnimationFrame(tick);
  });

  onUnmounted(stop);
  return displayed;
}

/**
 * 列表错峰入场：返回一个"给第 index 项算内联样式"的函数，
 * 配合 CSS 类 `.ch-reveal`（见 `styles/index.css`）使用。
 *
 * 延迟**封顶**（默认第 8 项之后不再累加）：一屏几十行时，最后一行不该等一秒才出现。
 */
export function useStaggerIn(step = 35, maxIndex = 8): (index: number) => CSSProperties {
  const reduce = useReducedMotion();
  return (index: number): CSSProperties =>
    reduce.value ? {} : ({ '--ch-reveal-delay': `${Math.min(index, maxIndex) * step}ms` } as CSSProperties);
}

/** 把 reduced-motion 折成一个布尔，供模板里判断"要不要挂动画类"。 */
export function useMotionEnabled(): Ref<boolean> {
  const reduce = useReducedMotion();
  return computed(() => !reduce.value);
}

/**
 * 整页换肤的揭示动画（beUI 的 `theme-toggle`）：新旧两帧各存一张快照，
 * 让新帧从一个**从点击位置扩散的圆**里长出来 —— 这是"整个界面换了张皮"这件事
 * 唯一能让人**看见**的表达方式，比整页硬切一下好懂得多。
 *
 * 返回的函数直接挂 `@click`：`@click="reveal($event, () => ui.setTheme(next))"`。
 *
 * 三条守卫缺一不可：
 *   ① 不认识 View Transition API 的浏览器直接走同步切换；
 *   ② 系统开了「减少动态效果」时不放全屏动画；
 *   ③ **文档不可见时不放**（最小化、被遮挡、无头浏览器）—— 那种情况下浏览器不产生帧，
 *      而 View Transition 的更新回调要等到下一个渲染时机才执行，**主题会一直不切**。
 */
export function useThemeReveal(): (event: MouseEvent, apply: () => void) => void {
  const reduce = useReducedMotion();

  return (event, apply) => {
    const doc = document as Document & {
      startViewTransition?: (callback: () => void) => { ready: Promise<void> };
    };
    if (
      typeof doc.startViewTransition !== 'function' ||
      reduce.value ||
      document.visibilityState !== 'visible'
    ) {
      apply();
      return;
    }

    const { clientX: x, clientY: y } = event;
    void doc
      .startViewTransition(apply)
      .ready.then(() => {
        // 半径取到最远的那个角，圆才能把整屏吃完
        const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
        document.documentElement.animate(
          { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
          {
            // 比常规过渡长一点 —— 它是一次**整屏**的变化，太快会读成"闪了一下"而不是"换了一层皮"
            duration: MOTION_DURATION.slow * 1.5,
            // 缓动取自共享令牌，别在这里手写曲线字面量（那是漂移的起点）
            easing: cubicBezierCss(EASE_OUT),
            pseudoElement: '::view-transition-new(root)',
          },
        );
      })
      .catch(() => undefined);
  };
}
