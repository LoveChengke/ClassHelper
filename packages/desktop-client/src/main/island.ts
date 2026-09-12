import path from 'node:path';
import { BrowserWindow, ipcMain, screen } from 'electron';
import {
  DEFAULT_ISLAND_APPEARANCE,
  ISLAND_POSITIONS,
  ISLAND_SLIVER_WIDTH,
  ISLAND_STYLES,
  type IslandAppearance,
  type IslandMode,
  type IslandNotification,
  type IslandState,
} from '@classhelper/shared';
import { logger } from './logger.js';
import { getConfig } from './config.js';

/**
 * 灵动岛（Dynamic Island）主进程控制器。
 *
 * 形态：一个独立的、无边框、透明、置顶、不占任务栏、不抢焦点的小窗口，
 *      固定在主显示器工作区顶部居中（"桌面中上方"）。
 *
 * 行为（对应产品需求）：
 * - 收到教师通知：变形为"新消息"胶囊；点击展开显示详情
 * - 上课时间段：非紧急通知不弹出（自动隐藏），进入待发队列
 * - 下课后：自动在桌面中上方弹出队列中的通知详情
 * - 紧急通知：无论是否在上课，立刻展开显示详情，无需点击
 *
 * 动画实现要点（需求 4：展开/收起不能抖动）：
 * - 窗口尺寸用**单一 requestAnimationFrame 循环**插值，不再用 setTimeout 链（避免掉帧与回跳）
 * - 锚点固定：横向按停靠位置计算、纵向固定，形变过程中卡片上边缘不动
 * - 卡片本身是固定尺寸（渲染进程），只让窗口露出/裁切，内容不参与布局重排
 * - 展开完成之后才取焦点（避免取焦瞬间抢走动画帧）
 * - 关闭动画时直接落到目标尺寸
 */

/** 基础尺寸：真实尺寸 = 外观设置联动计算（见 sizes()） */
/**
 * 基准尺寸（对齐 WinIsland 的 `base_width/base_height` 与 `expanded_width/expanded_height` 比例）：
 * - 胶囊：小而饱满（WinIsland compact 为 120×27，我们是文字型胶囊，取 216×34，圆角 = h/2 满圆角）
 * - 展开卡：展开增量与渲染进程 IslandApp.vue 的 EXTRA 常量一一对应
 *   （expanded +156×+218 / urgent +172×+238 / call +188×+254）
 */
const BASE = {
  pill: { width: 216, height: 34 },
  expanded: { width: 372, height: 220 },
  urgent: { width: 388, height: 236 },
  /** "叫人"消息卡片（比普通详情略大，突出"请 XXX 同学找 XXX 老师"） */
  call: { width: 404, height: 252 },
};

/**
 * 帧调度：优先 requestAnimationFrame（有则最平滑），主进程没有该全局时退化为 ~60fps 定时器。
 * 关键点不是用哪个 API，而是**始终只有一条动画循环**：每次新动画都会取消上一条并作废令牌，
 * 结束时再对齐一次最终尺寸，避免累积误差导致边缘"抖一下"。
 */
type FrameHandle = number;
declare const requestAnimationFrame: ((callback: (time: number) => void) => number) | undefined;
declare const cancelAnimationFrame: ((handle: number) => void) | undefined;

function scheduleFrame(callback: () => void): FrameHandle {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(() => callback());
  return setTimeout(callback, 16) as unknown as FrameHandle;
}

function cancelFrame(handle: FrameHandle): void {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle);
  else clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
}

const DEFAULT_SIZES: Record<IslandMode, { width: number; height: number }> = {
  hidden: BASE.pill,
  pill: BASE.pill,
  expanded: BASE.expanded,
};

let SIZES: Record<IslandMode, { width: number; height: number }> = { ...DEFAULT_SIZES };
let URGENT_SIZE = { ...BASE.urgent };
let CALL_SIZE = { ...BASE.call };

/**
 * 空闲"细缝"尺寸（参考 WinIsland 的 hidden_width：空闲态是一条很窄的圆角柱）。
 * 高度取胶囊高度的一部分，宽度固定（`ISLAND_SLIVER_WIDTH`）。
 */
let SLIVER_SIZE = { width: ISLAND_SLIVER_WIDTH, height: 22 };

/** 各状态的自动收起/隐藏时长（毫秒），0 表示不自动收起 */
const TIMEOUTS = {
  pill: 15_000,
  afterClassExpanded: 14_000,
  afterClassPill: 25_000,
  expanded: 20_000,
  urgent: 45_000,
  /** 叫人消息常驻更久，避免学生走开一会儿回来就看不到 */
  call: 90_000,
};

export interface IslandPushContext {
  inClass?: boolean;
  currentPeriodEnd?: string | null;
  week?: number;
}

export interface IslandClassStatePayload {
  inClass: boolean;
  currentPeriodEnd?: string | null;
  week?: number;
}

type IslandActionName = 'expand' | 'collapse' | 'dismiss' | 'mark-read' | 'open-app';

