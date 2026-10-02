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
 * 按角色权限模型：班级管理 / 学生管理 / 教师管理 仅管理员可见，
 * 教师端不应出现这些入口（后端同时强校验），因此这里的期望值就是教师可见的全部菜单。
 */
const MENU_ITEMS = [
  { label: '仪表盘', path: '/dashboard' },
  { label: '课表管理', path: '/schedules' },
  { label: '作业发布', path: '/homeworks' },
  { label: '通知发布', path: '/notifications' },
  { label: '成绩录入', path: '/grades' },
  { label: 'ClassIsland 联动', path: '/integrations' },
];

/** 教师端必须隐藏的入口（前端隐藏 + 后端 403，双重保障） */
const HIDDEN_MENU_LABELS = ['班级管理', '学生管理', '教师管理', '数据库管理'];

/** 管理员账号（教师录入用例）：与种子/安装初始化账号一致 */
const ADMIN_USERNAME = process.env.UI_SMOKE_ADMIN ?? 'admin';
const ADMIN_PASSWORD = process.env.UI_SMOKE_ADMIN_PASS ?? 'admin123';

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

/**
 * 管理员专属用例：登录 → 教师管理 → 录入教师 → 断言出现在列表 → 删除清理。
 *
 * 用户要求"支持录入学生也要支持录入老师，且录入老师的权限只有 admin"：
 * 因此这里用**管理员账号真实点一遍**（表单 → 接口 → 列表刷新），并在收尾删掉测试账号，
 * 保证"更支持录入教师"这条不是只有接口能跑、界面点不动。
 */
