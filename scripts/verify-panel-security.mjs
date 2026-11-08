/** 登录保护与两端错误提示回归；仅使用本机临时 HTTP 服务与隔离依赖。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const root = path.resolve('.');
const require = createRequire(path.join(root, 'packages/server/package.json'));
const { build } = createRequire(path.join(root, 'packages/desktop-client/package.json'))('esbuild');
const express = require('express');
const temp = fs.mkdtempSync(path.join(root, '.cache/panel-security-'));
let failed = 0;
async function check(name, test) {
  try {
    await test();
    console.log(`✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`✗ ${name}: ${error.message}`);
  }
}
async function bundle(name, entry, mocks) {
  const outfile = path.join(temp, `${name}.cjs`);
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    plugins: [
      {
        name: '隔离依赖',
        setup(b) {
          b.onResolve({ filter: /.*/ }, (a) =>
            Object.hasOwn(mocks, a.path) ? { path: a.path, namespace: 'mock' } : undefined,
          );
          b.onLoad({ filter: /.*/, namespace: 'mock' }, (a) => ({ contents: mocks[a.path], loader: 'js' }));
        },
      },
    ],
  });
  return require(outfile);
}
try {
  const security = await bundle('security', 'packages/server/src/middleware/security.ts', {
    '../config/env.js': 'export const env={rateLimitEnabled:true,isProduction:false};',
    '../lib/logger.js': 'export const logger={warn(){}};',
  });
  const app = express();
  app.use(express.json());
  app.use(['/login', '/class-login'], security.loginRateLimiter());
  app.post(['/login', '/class-login'], (req, res) =>
    res.status(req.body.ok ? 200 : 401).json({ message: req.body.ok ? '登录成功' : '账号或密码错误' }),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const send = async (ok = false, route = '/login') =>
    fetch(`http://127.0.0.1:${server.address().port}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ok }),
    });
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    await check('连续失败五次后，员工与班级登录共用五分钟封禁', async () => {
      for (let i = 0; i < 5; i++)
        assert.equal((await send(false, i % 2 ? '/class-login' : '/login')).status, 401);
      now += 299_000;
      const blocked = await send(true);
      assert.equal(blocked.status, 429);
      assert.ok(Number(blocked.headers.get('retry-after')) > 0);
      now += 1001;
      assert.equal((await send(true)).status, 200);
    });
    await check('成功登录清除连续失败次数', async () => {
      for (let i = 0; i < 4; i++) assert.equal((await send()).status, 401);
      assert.equal((await send(true)).status, 200);
      for (let i = 0; i < 4; i++) assert.equal((await send()).status, 401);
      assert.equal((await send(true)).status, 200);
    });
    await check('封禁从第五次失败起完整持续五分钟', async () => {
      for (let i = 0; i < 4; i++) await send();
      now += 240_000;
      await send();
      now += 60_001;
      assert.equal((await send(true)).status, 429);
      now += 240_000;
      assert.equal((await send(true)).status, 200);
    });
  } finally {
    Date.now = realNow;
    await new Promise((r) => server.close(r));
  }
  for (const side of ['web-admin', 'desktop-client']) {
    const seen = { messages: [], expired: 0, cleared: 0 };
    globalThis.__panelSecurity = seen;
    globalThis.localStorage = { getItem: () => null, removeItem: () => seen.cleared++ };
    globalThis.window = { location: { pathname: '/login', assign: () => seen.expired++ } };
    const mod = await bundle(
      side,
      `packages/${side}/src/${side === 'web-admin' ? '' : 'renderer/'}api/http.ts`,
      {
        axios:
          'const h=globalThis.__panelSecurity; export default {create:()=>({interceptors:{request:{use(){}},response:{use(_ok,fail){h.reject=fail}}}})};',
        'element-plus':
          'const h=globalThis.__panelSecurity;export const ElMessage={error:m=>h.messages.push(m),warning:m=>h.messages.push(m)};',
        '@classhelper/shared': 'export const STORAGE_KEYS={token:"token",user:"user"};',
        '@/config': 'export const API_BASE_URL="http://127.0.0.1/api";',
        '@/composables/calendarCache': 'export function clearCalendarCache(){}',
        '@/composables/assistantRequests': 'export function allowsAiExecution(){return true}',
        '../config.js': 'export function apiBaseOf(){return ""}',
      },
    );
    mod.setUnauthorizedHandler?.(() => seen.expired++);
    await check(`${side} 密码错误直接显示接口原因，不清会话`, async () => {
      await seen
        .reject({
          config: { url: '/auth/login', method: 'post' },
          response: { status: 401, data: { message: '账号或密码错误' } },
        })
        .catch(() => {});
      assert.deepEqual(seen.messages, ['账号或密码错误']);
      assert.equal(seen.expired + seen.cleared, 0);
    });
    seen.messages = [];
    await check(`${side} 受保护接口401仍清理过期会话`, async () => {
      await seen
        .reject({
          config: { url: '/auth/me', method: 'get' },
          response: { status: 401, data: { message: '凭据过期' } },
        })
        .catch(() => {});
      assert.deepEqual(seen.messages, ['登录状态已失效，请重新登录']);
      assert.ok(seen.expired + seen.cleared > 0);
    });
  }
} finally {
  assert.equal(path.dirname(temp), path.join(root, '.cache'));
  fs.rmSync(temp, { recursive: true, force: true });
  delete globalThis.__panelSecurity;
}
if (failed) process.exitCode = 1;
