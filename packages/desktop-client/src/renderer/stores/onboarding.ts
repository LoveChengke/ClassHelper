import { ref } from 'vue';
import { defineStore } from 'pinia';

/**
 * 初次启动引导的显示状态。
 *
 * 首次启动由 App.vue 按「配置里是否记过 onboardingDone」自动弹出；
 * 登录页与设置页的「使用引导」入口调用 open() 随时重看。
 * 单独一个 store 而不是组件内部 ref：触发入口（登录页 / 设置页）与
 * 渲染点（App.vue 顶层）分处两棵互不相干的子树。
 */
export const useOnboardingStore = defineStore('onboarding', () => {
  const visible = ref(false);

  function open(): void {
    visible.value = true;
  }

  function close(): void {
    visible.value = false;
  }

  return { visible, open, close };
});
