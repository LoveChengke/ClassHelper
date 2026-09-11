/**
 * Web 管理端 UI 冒烟测试（Electron 驱动真实浏览器内核）。
 *
 * 覆盖：
 *   1. 首页加载（生产构建产物）
 *   2. 登录页渲染与真实表单登录
 *   3. 进入主布局
 *   4. **侧边栏 7 个菜单逐一点击**：断言路由路径变化 + 页面标题渲染
 *      —— 这是"点击左侧边栏没反应"的回归测试
 *
 * 用法（需要后端已启动，且 Web 管理端由其托管）：
 *   UI_SMOKE_URL=http://127.0.0.1:4000/ node scripts/ui-smoke/run.mjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

// 使用独立（每次清空）的 userData，避免 Service Worker 缓存影响验证结果
if (process.env.UI_SMOKE_PROFILE) {
  app.setPath('userData', process.env.UI_SMOKE_PROFILE);
}

const TARGET_URL = process.env.UI_SMOKE_URL ?? 'http://127.0.0.1:4000/';
const USERNAME = process.env.UI_SMOKE_USER ?? 'teacher1';
const PASSWORD = process.env.UI_SMOKE_PASS ?? 'teacher123';
const RESULT_FILE = process.env.UI_SMOKE_RESULT ?? '';

/** 侧边栏菜单：显示文案 -> 期望路由 */
const MENU_ITEMS = [
  { label: '仪表盘', path: '/dashboard' },
  { label: '班级管理', path: '/classes' },
  { label: '学生管理', path: '/students' },
  { label: '课表管理', path: '/schedules' },
  { label: '作业发布', path: '/homeworks' },
  { label: '通知发布', path: '/notifications' },
  { label: '成绩录入', path: '/grades' },
];

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? ` - ${detail}` : ''}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 在渲染进程里轮询等待条件成立 */
async function waitFor(win, expression, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await win.webContents.executeJavaScript(
      `(() => { try { return Boolean(${expression}); } catch { return false; } })()`,
    );
    if (ok) return true;
    await sleep(150);
  }
  return false;
}

