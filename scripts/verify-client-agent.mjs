/** 用隔离的配置与模拟操作系统验证心跳、远控与更新，绝不执行真实关机或安装器。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireClient = createRequire(path.join(root, 'packages/desktop-client/package.json'));
const { build } = requireClient('esbuild');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'classhelper-agent-'));
const originalFetch = globalThis.fetch;
let passed = 0;
const h = {
  config: {
    serverUrl: 'http://127.0.0.1:4199',
    username: 'temporary-class',
    token: 'test-session',
    deviceKey: 'regression-device-key',
    autoUpdate: true,
    pendingUpdateVersion: '',
    pendingUpdateFile: '',
  },
  version: '1.0.0',
  visible: false,
  inClass: false,
  confirmed: true,
  spawnCode: 0,
  spawnError: false,
  spawned: [],
  acked: [],
  ackFails: false,
  quitCount: 0,
  committed: 0,
  cancelled: 0,
};
globalThis.__clientAgentTest = h;
function check(name, fn) {
  fn();
  passed++;
  console.log(`✓ ${name}`);
}
h.spawn = (file, args, options) => {
  h.spawned.push({ file, args, options });
  const child = new EventEmitter();
  child.unref = () => {};
  queueMicrotask(() => {
    if (h.holdSpawn) {
      h.heldChild = child;
      return;
    }
    if (h.spawnError) child.emit('error', new Error('模拟权限不足'));
    else {
      child.emit('spawn');
      child.emit('exit', h.spawnCode);
    }
  });
  return child;
};
const mockSources = {
  electron: `const h=globalThis.__clientAgentTest;
    export const BrowserWindow={getAllWindows:()=>[{isDestroyed:()=>false,isVisible:()=>h.visible,webContents:{send:()=>{}}}]};
    export const app={getVersion:()=>h.version,getPath:(name)=>name==='exe'?'C:/测试目录/ClassHelper.exe':${JSON.stringify(temp)},quit:()=>h.quitCount++};
    export const dialog={showMessageBox:async()=>({response:h.confirmed?1:0})};`,
  config: `const h=globalThis.__clientAgentTest; export const getConfig=()=>h.config;
    export const saveConfig=(patch)=>Object.assign(h.config,patch);`,
  island: `export const island={getState:()=>({inClass:globalThis.__clientAgentTest.inClass}),getCoursewareTransfer:()=>null};`,
  courseware: `export const pollCourseware=async()=>{};`,
  logger: `export const logger={info:()=>{},warn:()=>{},error:()=>{},debug:()=>{}};`,
  process: `export const spawn=(...args)=>globalThis.__clientAgentTest.spawn(...args);`,
  'update-installer': `const h=globalThis.__clientAgentTest;
    export async function prepareUpdateInstaller(options) {
      h.spawned.push({file:'update-helper.exe', options});
      if(h.spawnError)throw new Error('模拟安装助手启动失败');
      if(h.waitHelper)await new Promise(resolve=>h.releaseHelper=resolve);
      return {commit:()=>h.committed++,cancel:()=>h.cancelled++};
    }`,
};
try {
  const bundle = path.join(temp, 'agent.mjs');
  await build({
    entryPoints: [path.join(root, 'packages/desktop-client/src/main/client-agent.ts')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
    plugins: [
      {
        name: '模拟操作系统',
        setup(b) {
          b.onResolve({ filter: /^(electron|node:child_process)$/ }, (args) => ({
            path: args.path === 'electron' ? 'electron' : 'process',
            namespace: 'mock',
          }));
          b.onResolve({ filter: /^\.\/(config|island|logger|courseware|update-installer)\.js$/ }, (args) => ({
            path: path.basename(args.path, '.js'),
            namespace: 'mock',
          }));
          b.onLoad({ filter: /.*/, namespace: 'mock' }, (args) => ({
            contents: mockSources[args.path],
            loader: 'js',
          }));
          b.onLoad({ filter: /client-agent\.ts$/ }, async (args) => ({
            contents:
              fs.readFileSync(args.path, 'utf8') +
              `\nexport { beat, handleCommand, executeCommand };
          export { syncUpdatePolicy, considerUpdate, maybeInstallPendingUpdate, setQuitHandler, getUpdateProgress } from './auto-update.js';`,
            loader: 'ts',
          }));
        },
      },
    ],
  });
  const agent = await import(pathToFileURL(bundle).href);
  agent.setQuitHandler(() => h.quitCount++);
  let responseData = {
    deviceId: 'test-device',
    updateTargetVersion: null,
    update: null,
    command: null,
    updateMode: 'idle',
    updateNotBefore: null,
  };
  globalThis.fetch = async (url, options) => {
    if (url.includes('/ack')) {
      h.acked.push(JSON.parse(options.body));
      return { ok: !h.ackFails, status: h.ackFails ? 503 : 200 };
    }
    if (url.includes('/update-progress')) {
      (h.progressReports ??= []).push(JSON.parse(options.body));
      return { ok: true, status: 200 };
    }
    if (url.includes('/heartbeat'))
      return { ok: true, status: 200, json: async () => ({ success: true, data: responseData }) };
    // 下载故意暂不完成：心跳必须仍然返回。
    return {
      ok: true,
      body: {
        async *[Symbol.asyncIterator]() {
          await new Promise(() => {});
        },
      },
    };
  };
  const command = (id) => ({
    id,
    deviceId: 'test-device',
    kind: 'lock',
    payload: '验证',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  });
  responseData.command = command('from-heartbeat');
  await agent.beat();
  await new Promise((resolve) => setTimeout(resolve, 20));
  check('正确解包统一响应并执行心跳里的指令、送回执行结果', () => {
    assert.equal(h.spawned.length, 1);
    assert.equal(h.acked[0].ok, true);
  });
  h.confirmed = false;
  await agent.handleCommand(command('cancel'));
  check('远控立即执行并回执，不受旧版确认选项影响', () => {
    assert.equal(h.spawned.length, 2);
    assert.equal(h.acked.at(-1).ok, true);
  });
  h.confirmed = true;
  h.spawnCode = 5;
  const failed = await agent.executeCommand('shutdown');
  check('系统命令非零退出不再谎报成功，关机保留回执时间', () => {
    assert.equal(failed.ok, false);
    assert.deepEqual(h.spawned.at(-1).args, ['/s', '/t', '5']);
  });
  h.spawnCode = 0;
  h.spawnError = true;
  const startFailed = await agent.executeCommand('restart');
  check('系统进程启动失败得到失败结果', () => assert.equal(startFailed.ok, false));
  h.spawnError = false;
  h.ackFails = true;
  await agent.handleCommand(command('retry'));
  const spawnCount = h.spawned.length;
  h.ackFails = false;
  await agent.handleCommand(command('retry'));
  check('回执失败重试时不重复执行命令', () => assert.equal(h.spawned.length, spawnCount));
  const restartedAgent = await import(`${pathToFileURL(bundle).href}?restart=1`);
  await restartedAgent.handleCommand(command('retry'));
  check('客户端重启后从磁盘恢复结果，不重复执行系统命令', () => assert.equal(h.spawned.length, spawnCount));

  h.holdSpawn = true;
  const ackCount = h.acked.length;
  const executing = agent.handleCommand(command('still-executing'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await agent.handleCommand(command('still-executing'));
  check('执行中收到重复心跳不会提前回传中间结果', () => assert.equal(h.acked.length, ackCount));
  h.holdSpawn = false;
  h.heldChild.emit('exit', 0);
  await executing;

  responseData = {
    ...responseData,
    command: null,
    updateTargetVersion: '2.0.0',
    updateMode: 'after-school',
    updateNotBefore: new Date(Date.now() + 3600000).toISOString(),
    update: {
      version: '2.0.0',
      fileName: 'test-setup.exe',
      url: '/download',
      sha256: 'a'.repeat(64),
      size: 100,
    },
  };
  await Promise.race([
    agent.beat(),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('下载阻塞了心跳')), 1000);
      timer.unref();
    }),
  ]);
  check('慢速下载不阻塞心跳', () => assert.equal(agent.getClientAgentStatus().updateTargetVersion, '2.0.0'));
  const installer = path.join(temp, 'updates', 'test-setup.exe');
  fs.mkdirSync(path.dirname(installer), { recursive: true });
  fs.writeFileSync(installer, '模拟安装器');
  Object.assign(h.config, { pendingUpdateVersion: '2.0.0', pendingUpdateFile: installer });
  await agent.maybeInstallPendingUpdate();
  check('放学前即使窗口隐藏也不安装', () => assert.equal(h.quitCount, 0));
  agent.syncUpdatePolicy({ ...responseData, updateNotBefore: new Date(Date.now() - 60_000).toISOString() });
  h.visible = true;
  h.inClass = true;
  const beforeSchoolInstall = h.spawned.length;
  await agent.maybeInstallPendingUpdate();
  check('到达放学时间但仍在上课时继续等待', () => assert.equal(h.spawned.length, beforeSchoolInstall));
  h.inClass = false;
  h.spawnError = true;
  await agent.maybeInstallPendingUpdate();
  check('放学后无需隐藏窗口，安装助手启动失败时保留当前进程', () => {
    assert.equal(h.spawned.length, beforeSchoolInstall + 1);
    assert.equal(h.quitCount, 0);
  });
  h.spawnError = false;
  agent.syncUpdatePolicy({ ...responseData, updateTargetVersion: null });
  await agent.maybeInstallPendingUpdate();
  check('取消下发清除安装意图', () => assert.equal(h.config.pendingUpdateVersion, ''));
  check('取消下发会删除已下载的受管安装包', () => assert.equal(fs.existsSync(installer), false));
  fs.writeFileSync(installer, '模拟安装器');
  agent.syncUpdatePolicy({ ...responseData, updateMode: 'immediate' });
  Object.assign(h.config, { pendingUpdateVersion: '2.0.0', pendingUpdateFile: installer, autoUpdate: false });
  await agent.maybeInstallPendingUpdate();
  check('本机关掉自动更新时立即策略也不安装', () => assert.equal(h.quitCount, 0));
  h.config.autoUpdate = true;
  h.visible = true;
  h.inClass = true;
  await agent.maybeInstallPendingUpdate();
  check('安装助手确认就绪后提交交接，再退出旧客户端', () => {
    assert.equal(h.quitCount, 1);
    assert.equal(h.spawned.at(-1).file, 'update-helper.exe');
    assert.equal(h.spawned.at(-1).options.sha256, responseData.update.sha256);
    assert.equal(h.committed, 1);
    assert.equal(h.progressReports.at(-1).progress.stage, 'installing');
  });
  const cancelledInstall = await import(`${pathToFileURL(bundle).href}?cancel-before-ready=1`);
  cancelledInstall.setQuitHandler(() => h.quitCount++);
  cancelledInstall.syncUpdatePolicy({ ...responseData, updateMode: 'immediate' });
  h.waitHelper = true;
  const pendingInstall = cancelledInstall.maybeInstallPendingUpdate();
  while (!h.releaseHelper) await new Promise((resolve) => setTimeout(resolve, 1));
  h.config.autoUpdate = false;
  h.releaseHelper();
  await pendingInstall;
  check('等待助手就绪时关闭自动更新会取消交接，旧客户端继续运行', () => {
    assert.equal(h.quitCount, 1);
    assert.equal(h.committed, 1);
    assert.equal(h.cancelled, 1);
  });
  h.waitHelper = false;
  h.config.autoUpdate = true;
  fs.writeFileSync(
    path.join(temp, 'updates', 'install-result.json'),
    JSON.stringify({
      version: '2.0.0',
      serverUrl: h.config.serverUrl,
      username: h.config.username,
      error: '模拟安装器退出码：5',
    }),
  );
  const failedInstall = await import(`${pathToFileURL(bundle).href}?installer-failed=1`);
  const countBeforeRetry = h.spawned.length;
  const failure = failedInstall.getUpdateProgress();
  await failedInstall.maybeInstallPendingUpdate();
  check('安装助手失败后重启客户端可恢复原因并退避重试', () => {
    assert.equal(failure.stage, 'failed');
    assert.match(failure.error, /退出码：5/);
    assert.equal(h.spawned.length, countBeforeRetry);
  });
  console.log(`客户端代理回归：${passed}/${passed} 项通过`);
} finally {
  globalThis.fetch = originalFetch;
  delete globalThis.__clientAgentTest;
  fs.rmSync(temp, { recursive: true, force: true });
}
