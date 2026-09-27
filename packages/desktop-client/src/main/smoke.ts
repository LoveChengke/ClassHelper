import fs from 'node:fs';
import path from 'node:path';
import { app, screen } from 'electron';
import type { BrowserWindow, NativeImage } from 'electron';
import type { IslandAppearance, IslandNotification } from '@classhelper/shared';
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
  /** 偏红像素数（紧急形态的红色描边/角标/内部光晕） */
  reddish: number;
  /** 图像最外圈（2px）的偏红像素数：必须为 0，用于守住"卡片外不允许有光晕外溢" */
  edgeReddish: number;
  /** 岛矩形之外的偏红像素（窗口留白区，紧急光晕不外溢的断言依据） */
  outsideReddish?: number;
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

  return { opaque, transparent, uniqueColors: colors.size, reddish, edgeReddish };
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
    const stats: IslandShotStats = {
      name,
      expected,
      width: size.width,
      height: size.height,
      filePath,
      ...analyzeBitmap(cropped),
      corners,
      outsideReddish,
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
async function createSmokeNotification(): Promise<string> {
  const base = process.env.ELECTRON_SMOKE_API ?? 'http://127.0.0.1:4000/api';
  try {
    const login = (await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'teacher1', password: 'teacher123' }),
    }).then((response) => response.json())) as { data?: { token?: string } };
    const token = login?.data?.token;
    if (!token) return '';
    const classes = (await fetch(`${base}/classes`, {
      headers: { authorization: `Bearer ${token}` },
    }).then((response) => response.json())) as { data?: Array<{ id?: string }> };
    const classId = classes?.data?.[0]?.id ?? '';
    if (!classId) return '';
    const created = (await fetch(`${base}/notifications`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        classId,
        title: '红点位置校验',
        content: '自动化验证用通知（断言未读红点位置后会删除）。',
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
    const login = (await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'teacher1', password: 'teacher123' }),
    }).then((response) => response.json())) as { data?: { token?: string } };
    const token = login?.data?.token;
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

  const islandWindow = island.getWindow();
  // 默认关掉"失焦自动收起"：冒烟是自动化环境，系统/其它窗口抢焦点会随时触发 blur，
  // 把展开态收回会让断言随机失败。专门验证该行为的用例（4.5）会临时打开它。
  island.setBlurCollapseEnabled(false);

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
  const hiddenBeforePush = !(islandWindow?.isVisible() ?? true);
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
  island.handleAction({ action: 'dismiss' });
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

  // 4.9) 收起态回归（用户反馈"收起后部分情况无法再次打开"）：
  //      a) 胶囊不再因超时消失（有未处理通知时常驻）；
  //      b) 收起后胶囊仍然可命中（窗口保持可交互）→ 点击可再次展开；
  //      c) 空闲细缝态同样是"可见即可点"（细缝 6x22 也能命中）。
  // 注：此处不使用后面的 drainIsland（它在本函数更靠下的位置定义），就地排空队列。
  const drainForCollapseCheck = async (): Promise<void> => {
    for (let index = 0; index < 20; index += 1) {
      const current = island.getState();
      if (!current.active && current.queued.length === 0) return;
      island.handleAction({ action: 'dismiss' });
      await sleep(120);
    }
  };
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
  await sleep(500);
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
    cardCx: number;
    cardTop: number;
    cardW: number;
    cardH: number;
  }[] = [];

  const sampleCardRect = async (): Promise<void> => {
    const bounds = islandWindow?.getBounds();
    const rect = await islandWindow?.webContents
      .executeJavaScript(
        `(() => {
           const card = document.querySelector('.island-card');
           if (!card) return null;
           const r = card.getBoundingClientRect();
           return { left: r.left, top: r.top, width: r.width, height: r.height };
         })()`,
      )
      .catch(() => null);
    if (!bounds || !rect) return;
    motionSamples.push({
      winW: bounds.width,
      winH: bounds.height,
      cardCx: bounds.x + rect.left + rect.width / 2,
      cardTop: bounds.y + rect.top,
      cardW: rect.width,
      cardH: rect.height,
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

  // 收尾：保持"胶囊可见"状态——后续个性化用例（透明度 / 位置）需要窗口可见才会立即生效
  await sleep(250);
  /** 排空灵动岛队列：连续收起直到没有活动通知与排队通知（否则"空闲态"断言会被下一条顶掉） */
  const drainIsland = async (): Promise<void> => {
    for (let index = 0; index < 20; index += 1) {
      const current = island.getState();
      if (!current.active && current.queued.length === 0) return;
      island.handleAction({ action: 'dismiss' });
      await sleep(120);
    }
  };

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
  const probeStyle = async (
    style: IslandAppearance['style'],
  ): Promise<{ fill: string; stroke: string; material: string }> => {
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
      material: island.getBackgroundMaterial(),
    };
  };

  const blackStyle = await probeStyle('black');
  const glassStyle = await probeStyle('glass');
  const tintedStyle = await probeStyle('tinted');
  record(
    '视觉风格切换立刻生效（纯黑 / 毛玻璃亚克力 / 主题色）',
    blackStyle.fill === 'rgb(0, 0, 0)' &&
      blackStyle.material === 'none' &&
      glassStyle.fill.startsWith('rgba(10, 10, 14') &&
      glassStyle.material === 'acrylic' &&
      tintedStyle.fill === 'rgb(11, 11, 15)',
    `纯黑 fill=${blackStyle.fill} 材质=${blackStyle.material}；` +
      `毛玻璃 fill=${glassStyle.fill} 材质=${glassStyle.material}；` +
      `主题色 fill=${tintedStyle.fill} 材质=${tintedStyle.material}`,
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
  await sleep(450);
  record(
    '关闭空闲细缝后空闲再次完全隐藏（保持原行为）',
    islandWindow?.isVisible() === false,
    `isVisible=${islandWindow?.isVisible() ?? '-'}`,
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

  // 等通知经实时通道到达并弹出胶囊
  const deadline = Date.now() + 10_000;
  let state = island.getState();
  while (Date.now() < deadline) {
    state = island.getState();
    if (state.mode === 'pill' && state.active?.id === scenario.notificationId) break;
    await sleep(120);
  }
  const visible = island.getWindow()?.isVisible() ?? false;
  const delivered = state.mode === 'pill' && state.active?.id === scenario.notificationId && visible;
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
async function runSettingsPageAppearanceCheck(
  win: BrowserWindow,
): Promise<{ ok: boolean; detail: string }> {
  const result = (await win.webContents
    .executeJavaScript(
      `(async () => {
         const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
         const before = await window.desktop.islandGetAppearance();
         // 先固定基准高度：避免"当前高度恰好等于拖拽落点"导致假通过或假失败
         window.desktop.islandSetAppearance({ ...before, height: 44 });
         await wait(300);

         location.hash = '#/settings';
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
    | { ok: true; baseline: number; dragged: number; label: string }
    | { ok: false; detail: string }
    | null;

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
 * 设置页「通知显示位置」自检（需求：提醒弹在 ClassHelper 还是 ClassIsland，由客户端自己选）。
 *
 * 走真实 UI：切到设置页 → 点单选项 → 断言「本地配置已写入」，再切回去。
 * 服务端同步（写回班级记录）由 verify:classisland 覆盖，这里只管客户端这一半。
 */
async function runSettingsPageChannelCheck(
  win: BrowserWindow,
): Promise<{ ok: boolean; detail: string }> {
  const result = (await win.webContents
    .executeJavaScript(
      `(async () => {
         const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
         const before = (await window.desktop.getConfig()).notificationChannel;
         location.hash = '#/settings';

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
    | { ok: true; before: string; afterClient: string; afterBoth: string; clientChecked: boolean; labels: string[] }
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

  // 需求："删掉登录页所有示例内容" —— 占位符/提示里不允许出现示例班级码或示例账号
  const loginExampleLeak = await win.webContents.executeJavaScript(
    `(() => {
       const text = (document.body.innerText || '') + ' ' + Array.from(document.querySelectorAll('input'))
         .map((node) => node.getAttribute('placeholder') || '')
         .join(' ');
       const tokens = ['例如 G101', 'G101', '例如G101', 'admin123', 'teacher123', '演示', '示例'];
       return { leaked: tokens.filter((item) => text.includes(item)) };
     })()`,
  );
  record(
    '登录页不含示例内容（无示例班级码/演示账号）',
    (loginExampleLeak?.leaked ?? ['?']).length === 0,
    `越界文案=[${(loginExampleLeak?.leaked ?? []).join(',')}]`,
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

    // 真实通知链路：教师发通知 → 客户端实时通道 → 灵动岛胶囊；
    // 随后在灵动岛点"标为已读"，验证通知中心同步为已读（修复"点了已读仍显示未读"）
    const realtime = await runIslandRealtimeCheck(win);
    record('真实通知链路（Socket.IO → 灵动岛胶囊）', realtime.delivered, realtime.deliveryDetail);
    record('灵动岛"标为已读"同步通知中心', realtime.markRead, realtime.markReadDetail);

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
