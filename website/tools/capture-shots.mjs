/**
 * 给官网与 README 采集 **真实运行** 的实机截图。
 *
 * 复用仓库里已安装的 Electron（不需要额外依赖），真的打开 Web 管理端、真的登录、
 * 逐页截屏落到 website/assets/shots/（或 CAPTURE_OUT 指定的目录）。不是手绘的示意，也不是旧版本的残留图。
 *
 * 用法：
 *   1) 先把后端跑起来（它同时托管 Web 管理端）：pnpm dev:server
 *   2) node website/tools/capture-shots.mjs
 *
 * 环境变量：
 *   CAPTURE_URL   默认 http://127.0.0.1:4000
 *   CAPTURE_USER / CAPTURE_PASS   默认 admin / admin123
 *   CAPTURE_ONLY  只截某几页（逗号分隔的 name）
 *   CAPTURE_OUT   输出目录（逗号分隔多个，相对仓库根）；默认 website/assets/shots
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveElectronEnv, resolveElectronExecutable } from '../../scripts/lib/electron-env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
/**
 * 输出目录。默认只写官网那一份；`CAPTURE_OUT` 可以用逗号分隔指定多个（相对仓库根），
 * 例如一次同时喂官网与 README 的展示图：`CAPTURE_OUT=docs/images,website/assets/shots`。
 */
const outDirs = (process.env.CAPTURE_OUT ?? 'website/assets/shots')
  .split(',')
  .map((dir) => dir.trim())
  .filter(Boolean)
  .map((dir) => path.resolve(root, dir));

const BASE = process.env.CAPTURE_URL ?? 'http://127.0.0.1:4000';
const USER = process.env.CAPTURE_USER ?? 'admin';
const PASS = process.env.CAPTURE_PASS ?? 'admin123';
const ONLY = (process.env.CAPTURE_ONLY ?? '').split(',').filter(Boolean);
/**
 * 渲染倍率。**保持 1**：`force-device-scale-factor` 会让 BrowserWindow 的
 * width/height 按物理像素算，想要 1500 CSS px 的视口就得开 3000 px 的窗口，
 * 本机屏幕（1600×900）放不下，窗口会被夹回来反而更小。
 * 1 倍截出来的 1500 px 已经比站点上的显示尺寸大两倍，够清晰了。
 */
const SCALE = 1;

// ── 不在 Electron 里跑就先用仓库里的 Electron 重新拉起自己（见 scripts/lib/electron-env.mjs）
if (!process.versions.electron) {
  const electronDir = path.join(root, 'packages', 'desktop-client', 'node_modules', 'electron');
  const executable = resolveElectronExecutable(electronDir);
  if (!fs.existsSync(executable)) {
    console.error(`[capture] 找不到 Electron：${executable}`);
    console.error(
      '  先执行 pnpm install，再执行 node packages/desktop-client/node_modules/electron/install.js',
    );
    process.exit(2);
  }
  const child = spawn(executable, [fileURLToPath(import.meta.url)], {
    stdio: 'inherit',
    env: resolveElectronEnv(),
  });
  child.on('exit', (code) => process.exit(code ?? 1));
} else {
  const { app, BrowserWindow } = await import('electron');
  // 这两条必须在 whenReady 之前设置，晚一步就不生效了
  app.commandLine.appendSwitch('force-device-scale-factor', String(SCALE));
  // 干净的配置目录：上次留下的 localStorage 会让 /login 直接跳走，
  // 「登录页」那一张就截成别的页了
  const profileDir = path.join(root, '.cache', 'capture-shots-profile');
  fs.rmSync(profileDir, { recursive: true, force: true });
  app.setPath('userData', profileDir);
  // 关掉桌面窗口时默认会把整个 app 带退出（Windows），手机那一轮就跑不到了
  app.on('window-all-closed', () => {});
  // whenReady 的回调在本模块求值完之后才跑，所以上面那些 const 已经初始化好了
  app.whenReady().then(() => main(app, BrowserWindow));
}

