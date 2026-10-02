import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, desktopCapturer, screen } from 'electron';
import type { NativeImage } from 'electron';
import type { IslandAppearance, IslandNotification } from '@classhelper/shared';
import { ISLAND_SHADOW_PAD, islandListLayout } from '@classhelper/shared';
import { getConfig, saveConfig } from './config.js';
import { getDiagnostics } from './ipc.js';
import {
  getSliverSize,
  island,
  ISLAND_CALL_SIZE,
  ISLAND_SIZES,
  ISLAND_TIMEOUTS,
  ISLAND_URGENT_SIZE,
} from './island.js';
import { destroyTray, getTrayState, isTrayReady } from './tray.js';

interface SmokeResult {
  name: string;
  ok: boolean;
  detail: string;
}

type Recorder = (name: string, ok: boolean, detail?: string) => void;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 排空灵动岛（正在展示的 + 队列里的全关掉）。
 *
 * 为什么值得单独一个函数：**多条待处理通知会走"竖排列表"形态**，比单条详情卡高得多，
 * 于是"单条通知的详情卡 / 紧急卡 / 叫人卡"这类用例必须在干净的空闲态下推送才有意义
 * （否则量到的尺寸是列表的高度，断言会莫名其妙地红）。
 */
async function drainIsland(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    const current = island.getState();
    if (!current.active && current.queued.length === 0) return;
    island.handleAction({ action: 'dismiss' });
    await sleep(120);
  }
}

/** 当前"未处理"的通知条数（与主进程/渲染进程同一口径：正在展示的 + 队列，按 id 去重） */
function pendingCountOf(state: ReturnType<typeof island.getState>): number {
  const ids = new Set<string>();
  if (state.active) ids.add(state.active.id);
  for (const item of state.queued) ids.add(item.id);
  return ids.size;
}

/** 岛当前形态应有的高度（多条通知时是列表布局算出来的高度，与渲染进程同一个算法） */
function expectedListHeight(state: ReturnType<typeof island.getState>): number {
  const layout = islandListLayout({
    count: pendingCountOf(state),
    fontSize: island.getAppearance().fontSize,
    maxHeight: state.maxCardHeight,
    expanded: state.listExpanded,
  });
  return layout.height;
}

/** 灵动岛每种形态的截图像素统计（用于"截图像素级留档"断言） */
/** 岛几何：固定包围盒窗口 + 岛的真实矩形 + 形状路径尺寸 */
interface IslandGeometry {
  window: { x: number; y: number; width: number; height: number };
  island: IslandRect;
}

/** 岛在屏幕上的矩形（固定包围盒窗口内形变 → 断言都量这个） */
interface IslandRect {
  x: number;
  y: number;
  width: number;
  height: number;
  radius?: number;
  pathWidth?: number;
  pathHeight?: number;
  /** 形状路径绕行总角度（凸、不自交时 |winding| ≈ 2π） */
  winding?: number;
  /** 绕行单调性：角的采样参数写反时会在角上“往回折”，这里会变 false */
  windingOk?: boolean;
}

interface IslandShotStats {
  name: string;
  /** 期望的窗口逻辑尺寸（CSS 像素） */
  expected: { width: number; height: number };
  /** 实际截图像素尺寸（受 DPI 缩放影响，通常是逻辑尺寸的整数倍） */
  width: number;
  height: number;
  opaque: number;
  transparent: number;
  uniqueColors: number;
  /** 平均亮度（0~255） */
  luminance: number;
  /** 偏红像素数（紧急形态的红色描边/角标/内部光晕） */
  reddish: number;
  /** 图像最外圈（2px）的偏红像素数：必须为 0，用于守住"卡片外不允许有光晕外溢" */
  edgeReddish: number;
  /** 岛矩形之外的偏红像素（窗口留白区，紧急光晕不外溢的断言依据） */
  outsideReddish?: number;
  /**
   * `.shape path` 的计算 filter（投影）。
   *
   * 断言它是**常驻**的：形态切换只能改参数，不能把 filter 加/去掉 —— 增删 CSS filter 会让
   * Chromium 重建元素的渲染表面，首帧栅格化未完成时卡片底座会空掉一帧（用户反馈的
   * "开合时一瞬间的闪动"）。见 IslandApp.vue 里 `.shape path` 的注释。
   */
  shapeFilter?: string;
  filePath: string;
  /** 四角圆角几何检查：四个角的边界步进必须一致（抓“角缺一块 / 角画反”） */
  corners?: { steps: number[]; expectedInset: number; spread: number; limit: number };
}

const islandShots: IslandShotStats[] = [];

/** 统计截图位图：不透明像素、颜色种类、偏红像素（Electron 位图格式为 BGRA） */
function analyzeBitmap(image: NativeImage): {
  opaque: number;
  transparent: number;
  uniqueColors: number;
  reddish: number;
  edgeReddish: number;
  /** 整张图的平均亮度（0~255）：用来抓「卡片底色发白」这类问题 */
  luminance: number;
  /** 岛矩形之外的偏红像素（窗口留白区，紧急光晕不外溢的断言依据） */
  outsideReddish?: number;
} {
  const bitmap = image.toBitmap();
  const { width, height } = image.getSize();
  const total = Math.floor(bitmap.length / 4);
  let opaque = 0;
  let transparent = 0;
  let reddish = 0;
  let edgeReddish = 0;
  let luminanceSum = 0;
  const colors = new Set<number>();

  for (let index = 0; index < total; index += 1) {
    const offset = index * 4;
    const blue = bitmap[offset] ?? 0;
    const green = bitmap[offset + 1] ?? 0;
    const red = bitmap[offset + 2] ?? 0;
    const alpha = bitmap[offset + 3] ?? 0;

    if (alpha === 0) {
      transparent += 1;
      continue;
    }
    opaque += 1;
    luminanceSum += 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    if (colors.size < 4096) colors.add((red << 16) | (green << 8) | blue);

    // 红色占优：紧急态的描边、角标、内部光晕
    if (red > 110 && red > green + 40 && red > blue + 40) {
      reddish += 1;
      // 最外圈 2px 是窗口留白（卡片之外），不允许出现红色外溢光晕
      const x = index % width;
      const y = Math.floor(index / width);
      if (x < 2 || y < 2 || x >= width - 2 || y >= height - 2) edgeReddish += 1;
    }
  }

  return {
    opaque,
    transparent,
    uniqueColors: colors.size,
    reddish,
    edgeReddish,
    luminance: opaque > 0 ? luminanceSum / opaque : 0,
  };
}

/** 灵动岛状态截图留档 + 像素统计（便于人工复核外观与自动化断言） */
async function captureIsland(
  name: string,
  expected: { width: number; height: number },
): Promise<IslandShotStats | null> {
  // 截图统计总是执行（像素断言不依赖环境变量）；ISLAND_SHOTS_DIR 只控制是否落盘留档
  const dir = process.env.ISLAND_SHOTS_DIR ?? '';
  const win = island.getWindow();
  if (!win || win.isDestroyed()) return null;
  // 窗口可能正处在"隐藏 → 重新显示"的过渡里（例如下课后自动弹出）：
  // 先等它可见，避免偶发丢掉一张留档图导致"形态尺寸递增"这类断言缺数据。
  for (let attempt = 0; attempt < 15 && !win.isVisible(); attempt += 1) {
    await sleep(100);
  }
  if (!win.isVisible()) return null;
  try {
    // 透明窗口直接 capturePage 会得到空白图：把它临时放到不透明背景上再截图
    await win.webContents.executeJavaScript(
      `document.documentElement.style.background = '#1f2733'; document.body.style.background = '#1f2733'; true`,
    );
    await sleep(160);
    // 等岛形变收敛：像素级断言与留档都必须在"稳定帧"上做，
    // 否则会拍到形变中间帧（岛比目标略大/小），"岛外留白"统计随之误报。
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const first = await readIslandGeometryFrom(win);
      await sleep(50);
      const second = await readIslandGeometryFrom(win);
      if (
        first &&
        second &&
        Math.abs(first.island.width - second.island.width) < 0.6 &&
        Math.abs(first.island.height - second.island.height) < 0.6
      ) {
        break;
      }
    }
    // 先取岛的矩形 → 连拍两帧（第一帧可能是形变中的旧帧）→ 再取一次几何。
    // capturePage 返回的是"最近一次合成的帧"，形变很快时会与 DOM 状态差一帧，
    // 因此用前后两次几何的**并集**做"岛之外"的判定，避免把岛边缘误算成外溢。
    await win.webContents.capturePage();
    await sleep(60);
    const image = await win.webContents.capturePage();
    // 紧接截图之后读几何：让"矩形"与"画面"尽可能来自同一时刻
    const geometry = await readIslandGeometryFrom(win);
    const union = unionIslandRect(geometry, geometry);
    await win.webContents.executeJavaScript(
      `document.documentElement.style.background = 'transparent'; document.body.style.background = 'transparent'; true`,
    );

    const cropped = geometry ? cropToIsland(image, geometry, win) : image;
    // 岛之外的窗口留白区不允许出现红色（紧急光晕不外溢）——抗锯齿边界向内缩 2px
    const outsideReddish = union ? countReddishOutsideIsland(image, union, win, 3) : 0;
    const filePath = dir ? path.join(dir, `${name}.png`) : '';
    if (filePath) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, cropped.toPNG());
      // 同时留档"未裁剪的整窗"图，便于人工核对岛外留白
      if (geometry) fs.writeFileSync(path.join(dir, `${name}-window.png`), image.toPNG());
    }

    const size = cropped.getSize();
    // 四角圆角像素检查：半径取自卡片 CSS 变量 --card-r（与 SVG path 同源）
    const scaleRatio = image.getSize().width / Math.max(1, geometry?.window.width ?? image.getSize().width);
    const cardRadius = await win.webContents
      .executeJavaScript(
        `(() => {
           const card = document.querySelector('.island-card');
           if (!card) return 0;
           return Number.parseFloat(getComputedStyle(card).getPropertyValue('--card-r')) || 0;
         })()`,
      )
      .catch(() => 0);
    const corners = cardRadius > 0 ? analyzeCorners(cropped, cardRadius, scaleRatio) : undefined;
    // 投影（filter）是否常驻：形态切换只允许改参数，不允许增删 filter 声明
    const shapeFilter = await win.webContents
      .executeJavaScript(
        `(() => {
           const path = document.querySelector('.island-card .shape path');
           return path ? getComputedStyle(path).filter : '';
         })()`,
      )
      .catch(() => '');
    const stats: IslandShotStats = {
      name,
      expected,
      width: size.width,
      height: size.height,
      filePath,
      ...analyzeBitmap(cropped),
      corners,
      outsideReddish,
      shapeFilter,
    };
    islandShots.push(stats);
    const layout = await win.webContents
      .executeJavaScript(
        `(() => {
           const card = document.querySelector('.island-card');
           if (!card) return null;
           const dump = (selector) => {
             const node = card.querySelector(selector);
             if (!node) return null;
             const r = node.getBoundingClientRect();
             const s = getComputedStyle(node);
             return {
               selector,
               rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
               display: s.display,
               dir: s.flexDirection,
               justify: s.justifyContent,
               opacity: s.opacity,
             };
           };
           return {
             card: (() => {
               const r = card.getBoundingClientRect();
               return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
             })(),
             items: [
               dump('.content'),
               dump('.pill-layer'),
               dump('.expanded-layer'),
               dump('.expanded-layer .head'),
               dump('.expanded-layer .title'),
               dump('.expanded-layer .body'),
               dump('.expanded-layer .foot'),
             ].filter(Boolean),
           };
         })()`,
      )
      .catch(() => null);
    if (layout) {
      console.log(
        `[SMOKE] 布局诊断 ${name}：卡片=${layout.card.join(',')} ` +
          layout.items
            .map(
              (item: { selector: string; rect: number[]; display: string; dir: string; opacity: string }) =>
                `${item.selector}[${item.rect.join(',')} ${item.display}/${item.dir} op=${item.opacity}]`,
            )
            .join(' '),
      );
    }
    const redBox = reddishBBox(image);
    console.log(
      `[SMOKE] 灵动岛截图：${filePath}（${stats.width}x${stats.height} 不透明=${stats.opaque} ` +
        `颜色=${stats.uniqueColors} 偏红=${stats.reddish} 外圈偏红=${stats.edgeReddish}）` +
        ` 诊断[红像素框=${redBox.x},${redBox.y} ${redBox.width}x${redBox.height} ` +
        `岛=${geometry ? `${geometry.island.x - geometry.window.x},${geometry.island.y - geometry.window.y} ${geometry.island.width}x${geometry.island.height}` : '-'} ` +
        `窗口=${geometry ? `${geometry.window.width}x${geometry.window.height}` : '-'}]`,
    );
    return stats;
  } catch (error) {
    console.warn('[SMOKE] 灵动岛截图失败', error);
    return null;
  }
}

interface IslandBackdropStats {
  name: string;
  /** 环（窗口内、卡片外）亮度中位数：这一圈本该"透出桌面" */
  ring: number;
  /** 基准（窗口矩形之外、同一时刻的桌面）亮度中位数：用来对消壁纸本身的明暗 */
  reference: number;
  /** 卡片内部亮度中位数（防御性检查：卡片本身不能变白） */
  card: number;
  /** 卡片**近场**外圈里明显比紧邻桌面亮的像素数（材料/不透明窗口底色的直接证据） */
  veilPixels: number;
  filePath: string;
}

/**
 * 卡片外圈自检的**纯色底板**。
 *
 * 直接把岛摆到用户的桌面上取样是不可靠的：壁纸、浏览器窗口、正在干活的其他程序都会变，
 * 截出来的"环"到底是桌面还是面板根本说不清（真机实测就撞上过浏览器盖住岛的情况）。
 * 所以测试期间在岛下面垫一块**已知颜色**的底板窗口，环的期望值就变成常量：
 * 透明 ⇒ 环 = 底板色；被系统材质/不透明窗口底色糊过 ⇒ 环与底板色对不上（几秒内就能断言）。
 */
const ISLAND_BACKDROP_COLOR = '#101722';
const ISLAND_BACKDROP_LUMINANCE = 0.2126 * 0x10 + 0.7152 * 0x17 + 0.0722 * 0x22;
/** 底板色的 RGB 分量（残影判据用：与它比对，明显偏离才算"岛像素"） */
const ISLAND_BACKDROP_COLOR_RGB = { r: 0x10, g: 0x17, b: 0x22 };

/**
 * 冒烟用的教师凭据：**从环境变量读，不写进代码**。
 *
 * 为什么必须这样：本文件会被 esbuild 打进 `dist/main/index.js` → `app.asar`，随安装包发到每台学生机，
 * 而 asar 是可以直接解包的（实测 `grep teacher123 dist/main/index.js` 命中）。
 * 把种子教师账号明文写在里面，等于把教师账号随安装包一起发出去。
 *
 * 注意：把静态 import 改成 `await import('./smoke.js')` **不能**解决这个问题 ——
 * esbuild 在 `format: 'cjs'` + `bundle: true` 时不做代码分割，动态 import 同样被内联进同一个文件
 * （已用最小用例实测：模块内的字面量仍然出现在产物里）。真正的边界是 `app.asar` 里有什么，
 * 因此凭据必须从外部传入；未传入时相关断言标记为"跳过"，而不是静默失败。
 *
 * 传入方式见 `scripts/smoke.mjs` 与 `scripts/verify-packaged.mjs`（它们会带上种子默认值，
 * 那些脚本不进安装包）。
 */
const smokeCredentialUser = process.env.ELECTRON_SMOKE_USER ?? '';
const smokeCredentialPassword = process.env.ELECTRON_SMOKE_PASSWORD ?? '';

/** 需要在"登录页不得出现示例内容"里排查的凭据片段（有凭据时才非空） */
const smokeCredentialTokens = [smokeCredentialUser, smokeCredentialPassword].filter(Boolean);

/** 用教师账号换一个 token（未提供凭据时返回空串） */
async function smokeTeacherToken(base: string): Promise<string> {
  if (!smokeCredentialUser || !smokeCredentialPassword) return '';
  try {
    const login = (await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: smokeCredentialUser, password: smokeCredentialPassword }),
    }).then((response) => response.json())) as { data?: { token?: string } };
    return login?.data?.token ?? '';
  } catch {
    return '';
  }
}

let islandBackdropWindow: BrowserWindow | null = null;

/** 惰性创建纯色底板窗口（不抢焦点、不占任务栏，只在取样期间显示） */
async function ensureIslandBackdropWindow(): Promise<BrowserWindow> {
  if (islandBackdropWindow && !islandBackdropWindow.isDestroyed()) return islandBackdropWindow;
  const win = new BrowserWindow({
    show: false,
    frame: false,
    transparent: false,
    backgroundColor: ISLAND_BACKDROP_COLOR,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    alwaysOnTop: true,
    type: 'toolbar',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const page = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:${ISLAND_BACKDROP_COLOR}"></body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
  win.setAlwaysOnTop(true, 'screen-saver');
  islandBackdropWindow = win;
  return win;
}

/** 取样结束后收起底板（不留在桌面上） */
function hideIslandBackdropWindow(): void {
  if (islandBackdropWindow && !islandBackdropWindow.isDestroyed()) islandBackdropWindow.hide();
}

function medianOf(values: number[]): number {
  if (values.length === 0) return -1;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? -1;
}

/**
 * 收回动画逐帧取证（诊断用，只在 `ELECTRON_SMOKE_ISLAND_DIAG=1` 时跑；不进交付产物）。
 *
 * 为什么必须整屏抓：`webContents.capturePage()` 只拿渲染进程自己的位面，**窗口之外的残影拍不到**，
 * 而"收回一瞬间闪一下"的用户反馈正是这一类。这里用 `desktopCapturer` 走系统合成路径连拍，
 * 每帧同时记录：卡片矩形 / 窗口矩形 / `isClosing` / 两层 alpha（用来判定"双份内容重叠"）,
 * 以及**"卡片之外变成岛色"的像素数**（用来判定"窗口外残影"），帧图落盘供人工核对。
 */
async function diagnoseClosingFlash(label: string, withTouch: boolean): Promise<string> {
  const dir = path.join(process.cwd(), '..', '..', '.cache', 'island-closing-frames');
  fs.mkdirSync(dir, { recursive: true });
  const lines: string[] = [];
  const win = island.getWindow();
  if (!win || win.isDestroyed()) return 'no-window';

  island.setTouchMode(withTouch);
  // 复刻用户的实际外观：marginY=52、tinted（主题色渐变）——用户配置里就是这个
  island.setAppearance({ marginY: 52, style: 'tinted', speed: 1, animations: true });
  await sleep(400);

  // 垫一块**已知颜色的底板**在岛底下（用户桌面是浅色壁纸，底板用浅灰模拟），
  // 这样"岛矩形之外本该透出底板"的地方一旦出现别的颜色，就是残影 —— 判定不依赖壁纸内容。
  const backdrop = await ensureIslandBackdropWindow();
  const box = island.getWindowBounds();
  const pad = 60;
  backdrop.setBounds({
    x: box.x - pad,
    y: box.y - pad,
    width: box.width + pad * 2,
    height: box.height + pad * 2,
  });
  backdrop.showInactive();
  backdrop.moveTop();
  win.moveTop();
  await sleep(300);

  // 造一张和用户照片同形的紧急卡
  island.pushNotification(
    { ...makeNotification(`diag-close-${label}`, 'URGENT', '紧急通知'), teacherName: '系统管理员' },
    { inClass: false },
  );
  await sleep(800);
  island.handleAction({ action: 'expand' });
  await sleep(900);

  const display = screen.getPrimaryDisplay();
  const scale = display.scaleFactor || 1;
  const shotSize = {
    width: Math.round(display.size.width * scale),
    height: Math.round(display.size.height * scale),
  };
  const grab = async (): Promise<Electron.NativeImage | null> => {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: shotSize });
    const source = sources.find((item) => String(item.display_id) === String(display.id)) ?? sources[0];
    return source ? source.thumbnail : null;
  };
  const geometryNow = (): Promise<IslandGeometry | null> => readIslandGeometryFrom(win);
  const layerAlphas = async (): Promise<{ pill: number; expanded: number }> =>
    (await win.webContents
      .executeJavaScript(
        `(() => {
           const read = (selector) => {
             const node = document.querySelector(selector);
             return node ? Number(getComputedStyle(node).opacity) : -1;
           };
           return { pill: read('.pill-layer'), expanded: read('.expanded-layer') };
         })()`,
      )
      .catch(() => ({ pill: -1, expanded: -1 }))) ?? { pill: -1, expanded: -1 };

  /** 底板色（浅灰）与"岛色"的判据：明显偏离底板即视为岛像素 */
  const backdropRgb = ISLAND_BACKDROP_COLOR_RGB;
  const isIslandPixel = (bitmap: Buffer, index: number): boolean => {
    const b = bitmap[index];
    const g = bitmap[index + 1];
    const r = bitmap[index + 2];
    return Math.abs(r - backdropRgb.r) + Math.abs(g - backdropRgb.g) + Math.abs(b - backdropRgb.b) > 90;
  };
  /**
   * 统计：**窗口矩形之内、卡片矩形之外**出现"岛像素"的数量（= 残影/没被正确擦掉的内容）。
   * 这一带本该 100% 是底板色。
   */
  const countRingResidue = (
    bitmap: Buffer,
    shotScale: number,
    card: { x: number; y: number; width: number; height: number },
    winRect: { x: number; y: number; width: number; height: number },
  ): { ring: number; outsideWindow: number } => {
    const px = (v: number): number => Math.round(v * shotScale);
    const from = { x: px(winRect.x), y: px(winRect.y) };
    const to = { x: px(winRect.x + winRect.width), y: px(winRect.y + winRect.height) };
    const cardBox = { x: px(card.x), y: px(card.y), w: px(card.width), h: px(card.height) };
    let ring = 0;
    let outsideWindow = 0;
    for (let y = Math.max(0, from.y - px(30)); y < Math.min(shotSize.height, to.y + px(30)); y += 2) {
      for (let x = Math.max(0, from.x - px(30)); x < Math.min(shotSize.width, to.x + px(30)); x += 2) {
        const index = (y * shotSize.width + x) * 4;
        if (index + 3 >= bitmap.length) continue;
        if (!isIslandPixel(bitmap, index)) continue;
        const inCard =
          x >= cardBox.x && x <= cardBox.x + cardBox.w && y >= cardBox.y && y <= cardBox.y + cardBox.h;
        if (inCard) continue;
        if (x >= from.x && x <= to.x && y >= from.y && y <= to.y) ring += 1;
        else outsideWindow += 1;
      }
    }
    return { ring, outsideWindow };
  };

  // 模拟"手点"：真实光标停在按钮上（窗口处于可命中），再用 sendInputEvent 发真实鼠标按下/抬起
  island.setTestInputPassthrough(false);
  const buttonPoint = await win.webContents.executeJavaScript(
    `(() => {
       const button = document.querySelector('.island-card.expanded .solid-btn');
       if (!button) return null;
       const r = button.getBoundingClientRect();
       return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
     })()`,
  );
  if (buttonPoint) {
    const bounds = win.getBounds();
    island.setHitTestCursor({ x: Math.round(bounds.x + buttonPoint.x), y: Math.round(bounds.y + buttonPoint.y) });
    await sleep(160);
    win.webContents.sendInputEvent({ type: 'mouseDown', x: buttonPoint.x, y: buttonPoint.y, button: 'left', clickCount: 1 });
    await sleep(40);
    win.webContents.sendInputEvent({ type: 'mouseUp', x: buttonPoint.x, y: buttonPoint.y, button: 'left', clickCount: 1 });
  }
  const deadline = Date.now() + 1600;
  let index = 0;
  let maxRing = 0;
  let maxOutside = 0;
  let overlapFrames = 0;
  while (Date.now() < deadline) {
    const image = await grab();
    const geometry = await geometryNow();
    const alphas = await layerAlphas();
    if (image && geometry) {
      const bitmap = image.toBitmap();
      const shotScale = image.getSize().width / Math.max(1, display.size.width);
      const stat = countRingResidue(bitmap, shotScale, geometry.island, geometry.window);
      maxRing = Math.max(maxRing, stat.ring);
      maxOutside = Math.max(maxOutside, stat.outsideWindow);
      if (alphas.pill > 0.15 && alphas.expanded > 0.15) overlapFrames += 1;
      // 落盘：底板 + 岛所在区域（用户照片同款视角）
      const crop = image.crop({
        x: Math.max(0, Math.round((geometry.window.x - pad) * shotScale)),
        y: Math.max(0, Math.round((geometry.window.y - pad) * shotScale)),
        width: Math.min(
          image.getSize().width,
          Math.round((geometry.window.width + pad * 2) * shotScale),
        ),
        height: Math.min(
          image.getSize().height,
          Math.round((geometry.window.height + pad * 2) * shotScale),
        ),
      });
      fs.writeFileSync(path.join(dir, `${label}-${String(index).padStart(2, '0')}.png`), crop.toPNG());
      lines.push(
        `[${label}] #${index} t=${Date.now() - (deadline - 1600)}ms 卡片=${Math.round(
          geometry.island.width,
        )}x${Math.round(geometry.island.height)} 窗口=${geometry.window.width}x${geometry.window.height}@${
          geometry.window.x
        },${geometry.window.y} pill=${alphas.pill.toFixed(2)} expanded=${alphas.expanded.toFixed(
          2,
        )} 环内残影=${stat.ring} 窗口外残影=${stat.outsideWindow}`,
      );
    }
    index += 1;
    await sleep(20);
  }
  lines.push(
    `[${label}] 汇总：帧数=${index} 双份内容重叠帧=${overlapFrames} 环内残影峰值=${maxRing} 窗口外残影峰值=${maxOutside}`,
  );

  island.setHitTestCursor(null);
  island.setTestInputPassthrough(true);
  island.setTouchMode(false);
  await sleep(200);
  island.handleAction({ action: 'dismiss' });
  await sleep(300);
  fs.writeFileSync(path.join(dir, `${label}.txt`), lines.join(String.fromCharCode(10)));
  return lines.join(String.fromCharCode(10));
}

