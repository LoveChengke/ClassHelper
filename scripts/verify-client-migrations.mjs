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
  assert.ok(names.length > 0, '必须存在可回放的迁移');
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
  const run = (expected, targetUrl = databaseUrl) => {
    const script = `const {ensureSchema}=await import('./packages/server/src/lib/db-bootstrap.ts');
      const result=await ensureSchema(); if(result.applied!==${expected})throw new Error(JSON.stringify(result));
      const {ensureDefaultGroups}=await import('./packages/server/src/lib/permissions.ts');
      await ensureDefaultGroups();
      const {loadAuthPrincipal}=await import('./packages/server/src/lib/authz/index.ts');
      const {PERMISSION_KEYS}=await import('./packages/shared/dist/index.js');
      const admin=await loadAuthPrincipal({sub:'legacy-admin-user',role:'ADMIN',name:'测试',username:'测试',classId:null});
      if(admin.permissions.size!==PERMISSION_KEYS.length||admin.fromGroups)throw new Error('管理员不应受默认组限制');
      process.exit(0);`;
    const result = spawnSync(
      process.execPath,
      ['--import', './packages/server/node_modules/tsx/dist/loader.mjs', '--input-type=module', '-e', script],
      {
        cwd: root,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          JWT_SECRET: 'migrations-isolated-verification-secret-2026',
          DATABASE_URL: targetUrl,
          DATABASE_PROVIDER: 'sqlite',
        },
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
  // 第二个夹具模拟本次重构前已初始化的默认组和旧 mode 历史。
  const legacyUrl = `file:${path.join(dir, 'lifecycle-legacy.db').replaceAll('\\', '/')}`;
  const legacy = createClient({ url: legacyUrl });
  try {
    const split = names.indexOf('20261023000000_promotion_permission');
    assert(split > 0);
    await legacy.execute(
      'CREATE TABLE "_prisma_migrations" (migration_name TEXT, finished_at DATETIME, rolled_back_at DATETIME)',
    );
    for (const name of names.slice(0, split)) {
      await legacy.executeMultiple(fs.readFileSync(path.join(migrationRoot, name, 'migration.sql'), 'utf8'));
      await legacy.execute({
        sql: 'INSERT INTO "_prisma_migrations" VALUES (?, CURRENT_TIMESTAMP, NULL)',
        args: [name],
      });
    }
    await legacy.execute(
      `INSERT INTO "PermissionGroup" (id,name,defaultRole,scope,updatedAt) VALUES ('legacy-admin','旧管理员默认组','ADMIN','ALL',CURRENT_TIMESTAMP)`,
    );
    await legacy.execute(
      `INSERT INTO "PermissionGroupItem" (id,groupId,key) VALUES ('legacy-key','legacy-admin','roster:read')`,
    );
    await legacy.execute(
      `INSERT INTO "Student" (id,studentNo,name,updatedAt) VALUES ('legacy-student','LEGACY','旧学生',CURRENT_TIMESTAMP)`,
    );
    for (const [id, mode] of [
      ['old-single', 'single'],
      ['old-out', 'transfer-out'],
      ['old-restore', 'restore-transfer'],
    ])
      await legacy.execute({
        sql: "INSERT INTO \"StudentClassTransfer\" (id,studentId,studentNo,studentName,mode) VALUES (?,'legacy-student','LEGACY','旧学生',?)",
        args: [id, mode],
      });
    await legacy.execute(
      `INSERT INTO "User" (id,username,passwordHash,name,role,updatedAt) VALUES ('legacy-teacher','legacy-teacher','unused','旧教师','TEACHER',CURRENT_TIMESTAMP),('legacy-admin-user','legacy-admin-user','unused','旧管理员','ADMIN',CURRENT_TIMESTAMP)`,
    );
    await legacy.execute(
      `INSERT INTO "PermissionGroup" (id,name,scope,scopeValue,updatedAt) VALUES ('old-self','旧任教模板','SELF_CLASS','',CURRENT_TIMESTAMP),('old-head','旧班主任模板','SELF_CLASS','HEAD',CURRENT_TIMESTAMP)`,
    );
    await legacy.execute(
      `INSERT INTO "PermissionGroup" (id,name,defaultRole,scope,scopeValue,updatedAt) VALUES ('old-teacher-default','旧教师默认模板','TEACHER','ALL','',CURRENT_TIMESTAMP)`,
    );
    await legacy.execute(
      `INSERT INTO "UserPermissionGroup" (id,userId,groupId) VALUES ('old-self-link','legacy-teacher','old-self'),('old-head-link','legacy-teacher','old-head'),('old-admin-link','legacy-admin-user','legacy-admin')`,
    );
    legacy.close();
    run(names.length - split, legacyUrl);
    const upgraded = createClient({ url: legacyUrl });
    try {
      const keys = (
        await upgraded.execute(`SELECT key FROM "PermissionGroupItem" WHERE groupId='legacy-admin'`)
      ).rows.map((row) => row.key);
      assert(keys.includes('roster:read') && keys.includes('promotion:manage'));
      const assignments = (
        await upgraded.execute(
          `SELECT scope,scopeValue FROM "UserPermissionGroup" WHERE userId='legacy-teacher' ORDER BY scope`,
        )
      ).rows;
      assert.deepEqual(
        assignments.map((a) => [a.scope, a.scopeValue]),
        [
          ['HEAD', ''],
          ['TEACHING', ''],
        ],
      );
      assert.equal(
        (await upgraded.execute(`SELECT scope FROM "PermissionGroup" WHERE defaultRole='TEACHER'`)).rows[0]
          .scope,
        'TEACHING',
      );
      assert.equal(
        (await upgraded.execute(`SELECT scope FROM "PermissionGroup" WHERE id='old-head'`)).rows[0].scope,
        'HEAD',
      );
      assert.equal(
        (await upgraded.execute(`SELECT count(*) AS n FROM "PermissionGroup" WHERE defaultRole='ADMIN'`))
          .rows[0].n,
        1,
      );
      const kinds = (await upgraded.execute('SELECT id,kind,batchId FROM "StudentClassTransfer" ORDER BY id'))
        .rows;
      assert.deepEqual(
        kinds.map((row) => row.kind),
        ['transfer-out', 'restore', 'class-change'],
      );
      assert(kinds.every((row) => row.batchId === ''));
      assert(
        !(await upgraded.execute('PRAGMA table_info("StudentClassTransfer")')).rows.some(
          (row) => row.name === 'mode',
        ),
      );
      assert(
        (await upgraded.execute('PRAGMA table_info("ArchivedYear")')).rows.some(
          (row) => row.name === 'inactiveCount',
        ),
      );
    } finally {
      upgraded.close();
    }
    run(0, legacyUrl);
  } finally {
    legacy.close();
  }
  console.log(
    '数据库升级回归通过：保留业务课表与空权限组、默认组补升级键、旧 mode 映射 kind、旧行默认值与重启幂等。',
  );
} finally {
  client.close();
  if (
    path.dirname(path.resolve(dir)) !== path.resolve(os.tmpdir()) ||
    !path.basename(dir).startsWith('classhelper-upgrade-')
  )
    throw new Error('拒绝清理临时目录以外的路径');
  await fsp
    .rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    .catch((error) => console.error('清理临时测试库失败：', error.message));
}
