import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrowserWindow, app, shell } from 'electron';
import { flushConfigSync, getConfig } from './config.js';
import { registerIpcHandlers } from './ipc.js';
import { island, registerIslandIpc } from './island.js';
import { logger } from './logger.js';
import { runSmokeTest } from './smoke.js';
import { createTray, destroyTray, isTrayReady } from './tray.js';
import { scheduleStartupUpdateCheck } from './update.js';

// 主进程由 esbuild 打包为 CommonJS，因此这里可以直接使用 __dirname
// （dist/main/index.js -> dist/preload/index.js 与 dist/renderer/index.html）
const currentDir = __dirname;

const devServerUrl = process.env.VITE_DEV_SERVER_URL;
const isSmokeTest = process.env.ELECTRON_SMOKE_TEST === '1';

// 自动化验证使用独立的 userData：否则用户正在运行的客户端会占着单实例锁，
// 冒烟进程会"静默退出（退出码 0、无输出）"，看起来像构建坏了。
const smokeProfile = process.env.ELECTRON_SMOKE_PROFILE;
if (smokeProfile) app.setPath('userData', smokeProfile);

let mainWindow: BrowserWindow | null = null;

/** 是否正在退出：用于区分「关闭窗口 = 隐藏到托盘」与「真正退出」 */
let isQuitting = false;

/** 生产环境下主窗口加载的本页地址（用于导航白名单的精确比对） */
const prodRendererUrl = pathToFileURL(path.join(currentDir, '../renderer/index.html')).href;

/**
 * 是否允许窗口导航到这个地址。
 *
 * 为什么不能用 `url.startsWith(...)`：
 * - 开发态 `url.startsWith(devServerUrl)` 没有主机边界，`http://localhost:5174.evil.com` 也会被放行；
 * - 生产态 `url.startsWith('file://')` 等于放行**任意本地页面**。
 * 而 preload 是挂在窗口上的（不是挂在 URL 上）：一旦窗口被导航到别处，那个页面照样持有
 * `window.desktop`（含 `getConfig` 返回的明文 token）。因此这里按"精确同源 / 精确同一文件"比对。
 */
function isAllowedNavigation(url: string): boolean {
  try {
    const target = new URL(url);
    if (devServerUrl) return target.origin === new URL(devServerUrl).origin;
    target.hash = '';
    target.search = '';
    return target.href === prodRendererUrl;
  } catch {
    return false;
  }
}

