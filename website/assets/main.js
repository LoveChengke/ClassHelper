/**
 * ClassHelper · 官网交互
 *
 * 动效全部走 assets/motion.js 里那套 beUI token（曲线、弹簧、时长口径）。
 * 这里只做页面逻辑，逐块对着 beUI 的组件写：
 *
 *   标题逐字上浮        components/motion/text-animation      TextReveal
 *   灵动岛              components/blocks/dynamic-island     壳 + 内容两层弹簧
 *   胶囊文案交换        components/motion/action-swap        blur 变体
 *   铃铛晃动            motion guide「Semantic icon motion」  铰链摆动
 *   顶栏悬停胶囊        components/motion/shared-layout-bg    共享布局滑移
 *   阅读进度条          components/motion/scroll-animation    ScrollProgressBar
 *   按钮按压            components/motion/button             whileTap 0.93
 *   验收数字滚动        components/motion/number             NumberTicker
 *   上课时段滑块        components/motion/range-slider       GLIDE + BOUNCY
 *   复制按钮文案        components/motion/action-swap        roll 变体
 */

(() => {
  'use strict';

  const M = window.CHMotion;
  const {
    EASE_OUT,
    SPRING_PRESS,
    SPRING_SWAP,
    SPRING_LAYOUT,
    SPRING_GLIDE,
    SPRING_BOUNCY,
    SPRING_PROGRESS,
    SPRING_TEXT,
    DURATION,
    Spring,
    reduceMotion,
    hoverCapable,
    round2,
    clamp,
  } = M;
  /** duration+bounce 形式的壳弹簧（与 beUI 的 SHELL_SPRING / CONTENT_SPRING 同值） */
  const ISLAND_SHELL_SPRING = { duration: DURATION.islandShell, bounce: 0.2 };
  const ISLAND_CONTENT_SPRING = { duration: DURATION.islandContent, bounce: 0.35 };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  /** 延迟执行，并在页面不可见时不再堆积 */
  const after = (seconds, callback) => window.setTimeout(callback, Math.max(0, seconds * 1000));

  /* ══════════════════════════════════════════════════════════════════════
     一、标题逐字上浮 —— beUI TextReveal
     中文没有空格，所以按「字」切；每个字是一个 inline-block，空白保留。
     ══════════════════════════════════════════════════════════════════════ */

  function setupHeadlineReveal() {
    const headline = $('[data-reveal]');
    if (!headline) return;

    const lines = $$('.reveal-line', headline);
    if (!lines.length) return;

    const units = [];
    lines.forEach((line) => {
      // 整行渐变填色的那一行**不拆字**，整行做一个单元（见 styles.css 的 .reveal-grad）：
      // 拆成 per-char 的 inline-block 后，每个字各自建一层合成，祖先的
      // `background-clip: text` 就穿不过去了，渐变会整行失效。
      if (line.classList.contains('reveal-grad')) return;

      const text = line.textContent.trim();
      line.textContent = '';
      for (const char of Array.from(text)) {
        const span = document.createElement('span');
        span.className = 'reveal-unit';
        span.textContent = char;
        line.append(span);
        units.push({ element: span });
      }
    });

    const reduce = reduceMotion();

    units.forEach((unit, index) => {
      // reduce 时只留透明度：位移、缩放、模糊全部去掉
      if (reduce) {
        unit.element.style.opacity = '0';
        unit.element.style.transition = `opacity 0.25s ${EASE_OUT} ${round2(index * DURATION.textStagger * 0.3)}s`;
        return;
      }
      unit.element.style.opacity = '0';
      unit.element.style.filter = 'blur(12px)';
      unit.element.style.transform = 'translateY(40%)';
      unit.element.style.transition =
        `opacity 0.7s ${EASE_OUT} ${round2(index * DURATION.textStagger)}s,` +
        `filter 0.9s ${EASE_OUT} ${round2(index * DURATION.textStagger)}s`;
      unit.element.style.willChange = 'transform, opacity, filter';
    });

    // 位移用弹簧（TextReveal 的 y 就是 spring），透明度与模糊用 EASE_OUT 过渡
    document.documentElement.classList.remove('reveal-pending');

    let started = false;
    function startReveal() {
      if (started) return;
      started = true;
      units.forEach((unit, index) => {
        unit.element.style.opacity = '1';
        if (reduce) return;
        unit.element.style.filter = 'blur(0px)';

        const spring = new Spring(
          40,
          SPRING_TEXT,
          (value) => {
            unit.element.style.transform = `translateY(${round2(value)}%)`;
          },
          { restFloor: 0.01 },
        );
        after(index * DURATION.textStagger, () => spring.set(0));
      });
    }

    // 下一帧起跑；rAF 被限流时（后台标签页、被遮挡的窗口）用定时器兜底，
    // 否则单位会一直停在透明态，标题就永远是空的。
    M.nextFrame(startReveal);
    after(0.25, startReveal);
  }

  /* ══════════════════════════════════════════════════════════════════════
     二、灵动岛 —— beUI DynamicIsland
     ══════════════════════════════════════════════════════════════════════ */

  /** 与 DEFAULT_ISLAND_APPEARANCE 一致 */
  const ISLAND = { width: 268, height: 44, fontSize: 13 };
  /** 与 ISLAND_SIZE_DELTA 一致：展开卡的尺寸 = 胶囊 + 增量 */
  const SIZE_DELTA = {
    notification: { width: 156, height: 186 },
    urgent: { width: 172, height: 202 },
    call: { width: 188, height: 218 },
  };
  /**
   * 圆角是常数，不参与动画 —— beUI 的做法，浏览器会把它钳到 min(圆角, w/2, h/2)，
   * 于是「胶囊 → 圆角矩形」的形变是尺寸变化的副产品，不存在圆角插值出错的可能。
   * 值取产品的展开态半径 24，这样胶囊态会被钳成 h/2（满圆角）。
   */
  const ISLAND_RADIUS = 24;

  /** 超椭圆指数：2 = 标准圆弧圆角，越大曲率越连续（与产品的 squircle.ts 同值） */
  const SUPERELLIPSE_EXPONENT = 4.2;
  const CORNER_SEGMENTS = 14;

  function squirclePath(width, height, radius) {
    const w = Math.max(1, round2(width));
    const h = Math.max(1, round2(height));
    const r = Math.max(0, Math.min(radius, w / 2, h / 2));
    if (r <= 0.5) return `M0,0 H${w} V${h} H0 Z`;

    const p = 2 / SUPERELLIPSE_EXPONENT;
    const centers = [
      { cx: w - r, cy: r },
      { cx: w - r, cy: h - r },
      { cx: r, cy: h - r },
      { cx: r, cy: r },
    ];
    const startAngles = [-Math.PI / 2, 0, Math.PI / 2, Math.PI];

    const parts = [];
    for (let corner = 0; corner < 4; corner += 1) {
      const center = centers[corner];
      for (let index = 0; index <= CORNER_SEGMENTS; index += 1) {
        const angle = startAngles[corner] + (index / CORNER_SEGMENTS) * (Math.PI / 2);
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const px = center.cx + r * Math.sign(cos) * Math.pow(Math.abs(cos), p);
        const py = center.cy + r * Math.sign(sin) * Math.pow(Math.abs(sin), p);
        parts.push(`${index === 0 && corner === 0 ? 'M' : 'L'}${round2(px)},${round2(py)}`);
      }
    }
    parts.push('Z');
    return parts.join(' ');
  }

  const ICONS = {
    bell: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.4a5.6 5.6 0 0 0-5.6 5.6v3.3l-1.5 3a1 1 0 0 0 .9 1.5h12.4a1 1 0 0 0 .9-1.5l-1.5-3V8A5.6 5.6 0 0 0 12 2.4Zm0 19.2a2.6 2.6 0 0 0 2.5-2h-5a2.6 2.6 0 0 0 2.5 2Z"/></svg>',
    book: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 3.6h6.2c1 0 1.8.8 1.8 1.8v14c0-.9-.7-1.6-1.6-1.6H4Zm16 0h-6.2c-1 0-1.8.8-1.8 1.8v14c0-.9.7-1.6 1.6-1.6H20Z"/></svg>',
    megaphone:
      '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 10.2v3.6a1.4 1.4 0 0 0 1.4 1.4h1.4l4.6 4.2a1 1 0 0 0 1.7-.7v-13a1 1 0 0 0-1.7-.7L5.8 8.8H4.4A1.4 1.4 0 0 0 3 10.2Zm14.2-2.5a1 1 0 0 1 1.4.1 7.6 7.6 0 0 1 0 9.4 1 1 0 1 1-1.5-1.3 5.6 5.6 0 0 0 0-6.8 1 1 0 0 1 .1-1.4Z"/></svg>',
    chevron:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 15 6-6 6 6"/></svg>',
  };

  /** 一条消息的全部内容。文案取自产品自己的演示数据，不是现编的占位符。 */
  const MESSAGES = {
    notification: {
      icon: 'bell',
      badge: '通知',
      meta: '张老师 · 09-12 18:38',
      title: '秋季运动会报名',
      body: '各班请于本周五前把参赛名单交到体育组，每人限报两项，报名后不再更改。',
      more: '还有 1 条通知',
      buttons: ['打开应用', '标为已读', '知道了'],
      primary: '知道了',
    },
    urgent: {
      icon: 'bell',
      badge: '紧急',
      meta: '需立即查看 · 张老师',
      title: '上课期间的紧急通知',
      body: '明天下午的数学课改在实验楼 B205 上课，请同学们提前 10 分钟到达，并携带上次发的练习册。',
      more: '还有 1 条通知',
      buttons: ['打开应用', '标为已读', '知道了'],
      primary: '知道了',
      /** 紧急时铃铛从铰链上摆一下 —— motion guide 的「语义化图标动效」 */
      swing: true,
    },
    call: {
      icon: 'megaphone',
      badge: '叫人',
      meta: '张老师 · 09-12 18:40',
      title: '请 王小明 同学找 张老师',
      body: '带上昨天的数学作业到办公室。',
      more: '',
      buttons: ['收到'],
      primary: '收到',
    },
  };

  const PILL_HINT = {
    notification: { title: '新消息', sub: '张老师 · 点击查看', icon: 'bell' },
    urgent: { title: '紧急通知', sub: '点击查看', icon: 'bell', swing: true },
    call: { title: '老师叫你', sub: '点击查看', icon: 'megaphone' },
    homework: { title: '新作业', sub: '数学 · 点击查看', icon: 'book' },
  };

  /** 首屏演示顺序：三条消息依次到达，最后完全隐藏一会儿 */
  const SCRIPT = [
    { kind: 'pill', hint: 'notification', hold: 1500 },
    { kind: 'card', message: 'notification', hold: 5200 },
    { kind: 'pill', hint: 'urgent', hold: 1400 },
    { kind: 'card', message: 'urgent', hold: 5600 },
    { kind: 'pill', hint: 'call', hold: 1400 },
    { kind: 'card', message: 'call', hold: 5000 },
    { kind: 'pill', hint: 'homework', hold: 1600 },
    { kind: 'hidden', hold: 2200 },
  ];

  function cardMarkup(message) {
    const buttons = message.buttons
      .map(
        (label) =>
          `<span class="card-btn${label === message.primary ? ' card-btn-primary' : ''}">${label}</span>`,
      )
      .join('');

    return `
      <div class="card-head">
        <span class="card-icon${message.swing ? ' card-icon-swing' : ''}">${ICONS[message.icon]}</span>
        <span class="card-badge">${message.badge}</span>
        <span class="card-meta">${message.meta}</span>
        <span class="card-collapse">${ICONS.chevron}</span>
      </div>
      <p class="card-title">${message.title}</p>
      <p class="card-body">${message.body}</p>
      <div class="card-foot">
        <span class="card-more">${message.more}</span>
        ${buttons}
      </div>`;
  }

  function setupIsland() {
    const stage = $('#stage');
    const island = $('#island');
    const svg = $('#island-shape');
    const path = $('#island-path');
    const tint = $('#island-tint');
    const layers = $('.island-layers');
    const pill = $('#island-pill');
    const pillIcon = $('#pill-icon');
    const pillTitle = $('#pill-title');
    const pillSub = $('#pill-sub');
    if (!stage || !island || !path || !layers) return;

    // ── 壳：真实 width / height，两条弹簧（不是 transform，避免缩放拉伸）
    const shell = {
      width: new Spring(ISLAND.width, ISLAND_SHELL_SPRING, paint),
      height: new Spring(ISLAND.height, ISLAND_SHELL_SPRING, paint),
    };

    function paint() {
      const w = shell.width.value;
      const h = shell.height.value;
      island.style.width = `${round2(w)}px`;
      island.style.height = `${round2(h)}px`;
      svg.setAttribute('width', round2(w));
      svg.setAttribute('height', round2(h));
      const d = squirclePath(w, h, ISLAND_RADIUS);
      path.setAttribute('d', d);
      if (tint) tint.setAttribute('d', d);
    }
    paint();

    // ── 内容槽：进出都带位移 + 缩放 + 模糊（beUI 的 Slot）
    let slot = null;
    let exitTimers = [];

    function mountSlot(build) {
      exitTimers.forEach(window.clearTimeout);
      exitTimers = [];

      const previous = slot;
      if (previous) {
        // 退场走得快、不带模糊，趁壳还没缩到裁掉它之前先走
        previous.element.style.transition = `opacity ${DURATION.islandExit}s ${EASE_OUT}, transform ${DURATION.islandExit}s ${EASE_OUT}, filter ${DURATION.islandExit}s ${EASE_OUT}`;
        previous.element.style.opacity = '0';
        previous.element.style.filter = 'blur(0px)';
        previous.element.style.transform = 'translateY(-6px) scale(0.9)';
        previous.springs.forEach((spring) => spring.jump(spring.value));
        exitTimers.push(after(DURATION.islandExit, () => previous.element.remove()));
      }

      const element = document.createElement('div');
      element.className = 'island-slot-content';
      element.innerHTML = build();
      layers.append(element);

      const reduce = reduceMotion();
      const from = reduce
        ? { opacity: 0, scale: 1, y: 0, blur: 0 }
        : { opacity: 0, scale: 0.9, y: -8, blur: 5 };
      const to = { opacity: 1, scale: 1, y: 0, blur: 0 };

      const style = { ...from };
      element.style.transition = 'none';
      element.style.transformOrigin = 'top center';
      element.style.opacity = String(style.opacity);
      element.style.filter = `blur(${style.blur}px)`;
      element.style.transform = `translateY(${style.y}px) scale(${style.scale})`;

      const apply = () => {
        element.style.opacity = String(style.opacity);
        element.style.filter = `blur(${round2(style.blur)}px)`;
        element.style.transform = `translateY(${round2(style.y)}px) scale(${round2(style.scale)})`;
      };

      // 一条弹簧同时驱动 transform / opacity / blur —— 不做分属性补间，内容跟着壳一起走
      const movement = new Spring(from.y, ISLAND_CONTENT_SPRING, (v) => {
        style.y = v;
        apply();
      });
      const scale = new Spring(from.scale, ISLAND_CONTENT_SPRING, (v) => {
        style.scale = v;
        apply();
      });
      const opacity = new Spring(from.opacity, ISLAND_CONTENT_SPRING, (v) => {
        style.opacity = v;
        apply();
      });
      const blur = new Spring(from.blur, ISLAND_CONTENT_SPRING, (v) => {
        style.blur = v;
        apply();
      });
      const springs = [movement, scale, opacity, blur];

      if (reduce) {
        // 只保留透明度：不位移、不缩放、不去模糊之外加动效
        element.style.transition = `opacity 0.15s ${EASE_OUT}`;
        element.style.filter = 'blur(0px)';
        element.style.transform = 'none';
        movement.jump(to.y);
        scale.jump(to.scale);
        blur.jump(to.blur);
        after(0.01, () => {
          element.style.opacity = '1';
        });
      } else {
        movement.set(to.y);
        scale.set(to.scale);
        opacity.set(to.opacity);
        blur.set(to.blur);
      }

      slot = { element, springs };
    }

    // ── 胶囊标题用 action-swap 的 blur 变体换文案
    let pillState = { title: null, sub: null };
    function setPillHint(hint) {
      pillIcon.innerHTML = ICONS[hint.icon];
      pillIcon.dataset.swing = hint.swing ? 'true' : 'false';
      if (pillState.title === hint.title) return;
      pillState = { title: hint.title, sub: hint.sub };

      const swap = (element, text) => {
        element.textContent = text;
        element.classList.remove('is-swapping');
        void element.offsetWidth;
        element.classList.add('is-swapping');
      };
      swap(pillTitle, hint.title);
      swap(pillSub, hint.sub);
    }

    // ── 壳与内容一起换到某个形态
    function setSize(kind) {
      const next =
        kind === 'pill' || kind === 'hidden'
          ? { width: ISLAND.width, height: ISLAND.height }
          : { width: ISLAND.width + SIZE_DELTA[kind].width, height: ISLAND.height + SIZE_DELTA[kind].height };
      shell.width.set(next.width);
      shell.height.set(next.height);
    }

    let step = 0;
    let elapsed = 0;
    let lastFrame = 0;
    let onScreen = true;

    function renderStep() {
      const item = SCRIPT[step % SCRIPT.length];

      if (item.kind === 'card') {
        const message = MESSAGES[item.message];
        island.dataset.kind = item.message;
        island.dataset.shape = 'card';
        setSize(item.message);
        mountSlot(() => cardMarkup(message));
        pill.setAttribute('aria-hidden', 'true');
      } else {
        const hint = item.kind === 'pill' ? PILL_HINT[item.hint] : null;
        if (hint) {
          island.dataset.kind = item.hint;
          setPillHint(hint);
        }
        island.dataset.shape = 'pill';
        setSize('pill');
        mountSlot(() => '');
        pill.setAttribute('aria-hidden', 'false');
      }

      island.style.opacity = item.kind === 'hidden' ? '0' : '1';
    }

    /**
     * 一个自续的 rAF 循环同时推进故事线与可见性判断。
     * 可见性每帧现读，不缓存 —— 缓存过的标记一旦没被翻回来，动画就永久停住。
     */
    function loop(time) {
      const delta = lastFrame ? Math.min(64, time - lastFrame) : 16;
      lastFrame = time;

      if (onScreen && !document.hidden) {
        elapsed += delta;
        const item = SCRIPT[step % SCRIPT.length];
        if (elapsed >= item.hold) {
          elapsed = 0;
          step += 1;
          renderStep();
        }
      }
      requestAnimationFrame(loop);
    }

    function fit() {
      const available = stage.clientWidth - 32;
      // 卡片最高的是叫人卡（456 宽），按它算缩放，保证任何屏幕宽度都装得下
      const scale = Math.max(0.5, Math.min(1.18, available / (ISLAND.width + SIZE_DELTA.call.width + 20)));
      island.style.transform = `scale(${scale})`;
      stage.style.setProperty(
        '--headroom',
        `${Math.round((ISLAND.height + SIZE_DELTA.call.height) * scale) + 30}px`,
      );
    }

    fit();
    window.addEventListener('resize', fit, { passive: true });

    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver(
        (entries) => {
          onScreen = entries[0].isIntersecting;
        },
        { threshold: 0.15 },
      );
      observer.observe(stage);
    }

    renderStep();
    requestAnimationFrame(loop);
  }

  /* ══════════════════════════════════════════════════════════════════════
     三、顶栏悬停胶囊 —— beUI SharedLayoutBg
     ══════════════════════════════════════════════════════════════════════ */

  function setupNavPill() {
    const nav = $('.topnav');
    const pill = $('.nav-pill');
    const links = $$('a', nav);
    if (!nav || !pill || !links.length) return;

    const edges = new Spring(0, SPRING_LAYOUT, (value) => {
      pill.style.left = `${round2(value)}px`;
    });
    const span = new Spring(0, SPRING_LAYOUT, (value) => {
      pill.style.width = `${round2(value)}px`;
    });

    let visible = false;

    function show() {
      if (visible) return;
      visible = true;
      pill.classList.add('is-visible');
    }

    function hide() {
      visible = false;
      pill.classList.remove('is-visible');
    }

    function moveTo(link) {
      const navBox = nav.getBoundingClientRect();
      const box = link.getBoundingClientRect();
      const left = box.left - navBox.left - 10;
      const next = box.width + 20;
      if (!visible) {
        edges.jump(left);
        span.jump(next);
        show();
        return;
      }
      edges.set(left);
      span.set(next);
      show();
    }

    links.forEach((link) => {
      link.addEventListener('pointerenter', () => {
        if (!hoverCapable()) return;
        moveTo(link);
      });
      link.addEventListener('focus', () => moveTo(link));
      link.addEventListener('blur', hide);
    });
    nav.addEventListener('pointerleave', hide);
  }

  /* ══════════════════════════════════════════════════════════════════════
     四、阅读进度条 —— beUI ScrollProgressBar
     ══════════════════════════════════════════════════════════════════════ */

  function setupScrollProgress() {
    const bar = $('.scroll-progress');
    if (!bar) return;

    const progress = new Spring(0, SPRING_PROGRESS, (value) => {
      bar.style.transform = `scaleX(${round2(clamp(value, 0, 1))})`;
    });

    function read() {
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      const value = scrollable > 0 ? window.scrollY / scrollable : 0;
      if (reduceMotion()) progress.jump(clamp(value, 0, 1));
      else progress.set(clamp(value, 0, 1));
    }

    read();
    window.addEventListener('scroll', read, { passive: true });
    window.addEventListener('resize', read, { passive: true });
  }

  /* ══════════════════════════════════════════════════════════════════════
     五、按钮按压 —— beUI Button 的 whileTap / whileHover
     ══════════════════════════════════════════════════════════════════════ */

  function setupPressable() {
    $$('[data-press]').forEach(bindPressable);
  }

  /** 给单个元素挂上按压反馈；动态插入的卡片要在插入之后再调一次 */
  function bindPressable(element) {
    if (element.dataset.pressBound === '1') return;
    element.dataset.pressBound = '1';

    const canHover = hoverCapable();
    const pressScale = Number(element.dataset.press) || 0.93;
    const spring = new Spring(
      1,
      SPRING_PRESS,
      (value) => {
        element.style.transform = `scale(${round2(value)})`;
      },
      { restFloor: 0.0005 },
    );
    element.style.transformOrigin = 'center';

    // whileTap 压过 whileHover：松开手指后回到「悬停中」的状态而不是 1
    let hovering = false;
    const resting = () => (hovering && canHover ? 1.02 : 1);

    element.addEventListener('pointerdown', () => {
      if (!reduceMotion()) spring.set(pressScale);
    });
    const release = () => {
      if (reduceMotion()) {
        spring.jump(1);
        return;
      }
      spring.set(resting());
    };
    element.addEventListener('pointerup', release);
    element.addEventListener('pointercancel', release);

    if (canHover) {
      element.addEventListener('pointerenter', () => {
        hovering = true;
        if (!reduceMotion()) spring.set(1.02);
      });
      element.addEventListener('pointerleave', () => {
        hovering = false;
        release();
      });
    }
  }

  /* ══════════════════════════════════════════════════════════════════════
     六、上课时段：时间轴 + 滑块
     滑块的物理取自 beUI RangeSlider：位置用 SPRING_GLIDE（临界阻尼、跟手不回弹），
     把手拖拽时 scaleY 1.35 用 SPRING_BOUNCY。
     ══════════════════════════════════════════════════════════════════════ */

  const DAY_START = 7 * 60;
  const DAY_END = 17 * 60 + 10;

  const PERIODS = [
    { start: 7 * 60 + 10, end: 7 * 60 + 50, name: '早读', inClass: true },
    { start: 7 * 60 + 50, end: 8 * 60, name: '课间', inClass: false },
    { start: 8 * 60, end: 8 * 60 + 45, name: '第一节', subject: '数学', inClass: true },
    { start: 8 * 60 + 45, end: 8 * 60 + 55, name: '课间', inClass: false },
    { start: 8 * 60 + 55, end: 9 * 60 + 40, name: '第二节', subject: '语文', inClass: true },
    { start: 9 * 60 + 40, end: 10 * 60 + 10, name: '大课间', inClass: false },
    { start: 10 * 60 + 10, end: 10 * 60 + 55, name: '第三节', subject: '英语', inClass: true },
    { start: 10 * 60 + 55, end: 11 * 60 + 5, name: '课间', inClass: false },
    { start: 11 * 60 + 5, end: 11 * 60 + 50, name: '第四节', subject: '物理', inClass: true },
    { start: 11 * 60 + 50, end: 14 * 60, name: '午休', inClass: false },
    { start: 14 * 60, end: 14 * 60 + 45, name: '第五节', subject: '化学', inClass: true },
    { start: 14 * 60 + 45, end: 14 * 60 + 55, name: '课间', inClass: false },
    { start: 14 * 60 + 55, end: 15 * 60 + 40, name: '第六节', subject: '生物', inClass: true },
    { start: 15 * 60 + 40, end: 16 * 60 + 10, name: '课间', inClass: false },
    { start: 16 * 60 + 10, end: 16 * 60 + 55, name: '第七节', subject: '自习', inClass: true },
    { start: 16 * 60 + 55, end: DAY_END, name: '放学', inClass: false },
  ];

  const pad = (value) => String(value).padStart(2, '0');
  const hhmm = (minutes) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
  const percent = (minutes) => ((minutes - DAY_START) / (DAY_END - DAY_START)) * 100;

  function setupPolicy() {
    const root = $('#policy-widget');
    const track = $('#day-track');
    const marker = $('#day-marker');
    const input = $('#day-input');
    const timeEl = $('#policy-time');
    const stateEl = $('#policy-state');
    if (!root || !track || !marker || !input) return;

    const blocks = PERIODS.map(
      (period) => `
        <div class="day-block${period.inClass ? ' is-class' : ''}" data-share="${round2((percent(period.end) - percent(period.start)) / 100)}"
             style="left:${round2(percent(period.start))}%;width:${round2(percent(period.end) - percent(period.start))}%">
          <span class="day-block-label">${period.name}</span>
        </div>`,
    ).join('');
    // 每个节次的边界放一个刻度点 —— beUI RangeSlider 的 showTicks
    const ticks = PERIODS.map(
      (period) => `<span class="day-tick" style="left:${round2(percent(period.start))}%"></span>`,
    ).join('');
    track.innerHTML = `<div class="day-fill" aria-hidden="true"></div>${blocks}${ticks}`;
    const fill = $('.day-fill', track);

    const nodes = $$('.day-block', track);
    function fitLabels() {
      const trackWidth = track.clientWidth;
      nodes.forEach((node) => {
        const label = $('.day-block-label', node);
        if (!label) return;
        label.style.visibility = Number(node.dataset.share) * trackWidth < 56 ? 'hidden' : 'visible';
      });
    }
    fitLabels();
    window.addEventListener('resize', fitLabels, { passive: true });

    const say = {
      normalClient: $('#o-normal-client'),
      normalScreen: $('#o-normal-screen'),
      urgentScreen: $('#o-urgent-screen'),
    };

    function periodAt(minutes) {
      return (
        PERIODS.find((period) => minutes >= period.start && minutes < period.end) ??
        PERIODS[PERIODS.length - 1]
      );
    }

    // ── 把手：位置走弹簧，拖拽时纵向拉伸
    const position = new Spring(percent(Number(input.value)), SPRING_GLIDE, (value) => {
      marker.style.left = `${round2(value)}%`;
      if (fill) fill.style.width = `${round2(value)}%`;
    });
    // 初值就等于目标时 set() 会早退，得手动把首帧刷上去，否则把手停在默认的 left: auto
    position.paint();
    const stretch = new Spring(
      1,
      SPRING_BOUNCY,
      (value) => {
        marker.style.setProperty('--thumb-stretch', round2(value));
      },
      { restFloor: 0.002 },
    );

    function readOut() {
      const minutes = Number(input.value);
      const period = periodAt(minutes);
      const left = percent(minutes);
      if (reduceMotion()) {
        position.jump(left);
        if (fill) fill.style.width = `${round2(left)}%`;
      } else {
        position.set(left);
      }

      if (timeEl) timeEl.textContent = hhmm(minutes);

      if (stateEl) {
        if (period.inClass) {
          stateEl.textContent = period.subject
            ? `正在上 ${period.name} · ${period.subject}`
            : `${period.name}（算上课时段）`;
        } else {
          const next = PERIODS.find((item) => item.start >= minutes && item.inClass);
          stateEl.textContent = next
            ? `${period.name} · 下一节 ${hhmm(next.start)} 开始${next.subject ? `（${next.subject}）` : ''}`
            : `${period.name} · 今天的课都上完了`;
        }
      }

      root.dataset.inclass = period.inClass ? 'true' : 'false';

      if (say.normalClient) {
        say.normalClient.textContent = period.inClass
          ? '先收着：窗口直接隐藏，打下课铃再把详情弹出来。'
          : '直接弹出来：先是一个胶囊，点开才是详情卡。';
      }
      if (say.normalScreen) {
        say.normalScreen.textContent = period.inClass
          ? '暂存起来，打下课铃补弹（插件订阅课程事件）。'
          : '直接全屏弹出。';
      }
      if (say.urgentScreen) {
        say.urgentScreen.textContent = period.inClass
          ? '立刻全屏弹出，可以语音朗读 —— 老师正在等学生。'
          : '立刻全屏弹出，可以语音朗读。';
      }
    }

    input.addEventListener('input', readOut);
    if (!reduceMotion()) {
      input.addEventListener('pointerdown', () => stretch.set(1.35));
      const relax = () => stretch.set(1);
      input.addEventListener('pointerup', relax);
      input.addEventListener('pointercancel', relax);
      input.addEventListener('pointerleave', relax);
    }
    readOut();
  }

  /* ══════════════════════════════════════════════════════════════════════
     七、验收数字滚动 —— beUI NumberTicker
     每位数字是一列 0–9 的竖排，靠 translateY 滚到目标位；进场时逐位错开。
     ══════════════════════════════════════════════════════════════════════ */

  function setupNumberTickers() {
    const tickers = $$('[data-ticker]');
    if (!tickers.length) return;

    tickers.forEach((host) => {
      const value = host.dataset.ticker;
      host.innerHTML = `<span class="sr-only">${value}</span>`;
      const visual = document.createElement('span');
      visual.className = 'ticker';
      visual.setAttribute('aria-hidden', 'true');

      Array.from(value).forEach((char, index) => {
        if (!/\d/.test(char)) {
          const separator = document.createElement('span');
          separator.className = 'ticker-sep';
          separator.textContent = char;
          visual.append(separator);
          return;
        }
        const column = document.createElement('span');
        column.className = 'ticker-digit';
        // 静息位置一开始就写好：没轮到它滚动时也是正确的数字，不会是 0
        column.style.setProperty('--roll-to', `-${round2(Number(char) * 1.1)}em`);
        column.style.setProperty('--roll-delay', `${round2(index * DURATION.numberStagger)}s`);
        column.innerHTML = `<span class="ticker-roll">${Array.from({ length: 10 }, (_, n) => `<span>${n}</span>`).join('')}</span>`;
        visual.append(column);
      });

      host.append(visual);
      host.dataset.state = 'idle';
    });

    /** 先落到 0、再去掉这个类 —— 浏览器才会把「滚上去」的过渡跑起来 */
    function run(host) {
      if (host.dataset.state === 'done') return;
      host.dataset.state = 'done';
      if (reduceMotion()) return; // 静息位置本来就是对的，不需要动
      $$('.ticker-digit', host).forEach((column) => {
        column.classList.add('is-arming');
        void column.offsetWidth;
        after(Number.parseFloat(column.style.getPropertyValue('--roll-delay')) || 0, () =>
          column.classList.remove('is-arming'),
        );
      });
    }

    if (!('IntersectionObserver' in window)) {
      tickers.forEach(run);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            run(entry.target);
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.6 },
    );
    tickers.forEach((host) => observer.observe(host));
  }

  /* ══════════════════════════════════════════════════════════════════════
     八、复制按钮 —— beUI ActionSwap 的 roll 变体
     ══════════════════════════════════════════════════════════════════════ */

  function setupCopyButtons() {
    $$('[data-copy]').forEach((button) => {
      const label = $('.copy-label', button) ?? button;
      const idle = label.textContent.trim();
      const swapped = button.dataset.copyDone ?? '已复制';

      // action-swap 的 roll 变体：新文案从下方 90% 滚上来，带一点模糊
      label.style.transition = `opacity 0.25s ${EASE_OUT}, filter 0.25s ${EASE_OUT}`;
      const roll = new Spring(
        90,
        SPRING_SWAP,
        (value) => {
          label.style.transform = `translateY(${round2(value)}%)`;
        },
        { restFloor: 0.05 },
      );

      function swapTo(text) {
        label.textContent = text;
        if (reduceMotion()) {
          label.style.opacity = '1';
          label.style.filter = 'blur(0px)';
          roll.jump(0);
          return;
        }
        label.style.transition = 'none';
        label.style.opacity = '0';
        label.style.filter = 'blur(3px)';
        roll.jump(90);
        void label.offsetWidth;
        label.style.transition = `opacity 0.25s ${EASE_OUT}, filter 0.25s ${EASE_OUT}`;
        label.style.opacity = '1';
        label.style.filter = 'blur(0px)';
        roll.set(0);
      }

      button.addEventListener('click', async () => {
        const source = $(button.dataset.copy);
        if (!source) return;
        const text = source.textContent.trim();
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          const range = document.createRange();
          range.selectNodeContents(source);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          document.execCommand('copy');
          selection.removeAllRanges();
        }

        swapTo(swapped);
        button.dataset.done = '1';
        after(2, () => {
          swapTo(idle);
          button.dataset.done = '0';
        });
      });
    });
  }

  /* ══════════════════════════════════════════════════════════════════════
     十、实机截图 —— beUI Tabs（分段控件）+ Content swap（换组）+ Morphing lightbox
     ══════════════════════════════════════════════════════════════════════ */

  /**
   * 图都是 `website/tools/capture-shots.mjs` 与客户端冒烟脚本真的把程序跑起来截的
   * （见 README §7「官网」的采集步骤），不是画的示意。
   */
  const SHOT_GROUPS = [
    {
      id: 'web',
      label: 'Web 管理端',
      items: [
        {
          file: 'web-dashboard.jpg',
          kind: 'screen',
          cap: '仪表盘 —— 统计卡、最新通知与最近作业，范围按账号权限自动收窄',
        },
        {
          file: 'web-schedules.jpg',
          kind: 'screen',
          cap: '课表管理 —— 按周排课、单双周标签，也能直接导入 ClassIsland 的档案',
        },
        {
          file: 'web-homeworks.jpg',
          kind: 'screen',
          cap: '作业发布 —— 按天查看、快捷短语，教室机器上也能录',
        },
        {
          file: 'web-notifications.jpg',
          kind: 'screen',
          cap: '通知发布 —— 优先级、已读人数、上课时段发紧急通知要先过二次确认',
        },
        {
          file: 'web-grades.jpg',
          kind: 'screen',
          cap: '成绩录入 —— 单条 / 批量 / 表格导入，重复判定按「同班同学生同考试同课程」',
        },
        {
          file: 'web-integrations.jpg',
          kind: 'screen',
          cap: 'ClassIsland 联动 —— 设备在线状态、当前节次、回传与镜像开关',
        },
        {
          file: 'web-classes.jpg',
          kind: 'screen',
          cap: '班级管理 —— 建班、换班主任、改班级码与班级密码（仅管理员）',
        },
        { file: 'web-students.jpg', kind: 'screen', cap: '学生管理 —— 名单、表格导入，以及发「叫人」' },
        {
          file: 'web-teachers.jpg',
          kind: 'screen',
          cap: '教师管理 —— 单个录入 / 导入名单 / 重置密码（仅管理员）',
        },
        {
          file: 'web-database.jpg',
          kind: 'screen',
          cap: '数据库管理 —— 连接状态、备份、导入导出、SQLite ⇄ MySQL 一键切换',
        },
        { file: 'web-login.jpg', kind: 'screen', cap: '登录页 —— 页面上没有任何示例账号或演示数据' },
      ],
    },
    {
      id: 'client',
      label: '教室机器',
      items: [
        {
          file: 'client-schedule.png',
          kind: 'screen',
          cap: '「今天」时间轴 —— 大时钟、正在上的课、距下课倒计时、下一节还有多久',
        },
        {
          file: 'client-homeworks.png',
          kind: 'screen',
          cap: '作业看板 —— 按科目分卡，整屏缩放到刚好放下，不用上下翻页',
        },
        {
          file: 'client-grades.png',
          kind: 'screen',
          cap: '本班成绩总览 —— 分数 / 得分率 / 等级，配一张柱状图',
        },
        {
          file: 'client-settings-island.png',
          kind: 'screen',
          cap: '灵动岛个性化 —— 高宽圆角字号、主题色、动画速度都能调',
        },
        {
          file: 'client-settings-appearance.png',
          kind: 'screen',
          cap: '外观 —— 浅色 / 深色两套主题，切换即时生效',
        },
      ],
    },
    {
      id: 'island',
      label: '灵动岛',
      items: [
        { file: 'island-4-pill.png', kind: 'island', cap: '胶囊 —— 消息到达时先出这个，点开才是详情' },
        { file: 'island-5-clicked.png', kind: 'island', cap: '展开的详情卡 —— 标题、正文、时间与三个按钮' },
        {
          file: 'island-3-urgent.png',
          kind: 'island',
          cap: '紧急通知 —— 卡片内部红色呼吸光晕，上课时段也立刻展开',
        },
        {
          file: 'island-8-call.png',
          kind: 'island',
          cap: '叫人 ——「请 XXX 同学找 XXX 老师」，按钮是「收到」',
        },
        { file: 'island-7-homework.png', kind: 'island', cap: '新作业 —— 青蓝描边加书本图标' },
        {
          file: 'island-2-after-class.png',
          kind: 'island',
          cap: '上课期间收到、先收着的通知，打下课铃自动补弹',
        },
      ],
    },
    {
      id: 'mobile',
      label: '手机',
      items: [
        {
          file: 'mobile-notifications.jpg',
          kind: 'phone',
          cap: '手机上的抽屉导航 —— 侧边栏收进抽屉，由顶栏汉堡按钮唤出',
        },
        {
          file: 'mobile-dashboard.jpg',
          kind: 'phone',
          cap: '手机仪表盘 —— 统计卡两列，表格在卡片内横向滚动，页面不横滚',
        },
      ],
    },
  ];

  function setupShots() {
    const widget = $('#shots-widget');
    const tabsHost = $('.shots-tabs', widget ?? document);
    const indicator = $('.shots-indicator', widget ?? document);
    const grid = $('#shots-grid');
    if (!widget || !tabsHost || !indicator || !grid) return;

    // ── 分段控件：指示器在选项之间滑移（beUI Tabs 的 layoutId，这里靠 SPRING_LAYOUT 驱动）
    const indicatorX = new Spring(0, SPRING_LAYOUT, (value) => {
      indicator.style.transform = `translateX(${round2(value)}px)`;
    });
    const indicatorW = new Spring(0, SPRING_LAYOUT, (value) => {
      indicator.style.width = `${round2(value)}px`;
    });

    const tabs = SHOT_GROUPS.map((group) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'shots-tab';
      button.setAttribute('role', 'tab');
      button.dataset.shotsTab = group.id;
      button.textContent = group.label;
      button.setAttribute('aria-selected', 'false');
      button.addEventListener('click', () => select(group.id));
      return button;
    });
    tabsHost.append(...tabs);

    function moveIndicator(button, animate) {
      const hostBox = tabsHost.getBoundingClientRect();
      const box = button.getBoundingClientRect();
      const borderLeft = Number.parseFloat(getComputedStyle(tabsHost).borderLeftWidth) || 0;
      const x = box.left - hostBox.left - borderLeft;
      if (!animate || reduceMotion()) {
        indicatorX.jump(x);
        indicatorW.jump(box.width);
        return;
      }
      if (indicatorW.value === 0) indicatorW.jump(box.width);
      indicatorX.set(x);
      indicatorW.set(box.width);
    }

    // ── 卡片
    function makeCard(item) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'shot-card';
      card.dataset.kind = item.kind;
      card.dataset.press = '0.98';
      card.innerHTML = `
        <span class="shot-frame">
          <img src="assets/shots/${item.file}" alt="${item.cap}" loading="lazy" decoding="async" />
        </span>
        <span class="shot-cap">${item.cap}</span>`;
      bindPressable(card);
      card.addEventListener('click', () => openLightbox(card, item));
      return card;
    }

    /** beUI 的 Content reveal：透明度 + 8px 上浮 + 去模糊，0.22s EASE_OUT */
    const GRID_HIDDEN = { opacity: '0', transform: 'translateY(8px)', filter: 'blur(4px)' };

    function hideGrid() {
      grid.style.transition = 'none';
      grid.style.opacity = GRID_HIDDEN.opacity;
      grid.style.transform = GRID_HIDDEN.transform;
      grid.style.filter = GRID_HIDDEN.filter;
    }

    function revealGrid() {
      grid.style.transition = `opacity ${DURATION.reveal}s ${EASE_OUT}, transform ${DURATION.reveal}s ${EASE_OUT}, filter ${DURATION.reveal}s ${EASE_OUT}`;
      grid.style.opacity = '1';
      grid.style.transform = 'translateY(0)';
      grid.style.filter = 'blur(0px)';
    }

    /** beUI 的 Content swap：旧的走得比新的快，位移只有几个像素 */
    function renderGrid(id, animate) {
      const group = SHOT_GROUPS.find((item) => item.id === id);
      if (!group) return;

      const build = () => {
        grid.innerHTML = '';
        for (const item of group.items) grid.append(makeCard(item));
      };

      if (!animate || reduceMotion()) {
        build();
        return;
      }

      grid.style.transition = `opacity 0.12s ${EASE_OUT}, transform 0.12s ${EASE_OUT}, filter 0.12s ${EASE_OUT}`;
      grid.style.opacity = '0';
      grid.style.transform = 'translateY(-4px)';
      grid.style.filter = 'blur(4px)';
      after(0.12, () => {
        build();
        grid.style.transition = 'none';
        grid.style.transform = 'translateY(4px)';
        void grid.offsetHeight;
        grid.style.transition = `opacity 0.18s ${EASE_OUT}, transform 0.18s ${EASE_OUT}, filter 0.18s ${EASE_OUT}`;
        grid.style.opacity = '1';
        grid.style.transform = 'translateY(0)';
        grid.style.filter = 'blur(0px)';
      });
    }

    let current = null;
    function select(id) {
      if (current === id) return;
      const first = current === null;
      current = id;
      tabs.forEach((button) => {
        button.setAttribute('aria-selected', String(button.dataset.shotsTab === id));
      });
      moveIndicator(tabs[SHOT_GROUPS.findIndex((group) => group.id === id)], !first);

      // 首次进入：先落到隐藏态再建卡片，否则会先闪一下可见的样子。
      // 起跑用「下一帧 + 定时器兜底」：rAF 被限流时（后台标签页、被遮挡的窗口）也不能把整块图库留在透明态。
      if (first && !reduceMotion()) {
        hideGrid();
        renderGrid(id, false);
        M.nextFrame(revealGrid);
        after(0.3, revealGrid);
        return;
      }
      renderGrid(id, !first);
    }

    // ── 大图：从缩略图原地长到大图（FLIP）
    const lightbox = $('#lightbox');
    const backdrop = $('#lightbox-backdrop');
    const panel = $('#lightbox-panel');
    const lightboxImg = $('#lightbox-img');
    const caption = $('#lightbox-cap');
    const closeButton = $('#lightbox-close');

    let openCard = null;
    let targetSize = { w: 0, h: 0 };
    const box = {
      x: new Spring(0, SPRING_LAYOUT, (v) => {
        panel.style.transform = `translate3d(${round2(v)}px, ${round2(box.y.value)}px, 0)`;
      }),
      y: new Spring(0, SPRING_LAYOUT, () => {
        panel.style.transform = `translate3d(${round2(box.x.value)}px, ${round2(box.y.value)}px, 0)`;
      }),
      w: new Spring(0, SPRING_LAYOUT, (v) => {
        panel.style.width = `${round2(v)}px`;
      }),
      h: new Spring(0, SPRING_LAYOUT, (v) => {
        panel.style.height = `${round2(v)}px`;
      }),
    };

    /** 目标矩形：屏幕类按视口收着放，灵动岛的图**不放大**（原图就只有几百像素） */
    function targetRect(kind, image) {
      const natural = {
        w: image.naturalWidth || 16,
        h: image.naturalHeight || 9,
      };
      const isIsland = kind === 'island';
      const maxWidth = window.innerWidth * (isIsland ? 0.92 : 0.94);
      const maxHeight = window.innerHeight * (isIsland ? 0.6 : 0.84);
      let scale = Math.min(maxWidth / natural.w, maxHeight / natural.h);
      if (isIsland) scale = Math.min(scale, 1);
      const w = Math.round(natural.w * scale);
      const h = Math.round(natural.h * scale);
      return {
        w,
        h,
        x: Math.round((window.innerWidth - w) / 2),
        y: Math.round((window.innerHeight - h) / 2),
      };
    }

    function openLightbox(card, item) {
      const thumb = $('img', card);
      if (!thumb) return;
      openCard = card;
      lightboxImg.src = `assets/shots/${item.file}`;
      lightboxImg.alt = item.cap;
      caption.textContent = item.cap;

      const start = thumb.getBoundingClientRect();
      const target = targetRect(item.kind, thumb);
      targetSize = target;

      lightbox.hidden = false;
      panel.style.width = `${round2(start.width)}px`;
      panel.style.height = `${round2(start.height)}px`;
      box.x.jump(start.left);
      box.y.jump(start.top);
      box.w.jump(start.width);
      box.h.jump(start.height);

      const fade = `opacity 0.18s ${EASE_OUT}`;
      backdrop.style.transition = fade;
      closeButton.style.transition = fade;
      caption.style.transition = fade;
      backdrop.style.opacity = '1';
      closeButton.style.opacity = '1';
      caption.style.opacity = '1';

      if (!reduceMotion()) {
        box.x.set(target.x);
        box.y.set(target.y);
        box.w.set(target.w);
        box.h.set(target.h);
        // 兜底：帧循环被限流时（后台标签页、被遮挡的窗口）弹簧推不动，
        // 面板会一直卡在缩略图那么大。半秒后还没动就直接落到终点。
        after(0.5, () => {
          if (lightbox.hidden) return;
          if (Math.abs(box.w.value - start.width) > 1) return;
          box.x.jump(target.x);
          box.y.jump(target.y);
          box.w.jump(target.w);
          box.h.jump(target.h);
        });
      } else {
        box.x.jump(target.x);
        box.y.jump(target.y);
        box.w.jump(target.w);
        box.h.jump(target.h);
      }

      document.body.style.overflow = 'hidden';
      closeButton.focus({ preventScroll: true });
    }

    function closeLightbox() {
      if (lightbox.hidden) return;
      const card = openCard;
      const thumb = card ? $('img', card) : null;
      const end = thumb ? thumb.getBoundingClientRect() : null;

      const fade = `opacity 0.14s ${EASE_OUT}`;
      backdrop.style.transition = fade;
      closeButton.style.transition = fade;
      caption.style.transition = fade;
      backdrop.style.opacity = '0';
      closeButton.style.opacity = '0';
      caption.style.opacity = '0';

      if (end && !reduceMotion()) {
        box.x.set(end.left);
        box.y.set(end.top);
        box.w.set(end.width);
        box.h.set(end.height);
      }
      after(reduceMotion() ? 0 : 0.22, () => {
        lightbox.hidden = true;
        lightboxImg.removeAttribute('src');
        document.body.style.overflow = '';
        if (card) card.focus({ preventScroll: true });
        openCard = null;
      });
    }

    backdrop.addEventListener('click', closeLightbox);
    closeButton.addEventListener('click', closeLightbox);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !lightbox.hidden) closeLightbox();
    });
    window.addEventListener(
      'resize',
      () => {
        if (lightbox.hidden) return;
        const thumb = openCard ? $('img', openCard) : null;
        if (!thumb) return;
        const next = targetRect(openCard.dataset.kind, thumb);
        if (next.w === targetSize.w && next.h === targetSize.h) return;
        targetSize = next;
        box.x.set(next.x);
        box.y.set(next.y);
        box.w.set(next.w);
        box.h.set(next.h);
      },
      { passive: true },
    );

    select('web');
    // 首帧之后量一次指示器：字体加载完宽度会变
    M.nextFrame(() => moveIndicator(tabs[0], false));
    window.addEventListener(
      'resize',
      () =>
        moveIndicator(
          tabs.find((b) => b.dataset.shotsTab === current),
          false,
        ),
      {
        passive: true,
      },
    );
  }

  /* ══════════════════════════════════════════════════════════════════════
     十一、启动
     ══════════════════════════════════════════════════════════════════════ */

  setupHeadlineReveal();
  setupIsland();
  setupNavPill();
  setupScrollProgress();
  setupPressable();
  setupPolicy();
  setupNumberTickers();
  setupCopyButtons();
  setupShots();

  // 下载页（download.html）的版本卡片是拉到 GitHub 清单之后才建出来的，建完会派发一次
  // `ch:content` —— 那时候启动已经跑过了，按压反馈得在这儿补挂一次
  // （bindPressable 对挂过的元素会自己跳过，重复派发不会重复绑定）。
  document.addEventListener('ch:content', setupPressable);
})();