/**
 * 用**整屏截图**检查"卡片之外的那一圈"到底是什么颜色。
 *
 * 为什么必须拍整屏：`webContents.capturePage()` 只拿得到渲染进程自己的位面，
 * 窗口自己的底色 / 系统背景材质（亚克力、mica）都画在它**后面**，根本拍不到 ——
 * 「毛玻璃 / 主题色渐变出现白底」正是从这个盲区漏过去的（详见 `main/island.ts` 的说明）。
 *
 * 这里用 desktopCapturer 抓真实桌面合成结果，再按"岛矩形 / 窗口矩形"分三块取样：
 *   - 卡片：岛体内部 → 必须仍是深色；
 *   - 环：窗口内、卡片外 → 本该**完全透明**（露出桌面），出现浅色面板即回归；
 *   - 基准：窗口矩形之外、同一时刻的桌面 → 用来对消壁纸自身的明暗差异。
 */
async function captureIslandBackdrop(name: string): Promise<IslandBackdropStats | null> {
  const win = island.getWindow();
  if (!win || win.isDestroyed() || !win.isVisible()) return null;
  const geometry = await readIslandGeometryFrom(win);
  if (!geometry) return null;
  const rect = geometry.window;
  const display = screen.getDisplayMatching(rect);
  const scale = display.scaleFactor || 1;
  const margin = 40;
  // 垫底板 + 把岛抬回最上层（否则全屏浏览器之类的前台窗口会把岛盖住，量到的是别人的像素）
  const backdropWin = await ensureIslandBackdropWindow();
  backdropWin.setBounds({
    x: rect.x - margin - 8,
    y: rect.y - margin - 8,
    width: rect.width + (margin + 8) * 2,
    height: rect.height + (margin + 8) * 2,
  });
  backdropWin.showInactive();
  backdropWin.moveTop();
  win.moveTop();
  await sleep(320);
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(display.size.width * scale),
        height: Math.round(display.size.height * scale),
      },
    });
    const source = sources.find((item) => String(item.display_id) === String(display.id)) ?? sources[0];
    if (!source) return null;
    const shot = source.thumbnail;
    const shotSize = shot.getSize();
    // 缩略图可能被系统按上限缩小：一律用"缩略图尺寸 / 屏幕逻辑尺寸"换算，别假设等于 scaleFactor
    const shotScale = shotSize.width / Math.max(1, display.size.width);
    const left = Math.max(0, Math.round((rect.x - display.bounds.x - margin) * shotScale));
    const top = Math.max(0, Math.round((rect.y - display.bounds.y - margin) * shotScale));
    const width = Math.min(shotSize.width - left, Math.round((rect.width + margin * 2) * shotScale));
    const height = Math.min(shotSize.height - top, Math.round((rect.height + margin * 2) * shotScale));
    if (width <= 0 || height <= 0) return null;
    const region = shot.crop({ x: left, y: top, width, height });
    const bitmap = region.toBitmap();
    const size = region.getSize();
    // 屏幕逻辑坐标 → 裁剪图像素坐标
    const originX = display.bounds.x + left / shotScale;
    const originY = display.bounds.y + top / shotScale;
    const toPx = (value: number, origin: number): number => Math.round((value - origin) * shotScale);
    const winRect = {
      left: toPx(rect.x, originX) + 2,
      top: toPx(rect.y, originY) + 2,
      right: toPx(rect.x + rect.width, originX) - 2,
      bottom: toPx(rect.y + rect.height, originY) - 2,
    };
    const inset = Math.max(3, Math.round(3 * shotScale));
    const islandRect = {
      left: toPx(geometry.island.x, originX),
      top: toPx(geometry.island.y, originY),
      right: toPx(geometry.island.x + geometry.island.width, originX),
      bottom: toPx(geometry.island.y + geometry.island.height, originY),
    };
    // 卡片内部取样：向内缩，避开描边与抗锯齿
    const cardRect = {
      left: islandRect.left + inset,
      top: islandRect.top + inset,
      right: islandRect.right - inset,
      bottom: islandRect.bottom - inset,
    };
    // 环的"内边界"= 岛体矩形（外扩 1px）：岛自己的描边/抗锯齿不能算进"环"，
    // 否则会把卡片本身那圈 1px 白描边误当成"白底面板"（真机踩过）。
    const ringInner = {
      left: islandRect.left - 1,
      top: islandRect.top - 1,
      right: islandRect.right + 1,
      bottom: islandRect.bottom + 1,
    };
    const inRect = (
      x: number,
      y: number,
      r: { left: number; top: number; right: number; bottom: number },
    ): boolean => x >= r.left && x < r.right && y >= r.top && y < r.bottom;

    // 基准取样带：贴着窗口左右两侧、**与窗口同一批行**的桌面像素。
    // 与"窗口内那一圈"贴得最近、行也一致，才能把壁纸自身的明暗/gradient 抵消掉。
    const band = Math.max(4, Math.round(16 * shotScale));
    const refBand = {
      left: Math.max(0, winRect.left - band),
      right: Math.min(size.width, winRect.right + band),
      top: winRect.top,
      bottom: winRect.bottom,
    };
    // 卡片外圈的"近场"：卡片四周 pad+4 px 内（材料/窗口底色最先暴露的地方）
    const padNear = Math.max(
      0,
      Math.min(
        islandRect.left - winRect.left,
        islandRect.top - winRect.top,
        winRect.right - islandRect.right,
        winRect.bottom - islandRect.bottom,
      ),
    );
    const haloRect = {
      left: islandRect.left - padNear - 6,
      top: islandRect.top - padNear - 6,
      right: islandRect.right + padNear + 6,
      bottom: islandRect.bottom + padNear + 6,
    };

    const ring: number[] = [];
    const card: number[] = [];
    const reference: number[] = [];
    const fallbackReference: number[] = [];
    const halo: number[] = [];
    for (let y = 0; y < size.height; y += 1) {
      for (let x = 0; x < size.width; x += 1) {
        const offset = (y * size.width + x) * 4;
        const blue = bitmap[offset] ?? 0;
        const green = bitmap[offset + 1] ?? 0;
        const red = bitmap[offset + 2] ?? 0;
        const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
        if (inRect(x, y, cardRect)) card.push(luminance);
        else if (!inRect(x, y, ringInner) && inRect(x, y, winRect)) {
          ring.push(luminance);
          if (inRect(x, y, haloRect)) halo.push(luminance);
        } else {
          fallbackReference.push(luminance);
          if (y >= refBand.top && y < refBand.bottom && (x < winRect.left || x >= winRect.right)) {
            reference.push(luminance);
          }
        }
      }
    }
    // 贴边取样带样本太少（窗口贴屏幕边）时退回"窗口外全部像素"
    const refSample = reference.length >= 300 ? reference : fallbackReference;
    // 环上"白底"像素：比紧邻的桌面亮很多（材料面板 / 不透明窗口底色都会这样）
    const refMedian = medianOf(refSample);
    const veilPixels = halo.filter((value) => value > refMedian + 30).length;
    const filePath = process.env.ISLAND_SHOTS_DIR
      ? path.join(process.env.ISLAND_SHOTS_DIR, `${name}-backdrop.png`)
      : '';
    if (filePath) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, region.toPNG());
    }
    const stats: IslandBackdropStats = {
      name,
      ring: Math.round(medianOf(ring)),
      reference: Math.round(refMedian),
      card: Math.round(medianOf(card)),
      veilPixels,
      filePath,
    };
    console.log(
      `[SMOKE] 卡片外圈（整屏截图）：${name} 环=${stats.ring} 基准=${stats.reference} ` +
        `卡片=${stats.card} 环上白底像素=${stats.veilPixels} 窗口=${rect.width}x${rect.height} ` +
        `岛=${Math.round(geometry.island.width)}x${Math.round(geometry.island.height)} 图=${filePath}`,
    );
    return stats;
  } catch (error) {
    console.warn('[SMOKE] 卡片外圈截图失败', error);
    return null;
  } finally {
    hideIslandBackdropWindow();
  }
}

/** 按岛的矩形裁剪截图（含比例换算：capturePage 返回物理像素） */
function cropToIsland(
  image: Electron.NativeImage,
  geometry: IslandGeometry,
  win: BrowserWindow,
): Electron.NativeImage {
  const scale = win.webContents.getZoomFactor() || 1;
  const ratio = image.getSize().width / Math.max(1, geometry.window.width);
  void scale;
  const x = Math.max(0, Math.round(geometry.island.x - geometry.window.x) * (ratio / 1));
  const y = Math.max(0, Math.round(geometry.island.y - geometry.window.y) * ratio);
  const width = Math.min(image.getSize().width - x, Math.round(geometry.island.width * ratio));
  const height = Math.min(image.getSize().height - y, Math.round(geometry.island.height * ratio));
  if (width <= 0 || height <= 0) return image;
  return image.crop({ x, y, width, height });
}

/**
 * 圆角像素级检查（专抓“圆角缺一块 / 角画反”这类几何错误）。
 *
 * 做法：从裁剪图的四个角沿对角线向内逐像素走，找到第一个“连续 3 像素属于岛体”的位置，
 * 记为该角的边界步进 `steps`。连续圆角（superellipse n=4.2）理论边界在 0.153r 处，
 * 四个角必须互相一致——这正是之前的回归点：旧实现四个角共用同一个偏移向量，
 * 左上/右下被切掉一块，两两之间步进会明显不同。该指标只看角尖端 2~7px，与卡片内文字无关。
 */
function analyzeCorners(
  image: NativeImage,
  radius: number,
  ratio: number,
): { steps: number[]; expectedInset: number; spread: number; limit: number } {
  const bitmap = image.toBitmap();
  const size = image.getSize();
  const r = Math.max(3, radius * ratio);
  // “岛体存在”判定：与截图时注入的窗口背景色 #1f2733 差异明显即算岛体（纯黑填充、红色描边、
  // 白色文字都算），这样紧急态顶部的红色渐层不会把四角判定带偏。
  const bg = { r: 0x1f, g: 0x27, b: 0x33 };
  const isFill = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= size.width || y >= size.height) return false;
    const index = (y * size.width + x) * 4;
    const blue = bitmap[index] ?? 255;
    const green = bitmap[index + 1] ?? 255;
    const red = bitmap[index + 2] ?? 255;
    return Math.abs(red - bg.r) > 16 || Math.abs(green - bg.g) > 16 || Math.abs(blue - bg.b) > 16;
  };
  const signs: [number, number][] = [
    [1, 1],
    [-1, 1],
    [1, -1],
    [-1, -1],
  ];
  const maxSteps = Math.ceil(r) + 2;
  const steps: number[] = [];
  for (const [sx, sy] of signs) {
    let found = maxSteps;
    for (let k = 0; k <= maxSteps; k += 1) {
      const x = sx > 0 ? k : size.width - 1 - k;
      const y = sy > 0 ? k : size.height - 1 - k;
      if (isFill(x, y) && isFill(x + sx, y + sy) && isFill(x + 2 * sx, y + 2 * sy)) {
        found = k;
        break;
      }
    }
    steps.push(found);
  }
  const spread = Math.max(...steps) - Math.min(...steps);
  return {
    steps,
    expectedInset: Number((0.153 * r).toFixed(2)),
    spread,
    limit: Math.round(0.3 * r) + 1,
  };
}

/** 偏红像素的包围盒（诊断形状错位：与几何读数对比即可定位偏差来源） */
function reddishBBox(image: Electron.NativeImage): { x: number; y: number; width: number; height: number } {
  const bitmap = image.toBitmap();
  const size = image.getSize();
  let left = size.width;
  let top = size.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < size.height; y += 1) {
    for (let x = 0; x < size.width; x += 1) {
      const index = (y * size.width + x) * 4;
      const blue = bitmap[index] ?? 0;
      const green = bitmap[index + 1] ?? 0;
      const red = bitmap[index + 2] ?? 0;
      const alpha = bitmap[index + 3] ?? 0;
      if (alpha > 40 && red > green + 12 && red > blue + 12) {
        if (x < left) left = x;
        if (y < top) top = y;
        if (x > right) right = x;
        if (y > bottom) bottom = y;
      }
    }
  }
  return right < 0
    ? { x: 0, y: 0, width: 0, height: 0 }
    : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

/** 两次几何读数的并集（形变过程中宁可多算一点，也不会把岛边缘误判成"岛外"） */
function unionIslandRect(a: IslandGeometry | null, b: IslandGeometry | null): IslandGeometry | null {
  if (!a) return b;
  if (!b) return a;
  const left = Math.min(a.island.x, b.island.x);
  const top = Math.min(a.island.y, b.island.y);
  const right = Math.max(a.island.x + a.island.width, b.island.x + b.island.width);
  const bottom = Math.max(a.island.y + a.island.height, b.island.y + b.island.height);
  return {
    window: b.window,
    island: { x: left, y: top, width: right - left, height: bottom - top },
  };
}

/**
 * 统计"岛矩形之外"的偏红像素（窗口留白区）。
 * 新架构下窗口是固定包围盒，岛只占其中一部分：光晕一旦外溢就会落在这些留白里。
 */
function countReddishOutsideIsland(
  image: Electron.NativeImage,
  geometry: IslandGeometry,
  win: BrowserWindow,
  margin: number,
): number {
  const bitmap = image.toBitmap();
  const size = image.getSize();
  const ratio = size.width / Math.max(1, geometry.window.width);
  void win;
  // margin 是**向外**的容差：岛的描边（1px 居中）与抗锯齿边都算"岛内"，
  // 只有明显落在岛之外（> margin）的红色才算外溢。此前把它当"向内缩"，
  // 结果把岛自身的红色描边统计成了"岛外偏红"。
  const left = (geometry.island.x - geometry.window.x - margin) * ratio;
  const top = (geometry.island.y - geometry.window.y - margin) * ratio;
  const right = (geometry.island.x - geometry.window.x + geometry.island.width + margin) * ratio;
  const bottom = (geometry.island.y - geometry.window.y + geometry.island.height + margin) * ratio;

  let count = 0;
  for (let y = 0; y < size.height; y += 1) {
    for (let x = 0; x < size.width; x += 1) {
      if (x >= left && x <= right && y >= top && y <= bottom) continue;
      const index = (y * size.width + x) * 4;
      const blue = bitmap[index] ?? 0;
      const green = bitmap[index + 1] ?? 0;
      const red = bitmap[index + 2] ?? 0;
      const alpha = bitmap[index + 3] ?? 0;
      if (alpha > 40 && red > green + 12 && red > blue + 12) count += 1;
    }
  }
  return count;
}

/** 读取岛的几何（截图用；与 runIslandChecks 内的同名逻辑保持一致的语义） */
async function readIslandGeometryFrom(win: BrowserWindow): Promise<IslandGeometry | null> {
  const bounds = island.getWindowBounds();
  const rect = await win.webContents
    .executeJavaScript(
      `(() => {
         const card = document.querySelector('.island-card');
         if (!card) return null;
         const r = card.getBoundingClientRect();
         return { left: r.left, top: r.top, width: r.width, height: r.height };
       })()`,
    )
    .catch(() => null);
  if (!rect) return null;
  return {
    window: bounds,
    island: {
      x: bounds.x + rect.left,
      y: bounds.y + rect.top,
      width: rect.width,
      height: rect.height,
    },
  };
}

/** 打印灵动岛渲染进程的真实 DOM 结构（排查空白窗口） */
async function dumpIslandDom(_label: string): Promise<string> {
  const win = island.getWindow();
  if (!win || win.isDestroyed()) return 'no-window';
  try {
    return await win.webContents.executeJavaScript(
      `(() => {
         const app = document.querySelector('#app');
         const card = document.querySelector('.island-card');
         return JSON.stringify({
           appChildren: app ? app.children.length : -1,
           cardClass: card ? card.className : null,
           text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 60),
         });
       })()`,
    );
  } catch (error) {
    return `dump-error: ${(error as Error).message}`;
  }
}

/**
 * 冒烟用：用教师账号发一条普通通知，返回通知 id（失败返回空串）。
 * 用于"未读红点位置"这类需要真实未读数据的断言。
 */
async function createSmokeNotification(title = '红点位置校验'): Promise<string> {
  const base = process.env.ELECTRON_SMOKE_API ?? 'http://127.0.0.1:4000/api';
  try {
    // 凭据来自环境变量（见 smokeCredentialUser 的说明）：没给就跳过，绝不把账号写进安装包
    const token = await smokeTeacherToken(base);
    if (!token) return '';
    // 探针必须打到"冒烟客户端所在的班"，否则收不到；优先用 harness 传来的**临时班级** id
    // （见 scripts/lib/smoke-class.mjs：临时班级是为了不把测试通知弹到用户自己的客户端上）
    let classId = process.env.ELECTRON_SMOKE_CLASS_ID ?? '';
    if (!classId) {
      const classes = (await fetch(`${base}/classes`, {
        headers: { authorization: `Bearer ${token}` },
      }).then((response) => response.json())) as { data?: Array<{ id?: string }> };
      classId = classes?.data?.[0]?.id ?? '';
    }
    if (!classId) return '';
    const created = (await fetch(`${base}/notifications`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        classId,
        title,
        content: '自动化验证用通知（断言后即删除）。',
        // 普通优先级即可：冒烟客户端登录的是**临时班级**（没有课表 → 判定"不在上课"），
        // 普通通知照样立刻以胶囊弹出。这样即便探针被别的客户端收到，也只是短暂一条胶囊，
        // 不会弹成大卡（之前用 URGENT 是为了绕开"用户班级正在上课"的场景，现已不需要）。
        priority: 'NORMAL',
      }),
    }).then((response) => response.json())) as { data?: { id?: string } };
    return created?.data?.id ?? '';
  } catch {
    return '';
  }
}

