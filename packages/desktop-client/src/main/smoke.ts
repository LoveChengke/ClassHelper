import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { BrowserWindow } from 'electron';
import { getDiagnostics } from './ipc.js';

interface SmokeResult {
  name: string;
  ok: boolean;
  detail: string;
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
