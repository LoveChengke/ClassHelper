import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import * as ElementPlusIconsVue from '@element-plus/icons-vue';
import 'element-plus/dist/index.css';

import App from './App.vue';
import router from './router/index.js';
import { registerSmokeHooks } from './cache/self-test.js';
import './styles/index.css';

const app = createApp(App);

for (const [name, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(name, component);
}

app.use(createPinia());
app.use(router);
app.use(ElementPlus, { locale: zhCn });

// 冒烟验证模式：把缓存自检钩子暴露给主进程调用（正常运行时不存在）
if (window.desktop?.smokeTest) {
  registerSmokeHooks();
}

await router.isReady();
app.mount('#app');