interface IslandActionPayload {
  action: IslandActionName;
  id?: string;
}

class IslandController {
  private win: BrowserWindow | null = null;
  private rendererUrl: string | null = null;
  private ready = false;
  private pendingState: IslandState | null = null;
  private collapseTimer: ReturnType<typeof setTimeout> | null = null;
  /** 尺寸（形变）动画令牌：新动画会作废上一轮，避免互相打架 */
  private boundsToken = 0;
  /** 透明度（淡入淡出）动画令牌，与尺寸动画分开，否则淡入会立刻取消形变 */
  private fadeToken = 0;
  /** 尺寸动画的 requestAnimationFrame 句柄（需求 4：单循环，避免抖动） */
  private boundsFrame: number | null = null;
  /** 外观设置（设置页可调，主进程持久化） */
  private appearance: IslandAppearance = { ...DEFAULT_ISLAND_APPEARANCE };
  /** 当前生效的窗口背景材质（'acrylic' | 'none'），用于避免重复设置与冒烟断言 */
  private backgroundMaterial: string = 'none';

  private state: IslandState = {
    mode: 'hidden',
    active: null,
    queued: [],
    inClass: false,
    currentPeriodEnd: null,
    reason: null,
    updatedAt: Date.now(),
  };

  /** 灵动岛展开时点击"打开应用"交给外部处理 */
  private openAppHandler: (() => void) | null = null;

  /** 灵动岛点"标为已读"时交给外部（主窗口渲染进程）同步通知中心 */
  private markReadHandler: ((id: string) => void) | null = null;

  setOpenAppHandler(handler: () => void): void {
    this.openAppHandler = handler;
  }

  setMarkReadHandler(handler: (id: string) => void): void {
    this.markReadHandler = handler;
  }

