/**
 * 主进程与渲染进程之间的桥接契约（preload 通过 contextBridge 暴露）。
 * 渲染进程只依赖这些最小 API，不接触 Node.js。
 */
import type { IslandAppearance, IslandNotification, IslandState } from '@classhelper/shared';

/** 作业页展示偏好（看板 / 列表，看板外观） */
export interface HomeworkBoardSettings {
  /** 展示模式：board = 按科目卡片看板，list = 默认表格 */
  mode: 'board' | 'list';
  /** 看板条目是否显示时间（同时也控制"今日作业看板"标题栏中间的当天时间） */
  showTime: boolean;
  /** 看板字号（px） */
  fontSize: number;
  /** 只看"今天布置"的作业（默认 true，避免昨天的过期作业混进来） */
  todayOnly: boolean;
}

export interface DesktopStoredConfig {
  /** 后端服务地址，例如 http://127.0.0.1:4000 */
  serverUrl: string;
  /** 上次登录的用户名（便于自动填充） */
  username: string;
  /** 登录令牌（主进程用 safeStorage 加密后落盘，读回时自动解密） */
  token: string | null;
  /** 个性化设置：灵动岛外观（高度/宽度/圆角/透明度/主题色/字号/动画/位置/置顶） */
  island: IslandAppearance;
  /** 作业页展示偏好（看板/列表、显示时间、看板字号） */
  homeworkBoard: HomeworkBoardSettings;
}

export interface DesktopAppInfo {
  appVersion: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  userDataPath: string;
  /** 是否处于冒烟验证模式（由 ELECTRON_SMOKE_TEST=1 触发） */
  smokeTest: boolean;
}

/** 投递通知到灵动岛时附带的上下文 */
export interface IslandPushContext {
  /** 当前是否处于上课时间段（上课期间非紧急通知会被暂存，下课后自动弹出） */
  inClass?: boolean;
  /** 当前这节课的结束时间（HH:mm） */
  currentPeriodEnd?: string | null;
  week?: number;
  /** 设置页"预览效果"：直接展开示例岛、失焦不收起、30 秒后自行消失 */
  preview?: boolean;
}

export interface IslandClassStatePayload {
  inClass: boolean;
  currentPeriodEnd?: string | null;
  week?: number;
}

export interface DesktopBridge {
  /** 是否处于冒烟验证模式（由 ELECTRON_SMOKE_TEST=1 触发），同步可读 */
  smokeTest: boolean;
  getConfig(): Promise<DesktopStoredConfig>;
  saveConfig(patch: Partial<DesktopStoredConfig>): Promise<DesktopStoredConfig>;
  clearConfig(): Promise<DesktopStoredConfig>;
  getAppInfo(): Promise<DesktopAppInfo>;
  openExternal(url: string): Promise<boolean>;

  /* 灵动岛 */
  /** 把一条通知投递到灵动岛 */
  islandPush(payload: { notification: IslandNotification; context?: IslandPushContext }): void;
  /** 同步上课状态：进入上课隐藏，下课后自动弹出暂存通知 */
  islandSetClassState(payload: IslandClassStatePayload): void;
  /** 读取灵动岛当前状态（设置页/冒烟验证用） */
  islandGetState(): Promise<IslandState>;
  /** 应用灵动岛外观设置（实时生效） */
  islandSetAppearance(appearance: Partial<IslandAppearance>): void;
  /** 读取当前生效的外观设置 */
  islandGetAppearance(): Promise<IslandAppearance>;
  /** 订阅"灵动岛点了标为已读"事件，用于同步通知中心 */
  onIslandMarkRead(handler: (id: string) => void): void;
}

/** 灵动岛窗口自身的桥接（只暴露订阅状态与发送操作） */
export interface IslandRendererBridge {
  onState(handler: (state: IslandState) => void): void;
  /** 订阅外观设置（CSS 变量实时生效） */
  onAppearance(handler: (appearance: IslandAppearance) => void): void;
  getAppearance(): Promise<IslandAppearance>;
  sendAction(action: 'expand' | 'collapse' | 'dismiss' | 'mark-read' | 'open-app', id?: string): void;
  getState(): Promise<IslandState>;
  /** 命中测试结果：指针是否在岛体上（决定固定大窗口是否接收鼠标） */
  setInteractive(interactive: boolean): void;
  /** 上报岛体矩形（窗口内 CSS px）：主进程据此按光标位置兜底校正命中 */
  setHitRect(rect: { x: number; y: number; width: number; height: number } | null): void;
}

declare global {
  interface Window {
    /** 仅在 Electron 中注入；浏览器里为 undefined（渲染进程做了降级处理） */
    desktop?: DesktopBridge;
    /** 灵动岛窗口专用桥接 */
    island?: IslandRendererBridge;
    /** 冒烟验证钩子，仅在 ELECTRON_SMOKE_TEST=1 时由渲染进程注册 */
    __classhelperSmoke__?: {
      cacheSelfTest(): Promise<{ ok: boolean; detail: string }>;
      offlineScenario(): Promise<{ ok: boolean; detail: string }>;
      layoutNavigationSelfTest(): Promise<{ ok: boolean; detail: string }>;
      onlineScenario(credentials?: {
        code: string;
        password: string;
      }): Promise<{ ok: boolean; detail: string }>;
      /** 真实通知链路：教师发通知给当前学生班级，验证 Socket.IO → 灵动岛 */
      islandRealtimeScenario(): Promise<{
        ok: boolean;
        detail: string;
        notificationId?: string;
        teacherToken?: string;
        title?: string;
        classId?: string;
        inClass?: boolean;
      }>;
      islandRealtimeCleanup(
        notificationId: string,
        teacherToken: string,
      ): Promise<{ ok: boolean; detail: string }>;
      /** 读取某条通知在通知中心里的已读状态（验证灵动岛"标为已读"链路） */
      islandReadState(notificationId: string): Promise<{
        found: boolean;
        read: boolean;
        unreadCount: number;
        title: string;
      }>;
      /** ClassIsland 风格「今天」时间轴自检（造课 → 读 DOM → 清理） */
      scheduleTimelineSelfTest(): Promise<{ ok: boolean; detail: string }>;
      /** 作业看板全屏自适应自检（切看板 → 打开全屏 → 量尺寸） */
      homeworkBoardSelfTest(): Promise<{ ok: boolean; detail: string }>;
      sessionCleanup(): Promise<{ ok: boolean; detail: string }>;
    };
  }
}

export {};
