import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, '.cache', 'authz-verification', `run-${process.pid}-${Date.now()}`);
fs.mkdirSync(dir, { recursive: true });
const env = {
  ...process.env,
  NODE_ENV: 'test',
  DATABASE_PROVIDER: 'sqlite',
  DATABASE_URL: `file:${path.join(dir, 'test.db').replaceAll('\\', '/')}`,
  JWT_SECRET: 'authz-isolated-verification-secret-2026',
  TZ: 'Asia/Shanghai',
  RATE_LIMIT_ENABLED: 'false',
  LOG_LEVEL: 'warn',
};
const require = createRequire(path.join(root, 'packages/server/package.json'));
const database = require('@libsql/client').createClient({ url: env.DATABASE_URL });
await database.execute('PRAGMA user_version=0');
database.close();
async function run(args) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`隔离验收失败：${code}`))));
  });
}
await run([
  'packages/server/node_modules/prisma/build/index.js',
  'migrate',
  'deploy',
  '--config',
  'packages/server/prisma.config.ts',
]);
await run(['packages/server/node_modules/tsx/dist/cli.mjs', 'packages/server/scripts/verify-authz.ts']);
console.log(`授权隔离数据库：${dir}`);
