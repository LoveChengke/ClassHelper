import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

/**
 * 渲染进程构建配置（.mts 以保证 Vite 原生配置加载器按 ESM 解析）。
 *
 * 关键点：
 * 1) base: './' —— Electron 通过 file:// 加载 index.html，必须使用相对路径
 * 2) outDir: dist/renderer —— 与主进程产物 dist/main、preload 产物 dist/preload 分离
 * 3) 端口 5174（Web 管理端占用 5173），dev 时主进程读取 VITE_DEV_SERVER_URL
 */
export default defineConfig({
  base: './',
  plugins: [vue()],
  resolve: {
    alias: {
      '@renderer': fileURLToPath(new URL('./src/renderer', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
  },
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
  },
});
