<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch, type CSSProperties } from 'vue';
import {
  ISLAND_SHADOW_PAD,
  PRIORITY_RANK,
  type IslandAppearance,
  type IslandLayoutSettings,
  type IslandState,
  type ScheduleDto,
  type IslandLessonReminder,
} from '@classhelper/shared';
import ComponentNode from './ComponentNode.vue';
import ComponentIcon from './ComponentIcon.vue';
import ClassicNotifications from './ClassicNotifications.vue';
import { squirclePath } from './squircle.js';
import { SpringValue } from './spring.js';
import LessonReminderContent from './LessonReminderContent.vue';

const props = defineProps<{
  settings: IslandLayoutSettings;
  state: IslandState;
  schedules: ScheduleDto[];
  appearance: IslandAppearance;
  nativeVisible: boolean;
}>();
const scheme = computed(() => props.settings.schemes.find((s) => s.id === props.settings.activeSchemeId)!);
const expanded = computed(() => props.state.mode === 'expanded');
const lesson = computed(() => props.state.lessonReminder ?? null);
const lastLesson = ref<IslandLessonReminder | null>(null);
watch(
  lesson,
  (value) => {
    if (value) lastLesson.value = value;
  },
  { immediate: true },
);
const messages = computed(() => {
  const unique = new Map(
    [props.state.active, ...props.state.queued].filter((n) => n !== null).map((n) => [n.id, n]),
  );
  return [...unique.values()].sort(
    (a, b) =>
      PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] ||
      Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );
});
const shell = ref<HTMLElement>();
const compact = ref<HTMLElement>();
const details = ref<HTMLElement>();
const lessonSource = ref<HTMLElement>();
const now = ref(Date.now());
const visible = ref(!document.hidden);
const motion = computed(() => props.appearance.animations && visible.value && props.nativeVisible);
const available = ref({ width: 940, height: 620 });
const natural = ref({
  compact: { width: 40, height: 40 },
  details: { width: 280, height: 80 },
  lesson: { width: 480, height: 40 },
});
const anchor = computed(() =>
  props.appearance.position.endsWith('left')
    ? 'left'
    : props.appearance.position.endsWith('right')
      ? 'right'
      : 'center',
);
function fitted(size: { width: number; height: number }) {
  // 以未变形内容测量；字体、配置缩放、行数和屏幕变化都参与适配，不从动画中的壳反推内容。
  const scale = Math.min(
    scheme.value.scale,
    available.value.width / size.width,
    available.value.height / size.height,
  );
  return { scale, width: Math.ceil(size.width * scale), height: Math.ceil(size.height * scale) };
}
const compactFit = computed(() => fitted(natural.value.compact));
const detailsFit = computed(() => fitted(natural.value.details));
const lessonFit = computed(() => fitted(natural.value.lesson));
const fit = computed(() =>
  lesson.value ? lessonFit.value : expanded.value ? detailsFit.value : compactFit.value,
);
const morph = ref({ width: 40, height: 40, radius: 20 });
const springs = {
  width: new SpringValue(40),
  height: new SpringValue(40),
  radius: new SpringValue(20),
  content: new SpringValue(0, { snapThreshold: 0.001 }),
  lesson: new SpringValue(0, { snapThreshold: 0.001 }),
};
// 与经典岛一致：常态内容先退净，展开内容按进度平方进入；反向收起沿同一条曲线返回。
// 独立进度也保证两页尺寸相同时仍播放过渡，不能靠高度差推导。
const progress = ref(0);
const lessonProgress = ref(0);
const compactAlpha = computed(() => Math.max(0, 1 - progress.value * 1.5) * (1 - lessonProgress.value));
const detailsAlpha = computed(() => progress.value * progress.value * (1 - lessonProgress.value));
const path = computed(() => squirclePath(morph.value.width, morph.value.height, morph.value.radius));
const style = computed<CSSProperties>(() => ({
  width: `${morph.value.width}px`,
  height: `${morph.value.height}px`,
  '--card-path': `path("${path.value}")`,
  '--island-font': `${props.appearance.fontSize}px`,
  '--island-accent': props.appearance.accent,
  '--state-color':
    props.state.active?.priority === 'URGENT'
      ? '#ff453a'
      : props.state.active?.kind === 'call'
        ? '#ff9f0a'
        : props.appearance.accent,
  '--resident-background': 'var(--wn-bg)',
  '--resident-radius': `${morph.value.radius}px`,
  '--resident-scale': fit.value.scale,
  '--custom-row-gap': `${scheme.value.spacing}px`,
  '--resident-row-width': `${Math.max(60, available.value.width / scheme.value.scale - 58)}px`,
  '--secondary': `${(props.appearance.fontSize / 13) * 14}px`,
  '--emphasized': `${(props.appearance.fontSize / 13) * 18}px`,
  '--large': `${(props.appearance.fontSize / 13) * 20}px`,
  '--ci-body-font': `${(props.appearance.fontSize / 13) * 16}px`,
  '--resident-fade-duration': motion.value ? `${200 / props.appearance.speed}ms` : '0ms',
}));
let morphFrame = 0;
let morphFallback: ReturnType<typeof setTimeout> | undefined;
function animate() {
  const size = fit.value;
  const radius = Math.min(
    lesson.value ? 8 : expanded.value ? props.appearance.radius : scheme.value.radius,
    size.width / 2,
    size.height / 2,
  );
  const target = { width: size.width, height: size.height, radius };
  const snap = () => {
    cancelAnimationFrame(morphFrame);
    morphFrame = 0;
    clearTimeout(morphFallback);
    for (const key of ['width', 'height', 'radius'] as const) springs[key].snap(target[key]);
    springs.content.snap(expanded.value ? 1 : 0);
    springs.lesson.snap(lesson.value ? 1 : 0);
    progress.value = springs.content.value;
    lessonProgress.value = springs.lesson.value;
    morph.value = target;
    void nextTick(reportHit);
  };
  // 应用内动画开关与经典岛保持一致；系统减少动态效果不能再次覆盖用户已开启的动画。
  if (!motion.value) {
    snap();
    return;
  }
  for (const key of ['width', 'height', 'radius'] as const) springs[key].setTarget(target[key]);
  springs.content.setTarget(expanded.value ? 1 : 0);
  springs.lesson.setTarget(lesson.value ? 1 : 0);
  clearTimeout(morphFallback);
  morphFallback = setTimeout(snap, 1200 / props.appearance.speed);
  if (morphFrame) return;
  let last = performance.now();
  const frame = (time: number) => {
    const dt = (time - last) * props.appearance.speed;
    last = time;
    // 三个维度每帧都推进；不能用短路 || 导致后面的维度等宽度结束才开始。
    const moving = Object.values(springs)
      .map((s) => s.step(dt))
      .some(Boolean);
    morph.value = { width: springs.width.value, height: springs.height.value, radius: springs.radius.value };
    progress.value = springs.content.value;
    lessonProgress.value = springs.lesson.value;
    if (moving) morphFrame = requestAnimationFrame(frame);
    else {
      morphFrame = 0;
      clearTimeout(morphFallback);
      void nextTick(reportHit);
    }
  };
  morphFrame = requestAnimationFrame(frame);
}
function action(value: 'expand' | 'collapse' | 'expand-list' | 'dismiss-all' | 'mark-all-read' | 'open-app') {
  window.island?.sendAction(value);
}
function open(event: Event) {
  if (!expanded.value && !(event.target as HTMLElement).closest('button')) action('expand');
}
function key(event: KeyboardEvent) {
  if (event.target === event.currentTarget && ['Enter', ' '].includes(event.key)) {
    event.preventDefault();
    action(expanded.value ? 'collapse' : 'expand');
  }
  if (event.key === 'Escape') action('collapse');
}
function pointer(event: PointerEvent) {
  if (event.pointerType !== 'mouse') window.island?.noteResidentTouch();
}
let observer: ResizeObserver | undefined;
let clock: ReturnType<typeof setInterval>;
let hitFrame = 0;
let hitUntil = 0;
let hitTimer: ReturnType<typeof setTimeout> | undefined;
let lastHit = '';
function reportHit() {
  const r = shell.value?.getBoundingClientRect();
  if (!r) return;
  const payload = { x: r.x, y: r.y, width: r.width, height: r.height };
  const key = Object.values(payload).map(Math.round).join(',');
  if (key !== lastHit) {
    lastHit = key;
    window.island?.setHitRect(payload);
  }
  const bell = !expanded.value ? shell.value?.querySelector('.resident-bell')?.getBoundingClientRect() : null;
  window.island?.reportResidentControl(
    bell ? { x: bell.x, y: bell.y, width: bell.width, height: bell.height } : null,
  );
}
function trackHit() {
  // 几何动画只在合成/渲染层播放；主进程只接收限流命中矩形，绝不据此改窗口大小。
  if (!motion.value) {
    reportHit();
    return;
  }
  hitUntil = performance.now() + 600 / props.appearance.speed;
  clearTimeout(hitTimer);
  hitTimer = setTimeout(reportHit, 650 / props.appearance.speed);
  if (hitFrame) return;
  let last = 0;
  const frame = (time: number) => {
    if (time - last >= 60) {
      reportHit();
      last = time;
    }
    if (time < hitUntil) hitFrame = requestAnimationFrame(frame);
    else {
      hitFrame = 0;
      reportHit();
    }
  };
  hitFrame = requestAnimationFrame(frame);
}
let measuring = false;
function measure() {
  if (measuring) return;
  measuring = true;
  void nextTick(() => {
    measuring = false;
    if (!compact.value || !details.value) return;
    const read = (element: HTMLElement) => ({
      width: Math.max(40, element.offsetWidth),
      height: Math.max(40, element.offsetHeight),
    });
    natural.value = {
      compact: read(compact.value),
      details: read(details.value),
      lesson: lessonSource.value ? read(lessonSource.value) : natural.value.lesson,
    };
    void nextTick(() => {
      window.island?.reportSize({ width: fit.value.width, height: fit.value.height });
      trackHit();
    });
  });
}
function resizeCanvas(width = innerWidth, height = innerHeight) {
  available.value = {
    width: Math.max(40, Math.min(width, innerWidth) - 2 * ISLAND_SHADOW_PAD - 4),
    height: Math.max(40, Math.min(height, innerHeight) - 2 * ISLAND_SHADOW_PAD - 4),
  };
  measure();
}
const resize = () => resizeCanvas();
let stopViewport: (() => void) | undefined;
function visibility() {
  visible.value = !document.hidden;
  resize();
  void nextTick(reportHit);
}
// 不深度监听整份状态；只在目标内容/几何变化时测量，时钟每秒只改文本。
watch([expanded, scheme, lesson, () => props.state.listExpanded, messages], measure, {
  deep: true,
  flush: 'post',
});
watch(
  [fit, motion, expanded, lesson, () => props.appearance.radius, () => props.appearance.speed],
  () => {
    animate();
    trackHit();
  },
  { flush: 'post' },
);
watch(
  () => props.appearance.position,
  () => void nextTick(trackHit),
);
onMounted(() => {
  resize();
  stopViewport = window.island?.onViewport((v) => resizeCanvas(v.width, v.height));
  observer = new ResizeObserver((entries) => {
    if (entries.some((entry) => entry.target === document.documentElement)) resize();
    else measure();
  });
  observer.observe(document.documentElement);
  if (compact.value) observer.observe(compact.value);
  if (details.value) observer.observe(details.value);
  if (lessonSource.value) observer.observe(lessonSource.value);
  clock = setInterval(() => (now.value = Date.now()), 1000);
  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', visibility);
  void document.fonts.ready.then(measure);
});
onUnmounted(() => {
  stopViewport?.();
  observer?.disconnect();
  clearInterval(clock);
  clearTimeout(hitTimer);
  cancelAnimationFrame(hitFrame);
  cancelAnimationFrame(morphFrame);
  clearTimeout(morphFallback);
  window.removeEventListener('resize', resize);
  document.removeEventListener('visibilitychange', visibility);
  window.island?.reportResidentControl(null);
});
</script>

