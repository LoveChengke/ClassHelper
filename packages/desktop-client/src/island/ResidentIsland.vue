<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch, type CSSProperties } from 'vue';
import {
  CLASSISLAND_ISLAND_METRICS as CI,
  ISLAND_SHADOW_PAD,
  PRIORITY_LABELS,
  PRIORITY_RANK,
  type IslandAppearance,
  type IslandLayoutSettings,
  type IslandState,
  type ScheduleDto,
} from '@classhelper/shared';
import ComponentNode from './ComponentNode.vue';
import ComponentIcon from './ComponentIcon.vue';

const props = defineProps<{
  settings: IslandLayoutSettings;
  state: IslandState;
  schedules: ScheduleDto[];
  appearance: IslandAppearance;
  nativeVisible: boolean;
}>();
const scheme = computed(() => props.settings.schemes.find((s) => s.id === props.settings.activeSchemeId)!);
const expanded = computed(() => props.state.mode === 'expanded');
const messages = computed(() => {
  const unique = new Map(
    [props.state.active, ...props.state.queued].filter((n) => n !== null).map((n) => [n.id, n]),
  );
  return [...unique.values()].sort(
    (a, b) =>
      PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
      Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );
});
const shell = ref<HTMLElement>();
const compact = ref<HTMLElement>();
const details = ref<HTMLElement>();
const now = ref(Date.now());
const visible = ref(!document.hidden);
const motion = computed(() => props.appearance.animations && visible.value && props.nativeVisible);
const available = ref({ width: 940, height: 620 });
const natural = ref({ compact: { width: 40, height: 40 }, details: { width: 280, height: 80 } });
const anchor = computed(() =>
  props.appearance.position.endsWith('left')
    ? 'left'
    : props.appearance.position.endsWith('right')
      ? 'right'
      : 'center',
);
const capacity = computed(() =>
  Math.max(1, Math.floor((available.value.height / scheme.value.scale - 130) / 104)),
);
const visibleMessages = computed(() =>
  messages.value.slice(0, props.state.listExpanded ? capacity.value : Math.min(3, capacity.value)),
);
const remaining = computed(() => messages.value.length - visibleMessages.value.length);
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
const fit = computed(() => (expanded.value ? detailsFit.value : compactFit.value));
const style = computed<CSSProperties>(() => ({
  width: `${fit.value.width}px`,
  height: `${fit.value.height}px`,
  color: scheme.value.foreground,
  '--resident-background': `${scheme.value.color}${Math.round(scheme.value.opacity * 255)
    .toString(16)
    .padStart(2, '0')}`,
  '--resident-radius': `${scheme.value.radius * fit.value.scale}px`,
  '--resident-scale': fit.value.scale,
  '--custom-row-gap': `${scheme.value.spacing}px`,
  '--resident-row-width': `${Math.max(60, available.value.width / scheme.value.scale - 58)}px`,
  '--secondary': `${CI.secondaryFontSize}px`,
  '--emphasized': `${CI.emphasizedFontSize}px`,
  '--large': `${CI.largeFontSize}px`,
  '--resident-duration': motion.value ? `${550 / props.appearance.speed}ms` : '0ms',
  '--resident-fade-duration': motion.value ? `${200 / props.appearance.speed}ms` : '0ms',
}));
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
    natural.value = { compact: read(compact.value), details: read(details.value) };
    void nextTick(() => {
      window.island?.reportSize({ width: fit.value.width, height: fit.value.height });
      trackHit();
    });
  });
}
function resize() {
  available.value = {
    width: Math.max(40, innerWidth - 2 * ISLAND_SHADOW_PAD - 4),
    height: Math.max(40, innerHeight - 2 * ISLAND_SHADOW_PAD - 4),
  };
  measure();
}
function visibility() {
  visible.value = !document.hidden;
  void nextTick(reportHit);
}
// 不深度监听整份状态；只在目标内容/几何变化时测量，时钟每秒只改文本。
watch([expanded, scheme, () => props.state.listExpanded, messages], measure, { deep: true, flush: 'post' });
watch(fit, trackHit, { flush: 'post' });
watch(
  () => props.appearance.position,
  () => void nextTick(trackHit),
);
onMounted(() => {
  resize();
  observer = new ResizeObserver(measure);
  if (compact.value) observer.observe(compact.value);
  if (details.value) observer.observe(details.value);
  clock = setInterval(() => (now.value = Date.now()), 1000);
  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', visibility);
  void document.fonts.ready.then(measure);
});
onUnmounted(() => {
  observer?.disconnect();
  clearInterval(clock);
  clearTimeout(hitTimer);
  cancelAnimationFrame(hitFrame);
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
      class="custom-card resident-card"
      :class="{ 'resident-open': expanded, 'resident-separated': scheme.separated && !expanded }"
      :style="style"
      :role="expanded ? 'region' : 'button'"
      tabindex="0"
      :aria-label="
        expanded ? '常驻岛内容' : messages.length ? `查看 ${messages.length} 条通知` : '展开常驻岛'
      "
      :aria-expanded="expanded"
      @click="open"
      @keydown="key"
      @transitionend.self="reportHit"
    >
      <div
        class="resident-page resident-compact-page"
        :style="{ '--resident-scale': compactFit.scale }"
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
            :aria-label="messages.length ? `查看 ${messages.length} 条通知` : '展开常驻岛'"
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
        :style="{ '--resident-scale': detailsFit.scale }"
        :class="{ 'page-active': expanded }"
        :inert="!expanded"
        :aria-hidden="!expanded"
      >
        <div
          ref="details"
          class="resident-source resident-details"
          :class="{ 'with-messages': messages.length }"
          :style="
            messages.length ? { width: `${Math.min(440, available.width / scheme.scale)}px` } : undefined
          "
        >
          <header class="resident-panel-heading">
            <span>{{ messages.length ? `通知 · ${messages.length}` : '常驻岛' }}</span>
            <button class="icon-btn" aria-label="收起常驻岛" @click.stop="action('collapse')">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
                <path d="m8 14 4-4 4 4" />
              </svg>
            </button>
          </header>
          <div v-if="messages.length" id="custom-alert-host" class="resident-messages">
            <article
              v-for="item in visibleMessages"
              :key="item.id"
              class="list-row"
              :data-priority="item.priority"
            >
              <div class="resident-message-title">
                <strong>{{ item.title }}</strong>
                <span>{{ PRIORITY_LABELS[item.priority] }}</span>
              </div>
              <p>{{ item.content }}</p>
              <small>{{ [item.teacherName, item.courseName].filter(Boolean).join(' · ') }}</small>
            </article>
            <button
              v-if="remaining"
              class="resident-more"
              @click.stop="action(state.listExpanded ? 'open-app' : 'expand-list')"
            >
              {{
                state.listExpanded ? `其余 ${remaining} 条在应用中查看` : `展开更多（还有 ${remaining} 条）`
              }}
            </button>
            <footer class="resident-actions">
              <button @click.stop="action('open-app')">查看完整内容</button>
              <button @click.stop="action('mark-all-read')">标为已读</button>
              <button class="solid-btn" @click.stop="action('dismiss-all')">知道了</button>
            </footer>
          </div>
          <div v-else class="layout-rows resident-expanded-rows" :style="{ gap: `${scheme.spacing}px` }">
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
    </section>
  </div>
</template>
<style src="./resident-island.css"></style>
