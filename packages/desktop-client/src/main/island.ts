import path from 'node:path';
import { BrowserWindow, ipcMain, screen } from 'electron';
import type { IslandMode, IslandNotification, IslandState } from '@classhelper/shared';
import { logger } from './logger.js';

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
 */

const SIZES: Record<IslandMode, { width: number; height: number }> = {
  hidden: { width: 268, height: 44 },
  pill: { width: 268, height: 44 },
  expanded: { width: 404, height: 316 },
};

const URGENT_SIZE = { width: 424, height: 344 };

/** 各状态的自动收起/隐藏时长（毫秒），0 表示不自动收起 */
const TIMEOUTS = {
  pill: 15_000,
  afterClassExpanded: 14_000,
  afterClassPill: 25_000,
  expanded: 20_000,
  urgent: 45_000,
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

  setOpenAppHandler(handler: () => void): void {
    this.openAppHandler = handler;
  }

  async init(rendererUrl: string | null): Promise<void> {
    this.rendererUrl = rendererUrl;
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

    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.setIgnoreMouseEvents(false);
    win.on('closed', () => {
      this.win = null;
      this.ready = false;
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
    // 首次进入时同步一次当前状态，保证渲染进程不会停在初始默认值
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
   * 收到一条通知。
   * - 紧急：立刻展开（无视上课时段）
   * - 上课中：进队列并保持隐藏（下课后由 setClassState 触发弹出）
   * - 其它：显示"新消息"胶囊，等待点击展开
   */
  pushNotification(notification: IslandNotification, context: IslandPushContext = {}): void {
    const inClass = context.inClass ?? this.state.inClass;
    this.state.inClass = inClass;
    if (context.currentPeriodEnd !== undefined)
      this.state.currentPeriodEnd = context.currentPeriodEnd ?? null;

    if (notification.priority === 'URGENT') {
      // 紧急插播：如果正在展示别的通知，把它放回队列
      if (this.state.active && this.state.active.id !== notification.id) {
        this.state.queued.push(this.state.active);
      }
      this.state.queued = this.state.queued.filter((item) => item.id !== notification.id);
      this.activate(notification, 'urgent', 'expanded');
      logger.info(`灵动岛紧急插播：${notification.title}`);
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
      case 'expand':
        if (this.state.active) {
          this.setState({ mode: 'expanded' });
          this.scheduleCollapse(
            this.state.active.priority === 'URGENT' ? TIMEOUTS.urgent : TIMEOUTS.expanded,
          );
        }
        break;
      case 'collapse': {
        const next = this.state.queued[this.state.queued.length - 1];
        if (next) {
          this.setState({ mode: 'pill', reason: this.state.reason });
          this.scheduleCollapse(TIMEOUTS.pill);
        } else {
          this.hide();
        }
        break;
      }
      case 'dismiss':
        this.dismissActive();
        break;
      case 'mark-read': {
        const queue = this.state.queued.filter((item) => item.id !== payload.id);
        this.state.queued = queue;
        if (this.state.active?.id === payload.id) this.state.active = null;
        this.state.updatedAt = Date.now();
        if (this.state.mode === 'hidden') this.emit();
        else this.dismissActive();
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
    this.fadeOut();
    this.setState({ mode: 'hidden', reason: null }, { skipWindow: true });
  }

  destroy(): void {
    this.clearTimers();
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

  private computeBounds(size: { width: number; height: number }): {
    x: number;
    y: number;
    width: number;
    height: number;
  } {
    const area = screen.getPrimaryDisplay().workArea;
    return {
      x: Math.round(area.x + (area.width - size.width) / 2),
      y: area.y + 8,
      width: size.width,
      height: size.height,
    };
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

    if (this.state.mode === 'hidden') {
      this.fadeOut();
      return;
    }

    const size =
      this.state.mode === 'expanded'
        ? this.state.active?.priority === 'URGENT'
          ? URGENT_SIZE
          : SIZES.expanded
        : SIZES.pill;

    if (!this.win.isVisible()) {
      this.win.setOpacity(0);
      this.win.showInactive();
      this.animateBounds(size);
      this.fadeIn();
      return;
    }
    this.animateBounds(size);
  }

  private fadeIn(): void {
    if (!this.win || this.win.isDestroyed()) return;
    const token = ++this.fadeToken;
    let opacity = this.win.getOpacity();
    const step = (): void => {
      if (!this.win || this.win.isDestroyed() || token !== this.fadeToken) return;
      opacity = Math.min(1, opacity + 0.16);
      this.win.setOpacity(opacity);
      if (opacity < 1) setTimeout(step, 16);
    };
    step();
  }

  private fadeOut(): void {
    if (!this.win || this.win.isDestroyed() || !this.win.isVisible()) return;
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

  /** 尺寸/位置缓动：Windows 下没有原生窗口动画，这里按帧插值实现"形变"效果 */
  private animateBounds(size: { width: number; height: number }): void {
    if (!this.win || this.win.isDestroyed()) return;
    const from = this.win.getBounds();
    const to = this.computeBounds(size);
    if (from.width === to.width && from.height === to.height && from.x === to.x && from.y === to.y) return;

    const token = ++this.boundsToken;
    const duration = 260;
    const startedAt = Date.now();

    const step = (): void => {
      if (!this.win || this.win.isDestroyed() || token !== this.boundsToken) return;
      const progress = Math.min(1, (Date.now() - startedAt) / duration);
      const eased = 1 - Math.pow(1 - progress, 3); // easeOutCubic
      const bounds = {
        x: Math.round(from.x + (to.x - from.x) * eased),
        y: Math.round(from.y + (to.y - from.y) * eased),
        width: Math.round(from.width + (to.width - from.width) * eased),
        height: Math.round(from.height + (to.height - from.height) * eased),
      };
      this.win.setBounds(bounds);
      if (progress < 1) setTimeout(step, 12);
    };
    step();
  }
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

  ipcMain.on('island:action', (_event, payload: IslandActionPayload) => {
    if (!payload?.action) return;
    island.handleAction(payload);
  });
}

export { SIZES as ISLAND_SIZES, URGENT_SIZE as ISLAND_URGENT_SIZE };
