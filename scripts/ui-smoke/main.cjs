/**
 * Web 管理端 UI 冒烟测试（Electron 驱动真实浏览器内核）。
 *
 * 覆盖：
 *   1. 首页加载（生产构建产物）
 *   2. 登录页渲染与真实表单登录
 *   3. 进入主布局
 *   4. **侧边栏 7 个菜单逐一点击**：断言路由路径变化 + 页面标题渲染
 *      —— 这是"点击左侧边栏没反应"的回归测试
 *   5. **上课时段发布紧急通知**：全屏警告 + 3 秒倒计时 + 确认后才真正发布
 *      —— 上课时段由 run.mjs 的探针（今天 00:00-23:59 的课表）真实制造
 *   6. 前端路由深链直接访问
 *   7. PWA manifest + Service Worker（浏览器可安装为应用）
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

/**
 * 侧边栏菜单（教师账号 teacher1 可见的部分）。
 * 按新的角色权限模型：班级管理 / 学生管理 / 成绩录入 仅管理员可见，
 * 教师端不应出现这些入口（后端同时强校验），因此期望值只有 4 项。
 */
const MENU_ITEMS = [
  { label: '仪表盘', path: '/dashboard' },
  { label: '课表管理', path: '/schedules' },
  { label: '作业发布', path: '/homeworks' },
  { label: '通知发布', path: '/notifications' },
  { label: '成绩录入', path: '/grades' },
];

