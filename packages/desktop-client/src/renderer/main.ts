import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import 'element-plus/dist/index.css';
// 深色主题：html.dark 下的 --el-* 变量（品牌覆盖在 styles/index.css 的 html.dark 块）
import 'element-plus/theme-chalk/dark/css-vars.css';

import App from './App.vue';
import router from './router/index.js';
import { registerAppIcons } from './icons.js';
import { applyMotionTokens } from './composables/motion.js';
import './styles/index.css';

const app = createApp(App);

// 按需注册图标（见 icons.ts：只注册用到的那些，而不是全量 293 个）
registerAppIcons(app);

app.use(createPinia());
app.use(router);
app.use(ElementPlus, { locale: zhCn });

// 冒烟验证模式：把缓存自检钩子暴露给主进程调用（正常运行时不存在）。
//
// **动态 import 是刻意的**：`cache/self-test.ts` 有 1000 多行自检代码，
// 静态 import 会把它打进渲染进程入口 chunk，每次启动都要解析一遍。改成动态 import 后
// Vite/Rollup 会把它切成独立 chunk，只在冒烟模式下才加载（`verify:desktop` /
// `verify:packaged` 的那条路径）。
//
// 教师凭据由 preload 从环境变量透传（**不写在代码里**：渲染产物会进 app.asar 发给学生机）。
if (window.desktop?.smokeTest) {
  const { registerSmokeHooks, setSmokeTeacherCredentials } = await import('./cache/self-test.js');
  setSmokeTeacherCredentials({
    username: window.desktop.smokeCredentials?.username ?? '',
    password: window.desktop.smokeCredentials?.password ?? '',
  });
  registerSmokeHooks();
}

/**
 * 动效令牌（beUI 那套缓动与弹簧，见 packages/shared/src/motion.ts）写进 :root。
 *
 * 必须在 mount 之前：CSS 里引用的 `var(--ch-spring-*)` 要在首帧之前就已就位，
 * 否则第一帧会按"变量不存在"渲染一遍（表现为入场动画闪一下）。
 * 也刻意排在主题恢复（stores/ui.ts 的 init）之前 —— 令牌与主题互不相干，
 * 但先落令牌能让首屏的入场动画从第一帧起就是对的节奏。
 *
 * ⚠️ 灵动岛是**另一个渲染进程**（src/island/main.ts），不经过这里。
 */
applyMotionTokens();

await router.isReady();
app.mount('#app');