/** 冒烟用：删除上面造的通知（失败忽略） */
async function deleteSmokeNotification(id: string): Promise<void> {
  const base = process.env.ELECTRON_SMOKE_API ?? 'http://127.0.0.1:4000/api';
  try {
    const token = await smokeTeacherToken(base);
    if (!token) return;
    await fetch(`${base}/notifications/${id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    // 清理失败不影响冒烟结论
  }
}

function makeNotification(
  id: string,
  priority: IslandNotification['priority'],
  title: string,
): IslandNotification {
  return {
    id,
    title,
    content:
      '明天下午的数学课改为在实验楼 B205 上课，请同学们提前 10 分钟到达，并携带上次发的练习册。如有疑问请联系课代表。',
    priority,
    createdAt: new Date().toISOString(),
    courseName: '数学',
    teacherName: '张老师',
  };
}

/**
 * 岛体矩形上的相对点（fx/fy ∈ [0,1]）→ 屏幕坐标。
 * 主进程的命中兜底轮询读的是屏幕坐标，冒烟里用注入点代替"挪动用户鼠标"。
 */
function islandCardScreenPoint(fx: number, fy: number): { x: number; y: number } {
  const bounds = island.getWindowBounds();
  const rect = island.getHitRect();
  if (!rect) {
    return {
      x: bounds.x + Math.round(bounds.width / 2),
      y: bounds.y + Math.round(bounds.height / 2),
    };
  }
  return {
    x: Math.round(bounds.x + rect.x + rect.width * fx),
    y: Math.round(bounds.y + rect.y + rect.height * fy),
  };
}

/**
 * 灵动岛行为验证（对应产品需求）：
 * 1. 上课时间段收到普通通知 → 不显示灵动岛（窗口真正隐藏）并暂存
 * 2. 下课后 → 自动在桌面中上方弹出详情
 * 3. 上课时间段收到紧急通知 → 立即展开显示详情（无需点击），且带展开动画
 * 4. 非上课时段收到普通通知 → 直接显示"新消息"胶囊（无入场动画），点击后展开
 * 5. 点击卡片空白处 / 右上角收起按钮 → 回缩为胶囊
 * 6. 上课时间段内点击胶囊不会展开（上课不显示灵动岛）
 */
async function runIslandChecks(
  mainWin: BrowserWindow,
  record: Recorder,
  results: SmokeResult[],
): Promise<void> {
  record('灵动岛窗口已创建（置顶/透明/不占任务栏）', island.isReady(), `ready=${island.isReady()}`);
  if (!island.isReady()) return;

  // 诊断模式（ELECTRON_SMOKE_ISLAND_DIAG=1）：收回动画逐帧整屏取证，帧图与逐帧数据落盘
  // `.cache/island-closing-frames/`。只用于排查"收回一瞬间闪一下"，不参与常规验收。
  if (process.env.ELECTRON_SMOKE_ISLAND_DIAG === '1') {
    const touchLog = await diagnoseClosingFlash('touch', true);
    const mouseLog = await diagnoseClosingFlash('mouse', false);
    results.push({
      name: '灵动岛收回诊断（逐帧整屏取证）',
      ok: true,
      detail: '见 .cache/island-closing-frames/',
    });
    console.log(`[DIAG-CLOSE touch]` + String.fromCharCode(10) + touchLog);
    console.log(`[DIAG-CLOSE mouse]` + String.fromCharCode(10) + mouseLog);
  }

  const islandWindow = island.getWindow();
  // 默认关掉"失焦自动收起"：冒烟是自动化环境，系统/其它窗口抢焦点会随时触发 blur，
  // 把展开态收回会让断言随机失败。专门验证该行为的用例（4.5）会临时打开它。
  island.setBlurCollapseEnabled(false);
  /**
   * 真实点击穿透：自动化要跑几分钟，而用户很可能正在同一块屏幕上（他客户端那个岛和冒烟这个
   * 窗口都在屏幕顶部居中、互相叠着）—— 他点到的是**冒烟这个窗口**，于是冒烟会收到人发出的
   * expand / collapse / mark-read，把「点胶囊展开」「点空白处收起」这类用例整片弄红（实测踩过）。
   * 断言"真实光标命中"的那两条（4.5.1 假失焦）会临时关掉它。
   */
  island.setTestInputPassthrough(true);
  /**
   * 把验证实例的岛做成**一眼可辨**：洋红主题色（真实客户端默认是蓝色系）。
   *
   * 为什么：自动化验证会真在屏幕上放一个灵动岛窗口，位置与用户自己的客户端默认一致
   * （他常是 top-center + 较大 marginY，验证实例是 top-center + marginY=8）—— 两个岛一高一低叠在一起，
   * 用户会以为"屏幕上出现了第二个灵动岛"，点它又"反应不对"（它归验证脚本控制，会自己展开/收起）。
   * 只改**颜色**（不动停靠位置）：命中/几何断言全部按默认位置写过，挪位置会把它们弄红（实测踩过）。
   */
  island.setAppearance({ accent: '#e91e8c', style: 'tinted' });
  /**
   * 强制关掉触摸模式：本节的命中/穿透/窗口几何断言全部是按"鼠标模式"写的（用
   * `setHitTestCursor` 注入光标位置代替挪动真实鼠标）。若跑在带触摸屏的机器上，
   * 渲染进程会上报触摸模式 → 窗口改成"贴合岛体且不穿透"，这些注入光标的断言必然失败。
   * 触摸模式本身由本条用例末尾的专门断言覆盖。
   */
  island.setTouchMode(false);

  // 1) 上课期间：普通通知必须完全不显示（窗口隐藏）并进入队列
  island.setClassState({ inClass: true, currentPeriodEnd: '08:45', week: 1 });
  island.pushNotification(makeNotification('smoke-normal-in-class', 'NORMAL', '上课期间的普通通知'), {
    inClass: true,
  });
  await sleep(500);
  const hiddenState = island.getState();
  const hiddenVisible = islandWindow?.isVisible() ?? true;
  record(
    '上课期间普通通知自动隐藏（窗口隐藏 + 暂存待下课弹出）',
    hiddenState.mode === 'hidden' && hiddenState.queued.length === 1 && hiddenVisible === false,
    `mode=${hiddenState.mode} queued=${hiddenState.queued.length} visible=${hiddenVisible}`,
  );
  console.log(`[SMOKE] 隐藏态 DOM：${await dumpIslandDom('hidden')}`);

  // 1.1) 上课期间请求展开也不应显示（上课不显示灵动岛）
  island.handleAction({ action: 'expand' });
  await sleep(400);
  const expandBlocked = island.getState().mode === 'hidden' && !(islandWindow?.isVisible() ?? true);
  record(
    '上课期间点击不会展开灵动岛（严格不显示）',
    expandBlocked,
    `mode=${island.getState().mode} visible=${islandWindow?.isVisible() ?? true}`,
  );

  /**
   * 读取"岛"的几何：窗口矩形（固定包围盒）+ 岛在屏幕上的真实矩形（渲染层里的 .island-card）。
   * 新架构下**窗口恒定、岛在窗口内形变**，因此所有尺寸类断言都必须量 `island` 而不是窗口。
   */
  const readIslandGeometry = async (): Promise<IslandGeometry | null> => {
    const win = island.getWindowBounds();
    const rect = await islandWindow?.webContents
      .executeJavaScript(
        `(() => {
           const card = document.querySelector('.island-card');
           if (!card) return null;
           const r = card.getBoundingClientRect();
           const raw = getComputedStyle(card).getPropertyValue('--card-r').trim();
           const path = card.querySelector('.shape path');
           const box = path && typeof path.getBBox === 'function' ? path.getBBox() : null;
           // 路径绕行方向检查：沿路径等距采样，相邻点的方位角必须单调递增（凸、不自交）。
           // 角的采样参数若写反，路径会在角上“往回折”，这里会立刻暴露。
           let winding = 0;
           let windingOk = true;
           if (path && typeof path.getTotalLength === 'function') {
             const total = path.getTotalLength();
             const points = [];
             for (let index = 0; index < 96; index += 1) {
               const point = path.getPointAtLength((index / 96) * total);
               points.push([point.x, point.y]);
             }
             const cx = points.reduce((sum, p) => sum + p[0], 0) / points.length;
             const cy = points.reduce((sum, p) => sum + p[1], 0) / points.length;
             let previousAngle = null;
             for (const [x, y] of points) {
               const angle = Math.atan2(y - cy, x - cx);
               if (previousAngle !== null) {
                 let delta = angle - previousAngle;
                 while (delta > Math.PI) delta -= 2 * Math.PI;
                 while (delta < -Math.PI) delta += 2 * Math.PI;
                 if (delta < -0.05) windingOk = false;
                 winding += delta;
               }
               previousAngle = angle;
             }
           }
           return {
             left: r.left,
             top: r.top,
             width: r.width,
             height: r.height,
             radius: parseFloat(raw) || 0,
             pathWidth: box ? box.width : 0,
             pathHeight: box ? box.height : 0,
             winding,
             windingOk,
           };
         })()`,
      )
      .catch(() => null);
    if (!rect) return null;
    return {
      window: win,
      island: {
        x: win.x + rect.left,
        y: win.y + rect.top,
        width: rect.width,
        height: rect.height,
        radius: rect.radius,
        pathWidth: rect.pathWidth,
        pathHeight: rect.pathHeight,
        winding: rect.winding,
        windingOk: rect.windingOk,
      },
    };
  };

  // 2) 下课：自动弹出暂存通知的详情
  island.setClassState({ inClass: false, currentPeriodEnd: null, week: 1 });
  await sleep(900);
  const afterClassState = island.getState();
  record(
    '下课后自动弹出通知详情',
    afterClassState.mode === 'expanded' && afterClassState.active?.id === 'smoke-normal-in-class',
    `mode=${afterClassState.mode} active=${afterClassState.active?.id ?? '-'} reason=${afterClassState.reason ?? '-'}`,
  );
  await captureIsland('island-2-after-class', ISLAND_SIZES.expanded);
  // 下面几条要量"紧急 / 叫人"这类**单条**卡片的尺寸与动画，先排空队列：
  // 有多条待处理时岛会走竖排列表形态（高度的算法完全不同，见 4.13 的列表用例）。
  await drainIsland();
  await sleep(400);

  // 3) 上课期间紧急通知：立即展开，无需点击；并采样窗口尺寸证明有"展开动画"
  island.setClassState({ inClass: true, currentPeriodEnd: '08:45', week: 1 });
  await sleep(300);
  const sampledWidths: number[] = [];
  const sampler = setInterval(() => {
    // 新架构：量"岛"在屏幕上的真实宽度（窗口是固定包围盒，形变发生在窗口内）
    void readIslandGeometry()
      .then((geometry) => {
        if (geometry) sampledWidths.push(Math.round(geometry.island.width));
      })
      .catch(() => undefined);
  }, 16);
  island.pushNotification(makeNotification('smoke-urgent-in-class', 'URGENT', '上课期间的紧急通知'), {
    inClass: true,
  });
  await sleep(900);
  clearInterval(sampler);
  const urgentState = island.getState();
  record(
    '上课期间紧急通知立即展开显示详情（无需点击）',
    urgentState.mode === 'expanded' &&
      urgentState.active?.id === 'smoke-urgent-in-class' &&
      urgentState.reason === 'urgent',
    `mode=${urgentState.mode} active=${urgentState.active?.id ?? '-'} reason=${urgentState.reason ?? '-'}`,
  );

  const urgentGeometry = await readIslandGeometry();
  const urgentBounds = urgentGeometry?.island ?? null;
  const rampWidths = [
    ...new Set(sampledWidths.filter((width) => width > 0 && width < ISLAND_URGENT_SIZE.width)),
  ];
  record(
    '紧急通知带展开动画（岛从胶囊尺寸弹簧展开到紧急尺寸）',
    rampWidths.length >= 3 && Math.abs((urgentBounds?.width ?? 0) - ISLAND_URGENT_SIZE.width) <= 2,
    `采样=${sampledWidths.length} 中间尺寸=${rampWidths.length} 最终=${urgentBounds?.width ?? '-'}x${urgentBounds?.height ?? '-'}`,
  );
  await captureIsland('island-3-urgent', ISLAND_URGENT_SIZE);

  // 3.1) 上课期间“收起”紧急通知：只回缩为胶囊且保持可见，并且还能再次展开（回归）
  island.handleAction({ action: 'collapse' });
  await sleep(450);
  const collapsedUrgent = island.getState();
  const collapsedGeometry = await readIslandGeometry();
  record(
    '上课期间紧急通知收起后回缩为胶囊且保持可见',
    collapsedUrgent.mode === 'pill' &&
      (islandWindow?.isVisible() ?? false) &&
      Math.abs((collapsedGeometry?.island.width ?? 0) - ISLAND_SIZES.pill.width) <= 2,
    `mode=${collapsedUrgent.mode} visible=${islandWindow?.isVisible() ?? '-'} ` +
      `岛=${collapsedGeometry?.island.width?.toFixed(0) ?? '-'}x${collapsedGeometry?.island.height?.toFixed(0) ?? '-'}`,
  );
  island.handleAction({ action: 'expand' });
  await sleep(600);
  const reExpanded = island.getState();
  const reExpandedGeometry = await readIslandGeometry();
  record(
    '上课期间紧急通知回收后可再次展开（回归）',
    reExpanded.mode === 'expanded' &&
      reExpanded.active?.id === 'smoke-urgent-in-class' &&
      Math.abs((reExpandedGeometry?.island.width ?? 0) - ISLAND_URGENT_SIZE.width) <= 2,
    `mode=${reExpanded.mode} active=${reExpanded.active?.id ?? '-'} ` +
      `岛=${reExpandedGeometry?.island.width?.toFixed(0) ?? '-'}x${reExpandedGeometry?.island.height?.toFixed(0) ?? '-'}` +
      `（期望 ${ISLAND_URGENT_SIZE.width}）`,
  );
  island.pushNotification(makeNotification('smoke-normal-in-class-2', 'NORMAL', '上课中的普通通知'), {
    inClass: true,
  });
  await sleep(350);
  island.handleAction({ action: 'collapse' });
  await sleep(300);
  const afterNormalPush = island.getState();
  record(
    '上课期间普通通知只进队列（不顶掉正在展示的紧急消息）',
    afterNormalPush.active?.id === 'smoke-urgent-in-class' &&
      afterNormalPush.queued.some((item) => item.id === 'smoke-normal-in-class-2'),
    `active=${afterNormalPush.active?.id ?? '-'} queued=[${afterNormalPush.queued.map((item) => item.id).join(',')}]`,
  );

  // 4) 非上课时段普通通知 → 直接显示胶囊（无入场动画）；点击后展开
  island.setClassState({ inClass: false, currentPeriodEnd: null, week: 1 });
  await sleep(800);
  island.hide();
  await sleep(400);
  // 排空这一节留下的队列：下面断言的是"单条通知的胶囊 / 详情卡"（多条会走列表形态），
  // 顺带等窗口真的隐藏（hiddenBeforePush 才有意义）。
  // 淡出是主进程逐帧 setOpacity 的动画，机器忙时会比固定时长更久，因此轮询等它隐藏。
  await drainIsland();
  let hiddenBeforePush = !(islandWindow?.isVisible() ?? true);
  for (let attempt = 0; attempt < 25 && !hiddenBeforePush; attempt += 1) {
    await sleep(120);
    hiddenBeforePush = !(islandWindow?.isVisible() ?? true);
  }
  island.pushNotification(makeNotification('smoke-normal-free', 'NORMAL', '课间收到的普通通知'), {
    inClass: false,
  });
  await sleep(60);
  const immediateGeometry = await readIslandGeometry();
  const initialIsland = immediateGeometry?.island ?? null;
  await sleep(640);
  const pillState = island.getState();
  record(
    '普通通知直接显示胶囊（无"上岛"入场动画）',
    hiddenBeforePush &&
      pillState.mode === 'pill' &&
      Math.abs((initialIsland?.width ?? 0) - ISLAND_SIZES.pill.width) <= 2 &&
      Math.abs((initialIsland?.height ?? 0) - ISLAND_SIZES.pill.height) <= 2,
    `推送前隐藏=${hiddenBeforePush} 60ms 内岛=${initialIsland?.width?.toFixed(1) ?? '-'}x${initialIsland?.height?.toFixed(1) ?? '-'}` +
      `（期望 ${ISLAND_SIZES.pill.width}x${ISLAND_SIZES.pill.height}）mode=${pillState.mode}`,
  );
  await captureIsland('island-4-pill', ISLAND_SIZES.pill);
  console.log(`[SMOKE] 胶囊态 DOM：${await dumpIslandDom('pill')}`);

  const clicked = await islandWindow?.webContents.executeJavaScript(
    `(() => {
       const pill = document.querySelector('.island-card.pill:not(.hidden-placeholder)');
       if (!pill) return false;
       pill.click();
       return true;
     })()`,
  );
  await sleep(800);
  const expandedState = island.getState();
  record(
    '普通通知先变"新消息"胶囊，点击后展开详情',
    pillState.mode === 'pill' && clicked === true && expandedState.mode === 'expanded',
    `pillMode=${pillState.mode} clicked=${clicked} expandedMode=${expandedState.mode}`,
  );
  await captureIsland('island-5-clicked', ISLAND_SIZES.expanded);

  // 4.1) 展开态的 DOM 结构自检（卡片/标题/操作按钮都要真的渲染出来）
  const domInfo = await islandWindow?.webContents.executeJavaScript(
    `(() => ({
       hasCard: Boolean(document.querySelector('.island-card')),
       title: document.querySelector('.title')?.textContent ?? '',
       hasActions: Boolean(document.querySelector('.solid-btn')),
     }))()`,
  );
  record(
    '灵动岛渲染进程正常绘制（卡片/标题/操作按钮）',
    Boolean(domInfo?.hasCard && domInfo?.title && domInfo?.hasActions),
    `title=${domInfo?.title ?? '-'} actions=${domInfo?.hasActions ?? false}`,
  );

  // 4.2) 点击卡片空白处 → 回缩为胶囊
  const blankClicked = await islandWindow?.webContents.executeJavaScript(
    `(() => {
       const blank = document.querySelector('.island-card.expanded .body');
       if (!blank) return false;
       blank.click();
       return true;
     })()`,
  );
  await sleep(600);
  const afterBlank = island.getState();
  record(
    '点击卡片空白处回缩为胶囊',
    blankClicked === true && afterBlank.mode === 'pill',
    `blankClicked=${blankClicked} mode=${afterBlank.mode}`,
  );

  // 4.3) 点击右上角收起按钮 → 回缩为胶囊
  island.handleAction({ action: 'expand' });
  await sleep(600);
  const chevronClicked = await islandWindow?.webContents.executeJavaScript(
    `(() => {
       const button = document.querySelector('.island-card.expanded .icon-btn');
       if (!button) return false;
       button.click();
       return true;
     })()`,
  );
  await sleep(600);
  const afterChevron = island.getState();
  record(
    '点击右上角收起按钮回缩为胶囊',
    chevronClicked === true && afterChevron.mode === 'pill',
    `chevronClicked=${chevronClicked} mode=${afterChevron.mode}`,
  );

  // 4.4) 新架构（照搬 WinIsland）：窗口是固定包围盒，开合过程中**窗口一帧都不动**，
  //      岛在窗口内做弹簧形变。这里逐帧采样"窗口 + 岛"：窗口必须完全恒定，岛形变必须连续。
  island.handleAction({ action: 'expand' });
  await sleep(700);
  const shrinkSamples: {
    window: string;
    island: string;
    radius: number;
    pathWidth: number;
    pathHeight: number;
    winding?: number;
    windingOk?: boolean;
  }[] = [];
  const shrinkSampler = setInterval(() => {
    void readIslandGeometry()
      .then((geometry) => {
        if (!geometry) return;
        shrinkSamples.push({
          window: `${geometry.window.width}x${geometry.window.height}@${geometry.window.x},${geometry.window.y}`,
          island: `${Math.round(geometry.island.width)}x${Math.round(geometry.island.height)}`,
          radius: Number(geometry.island.radius ?? 0),
          pathWidth: Number(geometry.island.pathWidth ?? 0),
          pathHeight: Number(geometry.island.pathHeight ?? 0),
          winding: Number(geometry.island.winding ?? 0),
          windingOk: geometry.island.windingOk === true,
        });
      })
      .catch(() => undefined);
  }, 40);
  island.handleAction({ action: 'collapse' });
  await sleep(700);
  clearInterval(shrinkSampler);
  await sleep(120);
  const windowSignatures = [...new Set(shrinkSamples.map((item) => item.window))];
  const islandSizes = shrinkSamples.map((item) => item.island);
  const islandWidths = shrinkSamples.map((item) => Number(item.island.split('x')[0]));
  const islandMonotonic = islandWidths.every(
    (width, index) => index === 0 || width <= (islandWidths[index - 1] ?? width) + 1,
  );
  // 画出来的形状必须与卡片框一致：SVG 路径 bbox ≈ 卡片宽高（±2px）。
  // 这能一次性抓住“viewBox/preserveAspectRatio 错位导致形状被缩放或残留角”这类问题。
  const pathFits = shrinkSamples.every(
    (item) =>
      Math.abs(item.pathWidth - Number(item.island.split('x')[0])) <= 2 &&
      Math.abs(item.pathHeight - Number(item.island.split('x')[1])) <= 2,
  );
  // 圆角绕行方向：连续圆角路径必须凸且不自交（|绕行| ≈ 2π）；角的采样写反会在形变中被抓到
  const windingSamples = shrinkSamples.filter((item) => item.windingOk !== undefined);
  const windingOk =
    windingSamples.length > 0 &&
    windingSamples.every((item) => item.windingOk === true) &&
    windingSamples.every((item) => Math.abs(Math.abs(item.winding ?? 0) - Math.PI * 2) < 0.6);
  record(
    '开合过程中窗口全程恒定、岛在窗口内连续形变（照搬 WinIsland 架构）',
    shrinkSamples.length >= 3 && windowSignatures.length === 1 && islandMonotonic && pathFits && windingOk,
    `采样=${shrinkSamples.length} 窗口签名=[${windowSignatures.join(' ')}]（要求只有 1 种） ` +
      `岛尺寸序列=[${islandSizes.slice(0, 8).join('→')}${islandSizes.length > 8 ? '…' : ''}] 单调收缩=${islandMonotonic} ` +
      `形状与卡片框一致=${pathFits} 圆角绕行正确=${windingOk}（|绕行|=${(windingSamples[0]?.winding ?? 0).toFixed(2)}）`,
  );

  // 4.5) 点击屏幕其他位置（窗口失焦）→ 自动回缩为胶囊
  island.handleAction({ action: 'expand' });
  await sleep(700);
  const focusable = islandWindow?.isFocusable() ?? false;
  // "点到别处"的另一半含义是**指针不在岛上**：这里把注入光标放到屏幕左上角（远离岛体），
  // 否则会被下面 4.5.1 的"指针还在岛上 = 假失焦"保护逻辑判为无效失焦。
  island.setHitTestCursor({ x: 1, y: 1 });
  // 程序化触发失焦：等价于用户点到别处（冒烟窗口本身不显示，无法真的点击桌面）
  island.setBlurCollapseEnabled(true); // 这一条专门验证"失焦收起"，先打开该行为
  islandWindow?.emit('blur');
  await sleep(700);
  const afterBlur = island.getState();
  record(
    '点击屏幕任意位置回缩为胶囊（失焦收起；窗口始终可激活）',
    focusable && islandWindow?.isFocusable() === true && afterBlur.mode === 'pill',
    `展开时 focusable=${focusable} 失焦后 mode=${afterBlur.mode} focusable=${islandWindow?.isFocusable() ?? '-'}`,
  );

  // 4.5.2) 胶囊态窗口**必须始终可激活**：Windows 下 WS_EX_NOACTIVATE 且非活动窗口会丢掉
  //        鼠标**按下**事件（实测只到 mouseup、没有 mousedown/click）→ 胶囊"点不动"。
  //        这是用户反馈的根因，用"胶囊态 isFocusable() 必须为 true"固化下来。
  for (let index = 0; index < 10; index += 1) {
    const current = island.getState();
    if (!current.active && current.queued.length === 0) break;
    island.handleAction({ action: 'dismiss' });
    await sleep(120);
  }
  island.pushNotification(makeNotification('smoke-pill-focusable', 'NORMAL', '胶囊可激活校验'), {
    inClass: false,
  });
  await sleep(500);
  const pillFocusState = island.getState();
  record(
    '胶囊态窗口仍可激活（否则 Windows 丢掉 mousedown，胶囊"点不动"）',
    pillFocusState.mode === 'pill' && (islandWindow?.isFocusable() ?? false) === true,
    `mode=${pillFocusState.mode} focusable=${islandWindow?.isFocusable() ?? '-'} 当前是否聚焦=${islandWindow?.isFocused() ?? '-'}`,
  );
  island.handleAction({ action: 'dismiss' });
  await sleep(300);

  // 4.5.1) 展开动作自身引发的**假失焦**不能把刚展开的岛缩回胶囊。
  //        用户复现："收起后再次点击灵动岛没反应" —— 点开胶囊后约 0.5s 被系统收回焦点，
  //        岛立刻缩回胶囊，看起来就像"点了没反应"。此时指针必然还在岛上，必须忽略该失焦。
  island.pushNotification(makeNotification('smoke-phantom-blur', 'NORMAL', '假失焦回归'), {
    inClass: false,
  });
  await sleep(400);
  island.handleAction({ action: 'expand' });
  await sleep(300);
  // 这一条要断言"真实光标命中"，临时恢复真实输入
  island.setTestInputPassthrough(false);
  island.setHitTestCursor(islandCardScreenPoint(0.5, 0.5)); // 指针停在岛上（用户刚点的位置）
  await sleep(160);
  islandWindow?.emit('blur'); // 模拟展开后到达的那次假失焦
  await sleep(500);
  const afterPhantomBlur = island.getState();
  const phantomStillInteractive = island.getInteractive();
  record(
    '假失焦（指针仍在岛上）不回缩：展开后必须保持展开',
    afterPhantomBlur.mode === 'expanded' &&
      afterPhantomBlur.active?.id === 'smoke-phantom-blur' &&
      phantomStillInteractive === true,
    `mode=${afterPhantomBlur.mode} active=${afterPhantomBlur.active?.id ?? '-'} 命中=${phantomStillInteractive}`,
  );
  island.setHitTestCursor(null);
  island.setTestInputPassthrough(true);
  // 清掉这一条通知（队列为空 → 岛自行隐藏），避免影响后续用例的"空闲态"断言
  island.handleAction({ action: 'dismiss' });
  await sleep(400);
  // 其余用例关掉"失焦收起"：避免无关的焦点变化（系统抢焦点等）把展开态收回，干扰断言
  island.setBlurCollapseEnabled(false);

  // 4.6) 新作业上岛（kind=homework）：胶囊 + 展开显示作业要求
  //（截止时间功能已下线：这里同时守住"作业卡上不再出现截止时间"）
  // 先排空队列：单条消息时胶囊标题应是类型名（"新作业"），多条时才汇总成
  // 「新消息：叫人/作业/通知（共 N 条）」——两种情况都要确定性覆盖。
  for (let index = 0; index < 20; index += 1) {
    const current = island.getState();
    if (!current.active && current.queued.length === 0) break;
    island.handleAction({ action: 'dismiss' });
    await sleep(120);
  }
  await sleep(200);
  island.pushNotification(
    {
      ...makeNotification('smoke-homework', 'NORMAL', '第 3 章课后练习'),
      kind: 'homework',
      teacherName: '张老师',
    },
    { inClass: false },
  );
  await sleep(700);
  const homeworkState = island.getState();
  const homeworkDom = await islandWindow?.webContents.executeJavaScript(
    `(() => {
       const card = document.querySelector('.island-card.pill.homework');
       return { cls: card?.className ?? '', title: card?.querySelector('.pill-title')?.textContent?.trim() ?? '' };
     })()`,
  );
  record(
    '新作业发布也上岛（胶囊带"新作业"样式）',
    homeworkState.mode === 'pill' &&
      homeworkState.active?.kind === 'homework' &&
      (homeworkDom?.title ?? '').includes('新作业'),
    `mode=${homeworkState.mode} kind=${homeworkState.active?.kind} 胶囊标题="${homeworkDom?.title ?? '-'}" 类名=${homeworkDom?.cls ?? '-'}`,
  );
  island.handleAction({ action: 'expand' });
  await sleep(700);
  const homeworkCardText = await islandWindow?.webContents.executeJavaScript(
    `document.querySelector('.island-card.expanded')?.innerText?.replace(/\\s+/g, ' ').trim() ?? ''`,
  );
  record(
    '作业详情只显示作业要求（截止时间已下线）',
    (homeworkCardText ?? '').includes('第 3 章课后练习') && !(homeworkCardText ?? '').includes('截止时间'),
    `作业卡文案="${homeworkCardText ?? '-'}"`,
  );
  await captureIsland('island-7-homework', ISLAND_SIZES.expanded);

  // 4.6b) 收起后的胶囊要说明"这批消息里都有什么"：
  //       单条 → 类型名（上面的"新作业"）；多条 → 「新消息：叫人/作业/通知（共 3 条）」+「点击查看」
  island.pushNotification(
    {
      ...makeNotification('smoke-summary-call', 'NORMAL', '请 王小明 同学找 张老师'),
      kind: 'call',
      subtitle: '请尽快前往，收到后点「收到」',
    },
    { inClass: false },
  );
  await sleep(400);
  island.pushNotification(makeNotification('smoke-summary-notice', 'NORMAL', '类型汇总校验'), {
    inClass: false,
  });
  await sleep(600);
  const summaryDom = await islandWindow?.webContents.executeJavaScript(
    `(() => {
       const card = document.querySelector('.island-card.pill');
       return {
         title: card?.querySelector('.pill-title')?.textContent?.trim() ?? '',
         sub: card?.querySelector('.pill-sub')?.textContent?.trim() ?? '',
         types: Array.from(card?.querySelectorAll('.pill-type') ?? []).map((node) => node.textContent.trim()),
       };
     })()`,
  );
  const summaryState = island.getState();
  record(
    '收起胶囊显示通知类型汇总（新消息：叫人/作业/通知（共 N 条））',
    (summaryDom?.title ?? '').includes('新消息：') &&
      (summaryDom?.title ?? '').includes('叫人') &&
      (summaryDom?.title ?? '').includes('作业') &&
      (summaryDom?.title ?? '').includes('通知') &&
      (summaryDom?.title ?? '').includes('共 3 条') &&
      (summaryDom?.sub ?? '').includes('点击查看') &&
      (summaryDom?.types ?? []).length === 3 &&
      summaryState.mode === 'pill',
    `标题="${summaryDom?.title ?? '-'}" 副标题="${summaryDom?.sub ?? '-'}" ` +
      `类型标签=[${(summaryDom?.types ?? []).join(',')}] mode=${summaryState.mode}`,
  );
  island.handleAction({ action: 'dismiss' });
  await sleep(300);

  // 4.7) "紧急叫人"：URGENT + kind=call → 上课时段也立即展开
  // 先排空（上一条"类型汇总"用例留下的通知还在队列里，否则这里量到的是列表高度）
  await drainIsland();
  await sleep(400);
  island.setClassState({ inClass: true, currentPeriodEnd: '08:45', week: 1 });
  await sleep(400);
  island.pushNotification(
    {
      ...makeNotification('smoke-call', 'URGENT', '请 王小明 同学找 张老师'),
      kind: 'call',
      subtitle: '请尽快前往，收到后点「收到」',
      teacherName: '张老师',
    },
    { inClass: true },
  );
  // 采样状态轨迹，便于定位"出现了又被隐藏"这类时序问题
  const callTrace: string[] = [];
  for (let index = 0; index < 9; index += 1) {
    await sleep(100);
    const snapshot = island.getState();
    callTrace.push(`${snapshot.mode}/${snapshot.reason ?? '-'}`);
  }
  const callState = island.getState();
  const callDom = await islandWindow?.webContents.executeJavaScript(
    `(() => ({
       badge: document.querySelector('.island-card.expanded .badge')?.textContent?.trim() ?? '',
       title: document.querySelector('.island-card.expanded .title')?.textContent?.trim() ?? '',
       solid: document.querySelector('.island-card.expanded .solid-btn')?.textContent?.trim() ?? '',
       hint: document.querySelector('.island-card.expanded .call-hint')?.textContent?.trim() ?? '',
       cls: document.querySelector('.island-card.expanded')?.className ?? '',
     }))()`,
  );
  record(
    '紧急叫人消息上岛（上课时段也立即展开，无需点击）',
    callState.mode === 'expanded' &&
      callState.active?.kind === 'call' &&
      callState.reason === 'call' &&
      callState.inClass === true &&
      (callDom?.title ?? '').includes('请') &&
      (callDom?.title ?? '').includes('找'),
    `mode=${callState.mode} kind=${callState.active?.kind} reason=${callState.reason} 上课中=${callState.inClass} ` +
      `徽标=${callDom?.badge} 标题="${callDom?.title}" 按钮=${callDom?.solid}`,
  );
  await captureIsland('island-8-call', ISLAND_CALL_SIZE);

  // 4.7b) 紧急叫人"收起 → 再次点开"（用户复现路径：点击缩回后也无法点开）
  await islandWindow?.webContents
    .executeJavaScript(
      `(() => {
         document.querySelector('.island-card')?.click();
         return true;
       })()`,
    )
    .catch(() => undefined);
  await sleep(600);
  const urgentCallCollapsed = island.getState();
  await islandWindow?.webContents
    .executeJavaScript(
      `(() => {
         document.querySelector('.island-card')?.click();
         return true;
       })()`,
    )
    .catch(() => undefined);
  await sleep(700);
  const urgentCallReopened = island.getState();
  record(
    '紧急叫人收起后可再次点开（用户复现路径）',
    urgentCallCollapsed.mode === 'pill' &&
      urgentCallReopened.mode === 'expanded' &&
      urgentCallReopened.active?.id === 'smoke-call',
    `收起后=${urgentCallCollapsed.mode} 再次点开=${urgentCallReopened.mode} ` +
      `active=${urgentCallReopened.active?.id ?? '-'}`,
  );

  // 4.8) "普通叫人"：kind=call 但 priority=HIGH（服务端 urgent 缺省）→ **不自动展开**（不打断课堂），
  //      但上课时段仍以胶囊保持可见，并且必须能点开（用户反馈："非紧急叫人无法点开灵动岛"）。
  island.handleAction({ action: 'dismiss' });
  await sleep(300);
  island.pushNotification(
    {
      ...makeNotification('smoke-call-normal', 'HIGH', '请 王小明 同学找 张老师'),
      kind: 'call',
      subtitle: '请尽快前往，收到后点「收到」',
    },
    { inClass: true },
  );
  await sleep(500);
  const normalCallState = island.getState();
  const normalCallVisible = islandWindow?.isVisible() ?? false;
  record(
    '普通叫人上课时段只显示胶囊（不自动展开、不打断课堂）',
    normalCallState.mode === 'pill' &&
      normalCallState.active?.id === 'smoke-call-normal' &&
      normalCallState.reason === 'call' &&
      normalCallVisible,
    `mode=${normalCallState.mode} reason=${normalCallState.reason} 可见=${normalCallVisible} ` +
      `active=${normalCallState.active?.id ?? '-'}`,
  );
  // 上课时段点开普通叫人：必须能展开（这正是用户复现的那条路径）
  await islandWindow?.webContents
    .executeJavaScript(
      `(() => {
         document.querySelector('.island-card')?.click();
         return true;
       })()`,
    )
    .catch(() => undefined);
  await sleep(700);
  const normalCallOpened = island.getState();
  record(
    '普通叫人上课时段可以点开（用户复现路径）',
    normalCallOpened.mode === 'expanded' && normalCallOpened.active?.id === 'smoke-call-normal',
    `点击后 mode=${normalCallOpened.mode} active=${normalCallOpened.active?.id ?? '-'}`,
  );
  // 再收起 → 仍是胶囊（保持可见、可再次点开），下课后自动展开
  await island.handleAction({ action: 'collapse' });
  await sleep(500);
  const normalCallCollapsed = island.getState();
  record(
    '普通叫人收起后仍保留胶囊（可再次点开）',
    normalCallCollapsed.mode === 'pill' && normalCallCollapsed.active?.id === 'smoke-call-normal',
    `mode=${normalCallCollapsed.mode} active=${normalCallCollapsed.active?.id ?? '-'}`,
  );
  island.setClassState({ inClass: false, currentPeriodEnd: null, week: 1 });
  await sleep(600);
  const afterClassCall = island.getState();
  record(
    '下课后普通叫人自动弹出详情（叫人文案不丢）',
    afterClassCall.mode === 'expanded' && afterClassCall.active?.id === 'smoke-call-normal',
    `mode=${afterClassCall.mode} active=${afterClassCall.active?.id ?? '-'} kind=${afterClassCall.active?.kind}`,
  );
  island.handleAction({ action: 'dismiss' });
  await sleep(400);
  island.setClassState({ inClass: false, currentPeriodEnd: null, week: 1 });
  await sleep(400);

  /** 读展开卡里的"列表形态"关键信息（行数/提示行/卡片高度），供 4.8 的多条通知用例断言 */
  const readListCard = async (): Promise<{
    isList: boolean;
    rows: number;
    titles: string[];
    more: boolean;
    app: string;
    cardHeight: number;
  } | null> =>
    (await islandWindow?.webContents
      .executeJavaScript(
        `(() => {
           const card = document.querySelector('.island-card.expanded');
           if (!card) return null;
           const rows = Array.from(card.querySelectorAll('.list-row'));
           return {
             isList: Boolean(card.querySelector('.expanded-layer.list-mode')),
             rows: rows.length,
             titles: rows.map((node) => node.querySelector('.row-title')?.textContent?.trim() ?? ''),
             more: Boolean(card.querySelector('.more-btn')),
             app: card.querySelector('.more-app')?.textContent?.trim() ?? '',
             cardHeight: Math.round(card.getBoundingClientRect().height),
           };
         })()`,
      )
      .catch(() => null)) ?? null;

  /*
    4.8) 多条通知：展开后**竖向排列**（用户要求）
    - 默认按重要程度排列（紧急 > 重要 > 普通 > 低，同级按时间新的在前）；
    - 默认只显示前三条，下面一行「展开更多（还有 N 条）」；
    - 点"展开更多"把放得下的都铺出来；屏幕到任务栏放不下时改为「更多请前往应用内操作」；
    - 按钮只有一排：点「知道了」整批关闭；点「标为已读」整批已读。
  */
  await drainIsland();
  await sleep(400);
  island.setClassState({ inClass: false, currentPeriodEnd: null, week: 1 });
  await sleep(300);
  // 优先级故意乱序推送：排列顺序只能来自"按重要程度"，不是推送顺序
  const listIds = [
    'smoke-list-normal',
    'smoke-list-low',
    'smoke-list-urgent',
    'smoke-list-homework',
    'smoke-list-high',
  ];
  island.pushNotification(makeNotification(listIds[0]!, 'NORMAL', '列表-普通通知'), { inClass: false });
  await sleep(120);
  island.pushNotification(makeNotification(listIds[1]!, 'LOW', '列表-低优先级通知'), { inClass: false });
  await sleep(120);
  island.pushNotification(makeNotification(listIds[2]!, 'URGENT', '列表-紧急通知'), { inClass: false });
  await sleep(120);
  island.pushNotification(
    { ...makeNotification(listIds[3]!, 'NORMAL', '列表-新作业'), kind: 'homework' },
    { inClass: false },
  );
  await sleep(120);
  island.pushNotification(makeNotification(listIds[4]!, 'HIGH', '列表-重要通知'), { inClass: false });
  await sleep(700);
  const listPillDom = await islandWindow?.webContents.executeJavaScript(
    `document.querySelector('.island-card.pill .pill-title')?.textContent?.trim() ?? ''`,
  );
  island.handleAction({ action: 'expand' });
  await sleep(900);
  const listState = island.getState();
  const listDom = (await islandWindow?.webContents.executeJavaScript(
    `(() => {
       const card = document.querySelector('.island-card.expanded');
       const rows = Array.from(card?.querySelectorAll('.list-row') ?? []);
       return {
         isList: Boolean(card?.querySelector('.expanded-layer.list-mode')),
         rows: rows.length,
         titles: rows.map((node) => node.querySelector('.row-title')?.textContent?.trim() ?? ''),
         more: card?.querySelector('.more-btn')?.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
         app: card?.querySelector('.more-app')?.textContent?.trim() ?? '',
         cardHeight: Math.round(card?.getBoundingClientRect().height ?? 0),
       };
     })()`,
  )) as {
    isList: boolean;
    rows: number;
    titles: string[];
    more: string;
    app: string;
    cardHeight: number;
  } | null;
  const expectedHeight = expectedListHeight(listState);
  record(
    '多条通知竖向排列：按重要程度排序、只显示前三条 + 「展开更多」',
    listState.mode === 'expanded' &&
      (listPillDom ?? '').includes('共 5 条') &&
      listDom?.isList === true &&
      listDom.rows === 3 &&
      (listDom.titles[0] ?? '').includes('紧急') &&
      (listDom.titles[1] ?? '').includes('重要') &&
      (listDom.more ?? '').includes('展开更多') &&
      (listDom.more ?? '').includes('还有 2 条') &&
      Math.abs(listDom.cardHeight - expectedHeight) <= 2,
    `胶囊汇总="${listPillDom ?? '-'}" 列表=${listDom?.rows ?? '-'} 条 顺序=[${(listDom?.titles ?? []).join(' / ')}] ` +
      `提示="${listDom?.more ?? listDom?.app ?? '-'}" 卡片高=${listDom?.cardHeight ?? '-'}（算法=${expectedHeight.toFixed(1)}）`,
  );
  await captureIsland('island-9-list', {
    width: ISLAND_SIZES.expanded.width,
    height: expectedHeight,
  });

  // 4.8b) 点"展开更多"：5 条全部铺出来，提示行随之消失
  const moreClicked = await islandWindow?.webContents.executeJavaScript(
    `(() => {
       const button = document.querySelector('.island-card.expanded .more-btn');
       if (!button) return false;
       button.click();
       return true;
     })()`,
  );
  await sleep(900);
  const expandedListState = island.getState();
  const expandedListDom = (await islandWindow?.webContents.executeJavaScript(
    `(() => {
       const card = document.querySelector('.island-card.expanded');
       return {
         rows: card?.querySelectorAll('.list-row').length ?? 0,
         more: Boolean(card?.querySelector('.more-btn')),
         app: Boolean(card?.querySelector('.more-app')),
         cardHeight: Math.round(card?.getBoundingClientRect().height ?? 0),
       };
     })()`,
  )) as { rows: number; more: boolean; app: boolean; cardHeight: number } | null;
  record(
    '点「展开更多」铺出全部通知（提示行消失、卡片按算法长高）',
    moreClicked === true &&
      expandedListState.listExpanded === true &&
      expandedListDom?.rows === 5 &&
      expandedListDom.more === false &&
      expandedListDom.app === false &&
      Math.abs((expandedListDom?.cardHeight ?? 0) - expectedListHeight(expandedListState)) <= 2,
    `点击=${moreClicked} 行数=${expandedListDom?.rows ?? '-'} 提示=${expandedListDom?.more ? '展开更多' : expandedListDom?.app ? '前往应用内' : '无'} ` +
      `卡片高=${expandedListDom?.cardHeight ?? '-'}（算法=${expectedListHeight(expandedListState).toFixed(1)}）`,
  );

  // 4.8c) 通知多到屏幕放不下：卡片不许硬撑到屏幕外（会盖住任务栏），
  //       点"展开更多"后剩余部分改成「更多请前往应用内操作」，并停在可用高度以内。
  for (let index = 0; index < 25; index += 1) {
    island.pushNotification(
      makeNotification(`smoke-list-many-${index}`, 'NORMAL', `列表-批量通知 ${index + 1}`),
      { inClass: false },
    );
  }
  await sleep(700);
  island.handleAction({ action: 'expand' });
  await sleep(900);
  const manyState = island.getState();
  const manyBefore = await readListCard();
  const manyMoreClicked = await islandWindow?.webContents.executeJavaScript(
    `(() => {
       const button = document.querySelector('.island-card.expanded .more-btn');
       if (!button) return false;
       button.click();
       return true;
     })()`,
  );
  await sleep(1200);
  const manyAfter = await readListCard();
  const maxRowsLayout = islandListLayout({
    count: pendingCountOf(manyState),
    fontSize: island.getAppearance().fontSize,
    maxHeight: manyState.maxCardHeight,
    expanded: true,
  });
  record(
    '通知多到屏幕放不下：点「展开更多」铺到可用高度为止，其余提示「更多请前往应用内操作」',
    manyMoreClicked === true &&
      (manyAfter?.app ?? '').includes('更多请前往应用内操作') &&
      manyAfter?.more === false &&
      manyAfter?.rows === maxRowsLayout.rows &&
      (manyAfter?.rows ?? 0) > (manyBefore?.rows ?? 0) &&
      (manyAfter?.cardHeight ?? 0) <= manyState.maxCardHeight + 1,
    `共 ${pendingCountOf(manyState)} 条：展开前 ${manyBefore?.rows ?? '-'} 行（卡片 ${manyBefore?.cardHeight ?? '-'}）→ ` +
      `展开后 ${manyAfter?.rows ?? '-'} 行（算法 ${maxRowsLayout.rows}，卡片 ${manyAfter?.cardHeight ?? '-'} ≤ 可用高 ${manyState.maxCardHeight}）` +
      `，提示="${manyAfter?.app ?? '-'}"`,
  );

  // 4.8d) 一排按钮：点「知道了」整批关闭，并且**有收回动画**（窗口在动画期间保持可见，随后淡出隐藏）
  /**
   * 收回动画期间逐帧采样"卡片有没有被窗口裁掉"。
   * 用户反馈的症状："上半剩一个圆角，下半直接截断" = 窗口比卡片矮、底部被窗口平切
   * （触摸模式下窗口贴合岛体，若在卡片还很大时就按胶囊尺寸收窗口就会这样）。
   */
  /** 逐帧采样"卡片是否被窗口裁掉"（可复用到触摸模式的收回用例） */
  const probeClosingClipInto = async (sink: { shots: number; maxOverflow: number }): Promise<void> => {
    const bounds = islandWindow?.getBounds();
    const rect = await islandWindow?.webContents
      .executeJavaScript(
        `(() => {
           const card = document.querySelector('.island-card');
           if (!card) return null;
           const r = card.getBoundingClientRect();
           return { top: r.top, bottom: r.bottom };
         })()`,
      )
      .catch(() => null);
    if (!bounds || !rect) return;
    sink.shots += 1;
    sink.maxOverflow = Math.max(sink.maxOverflow, Math.max(0, -rect.top, rect.bottom - bounds.height));
  };
  const closingClip = { shots: 0, maxOverflow: 0 };
  const probeClosingClip = (): Promise<void> => probeClosingClipInto(closingClip);
  const batchDismissClicked = await islandWindow?.webContents.executeJavaScript(
    `(() => {
       const button = document.querySelector('.island-card.expanded .solid-btn');
       if (!button) return false;
       button.click();
       return true;
     })()`,
  );
  await sleep(120);
  const duringClose = { state: island.getState() };
  for (let attempt = 0; attempt < 26; attempt += 1) {
    await probeClosingClip();
    await sleep(40);
  }
  const afterClose = {
    visible: islandWindow?.isVisible() ?? false,
    state: island.getState(),
  };
  record(
    '多条通知点「知道了」：整批关闭（状态同步清空，窗口淡出隐藏）',
    batchDismissClicked === true &&
      duringClose.state.active === null &&
      duringClose.state.queued.length === 0 &&
      afterClose.state.mode === 'hidden' &&
      !afterClose.visible,
    `点击=${batchDismissClicked} 点击后 120ms 剩余=${pendingCountOf(duringClose.state)} ` +
      `结束后=mode:${afterClose.state.mode}/可见:${afterClose.visible}`,
  );
  /*
    4.8d.2) 触摸模式下"收起"（展开卡 → 胶囊）时的**逐帧残影检查**。

    触摸模式下窗口是"贴合岛体"的：收起时卡片缩小、窗口跟着收小，中心停靠下窗口的左右边都要移动，
    "让出去"的区域理论上会露出桌面 —— 若那里留着上一帧（DWM 还没重画），用户就会看到"闪一下/旧内容重影"。
    这里在岛底下垫一块**已知颜色的底板**，逐帧统计"窗口矩形内、卡片矩形外"出现非底板色的像素数：
    该带本该 100% 是底板色，出现岛像素即残影（用户反馈的"一缩回就出问题"正是这一类）。
  */
  island.setTouchMode(true);
  await sleep(300);
  island.pushNotification(
    { ...makeNotification('smoke-touch-collapse', 'URGENT', '触摸模式收起残影校验'), teacherName: '张老师' },
    { inClass: false },
  );
  await sleep(800);
  island.handleAction({ action: 'expand' });
  await sleep(900);
  const collapseBackdropWin = await ensureIslandBackdropWindow();
  const collapseWinBox = island.getWindowBounds();
  const collapsePad = 60;
  collapseBackdropWin.setBounds({
    x: collapseWinBox.x - collapsePad,
    y: collapseWinBox.y - collapsePad,
    width: collapseWinBox.width + collapsePad * 2,
    height: collapseWinBox.height + collapsePad * 2,
  });
  collapseBackdropWin.showInactive();
  collapseBackdropWin.moveTop();
  islandWindow?.moveTop();
  await sleep(320);

  const displayForCollapse = screen.getPrimaryDisplay();
  const shotScaleGuess = displayForCollapse.scaleFactor || 1;
  const collapseShotSize = {
    width: Math.round(displayForCollapse.size.width * shotScaleGuess),
    height: Math.round(displayForCollapse.size.height * shotScaleGuess),
  };
  const grabScreen = async (): Promise<Electron.NativeImage | null> => {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: collapseShotSize,
    });
    const source =
      sources.find((item) => String(item.display_id) === String(displayForCollapse.id)) ?? sources[0];
    return source ? source.thumbnail : null;
  };
  /** 窗口矩形内、卡片矩形外的"非底板色"像素数（= 残影） */
  const ringResidue = (
    bitmap: Buffer,
    shotScale: number,
    card: { x: number; y: number; width: number; height: number },
    winRect: { x: number; y: number; width: number; height: number },
  ): number => {
    const px = (v: number): number => Math.round(v * shotScale);
    const fromX = px(winRect.x);
    const fromY = px(winRect.y);
    const toX = px(winRect.x + winRect.width);
    const toY = px(winRect.y + winRect.height);
    const cardBox = { x: px(card.x), y: px(card.y), w: px(card.width), h: px(card.height) };
    let count = 0;
    for (let y = Math.max(0, fromY); y < Math.min(collapseShotSize.height, toY); y += 2) {
      for (let x = Math.max(0, fromX); x < Math.min(collapseShotSize.width, toX); x += 2) {
        if (x >= cardBox.x && x <= cardBox.x + cardBox.w && y >= cardBox.y && y <= cardBox.y + cardBox.h) continue;
        const index = (y * collapseShotSize.width + x) * 4;
        if (index + 3 >= bitmap.length) continue;
        const b = bitmap[index];
        const g = bitmap[index + 1];
        const r = bitmap[index + 2];
        // 与**底板自身颜色**比对：明显偏离才算"岛像素"（底板是深色，不能按"深色=岛"判）
        const bg = ISLAND_BACKDROP_COLOR_RGB;
        if (Math.abs(r - bg.r) + Math.abs(g - bg.g) + Math.abs(b - bg.b) > 90) count += 1;
      }
    }
    return count;
  };
  const collapseResidue = { shots: 0, max: 0 };
  await islandWindow?.webContents.executeJavaScript(
    `(() => {
       const button = document.querySelector('.island-card.expanded .icon-btn');
       if (button) button.click();
       return Boolean(button);
     })()`,
  );
  for (let attempt = 0; attempt < 22; attempt += 1) {
    const image = await grabScreen();
    const geometry = await readIslandGeometryFrom(islandWindow!);
    if (image && geometry) {
      collapseResidue.shots += 1;
      const bitmap = image.toBitmap();
      const shotScale = image.getSize().width / Math.max(1, displayForCollapse.size.width);
      collapseResidue.max = Math.max(
        collapseResidue.max,
        ringResidue(bitmap, shotScale, geometry.island, geometry.window),
      );
    }
    await sleep(30);
  }
  record(
    '触摸模式收起：窗口带内不出现残影（垫底板逐帧检查，窗口让出的区域不留上一帧）',
    collapseResidue.shots >= 4 && collapseResidue.max <= 400,
    `${collapseResidue.shots} 帧采样，窗口带内岛像素峰值=${collapseResidue.max}（该带本该全是底板色）`,
  );
  island.setTouchMode(false);
  await sleep(200);
  island.handleAction({ action: 'dismiss' });
  await sleep(400);

  // 形态变化全程卡片不许被窗口裁切（用户反馈："上半剩圆角、下半被平切"）
  record(
    '整批关闭过程中卡片不被窗口裁切（上半圆角、下半也是圆角）',
    closingClip.shots >= 5 && closingClip.maxOverflow <= 1,
    `${closingClip.shots} 帧采样，最大越界=${closingClip.maxOverflow.toFixed(1)}px（要求 ≤ 1px，即卡片完整落在窗口内）`,
  );

  await drainIsland();
  await sleep(400);
  island.setClassState({ inClass: false, currentPeriodEnd: null, week: 1 });
  await sleep(300);

  // 4.9) 收起态回归（用户反馈"收起后部分情况无法再次打开"）：
  //      a) 胶囊不再因超时消失（有未处理通知时常驻）；
  //      b) 收起后胶囊仍然可命中（窗口保持可交互）→ 点击可再次展开；
  //      c) 空闲细缝态同样是"可见即可点"（细缝 6x22 也能命中）。
  const drainForCollapseCheck = drainIsland;
  /** 合成"指针移到卡片上"：命中测试由渲染进程按指针位置决定（真实场景由系统转发 mousemove） */
  const hoverCard = async (): Promise<boolean> =>
    Boolean(
      await islandWindow?.webContents
        .executeJavaScript(
          `(() => {
             const card = document.querySelector('.island-card');
             if (!card) return false;
             const r = card.getBoundingClientRect();
             window.dispatchEvent(
               new MouseEvent('mousemove', {
                 clientX: r.left + r.width / 2,
                 clientY: r.top + r.height / 2,
                 bubbles: true,
               }),
             );
             return true;
           })()`,
        )
        .catch(() => false),
    );
  await drainForCollapseCheck();
  await sleep(300);
  island.pushNotification(makeNotification('smoke-collapse-reopen', 'NORMAL', '收起态回归校验'), {
    inClass: false,
  });
  await sleep(500);
  const collapseBefore = island.getState();
  await hoverCard();
  await sleep(200);
  await sleep(ISLAND_TIMEOUTS.pill + 700);
  const lingered = island.getState();
  const lingeredVisible = islandWindow?.isVisible() ?? false;
  // 断言"没有消失"即可：真人可能在这 15 秒里点了岛（那就从胶囊变成展开态），
  // 但只要还看得见、还是同一条通知，就说明"常驻"成立。
  record(
    '收起后胶囊常驻（超时不再消失，随时可再次点开）',
    collapseBefore.mode === 'pill' &&
      lingered.mode !== 'hidden' &&
      lingeredVisible &&
      lingered.active?.id === 'smoke-collapse-reopen',
    `收起前=${collapseBefore.mode} 超时后=${lingered.mode} 可见=${lingeredVisible} ` +
      `active=${lingered.active?.id ?? '-'}`,
  );
  // 先确保处于胶囊态（真人在等待期间可能点开过），再验证"命中恢复 + 点击展开"
  island.handleAction({ action: 'collapse' });
  await sleep(500);
  // 命中兜底：把窗口显式置为"穿透"，再把光标位置注入到胶囊中心 ——
  // 主进程每 120ms 按光标校正一次命中，必须自己恢复（这正是"点开再收起后点不开"的兜底修复）。
  // 先把光标注入到屏幕左上角（等价于指针离开岛体），否则轮询会立刻把命中又打开。
  island.setHitTestCursor({ x: 1, y: 1 });
  await sleep(260);
  island.setInteractive(false);
  await sleep(60);
  const forcedThrough = island.getInteractive();
  const pillPoint = islandCardScreenPoint(0.5, 0.5);
  island.setHitTestCursor(pillPoint);
  await sleep(260);
  const interactiveWhilePill = island.getInteractive();
  // 点击前记录渲染进程当前形态：若渲染进程停在 expanded（状态推送滞后），
  // 合成点击会被解释成"点空白处 → 收起"，表现为"点了没反应"，这里留证据便于定位。
  const classBeforeClick = await islandWindow?.webContents
    .executeJavaScript(`document.querySelector('.island-card')?.className ?? '-'`)
    .catch(() => '-');
  await islandWindow?.webContents
    .executeJavaScript(
      `(() => {
         document.querySelector('.island-card')?.click();
         return true;
       })()`,
    )
    .catch(() => undefined);
  // 轮询等待主进程状态落到 expanded（不同环境 IPC/动画耗时不同，固定 sleep 会误判）
  let reopened = island.getState();
  for (let attempt = 0; attempt < 12 && reopened.mode !== 'expanded'; attempt += 1) {
    await sleep(120);
    reopened = island.getState();
  }
  const classAfterClick = await islandWindow?.webContents
    .executeJavaScript(`document.querySelector('.island-card')?.className ?? '-'`)
    .catch(() => '-');
  record(
    '收起态点击可再次展开（胶囊命中恢复 + 点击后展开）',
    forcedThrough === false &&
      interactiveWhilePill === true &&
      reopened.mode === 'expanded' &&
      reopened.active?.id === 'smoke-collapse-reopen',
    `置穿透后=${forcedThrough} 光标在胶囊上时=${interactiveWhilePill} ` +
      `点击前渲染类名=${classBeforeClick} 点击后 mode=${reopened.mode} ` +
      `active=${reopened.active?.id ?? '-'} 点击后渲染类名=${classAfterClick}`,
  );

  const sliverForInteractive = getSliverSize();
  island.setAppearance({ ...island.getAppearance(), idleSliver: true });
  await sleep(200);
  await drainForCollapseCheck();
  await sleep(500);
  const sliverState = island.getState();
  island.setHitTestCursor(islandCardScreenPoint(0.5, 0.5));
  await sleep(260);
  const sliverInteractive = island.getInteractive();
  const sliverVisible = islandWindow?.isVisible() ?? false;
  // 光标移开细缝（屏幕左上角）→ 命中必须撤销，避免细缝窗口吞掉桌面点击
  island.setHitTestCursor({ x: 1, y: 1 });
  await sleep(260);
  const sliverInteractiveOutside = island.getInteractive();
  record(
    '空闲细缝态命中跟随光标（细缝上可点、移开即穿透）',
    sliverState.mode === 'hidden' &&
      sliverVisible &&
      sliverInteractive === true &&
      sliverInteractiveOutside === false,
    `mode=${sliverState.mode} 可见=${sliverVisible} 光标在细缝上=${sliverInteractive} ` +
      `光标移开=${sliverInteractiveOutside} 细缝=${sliverForInteractive.width}x${sliverForInteractive.height}`,
  );
  island.setHitTestCursor(null);
  island.setAppearance({ ...island.getAppearance(), idleSliver: false });
  await drainForCollapseCheck();
  await sleep(300);

  // 4.10) 用户复现路径："点开灵动岛再收起就无法再次打开了"
  //       之前是一条"展开 → 收起 → 再也点不开"的死路（窗口停在穿透状态）。
  //       这里用真实 DOM 点击走完 展开 → 收起 → 再次展开，并断言每个形态都有命中框上报。
  const clickIsland = async (selector = '.island-card'): Promise<boolean> =>
    Boolean(
      await islandWindow?.webContents
        .executeJavaScript(
          `(() => {
             const node = document.querySelector(${JSON.stringify(selector)});
             if (!node) return false;
             node.click();
             return true;
           })()`,
        )
        .catch(() => false),
    );
  const rectText = (rect: { width: number; height: number } | null): string =>
    rect ? `${Math.round(rect.width)}x${Math.round(rect.height)}` : '无';
  await drainForCollapseCheck();
  await sleep(300);
  island.pushNotification(makeNotification('smoke-reopen-roundtrip', 'NORMAL', '展开收起再展开'), {
    inClass: false,
  });
  await sleep(500);
  const clickedFirst = await clickIsland();
  await sleep(700);
  const afterFirstOpen = island.getState();
  const hitRectExpanded = island.getHitRect();
  const clickedCollapse = await clickIsland('.island-card.expanded .body');
  await sleep(700);
  const afterCollapse = island.getState();
  const hitRectPill = island.getHitRect();
  const clickedSecond = await clickIsland();
  await sleep(750);
  const afterSecondOpen = island.getState();
  record(
    '展开 → 收起 → 再次展开（用户复现路径）',
    clickedFirst &&
      clickedCollapse &&
      clickedSecond &&
      afterFirstOpen.mode === 'expanded' &&
      afterCollapse.mode === 'pill' &&
      afterSecondOpen.mode === 'expanded' &&
      afterSecondOpen.active?.id === 'smoke-reopen-roundtrip' &&
      hitRectExpanded !== null &&
      hitRectPill !== null,
    `${afterFirstOpen.mode}（命中框 ${rectText(hitRectExpanded)}） → ${afterCollapse.mode}` +
      `（命中框 ${rectText(hitRectPill)}） → ${afterSecondOpen.mode}` +
      ` active=${afterSecondOpen.active?.id ?? '-'}`,
  );
  // 主进程的命中兜底轮询：岛体矩形必须随形态更新（指针交给系统，这里只断言"依据"是对的）
  await island.handleAction({ action: 'collapse' });
  // 岛体矩形由渲染进程在形变过程中上报；置顶透明小窗的 rAF 在自动化会话里会被限流，
  // 形变可能要等渲染进程的兜底 snap（1.2s）才收敛，所以这里轮询等它变小，而不是死等 500ms。
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const rect = island.getHitRect();
    if (rect && Math.abs(rect.width - ISLAND_SIZES.pill.width) <= 2) break;
    await sleep(120);
  }
  const hitRectCollapsed = island.getHitRect();
  record(
    '命中兜底：岛体矩形随形态更新（供主进程按光标校正）',
    hitRectCollapsed !== null &&
      Math.abs(hitRectCollapsed.width - ISLAND_SIZES.pill.width) <= 2 &&
      hitRectExpanded !== null &&
      hitRectExpanded.width > hitRectCollapsed.width,
    `展开 ${rectText(hitRectExpanded)} → 收起 ${rectText(hitRectCollapsed)}（期望 ${ISLAND_SIZES.pill.width}）`,
  );
  // 彻底隐藏（无细缝）时必须撤销命中框，避免"看不见的窗口吞桌面点击"
  await drainForCollapseCheck();
  await sleep(600);
  const hitRectHidden = island.getHitRect();
  record(
    '彻底隐藏时撤销命中框（不吞桌面点击）',
    island.getState().mode === 'hidden' && hitRectHidden === null,
    `mode=${island.getState().mode} 命中框=${rectText(hitRectHidden)}`,
  );

  // 4.11) 设置页"预览效果"（用户反馈：预览无法正常展开示例岛）
  //       预览必须直接展开、失焦不收起（用户调滑块时主窗口一直是焦点），并在到点后自行消失。
  await drainForCollapseCheck();
  await sleep(300);
  island.pushNotification(
    {
      ...makeNotification('appearance-test-smoke', 'NORMAL', '灵动岛外观预览'),
      content: '拖动滑块即可实时预览。',
      teacherName: '本地预览',
    },
    { inClass: false, preview: true },
  );
  await sleep(700);
  const previewState = island.getState();
  const previewVisible = islandWindow?.isVisible() ?? false;
  const previewGeometry = await readIslandGeometry();
  // 失焦（等价于用户回到设置页拖滑块）不应把示例岛收起来
  islandWindow?.emit('blur');
  await sleep(700);
  const previewAfterBlur = island.getState();
  record(
    '设置页预览：示例岛直接展开且失焦不收起',
    previewState.mode === 'expanded' &&
      previewState.active?.id === 'appearance-test-smoke' &&
      previewVisible &&
      (previewGeometry?.island.width ?? 0) > ISLAND_SIZES.pill.width &&
      previewAfterBlur.mode === 'expanded',
    `预览态=${previewState.mode} 可见=${previewVisible} 岛宽=${previewGeometry?.island.width?.toFixed(0) ?? '-'}` +
      ` 失焦后=${previewAfterBlur.mode}`,
  );
  // 预览通知不该被"常驻胶囊"逻辑留下：点"知道了"后必须彻底消失
  island.handleAction({ action: 'dismiss' });
  await sleep(600);
  const previewDismissed = island.getState();
  record(
    '设置页预览：关掉后不残留（不会变成常驻胶囊）',
    previewDismissed.mode === 'hidden' && previewDismissed.active === null,
    `mode=${previewDismissed.mode} active=${previewDismissed.active?.id ?? '-'}`,
  );

  // 4.12) 用户复现路径：紧急通知 + 新作业（联合通知）时，收起后点击必须能打开**新作业**
  //       之前 active 仍是紧急那条，点击只会反复打开紧急，表现为"点不开新作业"。
  await drainForCollapseCheck();
  await sleep(300);
  island.setClassState({ inClass: true, currentPeriodEnd: '08:45', week: 1 });
  await sleep(300);
  island.pushNotification(makeNotification('smoke-mixed-urgent', 'URGENT', '上课期间的紧急通知'), {
    inClass: true,
  });
  await sleep(700);
  const mixedUrgent = island.getState();
  // 收起（学生点空白处）
  await islandWindow?.webContents
    .executeJavaScript(
      `(() => {
         document.querySelector('.island-card')?.click();
         return true;
       })()`,
    )
    .catch(() => undefined);
  await sleep(600);
  const mixedCollapsed = island.getState();
  // 又来了新作业（上课时段，属普通通知 → 进队列，但胶囊已把这个类型汇总出来了）
  island.pushNotification(
    {
      ...makeNotification('smoke-mixed-homework', 'NORMAL', '今天的新作业'),
      kind: 'homework',
    },
    { inClass: true },
  );
  await sleep(600);
  const mixedPillDom = await islandWindow?.webContents.executeJavaScript(
    `document.querySelector('.island-card.pill .pill-title')?.textContent?.trim() ?? ''`,
  );
  // 点击胶囊：必须打开**新作业**这条
  await islandWindow?.webContents
    .executeJavaScript(
      `(() => {
         document.querySelector('.island-card')?.click();
         return true;
       })()`,
    )
    .catch(() => undefined);
  await sleep(750);
  const mixedOpened = island.getState();
  record(
    '紧急通知后来了新作业：收起再点击打开的是新作业（联合通知回归）',
    mixedUrgent.mode === 'expanded' &&
      mixedCollapsed.mode === 'pill' &&
      (mixedPillDom ?? '').includes('作业') &&
      mixedOpened.mode === 'expanded' &&
      mixedOpened.active?.id === 'smoke-mixed-homework',
    `紧急态=${mixedUrgent.mode} 收起=${mixedCollapsed.mode} 胶囊标题="${mixedPillDom ?? '-'}" ` +
      `点击后=${mixedOpened.mode} active=${mixedOpened.active?.id ?? '-'}`,
  );
  island.handleAction({ action: 'dismiss' });
  await sleep(300);
  island.setClassState({ inClass: false, currentPeriodEnd: null, week: 1 });
  await sleep(300);

  // 5) 截图留档的像素级断言：每张图必须有实际绘制内容、颜色丰富，且宽高比与
  //    状态机配置的窗口尺寸一致（DPI 无关），紧急形态还必须出现红色描边/内部光晕像素。
  const shotDetails = islandShots.map((shot) => {
    const expectedRatio = shot.expected.width / shot.expected.height;
    const actualRatio = shot.width / shot.height;
    const ratioDelta = Math.abs(actualRatio - expectedRatio);
    return {
      ...shot,
      ratioDelta,
      text:
        `${shot.name} ${shot.width}x${shot.height}(期望 ${shot.expected.width}x${shot.expected.height}, ` +
        `比例偏差 ${ratioDelta.toFixed(3)}) 不透明=${shot.opaque} 颜色=${shot.uniqueColors} ` +
        `偏红=${shot.reddish} 岛外偏红=${shot.outsideReddish ?? 0}`,
    };
  });

  const blank = shotDetails.filter((shot) => shot.opaque < 500 || shot.uniqueColors < 3);
  const wrongRatio = shotDetails.filter((shot) => shot.ratioDelta > 0.05);
  const urgentShot = shotDetails.find((shot) => shot.name.includes('urgent'));
  const urgentReddish = urgentShot?.reddish ?? 0;
  const outsideReddish = urgentShot?.outsideReddish ?? 0;
  const pillShot = shotDetails.find((shot) => shot.name.includes('pill'));
  // "形态尺寸递增"：胶囊 < 某个展开形态 < 紧急形态。
  // 展开形态优先取 after-class 留档，缺图时退回其它展开态（避免一张可选留档缺失就误判）。
  const expandedShot = [
    shotDetails.find((shot) => shot.name.includes('after-class')),
    shotDetails.find((shot) => shot.name.includes('clicked')),
    shotDetails.find((shot) => shot.name.includes('homework')),
  ].find(Boolean);
  const sizesOrdered = Boolean(
    pillShot &&
    expandedShot &&
    urgentShot &&
    pillShot.height < expandedShot.height &&
    expandedShot.height < urgentShot.height,
  );

  record(
    '灵动岛各状态截图像素级留档（尺寸/宽高比/绘制内容/紧急红光）',
    shotDetails.length >= 4 &&
      blank.length === 0 &&
      wrongRatio.length === 0 &&
      urgentReddish > 200 &&
      sizesOrdered,
    `${shotDetails.length} 张：${shotDetails.map((shot) => shot.text).join(' | ')}` +
      `${blank.length > 0 ? ` 空白图=${blank.map((shot) => shot.name).join(',')}` : ''}` +
      `${wrongRatio.length > 0 ? ` 比例异常=${wrongRatio.map((shot) => shot.name).join(',')}` : ''}` +
      ` 形态尺寸递增=${sizesOrdered}`,
  );

  // 7) 光晕只在岛内部：固定的窗口包围盒里，岛之外的留白区不允许出现红色外溢像素
  record(
    '紧急光晕不外溢（岛之外的窗口留白区无红色像素）',
    urgentShot !== undefined && outsideReddish === 0 && urgentReddish > 200,
    `紧急态岛内偏红=${urgentReddish} 岛外留白偏红=${outsideReddish}（要求 0）`,
  );

  /*
    7a) 投影（filter）必须常驻：**任一所拍形态**都不允许缺 filter，切换形态只能改参数。

    增删 CSS filter 会让 Chromium 重建元素的渲染表面（effect node），首帧合成可能早于
    新表面栅格化完成 —— 那一帧被当作空内容画出去。卡片的底色正画在这个被过滤的元素上，
    于是**开/合的一瞬间底座会闪掉一帧**（用户反馈的"开合时一瞬间的闪动"）。
    这里刻意只断言"每一张截图都有投影"，不去要求"胶囊与展开的参数必须不同"：
    后者会把"岛因别的原因卡在展开态"这类无关故障也算到这条用例头上，信号就脏了。
  */
  const shotsWithFilter = shotDetails.filter((shot) => (shot.shapeFilter ?? '').length > 0);
  const missingShadow = shotsWithFilter.filter((shot) => !(shot.shapeFilter ?? '').includes('drop-shadow'));
  const pillFilter = pillShot?.shapeFilter ?? '';
  const expandedFilter = expandedShot?.shapeFilter ?? '';
  record(
    '灵动岛任意形态的投影都常驻（不增删 filter，避免开合闪一帧）',
    shotsWithFilter.length >= 3 && missingShadow.length === 0,
    `${shotsWithFilter.length} 张有 filter，缺投影=${missingShadow.map((shot) => shot.name).join(',') || '无'}；` +
      `胶囊=${pillFilter || '(未拍到)'} 展开=${expandedFilter || '(未拍到)'}`,
  );

  // 7b) 圆角几何：从四角沿对角线向内找边界，四个角的步进必须一致（旧实现四角共用同一个
  //     偏移向量，左上/右下被切掉一块，两两步进差异明显）。只看角尖端 2~7px，与文字无关。
  const cornerShots = shotDetails.filter((shot) => shot.corners);
  const badCorners = cornerShots.filter((shot) => {
    const corner = shot.corners;
    if (!corner) return false;
    return corner.spread > 2 || corner.steps.some((step) => step < 1 || step > corner.limit);
  });
  const cornerReport = cornerShots
    .map((shot) => {
      const corner = shot.corners;
      if (!corner) return shot.name;
      const flag = corner.spread > 2 ? ' ←离散超限' : '';
      return `${shot.name} 步进=[${corner.steps.join(',')}] 理论=${corner.expectedInset} 离散=${corner.spread}${flag}`;
    })
    .join(' | ');
  record(
    '圆角四角一致（无“缺一块 / 角画反”：四角边界步进一致且落在连续圆角理论值内）',
    cornerShots.length >= 4 && badCorners.length === 0,
    cornerReport,
  );

  // 8) 个性化外观：高度/宽度/圆角/字号/透明度/动画速度实时生效，且不破坏布局
  const appearanceBefore = island.getAppearance();
  // 8.1) 设置页真实链路（渲染进程 → IPC → 主进程）：用户反馈"设置不生效"，
  //      因此必须走设置页用的 `window.desktop.islandSetAppearance`，而不是直接调主进程 API。
  const rendererApplied = await mainWin?.webContents
    .executeJavaScript(
      `(() => {
         if (!window.desktop?.islandSetAppearance) return false;
         window.desktop.islandSetAppearance({
           height: 62,
           width: 320,
           radius: 28,
           fontSize: 16,
           opacity: 0.9,
           accent: '#ff7043',
         });
         return true;
       })()`,
    )
    .catch(() => false);
  await sleep(450);
  const rendererAppearance = island.getAppearance();
  const rendererCssVars = await islandWindow?.webContents
    .executeJavaScript(
      `(() => {
         const style = getComputedStyle(document.documentElement);
         return {
           h: style.getPropertyValue('--island-h').trim(),
           w: style.getPropertyValue('--island-w').trim(),
           font: style.getPropertyValue('--island-font').trim(),
           accent: style.getPropertyValue('--island-accent').trim(),
         };
       })()`,
    )
    .catch(() => null);
  record(
    '设置页链路：渲染进程 islandSetAppearance 实时生效（尺寸/字号/主题色）',
    rendererApplied === true &&
      rendererAppearance.height === 62 &&
      rendererAppearance.width === 320 &&
      rendererAppearance.fontSize === 16 &&
      rendererAppearance.accent.toLowerCase() === '#ff7043' &&
      rendererCssVars?.h === '62px' &&
      rendererCssVars?.w === '320px' &&
      rendererCssVars?.font === '16px' &&
      rendererCssVars?.accent.toLowerCase() === '#ff7043',
    `渲染进程调用=${rendererApplied} 主进程外观=${rendererAppearance.width}x${rendererAppearance.height} ` +
      `字号=${rendererAppearance.fontSize} 主题色=${rendererAppearance.accent} ` +
      `CSS 变量 h=${rendererCssVars?.h} w=${rendererCssVars?.w} font=${rendererCssVars?.font} accent=${rendererCssVars?.accent}`,
  );
  // 岛**可见**时改尺寸也要立刻生效（用户在设置页调滑块时岛正显示着）
  island.pushNotification(makeNotification('smoke-appearance-live', 'NORMAL', '实时预览校验'), {
    inClass: false,
  });
  await sleep(500);
  await mainWin?.webContents
    .executeJavaScript(
      `(() => {
         window.desktop?.islandSetAppearance({ height: 66, width: 336, fontSize: 17 });
         return true;
       })()`,
    )
    .catch(() => undefined);
  await sleep(450);
  const liveBounds = (await readIslandGeometry())?.island ?? null;
  record(
    '设置页链路：岛显示中改尺寸也立刻生效（实时预览）',
    liveBounds?.height === 66 && Math.abs((liveBounds?.width ?? 0) - 336) <= 1,
    `岛=${liveBounds?.width?.toFixed(0) ?? '-'}x${liveBounds?.height?.toFixed(0) ?? '-'}（期望 336x66）`,
  );
  island.setAppearance({ height: 56, width: 300, radius: 26, fontSize: 14, opacity: 0.92, speed: 1.5 });
  island.handleAction({ action: 'dismiss' });
  await sleep(300);
  island.pushNotification(makeNotification('smoke-appearance', 'NORMAL', '外观设置校验'), {
    inClass: false,
  });
  await sleep(600);
  const pillBounds = (await readIslandGeometry())?.island ?? null;
  const cssVars = await islandWindow?.webContents.executeJavaScript(
    `(() => {
       const style = getComputedStyle(document.documentElement);
       const card = document.querySelector('.island-card');
       return {
         h: style.getPropertyValue('--island-h').trim(),
         w: style.getPropertyValue('--island-w').trim(),
         radius: style.getPropertyValue('--island-radius').trim(),
         font: style.getPropertyValue('--island-font').trim(),
         accent: style.getPropertyValue('--island-accent').trim(),
         cardHeight: card ? Math.round(card.getBoundingClientRect().height) : 0,
       };
     })()`,
  );
  record(
    '个性化外观生效（高度/宽度/圆角/字号 → 窗口与卡片同步）',
    pillBounds?.width === 300 &&
      pillBounds?.height === 56 &&
      cssVars?.h === '56px' &&
      cssVars?.w === '300px' &&
      cssVars?.radius === '26px' &&
      cssVars?.font === '14px',
    `窗口=${pillBounds?.width ?? '-'}x${pillBounds?.height ?? '-'} CSS变量 h=${cssVars?.h} w=${cssVars?.w} ` +
      `圆角=${cssVars?.radius} 字号=${cssVars?.font} 卡片高=${cssVars?.cardHeight}`,
  );

  // 展开后内容不溢出（高度调大也不能出现内容超出卡片）
  island.handleAction({ action: 'expand' });
  await sleep(700);
  const overflowCheck = await islandWindow?.webContents.executeJavaScript(
    `(() => {
       const card = document.querySelector('.island-card.expanded');
       if (!card) return null;
       return {
         overflow: card.scrollHeight - card.clientHeight,
         width: Math.round(card.getBoundingClientRect().width),
         height: Math.round(card.getBoundingClientRect().height),
       };
     })()`,
  );
  record(
    '调整尺寸后内容不溢出',
    Boolean(overflowCheck) && overflowCheck.overflow <= 1,
    `卡片=${overflowCheck?.width ?? '-'}x${overflowCheck?.height ?? '-'} 溢出=${overflowCheck?.overflow ?? '-'}px`,
  );

  // 9) 抖动修复（需求 4）：只量"收回"过程
  //    - 窗口宽度必须单调收缩（由主进程 rAF 循环驱动，不回跳）
  //    - 卡片布局尺寸用 offsetWidth/offsetTop（不含 CSS transform），只允许在"详情/胶囊"两种固定值间切换
  island.setAppearance(appearanceBefore);
  await sleep(300);
  // 前面几节的收尾可能已经清空队列：这里保证有"正在展示的通知"，否则 expand 无可展开，
  // 采样只会拿到隐藏态的空数据（这条断言就失去意义）。
  if (!island.getState().active) {
    island.pushNotification(makeNotification('smoke-jitter', 'NORMAL', '开合抖动校验'), {
      inClass: false,
    });
    await sleep(500);
  }
  island.handleAction({ action: 'expand' });
  await sleep(700);
  const jitterSamples: { win: number; cardWidth: number; cardTop: number }[] = [];
  const jitterSampler = setInterval(() => {
    void readIslandGeometry()
      .then((geometry) => {
        if (!geometry) return;
        jitterSamples.push({
          win: geometry.window.width,
          cardWidth: Math.round(geometry.island.width),
          cardTop: Math.round(geometry.island.y),
        });
      })
      .catch(() => undefined);
  }, 30);
  island.handleAction({ action: 'collapse' });
  await sleep(800);
  clearInterval(jitterSampler);

  const winSequence = jitterSamples.map((item) => item.win);
  const windowConstant = new Set(winSequence).size <= 1;
  const islandSequence = jitterSamples.map((item) => item.cardWidth);
  const monotonicShrink = islandSequence.every(
    (width, index) => index === 0 || width <= (islandSequence[index - 1] ?? width) + 1,
  );
  const cardTops = jitterSamples.map((item) => item.cardTop);
  const topSpread = cardTops.length > 0 ? Math.max(...cardTops) - Math.min(...cardTops) : 99;
  record(
    '收回过程不抖动（窗口恒定 + 岛宽度单调收缩 + 岛顶部不动）',
    jitterSamples.length >= 4 && windowConstant && monotonicShrink && topSpread <= 1,
    `采样=${jitterSamples.length} 窗口宽度集合=[${[...new Set(winSequence)].join(',')}]（要求 1 个） ` +
      `岛宽度序列=[${islandSequence.join(',')}] 单调收缩=${monotonicShrink} 岛上边缘波动=${topSpread}px`,
  );
  // 10) 连续快速开合：最终状态与尺寸必须稳定
  for (let index = 0; index < 5; index += 1) {
    island.handleAction({ action: 'expand' });
    await sleep(45);
    island.handleAction({ action: 'collapse' });
    await sleep(45);
  }
  await sleep(600);
  const rapidState = island.getState();
  const rapidBounds = (await readIslandGeometry())?.island ?? null;
  const currentAppearance = island.getAppearance();
  record(
    '连续快速展开/收起后状态与尺寸稳定',
    rapidState.mode === 'pill' &&
      Math.abs((rapidBounds?.width ?? 0) - currentAppearance.width) <= 2 &&
      Math.abs((rapidBounds?.height ?? 0) - currentAppearance.height) <= 2,
    `mode=${rapidState.mode} 岛=${rapidBounds?.width?.toFixed(1) ?? '-'}x${rapidBounds?.height?.toFixed(1) ?? '-'}` +
      `（期望 ${currentAppearance.width}x${currentAppearance.height}）`,
  );

  // 10.5) 「开合不震动」实测：把窗口矩形与卡片的**真实屏幕矩形**逐帧采样，
  //       断言 ①卡片的水平中心与上边缘绝对不动（锚点稳定，不左右/上下跳动）
  //            ②卡片与窗口的尺寸单调变化且**从不过冲**（不再有"弹一下"的回弹）
  const motionSamples: {
    winW: number;
    winH: number;
    winX: number;
    cardCx: number;
    cardTop: number;
    cardW: number;
    cardH: number;
    pillLeft: number;
    pillRight: number;
    pillTextLeft: number;
  }[] = [];

  const sampleCardRect = async (): Promise<void> => {
    const bounds = islandWindow?.getBounds();
    const rect = await islandWindow?.webContents
      .executeJavaScript(
        `(() => {
           const card = document.querySelector('.island-card');
           if (!card) return null;
           const r = card.getBoundingClientRect();
           const pill = card.querySelector('.pill-title');
           const pr = pill ? pill.getBoundingClientRect() : null;
           const text = card.querySelector('.pill-text');
           const tr = text ? text.getBoundingClientRect() : null;
           return {
             left: r.left,
             top: r.top,
             width: r.width,
             height: r.height,
             pillLeft: pr ? pr.left : -1,
             pillRight: pr ? pr.right : -1,
             pillTextLeft: tr ? tr.left : -1,
           };
         })()`,
      )
      .catch(() => null);
    if (!bounds || !rect) return;
    motionSamples.push({
      winW: bounds.width,
      winH: bounds.height,
      winX: bounds.x,
      cardCx: bounds.x + rect.left + rect.width / 2,
      cardTop: bounds.y + rect.top,
      cardW: rect.width,
      cardH: rect.height,
      pillLeft: rect.pillLeft < 0 ? -1 : bounds.x + rect.pillLeft,
      pillRight: rect.pillRight < 0 ? -1 : bounds.x + rect.pillRight,
      pillTextLeft: rect.pillTextLeft < 0 ? -1 : bounds.x + rect.pillTextLeft,
    });
  };

  const runMotionProbe = async (action: 'expand' | 'collapse'): Promise<void> => {
    motionSamples.length = 0;
    island.handleAction({ action });
    const deadline = Date.now() + 900;
    while (Date.now() < deadline) {
      await sampleCardRect();
      await sleep(12);
    }
  };

  island.handleAction({ action: 'dismiss' });
  await sleep(250);
  island.pushNotification(makeNotification('smoke-motion', 'NORMAL', '开合不震动校验'), { inClass: false });
  await sleep(350);

  const expandedCard = { width: ISLAND_SIZES.expanded.width, height: ISLAND_SIZES.expanded.height };
  const pillCard = { width: ISLAND_SIZES.pill.width, height: ISLAND_SIZES.pill.height };

  await runMotionProbe('expand');
  const expandSamples = [...motionSamples];
  const cxSpread = expandSamples.length
    ? Math.max(...expandSamples.map((item) => item.cardCx)) -
      Math.min(...expandSamples.map((item) => item.cardCx))
    : 99;
  const topSpreadExpand = expandSamples.length
    ? Math.max(...expandSamples.map((item) => item.cardTop)) -
      Math.min(...expandSamples.map((item) => item.cardTop))
    : 99;
  const maxCardW = expandSamples.length ? Math.max(...expandSamples.map((item) => item.cardW)) : 0;
  const maxCardH = expandSamples.length ? Math.max(...expandSamples.map((item) => item.cardH)) : 0;
  const maxWinW = expandSamples.length ? Math.max(...expandSamples.map((item) => item.winW)) : 0;
  const maxWinH = expandSamples.length ? Math.max(...expandSamples.map((item) => item.winH)) : 0;
  const minWinW = expandSamples.length ? Math.min(...expandSamples.map((item) => item.winW)) : 0;
  const minWinH = expandSamples.length ? Math.min(...expandSamples.map((item) => item.winH)) : 0;
  const windowFrozen = maxWinW === minWinW && maxWinH === minWinH;
  const expandMonotonic = expandSamples.every(
    (item, index) => index === 0 || item.winW >= (expandSamples[index - 1]?.winW ?? 0) - 1,
  );
  const expandNoOvershoot = maxCardW <= expandedCard.width + 0.5 && maxCardH <= expandedCard.height + 0.5;
  record(
    '展开过程不震动（窗口冻结 + 岛锚点不动 + 尺寸不过冲）',
    expandSamples.length >= 5 &&
      windowFrozen &&
      cxSpread <= 0.5 &&
      topSpreadExpand <= 0.5 &&
      expandMonotonic &&
      expandNoOvershoot,
    `采样=${expandSamples.length} 窗口=${maxWinW}x${maxWinH}（全程冻结=${windowFrozen}） ` +
      `岛中心波动=${cxSpread.toFixed(2)}px 岛上边缘波动=${topSpreadExpand.toFixed(2)}px ` +
      `最大岛=${maxCardW.toFixed(1)}x${maxCardH.toFixed(1)}（目标 ${expandedCard.width}x${expandedCard.height}） 单调=${expandMonotonic}`,
  );

  await runMotionProbe('collapse');
  const collapseSamples = [...motionSamples];
  const cxSpreadCollapse = collapseSamples.length
    ? Math.max(...collapseSamples.map((item) => item.cardCx)) -
      Math.min(...collapseSamples.map((item) => item.cardCx))
    : 99;
  const topSpreadCollapse = collapseSamples.length
    ? Math.max(...collapseSamples.map((item) => item.cardTop)) -
      Math.min(...collapseSamples.map((item) => item.cardTop))
    : 99;
  const minCardW = collapseSamples.length ? Math.min(...collapseSamples.map((item) => item.cardW)) : 0;
  const collapseWindowFrozen =
    new Set(collapseSamples.map((item) => item.winW)).size <= 1 &&
    new Set(collapseSamples.map((item) => item.winH)).size <= 1;
  const collapseMonotonic = collapseSamples.every(
    (item, index) =>
      index === 0 || item.cardW <= (collapseSamples[index - 1]?.cardW ?? Number.MAX_SAFE_INTEGER) + 1,
  );
  const collapseNoOvershoot = minCardW >= pillCard.width - 1;
  record(
    '收回过程不震动（窗口冻结 + 岛锚点不动 + 尺寸不过冲）',
    collapseSamples.length >= 5 &&
      collapseWindowFrozen &&
      cxSpreadCollapse <= 0.5 &&
      topSpreadCollapse <= 0.5 &&
      collapseMonotonic &&
      collapseNoOvershoot,
    `采样=${collapseSamples.length} 窗口全程冻结=${collapseWindowFrozen} ` +
      `岛中心波动=${cxSpreadCollapse.toFixed(2)}px 岛上边缘波动=${topSpreadCollapse.toFixed(2)}px ` +
      `最小岛宽=${minCardW.toFixed(1)}（目标 ${pillCard.width}） 单调收缩=${collapseMonotonic}`,
  );

  /*
    11.7) 开合时**胶囊内容不允许横移/重排**（用户反馈："展开和收回的时候，新消息那行字往右跳一下再缩回"）。

    卡片在开合时会 268 ⇄ 424 变宽变窄，而中心停靠下卡片的左右边都在动：
    若胶囊内容跟着卡片宽度走，文字就会"先按宽卡片铺开、再随卡片收窄被省略号收回"。
    因此这里逐帧采样 `.pill-title` 的左右边缘：整段形变里它的位置必须基本不动
    （`.pill-inner` 固定为胶囊几何），否则就是又退化回"跟着卡片重排"了。
  */
  const pillSpan = (list: typeof motionSamples): { left: number; right: number; count: number } => {
    const rows = list.filter((item) => item.pillTextLeft >= 0 && item.pillRight >= 0);
    if (rows.length === 0) return { left: 0, right: 0, count: 0 };
    const lefts = rows.map((item) => item.pillTextLeft);
    const rights = rows.map((item) => item.pillRight);
    return {
      left: Math.max(...lefts) - Math.min(...lefts),
      right: Math.max(...rights) - Math.min(...rights),
      count: rows.length,
    };
  };
  const expandPill = pillSpan(expandSamples);
  const collapsePill = pillSpan(collapseSamples);
  record(
    '灵动岛开合时胶囊内容不横移（文字不"先铺开再缩回"，固定为胶囊几何）',
    expandPill.count >= 3 &&
      collapsePill.count >= 3 &&
      expandPill.right <= 2 &&
      collapsePill.right <= 2 &&
      expandPill.left <= 2 &&
      collapsePill.left <= 2,
    `展开：文本左边缘波动=${expandPill.left.toFixed(1)}px 右边缘波动=${expandPill.right.toFixed(1)}px（${expandPill.count} 帧）；` +
      `收回：左=${collapsePill.left.toFixed(1)}px 右=${collapsePill.right.toFixed(1)}px（${collapsePill.count} 帧）——都要求 ≤ 2px`,
  );

  // 收尾：保持"胶囊可见"状态——后续个性化用例（透明度 / 位置）需要窗口可见才会立即生效
  await sleep(250);
  // 排空队列用模块级的 drainIsland()（同一条实现，见文件顶部）

  /** 灵动岛状态摘要（失败时用于定位是"没排空队列"还是"几何没生效"） */
  const islandStateSummary = (): string => {
    const current = island.getState();
    return `mode=${current.mode} active=${current.active?.id ?? 'null'} queued=${current.queued.length} visible=${
      islandWindow?.isVisible() ?? '-'
    }`;
  };

  /** 等待灵动岛渲染出指定选择器（最多约 2s） */
  const waitForIslandDom = async (selector: string, timeoutMs = 2000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = await islandWindow?.webContents
        .executeJavaScript(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)
        .catch(() => false);
      if (found) return true;
      await sleep(60);
    }
    return false;
  };

  // 10.6) 字号：所有文本都由基础字号推导，改设置必须"立刻看到"（WinIsland 的 font_size 模型）
  const readFontSizes = async (): Promise<Record<string, number>> =>
    (await islandWindow?.webContents
      .executeJavaScript(
        `(() => {
           const pick = (selector) => {
             const node = document.querySelector(selector);
             if (!node) return 0;
             return Math.round(parseFloat(getComputedStyle(node).fontSize) * 100) / 100;
           };
           return {
             'pill-title': pick('.pill-title'),
             'pill-sub': pick('.pill-sub'),
             title: pick('.title'),
             content: pick('.content-text'),
             ghost: pick('.ghost-btn'),
           };
         })()`,
      )
      .catch(() => ({}))) ?? {};

  const probeFontScale = async (fontSize: number): Promise<Record<string, number>> => {
    island.setAppearance({ ...appearanceBefore, fontSize });
    await drainIsland();
    island.pushNotification(makeNotification('smoke-font', 'NORMAL', '字号实时生效校验'), {
      inClass: false,
    });
    await waitForIslandDom('.island-card.pill .pill-title');
    await sleep(120);
    const pillSizes = await readFontSizes();
    island.handleAction({ action: 'expand' });
    await waitForIslandDom('.island-card.expanded .title');
    await sleep(160);
    const expandedSizes = await readFontSizes();
    // 两次读取各有一半元素不存在（返回 0），合并时只采纳 >0 的有效值
    const merged: Record<string, number> = { ...pillSizes };
    for (const [key, value] of Object.entries(expandedSizes)) {
      if (value > 0) merged[key] = value;
    }
    return merged;
  };

  await drainIsland();
  const fontSmall = await probeFontScale(13);
  const fontLarge = await probeFontScale(19);
  const fontKeys = Object.keys(fontSmall).filter((key) => (fontSmall[key] ?? 0) > 0);
  const expectedRatio = 19 / 13;
  const fontRatios = fontKeys.map((key) => ({
    key,
    ratio: (fontLarge[key] ?? 0) / (fontSmall[key] ?? 1),
  }));
  const fontUniform = fontRatios.every((item) => Math.abs(item.ratio - expectedRatio) <= 0.03);
  record(
    '字号设置立刻生效（岛内所有文本按基础字号等比缩放）',
    fontKeys.length >= 5 && fontUniform,
    `13px→[${fontKeys.map((key) => `${key}=${fontSmall[key]}`).join(' ')}] ` +
      `19px→[${fontKeys.map((key) => `${key}=${fontLarge[key]}`).join(' ')}] ` +
      `期望倍率=${expectedRatio.toFixed(3)} 实测=[${fontRatios.map((item) => `${item.key}:${item.ratio.toFixed(3)}`).join(' ')}] ` +
      `${islandStateSummary()}`,
  );

  // 10.7) 视觉风格：纯黑 / 毛玻璃（亚克力）/ 主题色渐变，切换立即生效
  const probeStyle = async (style: IslandAppearance['style']): Promise<{ fill: string; stroke: string }> => {
    island.setAppearance({ ...appearanceBefore, style });
    await sleep(260);
    const measured = await islandWindow?.webContents
      .executeJavaScript(
        `(() => {
           const path = document.querySelector('.island-card .shape path');
           if (!path) return null;
           const style = getComputedStyle(path);
           return { fill: style.fill, stroke: style.stroke };
         })()`,
      )
      .catch(() => null);
    return {
      fill: String(measured?.fill ?? '-'),
      stroke: String(measured?.stroke ?? '-'),
    };
  };

  const blackStyle = await probeStyle('black');
  const glassStyle = await probeStyle('glass');
  const tintedStyle = await probeStyle('tinted');
  record(
    '视觉风格切换立刻生效（纯黑 / 毛玻璃半透明 / 主题色）',
    blackStyle.fill === 'rgb(0, 0, 0)' &&
      glassStyle.fill.startsWith('rgba(32, 32, 36') &&
      tintedStyle.fill === 'rgb(11, 11, 15)',
    `纯黑 fill=${blackStyle.fill}；毛玻璃 fill=${glassStyle.fill}；主题色 fill=${tintedStyle.fill}`,
  );
  // 10.7b) 固定大包围盒窗口的鼠标穿透（照搬 WinIsland set_cursor_hittest）：
  //        默认整块窗口穿透，指针进入岛体才接收鼠标 —— 否则会吞掉桌面点击。
  // 指针进入岛体前先保证岛真的画出来了（隐藏态曾让这条断言偶发失败）
  await drainIsland();
  island.pushNotification(makeNotification('smoke-interactive', 'NORMAL', '鼠标穿透校验'), {
    inClass: false,
  });
  await waitForIslandDom('.island-card.pill .pill-title');
  await sleep(200);
  // 命中兜底轮询读的是"岛体矩形"：等它上报后再注入光标（渲染进程上报有限流）
  for (let index = 0; index < 20 && !island.getHitRect(); index += 1) await sleep(80);
  await islandWindow?.webContents
    .executeJavaScript(
      `(() => {
         const card = document.querySelector('.island-card');
         const r = card.getBoundingClientRect();
         window.dispatchEvent(
           new MouseEvent('mousemove', {
             clientX: r.left + r.width / 2,
             clientY: r.top + r.height / 2,
             bubbles: true,
           }),
         );
         return true;
       })()`,
    )
    .catch(() => undefined);
  await sleep(180);
  // 兜底轮询读的是主进程光标坐标：注入到岛体中心，等价于"指针停在岛内"。
  // 命中判定链路是异步的（渲染进程上报矩形 → 主进程 120ms 轮询校正），
  // 因此这里**轮询等待**而不是固定 sleep 后读一次，避免偶发误判。
  island.setHitTestCursor(islandCardScreenPoint(0.5, 0.5));
  let interactiveInside = island.getInteractive();
  for (let index = 0; index < 10 && interactiveInside !== true; index += 1) {
    await sleep(120);
    island.setHitTestCursor(islandCardScreenPoint(0.5, 0.5));
    interactiveInside = island.getInteractive();
  }
  await islandWindow?.webContents
    .executeJavaScript(
      `(() => {
         window.dispatchEvent(new MouseEvent('mousemove', { clientX: 2, clientY: 2, bubbles: true }));
         return true;
       })()`,
    )
    .catch(() => undefined);
  // 光标的权威判定在主进程（兜底轮询）：这里把光标注入到屏幕左上角，等价于"指针离开岛体"
  island.setHitTestCursor({ x: 1, y: 1 });
  let interactiveOutside = island.getInteractive();
  for (let index = 0; index < 10 && interactiveOutside !== false; index += 1) {
    await sleep(120);
    island.setHitTestCursor({ x: 1, y: 1 });
    interactiveOutside = island.getInteractive();
  }
  const hitCheckGeometry = island.getHitRect();
  island.setHitTestCursor(null);
  record(
    '岛外鼠标穿透（固定大窗口不吞桌面点击）',
    interactiveInside === true && interactiveOutside === false,
    `指针在岛内 interactive=${interactiveInside}，指针在岛外 interactive=${interactiveOutside}（要求 true / false）` +
      ` 窗口可见=${islandWindow?.isVisible() ?? false} 状态=${island.getState().mode}` +
      ` 岛体矩形=${hitCheckGeometry ? `${Math.round(hitCheckGeometry.x)},${Math.round(hitCheckGeometry.y)} ${Math.round(hitCheckGeometry.width)}x${Math.round(hitCheckGeometry.height)}` : 'null'}`,
  );
  island.setAppearance({ ...appearanceBefore, style: 'black' });
  await sleep(200);

  // 10.7c) 触摸屏（希沃白板）：手指点不开灵动岛的根因是"窗口在触摸点处不可命中" ——
  //        打开命中的两条链路（渲染进程 mousemove 转发、主进程读系统光标）都要求鼠标指针移动，
  //        触摸两者都不产生，窗口会永远停在穿透态。修法是触摸模式下让窗口**贴合岛体**且不穿透
  //        （Electron 没有 SetWindowRgn，只能靠贴合包围盒把"多出来的透明区"压到投影留白大小）。
  //
  //        断言取"窗口 = 卡片实测尺寸 + 2×阴影留白"这个**与形态无关**的不变量：
  //        别写死 `ISLAND_SIZES.pill + pad` —— 岛此刻是胶囊还是卡片取决于前面用例留下的状态，
  //        写死形态会在别的用例微调外观/队列后误报（第一次就是这么写的，打包版冒烟里报了红）。
  const boxBeforeTouch = island.getWindowBounds();
  island.setTouchMode(true);
  const pad = ISLAND_SHADOW_PAD;
  let touchBox = island.getWindowBounds();
  let touchCard = { width: 0, height: 0 };
  const touchSnug = (): boolean =>
    Math.abs(touchBox.width - (touchCard.width + pad * 2)) <= 2 &&
    Math.abs(touchBox.height - (touchCard.height + pad * 2)) <= 2;
  for (let index = 0; index < 25 && !touchSnug(); index += 1) {
    const geo = islandWindow ? await readIslandGeometryFrom(islandWindow) : null;
    touchBox = island.getWindowBounds();
    if (geo?.island) touchCard = { width: geo.island.width, height: geo.island.height };
    if (touchSnug()) break;
    await sleep(120);
  }
  // 这条要断言触摸模式下"始终接收输入"，短时关掉测试输入穿透（否则恒为穿透）
  island.setTestInputPassthrough(false);
  const touchInteractive = island.getInteractive();
  const touchFlag = island.getTouchMode();
  const touchStateMode = island.getState().mode;
  island.setTouchMode(false);
  const boxRestored = (): boolean => {
    const box = island.getWindowBounds();
    return box.width === boxBeforeTouch.width && box.height === boxBeforeTouch.height;
  };
  let restoredBox = island.getWindowBounds();
  for (let index = 0; index < 20 && !boxRestored(); index += 1) {
    await sleep(100);
    restoredBox = island.getWindowBounds();
  }
  record(
    '触摸屏：窗口贴合岛体并始终接收输入（手指能点到岛）',
    touchSnug() && touchInteractive === true && boxRestored(),
    `触摸模式窗口=${touchBox.width}x${touchBox.height}` +
      `（岛体实测=${Math.round(touchCard.width)}x${Math.round(touchCard.height)} + 2×${pad} 留白，形态=${touchStateMode}）` +
      ` 触摸模式标记=${touchFlag} 接收输入=${touchInteractive}（要求 true）；` +
      `退出触摸模式后=${restoredBox.width}x${restoredBox.height}` +
      `（期望恢复 ${boxBeforeTouch.width}x${boxBeforeTouch.height}）`,
  );
  await sleep(200);
  // 触摸用例跑完，恢复"真实输入穿透"（后续用例仍靠它免于并行人工操作）
  island.setTestInputPassthrough(true);

  // 10.8) 空闲细缝（参考 WinIsland hidden_width）：开启后空闲留一条细缝，来消息再展开
  const sliver = getSliverSize();
  /**
   * 等岛体几何收敛到目标尺寸（不等固定时长）。
   * 原因：Windows 有时会把置顶透明小窗判定为"被遮挡/后台"，Chromium 会把 rAF 压到 1 帧/秒
   * （实测打包版细缝态出现过 1.1fps），此时形变会明显变慢；渲染进程 1.2s 后会自动 snap 到目标，
   * 所以这里轮询等待即可，固定 sleep 会误判成"细缝尺寸不对"。
   */
  const waitIslandSize = async (
    target: { width: number; height: number },
    timeoutMs = 4000,
  ): Promise<{ width: number; height: number } | null> => {
    const deadline = Date.now() + timeoutMs;
    let last: { width: number; height: number } | null = null;
    while (Date.now() < deadline) {
      last = (await readIslandGeometry())?.island ?? null;
      if (last && Math.abs(last.width - target.width) <= 1 && Math.abs(last.height - target.height) <= 1) {
        return last;
      }
      await sleep(120);
    }
    return last;
  };
  island.setAppearance({ ...appearanceBefore, idleSliver: true });
  await drainIsland();
  const sliverBounds = await waitIslandSize(sliver);
  island.pushNotification(makeNotification('smoke-sliver', 'NORMAL', '空闲细缝校验'), { inClass: false });
  const afterSliverNotification = await waitIslandSize({
    width: island.getAppearance().width,
    height: island.getAppearance().height,
  });
  record(
    '空闲细缝：空闲缩为细缝、来消息自动展开（WinIsland hidden_width）',
    Math.abs((sliverBounds?.width ?? 0) - sliver.width) <= 1 &&
      Math.abs((sliverBounds?.height ?? 0) - sliver.height) <= 1 &&
      Math.abs((afterSliverNotification?.width ?? 0) - island.getAppearance().width) <= 2,
    `细缝=${sliverBounds?.width ?? '-'}x${sliverBounds?.height ?? '-'}（期望 ${sliver.width}x${sliver.height}）` +
      ` 来消息后=${afterSliverNotification?.width ?? '-'}x${afterSliverNotification?.height ?? '-'} ${islandStateSummary()}`,
  );

  island.setAppearance({ ...appearanceBefore, idleSliver: false });
  island.handleAction({ action: 'dismiss' });
  // 注意：dismiss 走「收回动画（~360ms）→ 淡出 → 隐藏」，机器忙时耗时更长，
  // 固定 sleep 会间歇性踩到动画没播完（isVisible 仍为 true）——轮询等它真正隐藏。
  let sliverHidden = !(islandWindow?.isVisible() ?? true);
  for (let attempt = 0; attempt < 25 && !sliverHidden; attempt += 1) {
    await sleep(120);
    sliverHidden = !(islandWindow?.isVisible() ?? true);
  }
  record(
    '关闭空闲细缝后空闲再次完全隐藏（保持原行为）',
    sliverHidden,
    `isVisible=${islandWindow?.isVisible() ?? '-'}（轮询后${sliverHidden ? '已' : '未'}隐藏）`,
  );
  island.pushNotification(makeNotification('smoke-after-sliver', 'NORMAL', '细缝关闭后恢复'), {
    inClass: false,
  });
  await sleep(320);
  // 11) 个性化设置的其余参数：透明度 / 主题色 / 动画开关 / 速度 / 位置 / 置顶 / 持久化
  //     （需求 2 的完整清单，逐项断言真实窗口属性，而不是只看设置页显示）
  const workArea = screen.getPrimaryDisplay().workArea;

  // 11.1 透明度 → 窗口 setOpacity
  island.setAppearance({ ...appearanceBefore, opacity: 0.62 });
  await sleep(400);
  const opacityActual = islandWindow?.getOpacity() ?? -1;
  record(
    '个性设置：透明度生效（窗口 setOpacity）',
    Math.abs(opacityActual - 0.62) < 0.03,
    `设置=0.62 实际=${opacityActual.toFixed(2)}`,
  );

  // 11.2 主题色 → 渲染进程 CSS 变量
  island.setAppearance({ ...appearanceBefore, accent: '#ff7043' });
  await sleep(200);
  const accentVar = await islandWindow?.webContents.executeJavaScript(
    `getComputedStyle(document.documentElement).getPropertyValue('--island-accent').trim()`,
  );
  record('个性设置：主题色生效（CSS 变量）', accentVar === '#ff7043', `CSS --island-accent=${accentVar}`);

  // 11.2b) 三种视觉风格的**底色**：黑 / 毛玻璃 / 主题色渐变都必须是深色卡片
  //        并且卡片**外面那一圈**必须完全透明（用户反馈：毛玻璃与主题色渐变会出现白底 ——
  //        那圈留白曾被系统亚克力/不透明窗口底色垫成浅色面板，见 captureIslandBackdrop 说明）
  const styleLuminance: string[] = [];
  const styleRing: string[] = [];
  let styleOk = true;
  let ringOk = true;
  for (const style of ['black', 'glass', 'tinted'] as const) {
    island.setAppearance({ ...appearanceBefore, style, opacity: 1 });
    island.pushNotification(makeNotification(`smoke-style-${style}`, 'NORMAL', '风格底色自检'), {
      inClass: false,
    });
    await sleep(700);
    const shot = await captureIsland(`island-style-${style}`, ISLAND_SIZES.expanded);
    const luminance = shot?.luminance ?? -1;
    // 深色卡片：均值亮度应明显偏低（>140 基本就是白底）
    const ok = luminance >= 0 && luminance < 120;
    if (!ok) styleOk = false;
    styleLuminance.push(`${style}=${luminance >= 0 ? luminance.toFixed(0) : '-'}${ok ? '✓' : '✗'}`);
    // 卡片外圈：必须仍是"透出桌面"的那层像素（环亮度≈窗口外的桌面亮度），不能出现面板
    const backdrop = await captureIslandBackdrop(`island-style-${style}`);
    // 基准必须真的落在纯色底板上（否则说明底板被遮挡/截图偏了 —— 先修测试，别放过）
    const backdropVisible = backdrop ? Math.abs(backdrop.reference - ISLAND_BACKDROP_LUMINANCE) <= 8 : false;
    const ringDelta = backdrop ? Math.abs(backdrop.ring - backdrop.reference) : -1;
    // 环亮度必须与底板一致（系统材质/不透明窗口底色会把它整体抬亮或涂成白色）
    const ringOneOk =
      backdropVisible && ringDelta >= 0 && ringDelta <= 12 && (backdrop?.veilPixels ?? 1) <= 20;
    if (!ringOneOk) ringOk = false;
    styleRing.push(
      `${style}=环${backdrop?.ring ?? '-'}/底板${backdrop?.reference ?? '-'}` +
        `(差${ringDelta >= 0 ? ringDelta : '-'},卡片${backdrop?.card ?? '-'},` +
        `近场白底${backdrop?.veilPixels ?? '-'})${ringOneOk ? '✓' : '✗'}` +
        (backdropVisible ? '' : '（底板被遮挡）'),
    );
    island.handleAction({ action: 'dismiss' });
    await sleep(200);
  }
  record('个性设置：三种风格都是深色底（无白底）', styleOk, `平均亮度 ${styleLuminance.join(' ')}`);
  record('个性设置：卡片外圈透出桌面（三种风格都没有白底面板）', ringOk, styleRing.join(' '));
  island.setAppearance(appearanceBefore);

  // 11.3 位置：四个停靠点的窗口坐标必须落在对应锚点
  const positionCases: {
    position: IslandAppearance['position'];
    verify: (bounds: Electron.Rectangle) => boolean;
  }[] = [
    {
      position: 'top-left',
      verify: (bounds) =>
        Math.abs(bounds.x - (workArea.x + 8)) <= 1 && Math.abs(bounds.y - (workArea.y + 8)) <= 1,
    },
    {
      position: 'top-right',
      verify: (bounds) =>
        Math.abs(bounds.x + bounds.width - (workArea.x + workArea.width - 8)) <= 1 &&
        Math.abs(bounds.y - (workArea.y + 8)) <= 1,
    },
    {
      position: 'bottom-center',
      verify: (bounds) => Math.abs(bounds.y + bounds.height - (workArea.y + workArea.height - 8)) <= 1,
    },
    {
      position: 'top-center',
      verify: (bounds) => Math.abs(bounds.x + bounds.width / 2 - (workArea.x + workArea.width / 2)) <= 2,
    },
  ];
  const positionDetails: string[] = [];
  let positionOk = true;
  for (const item of positionCases) {
    island.setAppearance({ ...appearanceBefore, position: item.position });
    await sleep(450);
    const bounds = (await readIslandGeometry())?.island ?? null;
    const matched = Boolean(bounds) && item.verify(bounds as Electron.Rectangle);
    if (!matched) positionOk = false;
    positionDetails.push(
      `${item.position}=${bounds ? `${bounds.x},${bounds.y}` : '-'}${matched ? '✓' : '✗'}`,
    );
  }
  record('个性设置：停靠位置生效（6 个锚点）', positionOk, positionDetails.join(' '));

  // 11.3b) 边距：左右/上下边距必须真的把岛挪走（用户反馈「调边距没反应」：
  //        滑块在渲染层、定位在主进程，主进程没重跑就会出现「数字在变、岛不动」）
  island.setAppearance({ ...appearanceBefore, position: 'top-left', marginX: 48, marginY: 40 });
  await sleep(450);
  const marginLeft = (await readIslandGeometry())?.island ?? null;
  const marginLeftOk =
    Boolean(marginLeft) &&
    Math.abs((marginLeft as Electron.Rectangle).x - (workArea.x + 48)) <= 1 &&
    Math.abs((marginLeft as Electron.Rectangle).y - (workArea.y + 40)) <= 1;

  island.setAppearance({ ...appearanceBefore, position: 'top-right', marginX: 48, marginY: 8 });
  await sleep(450);
  const marginRight = (await readIslandGeometry())?.island ?? null;
  const marginRightOk =
    Boolean(marginRight) &&
    Math.abs(
      (marginRight as Electron.Rectangle).x +
        (marginRight as Electron.Rectangle).width -
        (workArea.x + workArea.width - 48),
    ) <= 1;

  record(
    '个性设置：边距生效（左右 + 上下）',
    marginLeftOk && marginRightOk,
    'top-left(marginX=48,marginY=40)=' +
      (marginLeft ? marginLeft.x + ',' + marginLeft.y : '-') +
      (marginLeftOk ? '✓' : '✗') +
      ' top-right(marginX=48)=' +
      (marginRight ? marginRight.x + ',' + marginRight.y : '-') +
      (marginRightOk ? '✓' : '✗'),
  );
  island.setAppearance(appearanceBefore);

  // 11.4 置顶开关 → 窗口 alwaysOnTop
  island.setAppearance({ ...appearanceBefore, alwaysOnTop: false });
  await sleep(250);
  const topOff = islandWindow?.isAlwaysOnTop() ?? true;
  island.setAppearance({ ...appearanceBefore, alwaysOnTop: true });
  await sleep(250);
  const topOn = islandWindow?.isAlwaysOnTop() ?? false;
  record(
    '个性设置：置顶开关生效',
    topOff === false && topOn === true,
    `关闭后 isAlwaysOnTop=${topOff}，开启后 isAlwaysOnTop=${topOn}`,
  );

  // 11.5 动画开关：关闭动画时展开必须"立即到位"（不做逐帧过渡）
  island.setAppearance({ ...appearanceBefore, animations: false });
  island.handleAction({ action: 'dismiss' });
  await sleep(250);
  island.pushNotification(makeNotification('smoke-anim-off', 'NORMAL', '关闭动画校验'), { inClass: false });
  await sleep(300);
  island.handleAction({ action: 'expand' });
  await sleep(60);
  const instantBounds = (await readIslandGeometry())?.island ?? null;
  const expectedExpanded = ISLAND_SIZES.expanded;
  const animationsOff = island.getAppearance().animations === false;
  record(
    '个性设置：关闭动画后展开立即到位',
    !animationsOff ||
      (instantBounds?.width === expectedExpanded.width && instantBounds?.height === expectedExpanded.height),
    `animations=${island.getAppearance().animations} 60ms 后窗口=${instantBounds?.width ?? '-'}x${instantBounds?.height ?? '-'}（目标 ${expectedExpanded.width}x${expectedExpanded.height}）`,
  );

  // 11.6 动画速度：speed=2 的收回耗时必须明显短于 speed=0.5
  const measureCollapse = async (speed: number): Promise<number> => {
    island.setAppearance({ ...appearanceBefore, animations: true, speed });
    island.handleAction({ action: 'expand' });
    await sleep(900);
    const started = Date.now();
    island.handleAction({ action: 'collapse' });
    const target = island.getAppearance().width;
    const deadline = started + 3000;
    while (Date.now() < deadline) {
      const geometry = await readIslandGeometry();
      const width = geometry?.island.width ?? 0;
      if (Math.abs(width - target) <= 1.5) break;
      await sleep(16);
    }
    return Date.now() - started;
  };
  const slowMs = await measureCollapse(0.5);
  const fastMs = await measureCollapse(2);
  record(
    '个性设置：动画速度生效（2 倍速明显快于 0.5 倍速）',
    fastMs + 60 < slowMs,
    `speed=0.5 收回耗时=${slowMs}ms，speed=2 收回耗时=${fastMs}ms`,
  );
  island.handleAction({ action: 'dismiss' });
  await sleep(250);

  // 11.7 持久化：写入主进程配置后重新读取必须一致（重启客户端后仍生效）
  const persisted = island.getAppearance();
  saveConfig({ island: persisted });
  const restored = getConfig().island ?? null;
  record(
    '个性设置：持久化到客户端配置（重启后仍生效）',
    Boolean(restored) &&
      restored?.height === persisted.height &&
      restored?.width === persisted.width &&
      restored?.radius === persisted.radius &&
      restored?.opacity === persisted.opacity &&
      restored?.accent === persisted.accent &&
      restored?.fontSize === persisted.fontSize &&
      restored?.animations === persisted.animations &&
      restored?.speed === persisted.speed &&
      restored?.position === persisted.position &&
      restored?.alwaysOnTop === persisted.alwaysOnTop,
    `写入=${persisted.width}x${persisted.height} 读取=${restored?.width ?? '-'}x${restored?.height ?? '-'} ` +
      `位置=${restored?.position} 置顶=${restored?.alwaysOnTop} 动画=${restored?.animations}`,
  );

  island.setAppearance(appearanceBefore);
  await sleep(300);

  // 4.12) 同一条消息的"双广播"不能把"叫人"降级成普通通知。
  //       服务端 createCall 既发 notification:new（班级房间）又发 call:new（user 房间），
  //       两条 DTO 同 id；后到的那条若直接覆盖，胶囊会显示成"新消息"（用户实测截图正是如此），
  //       紧急叫人还会被降级成"课中只排队、不立即展开"。
  const mergeCallId = 'smoke-call-merge';
  island.pushNotification(
    { ...makeNotification(mergeCallId, 'HIGH', '请 王小明 同学找 张老师'), kind: 'call' },
    { inClass: false },
  );
  await sleep(250);
  island.pushNotification(makeNotification(mergeCallId, 'HIGH', '请 王小明 同学找 张老师'), {
    inClass: false,
  });
  await sleep(450);
  const mergedCall = island.getState();
  record(
    '双广播（叫人 + 通知）不降级：同 id 合并后仍按"叫人"处理',
    mergedCall.active?.id === mergeCallId && mergedCall.active?.kind === 'call' && mergedCall.mode === 'pill',
    `mode=${mergedCall.mode} kind=${mergedCall.active?.kind ?? '-'} priority=${mergedCall.active?.priority ?? '-'}`,
  );
  const mergeUrgentId = 'smoke-call-merge-urgent';
  island.pushNotification(makeNotification(mergeUrgentId, 'NORMAL', '请 王小明 同学找 张老师'), {
    inClass: true,
  });
  await sleep(250);
  island.pushNotification(
    { ...makeNotification(mergeUrgentId, 'URGENT', '请 王小明 同学找 张老师'), kind: 'call' },
    { inClass: true },
  );
  await sleep(450);
  const mergedUrgent = island.getState();
  record(
    '紧急叫人双广播：合并后仍 URGENT 立即展开（课中不被降级为暂存）',
    mergedUrgent.active?.id === mergeUrgentId &&
      mergedUrgent.mode === 'expanded' &&
      mergedUrgent.active?.priority === 'URGENT',
    `mode=${mergedUrgent.mode} priority=${mergedUrgent.active?.priority ?? '-'} kind=${mergedUrgent.active?.kind ?? '-'}`,
  );
  island.setClassState({ inClass: false, currentPeriodEnd: null });
  island.handleAction({ action: 'dismiss' });
  await sleep(300);

  // 4.13) 渲染进程崩溃自愈：岛窗口绝不能变成"屏幕上一帧点不动的幽灵胶囊"。
  //       真实现象（本机实测）：崩掉岛渲染进程后，Windows 保留最后一帧 —— 胶囊看着还在，
  //       窗口也还在，但点击全部丢失（主进程日志里再无"收到用户动作"）。
  //       这里断言主进程会隐藏死窗口并重建，重建后状态回来了、也能重新命中。
  island.pushNotification(makeNotification('smoke-renderer-recover', 'NORMAL', '渲染进程自愈'), {
    inClass: false,
  });
  await sleep(500);
  const windowBeforeCrash = island.getWindow();
  islandWindow?.webContents.forcefullyCrashRenderer();
  await sleep(3000);
  const windowAfterCrash = island.getWindow();
  const recovered = island.isReady() && Boolean(windowAfterCrash) && windowAfterCrash !== windowBeforeCrash;
  island.setHitTestCursor(islandCardScreenPoint(0.5, 0.5));
  await sleep(250);
  const recoveredInteractive = island.getInteractive();
  const recoveredState = island.getState();
  record(
    '渲染进程崩溃后自愈（隐藏死窗口 + 重建 + 恢复命中，不再留"点不动的幽灵胶囊"）',
    recovered && recoveredInteractive && recoveredState.mode === 'pill',
    `窗口已重建=${windowAfterCrash !== windowBeforeCrash} ready=${island.isReady()} ` +
      `mode=${recoveredState.mode} 命中=${recoveredInteractive}`,
  );
  island.setHitTestCursor(null);
  island.handleAction({ action: 'dismiss' });
  await sleep(300);

  // 收尾：隐藏灵动岛，避免影响后续用例
  island.handleAction({ action: 'dismiss' });
  await sleep(300);

  // 本机录入的作业不上岛（用户要求）：走渲染进程 bridge 的真实判定
  const localHomework = await mainWin?.webContents
    .executeJavaScript(
      `(async () => {
         if (!window.__classhelperSmoke__?.islandHomeworkSuppressionCheck) return { ok: false, detail: '缺少自检钩子' };
         return await window.__classhelperSmoke__.islandHomeworkSuppressionCheck();
       })()`,
    )
    .catch(() => null);
  record(
    '本机录入的作业不再上灵动岛（内容指纹 + id 双重判定）',
    Boolean(localHomework?.ok),
    String(localHomework?.detail ?? '未执行'),
  );

  island.setTestInputPassthrough(false);
  results.push({ name: '灵动岛用例收尾', ok: true, detail: '已隐藏' });
}

/**
 * 真实通知链路自检（含"标为已读"同步）。
 *
 * 与 runIslandChecks 的区别：那里直接调 IPC 验证状态机；这里走完
 * "HTTP 发布 → Socket.IO 广播 → 渲染进程 realtime store → bridge → IPC → 灵动岛"全链路，
 * 并在灵动岛里真实点击"标为已读"，确认通知中心的未读状态同步更新。
 */
async function runIslandRealtimeCheck(
  win: BrowserWindow,
): Promise<{ delivered: boolean; deliveryDetail: string; markRead: boolean; markReadDetail: string }> {
  const scenario = await win.webContents.executeJavaScript(
    `(async () => {
       if (!window.__classhelperSmoke__?.islandRealtimeScenario) return { ok: false, detail: '渲染进程未注册冒烟钩子' };
       return await window.__classhelperSmoke__.islandRealtimeScenario();
     })()`,
  );
  if (!scenario?.ok) {
    return {
      delivered: false,
      deliveryDetail: `投递失败：${scenario?.detail ?? '未知原因'}`,
      markRead: false,
      markReadDetail: '未投递成功，跳过',
    };
  }

  // 等通知经实时通道到达并上岛（紧急通知直接展开、普通通知在课间是胶囊，两者都算"到了"）
  const deadline = Date.now() + 10_000;
  let state = island.getState();
  while (Date.now() < deadline) {
    state = island.getState();
    if (
      (state.mode === 'pill' || state.mode === 'expanded') &&
      state.active?.id === scenario.notificationId
    ) {
      break;
    }
    await sleep(120);
  }
  const visible = island.getWindow()?.isVisible() ?? false;
  const delivered =
    (state.mode === 'pill' || state.mode === 'expanded') &&
    state.active?.id === scenario.notificationId &&
    visible;
  const deliveryDetail =
    `通知=${scenario.notificationId} 客户端判定上课中=${scenario.inClass} ` +
    `灵动岛 mode=${state.mode} 可见=${visible}`;

  // 扩展灵动岛 → 点"标为已读" → 通知中心应同步为已读
  let markRead = false;
  let markReadDetail = '未执行';
  if (delivered) {
    const before = await win.webContents.executeJavaScript(
      `(async () => window.__classhelperSmoke__.islandReadState(${JSON.stringify(scenario.notificationId)}))()`,
    );
    island.handleAction({ action: 'expand' });
    await sleep(700);
    const clicked = await island.getWindow()?.webContents.executeJavaScript(
      `(() => {
         const button = Array.from(document.querySelectorAll('.island-card.expanded .ghost-btn')).find((node) =>
           (node.textContent ?? '').includes('标为已读'),
         );
         if (!button) return false;
         button.click();
         return true;
       })()`,
    );
    await sleep(900);
    const after = await win.webContents.executeJavaScript(
      `(async () => window.__classhelperSmoke__.islandReadState(${JSON.stringify(scenario.notificationId)}))()`,
    );
    markRead = clicked === true && after?.found === true && after?.read === true;
    markReadDetail =
      `点击标为已读=${clicked} 点击前 read=${before?.read}（未读 ${before?.unreadCount}）` +
      ` 点击后 read=${after?.read}（未读 ${after?.unreadCount}）标题="${after?.title ?? '-'}"`;
  }

  // 清理：删除本次自检产生的通知，避免污染演示数据
  const cleanup = await win.webContents
    .executeJavaScript(
      `(async () => {
         if (!window.__classhelperSmoke__?.islandRealtimeCleanup) return { ok: false, detail: '缺少清理钩子' };
         return await window.__classhelperSmoke__.islandRealtimeCleanup(
           ${JSON.stringify(scenario.notificationId)},
           ${JSON.stringify(scenario.teacherToken)},
         );
       })()`,
    )
    .catch(() => null);
  console.log(`[SMOKE] 真实链路清理：${cleanup?.detail ?? '未执行'}`);

  island.handleAction({ action: 'dismiss' });
  await sleep(300);

  return { delivered, deliveryDetail, markRead, markReadDetail };
}

/**
 * 多条通知「标为已读」的整批自检（用户要求：多条时那一排按钮里的"标为已读"**默认把这一批全标上**）。
 *
 * 走真实链路：教师发两条通知 → Socket.IO → 客户端实时通道 → 灵动岛排成列表 →
 * 在岛里点"标为已读" → **两条**都要在通知中心变成已读、岛同时整批关闭。
 * 这条同时守住了新加的 `island:mark-all-read` 通道（preload 白名单 → 渲染进程 → 通知中心）。
 */
async function runIslandBatchReadCheck(win: BrowserWindow): Promise<{ ok: boolean; detail: string }> {
  const first = await createSmokeNotification('灵动岛整批已读自检 A');
  const second = await createSmokeNotification('灵动岛整批已读自检 B');
  if (!first || !second) {
    return { ok: false, detail: '未创建出自检通知（后端不可用或缺少冒烟教师凭据）' };
  }
  const onIsland = (id: string, state: ReturnType<typeof island.getState>): boolean =>
    state.active?.id === id || state.queued.some((item) => item.id === id);
  try {
    // 等两条都到达灵动岛
    const deadline = Date.now() + 15_000;
    let state = island.getState();
    while (Date.now() < deadline) {
      state = island.getState();
      if (onIsland(first, state) && onIsland(second, state)) break;
      await sleep(150);
    }
    const bothArrived = onIsland(first, state) && onIsland(second, state);
    if (!bothArrived) {
      return {
        ok: false,
        detail: `通知没都到达灵动岛：A=${onIsland(first, state)} B=${onIsland(second, state)}（当前 ${pendingCountOf(state)} 条）`,
      };
    }
    island.handleAction({ action: 'expand' });
    await sleep(900);
    const islandWin = island.getWindow();
    const listed = await islandWin?.webContents.executeJavaScript(
      `document.querySelectorAll('.island-card.expanded .list-row').length`,
    );
    const clicked = await islandWin?.webContents.executeJavaScript(
      `(() => {
         const button = Array.from(document.querySelectorAll('.island-card.expanded .ghost-btn')).find((node) =>
           (node.textContent ?? '').includes('标为已读'),
         );
         if (!button) return false;
         button.click();
         return true;
       })()`,
    );
    await sleep(1500);
    const readState = async (id: string): Promise<{ read?: boolean } | null> =>
      win.webContents.executeJavaScript(
        `(async () => window.__classhelperSmoke__.islandReadState(${JSON.stringify(id)}))()`,
      );
    const afterFirst = await readState(first);
    const afterSecond = await readState(second);
    const cleared = island.getState();
    const ok =
      clicked === true &&
      Number(listed) >= 2 &&
      afterFirst?.read === true &&
      afterSecond?.read === true &&
      cleared.active === null &&
      cleared.queued.length === 0;
    return {
      ok,
      detail:
        `列表行=${listed} 点击=${clicked} A 已读=${afterFirst?.read} B 已读=${afterSecond?.read} ` +
        `岛剩余=${pendingCountOf(cleared)}`,
    };
  } catch (error) {
    return { ok: false, detail: `执行失败：${error instanceof Error ? error.message : String(error)}` };
  } finally {
    // 清理：删掉自检造的两条通知，别污染演示数据
    await deleteSmokeNotification(first);
    await deleteSmokeNotification(second);
    island.handleAction({ action: 'dismiss' });
    await sleep(300);
  }
}

/**
 * 设置页「真实 UI 链路」自检（用户反馈：**灵动岛设置无法生效并且无法实时预览**）。
 *
 * 为什么必须单独来一条：上面的用例都是直接调 `window.desktop.islandSetAppearance(...)`，
 * 绕过了设置页的控件，于是漏掉了真正的失败模式 —— 设置页把 Vue 的响应式 Proxy（`ref.value`）
 * 直接交给 `ipcRenderer`，结构化克隆会失败并抛出 `An object could not be cloned.`。
 * 这种失败是"半静默"的：滑块数字照常变化、界面不报错，只有主进程里的外观一动不动，
 * 用户看到的就是"拖了滑块没反应、预览也没变化"。
 *
 * 因此这里在真实设置页里合成一次拖拽（mousedown → mousemove → mouseup，与用户操作同一路径），
 * 并同时断言「滑块自身的数值」与「主进程里的外观」都变了 —— 只断言前者会漏掉这个 bug。
 */
/**
 * 设置页**不得**提供改密入口（2026-10-01 用户要求移除）。
 *
 * 历史：客户端曾因"完全没有改密入口"被反馈，补过一个对话框（改的是班级密码）；
 * 后来产品定版为学生个人账号整体清理、班级密码只由管理员在 Web 端「班级管理 → 修改班级账号」
 * 维护，客户端的入口也随之移除。这里做成**负断言**守住"不再退化回来"，
 * 并顺带确认「退出登录」按钮还在（设置页没有被顺手改坏）。
 */
async function runSettingsPagePasswordEntryCheck(
  win: BrowserWindow,
): Promise<{ ok: boolean; detail: string }> {
  const result = (await win.webContents
    .executeJavaScript(
      `(async () => {
         const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
         location.hash = '#/schedule';
         await wait(250);
         location.hash = '#/settings/account';
         let card = null;
         for (let i = 0; i < 40 && !card; i += 1) {
           await wait(100);
           card =
             Array.from(document.querySelectorAll('.el-card')).find((node) =>
               (node.textContent ?? '').includes('账号信息'),
             ) ?? null;
         }
         if (!card) return { ok: false, detail: '设置页里找不到「账号信息」卡片' };
         const buttons = Array.from(card.querySelectorAll('button')).map(
           (node) => (node.textContent ?? '').trim(),
         );
         location.hash = '#/schedule';
         return { ok: true, buttons };
       })()`,
    )
    .catch((error: unknown) => ({
      ok: false as const,
      detail: `执行失败：${error instanceof Error ? error.message : String(error)}`,
    }))) as { ok: true; buttons: string[] } | { ok: false; detail: string } | null;

  if (result?.ok) {
    const hasPassword = result.buttons.some((text) => text.includes('修改密码') || text.includes('密码'));
    return {
      ok: !hasPassword && result.buttons.some((text) => text === '退出登录'),
      detail:
        `账号信息卡片按钮=[${result.buttons.join(', ')}] ` +
        `改密入口存在=${hasPassword}（要求 false）退出登录存在=${result.buttons.includes('退出登录')}`,
    };
  }
  return { ok: false, detail: result?.detail ?? '未执行' };
}

async function runSettingsPageAppearanceCheck(win: BrowserWindow): Promise<{ ok: boolean; detail: string }> {
  const result = (await win.webContents
    .executeJavaScript(
      `(async () => {
         const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
         const before = await window.desktop.islandGetAppearance();
         // 先固定基准高度：避免"当前高度恰好等于拖拽落点"导致假通过或假失败
         window.desktop.islandSetAppearance({ ...before, height: 44 });
         await wait(300);

         location.hash = '#/settings/island';
         let runway = null;
         for (let i = 0; i < 40 && !runway; i += 1) {
           await wait(100);
           runway = document.querySelector('.el-slider__runway');
         }
         if (!runway) return { ok: false, detail: '设置页未渲染出滑块（未登录或页面未挂载）' };
         const rect = runway.getBoundingClientRect();
         if (!rect.width) return { ok: false, detail: '滑块宽度为 0，无法拖拽' };

         const x = rect.left + rect.width * 0.9;
         const y = rect.top + rect.height / 2;
         const fire = (target, type, extra) =>
           target.dispatchEvent(
             new MouseEvent(
               type,
               Object.assign({ bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }, extra),
             ),
           );
         fire(runway, 'mousedown', { buttons: 1 });
         await wait(60);
         fire(window, 'mousemove', { buttons: 1 });
         await wait(60);
         fire(window, 'mouseup', {});
         await wait(600);

         const dragged = await window.desktop.islandGetAppearance();
         const label =
           Array.from(document.querySelectorAll('.el-form-item__label'))
             .map((node) => (node.textContent ?? '').trim())
             .find((text) => text.startsWith('高度')) ?? '';
         // 复原外观与路由，不影响后续用例
         window.desktop.islandSetAppearance({ ...before });
         location.hash = '#/schedule';
         return { ok: true, baseline: 44, dragged: dragged.height, label };
       })()`,
    )
    .catch((error: unknown) => ({
      ok: false as const,
      detail: `执行失败：${error instanceof Error ? error.message : String(error)}`,
    }))) as
    { ok: true; baseline: number; dragged: number; label: string } | { ok: false; detail: string } | null;

  if (result?.ok) {
    return {
      ok: result.dragged !== result.baseline && result.label === `高度 ${result.dragged}px`,
      detail:
        `拖动高度滑块到 90%：页面标签="${result.label}"，` +
        `主进程外观高度 ${result.baseline} → ${result.dragged}`,
    };
  }
  return { ok: false, detail: result?.detail ?? '未执行' };
}

/**
 * 设置页「左右边距」自检（用户反馈：调左右边距**没有实时预览、也不生效**）。
 *
 * 为什么不能只调主进程：先前那条用例是直接 `island.setAppearance(...)`，绕过了
 * 「设置页 → preload → IPC → 主进程」这条真实链路 —— 用户遇到的失败很可能就在这一段。
 * 因此这里在真实设置页里对「左右边距」滑块合成一次拖拽，并且：
 *   1) 断言主进程 appearance.marginX 真的变了（IPC + 写值通了）；
 *   2) 断言岛的**真实几何**按新边距移动（窗口重排生效）。
 *
 * 岛的真实几何来自渲染进程上报（readGeometry），不是窗口 bounds —— 窗口是固定包围盒，
 * 只有岛体坐标才反映锚点。
 */
async function runSettingsPageMarginCheck(
  win: BrowserWindow,
  readGeometry: () => Promise<{ island: Electron.Rectangle } | null>,
): Promise<{ ok: boolean; detail: string }> {
  const appearanceBefore = island.getAppearance();

  // 1) 默认（居中）停靠：左右边距**必须**被禁用并给出原因，否则用户会一直以为"调了不生效"
  island.setAppearance({ ...appearanceBefore, position: 'top-center' });
  await sleep(300);
  const centerHint = (await win.webContents.executeJavaScript(
    `(async () => {
       const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
       // 必须"离开再回来"：设置页只在挂载时读一次外观，同 hash 再赋值不会重新挂载，
       // 页面里会留着过期的位置（这正是"改了设置没反应"的一个真实来源）
       location.hash = '#/schedule';
       await wait(250);
       location.hash = '#/settings/island';
       let item = null;
       for (let i = 0; i < 40 && !item; i += 1) {
         await wait(100);
         item = Array.from(document.querySelectorAll('.el-form-item')).find((node) =>
           (node.querySelector('.el-form-item__label')?.textContent ?? '').startsWith('左右边距'),
         );
       }
       if (!item) return { ok: false, detail: '找不到「左右边距」表单项' };
       const slider = item.querySelector('.el-slider');
       const runway = item.querySelector('.el-slider__runway');
       const disabled =
         slider?.classList.contains('is-disabled') === true ||
         runway?.classList.contains('is-disabled') === true ||
         slider?.getAttribute('aria-disabled') === 'true' ||
         runway?.getAttribute('aria-disabled') === 'true';
       const text = (item.textContent ?? '').replace(/\s+/g, ' ').trim();
       return { ok: true, disabled, hasHint: text.includes('居中') && text.includes('不生效') };
     })()`,
  )) as { ok: boolean; disabled?: boolean; hasHint?: boolean; detail?: string } | null;

  if (!centerHint?.ok || centerHint.disabled !== true || centerHint.hasHint !== true) {
    island.setAppearance(appearanceBefore);
    return {
      ok: false,
      detail:
        '居中停靠时「左右边距」的禁用/说明缺失：' +
        (centerHint?.ok
          ? `disabled=${centerHint.disabled} hasHint=${centerHint.hasHint}`
          : `${centerHint?.detail ?? '未执行'}`),
    };
  }

  // 2) 改成左停靠后再验"拖滑块 → 岛真的移动"
  island.setAppearance({ ...appearanceBefore, position: 'top-left', marginX: 8, marginY: 8 });
  await sleep(500);
  const before = (await readGeometry())?.island ?? null;

  const drag = (await win.webContents
    .executeJavaScript(
      `(async () => {
         const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
       location.hash = '#/schedule';
       await wait(200);
       location.hash = '#/settings/island';
       let runway = null;
       for (let i = 0; i < 40 && !runway; i += 1) {
         await wait(100);
         const item = Array.from(document.querySelectorAll('.el-form-item')).find((node) =>
           (node.querySelector('.el-form-item__label')?.textContent ?? '').startsWith('左右边距'),
         );
           runway = item?.querySelector('.el-slider__runway') ?? null;
         }
         if (!runway) return { ok: false, detail: '设置页里找不到「左右边距」滑块' };
         const marginItem = runway.closest('.el-form-item');
         const marginSlider = marginItem?.querySelector('.el-slider');
         const sliderDisabled = () =>
           marginSlider?.classList.contains('is-disabled') === true ||
           runway.classList.contains('is-disabled') === true;
         // 等滑块可用：页面必须已经读到「左停靠」的最新外观，否则拖了也不会生效
         let waited = 0;
         while (sliderDisabled() && waited < 4000) {
           await wait(150);
           waited += 150;
         }
         const positionText = (() => {
           const posItem = Array.from(document.querySelectorAll('.el-form-item')).find((node) =>
             (node.querySelector('.el-form-item__label')?.textContent ?? '').trim() === '显示位置',
           );
           return (posItem?.querySelector('.el-select')?.textContent ?? '').trim();
         })();
         if (sliderDisabled()) {
           return {
             ok: false,
             detail:
               '左停靠下「左右边距」仍被禁用（页面没刷新到最新位置：显示位置=「' + positionText + '」）',
           };
         }
         const rect = runway.getBoundingClientRect();
         if (rect.width === 0) return { ok: false, detail: '滑块宽度为 0' };
         const centerDisabled = false;
         const x = rect.left + rect.width * 0.75;
         const y = rect.top + rect.height / 2;
         const fire = (target, type, extra) =>
           target.dispatchEvent(
             new MouseEvent(
               type,
               Object.assign({ bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }, extra),
             ),
           );
         fire(runway, 'mousedown', { buttons: 1 });
         await wait(60);
         fire(window, 'mousemove', { buttons: 1 });
         await wait(60);
         fire(window, 'mouseup', {});
         await wait(600);
         const label =
           Array.from(document.querySelectorAll('.el-form-item__label'))
             .map((node) => (node.textContent ?? '').trim())
             .find((text) => text.startsWith('左右边距')) ?? '';
         return { ok: true, label, centerDisabled };
       })()`,
    )
    .catch((error: unknown) => ({ ok: false, detail: String(error) }))) as
    | { ok: true; label: string; centerDisabled: boolean; positionText: string }
    | { ok: false; detail: string }
    | null;

  await sleep(500);
  const after = (await readGeometry())?.island ?? null;
  const appearanceAfter = island.getAppearance();
  island.setAppearance(appearanceBefore);
  await sleep(250);

  const expectedX = before ? before.x + (appearanceAfter.marginX - 8) : null;
  const ipcOk = appearanceAfter.marginX > 8;
  const movedOk = Boolean(before && after && expectedX !== null && Math.abs(after.x - expectedX) <= 2);
  return {
    ok: Boolean(drag?.ok) && ipcOk && movedOk && (drag?.ok ? drag.centerDisabled === false : false),
    detail:
      '居中停靠时禁用+说明=✓；改左停靠（页面显示「' +
      (drag?.ok ? drag.positionText : '-') +
      '」）后拖到 75%：标签=' +
      (drag?.ok ? drag.label : '-') +
      '，主进程 marginX ' +
      appearanceBefore.marginX +
      ' → ' +
      appearanceAfter.marginX +
      '（IPC=' +
      ipcOk +
      '），岛 x ' +
      (before?.x ?? '-') +
      ' → ' +
      (after?.x ?? '-') +
      '（期望 ' +
      expectedX +
      '，移动=' +
      movedOk +
      '）' +
      (drag?.ok ? '' : '｜' + drag?.detail),
  };
}
async function runSettingsPageChannelCheck(win: BrowserWindow): Promise<{ ok: boolean; detail: string }> {
  const result = (await win.webContents
    .executeJavaScript(
      `(async () => {
         const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
         const before = (await window.desktop.getConfig()).notificationChannel;
         location.hash = '#/settings/reminder';

         // 找到「通知显示位置」那张卡片里的单选组
         let group = null;
         for (let i = 0; i < 40 && !group; i += 1) {
           await wait(100);
           group = Array.from(document.querySelectorAll('.el-card')).find((card) =>
             (card.querySelector('.el-card__header')?.textContent ?? '').includes('ClassIsland 联动'),
           );
         }
         if (!group) return { ok: false, detail: '设置页没有「ClassIsland 联动」卡片' };
         const radios = Array.from(group.querySelectorAll('.el-radio'));
          // 注意：这段脚本本身是外层模板字符串，里面不能再出现反引号（会截断外层字符串）
          if (radios.length < 3) return { ok: false, detail: '单选项只有 ' + radios.length + ' 个' };

         // 点第二个（只在 ClassHelper 客户端弹），断言配置真的写下去了
         radios[1].click();
         await wait(600);
         const afterClient = (await window.desktop.getConfig()).notificationChannel;
         const clientChecked = radios[1].classList.contains('is-checked');

         // 再点回第一个（两端都弹），避免影响后续用例
         radios[0].click();
         await wait(600);
         const afterBoth = (await window.desktop.getConfig()).notificationChannel;

         location.hash = '#/schedule';
         return { ok: true, before, afterClient, afterBoth, clientChecked, labels: radios.map((n) => n.textContent.trim()) };
       })()`,
    )
    .catch((error: unknown) => ({
      ok: false as const,
      detail: `执行失败：${error instanceof Error ? error.message : String(error)}`,
    }))) as
    | {
        ok: true;
        before: string;
        afterClient: string;
        afterBoth: string;
        clientChecked: boolean;
        labels: string[];
      }
    | { ok: false; detail: string }
    | null;

  if (result?.ok) {
    return {
      ok: result.afterClient === 'client' && result.clientChecked && result.afterBoth === 'both',
      detail:
        `单选项=[${result.labels.join(' / ')}]，` +
        `选择「只在 ClassHelper 客户端弹」后配置 ${result.before} → ${result.afterClient}（选中=${result.clientChecked}），` +
        `切回后 ${result.afterBoth}`,
    };
  }
  return { ok: false, detail: result?.detail ?? '未执行' };
}
/**
 * Electron 冒烟验证（ELECTRON_SMOKE_TEST=1 时触发，跑完自动退出）。
 * 覆盖：preload 桥接、渲染进程挂载、登录页 DOM、IndexedDB 缓存读写、离线回退，
 * 以及可选的联网集成（ELECTRON_SMOKE_ONLINE=1）。
 *
 * 结果同时输出到 stdout，并在设置 ELECTRON_SMOKE_RESULT 时写入 JSON 文件 ——
 * 打包后的 Windows GUI 进程没有 stdout，用结果文件才能在 CI/脚本里验证安装包。
 */

/**
 * 托盘与退出清理校验（需求 5）。
 * 这两个用例会隐藏主窗口并销毁托盘/灵动岛，因此必须放在所有依赖它们的用例之后。
 */
async function runTrayAndShutdownChecks(mainWin: BrowserWindow, record: Recorder): Promise<void> {
  // 11) 关闭到托盘：窗口关闭后进程存活、托盘仍在；清理后资源归零
  const trayBefore = getTrayState();
  mainWin.close();
  await sleep(500);
  const afterClose = { visible: mainWin.isVisible(), destroyed: mainWin.isDestroyed(), alive: app.isReady() };
  record(
    '关闭窗口隐藏到托盘（进程继续后台运行）',
    trayBefore.ready === true &&
      afterClose.visible === false &&
      afterClose.destroyed === false &&
      afterClose.alive === true,
    `托盘就绪=${trayBefore.ready} 有图标=${trayBefore.hasIcon} 关闭后 visible=${afterClose.visible} destroyed=${afterClose.destroyed} 进程存活=${afterClose.alive}`,
  );

  destroyTray();
  island.destroy();
  // 卡片外圈自检用的纯色底板（若已创建）也要一并释放，不留隐藏窗口
  if (islandBackdropWindow && !islandBackdropWindow.isDestroyed()) islandBackdropWindow.destroy();
  islandBackdropWindow = null;
  await sleep(200);
  record(
    '退出前资源清理（托盘/灵动岛已释放）',
    isTrayReady() === false && island.isReady() === false,
    `托盘=${isTrayReady()} 灵动岛=${island.isReady()}`,
  );
}
export async function runSmokeTest(win: BrowserWindow): Promise<void> {
  const results: SmokeResult[] = [];
  const record = (name: string, ok: boolean, detail = ''): void => {
    results.push({ name, ok, detail });
    console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? ` - ${detail}` : ''}`);
  };

  // 等待 Vue 挂载并完成启动流程（离线时最多等 14 秒）
  let dom: {
    title: string;
    appChildren: number;
    hasLoginPage: boolean;
    hasInput: boolean;
    hasLayout: boolean;
    text: string;
  } | null = null;

  const snapshot = async (): Promise<typeof dom> =>
    win.webContents.executeJavaScript(
      `(() => {
         const app = document.querySelector('#app');
         return {
           title: document.title,
           appChildren: app ? app.children.length : 0,
           hasLoginPage: Boolean(document.querySelector('.login-page')),
           hasInput: Boolean(document.querySelector('input')),
           hasLayout: document.querySelectorAll('.el-menu-item').length > 0,
           text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 80),
         };
       })()`,
    );

  for (let attempt = 0; attempt < 56; attempt += 1) {
    dom = await snapshot();
    // 等到登录页或主布局真正渲染出来（而不是停在启动过渡页）
    if ((dom?.hasLoginPage && dom?.hasInput) || dom?.hasLayout) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  // 上次运行可能残留登录态（客户端会直接进主界面）——先退出登录，再校验登录页
  if (dom?.hasLayout && !dom?.hasLoginPage) {
    console.log('[SMOKE] 检测到已保存的登录态，先退出登录再校验登录页');
    await win.webContents.executeJavaScript(
      `(async () => {
         if (!window.__classhelperSmoke__) return false;
         await window.__classhelperSmoke__.sessionCleanup();
         location.hash = '#/login';
         return true;
       })()`,
    );
    for (let attempt = 0; attempt < 40; attempt += 1) {
      dom = await snapshot();
      if (dom?.hasLoginPage && dom?.hasInput) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  record('渲染进程挂载（#app 有子节点）', (dom?.appChildren ?? 0) > 0, `children=${dom?.appChildren ?? 0}`);
  record(
    '窗口标题正确',
    dom?.title === '班级小助手' || (dom?.title ?? '').includes('班级小助手'),
    `title=${dom?.title}`,
  );
  record(
    '登录页渲染（服务器地址/用户名/密码输入框）',
    Boolean(dom?.hasLoginPage && dom?.hasInput),
    `text=${dom?.text ?? ''}`,
  );

  // 初始窗口尺寸：与 ClassIsland 主窗口对齐（实测其可视区 1242x582，见 main/index.ts）
  const [initialWidth, initialHeight] = win.getSize();
  record(
    '初始窗口尺寸与 ClassIsland 对齐（1242x582）',
    initialWidth === 1242 && initialHeight === 582,
    `实际 ${initialWidth}x${initialHeight}`,
  );

  // 初次启动引导（新装客户端首启自动弹出）：真实点击走完一遍，断言完成后写入配置。
  // 必须放在"登录页不含示例内容"的全文扫描**之前**——那时引导还开着，先把它的文案从屏幕上撤走。
  const onboarding = await win.webContents.executeJavaScript(
    `(async () => {
       if (!window.__classhelperSmoke__?.onboardingSelfTest) return { ok: false, detail: '缺少引导自检钩子' };
       return await window.__classhelperSmoke__.onboardingSelfTest();
     })()`,
  );
  record(
    '初次启动引导（首启自动弹出、可走完、状态写入配置）',
    Boolean(onboarding?.ok),
    String(onboarding?.detail ?? ''),
  );

  // 需求："删掉登录页所有示例内容" —— 占位符/提示里不允许出现示例班级码或示例账号。
  // 判据不写死具体示例码：用"演示/示例"字样 + 旧版占位符的**形状**（例如 G101）+ 环境变量传入的凭据，
  // 这样断言更严（任何"例如 XXX123"都会被抓到），安装包里也不留示例账号字面量。
  const loginExampleLeak = await win.webContents.executeJavaScript(
    `(() => {
       const text = (document.body.innerText || '') + ' ' + Array.from(document.querySelectorAll('input'))
         .map((node) => node.getAttribute('placeholder') || '')
         .join(' ');
       const tokens = ['演示', '示例'].concat(${JSON.stringify(smokeCredentialTokens)});
       const leaked = tokens.filter((item) => text.includes(item));
       // 旧版登录页的占位符样式："例如 G101" / "例如G101"
       if (/例如\\s*[A-Z]{1,3}\\d{2,4}/.test(text)) leaked.push('例如 <班级码>');
       return { leaked };
     })()`,
  );
  record(
    '登录页不含示例内容（无示例班级码/演示账号）',
    (loginExampleLeak?.leaked ?? ['?']).length === 0,
    `越界文案=[${(loginExampleLeak?.leaked ?? []).join(',')}]` +
      (smokeCredentialTokens.length === 0 ? '（未提供冒烟凭据，仅按"演示/示例"与占位符形状判定）' : ''),
  );

  // preload 桥接
  const bridge = await win.webContents.executeJavaScript(
    `(() => ({
       hasBridge: typeof window.desktop === 'object' && window.desktop !== null,
       methods: Object.keys(window.desktop ?? {}).sort(),
     }))()`,
  );
  record(
    'preload contextBridge 注入',
    Boolean(bridge?.hasBridge) && Array.isArray(bridge?.methods) && bridge.methods.includes('getConfig'),
    `methods=${(bridge?.methods ?? []).join(',')}`,
  );

  // IPC 往返（渲染进程 <-> 主进程）
  const ipcRoundTrip = await win.webContents.executeJavaScript(
    `(async () => {
       const info = await window.desktop.getAppInfo();
       const saved = await window.desktop.saveConfig({ serverUrl: 'http://127.0.0.1:4000' });
       return { electron: info.electron, hasSmokeFlag: info.smokeTest === true, serverUrl: saved.serverUrl, userData: info.userDataPath };
     })()`,
  );
  record(
    'IPC 调用主进程（getAppInfo / saveConfig）',
    Boolean(ipcRoundTrip?.electron) && ipcRoundTrip?.serverUrl === 'http://127.0.0.1:4000',
    `electron=${ipcRoundTrip?.electron} serverUrl=${ipcRoundTrip?.serverUrl}`,
  );

  const diagnostics = getDiagnostics();
  record('配置文件已写入用户目录', diagnostics.config.serverUrl.length > 0, diagnostics.configPath);

  // IndexedDB 缓存自检
  const cacheSelfTest = await win.webContents.executeJavaScript(
    `(async () => {
       if (!window.__classhelperSmoke__) return { ok: false, detail: '渲染进程未注册冒烟钩子' };
       return await window.__classhelperSmoke__.cacheSelfTest();
     })()`,
  );
  record('IndexedDB 缓存读写', Boolean(cacheSelfTest?.ok), String(cacheSelfTest?.detail ?? ''));

  // 离线回退场景
  const offline = await win.webContents.executeJavaScript(
    `(async () => {
       if (!window.__classhelperSmoke__) return { ok: false, detail: '渲染进程未注册冒烟钩子' };
       return await window.__classhelperSmoke__.offlineScenario();
     })()`,
  );
  record('断网时回退到本地缓存', Boolean(offline?.ok), String(offline?.detail ?? ''));

  // ---------------------------------------------------------------- 灵动岛
  await runIslandChecks(win, record, results);

  // 可选：对真实后端做联网集成自检（ELECTRON_SMOKE_ONLINE=1 时启用）
  if (process.env.ELECTRON_SMOKE_ONLINE === '1') {
    // 班级账号凭据由 scripts/smoke.mjs 通过管理端接口准备（渲染进程读不到 process.env）
    const classCode = process.env.ELECTRON_SMOKE_CLASS_CODE ?? '';
    const classPassword = process.env.ELECTRON_SMOKE_CLASS_PASSWORD ?? '';
    const online = await win.webContents.executeJavaScript(
      `(async () => {
         if (!window.__classhelperSmoke__) return { ok: false, detail: '渲染进程未注册冒烟钩子' };
         return await window.__classhelperSmoke__.onlineScenario(${JSON.stringify({ code: classCode, password: classPassword })});
       })()`,
    );
    record(
      '联网集成（登录 + 布局挂载 + 四类数据 + Socket.IO + 缓存写入）',
      Boolean(online?.ok),
      String(online?.detail ?? ''),
    );

    // 设置页真实 UI 链路（用户反馈："灵动岛设置无法生效并且无法实时预览"）：
    // 必须真的去拖设置页里的滑块 —— 直接调 window.desktop.* 会绕过
    // 「Vue 响应式 Proxy 过不了 IPC 结构化克隆」这个失败模式。
    const settingsAppearance = await runSettingsPageAppearanceCheck(win);
    record('设置页真实 UI：拖拽滑块即时改变灵动岛外观', settingsAppearance.ok, settingsAppearance.detail);

    // 通知显示位置（客户端自己选）：提醒弹在 ClassHelper 还是 ClassIsland
    const settingsChannel = await runSettingsPageChannelCheck(win);
    record('设置页真实 UI：切换「通知显示位置」写回本地配置', settingsChannel.ok, settingsChannel.detail);

    // 改密入口（2026-10-01 用户要求移除：班级密码只由管理员在 Web 端维护）——负断言防退化
    const settingsPassword = await runSettingsPagePasswordEntryCheck(win);
    record('设置页真实 UI：不再提供「修改密码」入口', settingsPassword.ok, settingsPassword.detail);

    // 左右边距：必须走「设置页拖滑块」的真实链路（用户反馈：调了没实时预览、也不生效）
    const settingsMargin = await runSettingsPageMarginCheck(win, () =>
      island.getWindow() ? readIslandGeometryFrom(island.getWindow()!) : Promise.resolve(null),
    );
    record('设置页真实 UI：拖「左右边距」滑块立即生效', settingsMargin.ok, settingsMargin.detail);

    // 真实通知链路：教师发通知 → 客户端实时通道 → 灵动岛胶囊；
    // 随后在灵动岛点"标为已读"，验证通知中心同步为已读（修复"点了已读仍显示未读"）
    const realtime = await runIslandRealtimeCheck(win);
    record('真实通知链路（Socket.IO → 灵动岛胶囊）', realtime.delivered, realtime.deliveryDetail);
    record('灵动岛"标为已读"同步通知中心', realtime.markRead, realtime.markReadDetail);

    // 多条通知的整批已读（用户要求：那一排按钮里的"标为已读"默认把这一批全标上）。
    // 必须放在登录之后：这两条通知要真的经 Socket.IO 到达客户端并排成列表。
    const batchRead = await runIslandBatchReadCheck(win);
    record('多条通知点「标为已读」：整批已读并关闭', batchRead.ok, batchRead.detail);

    // ClassIsland 风格「今天」时间轴：造课 → 断言高亮/倒计时/大时钟 → 清理
    const timeline = await win.webContents.executeJavaScript(
      `(async () => {
         if (!window.__classhelperSmoke__?.scheduleTimelineSelfTest) return { ok: false, detail: '缺少时间轴自检钩子' };
         return await window.__classhelperSmoke__.scheduleTimelineSelfTest();
       })()`,
    );
    record(
      '课表「今天」时间轴（当前课高亮/倒计时/大时钟）',
      Boolean(timeline?.ok),
      String(timeline?.detail ?? ''),
    );

    // 作业看板全屏自适应（用户反馈：全屏看板没有铺满屏幕）：
    // 进作业页 → 切看板 → 打开全屏 → 量布局宽度/可视底部，要求铺满且不需要滚动
    const boardFullscreen = await win.webContents.executeJavaScript(
      `(async () => {
         if (!window.__classhelperSmoke__?.homeworkBoardSelfTest) return { ok: false, detail: '缺少看板自适应自检钩子' };
         return await window.__classhelperSmoke__.homeworkBoardSelfTest();
       })()`,
    );
    record(
      '作业看板全屏自适应（铺满屏幕、内容不溢出）',
      Boolean(boardFullscreen?.ok),
      String(boardFullscreen?.detail ?? ''),
    );

    // 侧边栏点击导航（回归测试：曾因把 index 当路由名导致点击无反应）
    const navigation = await win.webContents.executeJavaScript(
      `(async () => {
         if (!window.__classhelperSmoke__) return { ok: false, detail: '渲染进程未注册冒烟钩子' };
         return await window.__classhelperSmoke__.layoutNavigationSelfTest();
       })()`,
    );
    record('侧边栏点击导航（逐一点击 5 个菜单）', Boolean(navigation?.ok), String(navigation?.detail ?? ''));

    // 主界面外观件（新功能回归）：真实点击主题日月按钮与侧边栏汉堡按钮，
    // 断言 html.dark 翻转、collapse 态生效、两者都写入主进程配置；结束时还原主题
    const chrome = await win.webContents.executeJavaScript(
      `(async () => {
         if (!window.__classhelperSmoke__?.layoutChromeSelfTest) return { ok: false, detail: '缺少外观件自检钩子' };
         return await window.__classhelperSmoke__.layoutChromeSelfTest();
       })()`,
    );
    record('主题切换与侧边栏折叠（真实点击、写回配置）', Boolean(chrome?.ok), String(chrome?.detail ?? ''));

    // 关于页（新功能回归）：/settings/about 渲染 + 诊断信息（getAppInfo 含 configPath）
    const aboutPage = await win.webContents.executeJavaScript(
      `(async () => {
         if (!window.__classhelperSmoke__?.aboutPageSelfTest) return { ok: false, detail: '缺少关于页自检钩子' };
         return await window.__classhelperSmoke__.aboutPageSelfTest();
       })()`,
    );
    record('关于页渲染（应用信息/诊断信息/鸣谢）', Boolean(aboutPage?.ok), String(aboutPage?.detail ?? ''));

    // 未读红点必须挂在"通知"图标右上方（用户反馈：原来挂在文字后面，位置不对）
    const readBadgeGeometry = async (): Promise<{
      ok: boolean;
      skipped?: string;
      reason?: string;
      dx?: number;
      dy?: number;
      text?: string;
    } | null> =>
      await win.webContents
        .executeJavaScript(
          `(() => {
             const item = Array.from(document.querySelectorAll('.el-menu-item')).find((node) =>
               (node.textContent ?? '').includes('通知'),
             );
             if (!item) return { ok: false, reason: '找不到通知菜单项' };
             const badge = item.querySelector('.menu-badge');
             const icon = item.querySelector('.menu-icon-slot .el-icon');
             if (!badge) return { ok: true, skipped: '当前没有未读消息' };
             if (!icon) return { ok: false, reason: '通知图标没有 .menu-icon-slot 定位父级' };
             const b = badge.getBoundingClientRect();
             const i = icon.getBoundingClientRect();
             return {
               ok: true,
               dx: Math.round(b.left + b.width / 2 - (i.left + i.width / 2)),
               dy: Math.round(b.top + b.height / 2 - (i.top + i.height / 2)),
               text: (badge.textContent ?? '').trim(),
             };
           })()`,
        )
        .catch(() => null);

    let badgeCheck = await readBadgeGeometry();
    let injectedId = '';
    if (badgeCheck?.skipped) {
      // 没有未读消息时红点不会渲染：造一条未读通知（教师账号），等实时推送刷新后再断言位置
      const created = await createSmokeNotification();
      if (created) {
        injectedId = created;
        await sleep(1400);
        badgeCheck = await readBadgeGeometry();
      }
    }
    record(
      '未读红点位置正确（挂在"通知"图标右上方）',
      badgeCheck?.ok === true &&
        (badgeCheck?.skipped !== undefined || ((badgeCheck?.dx ?? 0) > 0 && (badgeCheck?.dy ?? 0) < 0)),
      badgeCheck?.skipped
        ? `${badgeCheck.skipped}（未能构造未读消息，已跳过位置断言）`
        : `红点=${badgeCheck?.text} 相对图标中心 dx=${badgeCheck?.dx} dy=${badgeCheck?.dy}（要求 dx>0 且 dy<0）` +
            `${badgeCheck?.reason ? ` 原因=${badgeCheck.reason}` : ''}`,
    );
    if (injectedId) await deleteSmokeNotification(injectedId);

    const cleanup = await win.webContents.executeJavaScript(
      `(async () => {
         if (!window.__classhelperSmoke__) return { ok: false, detail: '渲染进程未注册冒烟钩子' };
         return await window.__classhelperSmoke__.sessionCleanup();
       })()`,
    );
    record('冒烟收尾：清理登录态', Boolean(cleanup?.ok), String(cleanup?.detail ?? ''));
  }

  /**
   * 把当前结果落盘 + 打印汇总。
   * 为什么要写两次：托盘/退出清理用例会真的走一遍"退出应用"，进程可能在收尾代码执行前就退出，
   * 那样 ELECTRON_SMOKE_RESULT 就不会生成（重启校验会误报"结果=-1/0"）。
   * 所以在跑托盘用例之前先写一次，收尾再写一次（覆盖全部用例）。
   */
  const writeResult = (): void => {
    const failedItems = results.filter((item) => !item.ok);
    const passedCount = results.length - failedItems.length;
    console.log(`\n[SMOKE] ${passedCount}/${results.length} 项通过`);
    const resultFile = process.env.ELECTRON_SMOKE_RESULT;
    if (!resultFile) return;
    try {
      fs.mkdirSync(path.dirname(resultFile), { recursive: true });
      fs.writeFileSync(
        resultFile,
        JSON.stringify(
          {
            passed: passedCount,
            total: results.length,
            ok: failedItems.length === 0,
            results,
            finishedAt: new Date().toISOString(),
            appVersion: app.getVersion(),
            packaged: app.isPackaged,
          },
          null,
          2,
        ),
        'utf8',
      );
      console.log(`[SMOKE] 结果已写入 ${resultFile}`);
    } catch (error) {
      console.error('[SMOKE] 写入结果文件失败', error);
    }
  };

  writeResult();

  // 托盘与退出清理放在最后：会隐藏主窗口并销毁托盘/灵动岛
  await runTrayAndShutdownChecks(win, record);

  writeResult();

  const failed = results.filter((item) => !item.ok);
  app.exit(failed.length === 0 ? 0 : 1);
}
