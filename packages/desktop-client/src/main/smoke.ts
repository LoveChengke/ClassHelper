import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { BrowserWindow } from 'electron';
import type { IslandNotification } from '@classhelper/shared';
import { getDiagnostics } from './ipc.js';
import { island } from './island.js';

interface SmokeResult {
  name: string;
  ok: boolean;
  detail: string;
}

type Recorder = (name: string, ok: boolean, detail?: string) => void;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 灵动岛状态截图留档（便于人工复核外观与动画） */
async function captureIsland(name: string): Promise<void> {
  const dir = process.env.ISLAND_SHOTS_DIR;
  const win = island.getWindow();
  if (!dir || !win || win.isDestroyed() || !win.isVisible()) return;
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
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.png`), image.toPNG());
    console.log(`[SMOKE] 灵动岛截图：${path.join(dir, `${name}.png`)}`);
  } catch (error) {
    console.warn('[SMOKE] 灵动岛截图失败', error);
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
 * 1. 上课时间段收到普通通知 → 自动隐藏并暂存
 * 2. 下课后 → 自动在桌面中上方弹出详情
 * 3. 上课时间段收到紧急通知 → 立即展开显示详情（无需点击）
 * 4. 非上课时段收到普通通知 → 变成"新消息"胶囊，点击后展开
 */
async function runIslandChecks(record: Recorder, results: SmokeResult[]): Promise<void> {
  record('灵动岛窗口已创建（置顶/透明/不占任务栏）', island.isReady(), `ready=${island.isReady()}`);
  if (!island.isReady()) return;

  const islandWindow = island.getWindow();

  // 1) 上课期间：普通通知必须保持隐藏并进入队列
  island.setClassState({ inClass: true, currentPeriodEnd: '08:45', week: 1 });
  island.pushNotification(makeNotification('smoke-normal-in-class', 'NORMAL', '上课期间的普通通知'), {
    inClass: true,
  });
  await sleep(500);
  const hiddenState = island.getState();
  record(
    '上课期间普通通知自动隐藏（暂存待下课弹出）',
    hiddenState.mode === 'hidden' && hiddenState.queued.length === 1,
    `mode=${hiddenState.mode} queued=${hiddenState.queued.length}`,
  );
  console.log(`[SMOKE] 隐藏态 DOM：${await dumpIslandDom('hidden')}`);

  // 2) 下课：自动弹出暂存通知的详情
  island.setClassState({ inClass: false, currentPeriodEnd: null, week: 1 });
  await sleep(900);
  const afterClassState = island.getState();
  record(
    '下课后自动弹出通知详情',
    afterClassState.mode === 'expanded' && afterClassState.active?.id === 'smoke-normal-in-class',
    `mode=${afterClassState.mode} active=${afterClassState.active?.id ?? '-'} reason=${afterClassState.reason ?? '-'}`,
  );
  await captureIsland('island-2-after-class');

  // 3) 上课期间紧急通知：立即展开，无需点击
  island.setClassState({ inClass: true, currentPeriodEnd: '08:45', week: 1 });
  await sleep(300);
  island.pushNotification(makeNotification('smoke-urgent-in-class', 'URGENT', '上课期间的紧急通知'), {
    inClass: true,
  });
  await sleep(900);
  const urgentState = island.getState();
  record(
    '上课期间紧急通知立即展开显示详情（无需点击）',
    urgentState.mode === 'expanded' &&
      urgentState.active?.id === 'smoke-urgent-in-class' &&
      urgentState.reason === 'urgent',
    `mode=${urgentState.mode} active=${urgentState.active?.id ?? '-'} reason=${urgentState.reason ?? '-'}`,
  );
  await captureIsland('island-3-urgent');

  // 4) 非上课时段普通通知 → 胶囊态；点击后展开
  island.handleAction({ action: 'dismiss' });
  island.setClassState({ inClass: false, currentPeriodEnd: null, week: 1 });
  await sleep(300);
  island.pushNotification(makeNotification('smoke-normal-free', 'NORMAL', '课间收到的普通通知'), {
    inClass: false,
  });
  await sleep(700);
  const pillState = island.getState();
  await captureIsland('island-4-pill');
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
  await captureIsland('island-5-clicked');

  // 5) 灵动岛 DOM 结构自检（确保渲染进程真的画出卡片而不是空白窗口）
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

  // 收尾：隐藏灵动岛，避免影响后续用例
  island.handleAction({ action: 'dismiss' });
  await sleep(300);
  results.push({ name: '灵动岛用例收尾', ok: true, detail: '已隐藏' });
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
