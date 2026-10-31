/** 使用实际更新路由和 Express 文件发送，聚焦隐藏路径、Range 与文件失效后的错误收尾。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, '.cache', 'update-download-tests', String(Date.now()), '.hidden');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, 'client-setup.exe');
const bytes = Buffer.alloc(4096, 0x5a);
fs.writeFileSync(file, bytes);
globalThis.__updateDownloadFixture = { file, fileName: path.basename(file) };
const clientRequire = createRequire(path.join(root, 'packages/desktop-client/package.json'));
const serverRequire = createRequire(path.join(root, 'packages/server/package.json'));
const express = serverRequire('express');
const pass = 'const pass=()=> (_req,_res,next)=>next();';
const mocks = {
  authz:
    'export const assertClassDevice=()=>{}; export const assertPermission=async()=>{}; export const classIdsFor=async()=>[];',
  auth:
    pass +
    'export const authenticate=pass,requireAnyPermission=pass,requirePermission=pass,requireAdmin=pass,requirePermissionOrClassDevice=pass; export const getAuthUser=()=>({role:"CLASS_DEVICE",sub:"fixture"}); export const hasAuthPermission=()=>false;',
  validate:
    pass +
    'export const validateBadRequest=pass;export const validatedBody=req=>req.body;export const validatedParams=req=>req.params;',
  releases:
    'export const resolveReleaseFile=async()=>globalThis.__updateDownloadFixture;export const listReleases=async()=>[];export const fetchReleaseFromGithub=async()=>null;export const registerRelease=async()=>null;export const deleteRelease=async()=>null;',
  update: 'export const checkForUpdates=async()=>null;',
  progress: 'export const getReleaseProgress=()=>({});export const setReleaseProgress=()=>{};',
};
const output = path.join(dir, 'route.cjs');
await clientRequire('esbuild').build({
  entryPoints: [path.join(root, 'packages/server/src/modules/update/update.module.ts')],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
  plugins: [
    {
      name: '隔离身份与元数据',
      setup(build) {
        build.onResolve({ filter: /^express$/ }, () => ({
          path: serverRequire.resolve('express'),
          external: true,
        }));
        const rules = [
          [/authz\/index\.js$/, 'authz'],
          [/middleware\/auth\.js$/, 'auth'],
          [/middleware\/validate\.js$/, 'validate'],
          [/client-releases\.service\.js$/, 'releases'],
          [/\/update\.service\.js$/, 'update'],
          [/release-progress\.js$/, 'progress'],
        ];
        build.onResolve({ filter: /.*/ }, (args) => {
          const rule = rules.find(([pattern]) => pattern.test(args.path));
          return rule ? { path: rule[1], namespace: 'fixture' } : undefined;
        });
        build.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
          contents: mocks[args.path],
          loader: 'js',
        }));
      },
    },
  ],
});
const { updateModule } = clientRequire(output);
const app = express();
app.use('/api/update', updateModule.router);
app.use((error, _req, res, _next) =>
  res.status(error.status ?? 500).json({ code: error.code, message: error.message }),
);
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const url = `http://127.0.0.1:${server.address().port}/api/update/client/download/fixture`;
try {
  const downloaded = await fetch(url, { signal: AbortSignal.timeout(2000) });
  assert.equal(downloaded.status, 200);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
  console.log('✓ 实际更新路由可发送隐藏目录中的安装包');
  const range = await fetch(url, { headers: { range: 'bytes=4-11' }, signal: AbortSignal.timeout(2000) });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 8);
  console.log('✓ 安装包 Range 请求保持有效');
  fs.renameSync(file, file + '.backup');
  const missing = await fetch(url, { signal: AbortSignal.timeout(2000) });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, 'NOT_FOUND');
  console.log('✓ 解析元数据后文件消失会结束错误响应，不再挂起');
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  delete globalThis.__updateDownloadFixture;
}
