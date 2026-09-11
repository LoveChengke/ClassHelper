import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const BACKEND_ORIGIN = process.env.CLASSHELPER_BACKEND ?? 'http://127.0.0.1:4000';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    // 开发期把 /api 与 /socket.io 代理到后端，避免跨域配置
    proxy: {
      '/api': { target: BACKEND_ORIGIN, changeOrigin: true },
      '/socket.io': { target: BACKEND_ORIGIN, changeOrigin: true, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
  },
});
