import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrowserWindow, ipcMain, screen } from 'electron';
import {
  DEFAULT_ISLAND_APPEARANCE,
  ISLAND_POSITIONS,
  ISLAND_SHADOW_PAD,
  ISLAND_SIZE_DELTA,
  ISLAND_SLIVER_WIDTH,
  ISLAND_STYLES,
  PRIORITY_RANK,
  islandListLayout,
  type IslandAppearance,
  type IslandListLayout,
  type IslandMode,
  type IslandNotification,
  type IslandState,
} from '@classhelper/shared';
import { logger } from './logger.js';
import { getConfig } from './config.js';

/** 生产环境的灵动岛页面地址（导航白名单的精确比对用） */
const prodIslandUrl = pathToFileURL(path.join(__dirname, '../renderer/island.html')).href;

/**
 * 是否允许灵动岛窗口导航到这个地址。
 * 与主窗口同一套理由：preload 挂在窗口上而不是 URL 上，被导航走就等于把 `window.desktop`
 * 交给了一个陌生页面；而灵动岛还是置顶窗口，陌生页面会停在屏幕最上层。
 */
function isAllowedIslandNavigation(url: string, devUrl: string | null): boolean {
  try {
    const target = new URL(url);
    if (devUrl) return target.origin === new URL(devUrl).origin;
    target.hash = '';
    target.search = '';
    return target.href === prodIslandUrl;
  } catch {
    return false;
  }
}

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