<template>
  <div
    class="resident-window"
    :data-anchor="anchor"
    :data-bottom="appearance.position.startsWith('bottom')"
    @pointerdown.capture="pointer"
  >
    <section
      ref="shell"
      class="custom-card resident-card island-card"
      :data-style="appearance.style"
      :class="{
        'resident-open': expanded,
        expanded,
        pill: !expanded,
        urgent: state.active?.priority === 'URGENT',
        call: state.active?.kind === 'call',
        'resident-separated': scheme.separated && !expanded && !lesson,
        'resident-lesson': !!lesson,
        'message-surface': expanded && messages.length > 0 && !lesson,
      }"
      :style="style"
      :role="expanded ? 'region' : 'button'"
      tabindex="0"
      :aria-label="
        expanded
          ? '自定义灵动岛内容'
          : messages.length
            ? `查看 ${messages.length} 条通知`
            : '展开自定义灵动岛'
      "
      :aria-expanded="expanded"
      @click="open"
      @keydown="key"
      @transitionend.self="reportHit"
    >
      <svg
        class="shape"
        :width="morph.width"
        :height="morph.height"
        :viewBox="`0 0 ${morph.width} ${morph.height}`"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path :d="path" />
      </svg>
      <span class="tint" aria-hidden="true" />
      <div
        class="resident-page resident-compact-page"
        :style="{
          '--resident-scale': compactFit.scale,
          opacity: compactAlpha,
          visibility: compactAlpha > 0 ? 'visible' : 'hidden',
        }"
        :class="{ 'page-active': !expanded }"
        :inert="expanded"
        :aria-hidden="expanded"
      >
        <div ref="compact" class="resident-source resident-compact">
          <div class="layout-rows" :style="{ gap: `${scheme.spacing}px` }">
            <section
              v-for="row in scheme.rows"
              :key="row.id"
              class="layout-row"
              :data-row="row.id"
              :style="{ '--row-gap': `${row.gap}px` }"
            >
              <div class="row-components">
                <ComponentNode
                  v-for="node in row.nodes"
                  :key="node.id"
                  :node="node"
                  :state="state"
                  :now="now"
                  :schedules="schedules"
                  :editing="false"
                  selected-id=""
                  alert-node-id=""
                />
              </div>
            </section>
          </div>
          <button
            class="resident-bell"
            :class="{ 'bell-empty': !messages.length }"
            :aria-label="messages.length ? `查看 ${messages.length} 条通知` : '展开自定义灵动岛'"
            @click.stop="action('expand')"
          >
            <ComponentIcon v-if="messages.length" kind="notification" />
            <svg
              v-else
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              aria-hidden="true"
            >
              <path d="m8 10 4 4 4-4" />
            </svg>
            <span v-if="messages.length" :key="messages.length">
              {{ messages.length > 99 ? '99+' : messages.length }}
            </span>
          </button>
        </div>
      </div>
      <div
        class="resident-page resident-detail-page"
        :style="{
          '--resident-scale': detailsFit.scale,
          opacity: detailsAlpha,
          visibility: detailsAlpha > 0 ? 'visible' : 'hidden',
        }"
        :class="{ 'page-active': expanded }"
        :inert="!expanded"
        :aria-hidden="!expanded"
      >
        <div
          ref="details"
          class="resident-source resident-details"
          :class="{ 'with-messages': messages.length }"
        >
          <ClassicNotifications
            v-if="messages.length"
            id="custom-alert-host"
            :state="state"
            :appearance="appearance"
            :max-height="available.height / scheme.scale"
          />
          <header v-else class="resident-panel-heading">
            <span>自定义灵动岛</span>
            <button class="icon-btn" aria-label="收起自定义灵动岛" @click.stop="action('collapse')">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
                <path d="m8 14 4-4 4 4" />
              </svg>
            </button>
          </header>
          <div
            v-if="!messages.length"
            class="layout-rows resident-expanded-rows"
            :style="{ gap: `${scheme.spacing}px` }"
          >
            <section
              v-for="row in scheme.expandedRows"
              :key="row.id"
              class="layout-row"
              :data-row="row.id"
              :style="{ '--row-gap': `${row.gap}px` }"
            >
              <div class="row-components">
                <ComponentNode
                  v-for="node in row.nodes"
                  :key="node.id"
                  :node="node"
                  :state="state"
                  :now="now"
                  :schedules="schedules"
                  :editing="false"
                  selected-id=""
                  alert-node-id=""
                />
              </div>
            </section>
          </div>
        </div>
      </div>
      <div
        class="resident-page resident-lesson-page"
        :style="{
          '--resident-scale': lessonFit.scale,
          opacity: lessonProgress,
          visibility: lessonProgress > 0 ? 'visible' : 'hidden',
        }"
        :aria-hidden="!lesson"
        :inert="!lesson"
      >
        <div ref="lessonSource" class="resident-source">
          <LessonReminderContent
            v-if="lastLesson"
            :reminder="lastLesson"
            :now="now"
            :appearance="appearance"
            :motion="motion"
          />
        </div>
      </div>
    </section>
  </div>
</template>
<style src="./custom-runtime.css"></style>
