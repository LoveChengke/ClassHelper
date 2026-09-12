import path from 'node:path';
import { BrowserWindow, app, shell } from 'electron';
import { registerIpcHandlers } from './ipc.js';
import { island, registerIslandIpc } from './island.js';
import { logger } from './logger.js';
import { runSmokeTest } from './smoke.js';

// 主进程由 esbuild 打包为 CommonJS，因此这里可以直接使用 __dirname
// （dist/main/index.js -> dist/preload/index.js 与 dist/renderer/index.html）
const currentDir = __dirname;

const devServerUrl = process.env.VITE_DEV_SERVER_URL;
const isSmokeTest = process.env.ELECTRON_SMOKE_TEST === '1';

let mainWindow: BrowserWindow | null = null;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 980,
    minHeight: 640,
    title: '班级小助手',
    // 冒烟验证时不弹窗，避免打扰使用者
    show: !isSmokeTest,
    autoHideMenuBar: true,
    backgroundColor: '#f5f7fa',
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
    const allowed = devServerUrl ? url.startsWith(devServerUrl) : url.startsWith('file://');
    if (!allowed) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    }
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
    } catch (error) {
      logger.error('灵动岛初始化失败（不影响主功能）', error);
    }

    if (isSmokeTest) {
      try {
        await runSmokeTest(mainWindow);
      } catch (error) {
        console.error('[SMOKE] 冒烟验证异常', error);
        app.exit(1);
      }
    }
  });

  app.on('window-all-closed', () => {
    island.destroy();
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    island.destroy();
  });

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
      await loadRenderer(mainWindow);
    }
  });
}
