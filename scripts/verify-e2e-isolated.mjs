/** 旧回归也必须隔离：临时库、带前缀的临时教师与班级，绝不回退真实实例。 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  dir = path.join(root, '.cache', 'v14-verification', `e2e-${process.pid}-${Date.now()}`);
fs.mkdirSync(dir, { recursive: true });
const env = {
  ...process.env,
  NODE_ENV: 'test',
  DATABASE_PROVIDER: 'sqlite',
  JWT_SECRET: 'e2e-isolated-verification-secret-2026',
  DATABASE_URL: `file:${path.join(dir, 'test.db').replaceAll('\\', '/')}`,
  TZ: 'Asia/Shanghai',
  RATE_LIMIT_ENABLED: 'false',
  LOG_LEVEL: 'warn',
  TERM_START_DATE: '2026-09-07',
};
const require = createRequire(path.join(root, 'packages/server/package.json')),
  { createClient } = require('@libsql/client');
const db = createClient({ url: env.DATABASE_URL });
await db.execute('PRAGMA user_version=0');
db.close();
function run(args, logName) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const log = fs.createWriteStream(path.join(dir, logName));
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (chunk) => {
        log.write(chunk);
        process.stdout.write(chunk);
      });
    child.once('error', reject);
    child.once('exit', (code) => {
      log.end();
      if (code === 0) resolve();
      else reject(new Error(`${logName} 退出码 ${code}，日志 ${dir}`));
    });
  });
}
const seedFile = path.join(root, 'packages/server/prisma', `.verification-seed-${process.pid}.ts`),
  testFile = path.join(root, 'packages/server/scripts', `.verification-e2e-${process.pid}.mjs`);
const prefix = `temporary${process.pid}_`;
function namespace(code) {
  for (const name of ['admin', 'teacher1', 'teacher2'])
    code = code.replaceAll(`'${name}'`, `'${prefix}${name}'`);
  return code;
}
let server;
try {
  await run(
    [
      'packages/server/node_modules/prisma/build/index.js',
      'migrate',
      'deploy',
      '--config',
      'packages/server/prisma.config.ts',
    ],
    'migrate.log',
  );
  fs.writeFileSync(
    seedFile,
    namespace(fs.readFileSync(path.join(root, 'packages/server/prisma/seed.ts'), 'utf8')),
    { flag: 'wx' },
  );
  await run(['packages/server/node_modules/tsx/dist/cli.mjs', seedFile], 'seed.log');
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  env.PORT = String(probe.address().port);
  await new Promise((r) => probe.close(r));
  env.VERIFY_BASE_URL = `http://127.0.0.1:${env.PORT}`;
  server = spawn(
    process.execPath,
    ['--import', './packages/server/node_modules/tsx/dist/loader.mjs', 'scripts/verification-server.mts'],
    { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const log = fs.createWriteStream(path.join(dir, 'server.log'));
  server.stdout.pipe(log);
  server.stderr.pipe(log);
  server.once('exit', (code, signal) => console.log(`临时服务退出：code=${code} signal=${signal}`));
  let ready = false;
  const startupDeadline = Date.now() + 60_000;
  while (Date.now() < startupDeadline) {
    if (server.exitCode !== null) throw new Error('临时服务启动失败');
    try {
      ready = (await fetch(`${env.VERIFY_BASE_URL}/healthz`, { signal: AbortSignal.timeout(1500) })).ok;
    } catch {
      /* 等待进程启动 */
    }
    if (ready) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!ready) throw new Error('临时服务未就绪');
  fs.writeFileSync(
    testFile,
    namespace(fs.readFileSync(path.join(root, 'packages/server/scripts/verify-e2e.mjs'), 'utf8')),
    { flag: 'wx' },
  );
  if (process.argv.includes('--web')) {
    env.UI_SMOKE_URL = env.VERIFY_BASE_URL;
    env.UI_SMOKE_ADMIN = `${prefix}admin`;
    env.UI_SMOKE_ADMIN_PASS = 'admin123';
    await run(['scripts/ui-smoke/run.mjs'], 'web.log');
  } else await run([testFile], 'e2e.log');
} finally {
  if (server && server.exitCode === null) {
    server.kill();
    await new Promise((r) => server.once('exit', r));
  }
  for (const file of [seedFile, testFile]) if (fs.existsSync(file)) fs.unlinkSync(file);
}
console.log(`隔离端到端日志：${dir}`);
