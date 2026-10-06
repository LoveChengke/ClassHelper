<script setup lang="ts">
import { useCountUp } from '@/composables/motion';

/**
 * 统计卡片。抽成组件而不是写在 DashboardView 的 v-for 里，是因为数字滚动要用到
 * `useCountUp()` —— 它必须在 setup 阶段调用（内部有 `watch` 与 `onUnmounted`），
 * 而 v-for 里没法给每一项单独跑一遍 setup。
 *
 * 外观类名走全局样式（`styles/index.css` 的 `.stat-card` / `.stat-value`…），
 * 与仪表盘原先的写法完全一致，这里只负责"数字滚起来"。
 */
const props = defineProps<{
  label: string;
  value: number;
  hint: string;
}>();

/**
 * 数字滚动（beUI 的 number 原语）。0 → 实际值的那一跳就是它存在的意义：
 * 数据是异步来的，直接跳到终值会让人错过"这一栏有内容"这件事。
 */
const displayed = useCountUp(() => props.value);
</script>

<template>
  <div class="stat-card">
    <div class="stat-label">{{ label }}</div>
    <div class="stat-value">{{ Math.round(displayed) }}</div>
    <div class="stat-hint">{{ hint }}</div>
  </div>
</template>
