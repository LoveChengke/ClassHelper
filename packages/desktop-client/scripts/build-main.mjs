/**
 * 主进程 / preload 构建：esbuild 打包为 CommonJS。
 * - external: electron（由 Electron 运行时提供）
 * - @classhelper/shared 会被内联打包（ESM 源码 -> CJS 产物）
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: false,
  external: ['electron'],
  logLevel: 'warning',
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
};

await build({
  ...shared,
  entryPoints: [path.join(root, 'src/main/index.ts')],
  outfile: path.join(root, 'dist/main/index.js'),
});

await build({
  ...shared,
  entryPoints: [path.join(root, 'src/preload/index.ts')],
  outfile: path.join(root, 'dist/preload/index.js'),
});

console.log('[build:main] dist/main/index.js 与 dist/preload/index.js 构建完成');
