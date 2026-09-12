import path from 'node:path';
import { BrowserWindow, ipcMain, screen } from 'electron';
import {
  DEFAULT_ISLAND_APPEARANCE,
  ISLAND_POSITIONS,
  ISLAND_SHADOW_PAD,
  ISLAND_SIZE_DELTA,
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
 * 形态尺寸（**岛本身的尺寸**，不是窗口尺寸）：
 * - 胶囊 = 用户设置的 width/height（WinIsland compact 是 120×27，我们是文字型胶囊，默认 268×44）
 * - 展开/紧急/叫人 = 胶囊 + `ISLAND_SIZE_DELTA`（与渲染进程共用同一常量表）
 *
 * 窗口尺寸 = 最大形态 + `ISLAND_SHADOW_PAD`，**一次算好、开合过程中不变**（照搬 WinIsland：
 * 它的窗口也是一次创建成最大包围盒，形变全部发生在窗口内的画布上）。
 */
const BASE = {
  pill: { width: 216, height: 34 },
  expanded: { width: 216 + ISLAND_SIZE_DELTA.expanded.width, height: 34 + ISLAND_SIZE_DELTA.expanded.height },
  urgent: { width: 216 + ISLAND_SIZE_DELTA.urgent.width, height: 34 + ISLAND_SIZE_DELTA.urgent.height },
  /** "叫人"消息卡片（比普通详情略大，突出"请 XXX 同学找 XXX 老师"） */
  call: { width: 216 + ISLAND_SIZE_DELTA.call.width, height: 34 + ISLAND_SIZE_DELTA.call.height },
};

// 说明：几何动画已全部移交渲染进程（渲染层用 WinIsland 的弹簧逐帧逼近岛的宽高/圆角），
// 主进程不再做窗口帧动画，因此原 scheduleFrame / cancelFrame / requestAnimationFrame 声明已移除。

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

/**
 * 固定包围盒窗口的尺寸：取所有形态里最大的一个，再加上阴影留白。
 * **只在设置变化时重算一次**，开合过程中窗口尺寸恒定（照搬 WinIsland 的"一次建大窗口"）。
 */
let BBOX_SIZE = { width: 0, height: 0 };

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
  /** 设置页"预览效果"：直接展开示例岛、失焦不收起、到点自行消失 */
  preview?: boolean;
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
  /** 当前是否接收鼠标（固定大包围盒窗口默认穿透，由渲染进程按命中动态打开） */
  private interactive = false;
  /** 渲染进程上报的岛体矩形（窗口内 CSS px）：主进程据此做光标命中兜底轮询 */
  private hitRect: { x: number; y: number; width: number; height: number } | null = null;
  /** 光标命中兜底轮询定时器（见 syncHitFromCursor 注释） */
  private hitTimer: ReturnType<typeof setInterval> | null = null;
  /** 诊断/冒烟用：覆盖光标位置（屏幕坐标），null 表示使用真实光标 */
  private cursorOverride: { x: number; y: number } | null = null;
  /** 上次按矩形立即校正命中的时刻（限流用） */
  private lastHitSyncAt = 0;
  /** 设置页"预览效果"的示例通知 id（预览期间失焦不收起） */
  private previewId: string | null = null;
  /** 预览示例岛的自动收尾定时器 */
  private previewTimer: ReturnType<typeof setTimeout> | null = null;

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
      // 固定包围盒（最大形态 + 阴影留白）：开合过程中**窗口不再移动/缩放**
      ...this.windowBounds(),
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
    // 默认整块窗口不接收鼠标（避免大面积透明窗口吞掉桌面点击），
    // 只有指针进入"岛"的可见区域时，渲染进程才通过 island:set-interactive 打开命中。
    win.setIgnoreMouseEvents(true, { forward: true });
    // 光标命中兜底轮询：即使 forward 的 mousemove 丢失，也能按光标位置自行校正命中
    this.startHitPoll();
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
      // 设置页预览：示例岛要继续留在屏幕上（用户在调滑块时主窗口一直是焦点）
      if (this.previewId && this.state.active?.id === this.previewId) return;
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
   * 只认 URGENT：紧急通知、以及"紧急叫人"（服务端 urgent=true 落库为 URGENT）。
   * 普通叫人（HIGH）与普通通知同等待遇 —— 上课时段只进队列，不打断课堂。
   */
  private isImmediate(notification: IslandNotification): boolean {
    return notification.priority === 'URGENT';
  }

  /**
   * 是否"允许点开"（上课时段也允许）：
   * - 紧急消息（含紧急叫人）：必须立刻看到；
   * - **任何"叫人"**：老师在等学生，允许学生主动点开看（但普通叫人不会自动展开打断课堂）。
   * 其它普通通知在上课时段一律不显示、也不可点开。
   */
  private isOpenable(notification: IslandNotification | null | undefined): boolean {
    if (!notification) return false;
    return this.isImmediate(notification) || notification.kind === 'call';
  }

  /**
   * 收到一条消息。
   * - 紧急（含紧急叫人）：立刻展开（无视上课时段）
   * - 预览（设置页"预览效果"）：直接展开，且不因失焦收起
   * - 上课中：普通通知进队列并保持隐藏；**叫人**仍以胶囊形式可见（可点开、不自动展开）
   * - 其它：显示"新消息/新作业/叫人"胶囊，等待点击展开
   */
  pushNotification(notification: IslandNotification, context: IslandPushContext = {}): void {
    const inClass = context.inClass ?? this.state.inClass;
    this.state.inClass = inClass;
    if (context.currentPeriodEnd !== undefined)
      this.state.currentPeriodEnd = context.currentPeriodEnd ?? null;

    // 设置页"预览效果"：直接把示例岛展开（并标记为预览，失焦不收起、超时后自行消失）
    if (context.preview) {
      this.previewId = notification.id;
      this.clearTimers();
      this.state.queued = this.state.queued.filter((item) => item.id !== notification.id);
      this.state.active = notification;
      this.state.updatedAt = Date.now();
      this.setState({ mode: 'expanded' });
      this.previewTimer = setTimeout(() => {
        this.previewTimer = null;
        this.endPreview(notification.id);
      }, PREVIEW_DURATION_MS);
      logger.info(`灵动岛预览：${notification.title}`);
      return;
    }
    if (this.previewId && this.previewId !== notification.id) this.endPreview(this.previewId);

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
          ? `灵动岛紧急叫人消息：${notification.title}`
          : `灵动岛紧急插播：${notification.title}`,
      );
      return;
    }

    if (inClass && notification.kind === 'call') {
      // 上课时段的**普通叫人**：不自动展开（不打断课堂），但保留胶囊让学生能主动点开
      if (this.state.active && this.state.active.id !== notification.id) {
        this.state.queued.push(this.state.active);
      }
      this.activate(notification, 'call', 'pill');
      logger.info(`灵动岛叫人消息（上课中，保持胶囊可点开）：${notification.title}`);
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

    // 展示新的一条之前，把"正在展示的上一条"放回队列（否则它会被静默顶掉，
    // 收起后的类型汇总与"还有 N 条"都会漏掉它）
    if (this.state.active && this.state.active.id !== notification.id) {
      if (!this.state.queued.some((item) => item.id === this.state.active?.id)) {
        this.state.queued.push(this.state.active);
      }
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
      const active = this.state.active;
      if (active && this.isOpenable(active) && this.state.mode === 'pill') {
        // 上课期间被收起的紧急消息 / 叫人：下课后自动展开，避免学生错过
        logger.info('灵动岛：下课，重新展开被收起的紧急消息 / 叫人');
        this.setState({ mode: 'expanded' });
        this.scheduleCollapse(active.kind === 'call' ? TIMEOUTS.call : TIMEOUTS.urgent);
        return;
      }
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
        // 上课时段：普通通知（含普通叫人）一律不显示；但紧急通知 / 紧急叫人本来就是必须
        // 立刻看到的，收起（回缩为胶囊）之后必须能再次点开——否则学生会误以为消息消失了。
        const showing = this.state.active;
        if (this.state.inClass && !this.isOpenable(showing)) {
          logger.info(
            `灵动岛：上课时段忽略展开（priority=${showing?.priority ?? '-'} kind=${showing?.kind ?? '-'} id=${showing?.id ?? '-'}）`,
          );
          break;
        }
        // 收起态（胶囊 / 空闲细缝）再次点击必须能打开：
        // active 为空但队列里还有未看通知时，先把它取出来当"当前通知"再展开，
        // 否则会出现"岛明明在屏幕上，点了没反应"（部分情况下的收起态无法再次打开）。
        if (!this.state.active) {
          const pending = this.state.queued[this.state.queued.length - 1];
          if (pending) {
            this.state.queued = this.state.queued.filter((item) => item.id !== pending.id);
            this.state.active = pending;
            logger.info(`灵动岛：收起态点击，重新打开队列中的通知 ${pending.id}`);
          }
        }
        const active = this.state.active;
        if (active) {
          if (this.state.mode !== 'expanded') {
            logger.info(
              `灵动岛：展开通知 ${active.id}（priority=${active.priority} kind=${active.kind ?? '-'}）`,
            );
          }
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
        // 上课时段：普通通知彻底隐藏；**叫人 / 紧急消息**回缩为胶囊（保持可见，允许再次展开）
        if (this.state.inClass && !this.isOpenable(this.state.active)) {
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
    this.stopHitPoll();
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
    // 设置页"预览效果"：示例岛由 previewTimer 自行收尾（不参与"常驻胶囊"逻辑，也不因失焦收起）
    if (this.previewId && this.state.active?.id === this.previewId) return;
    this.clearTimers();
    this.collapseTimer = setTimeout(() => {
      this.collapseTimer = null;
      // 上课时段 + 紧急消息（含紧急叫人）：不自动隐藏（学生必须一直能看到、随时能再点开），
      // 只把展开卡回缩为胶囊；下课后再恢复为展开提示。
      const immediateActive = this.state.active;
      if (this.state.inClass && this.isOpenable(immediateActive)) {
        if (this.state.mode === 'expanded') this.setState({ mode: 'pill' });
        return;
      }
      // 关键行为：只要还有"没处理完"的通知（当前展示的或队列里的），收起后**保持胶囊**，
      // 不再直接消失 —— 否则用户看到岛收起了却点不到（"收起状态无法再次打开"）。
      // 彻底隐藏只发生在：用户点了"知道了 / 标为已读"、队列清空、或进入上课时段。
      const pending = this.state.active !== null || this.state.queued.length > 0;
      if (this.state.mode === 'expanded' && this.state.queued.length > 1) {
        // 还有多条未看：先回缩为"还有 N 条"胶囊
        this.setState({ mode: 'pill' });
        if (pending) return;
        this.hide();
        return;
      }
      if (pending) {
        if (this.state.mode !== 'pill') this.setState({ mode: 'pill' });
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
    if (this.previewTimer) {
      clearTimeout(this.previewTimer);
      this.previewTimer = null;
    }
  }

  /** 结束设置页"预览效果"：清定时器，并在需要时把示例通知移出灵动岛 */
  private endPreview(id: string): void {
    if (this.previewId === id) this.previewId = null;
    if (this.previewTimer) {
      clearTimeout(this.previewTimer);
      this.previewTimer = null;
    }
    if (this.state.active?.id === id) this.dismissActive();
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

  /**
   * 灵动岛窗口是**固定包围盒**（照搬 WinIsland）：开合过程中只改渲染层里岛的宽高/圆角，
   * 窗口本身**一帧都不动**，因此不会有"逐帧移动+缩放透明窗口"带来的抖动与残影。
   *
   * 这里只负责三件事：可见性、焦点、透明度；几何交给渲染进程的弹簧形变。
   */
  private syncWindow(): void {
    if (!this.win || this.win.isDestroyed()) return;

    // 上课时间段：一律不显示灵动岛（只有"正在展示的紧急通知 / 叫人"允许出现在屏幕上）
    // 上课时段：只有"紧急通知 / 叫人"允许出现在屏幕上——展开态与胶囊态都算
    // （胶囊态也允许，学生收起后还能再点开；普通通知则一律隐藏）
    const openableShowing = this.state.active !== null && this.isOpenable(this.state.active);
    if (this.state.inClass && !openableShowing) {
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
        this.setInteractive(false);
        this.win.setOpacity(this.appearance.opacity);
        if (!this.win.isVisible()) this.win.showInactive();
        return;
      }
      this.fadeOut();
      return;
    }

    this.setInteractive(true);
    if (!this.win.isVisible()) {
      // 窗口位置由固定包围盒决定（applyWindowLayout），这里只负责显示 + 透明度
      this.cancelFade();
      this.win.setOpacity(this.appearance.opacity);
      this.win.showInactive();
      return;
    }
  }

  /**
   * 按当前外观把窗口放到锚点上（**只在尺寸/位置设置变化时调用**，开合时不调用）。
   * 窗口尺寸 = 最大形态 + 2×阴影留白，因此任何形态的岛都能完整容纳。
   */
  private applyWindowLayout(): void {
    if (!this.win || this.win.isDestroyed()) return;
    const next = this.windowBounds();
    const current = this.win.getBounds();
    if (
      current.x === next.x &&
      current.y === next.y &&
      current.width === next.width &&
      current.height === next.height
    ) {
      return;
    }
    this.win.setBounds(next);
  }

  /** 固定包围盒窗口的矩形：以锚点定位，尺寸恒为"最大形态 + 阴影留白" */
  private windowBounds(): Bounds {
    const width = Math.round(BBOX_SIZE.width);
    const height = Math.round(BBOX_SIZE.height);
    const anchor = this.resolveAnchor();

    // 窗口比岛大 ISLAND_SHADOW_PAD（给投影留白），因此窗口要再偏移一个 pad，
    // 保证**岛**的边/中心精确落在锚点上（而不是让窗口落在锚点上）。
    const pad = ISLAND_SHADOW_PAD;
    let x: number;
    switch (anchor.hMode) {
      case 'left':
        x = anchor.hValue - pad;
        break;
      case 'right':
        x = anchor.hValue + pad - width;
        break;
      default:
        x = anchor.hValue - Math.round(width / 2);
        break;
    }
    const y = anchor.vMode === 'bottom' ? anchor.vValue + pad - height : anchor.vValue - pad;

    return { x, y, width, height };
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
   * 几何动画已完全移交渲染进程（固定窗口内做弹簧形变），这里只保留一个"取消"入口，
   * 供 `hideImmediately()` 等在打断场景下调用（现在无需真正取消任何窗口动画）。
   */
  private cancelBoundsAnimation(): void {
    this.boundsFrame = null;
    this.boundsToken += 1;
  }

  /**
   * 应用外观设置（设置页实时生效）：尺寸联动、透明度、置顶、动画开关与位置。
   * 窗口只在尺寸/位置变化时**重排一次**（`applyWindowLayout`），开合过程不碰窗口。
   */
  setAppearance(patch: Partial<IslandAppearance>): void {
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
    // 包围盒/锚点可能变化：窗口重排一次（**不是逐帧**，开合过程中绝不会再碰窗口）
    this.applyWindowLayout();
    // 外观变化后按新尺寸重新同步（隐藏态不显示，不做额外动作）
    if (this.state.mode !== 'hidden') this.syncWindow();
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

  /**
   * 鼠标命中开关（照搬 WinIsland 的 `set_cursor_hittest`）：
   * 窗口是固定大包围盒，若不控制命中就会把整片桌面的点击都吃掉。
   * 渲染进程做命中测试（指针是否在"岛"的可见区域/可交互控件内），再回调这里切换。
   *
   * 另外主进程还有一路**兜底**：`syncHitFromCursor()` 每 120ms 直接读光标坐标与渲染进程
   * 上报的岛体矩形比对。原因是 Windows 下 `forward: true` 的 mousemove 转发并不总是可靠，
   * 一旦"展开 → 收起"后转发丢失，窗口会永远停在穿透状态 —— 用户看到的就是
   * "点开了再收起，就再也点不开了"。
   */
  setInteractive(interactive: boolean): void {
    if (this.interactive === interactive) return;
    this.interactive = interactive;
    if (!this.win || this.win.isDestroyed()) return;
    // forward: true 让窗口在"忽略鼠标"时仍把 mousemove 转发给渲染进程，
    // 这样渲染进程才能发现指针进入岛体并重新打开命中。
    this.win.setIgnoreMouseEvents(!interactive, { forward: true });
  }

  /** 渲染进程上报的岛体矩形（窗口内 CSS px，坐标系与窗口 DIP 一致） */
  setHitRect(rect: { x: number; y: number; width: number; height: number } | null): void {
    this.hitRect = rect && rect.width > 0 && rect.height > 0 ? { ...rect } : null;
    // 立即校正一次（形变期间渲染进程已限流到 ~10 次/秒，这里再兜一层 60ms 防止抖动）
    const now = Date.now();
    if (now - this.lastHitSyncAt >= 60) {
      this.lastHitSyncAt = now;
      this.syncHitFromCursor();
    }
  }

  /** 当前岛体矩形（供冒烟验证） */
  getHitRect(): { x: number; y: number; width: number; height: number } | null {
    return this.hitRect ? { ...this.hitRect } : null;
  }

  /**
   * 诊断 / 冒烟专用：覆盖"光标位置"（屏幕坐标），让命中兜底轮询按指定坐标校正。
   *
   * 真实场景用 `screen.getCursorScreenPoint()`；冒烟里不能去挪用户的物理鼠标，
   * 因此提供一个显式注入点，把"光标在岛上 / 不在岛上"两种情况都变成可复现的断言。
   */
  setHitTestCursor(point: { x: number; y: number } | null): void {
    this.cursorOverride = point ? { ...point } : null;
    this.syncHitFromCursor();
  }

  /** 按光标位置校正命中（不依赖渲染进程是否收到 mousemove） */
  private syncHitFromCursor(): void {
    if (!this.win || this.win.isDestroyed() || !this.win.isVisible()) {
      this.setInteractive(false);
      return;
    }
    const rect = this.hitRect;
    if (!rect) {
      this.setInteractive(false);
      return;
    }
    const bounds = this.win.getBounds();
    const point = this.cursorOverride ?? screen.getCursorScreenPoint();
    const localX = point.x - bounds.x;
    const localY = point.y - bounds.y;
    const margin = 2;
    const inside =
      localX >= rect.x - margin &&
      localX <= rect.x + rect.width + margin &&
      localY >= rect.y - margin &&
      localY <= rect.y + rect.height + margin;
    this.setInteractive(inside);
  }

  private startHitPoll(): void {
    if (this.hitTimer) return;
    this.hitTimer = setInterval(() => this.syncHitFromCursor(), 120);
    // 定时器不应拖住进程退出
    this.hitTimer.unref?.();
  }

  private stopHitPoll(): void {
    if (!this.hitTimer) return;
    clearInterval(this.hitTimer);
    this.hitTimer = null;
  }

  /** 当前是否接收鼠标（供冒烟验证） */
  getInteractive(): boolean {
    return this.interactive;
  }

  /** 固定包围盒窗口的矩形（供冒烟验证"窗口全程不变"） */
  getWindowBounds(): Bounds {
    if (!this.win || this.win.isDestroyed()) return { x: 0, y: 0, width: 0, height: 0 };
    return this.win.getBounds();
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
  // 空闲细缝：宽固定 6px（WinIsland hidden_width 的思路），高取胶囊高度的一部分。
  // 岛在固定窗口内形变，因此这里就是**岛的尺寸**，不受窗口最小高度限制。
  SLIVER_SIZE = {
    width: ISLAND_SLIVER_WIDTH,
    height: Math.max(12, Math.min(28, appearance.height - 22)),
  };

  // 固定窗口包围盒 = 最大形态 + 2×阴影留白（岛在其中居中/贴边形变）
  const maxWidth = Math.max(SIZES.pill.width, SIZES.expanded.width, URGENT_SIZE.width, CALL_SIZE.width);
  const maxHeight = Math.max(SIZES.pill.height, SIZES.expanded.height, URGENT_SIZE.height, CALL_SIZE.height);
  BBOX_SIZE = {
    width: maxWidth + ISLAND_SHADOW_PAD * 2,
    height: maxHeight + ISLAND_SHADOW_PAD * 2,
  };
}

/**
 * 空闲细缝的**岛**尺寸（渲染进程里 `.island-card` 的宽高；窗口是固定包围盒，不代表当前形态）。
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
 * 岛在固定窗口内的留白（= 阴影余量，见 `ISLAND_SHADOW_PAD`）。
 * 窗口尺寸 = 最大形态 + 2×该留白，因此投影永远不会被窗口裁掉。
 */
/** 灵动岛与屏幕工作区边缘的留白 */
const ISLAND_MARGIN = 8;
/**
 * 说明：Windows 对窗口最小高度有约 36px 的限制，但**只影响窗口**。
 * 新版架构里窗口是固定包围盒、岛在窗口内形变，因此"空闲细缝"可以真正做到 6px 宽/十几像素高
 * （与 WinIsland 的 hidden_width=5 一致），不再受该限制。
 */
/**
 * 失焦收起的宽限期：刚展开的 500ms 内忽略 blur（避免"刚弹出就被抢焦点导致瞬间收起"）。
 * 冒烟里"点击屏幕任意位置收起"的用例会在展开后等待约 700ms 再触发 blur，仍能正常验证收起。
 */
const BLUR_GRACE_MS = 500;

/** 设置页"预览效果"的示例岛停留时长（到点自动收尾，避免一直挂在桌面上） */
const PREVIEW_DURATION_MS = 30_000;

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

  // 渲染进程命中测试结果 → 切换窗口是否接收鼠标
  ipcMain.on('island:set-interactive', (_event, interactive: boolean) => {
    island.setInteractive(interactive === true);
  });

  // 渲染进程上报岛体矩形 → 主进程按光标位置做命中兜底（不依赖 mousemove 转发）
  ipcMain.on(
    'island:set-hit-rect',
    (_event, rect: { x: number; y: number; width: number; height: number } | null) => {
      island.setHitRect(rect ?? null);
    },
  );

  ipcMain.on('island:action', (_event, payload: IslandActionPayload) => {
    if (!payload?.action) return;
    island.handleAction(payload);
  });
}

export {
  SIZES as ISLAND_SIZES,
  URGENT_SIZE as ISLAND_URGENT_SIZE,
  CALL_SIZE as ISLAND_CALL_SIZE,
  TIMEOUTS as ISLAND_TIMEOUTS,
};
