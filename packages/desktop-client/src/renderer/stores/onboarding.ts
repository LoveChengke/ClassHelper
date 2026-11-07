import { ref } from 'vue';
import { defineStore } from 'pinia';

/** App.vue 按引导版本自动展示；登录页和设置页可随时重看。 */
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
