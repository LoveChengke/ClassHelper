import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import * as ElementPlusIconsVue from '@element-plus/icons-vue';
import 'element-plus/dist/index.css';
// 深色主题：html.dark 下的 --el-* 变量（品牌覆盖在 styles/index.css 的 html.dark 块）
import 'element-plus/theme-chalk/dark/css-vars.css';

import App from './App.vue';
import router from './router/index.js';
import { registerSmokeHooks, setSmokeTeacherCredentials } from './cache/self-test.js';
import './styles/index.css';

const app = createApp(App);

for (const [name, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(name, component);
}

app.use(createPinia());
app.use(router);
app.use(ElementPlus, { locale: zhCn });

// 冒烟验证模式：把缓存自检钩子暴露给主进程调用（正常运行时不存在）。
// 教师凭据由 preload 从环境变量透传（**不写在代码里**：渲染产物会进 app.asar 发给学生机）。
if (window.desktop?.smokeTest) {
  setSmokeTeacherCredentials({
    username: window.desktop.smokeCredentials?.username ?? '',
    password: window.desktop.smokeCredentials?.password ?? '',
  });
  registerSmokeHooks();
}

await router.isReady();
app.mount('#app');