async function runAdminTeacherChecks(win) {
  const username = `smoke_teacher_${Date.now()}`;
  // 姓名固定用这个值：界面上要能看出"这是冒烟建的账号"，方便人工排查残留
  const teacherName = '冒烟测试老师';

  const fillLoginAndSubmit = async (user, password) => {
    await win.webContents.executeJavaScript(`(() => {
      const setValue = (element, value) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const inputs = Array.from(document.querySelectorAll('input'));
      setValue(inputs[0], ${JSON.stringify(user)});
      const passwordInput = inputs.find((item) => item.type === 'password') ?? inputs[1];
      setValue(passwordInput, ${JSON.stringify(password)});
      const button = Array.from(document.querySelectorAll('button')).find((item) =>
        (item.textContent ?? '').includes('登录'),
      );
      if (button) button.click();
      return true;
    })()`);
    return waitFor(win, `document.querySelectorAll('.el-menu-item').length >= 6`, 20000);
  };

  // 1) 换管理员账号（清掉教师登录态 → 整页重载更接近真人操作）
  await win.webContents.executeJavaScript(`(() => { localStorage.clear(); return true; })()`);
  await win.loadURL(TARGET_URL);
  const loginReady = await waitFor(win, `document.querySelectorAll('input').length >= 2`, 15000);
  if (!loginReady) {
    record('管理员登录（教师录入前置）', false, '登录页未渲染');
    return;
  }
  const adminReady = await fillLoginAndSubmit(ADMIN_USERNAME, ADMIN_PASSWORD);
  record('管理员登录（教师录入前置）', adminReady, `账号=${ADMIN_USERNAME}`);
  if (!adminReady) return;

  // 1.1) localStorage.clear() 把「已看过引导」的标记也一并清掉 → 管理员登录后引导会再次自动
  //      弹出；先把它跳过再继续，避免遮罩留在屏幕上干扰后续真实点击（跳过即记「已看过」）。
  //      出现/关闭判据与 3.5 相同：等 × 按钮渲染，关闭看 .el-tour__mask 卸载。
  await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !document.querySelector('.el-tour__closebtn')) await sleep(120);
    document.querySelector('.el-tour__closebtn')?.click();
    const closeDeadline = Date.now() + 2000;
    while (Date.now() < closeDeadline && document.querySelector('.el-tour__mask')) await sleep(100);
    return true;
  })()`);

  // 1.2) 数据库管理页（仅管理员）：点开菜单 → 状态卡与备份表渲染
  const databasePage = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const menu = Array.from(document.querySelectorAll('.el-menu-item')).find((node) =>
      (node.textContent ?? '').trim().startsWith('数据库管理'),
    );
    if (!menu) return { ok: false, reason: '管理员菜单里没有「数据库管理」' };
    menu.click();
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline && location.pathname !== '/database') await sleep(80);
    // 等状态卡与备份表渲染（状态卡含「当前数据库」标题，备份表在 el-table 里）
    let hasStatusCard = false;
    let hasBackupTable = false;
    const tableDeadline = Date.now() + 8000;
    while (Date.now() < tableDeadline && !(hasStatusCard && hasBackupTable)) {
      hasStatusCard = Boolean(document.querySelector('.page-title'));
      hasBackupTable = Boolean(document.querySelector('.el-table'));
      await sleep(100);
    }
    const title = (document.querySelector('.page-title')?.textContent ?? '').trim();
    return {
      ok: location.pathname === '/database' && title === '数据库管理' && hasStatusCard && hasBackupTable,
      reason: '',
      path: location.pathname,
      title,
      hasStatusCard,
      hasBackupTable,
    };
  })()`);
  record(
    '数据库管理页（仅管理员：状态卡与备份表渲染）',
    databasePage?.ok === true,
    `path=${databasePage?.path ?? '-'} 标题=${databasePage?.title ?? '-'} 状态卡=${databasePage?.hasStatusCard} 表=${databasePage?.hasBackupTable} ${databasePage?.reason ?? ''}`,
  );

  // 2) 打开「教师管理」→ 新建教师（表单 → 保存 → 列表出现）
  const created = await win.webContents.executeJavaScript(`(async () => {
    const menu = Array.from(document.querySelectorAll('.el-menu-item')).find((node) =>
      (node.textContent ?? '').trim().startsWith('教师管理'),
    );
    if (!menu) return { ok: false, reason: '管理员菜单里没有「教师管理」' };
    menu.click();
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline && location.pathname !== '/teachers') {
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
    const title = document.querySelector('.page-title')?.textContent?.trim() ?? '';
    const openButton = Array.from(document.querySelectorAll('button')).find((node) =>
      (node.textContent ?? '').trim() === '新建教师',
    );
    if (!openButton) return { ok: false, reason: '教师管理页没有「新建教师」按钮', title };
    openButton.click();
    const dialogDeadline = Date.now() + 5000;
    while (Date.now() < dialogDeadline && !document.querySelector('.el-dialog')) {
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    const dialog = Array.from(document.querySelectorAll('.el-dialog')).find((node) =>
      (node.querySelector('.el-dialog__title')?.textContent ?? '').includes('新建教师'),
    );
    if (!dialog) return { ok: false, reason: '新建教师弹窗未打开', title };
    const setValue = (element, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const inputs = Array.from(dialog.querySelectorAll('input'));
    setValue(inputs[0], ${JSON.stringify(teacherName)});
    setValue(inputs[1], ${JSON.stringify(username)});
    const passwordInput = inputs.find((item) => item.type === 'password');
    if (passwordInput) setValue(passwordInput, 'smoke123456');
    await new Promise((resolve) => setTimeout(resolve, 200));
    const save = Array.from(dialog.querySelectorAll('.el-dialog__footer button')).find((node) =>
      (node.textContent ?? '').trim() === '保存',
    );
    if (!save) return { ok: false, reason: '弹窗没有保存按钮', title };
    save.click();
    // 等列表刷新出这条账号
    const rowDeadline = Date.now() + 8000;
    let rowText = '';
    while (Date.now() < rowDeadline) {
      const rows = Array.from(document.querySelectorAll('.el-table__row'));
      const hit = rows.find((row) => (row.textContent ?? '').includes(${JSON.stringify(username)}));
      if (hit) {
        rowText = (hit.textContent ?? '').replace(/\\s+/g, ' ').trim();
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return { ok: Boolean(rowText), title, rowText };
  })()`);
  record(
    '管理员录入教师（新建教师弹窗 → 保存 → 列表出现该账号）',
    Boolean(created?.ok),
    `页面标题=${created?.title ?? '-'} 新账号行="${created?.rowText ?? ''}"${created?.reason ? ` 原因=${created.reason}` : ''}`,
  );

  // 3) 删除刚建的测试账号（接口有护栏：班主任/有课程时拒绝），保持库干净
  const removed = await win.webContents.executeJavaScript(`(async () => {
    const rows = Array.from(document.querySelectorAll('.el-table__row'));
    const row = rows.find((item) => (item.textContent ?? '').includes(${JSON.stringify(username)}));
    if (!row) return { ok: false, reason: '列表里找不到刚建的账号' };
    const removeButton = Array.from(row.querySelectorAll('button')).find((node) =>
      (node.textContent ?? '').trim() === '删除',
    );
    if (!removeButton) return { ok: false, reason: '行内没有删除按钮' };
    removeButton.click();
    const confirmDeadline = Date.now() + 5000;
    while (Date.now() < confirmDeadline && !document.querySelector('.el-message-box')) {
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    const confirm = Array.from(document.querySelectorAll('.el-message-box__btns button')).find((node) =>
      (node.textContent ?? '').trim().includes('确认删除'),
    );
    if (!confirm) return { ok: false, reason: '确认弹窗没有「确认删除」按钮' };
    confirm.click();
    const goneDeadline = Date.now() + 8000;
    while (Date.now() < goneDeadline) {
      const still = Array.from(document.querySelectorAll('.el-table__row')).some((item) =>
        (item.textContent ?? '').includes(${JSON.stringify(username)}),
      );
      if (!still) return { ok: true };
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return { ok: false, reason: '删除后列表里仍然存在' };
  })()`);
  record(
    '管理员删除教师账号（收尾清理，接口护栏保留）',
    Boolean(removed?.ok),
    `${removed?.ok ? `已删除 ${username}` : `原因=${removed?.reason ?? '-'}`}`,
  );
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

  // 2.1 登录页不允许出现任何示例/演示内容（用户要求："删掉登录页所有示例内容"）
  const loginContent = await win.webContents.executeJavaScript(`(() => {
    const text = (document.body.innerText || '').replace(/\\s+/g, ' ').trim();
    const tokens = ['演示', '示例账号', 'admin123', 'teacher123', 'student123', 'G101', '种子数据', '点击填充'];
    return { text: text.slice(0, 160), leaked: tokens.filter((item) => text.includes(item)) };
  })()`);
  record(
    '登录页不含示例/演示内容（无演示账号、无示例凭据）',
    (loginContent?.leaked ?? ['?']).length === 0,
    `越界文案=[${(loginContent?.leaked ?? []).join(',')}] 可见文本="${loginContent?.text ?? ''}"`,
  );

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

  // 3.5 初次登录引导（新功能）：首次登录自动弹出聚焦式引导，可跳过；
  // 跳过（右上角 ×）后写入「已看过」标记，本次 profile 里不会再自动弹出。
  // 判据说明：el-tour 关闭后内容元素会像 el-dialog 一样残留在 DOM（父级 .el-popper 被隐藏，
  // AGENTS §7 第 22 条同款陷阱），所以「出现」等 × 按钮渲染、「关闭」看遮罩 .el-tour__mask 卸载。
  const tour = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    // 引导在布局挂载后延迟 ~600ms 弹出，且 popper 内容晚于外壳渲染，等 × 按钮真正出现
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !document.querySelector('.el-tour__closebtn')) await sleep(120);
    if (!document.querySelector('.el-tour__closebtn')) return { appeared: false, closed: false };
    const close = document.querySelector('.el-tour__closebtn');
    close.click();
    const closeDeadline = Date.now() + 3000;
    while (Date.now() < closeDeadline && document.querySelector('.el-tour__mask')) await sleep(120);
    return { appeared: true, closed: !document.querySelector('.el-tour__mask') };
  })()`);
  record(
    '首次登录展示新手引导且可跳过',
    tour?.appeared === true && tour?.closed === true,
    `出现=${tour?.appeared ?? '-'} 跳过后关闭=${tour?.closed ?? '-'}`,
  );

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
    '教师端隐藏无权入口（班级管理/学生管理/教师管理）',
    (hiddenCheck?.leaked ?? ['?']).length === 0,
    `可见菜单=[${(hiddenCheck?.labels ?? []).join(',')}] 越权入口=[${(hiddenCheck?.leaked ?? []).join(',')}]`,
  );

  // 7.51 仅管理员页面：教师**直接输网址**也必须被路由守卫挡回仪表盘
  //      （菜单隐藏只是"看不见"，不等于没有权限 —— 这里验证真的进不去）
  await win.loadURL(`${TARGET_URL.replace(/\/$/, '')}/teachers`);
  const teachersBlocked = await waitFor(win, `location.pathname === '/dashboard'`, 15000);
  const blockedTitle = await win.webContents.executeJavaScript(
    `document.querySelector('.page-title')?.textContent?.trim() ?? ''`,
  );
  record(
    '教师端直接访问 /teachers 被挡回仪表盘（录入教师仅管理员）',
    teachersBlocked && blockedTitle !== '教师管理',
    `落地=${await win.webContents.executeJavaScript('location.pathname')} 标题=${blockedTitle}`,
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
  // 7.7 ClassIsland 课程表导入弹窗（班主任可见：粘贴 JSON → 解析预览 → 单双周识别）
  //     注：需求调整后课表页只保留「导入 ClassIsland 课程表」入口（"导入时间配置"按钮已下线，
  //     时间表由课程表 JSON 里的 TimeLayouts 一起带进来）。
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

    const buttons = Array.from(document.querySelectorAll('button'));
    const openButton = buttons.find((node) => (node.textContent ?? '').trim() === '导入 ClassIsland 课程表');
    if (!openButton) return { ok: false, reason: '课表页没有"导入 ClassIsland 课程表"按钮（班主任权限未生效？）' };
    // 旧入口必须已经下线（需求 ⑩）
    const legacy = buttons.some((node) => (node.textContent ?? '').trim() === '导入时间配置');
    openButton.click();
    await sleep(700);

    const dialog = Array.from(document.querySelectorAll('.el-dialog')).find((node) =>
      (node.querySelector('.el-dialog__title')?.textContent ?? '').includes('ClassIsland'),
    );
    if (!dialog) return { ok: false, reason: '课程表导入弹窗未打开' };

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

    const previewDeadline = Date.now() + 9000;
    let rows = 0;
    let importEnabled = false;
    let errors = 0;
    let parityTags = 0;
    let content = '';
    while (Date.now() < previewDeadline) {
      rows = dialog.querySelectorAll('.el-table__body tbody tr').length;
      errors = dialog.querySelectorAll('.el-alert--error').length;
      const tags = Array.from(dialog.querySelectorAll('.el-tag')).map((node) => (node.textContent ?? '').trim());
      parityTags = tags.filter((text) => text === '单周' || text === '双周').length;
      content = (dialog.textContent ?? '').replace(/\s+/g, ' ');
      const confirm = Array.from(dialog.querySelectorAll('.el-dialog__footer button')).find(
        (node) => (node.textContent ?? '').trim() === '开始导入',
      );
      importEnabled = Boolean(confirm) && !confirm.disabled;
      if (rows >= 2) break;
      await sleep(150);
    }
    return {
      ok: true,
      rows,
      importEnabled,
      errors,
      parityTags,
      legacyGone: !legacy,
      hasFileInput: Boolean(dialog.querySelector('input[type=file]')) || content.includes('选择 .json 文件'),
    };
  })()`);
  record(
    'ClassIsland 课程表导入弹窗（示例 → 解析预览 → 识别单双周，旧"导入时间配置"入口已下线）',
    Boolean(layoutDialog?.ok) &&
      (layoutDialog?.rows ?? 0) >= 2 &&
      layoutDialog?.importEnabled === true &&
      layoutDialog?.errors === 0 &&
      (layoutDialog?.parityTags ?? 0) >= 1 &&
      layoutDialog?.legacyGone === true,
    `解析行=${layoutDialog?.rows ?? 0} 可导入=${layoutDialog?.importEnabled} 校验错误=${layoutDialog?.errors ?? '-'} ` +
      `单双周标签=${layoutDialog?.parityTags ?? 0} 旧入口已下线=${layoutDialog?.legacyGone} 文件选择=${layoutDialog?.hasFileInput}` +
      `${layoutDialog?.reason ? ` 原因=${layoutDialog.reason}` : ''}`,
  );
  // 关闭导入弹窗（用标题栏关闭按钮，兼容不同对话框的底部按钮文案）
  await win.webContents.executeJavaScript(`(() => {
    const dialog = Array.from(document.querySelectorAll('.el-dialog')).find((node) =>
      (node.querySelector('.el-dialog__title')?.textContent ?? '').includes('ClassIsland'),
    );
    const closeBtn = dialog?.querySelector('.el-dialog__headerbtn');
    if (closeBtn) closeBtn.click();
    return true;
  })()`);
  await sleep(300);

  // 7.8 授课科目统一：新增课表的科目下拉直接列出"全校统一科目"（不必按班级先录入课程），
  //     选中后自动建课并写入课表；用例结束把这条课表删掉，保证不污染演示数据。
  const unifiedSubject = await win.webContents.executeJavaScript(`(async () => {
    const openButton = Array.from(document.querySelectorAll('button')).find((node) =>
      (node.textContent ?? '').trim() === '新增课表',
    );
    if (!openButton) return { ok: false, reason: '课表页没有「新增课表」按钮（当前账号不是班主任？）' };
    openButton.click();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !document.querySelector('.el-dialog')) {
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    const dialog = Array.from(document.querySelectorAll('.el-dialog')).find((node) =>
      (node.querySelector('.el-dialog__title')?.textContent ?? '').includes('新增课表'),
    );
    if (!dialog) return { ok: false, reason: '新增课表弹窗未打开' };
    const selects = Array.from(dialog.querySelectorAll('.el-select__wrapper'));
    if (selects.length < 2) return { ok: false, reason: '弹窗里没有科目/星期下拉' };

    // 打开科目下拉，读取"统一科目"分组
    selects[0].click();
    await new Promise((resolve) => setTimeout(resolve, 450));
    const groups = Array.from(document.querySelectorAll('.el-select-group__title')).map((node) =>
      node.textContent.trim(),
    );
    // Element Plus 的 el-option-group 结构是：.el-select-group__wrap > (.el-select-group__title + ul.el-select-group)
    const unifiedWrap = Array.from(document.querySelectorAll('.el-select-group__wrap')).find((node) =>
      (node.querySelector('.el-select-group__title')?.textContent ?? '').includes('统一科目'),
    );
    const unifiedNames = unifiedWrap
      ? Array.from(unifiedWrap.querySelectorAll('.el-select-dropdown__item')).map((node) =>
          node.textContent.trim(),
        )
      : [];
    if (unifiedNames.length === 0) {
      return { ok: false, reason: '科目下拉里没有「统一科目」分组（该班已把所有科目都建好了？）', groups };
    }
    const subjectName = unifiedNames[0];
    const subjectOption = Array.from(unifiedWrap.querySelectorAll('.el-select-dropdown__item')).find(
      (node) => node.textContent.trim() === subjectName,
    );
    subjectOption.click();
    await new Promise((resolve) => setTimeout(resolve, 300));

    // 星期改成周日（避开演示课表的周一~周五），时间用默认值
    selects[1].click();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const sunday = Array.from(document.querySelectorAll('.el-select-dropdown__item')).find((node) =>
      (node.textContent ?? '').trim() === '周日',
    );
    if (!sunday) return { ok: false, reason: '星期下拉里没有「周日」' };
    sunday.click();
    await new Promise((resolve) => setTimeout(resolve, 300));

    const save = Array.from(dialog.querySelectorAll('.el-dialog__footer button')).find((node) =>
      (node.textContent ?? '').trim() === '保存',
    );
    if (!save) return { ok: false, reason: '弹窗没有保存按钮' };
    save.click();

    // 等课表列表出现这条（课程名 = 统一科目名）
    const listDeadline = Date.now() + 8000;
    let rowText = '';
    while (Date.now() < listDeadline) {
      const rows = Array.from(document.querySelectorAll('.el-table__row'));
      const hit = rows.find((row) => (row.textContent ?? '').includes(subjectName));
      if (hit) {
        rowText = (hit.textContent ?? '').replace(/\\s+/g, ' ').trim();
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return { ok: Boolean(rowText), subjectName, groups, unifiedCount: unifiedNames.length, rowText };
  })()`);
  record(
    '课表科目为全校统一目录（选中自动建课并写入课表）',
    Boolean(unifiedSubject?.ok) && (unifiedSubject?.unifiedCount ?? 0) >= 1,
    `统一科目分组=${(unifiedSubject?.groups ?? []).join('/') || '-'} 可选项=${unifiedSubject?.unifiedCount ?? 0} ` +
      `科目=${unifiedSubject?.subjectName ?? '-'} 新行="${unifiedSubject?.rowText ?? ''}"` +
      `${unifiedSubject?.reason ? ` 原因=${unifiedSubject.reason}` : ''}`,
  );

  // 删掉刚写入的那条课表**以及自动建出来的课程**，保持演示数据不变
  const removedUnified = await win.webContents.executeJavaScript(`(async () => {
    const rows = Array.from(document.querySelectorAll('.el-table__row'));
    const row = rows.find((item) => (item.textContent ?? '').includes(${JSON.stringify(
      unifiedSubject?.subjectName ?? '',
    )}));
    if (!row) return { ok: false, reason: '列表里找不到刚写入的课表行' };
    const removeButton = Array.from(row.querySelectorAll('button')).find((node) =>
      (node.textContent ?? '').trim() === '删除',
    );
    if (!removeButton) return { ok: false, reason: '行内没有删除按钮' };
    removeButton.click();
    const confirmDeadline = Date.now() + 5000;
    while (Date.now() < confirmDeadline && !document.querySelector('.el-message-box')) {
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    const confirm = Array.from(document.querySelectorAll('.el-message-box__btns button')).find((node) =>
      (node.textContent ?? '').trim() === '确定',
    );
    if (!confirm) return { ok: false, reason: '确认弹窗没有确定按钮' };
    confirm.click();
    await new Promise((resolve) => setTimeout(resolve, 900));

    // 自动建课留下的课程行也一并删掉（该科目本来不在这个班里）
    const token = localStorage.getItem('classhelper.token') ?? '';
    const headers = { authorization: 'Bearer ' + token };
    // 工具栏第一个选择器就是班级选择器；el-select 非 filterable 时选中项是 span 文本，读 textContent
    const classLabel = (document.querySelector('.toolbar .el-select')?.textContent ?? '').trim();
    const classes = (await (await fetch('/api/classes', { headers })).json()).data ?? [];
    const target = classes.find((item) => item.name === classLabel);
    if (!target) return { ok: true, courseRemoved: false, reason: '未能定位当前班级：' + classLabel };
    const courses = (await (await fetch('/api/courses?classId=' + target.id, { headers })).json()).data ?? [];
    const created = courses.find((item) => item.name === ${JSON.stringify(unifiedSubject?.subjectName ?? '')});
    if (!created) return { ok: true, courseRemoved: false };
    const removed = await fetch('/api/courses/' + created.id, { method: 'DELETE', headers });
    return { ok: true, courseRemoved: removed.ok, className: target.name };
  })()`);
  record(
    '课表用例收尾：统一科目课表与自动建的课程都已删除（不污染演示数据）',
    Boolean(removedUnified?.ok),
    removedUnified?.ok
      ? `课表已删除；课程已删除=${removedUnified.courseRemoved === true}（班级=${removedUnified.className ?? '-'}）`
      : `原因=${removedUnified?.reason ?? '-'}`,
  );

  // 7.85 ClassIsland 联动页：班主任为本班签发设备令牌 → 页面下发提醒表单可用 → 收尾删除设备
  //      （这条链路是"老师在 Web 端发提醒 → 教室里 ClassIsland 全屏弹出"的入口，必须真实点得动）
  const integrationUi = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const menu = Array.from(document.querySelectorAll('.el-menu-item')).find((node) =>
      (node.textContent ?? '').trim().startsWith('ClassIsland 联动'),
    );
    if (!menu) return { ok: false, reason: '教师端看不到「ClassIsland 联动」入口' };
    menu.click();
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline && location.pathname !== '/integrations') await sleep(80);
    if (location.pathname !== '/integrations') return { ok: false, reason: '点击后没有跳到 /integrations' };
    await sleep(900);

    const buttons = Array.from(document.querySelectorAll('button')).map((node) => (node.textContent ?? '').trim());
    const title = (document.querySelector('.page-title')?.textContent ?? '').trim();

    // 打开「下发提醒」弹窗：表单字段齐不齐
    const notifyButton = Array.from(document.querySelectorAll('button')).find((node) =>
      (node.textContent ?? '').trim() === '下发提醒',
    );
    if (!notifyButton) return { ok: false, title, reason: '页面没有「下发提醒」按钮' };
    notifyButton.click();
    await sleep(700);
    const notifyDialog = Array.from(document.querySelectorAll('.el-dialog')).find((node) =>
      (node.querySelector('.el-dialog__title')?.textContent ?? '').includes('下发提醒到 ClassIsland'),
    );
    if (!notifyDialog) return { ok: false, title, reason: '下发提醒弹窗未打开' };
    const labels = Array.from(notifyDialog.querySelectorAll('.el-form-item__label')).map((node) =>
      (node.textContent ?? '').trim(),
    );
    const submit = Array.from(notifyDialog.querySelectorAll('.el-dialog__footer button')).some(
      (node) => (node.textContent ?? '').trim() === '立即下发',
    );
    const cancel = Array.from(document.querySelectorAll('.el-dialog__footer button')).find((node) =>
      (node.textContent ?? '').trim() === '取消',
    );
    if (cancel) cancel.click();
    await sleep(400);

    // 打开「接入新设备」：生成令牌 → 弹窗必须给出 chci_ 明文
    // 收尾要删掉本次新增的设备，因此先记下当前已有的 id，之后按"集合差"清理
    const authHeaders = { authorization: 'Bearer ' + (localStorage.getItem('classhelper.token') ?? '') };
    const before = (await (await fetch('/api/integrations/devices', { headers: authHeaders })).json()).data ?? [];
    const beforeIds = new Set(before.map((item) => item.id));

    const createButton = Array.from(document.querySelectorAll('button')).find((node) =>
      (node.textContent ?? '').trim() === '接入新设备',
    );
    if (!createButton) return { ok: false, title, reason: '页面没有「接入新设备」按钮' };
    createButton.click();
    await sleep(600);
    const createDialog = Array.from(document.querySelectorAll('.el-dialog')).find((node) =>
      (node.querySelector('.el-dialog__title')?.textContent ?? '').includes('接入新设备'),
    );
    if (!createDialog) return { ok: false, title, reason: '接入新设备弹窗未打开' };
    const classSelected = Boolean((createDialog.querySelector('.el-select')?.textContent ?? '').trim());

    // 「设备名称」是 el-input，且同一弹窗里 el-select 也渲染 input，
    // 所以必须按表单项标签定位，否则会写进班级选择框里（这正是第一次写这个用例时踩的坑）
    const nameItem = Array.from(createDialog.querySelectorAll('.el-form-item')).find(
      (node) => (node.querySelector('.el-form-item__label')?.textContent ?? '').trim() === '设备名称',
    );
    const nameInput = nameItem?.querySelector('input');
    if (!nameInput) return { ok: false, title, reason: '「设备名称」输入框未找到' };
    nameInput.value = 'UI 冒烟设备';
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(200);
    const generate = Array.from(createDialog.querySelectorAll('.el-dialog__footer button')).find((node) =>
      (node.textContent ?? '').trim() === '生成设备令牌',
    );
    if (!generate) return { ok: false, title, reason: '弹窗没有「生成设备令牌」按钮' };
    generate.click();

    const tokenDeadline = Date.now() + 8000;
    let tokenText = '';
    while (Date.now() < tokenDeadline) {
      const box = document.querySelector('.el-dialog textarea');
      tokenText = (box?.value ?? '').trim();
      if (tokenText.startsWith('chci_')) break;
      await sleep(150);
    }
    const hasCopy = Array.from(document.querySelectorAll('.el-dialog__footer button')).some((node) =>
      (node.textContent ?? '').trim() === '复制令牌',
    );
    const closeToken = Array.from(document.querySelectorAll('.el-dialog__footer button')).find((node) =>
      (node.textContent ?? '').trim() === '关闭',
    );
    if (closeToken) closeToken.click();
    await sleep(400);

    // 用接口再确认一次"确实新建了一台设备"（界面上的令牌弹窗也可能是假象）
    const after = (await (await fetch('/api/integrations/devices', { headers: authHeaders })).json()).data ?? [];
    const created = after.filter((item) => !beforeIds.has(item.id));

    return {
      ok: true,
      title,
      hasNotify: buttons.includes('下发提醒'),
      hasCreate: buttons.includes('接入新设备'),
      labels,
      submit,
      classSelected,
      tokenPrefixOk: tokenText.startsWith('chci_'),
      tokenLength: tokenText.length,
      hasCopy,
      path: location.pathname,
      createdCount: created.length,
      createdName: created[0]?.name ?? '',
      createdIds: created.map((item) => item.id),
    };
  })()`);
  record(
    'ClassIsland 联动页（教师为本班签发设备令牌 + 下发提醒表单）',
    Boolean(integrationUi?.ok) &&
      integrationUi?.title === 'ClassIsland 联动' &&
      integrationUi?.hasNotify === true &&
      integrationUi?.hasCreate === true &&
      integrationUi?.submit === true &&
      integrationUi?.classSelected === true &&
      integrationUi?.tokenPrefixOk === true &&
      integrationUi?.tokenLength > 40 &&
      integrationUi?.hasCopy === true &&
      integrationUi?.createdCount === 1 &&
      integrationUi?.createdName === 'UI 冒烟设备' &&
      ['目标班级', '标题', '内容', '显示时长', '优先级', '语音朗读', '同步通知中心'].every((label) =>
        (integrationUi?.labels ?? []).includes(label),
      ),
    `path=${integrationUi?.path ?? '-'} 标题=${integrationUi?.title ?? '-'} 表单字段=[${(integrationUi?.labels ?? []).join('/')}] ` +
      `令牌前缀=${integrationUi?.tokenPrefixOk ? 'chci_' : '(异常)'}(${integrationUi?.tokenLength ?? 0} 字符) ` +
      `新建设备=${integrationUi?.createdCount ?? 0}台(${integrationUi?.createdName ?? '-'})` +
      `${integrationUi?.reason ? ` 原因=${integrationUi.reason}` : ''}`,
  );

  // 收尾：把本次新建的设备按 id 删掉（演示数据里不该留下"UI 冒烟设备"）
  const integrationCleanup = await win.webContents.executeJavaScript(`(async () => {
    const token = localStorage.getItem('classhelper.token') ?? '';
    const headers = { authorization: 'Bearer ' + token };
    const ids = ${JSON.stringify(integrationUi?.createdIds ?? [])};
    for (const id of ids) {
      await fetch('/api/integrations/devices/' + id, { method: 'DELETE', headers });
    }
    const list = (await (await fetch('/api/integrations/devices', { headers })).json()).data ?? [];
    return { ok: true, removed: ids.length, left: list.filter((item) => ids.includes(item.id)).length };
  })()`);
  record(
    'ClassIsland 联动用例收尾：冒烟设备已删除（不污染演示数据）',
    Boolean(integrationCleanup?.ok) && integrationCleanup?.left === 0,
    `删除=${integrationCleanup?.removed ?? 0} 残留=${integrationCleanup?.left ?? '-'}` +
      (integrationCleanup?.reason ? ` 原因=${integrationCleanup.reason}` : ''),
  );

  // 7.9 管理员专属：教师录入（本轮新增「教师管理」页，仅管理员可见可用）
  await runAdminTeacherChecks(win);

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
