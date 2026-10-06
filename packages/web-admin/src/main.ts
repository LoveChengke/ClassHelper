import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import 'element-plus/dist/index.css';
// 深色主题：html.dark 下的 --el-* 变量（品牌侧的语义色覆盖在 styles/index.css 的 html.dark 块）
import 'element-plus/theme-chalk/dark/css-vars.css';

import App from './App.vue';
import router from './router';
import { registerAppIcons } from './icons';
import { applyMotionTokens } from './composables/motion';
import { useUiStore } from './stores/ui';
import '@/styles/index.css';

const app = createApp(App);
const pinia = createPinia();

// 按需注册图标（见 icons.ts：只注册用到的那些，而不是全量 293 个）
registerAppIcons(app);

app.use(pinia);
app.use(router);
app.use(ElementPlus, { locale: zhCn });

/**
 * 全局错误处理。
 *
 * Element Plus 的 ElMessageBox 用 **rejection** 表达"用户取消"（reason 为 'cancel' / 'close'），
 * 而调用点普遍写成 `await ElMessageBox.confirm(...)`，于是每次点「取消」都会以
 * `Uncaught (in promise) cancel` 冒到控制台。这类噪音会淹没真正的异常（排查线上问题时最要命），
 * 因此在统一入口吞掉它；其余错误照常记录，行为不变。
 */
app.config.errorHandler = (error, _instance, info) => {
  if (error === 'cancel' || error === 'close') return;
  console.error(`[web-admin] 未处理的异常（${info}）`, error);
};

/**
 * 动效令牌（beUI 那套缓动与弹簧，见 packages/shared/src/motion.ts）写进 :root。
 * 必须在 mount 之前：CSS 里引用的 `var(--ch-spring-*)` 要在首帧之前就已就位，
 * 否则第一帧会按"变量不存在"渲染一遍（表现为入场动画闪一下）。
 */
applyMotionTokens();

/**
 * 主题也要在 mount **之前**落好：深色用户首帧才不会看到"先白后黑"闪一下。
 * 顺序放在动效令牌之后没有讲究，两者互不相干 —— 但都要早于 mount。
 */
useUiStore(pinia).init();

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
