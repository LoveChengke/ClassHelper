/** 课件验收始终使用临时库和临时文件目录，不访问正在使用的班级。 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, '.cache', 'v14-verification', `courseware-${process.pid}-${Date.now()}`);
fs.mkdirSync(dir, { recursive: true });
const env = {
  ...process.env,
  DATABASE_PROVIDER: 'sqlite',
  DATABASE_URL: `file:${path.join(dir, 'test.db').replaceAll('\\', '/')}`,
  COURSEWARE_DIR: path.join(dir, 'files'),
  TZ: 'Asia/Shanghai',
  RATE_LIMIT_ENABLED: 'false',
  LOG_LEVEL: 'warn',
};
const require = createRequire(path.join(root, 'packages/server/package.json'));
const { createClient } = require('@libsql/client');
const db = createClient({ url: env.DATABASE_URL });
await db.execute('PRAGMA user_version=0');
db.close();
async function run(args) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`课件验收失败：${code}`))));
  });
}
await run([
  'packages/server/node_modules/prisma/build/index.js',
  'migrate',
  'deploy',
  '--config',
  'packages/server/prisma.config.ts',
]);
await run([
  '--import',
  './packages/server/node_modules/tsx/dist/loader.mjs',
  'packages/server/scripts/verify-courseware.ts',
]);
console.log(`隔离验收留档：${dir}`);
