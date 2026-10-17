<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import type { IslandAppearance, IslandLessonReminder } from '@classhelper/shared';

const props = defineProps<{
  reminder: IslandLessonReminder;
  now: number;
  appearance: IslandAppearance;
  motion: boolean;
}>();
const root = ref<HTMLElement>();
const width = ref(480);
const mask = computed(() => props.now < props.reminder.maskUntil);
const title = computed(
  () => ({ prepare: '即将上课', 'on-class': '上课', break: '课间休息' })[props.reminder.kind],
);
const leftSeconds = computed(() =>
  Math.max(0, Math.ceil((props.reminder.lessonStartsAt - props.now) / 1000)),
);
const progress = computed(() =>
  Math.max(
    0,
    Math.min(
      1,
      (props.reminder.endsAt - props.now) / Math.max(1, props.reminder.endsAt - props.reminder.startedAt),
    ),
  ),
);
const course = computed(() =>
  props.reminder.kind === 'break' ? props.reminder.nextCourseName : props.reminder.courseName,
);
const time = computed(() =>
  props.reminder.kind === 'break'
    ? `${props.reminder.nextStartTime || ''}–${props.reminder.nextEndTime || ''}`
    : `${props.reminder.startTime}–${props.reminder.endTime}`,
);
const regions = ref([0, 0, 0, 0, 0]);
let frame = 0;
// ClassIsland SlantedMaskControl：5 个斜切区域、30°偏移、两侧向中央打开，中央向两侧关闭。
const polygons = computed(() => {
  const offset = Math.tan(Math.PI / 6) * 40;
  const total = width.value + offset;
  const edges = [0, 0.1, 0.3, 0.7, 0.9, 1];
  return regions.value.map((p, i) => {
    const center = (total * (edges[i]! + edges[i + 1]!)) / 2;
    const half = ((total * (edges[i + 1]! - edges[i]!) + 0.5) * p) / 2;
    return `${center - half},0 ${center + half},0 ${center + half - offset},40 ${center - half - offset},40`;
  });
});
function animateMask() {
  cancelAnimationFrame(frame);
  const target = mask.value ? 1 : 0;
  if (!props.motion) {
    regions.value = [target, target, target, target, target];
    return;
  }
  const from = [...regions.value];
  const started = performance.now();
  const delays = mask.value ? [0, 90, 120, 90, 0] : [120, 90, 0, 90, 120];
  const update = (at: number) => {
    const elapsed = (at - started) * props.appearance.speed;
    regions.value = from.map((value, i) => {
      const p = Math.max(0, Math.min(1, (elapsed - delays[i]!) / 360));
      const eased = target ? 1 - (1 - p) ** 4 : p * p;
      return value + (target - value) * eased;
    });
    if (elapsed < 480) frame = requestAnimationFrame(update);
  };
  frame = requestAnimationFrame(update);
}
watch(
  [mask, () => props.reminder.id, () => props.motion, () => props.appearance.speed],
  () => {
    if (mask.value) regions.value = [0, 0, 0, 0, 0];
    animateMask();
  },
  { flush: 'post' },
);
let observer: ResizeObserver | undefined;
onMounted(() => {
  observer = new ResizeObserver(() => {
    if (root.value) width.value = root.value.offsetWidth;
  });
  if (root.value) observer.observe(root.value);
  void nextTick(animateMask);
});
onUnmounted(() => {
  observer?.disconnect();
  cancelAnimationFrame(frame);
});
</script>

<template>
  <div
    ref="root"
    class="ci-lesson"
    :class="{ 'ci-mask-active': mask }"
    :data-kind="reminder.kind"
    :style="{
      '--ci-speed': appearance.speed,
      '--ci-duration': motion ? `${200 / appearance.speed}ms` : '0ms',
      '--ci-title-duration': motion ? `${250 / appearance.speed}ms` : '0ms',
      '--ci-scale-duration': motion ? `${750 / appearance.speed}ms` : '0ms',
      '--ci-delay': motion ? `${260 / appearance.speed}ms` : '0ms',
    }"
    role="status"
    aria-live="polite"
  >
    <div class="ci-lesson-info">
      <span v-if="reminder.kind === 'prepare'" class="ci-countdown">
        距上课还剩
        <strong>{{ leftSeconds }}</strong>
        秒
      </span>
      <span v-else class="ci-countdown">课间休息</span>
      <span class="ci-lesson-course">
        <span>下节课是：</span>
        <strong>{{ course }}</strong>
        <small>{{ time }}</small>
      </span>
    </div>
    <div class="ci-lesson-progress" :style="{ transform: `scaleX(${progress})` }" />
    <svg class="ci-mask" :viewBox="`0 0 ${width} 40`" preserveAspectRatio="none" aria-hidden="true">
      <polygon v-for="(points, i) in polygons" :key="i" :points="points" />
    </svg>
    <div class="ci-mask-title" :class="{ 'ci-title-in': mask }">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
        <path d="M6 9a6 6 0 0 1 12 0v4l2 3H4l2-3V9Zm4 10a2 2 0 0 0 4 0" />
      </svg>
      <strong>{{ title }}</strong>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </svg>
    </div>
  </div>
</template>

<style scoped>
.ci-lesson {
  position: relative;
  width: max-content;
  min-width: 300px;
  max-width: 800px;
  height: 40px;
  overflow: hidden;
  color: #fff;
  font-size: 16px;
  line-height: 1;
  border-radius: 8px;
  background: #20202080;
}
.ci-lesson-info {
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 24px;
  padding: 0 28px;
  white-space: nowrap;
  transition: opacity var(--ci-duration) ease-in;
}
.ci-mask-active .ci-lesson-info {
  opacity: 0;
}
.ci-countdown {
  flex-shrink: 0;
}
.ci-countdown strong {
  font-variant-numeric: tabular-nums;
}
.ci-lesson-course {
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}
.ci-lesson-course strong {
  font-size: 20px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ci-lesson-course small {
  font-size: 14px;
  font-variant-numeric: tabular-nums;
}
.ci-mask {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 40px;
  fill: var(--island-accent, #60a5fa);
  pointer-events: none;
}
.ci-mask-title {
  position: absolute;
  inset: 0;
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 8px;
  opacity: 0;
  font-size: 18px;
  transform: scale(1.1);
  transition:
    opacity var(--ci-duration) linear,
    transform var(--ci-duration) cubic-bezier(0.5, 0, 0.75, 0);
  pointer-events: none;
}
.ci-mask-title svg {
  width: 20px;
  height: 20px;
}
.ci-title-in {
  animation:
    ci-title-enter var(--ci-title-duration) var(--ci-delay) cubic-bezier(0.25, 1, 0.5, 1) both,
    ci-title-scale var(--ci-scale-duration) var(--ci-delay) cubic-bezier(0.25, 1, 0.5, 1) both;
}
.ci-mask-title:not(.ci-title-in) {
  animation: ci-title-leave var(--ci-duration) linear both;
}
@keyframes ci-title-enter {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@keyframes ci-title-scale {
  from {
    transform: scale(1.1);
  }
  to {
    transform: scale(1);
  }
}
@keyframes ci-title-leave {
  from {
    opacity: 1;
    transform: scale(1);
  }
  to {
    opacity: 0;
    transform: scale(1.1);
  }
}
.ci-lesson-progress {
  position: absolute;
  bottom: 0;
  left: 0;
  width: 100%;
  height: 2px;
  background: var(--island-accent, #60a5fa);
  transform-origin: left;
  transition: transform 50ms linear;
}
</style>
