import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, '.cache', 'ai-verification', `run-${process.pid}-${Date.now()}`);
fs.mkdirSync(dir, { recursive: true });
const env = {
  ...process.env,
  NODE_ENV: 'test',
  DATABASE_PROVIDER: 'sqlite',
  DATABASE_URL: `file:${path.join(dir, 'test.db').replaceAll('\\', '/')}`,
  JWT_SECRET: 'ai-isolated-verification-secret-2026',
  TZ: 'Asia/Shanghai',
  RATE_LIMIT_ENABLED: 'false',
  LOG_LEVEL: 'warn',
  COURSEWARE_DIR: path.join(dir, 'courseware'),
  AI_CACHE_SERVER_ROOT: path.join(dir, 'server'),
};
const require = createRequire(path.join(root, 'packages/server/package.json'));
const db = require('@libsql/client').createClient({ url: env.DATABASE_URL });
await db.execute('PRAGMA user_version=0');
db.close();
async function run(args) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env, windowsHide: true, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`AI 隔离验收退出：${code}`))));
  });
}
await run([
  'packages/server/node_modules/prisma/build/index.js',
  'migrate',
  'deploy',
  '--config',
  'packages/server/prisma.config.ts',
]);
await run(['packages/server/node_modules/tsx/dist/cli.mjs', 'packages/server/scripts/verify-ai.ts']);
console.log(`AI 隔离日志与数据库：${dir}`);
