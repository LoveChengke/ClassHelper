<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import {
  COURSEWARE_CATEGORIES,
  COURSEWARE_ISLAND_SIZE,
  ISLAND_SHADOW_PAD,
  type CoursewareTransfer,
  type IslandAppearance,
} from '@classhelper/shared';
const props = defineProps<{ transfer: CoursewareTransfer; appearance: IslandAppearance }>();
const card = ref<HTMLElement>();
const style = computed(() => {
  const position = props.appearance.position;
  return {
    width: `${COURSEWARE_ISLAND_SIZE.width}px`,
    height: `${COURSEWARE_ISLAND_SIZE.height}px`,
    [position.startsWith('bottom') ? 'bottom' : 'top']: `${ISLAND_SHADOW_PAD}px`,
    ...(position.endsWith('left')
      ? { left: `${ISLAND_SHADOW_PAD}px` }
      : position.endsWith('right')
        ? { right: `${ISLAND_SHADOW_PAD}px` }
        : { left: '50%', transform: 'translateX(-50%)' }),
    '--transfer-accent': props.appearance.accent,
  };
});
const status = computed(
  () =>
    ({
      downloading: '正在接收课件',
      verifying: '正在校验文件',
      completed: '课件接收完成',
      failed: '课件接收失败',
    })[props.transfer.stage],
);
function report() {
  const rect = card.value?.getBoundingClientRect();
  if (rect) window.island?.setHitRect({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
}
watch(
  () => [props.appearance.position, props.transfer],
  () => void nextTick(report),
);
onMounted(() => {
  report();
  window.addEventListener('resize', report);
});
onUnmounted(() => window.removeEventListener('resize', report));
</script>
<template>
  <section ref="card" class="courseware-transfer" :style="style" aria-label="课件传输状态">
    <header>
      <span>{{ status }}</span>
      <strong>{{ transfer.stage === 'failed' ? '失败' : `${transfer.progress}%` }}</strong>
    </header>
    <div class="filename" :title="transfer.name">{{ transfer.name }}</div>
    <div class="metadata">
      {{ COURSEWARE_CATEGORIES[transfer.category] }} · {{ transfer.teacherName || '教师' }}
      <span>
        {{ (transfer.receivedBytes / 1048576).toFixed(1) }} /
        {{ (transfer.totalBytes / 1048576).toFixed(1) }} MB
      </span>
    </div>
    <progress :value="transfer.progress" max="100" :aria-label="`${transfer.name} 传输进度`" />
    <p v-if="transfer.error">{{ transfer.error }}</p>
  </section>
</template>
<style scoped>
.courseware-transfer {
  position: fixed;
  box-sizing: border-box;
  padding: 17px 24px;
  border-radius: 24px;
  color: white;
  background: rgba(20, 20, 24, 0.97);
  box-shadow: 0 2px 8px #0004;
  font:
    13px/1.4 'Segoe UI',
    'Microsoft YaHei',
    sans-serif;
  overflow: hidden;
  pointer-events: none;
}
header,
.metadata {
  display: flex;
  justify-content: space-between;
  gap: 10px;
}
header {
  color: #ffffffb8;
  font-size: 12px;
}
header strong {
  color: var(--transfer-accent);
}
.filename {
  font-weight: 600;
  font-size: 16px;
  margin: 5px 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.metadata {
  color: #ffffffb8;
  font-size: 12px;
}
progress {
  display: block;
  width: 100%;
  height: 5px;
  margin-top: 11px;
  border: 0;
  border-radius: 8px;
  overflow: hidden;
  accent-color: var(--transfer-accent);
}
progress::-webkit-progress-bar {
  background: #ffffff30;
}
progress::-webkit-progress-value {
  background: var(--transfer-accent);
}
p {
  margin: 3px 0;
  font-size: 11px;
  color: #ffb4ab;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
