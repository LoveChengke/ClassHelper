import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../packages/web-admin/public/sw.js', import.meta.url), 'utf8');
const registry = fs.readFileSync(
  new URL('../packages/web-admin/src/element-plus.ts', import.meta.url),
  'utf8',
);
function verifyComponentRegistry(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = new URL(item.name + (item.isDirectory() ? '/' : ''), dir);
    if (item.isDirectory()) verifyComponentRegistry(file);
    else if (item.name.endsWith('.vue')) {
      for (const [, tag] of fs.readFileSync(file, 'utf8').matchAll(/<(el-[a-z0-9-]+)\b/g)) {
        const name = tag
          .split('-')
          .map((word) => word[0].toUpperCase() + word.slice(1))
          .join('');
        assert(registry.includes(name), `${file.pathname} 的 ${tag} 未注册`);
      }
    }
  }
}
verifyComponentRegistry(new URL('../packages/web-admin/src/', import.meta.url));
console.log('组件注册表覆盖全部模板标签');
let passed = 0;
let failed = 0;
async function check(name, test) {
  const handlers = new Map();
  const writes = [];
  const deleted = [];
  const context = {
    URL,
    Response,
    self: {
      location: { origin: 'https://audit.invalid' },
      addEventListener: (name, fn) => handlers.set(name, fn),
      clients: { claim: async () => {} },
      skipWaiting: async () => {},
    },
    caches: {
      open: async () => ({
        addAll: async () => {},
        put: async (key) => {
          writes.push(key);
        },
      }),
      keys: async () => ['classhelper-admin-v1', 'unrelated-app-cache'],
      delete: async (key) => {
        deleted.push(key);
      },
      match: async () => undefined,
    },
    fetch: async () => new Response('应用外壳', { headers: { 'content-type': 'text/html' } }),
  };
  vm.runInNewContext(source, context);
  async function fire(name, request) {
    const tasks = [];
    let response;
    handlers.get(name)({
      request,
      waitUntil: (task) => tasks.push(task),
      respondWith: (task) => {
        response = task;
      },
    });
    const result = response ? await response : undefined;
    await Promise.all(tasks);
    await new Promise((resolve) => setImmediate(resolve));
    return result;
  }
  try {
    await test({ context, writes, deleted, fire });
    console.log(`通过 ${++passed}：${name}`);
  } catch (error) {
    failed++;
    console.error(`失败：${name}：${error.message}`);
  }
}
const navigate = (pathname) => ({ method: 'GET', mode: 'navigate', url: 'https://audit.invalid' + pathname });
await check('错误导航响应不覆盖离线外壳', async ({ context, writes, fire }) => {
  context.fetch = async () =>
    new Response('失败页面', { status: 500, headers: { 'content-type': 'text/html' } });
  assert.equal((await fire('fetch', navigate('/dashboard'))).status, 500);
  assert.deepEqual(writes, []);
});
await check('非HTML导航不覆盖离线外壳', async ({ context, writes, fire }) => {
  context.fetch = async () => new Response('{}', { headers: { 'content-type': 'application/json' } });
  await fire('fetch', navigate('/download'));
  assert.deepEqual(writes, []);
});
await check('API与实时根路径及子路径全部透传', async ({ fire }) => {
  for (const pathname of ['/api', '/api/health', '/socket.io', '/socket.io/'])
    assert.equal(await fire('fetch', navigate(pathname)), undefined);
});
await check('只清理本应用的旧缓存', async ({ deleted, fire }) => {
  await fire('activate');
  assert.deepEqual(deleted, ['classhelper-admin-v1']);
});
await check('有效HTML仍更新外壳并支持离线回退', async ({ context, writes, fire }) => {
  assert.equal((await fire('fetch', navigate('/dashboard'))).status, 200);
  assert.deepEqual(writes, ['/index.html']);
  context.fetch = async () => {
    throw new Error('离线夹具');
  };
  context.caches.match = async () => new Response('已缓存外壳');
  assert.equal(await (await fire('fetch', navigate('/dashboard'))).text(), '已缓存外壳');
});
console.log(`Web Worker 专项：${passed} 通过，${failed} 失败`);
if (failed) process.exitCode = 1;
