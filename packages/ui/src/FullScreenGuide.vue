<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { ElButton } from 'element-plus';
export interface GuideStep {
  id: string;
  title: string;
  text: string;
  example: string[];
}
const props = defineProps<{ modelValue: boolean; steps: GuideStep[]; brandLogo?: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean]; finish: [] }>();
const index = ref(0),
  root = ref<HTMLElement>();
const current = computed(() => props.steps[Math.min(index.value, props.steps.length - 1)]);
let previousFocus: HTMLElement | null = null;
function retainFocus(): void {
  if (props.modelValue && root.value && !root.value.contains(document.activeElement)) root.value.focus();
}
function finish(): void {
  emit('update:modelValue', false);
  emit('finish');
}
function next(): void {
  if (index.value >= props.steps.length - 1) finish();
  else index.value++;
}
function keydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    finish();
  }
  if (event.key === 'ArrowRight') {
    event.preventDefault();
    next();
  }
  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    index.value = Math.max(0, index.value - 1);
  }
  if (event.key === 'Tab') {
    const buttons = [...(root.value?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [])];
    const target = event.shiftKey ? buttons.at(-1) : buttons[0];
    if (
      document.activeElement === (event.shiftKey ? buttons[0] : buttons.at(-1)) ||
      document.activeElement === root.value
    ) {
      event.preventDefault();
      target?.focus();
    }
  }
  event.stopPropagation();
}
watch(
  () => props.modelValue,
  async (open) => {
    if (open) {
      index.value = 0;
      previousFocus = document.activeElement as HTMLElement;
      await nextTick();
      if (!props.modelValue || !root.value) return;
      document.addEventListener('focusin', retainFocus, true);
      window.addEventListener('focus', retainFocus);
      root.value?.focus();
    } else {
      document.removeEventListener('focusin', retainFocus, true);
      window.removeEventListener('focus', retainFocus);
      previousFocus?.focus();
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  document.removeEventListener('focusin', retainFocus, true);
  window.removeEventListener('focus', retainFocus);
  if (props.modelValue) previousFocus?.focus();
});
</script>
<template>
  <Teleport to="body">
    <section
      v-if="modelValue && current"
      ref="root"
      class="ch-guide onboarding-welcome"
      tabindex="-1"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ch-guide-title"
      @keydown="keydown"
    >
      <header class="ch-guide-header">
        <span class="ch-guide-brand">
          <img v-if="brandLogo" :src="brandLogo" alt="" />
          ClassHelper
        </span>
        <ElButton text data-action="skip" @click="finish">跳过</ElButton>
      </header>
      <main class="ch-guide-main">
        <div class="ch-guide-copy" aria-live="polite">
          <p class="ch-guide-progress">{{ index + 1 }} / {{ steps.length }}</p>
          <h1 id="ch-guide-title">{{ current.title }}</h1>
          <p>{{ current.text }}</p>
        </div>
        <div class="ch-guide-example" aria-label="功能示意">
          <span class="ch-guide-example-label">功能示意</span>
          <div v-for="(line, n) in current.example" :key="n" class="ch-guide-example-row">
            <span class="ch-guide-example-dot" />
            {{ line }}
          </div>
        </div>
      </main>
      <footer class="ch-guide-footer">
        <div class="ch-guide-track">
          <span v-for="(step, n) in steps" :key="step.id" :class="{ active: n === index }" />
        </div>
        <div>
          <ElButton data-action="prev" :disabled="index === 0" @click="index--">上一步</ElButton>
          <ElButton
            type="primary"
            :data-action="index === steps.length - 1 ? 'finish' : 'next'"
            @click="next"
          >
            {{ index === steps.length - 1 ? '开始使用' : '下一步' }}
          </ElButton>
        </div>
      </footer>
    </section>
  </Teleport>
</template>