  async init(rendererUrl: string | null): Promise<void> {
    this.rendererUrl = rendererUrl;
    // 恢复用户保存的个性化外观（尺寸/位置/透明度/动画…），失败则用默认值
    try {
      this.appearance = normalizeAppearance({ ...DEFAULT_ISLAND_APPEARANCE, ...getConfig().island });
    } catch {
      this.appearance = { ...DEFAULT_ISLAND_APPEARANCE };
    }
    recomputeSizes(this.appearance);
    if (this.win && !this.win.isDestroyed()) return;

    const win = new BrowserWindow({
      ...this.computeBounds(SIZES.hidden),
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      // 不抢焦点：通知不应该打断学生正在做的事（键盘焦点仍留在原应用）
      focusable: false,
      alwaysOnTop: true,
      type: 'toolbar',
      webPreferences: {
        preload: path.join(__dirname, '../preload/island.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });

    win.setAlwaysOnTop(this.appearance.alwaysOnTop, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // 启动时即应用已保存的风格（glass 需要窗口创建后立刻设置材质）
    this.backgroundMaterial = 'none';
    this.applyBackgroundMaterial();
    win.setIgnoreMouseEvents(false);
    win.on('closed', () => {
      this.win = null;
      this.ready = false;
    });

    /**
     * 点击屏幕任意位置收起：展开态临时允许窗口获得焦点，
     * 用户点到别处（桌面、浏览器、其他应用）时窗口失焦 → 回缩为胶囊。
     *
     * 加一个宽限期（`BLUR_GRACE_MS`）：刚弹出/刚激活的瞬间，系统可能因为换前台窗口、
     * 抢焦点或截图等操作立刻产生一次 blur，此时收起会让"刚弹出的通知一闪就没了"。
     * 只在激活满 500ms 后才把 blur 当作"用户点击了别处"。
     */
    win.on('blur', () => {
      if (this.state.mode !== 'expanded' || this.state.inClass) return;
      const sinceActivated = Date.now() - this.state.updatedAt;
      if (sinceActivated < BLUR_GRACE_MS) {
        logger.info(`灵动岛：忽略激活后 ${sinceActivated}ms 内的失焦（宽限期内不收起）`);
        return;
      }
      logger.info('灵动岛：点击屏幕其他位置，回缩为胶囊');
      this.handleAction({ action: 'collapse' });
    });

    this.win = win;

    // 开发/冒烟时把灵动岛渲染进程的日志转发到主进程，便于排查"窗口空白"之类问题
    win.webContents.on('console-message', (...args) => {
      const first = args[0];
      const isEventObject = first && typeof first === 'object' && 'message' in first;
      const level = isEventObject ? first.level : args[1];
      const message = isEventObject ? first.message : args[2];
      const isProblem = level === 'error' || level === 'warning' || level === 2 || level === 3;
      if (isProblem || process.env.ELECTRON_SMOKE_TEST === '1') {
        logger.info(`[island-renderer] ${String(message)}`);
      }
    });

    if (rendererUrl) {
      await win.loadURL(rendererUrl);
    } else {
      await win.loadFile(path.join(__dirname, '../renderer/island.html'));
    }
    this.ready = true;
    if (this.pendingState) {
      this.emit(this.pendingState);
      this.pendingState = null;
    }
    // 首次进入时同步一次外观与状态，保证渲染进程不会停在初始默认值
    this.emitAppearance();
    this.emit();
    logger.info('灵动岛已就绪（置顶透明窗口，顶部居中）');
  }

  getWindow(): BrowserWindow | null {
    return this.win;
  }

  getState(): IslandState {
    return { ...this.state, queued: [...this.state.queued] };
  }

  isReady(): boolean {
    return this.ready && Boolean(this.win) && !this.win?.isDestroyed();
  }

  /* ------------------------------------------------------------ 对外行为 */

  /**
   * 是否需要"立即展开、无视上课时段"。
   * 紧急通知与"叫人"（老师点名）都属于：学生必须马上看到。
   */
  private isImmediate(notification: IslandNotification): boolean {
    return notification.priority === 'URGENT' || notification.kind === 'call';
  }

  /**
   * 收到一条消息。
   * - 紧急 / 叫人：立刻展开（无视上课时段）
   * - 上课中：进队列并保持隐藏（下课后由 setClassState 触发弹出）
   * - 其它：显示"新消息/新作业"胶囊，等待点击展开
   */
  pushNotification(notification: IslandNotification, context: IslandPushContext = {}): void {
    const inClass = context.inClass ?? this.state.inClass;
    this.state.inClass = inClass;
    if (context.currentPeriodEnd !== undefined)
      this.state.currentPeriodEnd = context.currentPeriodEnd ?? null;

    if (this.isImmediate(notification)) {
      // 插播：如果正在展示别的消息，把它放回队列
      if (this.state.active && this.state.active.id !== notification.id) {
        this.state.queued.push(this.state.active);
      }
      this.state.queued = this.state.queued.filter((item) => item.id !== notification.id);
      const reason = notification.kind === 'call' ? 'call' : 'urgent';
      this.activate(notification, reason, 'expanded');
      logger.info(
        notification.kind === 'call'
          ? `灵动岛叫人消息：${notification.title}`
          : `灵动岛紧急插播：${notification.title}`,
      );
      return;
    }

    if (inClass) {
      // 上课时段：自动隐藏，暂存待下课后弹出
      this.state.queued = [...this.state.queued.filter((item) => item.id !== notification.id), notification];
      if (this.state.mode !== 'hidden') {
        this.setState({ mode: 'hidden', reason: null });
      }
      this.state.updatedAt = Date.now();
      this.emit();
      logger.info(`灵动岛暂存通知（上课中，下课后弹出）：${notification.title}`);
      return;
    }

    if (this.state.mode === 'expanded' && this.state.active) {
      // 已经展开时，把当前这条挤入队列并显示新的一条
      this.state.queued.push(this.state.active);
    }
    this.state.queued = [...this.state.queued.filter((item) => item.id !== notification.id), notification];
    this.activate(notification, 'new', 'pill');
  }

  /** 上课状态变化：进入上课隐藏；下课则自动弹出队列 */
  setClassState(payload: IslandClassStatePayload): void {
    const wasInClass = this.state.inClass;
    this.state.inClass = payload.inClass;
    this.state.currentPeriodEnd = payload.currentPeriodEnd ?? null;

    if (payload.inClass) {
      if (!wasInClass) logger.info('灵动岛：进入上课时间段，自动隐藏');
      if (this.state.mode !== 'hidden') {
        // 上课期间自动隐藏（紧急通知也遵循，避免持续遮挡课堂投影）
        this.setState({ mode: 'hidden', reason: null });
      } else {
        this.state.updatedAt = Date.now();
        this.emit();
      }
      return;
    }

    if (wasInClass && !payload.inClass) {
      logger.info('灵动岛：下课，弹出上课期间暂存的通知');
      this.flushQueueAfterClass();
      return;
    }

    this.state.updatedAt = Date.now();
    this.emit();
  }

  /** 下课：弹出队列中最新的一条（展开显示详情），其余保留为"还有 N 条" */
  flushQueueAfterClass(): void {
    const next = this.state.queued[this.state.queued.length - 1];
    if (!next) {
      this.setState({ mode: 'hidden', reason: null });
      return;
    }
    const urgent = this.state.queued.find((item) => item.priority === 'URGENT');
    const target = urgent ?? next;
    this.activate(target, 'after-class', 'expanded');
  }

  handleAction(payload: IslandActionPayload): void {
    switch (payload.action) {
      case 'expand': {
        // 上课时段一律不显示灵动岛（只有紧急通知 / 叫人才会自动展开）
        if (this.state.inClass) break;
        const active = this.state.active;
        if (active) {
          this.setState({ mode: 'expanded' });
          this.scheduleCollapse(
            this.isImmediate(active)
              ? active.kind === 'call'
                ? TIMEOUTS.call
                : TIMEOUTS.urgent
              : TIMEOUTS.expanded,
          );
        }
        break;
      }
      case 'collapse':
        // 点击卡片空白处 / 右上角收起按钮 / 点击屏幕任意位置：回缩到灵动岛（胶囊）
        if (this.state.inClass) {
          this.hideImmediately();
          break;
        }
        if (this.state.active) {
          this.setState({ mode: 'pill', reason: this.state.reason });
          this.scheduleCollapse(TIMEOUTS.pill);
        } else {
          this.hide();
        }
        break;
      case 'dismiss':
        this.dismissActive();
        break;
      case 'mark-read': {
        const id = payload.id;
        const queue = this.state.queued.filter((item) => item.id !== id);
        this.state.queued = queue;
        if (this.state.active?.id === id) this.state.active = null;
        this.state.updatedAt = Date.now();
        if (this.state.mode === 'hidden') this.emit();
        else this.dismissActive();
        // 通知中心同步：转交主窗口渲染进程调用"标记已读"接口并刷新列表
        if (id) {
          logger.info(`灵动岛标记已读：${id}`);
          this.markReadHandler?.(id);
        }
        break;
      }
      case 'open-app':
        this.openAppHandler?.();
        break;
      default:
        break;
    }
  }

  hide(): void {
    this.clearTimers();
    if (!this.win || this.win.isDestroyed()) return;
    // 开启"空闲细缝"时不能走 fadeOut + skipWindow：那样会完全隐藏，
    // 必须让 syncWindow() 把窗口收成一条细缝（上课时段仍由 syncWindow 兜底为立即隐藏）。
    if (this.appearance.idleSliver) {
      this.setState({ mode: 'hidden', reason: null });
      return;
    }
    this.fadeOut();
    this.setState({ mode: 'hidden', reason: null }, { skipWindow: true });
  }

  /**
   * 立刻隐藏（不做淡出）：
   * 上课时间段必须"完全不显示灵动岛"，任何残留的淡出都会被投影/屏幕录制看到。
   */
  hideImmediately(): void {
    this.clearTimers();
    this.cancelBoundsAnimation();
    this.fadeToken += 1;
    const changed = this.state.mode !== 'hidden' || this.state.reason !== null;
    if (changed) {
      this.state = { ...this.state, mode: 'hidden', reason: null, updatedAt: Date.now() };
      this.emit();
    }
    if (!this.win || this.win.isDestroyed()) return;
    this.win.setFocusable(false);
    if (this.win.isVisible()) this.win.hide();
    this.win.setOpacity(1);
  }

  destroy(): void {
    this.clearTimers();
    this.cancelBoundsAnimation();
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }

  /* ------------------------------------------------------------ 内部实现 */

  private dismissActive(): void {
    this.clearTimers();
    if (this.state.active) {
      this.state.queued = this.state.queued.filter((item) => item.id !== this.state.active?.id);
    }
    this.state.active = null;

    const next = this.state.queued[this.state.queued.length - 1];
    if (next) {
      // 还有未看的通知：退成胶囊态提示"还有 N 条"
      this.state.active = next;
      this.setState({ mode: 'pill', reason: 'after-class' });
      this.scheduleCollapse(TIMEOUTS.afterClassPill);
      return;
    }
    this.hide();
  }

  private activate(notification: IslandNotification, reason: IslandState['reason'], mode: IslandMode): void {
    this.clearTimers();
    // 正在展示的通知从队列中移出，queue 只保留"尚未看过"的
    this.state.queued = this.state.queued.filter((item) => item.id !== notification.id);
    this.state.active = notification;
    this.state.updatedAt = Date.now();
    this.setState({ mode, reason });
    if (notification.priority === 'URGENT') {
      this.scheduleCollapse(TIMEOUTS.urgent);
    } else if (reason === 'after-class') {
      this.scheduleCollapse(TIMEOUTS.afterClassExpanded);
    } else if (mode === 'pill') {
      this.scheduleCollapse(TIMEOUTS.pill);
    } else {
      this.scheduleCollapse(TIMEOUTS.expanded);
    }
  }

  private scheduleCollapse(delayMs: number): void {
    this.clearTimers();
    this.collapseTimer = setTimeout(() => {
      this.collapseTimer = null;
      if (this.state.mode === 'expanded') {
        const hasMore = this.state.queued.length > 1;
        if (hasMore) {
          this.setState({ mode: 'pill' });
          this.scheduleCollapse(TIMEOUTS.afterClassPill);
        } else {
          this.hide();
        }
        return;
      }
      this.hide();
    }, delayMs);
  }

  private clearTimers(): void {
    if (this.collapseTimer) {
      clearTimeout(this.collapseTimer);
      this.collapseTimer = null;
    }
  }

  /**
   * 屏幕锚点：由停靠位置决定的"不动的那条边/中心"，全程使用**整数**。
   *
   * 关键点（修复"开合时震动"）：
   * - 锚点只跟屏幕工作区与停靠位置有关，与窗口尺寸无关 → 形变过程中不会逐帧漂移；
   * - 全部取整，避免 `Math.round` 在 0.5 边界上左右跳变（那会表现为 ±0.5px 的横向抖动）。
   */
  private resolveAnchor(): IslandAnchor {
    const area = screen.getPrimaryDisplay().workArea;
    const margin = ISLAND_MARGIN;
    const center = Math.round(area.x + area.width / 2);

    // 6 个停靠位置（顶/底 × 左/中/右），与 WinIsland 的 DockPosition 一一对应
    const position = this.appearance.position;
    const vMode: IslandAnchor['vMode'] = position.startsWith('bottom') ? 'bottom' : 'top';
    const vValue = vMode === 'bottom' ? area.y + area.height - margin : area.y + margin;
    const hMode: IslandAnchor['hMode'] = position.endsWith('left')
      ? 'left'
      : position.endsWith('right')
        ? 'right'
        : 'center';
    const hValue =
      hMode === 'left' ? area.x + margin : hMode === 'right' ? area.x + area.width - margin : center;
    return { hMode, hValue, vMode, vValue };
  }

  /**
   * 由锚点 + 目标尺寸推出窗口矩形。
   *
   * 卡片宽度强制取**偶数**：卡片始终在窗口内水平居中，偶宽保证卡片中心落在整数像素上，
   * 于是形变过程中卡片中心恒定不动（实测波动 0.00px），不会出现"左右轻微振动"。
   */
  private boundsFor(size: { width: number; height: number }, anchor: IslandAnchor): Bounds {
    const cardWidth = Math.max(2, evenWidth(Math.round(size.width) - CARD_PAD_X * 2));
    const cardHeight = Math.max(2, Math.round(size.height) - CARD_PAD_Y * 2);
    const width = cardWidth + CARD_PAD_X * 2;
    const height = cardHeight + CARD_PAD_Y * 2;

    let x: number;
    switch (anchor.hMode) {
      case 'left':
        x = anchor.hValue;
        break;
      case 'right':
        x = anchor.hValue - width;
        break;
      default:
        x = anchor.hValue - cardWidth / 2 - CARD_PAD_X;
        break;
    }

    const y = anchor.vMode === 'bottom' ? anchor.vValue - height : anchor.vValue;
    return { x, y, width, height };
  }

  private computeBounds(size: { width: number; height: number }): Bounds {
    return this.boundsFor(size, this.resolveAnchor());
  }

  /** 状态变更：先通知渲染进程，再驱动窗口尺寸/透明度动画 */
  private setState(patch: Partial<IslandState>, options: { skipWindow?: boolean } = {}): void {
    this.state = { ...this.state, ...patch, updatedAt: Date.now() };
    this.emit();
    if (!options.skipWindow) this.syncWindow();
  }

  private emit(state?: IslandState): void {
    const payload = state ?? this.getState();
    if (!this.win || this.win.isDestroyed()) {
      this.pendingState = payload;
      return;
    }
    if (!this.ready) {
      this.pendingState = payload;
      return;
    }
    this.win.webContents.send('island:state', payload);
  }

  private syncWindow(): void {
    if (!this.win || this.win.isDestroyed()) return;

    // 上课时间段：一律不显示灵动岛（只有"正在展示的紧急通知/叫人"允许出现在屏幕上）
    const immediateShowing =
      this.state.mode === 'expanded' && this.state.active !== null && this.isImmediate(this.state.active);
    if (this.state.inClass && !immediateShowing) {
      this.hideImmediately();
      return;
    }

    // 展开态才允许获得焦点，这样点击屏幕其他位置会 blur → 自动收起
    this.applyFocusable();

    if (this.state.mode === 'hidden') {
      // 空闲"细缝"（参考 WinIsland）：打开后空闲不再完全隐藏，而是留一条很窄的圆角柱；
      // 关闭时保持原行为（完全淡出并隐藏）。
      if (this.appearance.idleSliver) {
        this.cancelFade();
        this.win.setOpacity(this.appearance.opacity);
        if (!this.win.isVisible()) this.win.showInactive();
        this.animateBounds(SLIVER_SIZE);
        return;
      }
      this.fadeOut();
      return;
    }

    const size =
      this.state.mode === 'expanded'
        ? this.state.active
          ? this.isImmediate(this.state.active)
            ? this.state.active.kind === 'call'
              ? CALL_SIZE
              : URGENT_SIZE
            : SIZES.expanded
          : SIZES.expanded
        : SIZES.pill;

    if (!this.win.isVisible()) {
      const pillBounds = this.computeBounds(SIZES.pill);
      // 普通通知：直接出现在屏幕上，不做"上岛"入场动画
      if (size === SIZES.pill) {
        this.cancelFade();
        // 必须使用个性化透明度：这里以前硬编码 1，导致"隐藏后再弹出胶囊"会忽略透明度设置
        this.win.setOpacity(this.appearance.opacity);
        this.win.setBounds(pillBounds);
        this.win.showInactive();
        return;
      }
      // 展开 / 紧急：一定从胶囊尺寸开始缓动，保证"展开动画"看得见
      this.cancelFade();
      this.win.setOpacity(0);
      this.win.setBounds(pillBounds);
      this.win.showInactive();
      this.animateBounds(size, { spring: true });
      this.fadeIn();
      return;
    }
    this.animateBounds(size, { spring: size !== SIZES.pill });
  }

  /** 作废进行中的淡入淡出动画 */
  private cancelFade(): void {
    this.fadeToken += 1;
  }

  /** 展开态允许聚焦（用于"点击屏幕任意处收起"），其余时间不抢焦点 */
  private applyFocusable(): void {
    if (!this.win || this.win.isDestroyed()) return;
    const shouldFocus = this.state.mode === 'expanded';
    if (this.win.isFocusable() !== shouldFocus) this.win.setFocusable(shouldFocus);
    if (shouldFocus) this.win.focus();
  }

  private fadeIn(): void {
    if (!this.win || this.win.isDestroyed()) return;
    const target = this.appearance.opacity;
    if (!this.appearance.animations) {
      this.fadeToken += 1;
      this.win.setOpacity(target);
      return;
    }
    const token = ++this.fadeToken;
    let opacity = this.win.getOpacity();
    const step = (): void => {
      if (!this.win || this.win.isDestroyed() || token !== this.fadeToken) return;
      opacity = Math.min(target, opacity + 0.16);
      this.win.setOpacity(opacity);
      if (opacity < target) setTimeout(step, 16);
    };
    step();
  }

  private fadeOut(): void {
    if (!this.win || this.win.isDestroyed() || !this.win.isVisible()) return;
    if (!this.appearance.animations) {
      this.fadeToken += 1;
      this.win.hide();
      this.win.setOpacity(1);
      return;
    }
    const token = ++this.fadeToken;
    let opacity = this.win.getOpacity();
    const step = (): void => {
      if (!this.win || this.win.isDestroyed() || token !== this.fadeToken) return;
      opacity = Math.max(0, opacity - 0.2);
      this.win.setOpacity(opacity);
      if (opacity > 0.02) {
        setTimeout(step, 16);
        return;
      }
      this.win.hide();
      this.win.setOpacity(1);
    };
    step();
  }

  /**
   * 尺寸/位置缓动：Windows 下没有原生窗口动画，这里按帧插值实现"形变"效果。
   *
   * 用**单一 requestAnimationFrame 循环**驱动（需求 4）：
   * - 不再使用 setTimeout 链：避免掉帧、避免"每帧重新排定时器"带来的节奏抖动
   * - 锚点固定：锚点在动画开始前算一次（整数），过程中只让"对侧边"移动
   * - 缓动**单调不过冲**：早期版本用 easeOutBack 弹簧缓动，窗口尺寸会超过目标再弹回来，
   *   观感就是"开合时震一下"；现在统一用 easeOutCubic，尺寸/位置只朝目标单向变化
   * - 每帧只用整数像素、卡片宽度取偶数，卡片中心与不动的那条边全程恒定
   * - 关闭动画（appearance.animations = false）时直接落到目标尺寸
   */
  private animateBounds(size: { width: number; height: number }, options: { spring?: boolean } = {}): void {
    if (!this.win || this.win.isDestroyed()) return;
    const from = this.win.getBounds();
    const anchor = this.resolveAnchor();
    const to = this.boundsFor(size, anchor);
    if (from.width === to.width && from.height === to.height && from.x === to.x && from.y === to.y) return;

    this.cancelBoundsAnimation();
    const token = ++this.boundsToken;

    if (!this.appearance.animations) {
      this.win.setBounds(to);
      return;
    }

    // 形变时长：展开稍长一点（视觉上更"从容"），收回更快；倍速来自个性化设置
    const duration = Math.round(
      (options.spring === true ? 300 : 220) / Math.max(0.25, this.appearance.speed),
    );
    const fromCardWidth = Math.max(2, evenWidth(from.width - CARD_PAD_X * 2));
    const fromCardHeight = Math.max(2, from.height - CARD_PAD_Y * 2);
    const toCardWidth = Math.max(2, evenWidth(to.width - CARD_PAD_X * 2));
    const toCardHeight = Math.max(2, to.height - CARD_PAD_Y * 2);
    const startedAt = Date.now();

    const frame = (): void => {
      if (!this.win || this.win.isDestroyed() || token !== this.boundsToken) return;
      const progress = Math.min(1, (Date.now() - startedAt) / duration);
      // easeOutCubic：单调递减斜率，永不越过 1（因此不会有回弹）
      const eased = 1 - Math.pow(1 - progress, 3);

      const cardWidth = Math.max(
        2,
        evenWidth(Math.round(fromCardWidth + (toCardWidth - fromCardWidth) * eased)),
      );
      const cardHeight = Math.max(2, Math.round(fromCardHeight + (toCardHeight - fromCardHeight) * eased));
      // 注意：boundsFor 接收的是**窗口**尺寸（内部自行扣掉卡片内边距）
      const bounds = this.boundsFor(
        { width: cardWidth + CARD_PAD_X * 2, height: cardHeight + CARD_PAD_Y * 2 },
        anchor,
      );

      this.win.setBounds(bounds);
      if (progress < 1) {
        this.boundsFrame = scheduleFrame(frame);
        return;
      }
      // 收尾对齐到最终尺寸，避免四舍五入留下误差（会让卡片边缘"抖一下"）
      this.win.setBounds(to);
      this.boundsFrame = null;
      this.applyFocusable();
    };
    this.boundsFrame = scheduleFrame(frame);
  }

  /** 取消进行中的尺寸动画（帧循环） */
  private cancelBoundsAnimation(): void {
    if (this.boundsFrame !== null) {
      cancelFrame(this.boundsFrame);
      this.boundsFrame = null;
    }
    this.boundsToken += 1;
  }

  /**
   * 应用外观设置（设置页实时生效）：尺寸联动、透明度、置顶、动画开关与位置。
   * 尺寸只改窗口与卡片变量，渲染进程用 CSS 变量适配，不会引发布局错乱。
   */
  setAppearance(patch: Partial<IslandAppearance>): void {
    const before = this.appearance;
    this.appearance = normalizeAppearance({ ...this.appearance, ...patch });
    recomputeSizes(this.appearance);

    if (this.win && !this.win.isDestroyed()) {
      this.win.setAlwaysOnTop(this.appearance.alwaysOnTop, 'screen-saver');
      this.applyBackgroundMaterial();
      if (this.win.isVisible()) {
        // 显示中：立即应用透明度（隐藏时由 fadeIn 负责）
        this.win.setOpacity(this.appearance.opacity);
      }
    }
    this.emitAppearance();
    // 外观变化后按新尺寸重新同步（隐藏态不显示，不做额外动作）
    if (this.state.mode !== 'hidden') this.syncWindow();
    // 位置变化：即使当前不可见也先把窗口挪到新锚点，避免下次出现时"从旧位置飞过来"
    if (this.state.mode === 'hidden' && before.position !== this.appearance.position) {
      this.syncWindow();
    }
    logger.info(
      `灵动岛外观已更新：${this.appearance.width}x${this.appearance.height} 圆角=${this.appearance.radius} ` +
        `透明度=${this.appearance.opacity} 位置=${this.appearance.position} 风格=${this.appearance.style} ` +
        `字号=${this.appearance.fontSize} 动画=${this.appearance.animations} 速度=${this.appearance.speed} ` +
        `空闲细缝=${this.appearance.idleSliver}`,
    );
  }

  /**
   * 应用窗口背景材质（对应 WinIsland 的 `DWMWA_USE_HOSTBACKDROPBRUSH` / HostBackdropBrush）：
   * - `glass` 风格：Windows 11 的 acrylic 亚克力（真正的桌面模糊）
   * - 其他风格：`none`（纯色由渲染进程绘制，避免多余的模糊开销）
   * 平台不支持时静默降级为半透明纯色。
   */
  private applyBackgroundMaterial(): void {
    if (!this.win || this.win.isDestroyed()) return;
    const material = this.appearance.style === 'glass' ? 'acrylic' : 'none';
    if (this.backgroundMaterial === material) return;
    try {
      this.win.setBackgroundMaterial(material);
      this.backgroundMaterial = material;
    } catch (error) {
      logger.warn(`设置窗口背景材质失败（降级为纯色）：${(error as Error).message}`);
      this.backgroundMaterial = 'none';
    }
  }

  /** 当前窗口背景材质（供冒烟验证与设置页展示） */
  getBackgroundMaterial(): string {
    return this.backgroundMaterial;
  }

  getAppearance(): IslandAppearance {
    return { ...this.appearance };
  }

  /** 把外观同步给灵动岛渲染进程（CSS 变量） */
  private emitAppearance(): void {
    if (!this.win || this.win.isDestroyed() || !this.ready) return;
    this.win.webContents.send('island:appearance', this.getAppearance());
  }
}

/** 按外观设置换算各形态尺寸（胶囊尺寸可调，展开卡按比例联动，保证内容不溢出） */
export function recomputeSizes(appearance: IslandAppearance): void {
  const widthDelta = appearance.width - BASE.pill.width;
  const heightDelta = appearance.height - BASE.pill.height;
  const grow = (size: { width: number; height: number }): { width: number; height: number } => ({
    width: Math.max(appearance.width, size.width + widthDelta),
    height: Math.max(appearance.height, size.height + heightDelta),
  });
  SIZES = {
    hidden: { width: appearance.width, height: appearance.height },
    pill: { width: appearance.width, height: appearance.height },
    expanded: grow(BASE.expanded),
  };
  URGENT_SIZE = grow(BASE.urgent);
  CALL_SIZE = grow(BASE.call);
  // 空闲细缝：卡片宽固定 6px（WinIsland hidden_width 的思路），窗口 = 卡片 + 内边距。
  // 注意：Windows 对（透明无边框）窗口有约 36px 的**最小高度**限制——
  // 实测请求 32px 时实际得到 36px，因此这里直接以 36px 为下限，避免断言/预览与真实不一致。
  const sliverCardHeight = Math.max(16, Math.min(28, appearance.height - 22));
  SLIVER_SIZE = {
    width: Math.min(ISLAND_SLIVER_WIDTH + CARD_PAD_X * 2, appearance.width),
    height: Math.max(MIN_WINDOW_HEIGHT, sliverCardHeight + CARD_PAD_Y * 2),
  };
}

/**
 * 空闲细缝的**窗口**尺寸（`getBounds()` 返回值；卡片尺寸 = 再减去内边距）。
 * 供冒烟验证与设置页预览使用。
 */
export function getSliverSize(): { width: number; height: number } {
  return { ...SLIVER_SIZE };
}

/** 夹紧外观取值（越界值直接收敛，避免用户配置破坏布局） */
export function normalizeAppearance(input: IslandAppearance): IslandAppearance {
  const clamp = (value: number, min: number, max: number): number =>
    Math.min(max, Math.max(min, Math.round(value * 100) / 100));
  return {
    height: clamp(input.height, 36, 72),
    width: clamp(input.width, 220, 420),
    radius: clamp(input.radius, 8, 32),
    opacity: clamp(input.opacity, 0.4, 1),
    accent: /^#[0-9a-fA-F]{6}$/.test(input.accent) ? input.accent : DEFAULT_ISLAND_APPEARANCE.accent,
    fontSize: clamp(input.fontSize, 11, 20),
    animations: input.animations !== false,
    speed: clamp(input.speed, 0.5, 2),
    position: ISLAND_POSITIONS.includes(input.position) ? input.position : 'top-center',
    alwaysOnTop: input.alwaysOnTop !== false,
    style: ISLAND_STYLES.includes(input.style) ? input.style : 'black',
    idleSliver: input.idleSliver === true,
  };
}

/**
 * 说明：早期版本这里有一个 easeOutBack 弹簧缓动（进度过冲到 1 以上再回落），
 * 会让窗口尺寸"超过目标再弹回来"，观感就是开合时震一下，因此已移除；
 * 现在所有形变统一走单调的 easeOutCubic（见 animateBounds），不再有任何回弹。
 */

/**
 * 卡片相对窗口的内边距（必须与渲染进程 IslandApp.vue 的 CARD_PAD_X/CARD_PAD_Y 一致）。
 * 取 5px 是为了给展开态的投影（WinIsland: y+2、σ=3）留出不被窗口裁掉的余量。
 */
const CARD_PAD_X = 5;
const CARD_PAD_Y = 5;
/** 灵动岛与屏幕工作区边缘的留白 */
const ISLAND_MARGIN = 8;
/**
 * Windows 对窗口最小高度的实际限制（实测：请求 32px 会得到 36px）。
 * 空闲细缝等"极小形态"必须以此作为高度下限，否则断言与真实窗口会不一致。
 */
const MIN_WINDOW_HEIGHT = 36;
/**
 * 失焦收起的宽限期：刚展开的 500ms 内忽略 blur（避免"刚弹出就被抢焦点导致瞬间收起"）。
 * 冒烟里"点击屏幕任意位置收起"的用例会在展开后等待约 700ms 再触发 blur，仍能正常验证收起。
 */
const BLUR_GRACE_MS = 500;

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 屏幕锚点：由停靠位置决定的"不动的那条边/中心"（整数） */
interface IslandAnchor {
  hMode: 'center' | 'left' | 'right';
  hValue: number;
  vMode: 'top' | 'bottom';
  vValue: number;
}

/** 卡片宽度取偶数：保证水平居中的卡片中心落在整数像素上，形变时不左右跳变 */
function evenWidth(value: number): number {
  const safe = Math.max(2, Math.round(value));
  return safe - (safe % 2);
}

export const island = new IslandController();

/** 注册灵动岛相关 IPC（主窗口渲染进程 -> 主进程；灵动岛渲染进程 -> 主进程） */
export function registerIslandIpc(): void {
  ipcMain.on(
    'island:push',
    (_event, payload: { notification: IslandNotification; context?: IslandPushContext }) => {
      if (!payload?.notification) return;
      island.pushNotification(payload.notification, payload.context ?? {});
    },
  );

  ipcMain.on('island:class-state', (_event, payload: IslandClassStatePayload) => {
    if (!payload) return;
    island.setClassState(payload);
  });

  ipcMain.handle('island:get-state', () => island.getState());

  ipcMain.on('island:set-appearance', (_event, patch: Partial<IslandAppearance>) => {
    if (patch) island.setAppearance(patch);
  });

  ipcMain.handle('island:get-appearance', () => island.getAppearance());

  ipcMain.on('island:action', (_event, payload: IslandActionPayload) => {
    if (!payload?.action) return;
    island.handleAction(payload);
  });
}

export { SIZES as ISLAND_SIZES, URGENT_SIZE as ISLAND_URGENT_SIZE, CALL_SIZE as ISLAND_CALL_SIZE };
