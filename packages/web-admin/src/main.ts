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
