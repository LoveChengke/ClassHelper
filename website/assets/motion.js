/**
 * 动效层 —— 每一条曲线、每一个弹簧参数都取自 beUI（beui.dev）的源码：
 *
 *   lib/ease.ts                     共享 token（EASE_OUT / SPRING_PRESS / …）
 *   components/motion/dynamic-island 壳 spring 用 Apple 的 duration+bounce 形式
 *   components/motion/text-animation TextReveal：逐字上浮 + 去模糊
 *   components/motion/number         NumberTicker：数字竖排滚轮
 *   components/motion/shared-layout-bg 悬停胶囊在条目之间滑移
 *   components/motion/range-slider  位置用 SPRING_GLIDE，拖拽把手 scaleY 用 SPRING_BOUNCY
 *   components/motion/scroll-animation 阅读进度条，PROGRESS_SPRING 缓跟
 *   components/motion/button         whileTap 0.93 / whileHover 1.02
 *
 * 这里只有引擎，没有页面逻辑；页面逻辑在 main.js 里。
 */

(() => {
  'use strict';

  /* ═══════════════════════════════ 曲线 ═══════════════════════════════════ */

  /** 进场与退场：立刻响应，然后安静地落位 */
  const EASE_OUT = 'cubic-bezier(0.16, 1, 0.3, 1)';
  /** 已经在屏幕上的东西开始移动 */
  const EASE_IN_OUT = 'cubic-bezier(0.77, 0, 0.175, 1)';
  /** 抽屉 */
  const EASE_DRAWER = 'cubic-bezier(0.32, 0.72, 0, 1)';

  /* ═══════════════════════════════ 弹簧 ═══════════════════════════════════ */

  /** 按钮等可按压表面：快、有分量 */
  const SPRING_PRESS = { stiffness: 500, damping: 30, mass: 0.6 };
  /** 控件内部文字 / 图标交换位置 */
  const SPRING_SWAP = { stiffness: 460, damping: 30, mass: 0.55 };
  /** 由指针唤出的浮层 */
  const SPRING_PANEL = { stiffness: 420, damping: 40, mass: 0.5 };
  /** 共享布局滑移：胶囊、指示器、面板换位置 */
  const SPRING_LAYOUT = { stiffness: 360, damping: 32, mass: 0.6 };
  /** 装饰性的鼠标跟随（磁吸、倾斜、Dock） */
  const SPRING_MOUSE = { stiffness: 200, damping: 15, mass: 0.3 };
  /** 拖拽把手与填充：临界阻尼，跟手且不会在两端回弹 */
  const SPRING_GLIDE = { stiffness: 700, damping: 50, mass: 0.5 };
  /** 范围滑块把手的抓取反馈（只做 scaleY） */
  const SPRING_BOUNCY = { stiffness: 500, damping: 14, mass: 0.7 };
  /** 阅读进度条：故意比 UI 弹簧松，让它跟着滚动慢慢追上来 */
  const SPRING_PROGRESS = { stiffness: 120, damping: 30, mass: 0.6 };
  /** 标题逐字上浮（TextReveal 的 DEFAULT_SPRING） */
  const SPRING_TEXT = { stiffness: 140, damping: 26, mass: 1.2 };

  /* ═════════════════════════ 时长口径（beUI motion guide） ═════════════════════════
     按压反馈 100–160ms · tooltip 125–200 · 下拉 150–250 · 弹窗抽屉 200–500
     界面动效默认 < 300ms；更长的动效只属于讲解型演示。 */

  const DURATION = {
    press: 0.14,
    swap: 0.2,
    reveal: 0.22,
    islandShell: 0.8,
    islandContent: 0.8,
    islandExit: 0.08,
    number: 0.9,
    numberStagger: 0.04,
    textStagger: 0.03,
  };

  /* ═══════════════════════════ duration + bounce ═══════════════════════════
     motion 的 Apple 式弹簧写法：给一个「感知时长」和一个回弹量，反解出刚度。
     bounce = 0 无回弹（临界阻尼），bounce = 1 最弹；阻尼比 ζ = 1 - bounce。
     做法是拿单位阶跃响应去二分刚度，让它在 duration 秒内落到静止 —— 与
     motion 的 springFromDuration 同一套语义（因此感知时长与位移距离无关）。 */

  const REST_DELTA = 0.01;
  const REST_SPEED = 0.01;
  const SOLVE_STEP = 1 / 480;
  /** 运行时积分用的固定子步，与求解器同口径 */
  const INTERNAL_STEP_MS = 1000 / 480;
  /** 单帧最多补多少个子步，防止切回标签页时一次算几千步 */
  const MAX_SUBSTEPS = 96;

  function settleTime(stiffness, damping, mass) {
    let x = 0;
    let velocity = 0;
    for (let t = 0; t < 6; t += SOLVE_STEP) {
      const acceleration = (-stiffness * (x - 1) - damping * velocity) / mass;
      velocity += acceleration * SOLVE_STEP;
      x += velocity * SOLVE_STEP;
      if (Math.abs(x - 1) < REST_DELTA && Math.abs(velocity) < REST_SPEED) return t;
    }
    return 6;
  }

  const durationCache = new Map();

  function springFromDuration(duration, bounce, mass = 1) {
    const key = `${duration}|${bounce}|${mass}`;
    const cached = durationCache.get(key);
    if (cached) return cached;

    const zeta = Math.max(0.05, Math.min(1, 1 - bounce));
    // 刚度越大落位越快，settleTime 对它单调递减 —— 二分找出刚好在 duration 落位的那个
    let low = 1;
    let high = 4000;
    for (let i = 0; i < 40; i += 1) {
      const stiffness = (low + high) / 2;
      const damping = 2 * zeta * Math.sqrt(stiffness * mass);
      if (settleTime(stiffness, damping, mass) > duration) low = stiffness;
      else high = stiffness;
    }
    const stiffness = (low + high) / 2;
    const result = { stiffness, damping: 2 * zeta * Math.sqrt(stiffness * mass), mass };
    durationCache.set(key, result);
    return result;
  }

  /** 把 {stiffness,damping,mass} 或 {duration,bounce} 统一成系数 */
  function resolveConfig(config) {
    if (config.duration !== undefined) {
      return springFromDuration(config.duration, config.bounce ?? 0, config.mass ?? 1);
    }
    return { stiffness: config.stiffness, damping: config.damping, mass: config.mass ?? 1 };
  }

  /* ═══════════════════════════ 共享帧循环 ═══════════════════════════
     全站一个 rAF：所有弹簧都挂在这上面，谁在动就推进谁，都停了就整条循环歇着。
     可见性每帧现读，不缓存 —— 缓存过的标记一旦翻不回来，动画就永久停住。 */

  const running = new Set();
  let frameId = 0;
  let lastTime = 0;

  const reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const reduceMotion = () => reduceQuery.matches;

  function frame(time) {
    const delta = lastTime ? Math.min(64, time - lastTime) : 16;
    lastTime = time;

    for (const spring of [...running]) {
      if (!spring.step(delta)) running.delete(spring);
    }

    if (running.size > 0) {
      frameId = requestAnimationFrame(frame);
    } else {
      frameId = 0;
      lastTime = 0;
    }
  }

  function wake() {
    if (!frameId) frameId = requestAnimationFrame(frame);
  }

  /* ═══════════════════════════════ 弹簧 ═══════════════════════════════ */

  class Spring {
    /**
     * @param {number} initial 初值
     * @param {object} config  {stiffness,damping,mass} 或 {duration,bounce}
     * @param {(value:number)=>void} onUpdate 每帧回调
     * @param {{restRatio?:number, restFloor?:number}} [rest] 静止阈值
     */
    constructor(initial, config, onUpdate, rest = {}) {
      const resolved = resolveConfig(config);
      this.stiffness = resolved.stiffness;
      this.damping = resolved.damping;
      this.mass = resolved.mass;
      // duration+bounce 那套是按「本次位移的 1%」判定静止的，这里跟着同口径缩放 ——
      // 用绝对阈值的话，同一组参数走 20px 和走 200px 的观感时长会不一样。
      this.restRatio = rest.restRatio ?? REST_DELTA;
      this.restFloor = rest.restFloor ?? 1e-4;
      this.restDelta = this.restFloor;
      this.restSpeed = this.restFloor;
      this.value = initial;
      this.target = initial;
      this.velocity = 0;
      this.onUpdate = onUpdate;
    }

    get settled() {
      return this.value === this.target && this.velocity === 0;
    }

    /** 换目标。保留当前速度 —— 真实弹簧就是这样，中途改向不会顿一下。 */
    set(target, options = {}) {
      if (options.velocity !== undefined) this.velocity = options.velocity;
      if (target === this.target && this.settled) return;
      this.target = target;
      if (reduceMotion() || options.instant) {
        this.jump(target);
        return;
      }
      const travel = Math.abs(target - this.value);
      this.restDelta = Math.max(this.restFloor, travel * this.restRatio);
      this.restSpeed = this.restDelta;
      running.add(this);
      wake();
    }

    /** 直接落位，不做动画 */
    jump(target) {
      this.target = target;
      this.value = target;
      this.velocity = 0;
      running.delete(this);
      this.onUpdate?.(this.value, this);
    }

    /** 把当前值刷一次到 DOM。构造之后、或 set() 因为目标没变而早退时，靠它把首帧对上。 */
    paint() {
      this.onUpdate?.(this.value, this);
    }

    step(deltaMs) {
      // 定步长积分：显式欧拉在 60/120Hz 这种大步长下会明显耗散，同一组参数的
      // 观感时长会随屏幕刷新率变（0.8s 的壳在 120Hz 下会 0.48s 就停）。
      // 这里把它拆成 1/480s 的固定子步，几时落位只由参数决定，与刷新率无关。
      const sub = INTERNAL_STEP_MS;
      let remaining = Math.min(deltaMs, sub * MAX_SUBSTEPS);
      let moving = false;

      while (remaining > 0) {
        const dt = Math.min(sub, remaining) / 1000;
        remaining -= sub;
        moving = this.#integrate(dt) || moving;
      }
      return moving;
    }

    #integrate(dt) {
      const distance = this.target - this.value;
      if (distance === 0 && Math.abs(this.velocity) < this.restSpeed) {
        this.value = this.target;
        this.velocity = 0;
        this.onUpdate?.(this.value, this);
        return false;
      }

      // 胡克定律 + 阻尼：a = (k·(target − value) − c·v) / m
      const acceleration = (this.stiffness * distance - this.damping * this.velocity) / this.mass;
      this.velocity += acceleration * dt;
      this.value += this.velocity * dt;

      if (Math.abs(this.target - this.value) < this.restDelta && Math.abs(this.velocity) < this.restSpeed) {
        this.value = this.target;
        this.velocity = 0;
        this.onUpdate?.(this.value, this);
        return false;
      }
      if (!Number.isFinite(this.value) || !Number.isFinite(this.velocity)) {
        this.value = this.target;
        this.velocity = 0;
        this.onUpdate?.(this.value, this);
        return false;
      }

      this.onUpdate?.(this.value, this);
      return true;
    }
  }

  /* ═══════════════════════════ 通用小工具 ═══════════════════════════ */

  const round2 = (value) => Math.round(value * 100) / 100;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  /** 指针能悬停吗 —— 触摸设备上不要挂 hover 态 */
  const hoverCapable = () => window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  function setTransition(el, properties, duration, ease = EASE_OUT, delay = 0) {
    el.style.transition = properties
      .map((property) => `${property} ${duration}s ${ease} ${delay ? `${delay}s` : '0s'}`)
      .join(', ');
  }

  /** 动画重定向：先落 initial，下一帧再说 —— 保证浏览器真的重绘一次 */
  function nextFrame(callback) {
    requestAnimationFrame(() => requestAnimationFrame(callback));
  }

  window.CHMotion = {
    EASE_OUT,
    EASE_IN_OUT,
    EASE_DRAWER,
    SPRING_PRESS,
    SPRING_SWAP,
    SPRING_PANEL,
    SPRING_LAYOUT,
    SPRING_MOUSE,
    SPRING_GLIDE,
    SPRING_BOUNCY,
    SPRING_PROGRESS,
    SPRING_TEXT,
    DURATION,
    Spring,
    springFromDuration,
    reduceMotion,
    hoverCapable,
    round2,
    clamp,
    setTransition,
    nextFrame,
  };
})();
