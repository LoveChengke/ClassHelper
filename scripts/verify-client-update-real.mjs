/** 真实更新验收：隔离数据库、班级、应用标识和安装目录，运行真实 NSIS；不使用桌面自动化。 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { buildUpdateHelper } from '../packages/desktop-client/scripts/build-update-helper.mjs';
import assert from 'node:assert/strict';
if (process.platform !== 'win32' || !process.argv.includes('--real-install'))
  throw new Error('此验收会真实安装和卸载独立测试副本，仅在 Windows 显式传 --real-install 时执行');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootVersion = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version;
const portable = process.argv.includes('--portable');
const targetVersion = process.argv.includes('--prefix-version') ? `v${rootVersion}` : rootVersion;
const session = path.join(repo, '.cache/client-update-real');
const runDir = path.join(
  session,
  (process.argv.includes('--unicode-paths') ? '升级 验证-' : 'run-') +
    new Date().toISOString().replace(/[:.]/g, '-'),
);
fs.mkdirSync(runDir, { recursive: true });
fs.writeFileSync(path.join(session, 'latest-run.txt'), runDir);
const id = crypto.randomBytes(5).toString('hex');
const name = 'ClassHelperUpdateProbe' + id;
const appId = 'com.classhelper.updateprobe.' + id;
const installDir = path.join(runDir, 'installed');
const profile = path.join(runDir, 'profile');
const serverDir = path.join(runDir, 'server');
const traceFile = path.join(runDir, 'http-trace.jsonl');
const bootFile = path.join(runDir, 'boots.jsonl');
const [major, minor, patch] = rootVersion.split('-')[0].split('.').map(Number);
const previousVersion =
  patch > 0 ? `${major}.${minor}.${patch - 1}` : minor > 0 ? `${major}.${minor - 1}.0` : `${major - 1}.0.0`;
const versions = [previousVersion, rootVersion];
const report = {
  runDir,
  appId,
  executableName: name,
  versions,
  portable,
  targetVersion,
  startedAt: new Date().toISOString(),
  checks: [],
  result: 'RUNNING',
  fixtureDifferences: [
    '独立测试应用标识和安装目录',
    '仅改变测试包版本，仓库版本不变',
    '启动壳仅隐藏窗口并记录进程身份',
    '不创建快捷方式',
  ],
  sourceHashes: {},
};
const writeReport = () => fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2));
const log = (s) => {
  console.log(new Date().toISOString() + ' ' + s);
  fs.appendFileSync(path.join(runDir, 'runner.log'), new Date().toISOString() + ' ' + s + '\n');
};
const check = (label, detail = {}) => {
  report.checks.push({ label, at: new Date().toISOString(), ...detail });
  writeReport();
  log('PASS ' + label);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function within(p) {
  const rel = path.relative(runDir, path.resolve(p));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Unsafe fixture path: ' + p);
  return p;
}
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function childRun(exe, args, file, env = process.env, cwd = repo, timeout = 300000) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(path.join(runDir, file), { flags: 'a' });
    const child = spawn(exe, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.pipe(out, { end: false });
    child.stderr?.pipe(out, { end: false });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(file + ' timed out'));
    }, timeout);
    child.once('error', (e) => {
      clearTimeout(timer);
      out.end();
      reject(e);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      out.end();
      if (code === 0) resolve();
      else reject(new Error(file + ' exited ' + code));
    });
  });
}
async function waitFor(label, fn, timeout = 90000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (e) {
      last = e;
    }
    await sleep(500);
  }
  throw new Error('Timeout: ' + label + (last ? ' (' + last.message + ')' : ''));
}
const readLines = (file) => {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((x) => JSON.parse(x));
  } catch {
    return [];
  }
};
const clientRequire = createRequire(path.join(repo, 'packages/desktop-client/package.json'));
const builderRequire = createRequire(clientRequire.resolve('electron-builder'));
const asarRequire = createRequire(builderRequire.resolve('app-builder-lib'));
const asar = asarRequire('@electron/asar');
const { build: esbuild } = clientRequire('esbuild');
const electronDist = path.dirname(clientRequire('electron'));
const buildEnv = {
  ...process.env,
  ELECTRON_BUILDER_CACHE: path.join(repo, '.cache/electron-builder'),
  ELECTRON_CACHE: path.join(repo, '.cache/electron'),
  CSC_IDENTITY_AUTO_DISCOVERY: 'false',
  TEMP: path.join(runDir, 'tmp'),
  TMP: path.join(runDir, 'tmp'),
};
function cachedTool(prefix, required) {
  const cache = buildEnv.ELECTRON_BUILDER_CACHE;
  if (!fs.existsSync(cache)) throw new Error('缺少 NSIS 工具缓存，请先完成一次客户端构建');
  for (const entry of fs.readdirSync(cache, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const base = path.join(cache, entry.name);
    for (const child of fs.readdirSync(base, { withFileTypes: true })) {
      if (!child.isDirectory() || child.name.endsWith('.tmp')) continue;
      const candidate = path.join(base, child.name);
      if (required.every((file) => fs.existsSync(path.join(candidate, file)))) return candidate;
    }
  }
  throw new Error('缺少完整 NSIS 构建工具缓存，请先完成一次客户端构建');
}
buildEnv.ELECTRON_BUILDER_NSIS_DIR ??= cachedTool('nsis-', ['elevate.exe', 'Bin/makensis.exe']);
buildEnv.ELECTRON_BUILDER_NSIS_RESOURCES_DIR ??= cachedTool('nsis-resources-', ['plugins']);
for (const key of [
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_SMOKE_TEST',
  'ELECTRON_SMOKE_MODE',
  'VITE_DEV_SERVER_URL',
])
  delete buildEnv[key];
fs.mkdirSync(buildEnv.TEMP, { recursive: true });
const serverEnv = {
  ...buildEnv,
  NODE_ENV: 'test',
  DATABASE_PROVIDER: 'sqlite',
  DATABASE_URL: 'file:' + path.join(runDir, 'test.db').replaceAll('\\', '/'),
  JWT_SECRET: crypto.randomBytes(36).toString('hex'),
  BCRYPT_ROUNDS: '4',
  RATE_LIMIT_ENABLED: 'false',
  LOG_LEVEL: 'warn',
  TERM_START_DATE: '2026-09-07',
  WEB_DIST_DIR: path.join(repo, 'packages/web-admin/dist'),
};
let server, initialClient, adminToken, base, uninstaller;
const credentials = {
  username: 'probe_' + id,
  password: crypto.randomBytes(18).toString('hex'),
  code: ('UP' + id).toUpperCase(),
  classPassword: crypto.randomBytes(18).toString('hex'),
};
const deviceKey = crypto.randomUUID();
async function api(endpoint, { method = 'GET', body, token = adminToken } = {}) {
  const response = await fetch(base + '/api' + endpoint, {
    method,
    headers: {
      ...(token ? { authorization: 'Bearer ' + token } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10000),
  });
  const data = await response.json();
  if (!response.ok || !data.success)
    throw new Error(endpoint + ' HTTP ' + response.status + ': ' + JSON.stringify(data));
  return data.data;
}
async function stopClient() {
  try {
    const { port } = JSON.parse(fs.readFileSync(path.join(profile, 'probe-control.json'), 'utf8'));
    await fetch('http://127.0.0.1:' + port + '/quit', { method: 'POST', signal: AbortSignal.timeout(2000) });
  } catch {}
}
try {
  log('测试目录：' + runDir);
  writeReport();
  for (const file of [
    'src/main/auto-update.ts',
    'src/main/update-installer.ts',
    'native/update-helper.cs',
    'src/main/client-agent.ts',
    'src/main/index.ts',
    'src/main/update.ts',
  ])
    report.sourceHashes[file] = sha(path.join(repo, 'packages/desktop-client', file));
  fs.mkdirSync(serverDir, { recursive: true });
  fs.cpSync(path.join(repo, 'packages/server/src'), path.join(serverDir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(serverDir, 'prisma'), { recursive: true });
  fs.cpSync(path.join(repo, 'packages/server/prisma/migrations'), path.join(serverDir, 'prisma/migrations'), {
    recursive: true,
  });
  fs.copyFileSync(
    path.join(repo, 'packages/server/prisma/schema.prisma'),
    path.join(serverDir, 'prisma/schema.prisma'),
  );
  fs.writeFileSync(path.join(serverDir, 'package.json'), JSON.stringify({ type: 'module' }));
  if (!fs.existsSync(path.join(serverDir, 'node_modules')))
    fs.symlinkSync(
      path.join(repo, 'packages/server/node_modules'),
      path.join(serverDir, 'node_modules'),
      'junction',
    );
  const serverRequire = createRequire(path.join(repo, 'packages/server/package.json'));
  const initDb = serverRequire('@libsql/client').createClient({ url: serverEnv.DATABASE_URL });
  await initDb.execute('PRAGMA user_version=0');
  initDb.close();
  await childRun(
    process.execPath,
    [
      path.join(repo, 'packages/server/node_modules/prisma/build/index.js'),
      'migrate',
      'deploy',
      '--config',
      path.join(repo, 'packages/server/prisma.config.ts'),
    ],
    'migrate.log',
    serverEnv,
  );
  fs.writeFileSync(path.join(runDir, 'credentials.json'), JSON.stringify(credentials));
  const seedCode = `import fs from 'node:fs'; import {prisma} from './src/lib/db.js'; import {hashPassword} from './src/lib/password.js'; const c=JSON.parse(fs.readFileSync(${JSON.stringify(path.join(runDir, 'credentials.json'))},'utf8')); await prisma.class.deleteMany({where:{code:c.code}}); await prisma.user.deleteMany({where:{username:c.username}}); await prisma.user.create({data:{username:c.username,passwordHash:await hashPassword(c.password),name:'更新验证管理员',role:'ADMIN'}}); const cls=await prisma.class.create({data:{name:'更新验证临时班级',grade:'高一',code:c.code,passwordHash:await hashPassword(c.classPassword)}}); fs.writeFileSync(${JSON.stringify(path.join(runDir, 'class.json'))},JSON.stringify({id:cls.id})); await prisma.$disconnect();`;
  fs.writeFileSync(path.join(serverDir, 'seed.mts'), seedCode);
  await childRun(
    process.execPath,
    [
      '--import',
      pathToFileURL(path.join(repo, 'packages/server/node_modules/tsx/dist/loader.mjs')).href,
      path.join(serverDir, 'seed.mts'),
    ],
    'seed.log',
    serverEnv,
  );
  const listener = net.createServer();
  await new Promise((r) => listener.listen(0, '127.0.0.1', r));
  const port = listener.address().port;
  await new Promise((r) => listener.close(r));
  base = 'http://127.0.0.1:' + port;
  serverEnv.PORT = String(port);
  report.base = base;
  const serverCode = `import fs from 'node:fs'; import {createServer} from 'node:http'; import {createApp} from './src/app.js'; import {initRealtime} from './src/realtime/socket.js'; const app=createApp(); const originalFetch=globalThis.fetch; globalThis.fetch=(u,i)=>{const url=new URL(typeof u==='string'?u:u.url??u);if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))return Promise.reject(new Error('Probe blocks external requests'));return originalFetch(u,i)}; const server=createServer((req,res)=>{const requestUrl=req.url;let chunks=[]; if(requestUrl?.includes('/clients/'))req.on('data',c=>chunks.push(c));res.on('finish',()=>{const item={at:new Date().toISOString(),method:req.method,url:requestUrl,status:res.statusCode,length:res.getHeader('content-length')};try{const b=JSON.parse(Buffer.concat(chunks).toString());item.deviceKey=b.deviceKey;item.clientVersion=b.clientVersion;item.progress=b.progress??b.updateProgress;}catch{} if(requestUrl?.includes('/clients/')||requestUrl?.includes('/update/'))fs.appendFileSync(${JSON.stringify(traceFile)},JSON.stringify(item)+'\\n')});app(req,res)});initRealtime(server);server.listen(${port},'127.0.0.1',()=>console.log('PROBE_READY'));`;
  fs.writeFileSync(path.join(serverDir, 'probe.mts'), serverCode);
  server = spawn(
    process.execPath,
    [
      '--import',
      pathToFileURL(path.join(repo, 'packages/server/node_modules/tsx/dist/loader.mjs')).href,
      path.join(serverDir, 'probe.mts'),
    ],
    { cwd: serverDir, env: serverEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const serverLog = fs.createWriteStream(path.join(runDir, 'server.log'));
  server.stdout.pipe(serverLog);
  server.stderr.pipe(serverLog);
  await waitFor(
    'isolated server ready',
    async () => (await fetch(base + '/healthz', { signal: AbortSignal.timeout(1500) })).ok,
  );
  adminToken = (
    await api('/auth/login', {
      method: 'POST',
      body: { username: credentials.username, password: credentials.password },
      token: null,
    })
  ).token;
  const classToken = (
    await api('/auth/class-login', {
      method: 'POST',
      body: { code: credentials.code, password: credentials.classPassword },
      token: null,
    })
  ).token;
  assert.ok(adminToken && classToken);
  check('真实服务端与临时班级登录成功');
  const template = path.join(runDir, 'client-template');
  fs.mkdirSync(path.join(template, 'dist/main'), { recursive: true });
  await childRun(
    process.execPath,
    [
      path.join(repo, 'packages/desktop-client/node_modules/vite/bin/vite.js'),
      'build',
      '--config',
      path.join(repo, 'packages/desktop-client/vite.config.mts'),
      '--outDir',
      path.join(template, 'dist/renderer'),
    ],
    'renderer-build.log',
    buildEnv,
    path.join(repo, 'packages/desktop-client'),
  );
  buildUpdateHelper(path.join(template, 'dist/main/update-helper.exe'));
  const buildCommon = {
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    sourcemap: false,
    external: ['electron'],
    logLevel: 'warning',
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  };
  for (const [src, dst] of [
    ['src/main/index.ts', 'dist/main/index.js'],
    ['src/preload/index.ts', 'dist/preload/index.js'],
    ['src/preload/island.ts', 'dist/preload/island.js'],
  ])
    await esbuild({
      ...buildCommon,
      entryPoints: [path.join(repo, 'packages/desktop-client', src)],
      outfile: path.join(template, dst),
    });
  const bootstrap = `const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),{app}=require('electron');const profile=${JSON.stringify(profile)};fs.mkdirSync(profile,{recursive:true});app.setPath('userData',profile);app.setPath('logs',path.join(profile,'logs'));process.argv.push('--hidden');const fetchOriginal=globalThis.fetch;globalThis.fetch=(u,i)=>{const v=new URL(typeof u==='string'?u:u.url??u);if(!['127.0.0.1','localhost','[::1]'].includes(v.hostname))return Promise.reject(new Error('Probe blocks external requests'));return fetchOriginal(u,i)};const add=(x)=>fs.appendFileSync(${JSON.stringify(bootFile)},JSON.stringify({at:new Date().toISOString(),...x})+'\\n');add({event:'boot',pid:process.pid,version:app.getVersion(),exe:process.execPath,packaged:app.isPackaged,smoke:process.env.ELECTRON_SMOKE_TEST==='1'});app.on('browser-window-created',(_e,w)=>{w.on('show',()=>w.hide());w.webContents.on('did-finish-load',()=>add({event:'renderer-ready',pid:process.pid,version:app.getVersion()}));});app.on('will-quit',()=>add({event:'quit',pid:process.pid,version:app.getVersion()}));const ctl=http.createServer((q,s)=>{if(q.url==='/quit'&&q.method==='POST'){s.end('ok');setTimeout(()=>app.quit(),100)}else{s.statusCode=404;s.end()}});ctl.listen(0,'127.0.0.1',()=>fs.writeFileSync(path.join(profile,'probe-control.json'),JSON.stringify({port:ctl.address().port,pid:process.pid})));ctl.unref();require('./dist/main/index.js');`;
  fs.writeFileSync(path.join(template, 'probe-bootstrap.cjs'), bootstrap);
  const builderCli = path.join(
    path.dirname(clientRequire.resolve('electron-builder/package.json')),
    'out/cli/cli.js',
  );
  const setups = [];
  for (const version of versions) {
    log('构建真实 NSIS 安装包 ' + version);
    const project = path.join(runDir, 'app-' + version);
    fs.cpSync(template, project, { recursive: true });
    fs.writeFileSync(
      path.join(project, 'package.json'),
      JSON.stringify({
        name: 'classhelper-update-probe-' + id,
        version,
        description: '隔离更新验证',
        author: 'ClassHelper',
        main: 'probe-bootstrap.cjs',
        private: true,
      }),
    );
    const output = path.join(runDir, 'build-' + version);
    const config = {
      appId,
      productName: name,
      executableName: name,
      directories: { app: project, output, buildResources: path.join(repo, 'packages/desktop-client/build') },
      files: ['dist/**/*', 'probe-bootstrap.cjs', 'package.json', '!node_modules/**/*'],
      asar: true,
      npmRebuild: false,
      compression: 'normal',
      electronLanguages: ['zh-CN'],
      electronDist,
      electronVersion: JSON.parse(fs.readFileSync(clientRequire.resolve('electron/package.json'))).version,
      win: {
        target: [
          { target: 'nsis', arch: ['x64'] },
          ...(portable && version === versions[0] ? [{ target: 'portable', arch: ['x64'] }] : []),
        ],
        icon: path.join(repo, 'packages/desktop-client/build/classhelper.ico'),
      },
      nsis: {
        oneClick: false,
        perMachine: false,
        allowToChangeInstallationDirectory: true,
        createDesktopShortcut: false,
        createStartMenuShortcut: false,
        artifactName: 'ClassHelper-${version}-x64-client-setup.exe',
      },
      portable: { artifactName: 'ClassHelper-${version}-x64-client-portable.exe' },
    };
    const configFile = path.join(runDir, 'builder-' + version + '.json');
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
    await childRun(
      process.execPath,
      [builderCli, '--win', '--x64', '--publish', 'never', '--config', configFile],
      'build-' + version + '.log',
      buildEnv,
      project,
      600000,
    );
    const setup = path.join(output, 'ClassHelper-' + version + '-x64-client-setup.exe');
    assert.ok(fs.existsSync(setup));
    setups.push(setup);
  }
  report.installers = setups.map((file, i) => ({
    file,
    version: versions[i],
    size: fs.statSync(file).size,
    sha256: sha(file),
  }));
  const compiledHash = sha(path.join(template, 'dist/main/index.js'));
  for (const version of versions) {
    const archived = asar.extractFile(
      path.join(runDir, 'build-' + version, 'win-unpacked/resources/app.asar'),
      path.join('dist', 'main', 'index.js'),
    );
    assert.equal(crypto.createHash('sha256').update(archived).digest('hex'), compiledHash);
  }
  check('两份真实安装包均包含相同的当前客户端更新代码', { compiledMainSha256: compiledHash });
  const releaseDir = path.join(runDir, 'data/client-releases', targetVersion);
  fs.mkdirSync(releaseDir, { recursive: true });
  fs.copyFileSync(setups[1], path.join(releaseDir, path.basename(setups[1])));
  const release = await api('/update/client/releases', {
    method: 'POST',
    body: { version: targetVersion, fileName: path.basename(setups[1]), notes: '隔离真实安装验证' },
  });
  assert.equal(release.sha256, report.installers[1].sha256);
  check('真实 API 登记新安装包，服务端 SHA256 与构建产物一致');
  log('将旧测试版安装到 ' + installDir);
  within(installDir);
  await childRun(setups[0], ['/S', '/D=' + installDir], 'initial-install.log', buildEnv, runDir, 180000);
  const exe = path.join(installDir, name + '.exe');
  assert.ok(fs.existsSync(exe));
  uninstaller = path.join(installDir, 'Uninstall ' + name + '.exe');
  const installedVersion = () =>
    JSON.parse(asar.extractFile(path.join(installDir, 'resources/app.asar'), 'package.json').toString())
      .version;
  assert.equal(installedVersion(), versions[0]);
  check('旧测试版真实静默安装成功', { installDir });
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(
    path.join(profile, 'config.json'),
    JSON.stringify({
      serverUrl: base,
      username: credentials.code,
      token: classToken,
      tokenEncrypted: false,
      deviceKey,
      autoUpdate: true,
      autoLaunch: false,
      onboardingDone: true,
      developerMode: true,
      island: { idleSliver: false, animations: false },
      islandLayout: { layout: 'fixed' },
    }),
  );
  const clientEnv = { ...buildEnv, ELECTRON_SMOKE_PROFILE: profile };
  const launchExe = portable
    ? path.join(runDir, `build-${versions[0]}`, `ClassHelper-${versions[0]}-x64-client-portable.exe`)
    : exe;
  initialClient = spawn(launchExe, ['--hidden'], {
    cwd: installDir,
    env: clientEnv,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const clientLog = fs.createWriteStream(path.join(runDir, 'client-console.log'));
  initialClient.stdout.pipe(clientLog);
  initialClient.stderr.pipe(clientLog);
  const device = await waitFor(
    'old client heartbeat',
    async () =>
      (await api('/clients/devices')).find(
        (d) => d.deviceKey === deviceKey && d.clientVersion === versions[0],
      ),
    90000,
  );
  const oldBoot = readLines(bootFile).find((b) => b.event === 'boot' && b.version === versions[0]);
  assert.ok(oldBoot?.packaged && !oldBoot.smoke);
  check('旧版打包客户端真实启动并向服务端上报', {
    pid: oldBoot.pid,
    deviceId: device.id,
    version: device.clientVersion,
  });
  const pushed = await api('/clients/updates', {
    method: 'POST',
    body: { deviceIds: [device.id], version: targetVersion, mode: 'immediate' },
  });
  report.pushResult = pushed;
  check('真实 API 向指定测试设备下发更新');
  let lastStatus = '';
  const upgraded = await waitFor(
    'new version heartbeat and completed receipt',
    async () => {
      const d = (await api('/clients/devices')).find((x) => x.deviceKey === deviceKey);
      const progress =
        typeof d?.updateProgress === 'string'
          ? (() => {
              try {
                return JSON.parse(d.updateProgress);
              } catch {
                return null;
              }
            })()
          : d?.updateProgress;
      const status = JSON.stringify({
        version: d?.clientVersion,
        stage: progress?.stage,
        error: progress?.error,
      });
      if (status !== lastStatus) {
        lastStatus = status;
        log('设备状态 ' + status);
      }
      if (d?.clientVersion === versions[1] && progress?.stage === 'completed') return d;
      return false;
    },
    180000,
  );
  const traces = readLines(traceFile);
  const downloads = traces.filter((t) => t.url?.includes('/update/client/download/') && t.status === 200);
  assert.ok(downloads.length);
  assert.equal(Number(downloads.at(-1).length), report.installers[1].size);
  const cached = path.join(profile, 'updates', path.basename(setups[1]));
  if (fs.existsSync(cached)) assert.equal(sha(cached), report.installers[1].sha256);
  check('客户端通过真实下载接口收完整安装包并校验', {
    downloads: downloads.map((t) => ({ at: t.at, length: t.length, status: t.status })),
  });
  const boots = readLines(bootFile);
  const newBoot = boots.find((b) => b.event === 'boot' && b.version === versions[1]);
  assert.ok(newBoot?.packaged && !newBoot.smoke && newBoot.pid !== oldBoot.pid);
  assert.equal(path.resolve(newBoot.exe).toLowerCase(), path.resolve(exe).toLowerCase());
  assert.equal(installedVersion(), versions[1]);
  assert.ok(boots.some((b) => b.event === 'quit' && b.pid === oldBoot.pid));
  check('旧进程退出，真实安装器覆盖原目录，新版自动启动', {
    oldPid: oldBoot.pid,
    newPid: newBoot.pid,
    exe: newBoot.exe,
    installedVersion: installedVersion(),
  });
  await waitFor(
    'new renderer loaded',
    () => readLines(bootFile).some((b) => b.event === 'renderer-ready' && b.pid === newBoot.pid),
    15000,
  );
  check('新版界面资源加载成功，服务端确认升级完成', {
    clientVersion: upgraded.clientVersion,
    updateProgress: upgraded.updateProgress,
  });
  report.result = 'PASS';
  assert.equal(JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version, rootVersion);
  const helperLog = fs.readFileSync(path.join(profile, 'updates/install-helper.log'), 'utf8');
  assert.match(helperLog, /安装器退出码：0/);
  report.installerHelperLog = helperLog;
} catch (error) {
  report.result = 'FAIL';
  report.error = error.stack ?? String(error);
  log('FAIL ' + error.message);
} finally {
  log('停止隔离进程并卸载测试副本');
  await stopClient();
  await sleep(2000);
  if (initialClient?.exitCode === null) {
    try {
      initialClient.kill();
    } catch {}
  }
  if (uninstaller && fs.existsSync(uninstaller)) {
    try {
      within(uninstaller);
      await childRun(uninstaller, ['/S'], 'uninstall.log', buildEnv, installDir, 120000);
      report.uninstalled = true;
    } catch (e) {
      report.cleanupError = e.message;
    }
  }
  if (server?.exitCode === null) {
    server.kill();
    await sleep(500);
  }
  for (const file of [path.join(runDir, 'credentials.json'), path.join(profile, 'config.json')])
    if (fs.existsSync(file)) {
      try {
        const config = JSON.parse(fs.readFileSync(file));
        for (const key of ['password', 'classPassword', 'token'])
          if (key in config) config[key] = '<REDACTED>';
        fs.writeFileSync(file, JSON.stringify(config, null, 2));
      } catch {}
    }
  delete serverEnv.JWT_SECRET;
  adminToken = undefined;
  report.finishedAt = new Date().toISOString();
  writeReport();
  console.log(
    JSON.stringify(
      {
        result: report.result,
        checks: report.checks.length,
        error: report.error?.split('\n')[0],
        report: path.join(runDir, 'report.json'),
        cleanup: report.uninstalled,
      },
      null,
      2,
    ),
  );
}
process.exitCode = report.result === 'PASS' ? 0 : 1;