function createWindow(): BrowserWindow {
  // 启动底色跟主题走：深色主题下若仍用浅色底，窗口先白后黑会"闪一下"
  const theme = getConfig().theme;
  const win = new BrowserWindow({
    // 初始尺寸与 ClassIsland 主窗口对齐（实测其可视区 1242x582），保持同一观感
    width: 1242,
    height: 582,
    minWidth: 1000,
    minHeight: 540,
    center: true,
    title: '班级小助手',
    // 冒烟验证时不弹窗，避免打扰使用者
    show: !isSmokeTest,
    autoHideMenuBar: true,
    backgroundColor: theme === 'dark' ? '#161719' : '#f3f3f3',
    webPreferences: {
      preload: path.join(currentDir, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  // 外部链接交给系统浏览器，禁止在应用内新开窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isAllowedNavigation(url)) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    logger.warn(`主窗口拒绝了页面导航：${url}`);
  });

  win.on('closed', () => {
    mainWindow = null;
  });

  return win;
}

async function loadRenderer(win: BrowserWindow): Promise<void> {
  if (devServerUrl) {
    await win.loadURL(devServerUrl);
    win.webContents.openDevTools({ mode: 'detach' });
    return;
  }
  // 生产：加载打包后的本地 HTML（vite base 为 './'，使用 file:// 相对路径）
  await win.loadFile(path.join(currentDir, '../renderer/index.html'));
}

// 单实例：重复启动时聚焦已有窗口
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    registerIpcHandlers();
    registerIslandIpc();

    mainWindow = createWindow();
    await loadRenderer(mainWindow);

    // 灵动岛：独立的置顶透明小窗口（桌面中上方）
    try {
      await island.init(devServerUrl ? `${devServerUrl.replace(/\/+$/, '')}/island.html` : null);
      // 点击灵动岛里的"打开应用"时把主窗口拉到前台
      island.setOpenAppHandler(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      });
      // 灵动岛点"标为已读"：转交主窗口渲染进程调用接口并刷新通知中心
      island.setMarkReadHandler((id) => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        mainWindow.webContents.send('island:mark-read', id);
      });
      // 多条通知时的"标为已读"是**整批**操作：一次把列表里的通知都标上
      island.setMarkAllReadHandler((ids) => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        mainWindow.webContents.send('island:mark-all-read', ids);
      });
    } catch (error) {
      logger.error('灵动岛初始化失败（不影响主功能）', error);
    }

    // 关闭主窗口 → 隐藏到系统托盘（需求 5），只有托盘"退出"才真正结束进程
    // 注意：必须在冒烟验证之前挂载，否则 close() 会真的销毁窗口
    mainWindow?.on('close', (event) => {
      if (isQuitting) return;
      event.preventDefault();
      mainWindow?.hide();
      logger.info('主窗口已隐藏到系统托盘（后台继续运行，左键托盘图标可恢复）');
    });

    try {
      createTray({
        onShow: () => showMainWindow(),
        onHide: () => mainWindow?.hide(),
        onQuit: () => quitApp(),
      });
    } catch (error) {
      logger.warn(`系统托盘初始化失败（不影响主功能）：${error instanceof Error ? error.message : error}`);
    }

    // 启动后自动查一次更新（延迟几秒，不跟首屏抢带宽）；冒烟模式下自动跳过，见 main/update.ts
    scheduleStartupUpdateCheck(() => mainWindow);

    if (isSmokeTest) {
      try {
        await runSmokeTest(mainWindow);
      } catch (error) {
        console.error('[SMOKE] 冒烟验证异常', error);
        app.exit(1);
      }
    }
  });

  /** 显示主窗口（托盘左键 / 托盘菜单 / 二次启动） */
  function showMainWindow(): void {
    if (!mainWindow || mainWindow.isDestroyed()) {
      mainWindow = createWindow();
      void loadRenderer(mainWindow);
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }

  /**
   * 退出前的统一资源清理（需求 5：托盘 / 定时器 / 网络连接 / 窗口都不留残留）。
   * 幂等：托盘退出、before-quit、will-quit 都可能触发。
   */
  function shutdownResources(): string {
    const done: string[] = [];
    // 配置是**异步合并写**的（见 main/config.ts）：退出前必须同步落地一次，
    // 否则"刚改完设置就退出"这一类操作会丢掉最后一次改动。
    // 放在最前面：后面会销毁窗口与灵动岛，先落盘不依赖任何窗口是否还在。
    flushConfigSync();
    done.push('配置已落盘');
    if (isTrayReady()) {
      destroyTray();
      done.push('托盘已销毁');
    }
    if (island.isReady()) {
      island.destroy();
      done.push('灵动岛已销毁');
    }
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        // 渲染进程随之结束：其中的 Socket.IO 连接、定时器、IndexedDB 句柄一并释放
        win.destroy();
        done.push('窗口已销毁');
      }
    }
    return done.length > 0 ? done.join('、') : '无需要清理的资源';
  }

  /** 真正退出：先清理资源，再 app.quit，并用 app.exit 兜底（确保不留进程） */
  function quitApp(): void {
    if (isQuitting) return;
    isQuitting = true;
    logger.info(`正在退出：${shutdownResources()}`);
    app.quit();
    setTimeout(() => app.exit(0), 1500);
  }

  app.on('window-all-closed', () => {
    // 有托盘常驻：窗口全关也不退出，继续后台接收通知
    logger.info('所有窗口已关闭，程序继续在系统托盘后台运行');
  });

  app.on('before-quit', () => {
    isQuitting = true;
    shutdownResources();
  });

  app.on('will-quit', () => {
    const summary = shutdownResources();
    logger.info(`应用退出清理：${summary}`);
  });

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
      await loadRenderer(mainWindow);
    }
  });
}
