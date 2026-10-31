/** 验证真实原生助手的就绪、取消、篡改拒绝与失败恢复；不执行 NSIS。 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildUpdateHelper } from '../packages/desktop-client/scripts/build-update-helper.mjs';

if (process.platform !== 'win32') throw new Error('原生更新助手验证仅支持 Windows');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, '.cache', 'update-installer-tests', `${Date.now()}-含空格 验证`);
fs.mkdirSync(path.join(dir, 'updates'), { recursive: true });
const clientRequire = createRequire(path.join(root, 'packages/desktop-client/package.json'));
const { build } = clientRequire('esbuild');
buildUpdateHelper(path.join(dir, 'update-helper.exe'));
await build({
  entryPoints: [path.join(root, 'packages/desktop-client/src/main/update-installer.ts')],
  outfile: path.join(dir, 'installer.cjs'),
  bundle: true,
  format: 'cjs',
  platform: 'node',
  logLevel: 'silent',
});
const { prepareUpdateInstaller } = await import(pathToFileURL(path.join(dir, 'installer.cjs')).href);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(read, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      if (read()) return;
    } catch {
      /* 等待写入 */
    }
    await sleep(50);
  }
  throw new Error('等待原生助手结果超时');
}
const installer = path.join(dir, 'updates', 'fixture.exe');
fs.writeFileSync(installer, '只验证准备与取消，不执行此文件');
const options = {
  directory: path.dirname(installer),
  installer,
  version: '2.0.0',
  sha256: crypto.createHash('sha256').update(fs.readFileSync(installer)).digest('hex'),
  size: fs.statSync(installer).size,
  serverUrl: 'http://127.0.0.1:1',
  username: 'isolated-helper-test',
  restartExe: process.execPath,
  portable: false,
};
const helper = await prepareUpdateInstaller(options);
assert.match(fs.readFileSync(path.join(dir, 'updates/install-helper.log'), 'utf8'), /校验通过/);
helper.cancel();
await waitFor(() => !fs.readdirSync(path.dirname(installer)).some((name) => name.endsWith('.ready')));
assert.doesNotMatch(fs.readFileSync(path.join(dir, 'updates/install-helper.log'), 'utf8'), /开始安装/);
console.log('✓ 真实助手就绪，取消交接后不执行安装器');

fs.appendFileSync(installer, '篡改');
await assert.rejects(prepareUpdateInstaller(options), /长度不匹配/);
assert.match(JSON.parse(fs.readFileSync(path.join(dir, 'updates/install-result.json'))).error, /长度不匹配/);
console.log('✓ 安装前再次检查文件，拒绝已被篡改的安装包并记录原因');
await assert.rejects(
  prepareUpdateInstaller({ ...options, size: fs.statSync(installer).size }),
  /SHA256 校验失败/,
);
console.log('✓ 长度合法但摘要不符的安装包也被拒绝');

const compiler = path.join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
function compile(name, code) {
  const source = path.join(dir, name + '.cs'),
    exe = path.join(dir, name + '.exe');
  fs.writeFileSync(source, code);
  execFileSync(compiler, ['/nologo', '/target:winexe', '/out:' + exe, source], {
    windowsHide: true,
    stdio: 'pipe',
  });
  return exe;
}
const failure = compile('failed-installer', 'class Fixture { static int Main() { return 37; } }');
const restoreMarker = path.join(dir, 'restored.txt');
const restore = compile(
  'restore-client',
  'using System.IO; [assembly:System.Reflection.AssemblyInformationalVersion("1.0.0")] class Fixture { static void Main() { File.WriteAllText(@"' +
    restoreMarker.replaceAll('"', '""') +
    '","restored"); } }',
);
fs.copyFileSync(failure, installer);
options.sha256 = crypto.createHash('sha256').update(fs.readFileSync(installer)).digest('hex');
options.size = fs.statSync(installer).size;
options.restartExe = restore;
const childFile = path.join(dir, 'parent.cjs');
fs.writeFileSync(
  childFile,
  `const {prepareUpdateInstaller}=require('./installer.cjs');(async()=>{const helper=await prepareUpdateInstaller(${JSON.stringify(options)});helper.commit();process.exit(0)})().catch(e=>{console.error(e);process.exit(1)});`,
);
const parent = spawn(process.execPath, [childFile], { windowsHide: true, stdio: 'inherit' });
assert.equal(await new Promise((resolve) => parent.once('exit', resolve)), 0);
await waitFor(() => fs.existsSync(restoreMarker));
const result = JSON.parse(fs.readFileSync(path.join(dir, 'updates/install-result.json')));
assert.equal(result.stage, 'failed');
assert.match(result.error, /退出码：37/);
assert.match(fs.readFileSync(path.join(dir, 'updates/install-helper.log'), 'utf8'), /旧进程已退出，开始安装/);
console.log('✓ 父进程退出后助手继续运行，非零退出被记录并恢复客户端');
const success = compile('successful-installer', 'class Fixture { static int Main() { return 0; } }');
fs.copyFileSync(success, installer);
options.sha256 = crypto.createHash('sha256').update(fs.readFileSync(installer)).digest('hex');
options.size = fs.statSync(installer).size;
options.version = 'v1.0.0';
fs.rmSync(restoreMarker);
fs.writeFileSync(
  childFile,
  `const {prepareUpdateInstaller}=require('./installer.cjs');(async()=>{const helper=await prepareUpdateInstaller(${JSON.stringify(options)});helper.commit();process.exit(0)})().catch(e=>{console.error(e);process.exit(1)});`,
);
const successfulParent = spawn(process.execPath, [childFile], { windowsHide: true, stdio: 'inherit' });
assert.equal(await new Promise((resolve) => successfulParent.once('exit', resolve)), 0);
await waitFor(() => fs.existsSync(restoreMarker));
await waitFor(
  () => JSON.parse(fs.readFileSync(path.join(dir, 'updates/install-result.json'))).stage === 'installed',
);
console.log('✓ 支持 v 前缀版本号，安装器未启动新版时由助手补启客户端');
console.log(`原生更新助手验证通过，证据目录：${dir}`);
