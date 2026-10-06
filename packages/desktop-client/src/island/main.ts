import { createApp } from 'vue';
import IslandApp from './IslandApp.vue';
import { applyMotionTokens } from '../renderer/composables/motion.js';

/**
 * 灵动岛渲染进程入口。
 * 刻意不引入 Element Plus 等 UI 库：这个窗口极小、常驻桌面，
 * 保持零依赖可以让它在低配机器上也瞬间渲染。
 */
const app = createApp(IslandApp);

/**
 * 动效令牌（beUI 的缓动曲线，见 packages/shared/src/motion.ts）写进 `:root`。
 *
 * **必须在这里也注入一次**：灵动岛是**另一个渲染进程**，不共享主窗口的 `:root`。
 * 而 `IslandApp.vue` 的悬停微交互引用了 `var(--ch-dur-fast)` / `var(--ch-ease-out)`——
 * 变量缺席会让整条 `transition` 简写失效（自定义属性解析不出来 → 声明作废），
 * 结果是**完全没有过渡**，比改造前还差。
 *
 * 成本可控：多出来的是共享模块里的令牌常量与弹簧积分（约 2KB），
 * 相比岛内已经打包的 Vue 可以忽略；换来的是"两端一岛同一套曲线、不各抄一份"。
 */
applyMotionTokens();

app.config.errorHandler = (error) => {
  console.error('[island] 渲染异常', error);
};

app.mount('#app');
