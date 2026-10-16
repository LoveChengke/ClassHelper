/** 隔离验证缓存故障恢复、实时通知竞态和崩溃恢复，不创建任何桌面窗口。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
const root = path.resolve('.');
const { build } = createRequire(path.join(root, 'packages/desktop-client/package.json'))('esbuild');
fs.mkdirSync(path.join(root, '.cache/tmp'), { recursive: true });
const temp = fs.mkdtempSync(path.join(root, '.cache/tmp/review-client-'));
let passed = 0;
function check(name, value) {
  assert.ok(value, name);
  passed++;
  console.log(`✓ ${name}`);
}
const h = { writes: [], pending: [], app: new EventEmitter(), handlers: {}, restarts: 0, recoveries: 0 };
globalThis.__reviewClientTest = h;
async function bundle(name, entry, mocks = {}, append = '', prefix = '') {
  const target = path.join(temp, `${name}.mjs`);
  await build({
    entryPoints: [path.join(root, entry)],
    outfile: target,
    platform: 'node',
    format: 'esm',
    bundle: true,
    logLevel: 'silent',
    plugins: [
      {
        name: '隔离依赖',
        setup(b) {
          b.onResolve({ filter: /.*/ }, (args) => {
            const key = Object.keys(mocks).find((key) => args.path === key);
            if (key) return { path: key, namespace: 'review-mock' };
          });
          b.onLoad({ filter: /.*/, namespace: 'review-mock' }, (args) => ({
            contents: mocks[args.path],
            loader: 'js',
          }));
          b.onLoad({ filter: /\.(ts)$/ }, (args) =>
            args.path === path.join(root, entry)
              ? { contents: prefix + fs.readFileSync(args.path, 'utf8') + append, loader: 'ts' }
              : null,
          );
        },
      },
    ],
  });
  return import(pathToFileURL(target).href);
}
const refMock =
  'export const ref=(value)=>({value}); export const computed=(fn)=>({get value(){return fn()}});';
