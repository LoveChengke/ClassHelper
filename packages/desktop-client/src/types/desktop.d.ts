/**
 * 主进程与渲染进程之间的桥接契约（preload 通过 contextBridge 暴露）。
 * 渲染进程只依赖这些最小 API，不接触 Node.js。
 */
import type {
  ClassIslandNotificationChannel,
  IslandAppearance,
  IslandNotification,
  IslandState,
  UpdateInfo,
} from '@classhelper/shared';

/** 作业页展示偏好（看板 / 列表，看板外观） */
export interface HomeworkBoardSettings {
  /** 展示模式：board = 按科目卡片看板，list = 默认表格 */
  mode: 'board' | 'list';
  /** 看板条目是否显示时间（同时也控制"今日作业看板"标题栏中间的当天时间） */
  showTime: boolean;
  /** 看板字号（px） */
  fontSize: number;
  /**
   * @deprecated 已由「按天查看 + 日期选择器」取代（作业页不再有"只看今天"开关）。
   * 保留字段只为兼容旧配置文件，读写都忽略它。
   */
  todayOnly?: boolean;
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
  /**
   * 作业录入的快捷短语（客户端「设置 → 作业录入」里增删，默认见 shared 的 HOMEWORK_PHRASE_DEFAULTS）。
   * 录入作业时点一下就追加到标题/内容里，少打字（例如 P、大本、背诵）。
   */
  homeworkPhrases: string[];
  /**
   * 通知显示位置（both / client / classisland）。
   *
   * 这台教室机器"提醒到底弹在哪个端"由它决定：值同时存本地（决定本机要不要弹窗/上岛）
   * 与班级记录（服务端据此决定要不要推给 ClassIsland）。
   */
  notificationChannel: ClassIslandNotificationChannel;
  /**
   * 是否已看过「初次启动引导」。
   *
   * 首次启动自动弹出一次（完成或跳过即记为看过并写入配置，之后不再自动弹出）；
   * 登录页与设置页的「使用引导」入口可随时重看（重看不改变该值）。
   */
  onboardingDone: boolean;
  /** 界面主题：light=浅色（默认）/ dark=深色（黑夜模式） */
  theme: 'light' | 'dark';
  /** 主侧边栏是否折叠成图标栏（可由顶栏汉堡按钮切换） */
  sidebarCollapsed: boolean;
  /**
   * 用户点过「忽略此版本」的版本号（空串 = 没忽略过）。
   *
   * 启动时的自动检查会跳过这个版本，避免每次开客户端都弹一次同样的提示；
   * 在「关于」页手动检查时仍会正常显示结果。
   */
  ignoredUpdateVersion: string;
}

export interface DesktopAppInfo {
  appVersion: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  userDataPath: string;
  /** 主进程配置文件（config.json）的绝对路径（关于页「诊断信息」展示） */
  configPath: string;
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
  /**
   * 冒烟凭据（仅冒烟模式下发，否则 `undefined`）。
   *
   * 为什么要从环境变量绕一圈：这些凭据被渲染进程的冒烟钩子用来"造测试数据"，
   * 而渲染产物（`dist/renderer/assets/*.js`）会进 `app.asar` 发给每台学生机 —— asar 可直接解包，
   * 把账号口令写在代码里等于随安装包一起发出去。凭据只由
   * `scripts/smoke.mjs` / `scripts/verify-packaged.mjs` 通过环境变量提供（这两个脚本不进安装包）。
   */
  smokeCredentials?: {
    username: string;
    password: string;
    classCode: string;
    classPassword: string;
  };
  getConfig(): Promise<DesktopStoredConfig>;
  /**
   * 局部更新配置。
   *
   * **必须传纯数据（普通对象 / 基本类型）**：传 Vue 的 `ref.value` / `reactive()` 对象
   * 会在 contextBridge 跨隔离世界时被结构化克隆拒绝，抛
   * `Error: An object could not be cloned.`，而且调用点看起来"只是没生效"。
   * 页面里请写成 `saveConfig({ island: { ...island.value } })` 这种展开后的字面量。
   */
  saveConfig(patch: Partial<DesktopStoredConfig>): Promise<DesktopStoredConfig>;
  clearConfig(): Promise<DesktopStoredConfig>;
  getAppInfo(): Promise<DesktopAppInfo>;
  openExternal(url: string): Promise<boolean>;

