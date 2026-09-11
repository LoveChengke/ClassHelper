import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import * as ElementPlusIconsVue from '@element-plus/icons-vue';
import 'element-plus/dist/index.css';

import App from './App.vue';
import router from './router';
import '@/styles/index.css';

const app = createApp(App);

// 全量注册 Element Plus 图标，模板里可直接 <el-icon><Bell /></el-icon>
for (const [name, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(name, component);
}

app.use(createPinia());
app.use(router);
app.use(ElementPlus, { locale: zhCn });

app.mount('#app');

/**
 * 注册 Service Worker（仅生产构建）：
 * - 浏览器可「安装为应用」（PWA），断网时仍能打开应用外壳
 * - 不缓存 /api 与 /socket.io，保证数据实时性
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch((error) => {
      console.warn('[pwa] Service Worker 注册失败：', error);
    });
  });
}