async function main() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  // 把渲染进程的报错转发到控制台（兼容 Electron 新旧事件签名）
  win.webContents.on('console-message', (...args) => {
    const first = args[0];
    const isEventObject = first && typeof first === 'object' && 'message' in first;
    const level = isEventObject ? first.level : args[1];
    const message = isEventObject ? first.message : args[2];
    // level: 旧版为 0..3 数字，新版为 'info' | 'warning' | 'error' | 'debug'
    const isProblem = level === 'error' || level === 'warning' || level === 2 || level === 3;
    if (isProblem) console.log(`[renderer] ${String(message)}`);
  });

  console.log(`[ui-smoke] 打开 ${TARGET_URL}`);
  await win.loadURL(TARGET_URL);

  // 1. 首页
  const title = await win.webContents.executeJavaScript('document.title');
  record('Web 管理端首页加载', typeof title === 'string' && title.includes('班级小助手'), `title=${title}`);

  // 2. 登录页
  const loginReady = await waitFor(win, `document.querySelectorAll('input').length >= 2`, 15000);
  record('登录页渲染（用户名/密码输入框）', loginReady);

  // 3. 填写表单并点击登录（用原生 setter + input 事件，保证 Vue 双向绑定生效）
  await win.webContents.executeJavaScript(`(() => {
    const inputs = Array.from(document.querySelectorAll('input'));
    const setValue = (element, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    };
    setValue(inputs[0], ${JSON.stringify(USERNAME)});
    const passwordInput = inputs.find((item) => item.type === 'password') ?? inputs[1];
    setValue(passwordInput, ${JSON.stringify(PASSWORD)});
    return true;
  })()`);

  await win.webContents.executeJavaScript(`(() => {
    const button = Array.from(document.querySelectorAll('button')).find((item) => (item.textContent ?? '').includes('登录'));
    if (!button) return false;
    button.click();
    return true;
  })()`);

  const layoutReady = await waitFor(
    win,
    `document.querySelectorAll('.el-menu-item').length >= ${MENU_ITEMS.length}`,
    20000,
  );
  record(
    '真实表单登录并进入主布局',
    layoutReady,
    `菜单项=${await win.webContents.executeJavaScript(`document.querySelectorAll('.el-menu-item').length`)}`,
  );

  if (!layoutReady) {
    await finish(win);
    return;
  }

  // 4. 逐一点击侧边栏菜单
  const visited = [];
  const failures = [];

  for (const item of MENU_ITEMS) {
    const outcome = await win.webContents.executeJavaScript(`(async () => {
      const label = ${JSON.stringify(item.label)};
      const expected = ${JSON.stringify(item.path)};
      const items = Array.from(document.querySelectorAll('.el-menu-item'));
      const element = items.find((node) => (node.textContent ?? '').trim().startsWith(label));
      if (!element) return { ok: false, path: location.pathname, title: '', reason: '菜单项未找到' };

      element.click();

      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        if (location.pathname === expected) break;
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      // 等视图渲染
      const viewDeadline = Date.now() + 3000;
      while (Date.now() < viewDeadline) {
        if (document.querySelector('.page-title')) break;
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      const title = (document.querySelector('.page-title')?.textContent ?? '').trim();
      return { ok: location.pathname === expected && Boolean(title), path: location.pathname, title, expected };
    })()`);

    visited.push(`${item.label}→${outcome.path}${outcome.title ? `(${outcome.title})` : ''}`);
    if (!outcome.ok)
      failures.push(
        `${item.label}(期望 ${item.path} 实际 ${outcome.path}${outcome.reason ? ` ${outcome.reason}` : ''})`,
      );
  }

  record(
    `侧边栏点击导航（逐一点击 ${MENU_ITEMS.length} 个菜单）`,
    failures.length === 0,
    `visited=[${visited.join(' ')}]${failures.length > 0 ? ` failures=${failures.join(';')}` : ''}`,
  );

  // 5. SPA 深链刷新（生产环境静态托管必须支持）
  await win.loadURL(`${TARGET_URL.replace(/\/$/, '')}/grades`);
  const deepLinkOk = await waitFor(
    win,
    `document.querySelectorAll('.el-menu-item').length >= ${MENU_ITEMS.length}`,
    15000,
  );
  record(
    '前端路由深链直接访问（/grades 刷新可用）',
    deepLinkOk,
    `path=${await win.webContents.executeJavaScript('location.pathname')}`,
  );

  // 6. PWA 可安装性：manifest 可获取 + Service Worker 已注册
  // 注意：注入代码里不要使用 ${} 插值，避免与宿主文件的模板字符串冲突
  const manifestInfo = await win.webContents.executeJavaScript(`(async () => {
    const link = document.querySelector('link[rel="manifest"]');
    if (!link) return { ok: false, detail: '缺少 manifest 链接' };
    const response = await fetch(link.getAttribute('href'));
    const json = await response.json().catch(() => null);
    const ok = response.ok && Boolean(json && json.name);
    return { ok, detail: String(response.status) + ' name=' + (json && json.name ? json.name : '-') + ' icons=' + (json && json.icons ? json.icons.length : 0) };
  })()`);
  record('PWA manifest 可获取', Boolean(manifestInfo?.ok), String(manifestInfo?.detail ?? ''));

  const swInfo = await win.webContents.executeJavaScript(`(async () => {
    if (!('serviceWorker' in navigator)) return { ok: false, detail: '不支持 Service Worker' };
    const registrations = await navigator.serviceWorker.getRegistrations();
    return { ok: registrations.length > 0, detail: 'registrations=' + registrations.length };
  })()`);
  record('Service Worker 已注册（浏览器可安装为应用）', Boolean(swInfo?.ok), String(swInfo?.detail ?? ''));

  await finish(win);
}

async function finish(win) {
  const failed = results.filter((item) => !item.ok);
  const passed = results.length - failed.length;
  console.log(`\n[ui-smoke] ${passed}/${results.length} 项通过`);

  if (RESULT_FILE) {
    try {
      fs.mkdirSync(path.dirname(RESULT_FILE), { recursive: true });
      fs.writeFileSync(
        RESULT_FILE,
        JSON.stringify(
          { passed, total: results.length, ok: failed.length === 0, results, target: TARGET_URL },
          null,
          2,
        ),
        'utf8',
      );
      console.log(`[ui-smoke] 结果已写入 ${RESULT_FILE}`);
    } catch (error) {
      console.error('[ui-smoke] 写入结果失败', error);
    }
  }

  win.destroy();
  app.exit(failed.length === 0 ? 0 : 1);
}

app.whenReady().then(() =>
  main().catch(async (error) => {
    record('UI 冒烟执行异常', false, String(error));
    console.error(error);
    app.exit(1);
  }),
);

app.on('window-all-closed', () => app.quit());