  /* 更新检查 */
  /**
   * 检查 GitHub 上有没有新版本（主进程直连，不经后端）。
   *
   * @param force true = 绕过主进程缓存（对应「关于」页里用户主动点的那次检查）
   *
   * 返回的 `ok:false` 是**正常结果**（教室机器没有外网 / GitHub 限流 / 超时），不是异常，
   * 界面按"暂时查不到更新"呈现即可。
   */
  checkForUpdates(force?: boolean): Promise<UpdateInfo>;
  /** 忽略某个版本的更新提示（写入 config.json，启动自动检查不再提示它） */
  ignoreUpdateVersion(version: string): Promise<void>;
  /** 订阅"启动自动检查发现新版本"（仅新版本且未被忽略时触发一次） */
  onUpdateAvailable(handler: (info: UpdateInfo) => void): void;

  /* 灵动岛 */
  /** 把一条通知投递到灵动岛（payload 必须是纯数据，说明见 saveConfig） */
  islandPush(payload: { notification: IslandNotification; context?: IslandPushContext }): void;
  /** 同步上课状态：进入上课隐藏，下课后自动弹出暂存通知 */
  islandSetClassState(payload: IslandClassStatePayload): void;
  /** 读取灵动岛当前状态（设置页/冒烟验证用） */
  islandGetState(): Promise<IslandState>;
  /**
   * 应用灵动岛外观设置（实时生效）。
   *
   * 同 saveConfig：**必须是纯数据**。设置页曾把 `island`（`ref`）的响应式 Proxy 直接传进来，
   * 结果 contextBridge 抛 `An object could not be cloned.`，主进程收不到任何东西 ——
   * 现象就是"拖了滑块、数字在变，灵动岛毫无反应，保存也不生效"。
   */
  islandSetAppearance(appearance: Partial<IslandAppearance>): void;
  /** 读取当前生效的外观设置 */
  islandGetAppearance(): Promise<IslandAppearance>;
  /** 订阅"灵动岛点了标为已读"事件，用于同步通知中心 */
  onIslandMarkRead(handler: (id: string) => void): void;
  /** 订阅"灵动岛点了标为已读（多条通知的整批）"，一次把这一批都标记已读 */
  onIslandMarkAllRead(handler: (ids: string[]) => void): void;
}

/** 灵动岛窗口自身的桥接（只暴露订阅状态与发送操作） */
export interface IslandRendererBridge {
  onState(handler: (state: IslandState) => void): void;
  /** 订阅外观设置（CSS 变量实时生效） */
  onAppearance(handler: (appearance: IslandAppearance) => void): void;
  getAppearance(): Promise<IslandAppearance>;
  sendAction(
    action:
      | 'expand'
      | 'expand-list'
      | 'collapse'
      | 'dismiss'
      | 'dismiss-all'
      | 'mark-read'
      | 'mark-all-read'
      | 'open-app',
    id?: string,
  ): void;
  getState(): Promise<IslandState>;
  /**
   * 命中提示：指针在岛体上时应让固定大窗口接收鼠标（比主进程 60ms 轮询更快）。
   * **只会上报 true**：关闭命中（穿透）一律由主进程按真实光标决定，
   * 两边都下发会让窗口在"接收/穿透"之间抖动（用户反馈的"点了没反应"）。
   */
  setInteractive(interactive: boolean): void;
  /** 上报岛体矩形（窗口内 CSS px）：主进程据此按光标位置兜底校正命中 */
  setHitRect(rect: { x: number; y: number; width: number; height: number } | null): void;
  /**
   * 上报"本机是触摸屏"（`navigator.maxTouchPoints > 0`）：主进程据此让窗口贴合岛体并始终接收
   * 输入，否则触摸屏上手指永远点不到岛（触摸不产生 mousemove、也不移动系统光标）。
   */
  setTouchMode(enabled: boolean): void;
  /** 心跳：主进程据此发现"渲染进程卡死的幽灵窗口"（岛还在屏幕上但点不动）并重建窗口 */
  alive(): void;
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
      /** 本机录入的作业不上灵动岛自检（内容指纹 + id 双重判定） */
      islandHomeworkSuppressionCheck(): Promise<{ ok: boolean; detail: string }>;
      /** 初次启动引导自检（首启自动出现 → 真实点击走完 → 完成状态写入配置） */
      onboardingSelfTest(): Promise<{ ok: boolean; detail: string }>;
      /** 主界面外观件自检（真实点击：主题切换 html.dark + 落盘、侧边栏折叠 + 落盘） */
      layoutChromeSelfTest(): Promise<{ ok: boolean; detail: string }>;
      /** 关于页自检（/settings/about 渲染 + getAppInfo 含 configPath） */
      aboutPageSelfTest(): Promise<{ ok: boolean; detail: string }>;
      sessionCleanup(): Promise<{ ok: boolean; detail: string }>;
    };
  }
}

export {};