/**
 * 桌面端页面：路由路径 → 文件名。
 * `pickClass` 会在截图前把工具栏的班级下拉切过去 —— 演示班里 高一(1)班 被冒烟跑了几十次，
 * 列表里全是「联动页也不该下发」这类测试残条；高二(3)班 还是干净的种子数据。
 */
const DESKTOP_PAGES = [
  { name: 'web-dashboard', route: '/dashboard', title: '仪表盘' },
  { name: 'web-classes', route: '/classes', title: '班级管理' },
  { name: 'web-students', route: '/students', title: '学生管理' },
  { name: 'web-teachers', route: '/teachers', title: '教师管理' },
  { name: 'web-schedules', route: '/schedules', title: '课表管理' },
  { name: 'web-homeworks', route: '/homeworks', title: '作业发布' },
  { name: 'web-notifications', route: '/notifications', title: '通知发布', pickClass: '高二(3)班' },
  { name: 'web-grades', route: '/grades', title: '成绩录入' },
  { name: 'web-integrations', route: '/integrations', title: 'ClassIsland 联动' },
  { name: 'web-database', route: '/database', title: '数据库管理' },
];

/** 手机小屏：同一套界面在 <=768px 下的样子（抽屉 + 卡片内滚动） */
const MOBILE_PAGES = [
  { name: 'mobile-notifications', route: '/notifications', title: '手机 · 通知发布', openDrawer: true },
  { name: 'mobile-dashboard', route: '/dashboard', title: '手机 · 仪表盘' },
];