try {
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  try {
    h.webPermissions = ['permission:manage', 'system:manage'];
    const webAuth = await bundle('web-auth', 'packages/web-admin/src/stores/auth.ts', {
      vue: refMock,
      pinia: 'export const defineStore=(_name, setup)=>setup;',
      '@/api':
        'export const authApi={}; export const permissionApi={me:async()=>({permissions:globalThis.__reviewClientTest.webPermissions,fromGroups:false})};',
    });
    const auth = webAuth.useAuthStore();
    auth.user.value = { role: 'ADMIN' };
    auth.token.value = 'admin-test';
    await auth.ensurePermissions();
    check(
      '管理员界面不会绕过已收回的默认组权限',
      !auth.can('remote:control') && !auth.can('ai:use') && auth.can('permission:manage'),
    );
    h.webPermissions.push('remote:control');
    await auth.ensurePermissions(true);
    check('刷新权限后管理员界面采用当前生效集合', auth.can('remote:control'));
  } finally {
    globalThis.localStorage = previousStorage;
  }
  const requests = [];
  const originalIndexedDB = globalThis.indexedDB;
  globalThis.indexedDB = {
    open() {
      const request = {};
      requests.push(request);
      return request;
    },
  };
  try {
    const db = await bundle('database', 'packages/desktop-client/src/renderer/cache/db.ts');
    const first = db.cacheGet('grades', 'key');
    requests[0].error = new Error('首次打开失败');
    requests[0].onerror();
    await assert.rejects(first, /首次打开失败/);
    const second = db.cacheGet('grades', 'key');
    check('IndexedDB 打开失败后会重新发起请求', requests.length === 2);
    let closed = false;
    const connection = {
      close() {
        closed = true;
      },
      transaction() {
        const transaction = {
          objectStore: () => ({
            get() {
              const request = { result: undefined };
              queueMicrotask(() => transaction.oncomplete());
              return request;
            },
          }),
        };
        return transaction;
      },
    };
    requests[1].result = connection;
    requests[1].onsuccess();
    check('重试成功后可以正常读取缓存', (await second) === null);
    connection.onversionchange();
    check('版本变化会关闭旧连接', closed);
    const blocked = db.cacheGet('grades', 'key');
    requests[2].onblocked();
    await assert.rejects(blocked, /其它窗口/);
    const retry = db.cacheGet('grades', 'key');
    requests[3].result = connection;
    requests[3].onsuccess();
    check('数据库被占用后也可以恢复', (await retry) === null && requests.length === 4);
  } finally {
    globalThis.indexedDB = originalIndexedDB;
  }

  const notifications = await bundle(
    'notifications',
    'packages/desktop-client/src/renderer/stores/notifications.ts',
    {
      vue: refMock,
      pinia: 'export const defineStore=(_name, setup)=>setup;',
      '../api/index.js':
        'const h=globalThis.__reviewClientTest; export const notificationApi={list:()=>new Promise(resolve=>h.pending.push(resolve)),markRead:async()=>({}),markAllRead:async()=>({marked:1}),unreadCount:async()=>({count:0})};',
      '../cache/db.js':
        'const h=globalThis.__reviewClientTest; export const cacheGet=async()=>null; export const cacheSet=async(...args)=>{h.writes.push(args)};',
      './db.js':
        'const h=globalThis.__reviewClientTest; export const cacheGet=async()=>null; export const cacheSet=async(...args)=>{h.writes.push(args)};',
      './app.js': 'export const useAppStore=()=>({markSynced(){}});',
    },
    `\nexport {setCacheScope} from '../cache/scope.js';`,
  );
  const store = notifications.useNotificationStore();
  const item = {
    id: 'n',
    title: '实时通知',
    content: '内容',
    classId: 'c',
    priority: 'NORMAL',
    read: false,
    createdAt: new Date().toISOString(),
  };
  let loading = store.load();
  await store.pushRealtime(item);
  h.pending.shift()([]);
  await loading;
  check('列表请求中的实时新通知不会丢失', store.items.value[0]?.id === 'n' && store.unreadCount.value === 1);
  loading = store.load();
  await store.markRead('n');
  h.pending.shift()([{ ...item, read: false }]);
  await loading;
  check('迟到的列表快照不会撤销本地已读', store.items.value[0]?.read === true);
  loading = store.load();
  await store.removeRealtime('n');
  h.pending.shift()([item]);
  await loading;
  check('已删除通知不会被迟到快照复活', store.items.value.length === 0);
  loading = store.load();
  notifications.setCacheScope('http://other.invalid', 'other-class');
  h.pending.shift()([item]);
  await loading;
  check('旧会话迟到响应不会污染换班后的列表', store.items.value.length === 0);

  const previousWindow = globalThis.window;
  const noon = new Date();
  noon.setHours(10, 0, 0, 0);
  h.FixedDate = class extends Date {
    constructor(...args) {
      super(...(args.length ? args : [noon.getTime()]));
    }
  };
  h.classStates = [];
  globalThis.window = { desktop: { islandSetClassState: (state) => h.classStates.push(state) } };
  h.auth = { token: 'session', classId: 'c' };
  h.termWeek = 9;
  h.appStore = {
    currentWeek: 1,
    async refreshTerm() {
      this.currentWeek = h.termWeek;
    },
  };
  h.scheduleLoader = async (params) => {
    h.requestedWeek = params.week;
    return [
      {
        id: 's',
        classId: 'c',
        courseId: 'course',
        course: { name: '语文' },
        dayOfWeek: noon.getDay() || 7,
        startTime: '08:00',
        endTime: '11:00',
        weekStart: params.week,
        weekEnd: params.week,
        weekParity: 'ALL',
      },
    ];
  };
  const bridge = await bundle(
    'bridge',
    'packages/desktop-client/src/renderer/island/bridge.ts',
    {
      vue: 'export const watch=()=>()=>{};',
      '../api/index.js':
        'const h=globalThis.__reviewClientTest; export const scheduleApi={list:(params)=>h.scheduleLoader(params)}; export const notificationApi={list:async()=>[]};',
      './db.js': 'export const cacheGet=async()=>null; export const cacheSet=async()=>{};',
      '../stores/app.js':
        'export const useAppStore=()=>globalThis.__reviewClientTest.appStore; export const readOfflineSince=()=>null; export const clearOfflineSince=()=>{};',
      '../stores/auth.js': 'export const useAuthStore=()=>globalThis.__reviewClientTest.auth;',
      '../stores/notifications.js': 'export const useNotificationStore=()=>({});',
      '../stores/realtime.js': 'export const useRealtimeStore=()=>({on(){},off(){}});',
    },
    `\nexport {setCacheScope} from '../cache/scope.js';`,
    'const Date=globalThis.__reviewClientTest.FixedDate;\n',
  );
  try {
    await bridge.refreshIslandSchedules();
    check(
      '先解析真实教学周再请求课表，不会误取第 1 周',
      h.requestedWeek === 9 && bridge.getIslandClassContext().inClass,
    );
    const loader = h.scheduleLoader;
    h.scheduleLoader = async () => {
      throw new Error('短暂断网');
    };
    await bridge.refreshIslandSchedules();
    check(
      '无缓存的失败刷新不会清掉已知课表或上课状态',
      bridge.getIslandSchedules().length === 1 && bridge.getIslandClassContext().inClass,
    );
    h.scheduleLoader = loader;
    h.termWeek = 10;
    await bridge.refreshIslandSchedules();
    check('教学周变更后按新周请求并计算', h.requestedWeek === 10 && bridge.getIslandClassContext().inClass);
    h.scheduleLoader = () =>
      new Promise((resolve) => {
        h.finishSchedule = resolve;
      });
    const pending = bridge.refreshIslandSchedules();
    await Promise.resolve();
    await Promise.resolve();
    bridge.stopIslandBridge();
    bridge.setCacheScope('http://changed.invalid', 'class-b');
    h.finishSchedule([]);
    await pending;
    check('停止桥接后旧班迟到课表不能恢复旧会话', bridge.getIslandSchedules().length === 0);
  } finally {
    globalThis.window = previousWindow;
  }

  h.app.relaunch = () => h.restarts++;
  h.process = {
    env: {},
    on: (event, handler) => {
      h.handlers[event] = handler;
    },
  };
  const guard = await bundle(
    'guard',
    'packages/desktop-client/src/main/crash-guard.ts',
    {
      electron: 'export const app=globalThis.__reviewClientTest.app;',
      './logger.js': 'export const logger={info(){},warn(){},error(){}};',
    },
    '',
    'const process=globalThis.__reviewClientTest.process;\n',
  );
  guard.installCrashGuard({
    recoverMainWindow: async () => {
      h.recoveries++;
      await new Promise((resolve) => {
        h.finishRecovery = resolve;
      });
    },
    isIdle: () => true,
    quitApp() {},
  });
  h.app.emit('render-process-gone', {}, { id: 99 }, { reason: 'crashed', exitCode: 2 });
  check('没有主窗口时不会把灵动岛崩溃当成主窗口崩溃', h.recoveries === 0);
  const win = new EventEmitter();
  Object.assign(win, { webContents: { id: 10 }, isDestroyed: () => false, hide() {} });
  guard.watchMainWindow(win);
  h.app.emit('render-process-gone', {}, { id: 10 }, { reason: 'crashed', exitCode: 2 });
  h.app.emit('render-process-gone', {}, { id: 10 }, { reason: 'crashed', exitCode: 2 });
  check('异步窗口恢复完成前不重复重建', h.recoveries === 1);
  h.finishRecovery();
  await Promise.resolve();
  h.handlers.unhandledRejection(new Error('普通请求失败'));
  check('普通 Promise 拒绝不会触发应用重启', h.restarts === 0);
  h.handlers.uncaughtException(new Error('致命异常'));
  check('空闲时真正致命的异常仍可重启恢复', h.restarts === 1);
  console.log(`审查客户端逻辑回归：${passed}/${passed} 项通过`);
} finally {
  delete globalThis.__reviewClientTest;
  fs.rmSync(temp, { recursive: true, force: true });
}