type IslandActionName =
  | 'expand'
  | 'collapse'
  /** 多条通知时点"展开更多"：把列表铺到屏幕放得下的程度 */
  | 'expand-list'
  | 'dismiss'
  /** 多条通知时点"知道了"：整批关闭，但不改通知中心的已读状态 */
  | 'dismiss-all'
  | 'mark-read'
  /** 多条通知时点"标为已读"：整批已读并关闭 */
  | 'mark-all-read'
  | 'open-app';

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
  /** 当前是否接收鼠标（固定大包围盒窗口默认穿透，由渲染进程按命中动态打开） */
  /** 是否允许"失焦自动收起"（冒烟可临时关闭，避免焦点抖动干扰断言） */
  private blurCollapseEnabled = true;
  private interactive = false;
  /**
   * 触摸模式：触摸屏机器上由渲染进程按 `navigator.maxTouchPoints` 上报（见 `setTouchMode`）。
   *
   * 为什么触摸屏必须单独一套：触摸屏上"点不动"是**机制性**的，不是偶发 —— 打开命中的两条链路
   * （渲染进程的 mousemove 转发、主进程读系统光标位置）都以"鼠标指针移动"为前提，而手指触摸
   * 既不产生 mousemove、也不移动系统光标。于是窗口永远停在 `setIgnoreMouseEvents(true)` 的
   * 穿透态，手指点下去只落到桌面（用户反馈：希沃白板上触摸灵动岛无法展开）。
   *
   * 修法只有一条：**窗口在触摸点处必须可命中**。Electron 没有 SetWindowRgn 那种"窗口区域"能力，
   * 所以改成在触摸模式下让窗口**贴合岛体**（岛体 + 阴影留白）并始终接收输入 —— 贴身后多出来的
   * 只有投影所需的 10px 留白，不再吞掉桌面点击。
   */
  private touchMode = false;
  /** 渲染进程上报的岛体矩形（窗口内 CSS px）：主进程据此做光标命中兜底轮询 */
  private hitRect: { x: number; y: number; width: number; height: number } | null = null;
  /** 光标命中兜底轮询定时器（见 syncHitFromCursor 注释） */
  private hitTimer: ReturnType<typeof setInterval> | null = null;
  /** 诊断/冒烟用：覆盖光标位置（屏幕坐标），null 表示使用真实光标 */
  private cursorOverride: { x: number; y: number } | null = null;
  /**
   * 冒烟/诊断用：让窗口**不接收真实鼠标**（真实点击穿透到桌面）。
   *
   * 为什么需要：自动化验证时长分钟计，而岛上那套命中逻辑是按"真实光标位置"开的 ——
   * 若此时用户正在用同一块屏幕（他自己的客户端和冒烟窗口都在屏幕顶部居中、互相叠着），
   * 他点到的是**冒烟这个窗口**，冒烟就会收到人的点击（实测：冒烟从未发出的 collapse / mark-read
   * 混进了断言，把「点胶囊展开」「点空白处收起」等用例整片弄红）。
   * 打开后所有命中请求一律按"穿透"处理；合成 DOM 点击（executeJavaScript）不受影响。
   */
  private testInputPassthrough = false;
  /** 上次按矩形立即校正命中的时刻（限流用） */
  private lastHitSyncAt = 0;
  /** 设置页"预览效果"的示例通知 id（预览期间失焦不收起） */
  private previewId: string | null = null;
  /** 上课时段里"用户主动点开"的通知 id（syncWindow 的上课守卫对它放行） */
  private explicitShowId: string | null = null;
  /** 预览示例岛的自动收尾定时器 */
  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  /** 渲染进程最近一次心跳/存活信号（用于发现"卡死的幽灵窗口"） */
  private lastAliveAt = 0;
  /** 正在重建窗口（避免并发重建） */
  private recovering = false;
  /** 最近的窗口重建时刻（限流用） */
  private recoverAt: number[] = [];
  /** 上一次计算锚点所依据的显示器 id：用于发现"光标换屏 / 显示器插拔"并重排窗口 */
  private anchorDisplayId: number | null = null;
  /** 展开卡可用高度上限（CSS px）：由工作区/停靠位置算出，随状态下发给渲染进程 */
  private maxCardHeight = 1024;
  private state: IslandState = {
    mode: 'hidden',
    active: null,
    queued: [],
    inClass: false,
    currentPeriodEnd: null,
    reason: null,
    listExpanded: false,
    maxCardHeight: 1024,
    updatedAt: Date.now(),
  };

  /** 灵动岛展开时点击"打开应用"交给外部处理 */
  private openAppHandler: (() => void) | null = null;

  /** 灵动岛点"标为已读"时交给外部（主窗口渲染进程）同步通知中心 */
  private markReadHandler: ((id: string) => void) | null = null;

  /** 灵动岛一次"标为已读"要标记的多条通知（多条列表时的整批已读） */
  private markAllReadHandler: ((ids: string[]) => void) | null = null;

  setOpenAppHandler(handler: () => void): void {
    this.openAppHandler = handler;
  }

  setMarkReadHandler(handler: (id: string) => void): void {
    this.markReadHandler = handler;
  }

  setMarkAllReadHandler(handler: (ids: string[]) => void): void {
    this.markAllReadHandler = handler;
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
    this.refreshViewport();
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
      /**
       * **必须可激活**（focusable: true）。
       *
       * Windows 下 `WS_EX_NOACTIVATE` 且窗口不是活动窗口时，鼠标**按下**事件会被丢掉：
       * 渲染进程只会收到 mouseup、收不到 mousedown/click，于是胶囊怎么点都没反应
       * （真机实测：胶囊态只有 mouseup；展开态 focusable 时是完整的 mousedown+mouseup+click）。
       * "不抢焦点"靠 `showInactive()`（显示时不激活）+ 收起时 `blur()` 保证，而不是靠
       * 关掉可激活性 —— 关掉可激活性的代价就是"点不动"。
       */
      focusable: true,
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
    // 拒绝一切导航与新开窗口（理由见 isAllowedIslandNavigation）
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event, url) => {
      if (isAllowedIslandNavigation(url, this.rendererUrl)) return;
      event.preventDefault();
      logger.warn(`灵动岛拒绝了页面导航：${url}`);
    });
    // 注意：这里**不能**调用 `win.setBackgroundMaterial()`（亚克力/mica），
    // 见 `applyBackgroundMaterial` 移除处的说明。
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
     * 但 `win.focus()` 在 Windows 上并不可靠：展开时 `setFocusable(true) + focus()`
     * 常常先给焦点、再被系统收回，产生一次与用户操作无关的 blur（实测 70ms~520ms 后到达）。
     * 它落在 `BLUR_GRACE_MS` 宽限期内会被忽略，落在之后就会把刚展开的岛缩回胶囊 ——
     * 用户看到的就是「点了没反应 / 点开又立刻缩回去」。
     * 因此这里再用**指针位置**兜一层：指针还在岛上就绝不收起（详见 isCursorOnIsland）。
     */
    win.on('blur', () => {
      // 冒烟里可以临时关掉"失焦收起"，避免测试过程被无关的焦点变化打断（默认开启）
      if (!this.blurCollapseEnabled) return;
      if (this.state.mode !== 'expanded' || this.state.inClass) return;
      // 设置页预览：示例岛要继续留在屏幕上（用户在调滑块时主窗口一直是焦点）
      if (this.previewId && this.state.active?.id === this.previewId) return;
      const sinceActivated = Date.now() - this.state.updatedAt;
      if (this.isCursorOnIsland()) {
        logger.info(
          `灵动岛：忽略失焦（指针仍在岛上，判定为展开时的激活抖动）距上次状态=${sinceActivated}ms`,
        );
        return;
      }
      // 触摸屏上没有"指针"可依据（isCursorOnIsland 恒为 false），只能用更宽的宽限期覆盖
      // 上面实测到的 70~520ms 抖动区间，否则手指点开后约 0.5s 会莫名缩回胶囊。
      const grace = this.touchMode ? BLUR_GRACE_TOUCH_MS : BLUR_GRACE_MS;
      if (sinceActivated < grace) {
        logger.info(`灵动岛：忽略激活后 ${sinceActivated}ms 内的失焦（宽限期内不收起）`);
        return;
      }
      logger.info('灵动岛：点击屏幕其他位置，回缩为胶囊');
      this.handleAction({ action: 'collapse' });
    });

    this.win = win;
    this.lastAliveAt = Date.now();

    /**
     * 渲染进程没了/卡了时的自愈：隐藏死窗口（避免留下"幽灵胶囊"）并重建窗口。
     * 三种触发：进程崩溃、系统判定无响应、心跳超时（见 checkRendererAlive）。
     */
    win.webContents.on('render-process-gone', (_event, details) => {
      logger.error(
        `灵动岛渲染进程已退出（reason=${details.reason} exitCode=${details.exitCode}），开始重建窗口`,
      );
      this.recoverWindow('渲染进程退出');
    });
    win.webContents.on('unresponsive', () => {
      logger.warn('灵动岛渲染进程无响应（等待心跳恢复，超时将重建窗口）');
    });
    win.webContents.on('responsive', () => {
      logger.info('灵动岛渲染进程已恢复响应');
      this.lastAliveAt = Date.now();
    });

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
   * 同一条消息**可能经由两条广播链路到达**：服务端 `createCall` 既发 `notification:new`
   * （班级房间）又发 `call:new`（学生/班级 user 房间），两条 DTO 的 id 相同、
   * 只有"是否叫人"的语义不同。后到的那条绝不能把已有的"叫人"降级成普通通知 ——
   * 否则胶囊显示成"新消息"、上课时段还会被当成普通通知隐藏（用户实测截图：
   * 叫人胶囊写着"新消息 / 系统管理员 · 点击查看"）。
   *
   * 合并规则：类型取更特殊的（call 优先），优先级取更高的（URGENT > HIGH > NORMAL）。
   */
  private mergeNotification(
    existing: IslandNotification | null,
    incoming: IslandNotification,
  ): IslandNotification {
    if (!existing || existing.id !== incoming.id) return incoming;
    const kind = existing.kind === 'call' || incoming.kind === 'call' ? 'call' : incoming.kind;
    const priority =
      (PRIORITY_RANK[incoming.priority] ?? 0) >= (PRIORITY_RANK[existing.priority] ?? 0)
        ? incoming.priority
        : existing.priority;
    return { ...incoming, kind, priority };
  }

  /** 找到同 id 的已知消息（正在展示的或队列里的） */
  private findKnownNotification(id: string): IslandNotification | null {
    if (this.state.active?.id === id) return this.state.active;
    return this.state.queued.find((item) => item.id === id) ?? null;
  }

  /**
   * 当前**未处理**的消息（正在展示的 + 队列里的），按「重要程度 → 时间」倒序。
   *
   * 排序口径与共享常量 `PRIORITY_RANK` 一致：紧急 > 重要 > 普通 > 低，同级按时间新的在前。
   * 用户在展开卡里看到的就是这个顺序（"默认按重要程度排列"）。
   */
  private pendingNotifications(): IslandNotification[] {
    const merged: IslandNotification[] = [];
    if (this.state.active) merged.push(this.state.active);
    for (const item of this.state.queued) {
      if (!merged.some((existing) => existing.id === item.id)) merged.push(item);
    }
    return merged.sort((a, b) => {
      const rank = (PRIORITY_RANK[b.priority] ?? 0) - (PRIORITY_RANK[a.priority] ?? 0);
      if (rank !== 0) return rank;
      return String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''));
    });
  }

  /**
   * 多条通知时的列表布局（几条、要不要"展开更多"、卡片多高）。
   * 只有展开态且待处理 ≥ 2 条时才有列表形态，单条通知仍然是原来那张详情卡。
   */
  private listLayout(): IslandListLayout | null {
    if (this.state.mode !== 'expanded') return null;
    const count = this.pendingNotifications().length;
    if (count < 2) return null;
    return islandListLayout({
      count,
      fontSize: this.appearance.fontSize,
      maxHeight: this.maxCardHeight,
      expanded: this.state.listExpanded,
    });
  }

  /**
   * 展开卡在当前屏幕 / 停靠位置下的可用高度上限：
   * 从"岛被锚定的那条边"量到屏幕工作区的另一端（也就是任务栏上方）。
   *
   * 用锚点 `vValue` 而不是窗口矩形来算：锚点与窗口尺寸无关，因此**列表长高后再算还是同一个数**
   * （用窗口矩形会自引用：窗口高度取决于列表高度，列表高度又取决于可用高度）。
   */
  private refreshViewport(): void {
    const area = this.targetDisplay().workArea;
    const anchor = this.resolveAnchor();
    const marginY = Math.round(this.appearance.marginY ?? ISLAND_MARGIN);
    const available =
      anchor.vMode === 'bottom'
        ? anchor.vValue - (area.y + marginY)
        : area.y + area.height - marginY - anchor.vValue;
    // 下限兜底：屏幕再小也不能用 0 去算布局（否则连一行都排不出来）
    this.maxCardHeight = Math.max(MIN_CARD_HEIGHT, Math.floor(available));
    this.state.maxCardHeight = this.maxCardHeight;
  }

  /**
   * 收到一条消息。
   * - 紧急（含紧急叫人）：立刻展开（无视上课时段）
   * - 预览（设置页"预览效果"）：直接展开，且不因失焦收起
   * - 上课中：普通通知进队列并保持隐藏；**叫人**仍以胶囊形式可见（可点开、不自动展开）
   * - 其它：显示"新消息/新作业/叫人"胶囊，等待点击展开
   */
  pushNotification(raw: IslandNotification, context: IslandPushContext = {}): void {
    this.state.listExpanded = false;
    // 同一 id 的第二条链路（通知/叫人双播）：合并而不是覆盖，保住"叫人/紧急"语义
    const notification = this.mergeNotification(this.findKnownNotification(raw.id), raw);
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
      this.setState({ mode: 'expanded', listExpanded: false });
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
      this.explicitShowId = null;
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
    // 渲染进程（胶囊/卡片/按钮）点进来的动作：日志是排查"点了没反应"的关键证据
    logger.info(
      `灵动岛：收到用户动作 ${payload.action}${payload.id ? ` id=${payload.id}` : ''}（当前 ${this.state.mode}）`,
    );
    switch (payload.action) {
      case 'expand': {
        // 上课时段：普通通知（含普通叫人）一律不显示；但紧急通知 / 紧急叫人本来就是必须
        // 立刻看到的，收起（回缩为胶囊）之后必须能再次点开——否则学生会误以为消息消失了。
        const showing = this.state.active;
        // 岛当前可见（胶囊态）时，用户是"对着屏幕上这条岛"点的：
        // 只要队列里有更**新**的消息（例如紧急通知之后又来了作业），就应当打开新那条，
        // 而不是反复打开上一条 —— 否则表现为"点不开新作业"（用户反馈的联合通知场景）。
        // 岛完全隐藏时仍严格遵循上课不打扰。
        const islandVisible = this.state.mode !== 'hidden';
        if (this.state.inClass && !this.isOpenable(showing) && !islandVisible) {
          logger.info(
            `灵动岛：上课时段忽略展开（priority=${showing?.priority ?? '-'} kind=${showing?.kind ?? '-'} id=${showing?.id ?? '-'}）`,
          );
          break;
        }
        const newestQueued = this.state.queued[this.state.queued.length - 1];
        const shouldOpenNewest = Boolean(
          newestQueued &&
          (!showing || String(newestQueued.createdAt ?? '') > String(showing.createdAt ?? '')),
        );
        if (!this.state.active || shouldOpenNewest) {
          const pending = newestQueued;
          if (pending) {
            // 当前展示的那条回队列，换成最新的一条
            if (this.state.active && this.state.active.id !== pending.id) {
              this.state.queued = this.state.queued.filter(
                (item) => item.id !== pending.id && item.id !== this.state.active?.id,
              );
              this.state.queued.push(this.state.active);
            } else {
              this.state.queued = this.state.queued.filter((item) => item.id !== pending.id);
            }
            this.state.active = pending;
            logger.info(
              `灵动岛：收起态点击，打开最新通知 ${pending.id}（队列 ${this.state.queued.length} 条）`,
            );
          }
        }
        const active = this.state.active;
        if (active) {
          if (this.state.mode !== 'expanded') {
            logger.info(
              `灵动岛：展开通知 ${active.id}（priority=${active.priority} kind=${active.kind ?? '-'}）`,
            );
          }
          // 上课时段里"用户主动点开"的消息要能真的留在屏幕上：
          // 记下这条 id，syncWindow 的上课守卫对它是放行的（否则展开后会被立刻隐藏，
          // 表现为"点不开新作业"——用户反馈的联合通知场景）。
          this.explicitShowId = this.state.inClass ? active.id : null;
          // 每次重新点开都从"只显示前三条"开始（上文的 setState 只在离开 expanded 时复位）
          this.setState({ mode: 'expanded', listExpanded: false });
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
      case 'expand-list': {
        // 多条通知时点"展开更多"：把列表铺到屏幕放得下的程度（窗口跟着长高，见 setState）
        if (this.state.mode === 'hidden' || this.state.listExpanded) break;
        const layout = this.listLayout();
        if (!layout) break;
        logger.info(
          `灵动岛：展开更多（共 ${this.pendingNotifications().length} 条，显示 ${layout.rows} 条，提示=${layout.hint ?? '无'}）`,
        );
        this.setState({ mode: 'expanded', listExpanded: true });
        this.scheduleCollapse(TIMEOUTS.expanded);
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
      case 'dismiss-all':
        // 多条通知时点"知道了"：整批关闭（通知中心仍是未读，学生回应用里再看）
        logger.info(`灵动岛：整批知道了（${this.pendingNotifications().length} 条）`);
        this.clearPendingForClose();
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
      case 'mark-all-read': {
        // 多条通知时点"标为已读"：**默认把这一批全部标记已读**再关闭。
        // 作业卡的 id 是本地合成的（`homework-<id>`，库里没有这条通知），交给通知中心只会报"通知不存在"，
        // 因此这里先按 kind 过滤掉，单条模式的 canMarkRead 守卫同理。
        const ids = this.pendingNotifications()
          .filter((item) => item.kind !== 'homework')
          .map((item) => item.id);
        logger.info(`灵动岛：整批标为已读（${ids.length} 条）`);
        if (ids.length > 0) this.markAllReadHandler?.(ids);
        this.clearPendingForClose();
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
    this.explicitShowId = null;
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
    this.setInteractive(false, '立即隐藏');
    this.explicitShowId = null;
    this.fadeToken += 1;
    const changed = this.state.mode !== 'hidden' || this.state.reason !== null;
    if (changed) {
      this.state = { ...this.state, mode: 'hidden', reason: null, updatedAt: Date.now() };
      this.emit();
    }
    if (!this.win || this.win.isDestroyed()) return;
    // 焦点/可激活性统一由 applyFocusable 维护（窗口必须始终可激活，否则丢 mousedown）
    if (this.win.isFocused()) this.win.blur();
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

  /**
   * 整批清空并关闭（"知道了 / 标为已读"的多条场景）。
   * 状态同步落地（渲染进程随之收起卡片，窗口由 `hide()` 淡出）。
   */
  private clearPendingForClose(): void {
    this.clearTimers();
    this.state.active = null;
    this.state.queued = [];
    this.state.listExpanded = false;
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
    // 多显示器教室电脑：打开"跟随鼠标屏幕"后，岛出现在鼠标所在的那块屏（讲台切换投影时不用改设置）
    const display = this.targetDisplay();
    const area = display.workArea;
    const marginX = Math.round(this.appearance.marginX ?? ISLAND_MARGIN);
    const marginY = Math.round(this.appearance.marginY ?? ISLAND_MARGIN);
    const center = Math.round(area.x + area.width / 2);

    // 6 个停靠位置（顶/底 × 左/中/右），与 WinIsland 的 DockPosition 一一对应
    const position = this.appearance.position;
    const vMode: IslandAnchor['vMode'] = position.startsWith('bottom') ? 'bottom' : 'top';
    const vValue = vMode === 'bottom' ? area.y + area.height - marginY : area.y + marginY;
    const hMode: IslandAnchor['hMode'] = position.endsWith('left')
      ? 'left'
      : position.endsWith('right')
        ? 'right'
        : 'center';
    const hValue =
      hMode === 'left'
        ? area.x + marginX
        : hMode === 'right'
          ? area.x + area.width - marginX
          : center;
    return { hMode, hValue, vMode, vValue };
  }

  /** 当前应该把岛放在哪块屏上：跟随鼠标时用光标所在屏，否则用主屏 */
  private targetDisplay(cursor?: { x: number; y: number } | null): Electron.Display {
    return this.appearance.followCursorDisplay
      ? screen.getDisplayNearestPoint(cursor ?? this.cursorOverride ?? screen.getCursorScreenPoint())
      : screen.getPrimaryDisplay();
  }

  /**
   * 锚点所在屏幕变化时重排窗口（"跟随鼠标屏幕"、主屏切换、显示器插拔都会走到这里）。
   *
   * 原先锚点只在 `setAppearance()` 里算一次，于是"跟随鼠标屏幕"实际上**只在改设置的那一瞬间**
   * 生效：讲台从投影切回来之后，岛还留在原来那块屏上，直到用户再动一次外观设置。
   * 这里挂在已有的 60ms 命中轮询上（不新增定时器），并且只在目标屏幕真的变了、且窗口可见时才动窗口。
   *
   * 不需要额外监听 `screen` 的 display-* 事件：目标屏是由**当前光标位置**或主屏推出来的，
   * 插拔/切主屏之后下一轮 tick 自然会算出不同的 id，一样能触发重排。
   */
  private syncAnchorDisplay(cursor?: { x: number; y: number } | null): void {
    if (!this.win || this.win.isDestroyed()) return;
    const displayId = this.targetDisplay(cursor).id;
    if (this.anchorDisplayId === displayId) return;
    this.anchorDisplayId = displayId;
    // 换屏了：可用高度（工作区）也跟着换，列表"能放几行"要重算
    this.refreshViewport();
    if (!this.win.isVisible()) return;
    this.relayout();
  }

  /** 状态变更：先通知渲染进程，再驱动窗口尺寸/透明度动画 */
  private setState(patch: Partial<IslandState>, options: { skipWindow?: boolean } = {}): void {
    this.state = { ...this.state, ...patch, updatedAt: Date.now() };
    // 离开展开态就把"展开更多"复位：下次再点开时默认回到"只显示前三条"
    if (this.state.mode !== 'expanded') this.state.listExpanded = false;
    // 列表形态比普通展开卡高：窗口要**先**长高，卡片才开始形变，否则底部会被窗口裁掉
    if (!options.skipWindow) this.relayout();
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
    // 用户在课中主动点开的那条同样允许显示（否则"点开了又被立刻隐藏"）
    const explicitShowing =
      this.state.active !== null && this.state.active.id === this.explicitShowId && !this.previewId;
    if (this.state.inClass && !openableShowing && !explicitShowing) {
      this.hideImmediately();
      return;
    }

    // 展开态才允许获得焦点，这样点击屏幕其他位置会 blur → 自动收起
    this.applyFocusable();
    // 窗口不可见时先把包围盒对齐到当前形态：列表形态留下的"高窗口"在这里收回去。
    // 必须挑"不可见"的时刻做 —— 可见时改大小会把正在形变的卡片裁掉一截。
    if (!this.win.isVisible()) this.applyWindowLayout();
    // 触摸模式：形态变了，窗口要立刻跟着变大（缩小交给岛体矩形上报后判定，避免裁掉形变中的卡片）
    this.syncTouchLayout();

    if (this.state.mode === 'hidden') {
      // 空闲"细缝"（参考 WinIsland）：打开后空闲不再完全隐藏，而是留一条很窄的圆角柱；
      // 关闭时保持原行为（完全淡出并隐藏）。
      this.setInteractive(false, '隐藏态');
      if (this.appearance.idleSliver) {
        this.cancelFade();
        this.win.setOpacity(this.appearance.opacity);
        if (!this.win.isVisible()) this.win.showInactive();
        // 细缝也要"可见即可点"：按真实光标位置决定是否接收鼠标
        this.syncHitFromCursor();
        return;
      }
      this.fadeOut();
      return;
    }

    // 岛应该可见：**必须**先取消可能还在跑的淡出 —— 否则那次淡出会继续把透明度降到 0
    // 并 hide() 掉窗口，造成"状态是胶囊/展开、窗口却被隐藏"的错位（岛看着在、点不动或直接消失）。
    this.cancelFade();
    if (this.win.getOpacity() !== this.appearance.opacity) {
      this.win.setOpacity(this.appearance.opacity);
    }
    if (!this.win.isVisible()) {
      // 窗口位置由固定包围盒决定（applyWindowLayout），这里只负责显示
      this.win.showInactive();
    }
    // 命中一律按"真实光标是否落在岛上"决定：**绝不**整块固定包围盒吃鼠标，
    // 否则岛一旦弹出，屏幕上方就会有一块看不见却点不动的区域。
    this.syncHitFromCursor();
  }

  /**
   * 窗口包围盒：
   * - 普通（鼠标）模式：固定取"最大形态 + 2×阴影留白"，**开合过程中一帧都不动**（照搬 WinIsland）；
   *   唯一的例外是**多条通知的列表**：它比任何普通形态都高，窗口必须当场长高，否则卡片底部
   *   （那排按钮）会被窗口裁掉。窗口是在卡片开始形变**之前**改的，用户看不到这一步。
   * - 触摸模式：贴合当前形态（岛体 + 2×阴影留白），否则大包围盒的透明区会吞掉桌面的触摸。
   */
  private windowBox(): { width: number; height: number } {
    const size = this.formSize();
    if (!this.touchMode) {
      return {
        width: Math.round(Math.max(BBOX_SIZE.width, size.width + ISLAND_SHADOW_PAD * 2)),
        height: Math.round(Math.max(BBOX_SIZE.height, size.height + ISLAND_SHADOW_PAD * 2)),
      };
    }
    return {
      width: Math.round(size.width + ISLAND_SHADOW_PAD * 2),
      height: Math.round(size.height + ISLAND_SHADOW_PAD * 2),
    };
  }

  /**
   * 触摸模式下重排窗口（贴合岛体）：
   * **变大立刻生效**（否则形变中的卡片会被窗口裁掉一半）；**变小要等岛真的收小**——
   * 判据是渲染进程上报的真实岛体矩形已经装得下，见 `cardFitsFormSize`。
   */
  private syncTouchLayout(): void {
    if (!this.touchMode || !this.win || this.win.isDestroyed()) return;
    const target = this.windowBox();
    const current = this.win.getBounds();
    const shrinking = target.width < current.width || target.height < current.height;
    /**
     * **窗口可见期间只增不减**（触摸模式）。
     *
     * 为什么：触摸模式下窗口是"贴合岛体"的（手指要能点到岛），所以形态变化时窗口本该跟着变
     * —— 但**收小会让出一块区域**，Windows/DWM 在那一瞬间可能还留着上一帧的内容，
     * 用户看到的就是"一缩回/一展开就闪一下、像旧画面残留在那里"（反复反馈、逐帧抓过的那一类）。
     * 变大属于"只增不减"，不会让出任何区域；所以：
     * - 需要**变大**就立刻变大（否则形变中的卡片会被窗口裁掉）；
     * - 需要**变小**一律等窗口隐藏之后再收（`syncWindow` 里"不可见时对齐包围盒"，
     *   不可见时改尺寸不会有残影），这也顺带修掉"隐藏态改停靠/边距不生效"那条。
     */
    if (shrinking && this.win.isVisible()) return;
    this.applyWindowLayout();
  }

  /** 渲染进程上报的岛体是否已经收进"当前形态"的尺寸里（触摸模式下判断能否缩小窗口） */
  private cardFitsFormSize(): boolean {
    const rect = this.hitRect;
    if (!rect) return false;
    const size = this.formSize();
    return rect.width <= size.width + 1 && rect.height <= size.height + 1;
  }

  /** 外观 / 锚点变化后的窗口重排：普通模式按固定包围盒重排，触摸模式走贴合逻辑 */
  private relayout(): void {
    if (this.touchMode) this.syncTouchLayout();
    else this.applyWindowLayout();
  }

  /**
   * 按当前外观把窗口放到锚点上（**只在尺寸/位置设置变化时调用**，开合时不调用）。
   * 尺寸见 `windowBox`：普通模式恒为"最大形态 + 阴影留白"，触摸模式贴合当前形态。
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

  /** 窗口矩形：以锚点定位（尺寸由 `windowBox` 决定，触摸模式随形态变化） */
  private windowBounds(): Bounds {
    const box = this.windowBox();
    const width = box.width;
    const height = box.height;
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

  /**
   * 焦点策略：**窗口始终可激活**，只有展开态才真正持有键盘焦点。
   *
   * 为什么不能把可激活性关掉（focusable=false）：Windows 下 `WS_EX_NOACTIVATE` 且非活动窗口
   * 会**丢掉鼠标按下事件**（实测只到 mouseup、没有 mousedown/click），胶囊就"点不动"了。
   * 因此收起/隐藏时改为 `blur()`：既不占着用户的键盘焦点，又保持可激活（点击能正常送达）。
   * 展开态 `focus()` 是为了"点屏幕别处 → 失焦 → 回缩为胶囊"这条交互生效。
   */
  private applyFocusable(): void {
    if (!this.win || this.win.isDestroyed()) return;
    if (!this.win.isFocusable()) this.win.setFocusable(true);
    if (this.state.mode === 'expanded') {
      this.win.focus();
      return;
    }
    if (this.win.isFocused()) this.win.blur();
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

  /*
   * 为什么不使用窗口背景材质（Windows 亚克力 / mica）——踩过的坑，别再往回加：
   *
   * WinIsland 的 `glass` 用 `DWMWA_USE_HOSTBACKDROPBRUSH`（HostBackdropBrush）做真·桌面模糊，
   * Electron 里看起来对应 `win.setBackgroundMaterial('acrylic')`，但两者**语义完全不同**：
   *
   * 1. `setBackgroundMaterial()` 把材质刷在**整个窗口矩形**上，而不是卡片形状上。
   *    灵动岛是"固定大包围盒窗口"（卡片之外还有形变/阴影留白），于是卡片周围会露出一圈
   *    材质面板 —— 用户看到的就是"白底"（浅色主题下亚克力是浅灰白色，实测 (238,247,252)）。
   * 2. 材质的明暗跟随**应用主题**：本客户端是浅色 Fluent 主题，亚克力必然是浅色，
   *    无法像 WinIsland 那样自带深色 tint（`Color::from_argb(150, 10, 10, 14)`）。
   * 3. 更糟的是：只要调用过一次（**包括 `'none'`**），窗口就再也不是逐像素透明的了 ——
   *    Electron 会让它回落到默认不透明底色（`backgroundColor` 默认 `#FFF`），
   *    于是从 `glass` 切到 `black` / `tinted` 之后，卡片周围会永久留一圈**纯白**。
   *    这正好对应"毛玻璃和主题色渐变会出现白底"的现象。
   * 4. CSS `backdrop-filter: blur()` 也不能替代：透明窗口里 Chromium 采样不到窗口之后的桌面，
   *    真机实测与不加模糊的像素完全一致（卡片区域离散度都是 12.7）。
   *
   * 结论：`glass` 风格改为**纯 CSS 半透明深色卡片**（取 WinIsland 拿不到 host backdrop 时的
   * 官方降级色 `rgba(32,32,36,0.804)`，见 `docs/dev/winisland-design-tokens.md`），
   * 桌面透过率由卡片自身 alpha 决定，窗口始终保持 `transparent: true` 的逐像素透明。
   * 回归用例：「个性设置：卡片外圈透出桌面（三种风格都没有白底面板）」。
   */
  /**
   * 应用外观设置（设置页实时生效）：尺寸联动、透明度、置顶、动画开关与位置。
   * 窗口只在尺寸/位置变化时**重排一次**（`applyWindowLayout`），开合过程不碰窗口。
   */
  setAppearance(patch: Partial<IslandAppearance>): void {
    // 先丢掉显式 undefined 的键：设置页/冒烟脚本传的都是**部分补丁**，
    // 一个残缺字段不该把对应外观重置成默认值（NaN 的兜底在 normalizeAppearance 里）
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch ?? {})) {
      if (value !== undefined) clean[key] = value;
    }
    this.appearance = normalizeAppearance({ ...this.appearance, ...clean } as IslandAppearance);
    recomputeSizes(this.appearance);
    // 字号/边距会影响"列表能放几行"，可用高度也随停靠位置变化 —— 重算一次并随状态下发
    this.refreshViewport();

    if (this.win && !this.win.isDestroyed()) {
      this.win.setAlwaysOnTop(this.appearance.alwaysOnTop, 'screen-saver');
      if (this.win.isVisible()) {
        // 显示中：立即应用透明度（隐藏时由 fadeIn 负责）
        this.win.setOpacity(this.appearance.opacity);
      }
    }
    this.emitAppearance();
    // 包围盒/锚点可能变化：窗口重排一次（**不是逐帧**，开合过程中绝不会再碰窗口）
    this.relayout();
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
   * 鼠标命中开关（照搬 WinIsland 的 `set_cursor_hittest`）：
   * 窗口是固定大包围盒，若不控制命中就会把整片桌面的点击都吃掉。
   * 渲染进程做命中测试（指针是否在"岛"的可见区域/可交互控件内），再回调这里切换。
   *
   * 另外主进程还有一路**兜底**：`syncHitFromCursor()` 每 120ms 直接读光标坐标与渲染进程
   * 上报的岛体矩形比对。原因是 Windows 下 `forward: true` 的 mousemove 转发并不总是可靠，
   * 一旦"展开 → 收起"后转发丢失，窗口会永远停在穿透状态 —— 用户看到的就是
   * "点开了再收起，就再也点不开了"。
   */
  setInteractive(interactive: boolean, source = '未知'): void {
    // 触摸模式：窗口已贴合岛体，必须**始终**接收输入。触摸不会产生光标移动，按光标判定命中的
    // 那套逻辑在触摸屏上永远不会打开，一旦让它把命中关掉，手指就再也点不到（"点不动"）。
    // 测试输入穿透：真实鼠标一律不接收（理由见 testInputPassthrough 字段）；
    // 但**注入光标**（冒烟用 setHitTestCursor 模拟指针在岛上/岛外）照常生效，
    // 否则「光标轮询校正命中」「岛外穿透」这类断言全会被自己的开关弄红。
    const passthrough = this.testInputPassthrough && this.cursorOverride === null;
    const next = passthrough ? false : this.touchMode ? true : interactive;
    if (this.interactive === next) return;
    this.interactive = next;
    logger.info(
      `灵动岛：鼠标命中=${next}（请求=${interactive}，来自${source}）mode=${this.state.mode} ` +
        `窗口可见=${this.win?.isVisible() ?? false} 岛体矩形=${
          this.hitRect ? `${Math.round(this.hitRect.width)}x${Math.round(this.hitRect.height)}` : '无'
        }`,
    );
    if (!this.win || this.win.isDestroyed()) return;
    // forward: true 让窗口在"忽略鼠标"时仍把 mousemove 转发给渲染进程，
    // 这样渲染进程才能发现指针进入岛体并重新打开命中。
    // 注意传的是 next 而不是入参：触摸模式下入参可能是 false（按光标判定），
    // 直接用它会把窗口又打回穿透态 —— 那正是"手指点不开"的根因。
    this.win.setIgnoreMouseEvents(!next, { forward: true });
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
    // 触摸模式：窗口要一直贴合岛体，而"收小"必须等岛真的收小之后再做（否则形变中的卡片被窗口裁掉）。
    // 渲染进程每 ≥50ms 就会上报一次真实几何，正好拿来当这个判据。
    this.syncTouchLayout();
  }

  /** 当前岛体矩形（供冒烟验证） */
  getHitRect(): { x: number; y: number; width: number; height: number } | null {
    return this.hitRect ? { ...this.hitRect } : null;
  }

  /**
   * 设置触摸模式（触摸屏机器由渲染进程上报，冒烟也可显式开关）。
   *
   * 开启后：窗口贴合岛体（见 `windowBox`）且不再穿透（见 `setInteractive`）——
   * 这是让"手指按在岛上"能被 Windows 命中到本窗口的唯一办法（详见 `touchMode` 字段的注释）。
   * 关闭后回到"固定大包围盒 + 按光标命中"的原行为，因此非触摸屏机器的表现完全不变。
   */
  setTouchMode(enabled: boolean): void {
    if (this.touchMode === enabled) return;
    this.touchMode = enabled;
    logger.info(
      `灵动岛：触摸模式=${enabled}（窗口${enabled ? '贴合岛体并始终接收输入' : '回到固定包围盒穿透'}）`,
    );
    // 直接重排到目标包围盒：开启时贴合岛体，关闭时回到"最大形态 + 阴影留白"的固定大包围盒
    this.applyWindowLayout();
    if (enabled) this.setInteractive(true, '触摸模式');
    else this.syncHitFromCursor();
  }

  /** 是否处于触摸模式（供冒烟验证） */
  getTouchMode(): boolean {
    return this.touchMode;
  }

  /**
   * 开关"测试输入穿透"（冒烟用，见 `testInputPassthrough`）：
   * 打开后真实鼠标点击穿透到桌面，不会污染自动化断言；关闭后立刻按真实光标位置恢复命中。
   */
  setTestInputPassthrough(enabled: boolean): void {
    if (this.testInputPassthrough === enabled) return;
    this.testInputPassthrough = enabled;
    logger.info(`灵动岛：测试输入穿透=${enabled}（供自动化验证不被并行人工操作打扰）`);
    if (enabled) this.setInteractive(false, '测试输入穿透');
    else this.syncHitFromCursor();
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

  /**
   * 光标相对窗口左上角的本地坐标（CSS px / DIP，与渲染进程上报的岛体矩形同一坐标系）。
   * 冒烟里用 `setHitTestCursor` 注入，真实场景读系统光标。
   *
   * `cursor`：调用方在本轮 tick 里已经读过的光标位置（见 `startHitPoll`）。
   * 传进来就复用它，避免同一个 tick 里重复调 `screen.getCursorScreenPoint()`。
   */
  private cursorLocal(cursor?: { x: number; y: number } | null): { x: number; y: number } | null {
    if (!this.win || this.win.isDestroyed()) return null;
    const bounds = this.win.getBounds();
    const point = cursor ?? this.cursorOverride ?? screen.getCursorScreenPoint();
    return { x: point.x - bounds.x, y: point.y - bounds.y };
  }

  /**
   * 岛体矩形：优先用渲染进程上报的真实几何；渲染进程还没上报时用**主进程按当前形态算出的
   * 目标矩形**兜底 —— 否则会出现"岛明明可见、窗口却一直不接收鼠标（点了没反应）"这种死局。
   */
  private effectiveHitRect(): { x: number; y: number; width: number; height: number } | null {
    return this.hitRect ?? this.expectedHitRect();
  }

  /** 当前形态下**岛本身**的尺寸（不是窗口尺寸；响应进程的 `.island-card` 宽高） */
  private formSize(): { width: number; height: number } {
    // 多条通知的列表形态：高度由统一布局算法算出（渲染进程算的是同一个数）
    const layout = this.listLayout();
    if (layout) return { width: SIZES.expanded.width, height: layout.height };
    if (this.state.mode === 'expanded') {
      return this.state.active?.kind === 'call'
        ? CALL_SIZE
        : this.state.active?.priority === 'URGENT'
          ? URGENT_SIZE
          : SIZES.expanded;
    }
    if (this.state.mode === 'hidden' && this.appearance.idleSliver) return SLIVER_SIZE;
    return SIZES.pill;
  }

  /**
   * 按当前形态/停靠位置算出岛体目标矩形（窗口内 CSS px），仅作兜底。
   *
   * 定位规则必须与渲染进程的 CSS 完全一致（`islandStyle`）：左/右停靠贴边留 pad，
   * 居中则水平居中；上/下停靠同理。这里用**窗口实际尺寸**而不是 BBOX_SIZE 计算 ——
   * 触摸模式下窗口会贴合岛体，用固定的 BBOX_SIZE 会算出错误偏移。
   */
  private expectedHitRect(): { x: number; y: number; width: number; height: number } {
    const size = this.formSize();
    const pad = ISLAND_SHADOW_PAD;
    const position = this.appearance.position;
    const bounds =
      this.win && !this.win.isDestroyed()
        ? this.win.getBounds()
        : { width: Math.round(BBOX_SIZE.width), height: Math.round(BBOX_SIZE.height) };
    const width = bounds.width;
    const height = bounds.height;
    const x = position.endsWith('left')
      ? pad
      : position.endsWith('right')
        ? width - pad - size.width
        : Math.round((width - size.width) / 2);
    const y = position.startsWith('bottom') ? height - pad - size.height : pad;
    return { x, y, width: size.width, height: size.height };
  }

  /** 本地坐标是否落在岛体矩形内（含 2px 容差） */
  private isInsideHitRect(local: { x: number; y: number } | null): boolean {
    const rect = this.effectiveHitRect();
    if (!local || !rect) return false;
    const margin = 2;
    return (
      local.x >= rect.x - margin &&
      local.x <= rect.x + rect.width + margin &&
      local.y >= rect.y - margin &&
      local.y <= rect.y + rect.height + margin
    );
  }

  /**
   * 指针当前是否落在岛体（卡片）上。
   *
   * 用途：区分"用户点了屏幕别处"和"展开自身引发的激活抖动" —— 两者都会让窗口失焦，
   * 但只有前者会把指针留在岛外。岛是置顶窗口，用户点到岛上时点击必然落在岛上，
   * 因此"指针还在岛上却收到 blur"一定是系统/程序造成的假失焦，此时绝不能收起
   * （否则表现为「点了没反应 / 点开又立刻缩回胶囊」）。
   */
  private isCursorOnIsland(): boolean {
    if (!this.win || this.win.isDestroyed() || !this.win.isVisible()) return false;
    return this.isInsideHitRect(this.cursorLocal());
  }

  /** 按光标位置校正命中（不依赖渲染进程是否收到 mousemove） */
  private syncHitFromCursor(cursor?: { x: number; y: number } | null): void {
    if (!this.win || this.win.isDestroyed() || !this.win.isVisible()) {
      this.setInteractive(false, '窗口不可见');
      return;
    }
    // 完全隐藏（含淡出过程中）：一律不再接收鼠标，避免窗口在消失的几百毫秒里吞掉桌面点击。
    // 空闲细缝态（idleSliver）是"可见即可点"，不走这条。
    if (this.state.mode === 'hidden' && !this.appearance.idleSliver) {
      this.setInteractive(false, '隐藏态');
      return;
    }
    this.setInteractive(this.isInsideHitRect(this.cursorLocal(cursor)), '光标轮询');
  }

  private startHitPoll(): void {
    if (this.hitTimer) return;
    // 60ms：渲染进程的 mousemove 转发在 Windows 上并不可靠，这里是命中的**权威来源**，
    // 间隔必须足够小，否则"指针移上胶囊后立刻点击"会因窗口还没接收鼠标而点空（用户反馈过）。
    //
    // 每一跳的成本要压到最低（这个定时器从岛初始化一直跑到进程退出）：
    // 1) 光标位置**每跳只读一次**，命中判定与"跟随鼠标屏幕"共用 —— 原先 cursorLocal() 与
    //    targetDisplay() 各读一次，等于每跳两次 `screen.getCursorScreenPoint()`；
    // 2) 窗口不可见时直接返回：此时命中判定与心跳检查本来就各自早退（窗口不可见 ⇒ 无命中可言），
    //    留着那两次系统调用纯属白跑。
    this.hitTimer = setInterval(() => {
      if (!this.win || this.win.isDestroyed()) return;
      const visible = this.win.isVisible();
      // 不可见、且不跟随鼠标屏幕时，连读光标都可省掉（targetDisplay 会走主屏分支）
      const cursor =
        visible || this.appearance.followCursorDisplay
          ? (this.cursorOverride ?? screen.getCursorScreenPoint())
          : null;

      // 先按目标屏幕校正窗口位置（换屏/插拔显示器），再算命中与心跳：
      // 顺序不能反，否则命中判定会用上一块屏的窗口坐标
      this.syncAnchorDisplay(cursor);
      if (!visible) return;

      this.syncHitFromCursor(cursor);
      this.checkRendererAlive();
    }, 60);
    // 定时器不应拖住进程退出
    this.hitTimer.unref?.();
  }

  private stopHitPoll(): void {
    if (!this.hitTimer) return;
    clearInterval(this.hitTimer);
    this.hitTimer = null;
  }

  /** 渲染进程心跳（渲染进程每隔几秒上报一次） */
  noteRendererAlive(): void {
    this.lastAliveAt = Date.now();
  }

  /**
   * 心跳检查：岛可见（非隐藏态）却长时间收不到渲染进程心跳 → 判定渲染进程卡死，
   * 隐藏死窗口并重建。这是"幽灵胶囊（看着在、点不动）"的兜底自愈。
   */
  private checkRendererAlive(): void {
    if (!this.win || this.win.isDestroyed() || !this.win.isVisible()) return;
    if (this.state.mode === 'hidden' && !this.appearance.idleSliver) return;
    if (Date.now() - this.lastAliveAt <= RENDERER_ALIVE_TIMEOUT_MS) return;
    logger.error(
      `灵动岛渲染进程超过 ${Math.round(RENDERER_ALIVE_TIMEOUT_MS / 1000)}s 没有心跳（疑似卡死），重建窗口`,
    );
    this.lastAliveAt = Date.now(); // 先重置，避免 60ms 轮询里重复触发
    this.recoverWindow('心跳超时');
  }

  /**
   * 重建灵动岛窗口（渲染进程崩溃/卡死后的自愈）。
   *
   * 关键：先把**窗口隐藏**，否则 Windows 会保留最后一帧 —— 用户看到"岛还挂在屏幕上，
   * 但怎么点都没反应"。随后销毁旧窗口并重新 init（状态与外观会重新下发）。
   * 限流：10 分钟内最多重建 RECOVER_MAX_TIMES 次，超出则暂停并隐藏，避免无限重建。
   */
  private recoverWindow(reason: string): void {
    if (this.recovering) return;
    const now = Date.now();
    this.recoverAt = this.recoverAt.filter((at) => now - at < RECOVER_WINDOW_MS);
    if (this.recoverAt.length >= RECOVER_MAX_TIMES) {
      logger.error(`灵动岛已连续重建 ${RECOVER_MAX_TIMES} 次（${reason}），暂停自动恢复并隐藏窗口`);
      this.hideImmediately();
      return;
    }
    this.recoverAt.push(now);
    this.recovering = true;
    // 1) 立刻隐藏死窗口：不然屏幕上会留一帧"点不动的幽灵胶囊"
    try {
      this.setInteractive(false, '重建窗口');
      this.win?.hide();
    } catch {
      // 忽略：窗口可能已销毁
    }
    // 2) 销毁旧窗口并重建
    const old = this.win;
    this.win = null;
    this.ready = false;
    try {
      if (old && !old.isDestroyed()) old.destroy();
    } catch {
      // 忽略
    }
    void this.init(this.rendererUrl)
      .then(() => {
        // 新窗口是 show:false 创建的，必须按当前状态同步一次可见性/命中
        this.syncWindow();
        logger.info(`灵动岛窗口已重建（${reason}），状态与外观已重新下发`);
      })
      .catch((error) => {
        logger.error(`灵动岛窗口重建失败：${(error as Error).message}`);
      })
      .finally(() => {
        this.recovering = false;
      });
  }

  /** 当前是否在重建窗口（供冒烟验证） */
  isRecovering(): boolean {
    return this.recovering;
  }

  /** 当前是否接收鼠标（供冒烟验证） */
  /** 诊断/冒烟用：开关"失焦自动收起" */
  setBlurCollapseEnabled(enabled: boolean): void {
    this.blurCollapseEnabled = enabled;
  }

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
  /**
   * 夹紧数值：**非法值回落到该字段的默认值**，而不是变成 NaN。
   *
   * 注意 `Math.max(min, NaN)` 仍是 NaN、`Math.min(max, NaN)` 也是 NaN —— 也就是说"只夹紧"
   * 并不能防住 NaN。而 `setAppearance()` 的入参来自 IPC（`island:set-appearance` 只判了 `if (patch)`），
   * 渲染进程传一个显式 `undefined` 字段就会得到 NaN，随后 `setOpacity(NaN)` / `setBounds({x:NaN})`
   * 抛异常；它在非 async 的 ipcMain 监听里抛出，主进程没有兜底，会直接崩掉
   * （连带托盘、灵动岛、实时连接一起消失）。因此这里补上 fallback。
   */
  const clamp = (value: number, min: number, max: number, fallback: number): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.round(value * 100) / 100));
  };
  const fallbackOf = DEFAULT_ISLAND_APPEARANCE;
  return {
    height: clamp(input.height, 36, 72, fallbackOf.height),
    width: clamp(input.width, 220, 420, fallbackOf.width),
    radius: clamp(input.radius, 8, 32, fallbackOf.radius),
    opacity: clamp(input.opacity, 0.4, 1, fallbackOf.opacity),
    accent: /^#[0-9a-fA-F]{6}$/.test(input.accent) ? input.accent : DEFAULT_ISLAND_APPEARANCE.accent,
    fontSize: clamp(input.fontSize, 11, 20, fallbackOf.fontSize),
    animations: input.animations !== false,
    speed: clamp(input.speed, 0.5, 2, fallbackOf.speed),
    position: ISLAND_POSITIONS.includes(input.position) ? input.position : 'top-center',
    alwaysOnTop: input.alwaysOnTop !== false,
    style: ISLAND_STYLES.includes(input.style) ? input.style : 'black',
    idleSliver: input.idleSliver === true,
    // 边距：0 表示贴着屏幕边缘，上限给到 200/160 是为了"多显示器 + 任务栏在侧面"这类布局
    marginX: clamp(input.marginX ?? DEFAULT_ISLAND_APPEARANCE.marginX, 0, 200, fallbackOf.marginX),
    marginY: clamp(input.marginY ?? DEFAULT_ISLAND_APPEARANCE.marginY, 0, 160, fallbackOf.marginY),
    followCursorDisplay: input.followCursorDisplay === true,
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

/**
 * 触摸屏上的失焦宽限期（触摸模式专用，见 `touchMode`）。
 *
 * 触摸没有光标，`isCursorOnIsland()` 这条"指针还在岛上就判定为激活抖动"的兜底恒为 false，
 * 只剩宽限期这一层防线。而实测的假失焦出现在 focus 之后 70~520ms，正好跨过 500ms 的边界，
 * 不放开的话手指点开后会偶发地立刻缩回胶囊。取 1200ms 给它 2 倍余量；
 * 真正的"点屏幕别处收起"仍会在 1.2s 后生效。
 */
const BLUR_GRACE_TOUCH_MS = 1200;

/** 设置页"预览效果"的示例岛停留时长（到点自动收尾，避免一直挂在桌面上） */
const PREVIEW_DURATION_MS = 30_000;

/**
 * 展开卡可用高度的下限（CSS px）：屏幕再矮也要留出这么多，
 * 否则"列表能放几行"会算出负数。真正的工作区空间由 `refreshViewport` 算，这里只是防呆。
 */
const MIN_CARD_HEIGHT = 120;


/**
 * 渲染进程心跳（渲染进程每 5s 上报一次，间隔写死在 `src/island/IslandApp.vue`）：
 * 超过这个时间没上报就认为它已经卡死/不响应。
 * 岛是"无边框透明置顶窗口"，渲染进程一旦挂掉，Windows 会把**最后一帧留在屏幕上**
 * 形成"幽灵胶囊"：窗口还在、看着正常，但怎么点都没反应（实测复现：崩掉渲染进程后
 * 点击完全不产生任何动作）。所以必须有心跳 + 重建来兜底。
 */
const RENDERER_ALIVE_TIMEOUT_MS = 20_000;
/** 窗口重建限流：一段时间内最多重建几次，避免持续崩坏时无限重建 */
const RECOVER_MAX_TIMES = 3;
const RECOVER_WINDOW_MS = 10 * 60_000;

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

  // 渲染进程心跳：用于发现"幽灵窗口"（渲染进程卡死但窗口还留在屏幕上，点了没反应）
  ipcMain.on('island:alive', () => {
    island.noteRendererAlive();
  });

  ipcMain.handle('island:get-state', () => island.getState());

  ipcMain.on('island:set-appearance', (_event, patch: Partial<IslandAppearance>) => {
    if (patch) island.setAppearance(patch);
  });

  ipcMain.handle('island:get-appearance', () => island.getAppearance());

  // 渲染进程命中测试结果 → **只用于立刻打开命中**（比 60ms 轮询更快）。
  // 关闭命中一律由主进程按真实光标决定：两边都下发 true/false 会互相覆盖，
  // 窗口在"接收/穿透"之间抖动，用户点下去时可能正好穿透（表现为"点了没反应"）。
  ipcMain.on('island:set-interactive', (_event, interactive: boolean) => {
    if (interactive !== true) return;
    island.setInteractive(true, '渲染进程');
  });

  // 渲染进程上报岛体矩形 → 主进程按光标位置做命中兜底（不依赖 mousemove 转发）
  ipcMain.on(
    'island:set-hit-rect',
    (_event, rect: { x: number; y: number; width: number; height: number } | null) => {
      island.setHitRect(rect ?? null);
    },
  );

  // 触摸屏上报（渲染进程按 navigator.maxTouchPoints 判定）→ 窗口改为贴合岛体并始终接收输入。
  // 触摸屏上按光标判定命中的那套永远打不开命中，手指点不到岛（详见 IslandController.touchMode）。
  ipcMain.on('island:set-touch-mode', (_event, enabled: boolean) => {
    island.setTouchMode(enabled === true);
  });

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
