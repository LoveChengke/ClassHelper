import fs from 'node:fs';
import path from 'node:path';
import { Menu, Tray, app, nativeImage } from 'electron';
import { logger } from './logger.js';

/**
 * 系统托盘（需求 5）：关闭主窗口不退出程序，而是隐藏到托盘后台运行；
 * 托盘图标可恢复窗口，并提供"退出"入口（退出前统一清理资源）。
 */
let tray: Tray | null = null;

export interface TrayHandlers {
  onShow(): void;
  onHide(): void;
  onQuit(): void;
}

/** 托盘图标：优先用打包进 dist/renderer 的 tray.png，其次资源目录 */
function resolveTrayIcon(): string | null {
  const candidates = [
    path.join(__dirname, '../renderer/tray.png'),
    path.join(process.resourcesPath ?? '', 'tray.png'),
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function createTray(handlers: TrayHandlers): Tray | null {
  if (tray && !tray.isDestroyed()) return tray;

  const iconPath = resolveTrayIcon();
  const image = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  tray = new Tray(image);

  tray.setToolTip('班级小助手（后台运行中）');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => handlers.onShow() },
      { label: '隐藏到托盘', click: () => handlers.onHide() },
      { type: 'separator' },
      { label: '退出班级小助手', click: () => handlers.onQuit() },
    ]),
  );
  // 左键单击/双击托盘图标：恢复窗口（用户习惯）
  tray.on('click', () => handlers.onShow());
  tray.on('double-click', () => handlers.onShow());

  logger.info(iconPath ? `系统托盘已就绪：${iconPath}` : '系统托盘已就绪（未找到图标文件，使用空图标）');
  return tray;
}

export function destroyTray(): void {
  if (!tray) return;
  try {
    tray.destroy();
  } catch {
    /* 忽略销毁异常 */
  }
  tray = null;
  logger.info('系统托盘已销毁');
}

export function isTrayReady(): boolean {
  return Boolean(tray && !tray.isDestroyed());
}

/** 供"关于/设置"展示（也可用于冒烟断言） */
export function getTrayState(): { ready: boolean; hasIcon: boolean; appPath: string } {
  return {
    ready: isTrayReady(),
    hasIcon: Boolean(resolveTrayIcon()),
    appPath: app.getPath('exe'),
  };
}