/** 教师端必须隐藏的入口（前端隐藏 + 后端 403，双重保障） */
const HIDDEN_MENU_LABELS = ['班级管理', '学生管理'];

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

  // 5. 上课时段发布紧急通知：全屏警告 + 3 秒倒计时 + 教师确认后才真正发布
  //    "上课时段"由 run.mjs 的探针提前用 HTTP 建好（今天 00:00-23:59 的课表）
  const urgentTitle = process.env.UI_SMOKE_URGENT_TITLE ?? 'UI 冒烟紧急通知';
  const inClass = process.env.UI_SMOKE_INCLASS === '1';
  if (!inClass) {
    record(
      '上课时段发布紧急通知（全屏警告 + 3 秒倒计时）',
      false,
      `未能制造上课时段：${process.env.UI_SMOKE_PROBE_DETAIL || '未知原因'}`,
    );
  } else {
    const urgent = await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const waitFor = async (check, timeout = 8000) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          const value = check();
          if (value) return value;
          await sleep(80);
        }
        return null;
      };
      const byText = (nodes, text) =>
        Array.from(nodes).find((node) => (node.textContent ?? '').trim().includes(text));
      const setValue = (element, value) => {
        const proto = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const formItem = (dialog, label) =>
        Array.from(dialog.querySelectorAll('.el-form-item')).find((item) =>
          (item.querySelector('.el-form-item__label')?.textContent ?? '').trim().startsWith(label),
        );

      const menu = byText(document.querySelectorAll('.el-menu-item'), '通知发布');
      if (!menu) return { ok: false, detail: '侧边栏未找到"通知发布"菜单' };
      menu.click();
      if (!(await waitFor(() => location.pathname === '/notifications')))
        return { ok: false, detail: '未跳转到 /notifications' };

      const openButton = await waitFor(() => byText(document.querySelectorAll('button'), '发布通知'));
      if (!openButton) return { ok: false, detail: '未找到"发布通知"按钮' };
      openButton.click();

      // 页面里同时存在「发布通知」与「叫人」两个弹窗，按标题精确定位
      const dialog = await waitFor(() =>
        Array.from(document.querySelectorAll('.el-dialog')).find((node) =>
          (node.querySelector('.el-dialog__title')?.textContent ?? '').includes('发布通知'),
        ),
      );
      if (!dialog) return { ok: false, detail: '发布通知弹窗未打开' };
      // 等目标班级下拉选好值（班级列表是异步加载的，避免空值导致校验失败）
      await waitFor(() => (dialog.querySelector('.el-select__selected-item')?.textContent ?? '').trim().length > 0, 5000);

      const titleItem = formItem(dialog, '标题');
      const contentItem = formItem(dialog, '内容');
      if (!titleItem || !contentItem) return { ok: false, detail: '弹窗表单缺少标题/内容字段' };
      setValue(titleItem.querySelector('input'), ${JSON.stringify(urgentTitle)});
      setValue(contentItem.querySelector('textarea'), '自动化校验：本节课紧急通知二次确认流程');

      const urgentRadio = byText(dialog.querySelectorAll('.el-radio-button'), '紧急');
      if (!urgentRadio) return { ok: false, detail: '未找到"紧急"优先级选项' };
      (urgentRadio.querySelector('.el-radio-button__inner') ?? urgentRadio).click();
      const radioActive = await waitFor(() => {
        const node = byText(dialog.querySelectorAll('.el-radio-button'), '紧急');
        return Boolean(node && node.classList.contains('is-active'));
      });
      if (!radioActive) return { ok: false, detail: '"紧急"优先级未选中' };

      const publish = byText(dialog.querySelectorAll('.el-dialog__footer button'), '立即发布');
      if (!publish) return { ok: false, detail: '未找到"立即发布"按钮' };
      publish.click();

      const mask = await waitFor(() => document.querySelector('.urgent-mask'), 15000);
      if (!mask) {
        const errors = Array.from(dialog.querySelectorAll('.el-form-item__error')).map((n) => n.textContent.trim()).join('|');
        const tips = Array.from(document.querySelectorAll('.el-message')).map((n) => n.textContent.trim()).join('|');
        return { ok: false, detail: '未弹出全屏警告｜表单错误=' + (errors || '无') + '｜页面提示=' + (tips || '无') + '｜班级=' + ((dialog.querySelector('.el-select__selected-item')?.textContent ?? '').trim()) };
      }

      const maskText = (mask.textContent ?? '').replace(/\\s+/g, ' ').trim();
      const periodText = (mask.querySelector('.urgent-period .period-value')?.textContent ?? '').trim();
      const dangerButton = mask.querySelector('.urgent-actions button.el-button--danger');
      if (!dangerButton) return { ok: false, detail: '全屏警告缺少确认按钮' };
      const disabledAtStart = dangerButton.disabled === true;
      const startText = (dangerButton.textContent ?? '').trim();

      const startedAt = Date.now();
      const enabled = await waitFor(() => {
        const node = document.querySelector('.urgent-mask .urgent-actions button.el-button--danger');
        return Boolean(node && node.disabled !== true);
      }, 9000);
      const countdownMs = Date.now() - startedAt;
      if (!enabled) return { ok: false, detail: '倒计时结束后确认按钮仍未可用' };

      document.querySelector('.urgent-mask .urgent-actions button.el-button--danger').click();

      const closed = await waitFor(() => !document.querySelector('.urgent-mask'), 6000);
      const listed = await waitFor(
        () =>
          Array.from(document.querySelectorAll('.el-table__body td')).some((cell) =>
            (cell.textContent ?? '').includes(${JSON.stringify(urgentTitle)}),
          ),
        10000,
      );

      return {
        ok: Boolean(closed && listed),
        detail: closed
          ? listed
            ? ''
            : '确认后警告已关闭，但通知列表未出现该通知'
          : '点击确认后全屏警告未关闭',
        maskText,
        periodText,
        disabledAtStart,
        startText,
        countdownMs,
      };
    })()`);

    record(
      '上课时段发布紧急通知（全屏警告 + 3 秒倒计时）',
      Boolean(urgent?.ok) &&
        Boolean(urgent?.maskText?.includes('现在为上课时间段')) &&
        Boolean(urgent?.periodText) &&
        urgent?.disabledAtStart === true &&
        Number(urgent?.countdownMs) >= 1500,
      urgent
        ? `警告文案="${urgent.maskText?.slice(0, 60)}…" 上课时段=${urgent.periodText} ` +
            `初始按钮="${urgent.startText}"(禁用=${urgent.disabledAtStart}) ` +
            `倒计时=${urgent.countdownMs}ms${urgent.detail ? ` 问题=${urgent.detail}` : ''}`
        : '未执行',
    );
  }

  // 6. SPA 深链刷新（生产环境静态托管必须支持）
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

  // 7. PWA 可安装性：manifest 可获取 + Service Worker 已注册
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

  // 7.5 权限入口隐藏（教师端不应出现班级/学生/成绩录入入口）
  const hiddenCheck = await win.webContents.executeJavaScript(`(() => {
    const labels = Array.from(document.querySelectorAll('.el-menu-item')).map((node) =>
      (node.textContent ?? '').trim(),
    );
    const leaked = ${JSON.stringify(HIDDEN_MENU_LABELS)}.filter((item) => labels.some((label) => label.startsWith(item)));
    return { labels, leaked };
  })()`);
  record(
    '教师端隐藏无权入口（班级管理/学生管理）',
    (hiddenCheck?.leaked ?? ['?']).length === 0,
    `可见菜单=[${(hiddenCheck?.labels ?? []).join(',')}] 越权入口=[${(hiddenCheck?.leaked ?? []).join(',')}]`,
  );

  // 7.6 "叫人"入口（通知发布 → 叫人 → 快捷短语/自定义消息）
  const callDialog = await win.webContents.executeJavaScript(`(async () => {
    const menu = Array.from(document.querySelectorAll('.el-menu-item')).find((node) =>
      (node.textContent ?? '').trim().startsWith('通知发布'),
    );
    if (!menu) return { ok: false, reason: '未找到通知发布菜单' };
    menu.click();
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline && location.pathname !== '/notifications') {
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
    const callButton = Array.from(document.querySelectorAll('button')).find((node) =>
      (node.textContent ?? '').trim() === '叫人',
    );
    if (!callButton) return { ok: false, reason: '通知页没有"叫人"按钮' };
    callButton.click();
    await new Promise((resolve) => setTimeout(resolve, 700));
    const dialog = Array.from(document.querySelectorAll('.el-dialog')).find((node) =>
      (node.querySelector('.el-dialog__title')?.textContent ?? '').includes('叫人'),
    );
    if (!dialog) return { ok: false, reason: '叫人弹窗未打开' };
    const phrases = Array.from(dialog.querySelectorAll('.call-phrase')).map((node) => node.textContent.trim());
    const hasTextarea = Boolean(dialog.querySelector('textarea'));
    const target = dialog.querySelector('.el-alert__title')?.textContent?.trim() ?? '';
    // 点第二条快捷短语（第一条是默认选中，再点会取消），确认可切换选中态
    const phraseNodes = Array.from(dialog.querySelectorAll('.call-phrase'));
    const target2 = phraseNodes[1] ?? phraseNodes[0];
    const expected = target2 ? target2.textContent.trim() : '';
    if (target2) target2.click();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const darkTag = dialog.querySelector('.call-phrase.el-tag--dark');
    const picked = Boolean(darkTag) && darkTag.textContent.trim() === expected;
    // 紧急 / 普通两级：默认普通（不打断课堂），切到紧急必须联动提示文案
    const radioNodes = Array.from(dialog.querySelectorAll('.el-radio-button'));
    const levels = radioNodes.map((node) => node.textContent.trim());
    const alertBefore = dialog.querySelector('.el-alert__title')?.textContent?.trim() ?? '';
    const urgentNode = radioNodes.find((node) => node.textContent.includes('紧急'));
    if (urgentNode) urgentNode.click();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const alertAfter = dialog.querySelector('.el-alert__title')?.textContent?.trim() ?? '';
    const urgentChecked = radioNodes.some(
      (node) => node.textContent.includes('紧急') && node.classList.contains('is-active'),
    );
    return {
      ok: true,
      phrases,
      hasTextarea,
      target,
      picked,
      path: location.pathname,
      levels,
      alertBefore,
      alertAfter,
      urgentChecked,
    };
  })()`);
  record(
    '叫人入口（快捷短语 + 自定义消息）',
    Boolean(callDialog?.ok) &&
      (callDialog?.phrases?.length ?? 0) >= 5 &&
      callDialog?.hasTextarea === true &&
      callDialog?.picked === true,
    `path=${callDialog?.path} 对象="${callDialog?.target}" 短语数=${callDialog?.phrases?.length ?? 0} 自定义输入=${callDialog?.hasTextarea} 可选中=${callDialog?.picked}` +
      `${callDialog?.reason ? ` 原因=${callDialog.reason}` : ''}`,
  );
  record(
    '叫人分紧急/普通两级（默认普通，"紧急"联动提示文案）',
    (callDialog?.levels?.length ?? 0) === 2 &&
      (callDialog?.levels ?? []).some((level) => level.includes('普通')) &&
      (callDialog?.levels ?? []).some((level) => level.includes('紧急')) &&
      (callDialog?.alertBefore ?? '').includes('普通') &&
      (callDialog?.alertAfter ?? '').includes('紧急') &&
      callDialog?.urgentChecked === true,
    `级别=[${(callDialog?.levels ?? []).join(' / ')}] 默认提示="${callDialog?.alertBefore}" ` +
      `切紧急后="${callDialog?.alertAfter}" 紧急选中=${callDialog?.urgentChecked}`,
  );
  await win.webContents.executeJavaScript(`(() => {
    const cancel = Array.from(document.querySelectorAll('.el-dialog__footer button')).find((node) =>
      (node.textContent ?? '').trim() === '取消',
    );
    if (cancel) cancel.click();
    return true;
  })()`);
  await sleep(300);

  // 7.65 需求 6：班主任（teacher1）在「成绩录入」页看到导入入口，且弹窗真实可用
  const gradesImportUi = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const menu = Array.from(document.querySelectorAll('.el-menu-item')).find((node) =>
      (node.textContent ?? '').trim().startsWith('成绩录入'),
    );
    if (!menu) return { ok: false, reason: '班主任看不到「成绩录入」入口（需求 6 未生效）' };
    menu.click();
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline && location.pathname !== '/grades') await sleep(80);
    await sleep(900);

    const importButton = Array.from(document.querySelectorAll('button')).find((node) =>
      (node.textContent ?? '').trim() === '导入表格',
    );
    if (!importButton) return { ok: false, reason: '成绩页没有「导入表格」按钮（班主任应可导入本班成绩）' };
    importButton.click();
    await sleep(700);

    const dialog = Array.from(document.querySelectorAll('.el-dialog')).find((node) =>
      (node.querySelector('.el-dialog__title')?.textContent ?? '').includes('导入成绩表格'),
    );
    if (!dialog) return { ok: false, reason: '导入弹窗未打开' };

    const buttons = Array.from(dialog.querySelectorAll('button')).map((node) => (node.textContent ?? '').trim());
    return {
      ok: true,
      hasExcelTemplate: buttons.some((text) => text.includes('下载模板（Excel）')),
      hasCsvTemplate: buttons.some((text) => text.includes('下载模板（CSV）')),
      hasFileInput: Boolean(dialog.querySelector('input[type=file]')),
      path: location.pathname,
    };
  })()`);
  record(
    '班主任可用成绩导入入口（模板下载 + 选择文件）',
    Boolean(gradesImportUi?.ok) &&
      gradesImportUi?.hasExcelTemplate === true &&
      gradesImportUi?.hasCsvTemplate === true &&
      gradesImportUi?.hasFileInput === true,
    `path=${gradesImportUi?.path ?? '-'} Excel模板=${gradesImportUi?.hasExcelTemplate} CSV模板=${gradesImportUi?.hasCsvTemplate} 文件选择=${gradesImportUi?.hasFileInput}` +
      `${gradesImportUi?.reason ? ` 原因=${gradesImportUi.reason}` : ''}`,
  );
  await win.webContents.executeJavaScript(`(() => {
    const buttons = Array.from(document.querySelectorAll('.el-dialog__footer button'));
    const close = buttons.find((node) => (node.textContent ?? '').trim() === '关闭');
    if (close) close.click();
    return true;
  })()`);
  await sleep(300);

  // 7.7 ClassIsland 时间配置导入弹窗（班主任可见：粘贴 JSON → 解析预览 → 确认导入）
  const layoutDialog = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const menu = Array.from(document.querySelectorAll('.el-menu-item')).find((node) =>
      (node.textContent ?? '').trim().startsWith('课表管理'),
    );
    if (!menu) return { ok: false, reason: '未找到课表管理菜单' };
    menu.click();
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline && location.pathname !== '/schedules') await sleep(80);
    await sleep(600);

    const openButton = Array.from(document.querySelectorAll('button')).find((node) =>
      (node.textContent ?? '').trim() === '导入时间配置',
    );
    if (!openButton) return { ok: false, reason: '课表页没有"导入时间配置"按钮（班主任权限未生效？）' };
    openButton.click();
    await sleep(700);

    const dialog = Array.from(document.querySelectorAll('.el-dialog')).find((node) =>
      (node.querySelector('.el-dialog__title')?.textContent ?? '').includes('ClassIsland'),
    );
    if (!dialog) return { ok: false, reason: '时间配置导入弹窗未打开' };

    const sampleButton = Array.from(dialog.querySelectorAll('button')).find((node) =>
      (node.textContent ?? '').trim() === '填入示例',
    );
    if (!sampleButton) return { ok: false, reason: '缺少"填入示例"按钮' };
    sampleButton.click();
    await sleep(200);

    const previewButton = Array.from(dialog.querySelectorAll('button')).find((node) =>
      (node.textContent ?? '').trim() === '解析预览',
    );
    if (!previewButton) return { ok: false, reason: '缺少"解析预览"按钮' };
    previewButton.click();

    const previewDeadline = Date.now() + 8000;
    let rows = 0;
    let importEnabled = false;
    let errors = 0;
    while (Date.now() < previewDeadline) {
      rows = dialog.querySelectorAll('.el-table__body tbody tr').length;
      errors = dialog.querySelectorAll('.el-alert--error').length;
      const confirm = Array.from(dialog.querySelectorAll('.el-dialog__footer button')).find((node) =>
        (node.textContent ?? '').trim() === '确认导入',
      );
      importEnabled = Boolean(confirm) && !confirm.disabled;
      if (rows >= 2) break;
      await sleep(150);
    }
    return { ok: true, rows, importEnabled, errors, hasFileInput: Boolean(dialog.querySelector('input[type=file]')) };
  })()`);
  record(
    'ClassIsland 时间配置导入弹窗（示例 → 解析预览 → 可导入）',
    Boolean(layoutDialog?.ok) &&
      (layoutDialog?.rows ?? 0) >= 2 &&
      layoutDialog?.importEnabled === true &&
      layoutDialog?.errors === 0,
    `节次行=${layoutDialog?.rows ?? 0} 可导入=${layoutDialog?.importEnabled} 校验错误=${layoutDialog?.errors ?? '-'} 文件选择=${layoutDialog?.hasFileInput}` +
      `${layoutDialog?.reason ? ` 原因=${layoutDialog.reason}` : ''}`,
  );
  await win.webContents.executeJavaScript(`(() => {
    const buttons = Array.from(document.querySelectorAll('.el-dialog__footer button'));
    const close = buttons.find((node) => (node.textContent ?? '').trim() === '关闭');
    if (close) close.click();
    return true;
  })()`);
  await sleep(300);

  // 8. 手机小屏适配（390×844，1Panel 风格：侧边栏收进抽屉 + 卡片内横向滚动）
  await runMobileChecks(win);

  await finish(win);
}

/** 移动端截图留档目录（可用 UI_SMOKE_SHOTS_DIR 覆盖） */
const SHOTS_DIR = process.env.UI_SMOKE_SHOTS_DIR ?? '';

async function captureMobileShot(win, name) {
  if (!SHOTS_DIR) return '';
  try {
    const image = await win.webContents.capturePage();
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    const file = path.join(SHOTS_DIR, `${name}.png`);
    fs.writeFileSync(file, image.toPNG());
    console.log(`[ui-smoke] 移动端截图：${file}`);
    return file;
  } catch (error) {
    console.warn('[ui-smoke] 移动端截图失败', error);
    return '';
  }
}

/**
 * 手机小屏适配验证（真实点击）：
 *   1. 侧边栏收起 → 顶栏出现汉堡按钮（桌面侧边栏不渲染）
 *   2. 点汉堡 → 抽屉菜单打开并渲染全部菜单项
 *   3. 抽屉里点"通知发布" → 路由跳转且抽屉自动收起
 *   4. 页面无横向溢出（scrollWidth <= innerWidth，表格自身滚动不计入）
 *   5. 表格在卡片内横向滚动（卡片可滚动，页面不滚动）
 *   6. 弹窗宽度自适应（不超出视口且接近整屏宽）
 *   7. 工具栏控件铺满整行
 *
 * 注意：这套检查必须让窗口真正可见（showInactive）。
 * Chromium 对隐藏的页面会冻结 CSS transition，Vue 的 <Transition> 收不到
 * transitionend，抽屉会一直停在 enter-from（表现为"点了没反应"）。
 */
async function runMobileChecks(win) {
  const MOBILE = { width: 390, height: 844 };
  win.showInactive();
  await sleep(500);
  win.setBounds({ ...win.getBounds(), width: MOBILE.width, height: MOBILE.height });
  await sleep(600);
  await waitFor(win, `window.innerWidth <= 768`, 8000);

  const layout = await win.webContents.executeJavaScript(`(() => {
    const toggle = document.querySelector('.nav-toggle');
    const aside = document.querySelector('.layout-aside');
    const drawer = document.querySelector('.ch-nav-drawer');
    return {
      innerWidth: window.innerWidth,
      hasToggle: Boolean(toggle),
      toggleVisible: Boolean(toggle && toggle.getBoundingClientRect().width > 0),
      asideRendered: Boolean(aside),
      drawerOpen: Boolean(drawer && drawer.getBoundingClientRect().width > 0),
      title: document.querySelector('.header-title')?.textContent?.trim() ?? '',
    };
  })()`);
  record(
    '手机端布局：侧边栏收起、顶栏汉堡按钮出现',
    layout?.innerWidth <= 768 && layout?.toggleVisible && layout?.asideRendered === false,
    `innerWidth=${layout?.innerWidth} 汉堡=${layout?.toggleVisible} 桌面侧边栏渲染=${layout?.asideRendered} 顶栏标题=${layout?.title}`,
  );

  await win.webContents.executeJavaScript(
    `(() => { const button = document.querySelector('.nav-toggle'); if (button) button.click(); return true; })()`,
  );
  // 等抽屉真的滑出来（左边缘回到 0），而不是只等元素出现
  await waitFor(
    win,
    `(() => { const node = document.querySelector('.ch-nav-drawer'); const rect = node && node.getBoundingClientRect(); return Boolean(rect && rect.left >= -1 && rect.width > 0); })()`,
    5000,
  );
  const drawerInfo = await win.webContents.executeJavaScript(`(() => {
    const drawer = document.querySelector('.ch-nav-drawer');
    const overlay = document.querySelector('.el-overlay.is-drawer, .el-overlay.is-modal-drawer');
    const toggle = document.querySelector('.nav-toggle');
    const rect = drawer ? drawer.getBoundingClientRect() : null;
    return {
      open: Boolean(rect && rect.left >= -1 && rect.width > 0),
      left: rect ? Math.round(rect.left) : null,
      right: rect ? Math.round(rect.right) : null,
      expandAttr: toggle ? toggle.getAttribute('aria-expanded') : null,
      transform: drawer ? getComputedStyle(drawer).transform : '',
      overlayClass: overlay ? overlay.className : '',
      items: document.querySelectorAll('.ch-nav-drawer .el-menu-item').length,
      labels: Array.from(document.querySelectorAll('.ch-nav-drawer .el-menu-item')).map((n) => n.textContent.trim()).join('|'),
    };
  })()`);
  await captureMobileShot(win, 'mobile-1-drawer');
  record(
    '手机端抽屉菜单（点汉堡滑出，菜单项完整）',
    drawerInfo?.open === true && drawerInfo?.items >= 4 && !/enter-from/.test(drawerInfo?.overlayClass ?? ''),
    `菜单项=${drawerInfo?.items} left=${drawerInfo?.left} aria-expanded=${drawerInfo?.expandAttr} ` +
      `transform=${drawerInfo?.transform} 遮罩类=${drawerInfo?.overlayClass}`,
  );

  const drawerNav = await win.webContents.executeJavaScript(`(async () => {
    const item = Array.from(document.querySelectorAll('.ch-nav-drawer .el-menu-item')).find((node) =>
      (node.textContent ?? '').trim().startsWith('通知发布'),
    );
    if (!item) return { ok: false, reason: '抽屉里未找到"通知发布"' };
    item.click();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && location.pathname !== '/notifications') {
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    return { ok: location.pathname === '/notifications', path: location.pathname };
  })()`);
  // 等抽屉收起动画结束（右边缘回到 0 以内）
  await waitFor(
    win,
    `(() => { const node = document.querySelector('.ch-nav-drawer'); const rect = node && node.getBoundingClientRect(); return Boolean(rect && rect.right <= 1); })()`,
    5000,
  );
  const drawerClosed = await win.webContents.executeJavaScript(`(() => {
    const drawer = document.querySelector('.ch-nav-drawer');
    const rect = drawer ? drawer.getBoundingClientRect() : null;
    const overlay = document.querySelector('.el-overlay');
    return {
      left: rect ? Math.round(rect.left) : null,
      right: rect ? Math.round(rect.right) : null,
      overlayDisplay: overlay ? getComputedStyle(overlay).display : 'none',
      path: location.pathname,
    };
  })()`);
  await captureMobileShot(win, 'mobile-2-notifications');
  record(
    '手机端抽屉菜单真实点击导航（通知发布并自动收起抽屉）',
    Boolean(drawerNav?.ok) && drawerClosed?.right <= 1,
    `path=${drawerNav?.path}/${drawerClosed?.path} 抽屉 right=${drawerClosed?.right}（<=1 表示已收起）遮罩=${drawerClosed?.overlayDisplay}`,
  );

  const overflow = await win.webContents.executeJavaScript(`(() => {
    const doc = document.documentElement;
    // 只统计"真正把页面撑宽"的元素：祖先里有横向可滚动容器（表格卡片）的属于正常设计
    const insideScroller = (node) => {
      let parent = node.parentElement;
      while (parent && parent !== document.body) {
        const style = getComputedStyle(parent);
        const scrollable = /(auto|scroll)/.test(style.overflowX);
        if (scrollable && parent.scrollWidth > parent.clientWidth + 1) return true;
        parent = parent.parentElement;
      }
      return false;
    };
    let worst = null;
    for (const node of document.querySelectorAll('.page *')) {
      const rect = node.getBoundingClientRect();
      if (rect.width === 0 || rect.right <= window.innerWidth + 1) continue;
      if (insideScroller(node)) continue;
      worst = (node.className || node.tagName) + '@' + Math.round(rect.left) + '..' + Math.round(rect.right);
      break;
    }
    return {
      innerWidth: window.innerWidth,
      docScrollWidth: doc.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      widest: worst,
    };
  })()`);
  record(
    '手机端无页面横向溢出（表格滚动不计入）',
    overflow?.docScrollWidth <= overflow?.innerWidth + 1 && !overflow?.widest,
    `scrollWidth=${overflow?.docScrollWidth} body=${overflow?.bodyScrollWidth} innerWidth=${overflow?.innerWidth} 越界元素=${overflow?.widest ?? '无'}`,
  );

  const tableScroll = await win.webContents.executeJavaScript(`(() => {
    const body = document.querySelector('.table-card .el-card__body');
    const table = document.querySelector('.table-card .el-table');
    return {
      hasCard: Boolean(body),
      cardClientWidth: body ? body.clientWidth : 0,
      cardScrollWidth: body ? body.scrollWidth : 0,
      tableWidth: table ? Math.round(table.getBoundingClientRect().width) : 0,
    };
  })()`);
  record(
    '手机端表格在卡片内横向滚动（页面不横向滚动）',
    Boolean(tableScroll?.hasCard) && tableScroll.cardScrollWidth > tableScroll.cardClientWidth,
    `卡片可视=${tableScroll?.cardClientWidth} 内容宽=${tableScroll?.cardScrollWidth} 表格宽=${tableScroll?.tableWidth}`,
  );

  const toolbar = await win.webContents.executeJavaScript(
    `(() => {
       const control = document.querySelector('.toolbar .el-select') ?? document.querySelector('.toolbar .el-input');
       return {
         innerWidth: window.innerWidth,
         width: control ? Math.round(control.getBoundingClientRect().width) : 0,
       };
     })()`,
  );
  record(
    '手机端工具栏控件铺满整行',
    toolbar?.width >= toolbar?.innerWidth - 48,
    `控件宽=${toolbar?.width} 视口宽=${toolbar?.innerWidth}`,
  );

  const dialog = await win.webContents.executeJavaScript(`(async () => {
    const open = Array.from(document.querySelectorAll('button')).find((node) =>
      (node.textContent ?? '').trim().includes('发布通知'),
    );
    if (!open) return { ok: false, reason: '未找到"发布通知"按钮' };
    open.click();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !document.querySelector('.el-dialog')) {
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    const node = document.querySelector('.el-dialog');
    if (!node) return { ok: false, reason: '弹窗未打开' };
    const rect = node.getBoundingClientRect();
    return {
      ok: true,
      width: Math.round(rect.width),
      innerWidth: window.innerWidth,
      left: Math.round(rect.left),
      formItemWidth: Math.round(
        document.querySelector('.el-dialog .el-form-item')?.getBoundingClientRect().width ?? 0,
      ),
    };
  })()`);
  await captureMobileShot(win, 'mobile-3-dialog');
  record(
    '手机端弹窗宽度自适应（不超出视口且接近整屏）',
    Boolean(dialog?.ok) &&
      dialog.width <= dialog.innerWidth &&
      dialog.width >= dialog.innerWidth - 32 &&
      dialog.left >= 0,
    `弹窗宽=${dialog?.width} 视口宽=${dialog?.innerWidth} left=${dialog?.left}`,
  );

  await win.webContents.executeJavaScript(`(() => {
    const cancel = Array.from(document.querySelectorAll('.el-dialog__footer button')).find((node) =>
      (node.textContent ?? '').trim() === '取消',
    );
    if (cancel) cancel.click();
    return true;
  })()`);
  await sleep(300);

  // 恢复桌面尺寸并隐藏窗口，避免影响后续（结果已全部记录）
  win.setBounds({ ...win.getBounds(), width: 1440, height: 900 });
  await sleep(300);
  win.hide();
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