// 本机屏幕工作区只有 1600×852，窗口再高会被 Electron 夹回来，所以取能放下的高度
const DESKTOP = { width: 1500, height: 820 };
const MOBILE = { width: 414, height: 800 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(app, BrowserWindow) {
  async function login() {
    const response = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: USER, password: PASS }),
    });
    if (!response.ok) throw new Error(`登录失败 ${response.status}：${await response.text()}`);
    return (await response.json()).data;
  }

  async function makeWindow(size) {
    const win = new BrowserWindow({
      ...size,
      useContentSize: true,
      show: true,
      autoHideMenuBar: true,
      backgroundColor: '#f2f4f8',
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    // 连着开关窗口时偶发 ERR_FAILED，重试一次就好
    for (let attempt = 1; ; attempt += 1) {
      try {
        await win.loadURL(`${BASE}/login`);
        return win;
      } catch (error) {
        if (attempt >= 3) throw error;
        await sleep(600);
      }
    }
  }

  /** 把令牌塞进 localStorage，省掉每次跑一遍登录表单；顺便压掉新手引导 */
  async function seedSession(win, session) {
    await win.webContents.executeJavaScript(`
      localStorage.setItem('classhelper.token', ${JSON.stringify(session.token)});
      localStorage.setItem('classhelper.user', ${JSON.stringify(JSON.stringify(session.user))});
      localStorage.setItem('classhelper.onboarding', '99');
    `);
  }

  /** 页面上可能飘着 ElMessage 提示，截之前先收掉，免得挡住内容 */
  async function dismissToasts(win) {
    await win.webContents.executeJavaScript(`
      document.querySelectorAll('.el-message, .el-notification').forEach((node) => node.remove());
      const tour = document.querySelector('.el-tour__closebtn');
      if (tour) tour.click();
    `);
  }

  async function shoot(win, name, width) {
    // capturePage 偶发 UnknownVizError（合成器还没交出那一帧），重试几次就好
    let image = null;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        const frame = await win.webContents.capturePage();
        if (!frame.isEmpty()) {
          image = frame;
          break;
        }
      } catch (error) {
        if (attempt === 4) throw error;
        console.warn(`  ${name} 截图失败（第 ${attempt} 次）：${error.message}`);
      }
      await sleep(450);
    }
    if (!image) throw new Error(`${name} 连续 4 次没截到内容`);

    const [contentW, contentH] = win.getContentSize();
    // 2 倍渲染 → 缩到目标宽度：文字边缘比直接 1 倍清晰一档
    const scaled = image.getSize().width > width ? image.resize({ width, quality: 'best' }) : image;
    const jpeg = scaled.toJPEG(90);
    const written = [];
    for (const dir of outDirs) {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${name}.jpg`);
      fs.writeFileSync(file, jpeg);
      written.push(`${path.relative(root, file)} ${(jpeg.length / 1024).toFixed(0)}KB`);
    }
    console.log(
      `  ${name.padEnd(22)} ${scaled.getSize().width}×${scaled.getSize().height}  ` +
        `${written.join(' | ')}  (窗口内容 ${contentW}×${contentH}, 截图 ${image.getSize().width}×${image.getSize().height})`,
    );
  }

  /**
   * 一个「用完可能已经被关掉」的窗口。截屏过程要弹好几个真窗口在用户桌面上，
   * 用户顺手关掉一个是完全正常的，所以每一步之前都确认它还在。
   */
  function opener(size, session) {
    let win = null;
    return {
      async ensure() {
        if (win && !win.isDestroyed()) return win;
        win = await makeWindow(size);
        await seedSession(win, session);
        return win;
      },
      close() {
        if (win && !win.isDestroyed()) win.destroy();
        win = null;
      },
    };
  }

  /** 把工具栏第一个下拉（班级）切到指定班级：Element Plus 的 select 要点 wrapper 才会展开 */
  async function pickClass(win, className) {
    await win.webContents.executeJavaScript(`
      (() => {
        const wrapper = document.querySelector('.el-select__wrapper') ?? document.querySelector('.el-select');
        if (!wrapper) return false;
        wrapper.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        wrapper.click();
        return true;
      })()
    `);
    await sleep(600);
    const picked = await win.webContents.executeJavaScript(`
      (() => {
        const items = [...document.querySelectorAll('.el-select-dropdown__item')];
        const target = items.find((li) => li.textContent.trim() === ${JSON.stringify(className)});
        if (!target) return '没找到，候选：' + items.map((li) => li.textContent.trim()).join('/');
        target.click();
        return 'ok';
      })()
    `);
    await sleep(1100);
    return picked;
  }

  async function run() {
    const session = await login();
    console.log(`[capture] ${session.user.name}（${session.user.role}）→ ${BASE}`);

    // 登录页要在写入令牌之前截：这时候还不能 seed
    const loginWindow = await makeWindow(DESKTOP);
    await sleep(1300);
    await shoot(loginWindow, 'web-login', DESKTOP.width);
    loginWindow.destroy();

    const desktop = opener(DESKTOP, session);
    for (const page of DESKTOP_PAGES) {
      if (ONLY.length && !ONLY.includes(page.name)) continue;
      const win = await desktop.ensure();
      await win.loadURL(`${BASE}${page.route}`);
      await sleep(1900);
      if (page.pickClass) {
        const result = await pickClass(win, page.pickClass);
        if (result !== 'ok') console.warn(`  ${page.name} 切换班级失败：${result}`);
      }
      await dismissToasts(win);
      await sleep(300);
      await shoot(win, page.name, DESKTOP.width);
    }
    desktop.close();

    const mobile = opener(MOBILE, session);
    for (const page of MOBILE_PAGES) {
      if (ONLY.length && !ONLY.includes(page.name)) continue;
      const win = await mobile.ensure();
      await win.loadURL(`${BASE}${page.route}`);
      await sleep(2000);
      await dismissToasts(win);
      if (page.openDrawer) {
        await win.webContents.executeJavaScript(`
          const burger = document.querySelector('.header-left button, header button');
          if (burger) burger.click();
        `);
        await sleep(800);
      }
      await sleep(300);
      await shoot(win, page.name, MOBILE.width);
    }
    mobile.close();
  }
  try {
    await run();
    console.log('[capture] 完成');
    app.exit(0);
  } catch (error) {
    console.error('[capture] 失败：', error);
    app.exit(1);
  }
}
