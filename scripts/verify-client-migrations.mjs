/** 用临时旧版 Prisma 数据库验收覆盖升级，避免回放旧 SQL 或丢失业务数据。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireServer = createRequire(path.join(root, 'packages/server/package.json'));
const { createClient } = requireServer('@libsql/client');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'classhelper-upgrade-'));
const databaseUrl = `file:${path.join(dir, 'upgrade.db').replaceAll('\\', '/')}`;
const client = createClient({ url: databaseUrl });
try {
  const migrationRoot = path.join(root, 'packages/server/prisma/migrations');
  const names = fs
    .readdirSync(migrationRoot)
    .filter((name) => fs.existsSync(path.join(migrationRoot, name, 'migration.sql')))
    .sort();
  assert.equal(names.at(-1), '20261017090000_permission_read_keys');
  const baseline = names.indexOf('20261016090000_retire_integration_and_schedule_updates');
  await client.execute(
    'CREATE TABLE "_prisma_migrations" (migration_name TEXT, finished_at DATETIME, rolled_back_at DATETIME)',
  );
  for (const name of names.slice(0, baseline)) {
    const sql = fs.readFileSync(path.join(migrationRoot, name, 'migration.sql'), 'utf8');
    await client.executeMultiple(sql);
    await client.execute({
      sql: 'INSERT INTO "_prisma_migrations" VALUES (?, CURRENT_TIMESTAMP, NULL)',
      args: [name],
    });
  }
  await client.execute(
    `INSERT INTO "User" (id,username,passwordHash,name,role,updatedAt) VALUES ('u','fixture','unused','升级测试','ADMIN',CURRENT_TIMESTAMP)`,
  );
  await client.execute(
    `INSERT INTO "Class" (id,name,grade,code,teacherId,updatedAt) VALUES ('c','升级保留班级','高一','TEST','u',CURRENT_TIMESTAMP)`,
  );
  await client.execute(`INSERT INTO "Course" (id,name,classId,teacherId) VALUES ('course','语文','c','u')`);
  await client.execute(
    `INSERT INTO "Schedule" (id,classId,courseId,dayOfWeek,startTime,endTime,source,updatedAt) VALUES ('s','c','course',1,'08:00','08:45','classisland',CURRENT_TIMESTAMP)`,
  );
  await client.execute(
    `INSERT INTO "PermissionGroup" (id,name,updatedAt) VALUES ('custom','教师默认权限',CURRENT_TIMESTAMP)`,
  );
  const run = (expected) => {
    const script = `const {ensureSchema}=await import('./packages/server/src/lib/db-bootstrap.ts');
      const result=await ensureSchema(); if(result.applied!==${expected})throw new Error(JSON.stringify(result));
      const {ensureDefaultGroups}=await import('./packages/server/src/lib/permissions.ts');
      await ensureDefaultGroups();process.exit(0);`;
    const result = spawnSync(
      process.execPath,
      ['--import', './packages/server/node_modules/tsx/dist/loader.mjs', '--input-type=module', '-e', script],
      {
        cwd: root,
        env: { ...process.env, DATABASE_URL: databaseUrl, DATABASE_PROVIDER: 'sqlite' },
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  };
  run(names.length - baseline);
  const tables = (await client.execute(`SELECT name FROM sqlite_master WHERE type='table'`)).rows.map(
    (row) => row.name,
  );
  assert.ok(!tables.includes('IntegrationDevice') && !tables.includes('ClassIslandPush'));
  assert.equal((await client.execute(`SELECT name FROM "Class" WHERE id='c'`)).rows[0].name, '升级保留班级');
  assert.equal((await client.execute(`SELECT source FROM "Schedule" WHERE id='s'`)).rows[0].source, 'manual');
  const defaults = (await client.execute(`SELECT id,name FROM "PermissionGroup" WHERE defaultRole='TEACHER'`))
    .rows;
  assert.equal(defaults.length, 1);
  assert.notEqual(defaults[0].name, '教师默认权限');
  await client.execute({ sql: 'DELETE FROM "PermissionGroupItem" WHERE groupId=?', args: [defaults[0].id] });
  run(0);
  assert.equal(
    (
      await client.execute({
        sql: 'SELECT count(*) AS n FROM "PermissionGroupItem" WHERE groupId=?',
        args: [defaults[0].id],
      })
    ).rows[0].n,
    0,
  );
  console.log(
    '数据库升级回归通过：接纳 Prisma 迁移记录、保留业务课表、移除联动、避开默认组重名、重启保留空权限组。',
  );
} finally {
  client.close();
  await fsp
    .rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    .catch((error) => console.error('清理临时测试库失败：', error.message));
}
