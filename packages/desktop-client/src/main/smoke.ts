import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { BrowserWindow, NativeImage } from 'electron';
import type { IslandNotification } from '@classhelper/shared';
import { getDiagnostics } from './ipc.js';
import { island, ISLAND_CALL_SIZE, ISLAND_SIZES, ISLAND_URGENT_SIZE } from './island.js';

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
async function runIslandChecks(record: Recorder, results: SmokeResult[]): Promise<void> {
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
  const allowedSizes = new Set(['396x308', '416x336', '432x352', '260x38']);
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
  await sleep(900);
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
  await runIslandChecks(record, results);

  // 可选：对真实后端做联网集成自检（ELECTRON_SMOKE_ONLINE=1 时启用）
  if (process.env.ELECTRON_SMOKE_ONLINE === '1') {
    const online = await win.webContents.executeJavaScript(
      `(async () => {
         if (!window.__classhelperSmoke__) return { ok: false, detail: '渲染进程未注册冒烟钩子' };
         return await window.__classhelperSmoke__.onlineScenario();
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
