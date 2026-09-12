import fs from 'node:fs';
import path from 'node:path';
import { app, screen } from 'electron';
import type { BrowserWindow, NativeImage } from 'electron';
import type { IslandAppearance, IslandNotification } from '@classhelper/shared';
import { getConfig, saveConfig } from './config.js';
import { getDiagnostics } from './ipc.js';
import { getSliverSize, island, ISLAND_CALL_SIZE, ISLAND_SIZES, ISLAND_URGENT_SIZE } from './island.js';
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
  filePath: string;
}

const islandShots: IslandShotStats[] = [];

/** 统计截图位图：不透明像素、颜色种类、偏红像素（Electron 位图格式为 BGRA） */
function analyzeBitmap(image: NativeImage): {
  opaque: number;
  transparent: number;
  uniqueColors: number;
  reddish: number;
  edgeReddish: number;
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
  if (!win || win.isDestroyed() || !win.isVisible()) return null;
  try {
    // 透明窗口直接 capturePage 会得到空白图：把它临时放到不透明背景上再截图
    await win.webContents.executeJavaScript(
      `document.documentElement.style.background = '#1f2733'; document.body.style.background = '#1f2733'; true`,
    );
    await sleep(120);
    const image = await win.webContents.capturePage();
    await win.webContents.executeJavaScript(
      `document.documentElement.style.background = 'transparent'; document.body.style.background = 'transparent'; true`,
    );
    const filePath = dir ? path.join(dir, `${name}.png`) : '';
    if (filePath) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, image.toPNG());
    }

    const size = image.getSize();
    const stats: IslandShotStats = {
      name,
      expected,
      width: size.width,
      height: size.height,
      filePath,
      ...analyzeBitmap(image),
    };
    islandShots.push(stats);
    console.log(
      `[SMOKE] 灵动岛截图：${filePath}（${stats.width}x${stats.height} 不透明=${stats.opaque} ` +
        `颜色=${stats.uniqueColors} 偏红=${stats.reddish} 外圈偏红=${stats.edgeReddish}）`,
    );
    return stats;
  } catch (error) {
    console.warn('[SMOKE] 灵动岛截图失败', error);
    return null;
  }
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
    const bounds = islandWindow?.getBounds();
    if (bounds) sampledWidths.push(bounds.width);
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

  const urgentBounds = islandWindow?.getBounds();
  const rampWidths = [
    ...new Set(sampledWidths.filter((width) => width > 0 && width < ISLAND_URGENT_SIZE.width)),
  ];
  record(
    '紧急通知带展开动画（窗口从胶囊尺寸缓动到紧急尺寸）',
    rampWidths.length >= 3 && urgentBounds?.width === ISLAND_URGENT_SIZE.width,
    `采样=${sampledWidths.length} 中间尺寸=${rampWidths.length} 最终=${urgentBounds?.width ?? '-'}x${urgentBounds?.height ?? '-'}`,
  );
  await captureIsland('island-3-urgent', ISLAND_URGENT_SIZE);

  // 3.1) 上课期间请求"收起"也不应显示胶囊（上课严格不显示灵动岛）
  island.handleAction({ action: 'collapse' });
  await sleep(400);
  record(
    '上课期间收起不会回缩成胶囊（严格不显示）',
    island.getState().mode === 'hidden' && !(islandWindow?.isVisible() ?? true),
    `mode=${island.getState().mode} visible=${islandWindow?.isVisible() ?? true}`,
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
  const immediateBounds = islandWindow?.getBounds();
  await sleep(640);
  const pillState = island.getState();
  record(
    '普通通知直接显示胶囊（无"上岛"入场动画）',
    hiddenBeforePush &&
      pillState.mode === 'pill' &&
      immediateBounds?.width === ISLAND_SIZES.pill.width &&
      immediateBounds?.height === ISLAND_SIZES.pill.height,
    `推送前隐藏=${hiddenBeforePush} 60ms 内窗口=${immediateBounds?.width ?? '-'}x${immediateBounds?.height ?? '-'}` +
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

  // 4.4) 收回过程中卡片不能出现"被拉扁的方框"：
  //      采样卡片尺寸，必须始终是固定的胶囊/详情尺寸之一，绝不出现中间值。
  island.handleAction({ action: 'expand' });
  await sleep(700);
  const shrinkSamples: string[] = [];
  const shrinkSampler = setInterval(() => {
    void islandWindow?.webContents
      .executeJavaScript(
        `(() => {
           const node = document.querySelector('.island-card');
           if (!node) return '';
           const rect = node.getBoundingClientRect();
           return Math.round(rect.width) + 'x' + Math.round(rect.height);
         })()`,
      )
      .then((value: string) => {
        if (value) shrinkSamples.push(value);
      })
      .catch(() => undefined);
  }, 40);
  island.handleAction({ action: 'collapse' });
  await sleep(700);
  clearInterval(shrinkSampler);
  await sleep(120);
  // 允许的卡片尺寸由当前外观与各形态窗口尺寸推导（卡片 = 窗口 - 2*5px 内边距）
  const cardLabel = (size: { width: number; height: number }): string =>
    `${size.width - 10}x${size.height - 10}`;
  const allowedSizes = new Set([
    cardLabel(ISLAND_SIZES.pill),
    cardLabel(ISLAND_SIZES.expanded),
    cardLabel(ISLAND_URGENT_SIZE),
    cardLabel(ISLAND_CALL_SIZE),
  ]);
  const stretched = [...new Set(shrinkSamples)].filter((size) => !allowedSizes.has(size));
  record(
    '收回动画不出现被拉伸的"方框"（卡片保持固定尺寸）',
    shrinkSamples.length >= 3 && stretched.length === 0,
    `采样=${shrinkSamples.length} 尺寸集合=[${[...new Set(shrinkSamples)].join(',')}] 异常尺寸=[${stretched.join(',')}]`,
  );

  // 4.5) 点击屏幕其他位置（窗口失焦）→ 自动回缩为胶囊
  island.handleAction({ action: 'expand' });
  await sleep(700);
  const focusable = islandWindow?.isFocusable() ?? false;
  // 程序化触发失焦：等价于用户点到别处（冒烟窗口本身不显示，无法真的点击桌面）
  islandWindow?.emit('blur');
  await sleep(700);
  const afterBlur = island.getState();
  record(
    '点击屏幕任意位置回缩为胶囊（展开时可聚焦 + 失焦收起）',
    focusable && islandWindow?.isFocusable() === false && afterBlur.mode === 'pill',
    `展开时 focusable=${focusable} 失焦后 mode=${afterBlur.mode} focusable=${islandWindow?.isFocusable() ?? '-'}`,
  );

  // 4.6) 新作业上岛（kind=homework）：胶囊 + 展开显示截止时间
  island.handleAction({ action: 'dismiss' });
  await sleep(400);
  island.pushNotification(
    {
      ...makeNotification('smoke-homework', 'NORMAL', '第 3 章课后练习'),
      kind: 'homework',
      subtitle: '截止时间：2026-09-15 22:00',
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
  const homeworkHint = await islandWindow?.webContents.executeJavaScript(
    `document.querySelector('.island-card.expanded .call-hint')?.textContent?.trim() ?? ''`,
  );
  record(
    '作业详情显示截止时间',
    (homeworkHint ?? '').includes('截止时间'),
    `附加说明="${homeworkHint ?? '-'}"`,
  );
  await captureIsland('island-7-homework', ISLAND_SIZES.expanded);

  // 4.7) "叫人"：上课时段也立即展开，展示"请 XXX 同学找 XXX 老师"
  island.handleAction({ action: 'dismiss' });
  island.setClassState({ inClass: true, currentPeriodEnd: '08:45', week: 1 });
  await sleep(400);
  island.pushNotification(
    {
      ...makeNotification('smoke-call', 'HIGH', '请 王小明 同学找 张老师'),
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
    '叫人消息上岛（上课时段也立即展开，无需点击）',
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
  island.handleAction({ action: 'dismiss' });
  island.setClassState({ inClass: false, currentPeriodEnd: null, week: 1 });
  await sleep(400);

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
        `偏红=${shot.reddish} 外圈偏红=${shot.edgeReddish}`,
    };
  });

  const blank = shotDetails.filter((shot) => shot.opaque < 500 || shot.uniqueColors < 3);
  const wrongRatio = shotDetails.filter((shot) => shot.ratioDelta > 0.05);
  const urgentShot = shotDetails.find((shot) => shot.name.includes('urgent'));
  const urgentReddish = urgentShot?.reddish ?? 0;
  const edgeReddish = urgentShot?.edgeReddish ?? 0;
  const pillShot = shotDetails.find((shot) => shot.name.includes('pill'));
  const sizesOrdered = Boolean(
    pillShot &&
    urgentShot &&
    pillShot.height < (shotDetails.find((shot) => shot.name.includes('after-class'))?.height ?? 0) &&
    (shotDetails.find((shot) => shot.name.includes('after-class'))?.height ?? 0) < urgentShot.height,
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

  // 7) 光晕只在卡片内部：截图最外圈（窗口留白）不允许出现红色外溢像素
  record(
    '紧急红晕不外溢（窗口边缘无红色光晕像素）',
    urgentShot !== undefined && edgeReddish === 0 && urgentReddish > 200,
    `紧急态偏红=${urgentReddish} 最外圈偏红=${edgeReddish}（要求 0）`,
  );

  // 8) 个性化外观：高度/宽度/圆角/字号/透明度/动画速度实时生效，且不破坏布局
  const appearanceBefore = island.getAppearance();
  island.setAppearance({ height: 56, width: 300, radius: 26, fontSize: 14, opacity: 0.92, speed: 1.5 });
  island.handleAction({ action: 'dismiss' });
  await sleep(300);
  island.pushNotification(makeNotification('smoke-appearance', 'NORMAL', '外观设置校验'), {
    inClass: false,
  });
  await sleep(600);
  const pillBounds = islandWindow?.getBounds();
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
  island.handleAction({ action: 'expand' });
  await sleep(700);
  const jitterSamples: { win: number; cardWidth: number; cardTop: number }[] = [];
  const jitterSampler = setInterval(() => {
    const winWidth = islandWindow?.getBounds().width ?? 0;
    void islandWindow?.webContents
      .executeJavaScript(
        `(() => {
           const card = document.querySelector('.island-card');
           return card ? { width: card.offsetWidth, top: card.offsetTop } : null;
         })()`,
      )
      .then((value: { width: number; top: number } | null) => {
        if (value) jitterSamples.push({ win: winWidth, cardWidth: value.width, cardTop: value.top });
      })
      .catch(() => undefined);
  }, 30);
  island.handleAction({ action: 'collapse' });
  await sleep(800);
  clearInterval(jitterSampler);

  const winSequence = jitterSamples.map((item) => item.win);
  const monotonicShrink = winSequence.every(
    (width, index) => index === 0 || width <= (winSequence[index - 1] ?? width) + 1,
  );
  const cardTops = jitterSamples.map((item) => item.cardTop);
  const topSpread = cardTops.length > 0 ? Math.max(...cardTops) - Math.min(...cardTops) : 99;
  const cardWidths = [...new Set(jitterSamples.map((item) => item.cardWidth))];
  const expectedWidths = [ISLAND_SIZES.expanded.width - 10, ISLAND_SIZES.pill.width - 10];
  const widthOk = cardWidths.every((width) => expectedWidths.includes(width));
  record(
    '收回过程不抖动（窗口宽度单调收缩 + 卡片布局尺寸不拉伸）',
    jitterSamples.length >= 4 && monotonicShrink && topSpread <= 1 && widthOk && cardWidths.length <= 2,
    `采样=${jitterSamples.length} 窗口序列=[${winSequence.join(',')}] 单调收缩=${monotonicShrink} ` +
      `卡片上边缘波动=${topSpread}px 卡片宽度集合=[${cardWidths.join(',')}]（期望 ${expectedWidths.join('/')}）`,
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
  const rapidBounds = islandWindow?.getBounds();
  const currentAppearance = island.getAppearance();
  record(
    '连续快速展开/收起后状态与尺寸稳定',
    rapidState.mode === 'pill' &&
      rapidBounds?.width === currentAppearance.width &&
      rapidBounds?.height === currentAppearance.height,
    `mode=${rapidState.mode} 窗口=${rapidBounds?.width ?? '-'}x${rapidBounds?.height ?? '-'}` +
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

  const expandedCard = { width: ISLAND_SIZES.expanded.width - 10, height: ISLAND_SIZES.expanded.height - 10 };
  const pillCard = { width: ISLAND_SIZES.pill.width - 10, height: ISLAND_SIZES.pill.height - 10 };

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
  const expandMonotonic = expandSamples.every(
    (item, index) => index === 0 || item.winW >= (expandSamples[index - 1]?.winW ?? 0) - 1,
  );
  const expandNoOvershoot =
    maxCardW <= expandedCard.width + 0.5 &&
    maxCardH <= expandedCard.height + 0.5 &&
    maxWinW <= ISLAND_SIZES.expanded.width + 1 &&
    maxWinH <= ISLAND_SIZES.expanded.height + 1;
  record(
    '展开过程不震动（锚点不动 + 尺寸不过冲）',
    expandSamples.length >= 5 &&
      cxSpread <= 0.5 &&
      topSpreadExpand <= 0.5 &&
      expandMonotonic &&
      expandNoOvershoot,
    `采样=${expandSamples.length} 卡片中心波动=${cxSpread.toFixed(2)}px 上边缘波动=${topSpreadExpand.toFixed(2)}px ` +
      `最大卡片=${maxCardW.toFixed(1)}x${maxCardH.toFixed(1)}（目标 ${expandedCard.width}x${expandedCard.height}）` +
      ` 最大窗口=${maxWinW}x${maxWinH}（目标 ${ISLAND_SIZES.expanded.width}x${ISLAND_SIZES.expanded.height}） 单调=${expandMonotonic}`,
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
  const minWinW = collapseSamples.length ? Math.min(...collapseSamples.map((item) => item.winW)) : 0;
  const minCardW = collapseSamples.length ? Math.min(...collapseSamples.map((item) => item.cardW)) : 0;
  const collapseMonotonic = collapseSamples.every(
    (item, index) =>
      index === 0 || item.winW <= (collapseSamples[index - 1]?.winW ?? Number.MAX_SAFE_INTEGER) + 1,
  );
  const collapseNoOvershoot = minCardW >= pillCard.width - 0.5 && minWinW >= ISLAND_SIZES.pill.width - 1;
  record(
    '收回过程不震动（锚点不动 + 尺寸不过冲）',
    collapseSamples.length >= 5 &&
      cxSpreadCollapse <= 0.5 &&
      topSpreadCollapse <= 0.5 &&
      collapseMonotonic &&
      collapseNoOvershoot,
    `采样=${collapseSamples.length} 卡片中心波动=${cxSpreadCollapse.toFixed(2)}px 上边缘波动=${topSpreadCollapse.toFixed(2)}px ` +
      `最小卡片宽=${minCardW.toFixed(1)}（目标 ${pillCard.width}） 最小窗口宽=${minWinW}（目标 ${ISLAND_SIZES.pill.width}） 单调=${collapseMonotonic}`,
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
  island.setAppearance({ ...appearanceBefore, style: 'black' });
  await sleep(200);

  // 10.8) 空闲细缝（参考 WinIsland hidden_width）：开启后空闲留一条细缝，来消息再展开
  const sliver = getSliverSize();
  island.setAppearance({ ...appearanceBefore, idleSliver: true });
  await drainIsland();
  await sleep(420);
  const sliverBounds = islandWindow?.getBounds();
  island.pushNotification(makeNotification('smoke-sliver', 'NORMAL', '空闲细缝校验'), { inClass: false });
  await sleep(500);
  const afterSliverNotification = islandWindow?.getBounds();
  record(
    '空闲细缝：空闲缩为细缝、来消息自动展开（WinIsland hidden_width）',
    sliverBounds?.width === sliver.width &&
      sliverBounds?.height === sliver.height &&
      afterSliverNotification?.width === island.getAppearance().width,
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
    const bounds = islandWindow?.getBounds();
    const matched = Boolean(bounds) && item.verify(bounds as Electron.Rectangle);
    if (!matched) positionOk = false;
    positionDetails.push(
      `${item.position}=${bounds ? `${bounds.x},${bounds.y}` : '-'}${matched ? '✓' : '✗'}`,
    );
  }
  record('个性设置：停靠位置生效（6 个锚点）', positionOk, positionDetails.join(' '));
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
  const instantBounds = islandWindow?.getBounds();
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
    await sleep(500);
    const started = Date.now();
    island.handleAction({ action: 'collapse' });
    const target = island.getAppearance().width;
    const deadline = started + 2500;
    while (Date.now() < deadline) {
      const width = islandWindow?.getBounds().width ?? 0;
      if (Math.abs(width - target) <= 1) break;
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

    // 侧边栏点击导航（回归测试：曾因把 index 当路由名导致点击无反应）
    const navigation = await win.webContents.executeJavaScript(
      `(async () => {
         if (!window.__classhelperSmoke__) return { ok: false, detail: '渲染进程未注册冒烟钩子' };
         return await window.__classhelperSmoke__.layoutNavigationSelfTest();
       })()`,
    );
    record('侧边栏点击导航（逐一点击 5 个菜单）', Boolean(navigation?.ok), String(navigation?.detail ?? ''));

    const cleanup = await win.webContents.executeJavaScript(
      `(async () => {
         if (!window.__classhelperSmoke__) return { ok: false, detail: '渲染进程未注册冒烟钩子' };
         return await window.__classhelperSmoke__.sessionCleanup();
       })()`,
    );
    record('冒烟收尾：清理登录态', Boolean(cleanup?.ok), String(cleanup?.detail ?? ''));
  }

  // 托盘与退出清理放在最后：会隐藏主窗口并销毁托盘/灵动岛
  await runTrayAndShutdownChecks(win, record);

  const failed = results.filter((item) => !item.ok);
  const passed = results.length - failed.length;
  console.log(`\n[SMOKE] ${passed}/${results.length} 项通过`);

  const resultFile = process.env.ELECTRON_SMOKE_RESULT;
  if (resultFile) {
    try {
      fs.mkdirSync(path.dirname(resultFile), { recursive: true });
      fs.writeFileSync(
        resultFile,
        JSON.stringify(
          {
            passed,
            total: results.length,
            ok: failed.length === 0,
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
  }

  app.exit(failed.length === 0 ? 0 : 1);
}
