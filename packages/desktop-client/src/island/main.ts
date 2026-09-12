import { createApp } from 'vue';
import IslandApp from './IslandApp.vue';

/**
 * 灵动岛渲染进程入口。
 * 刻意不引入 Element Plus 等 UI 库：这个窗口极小、常驻桌面，
 * 保持零依赖可以让它在低配机器上也瞬间渲染。
 */
const app = createApp(IslandApp);

app.config.errorHandler = (error) => {
  console.error('[island] 渲染异常', error);
};

app.mount('#app');
