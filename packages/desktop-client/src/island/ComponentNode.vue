<script setup lang="ts">
import { computed, type CSSProperties } from 'vue';
import {
  ISLAND_COMPONENT_LABELS,
  type IslandComponentNode,
  type IslandState,
  type ScheduleDto,
} from '@classhelper/shared';
const props = defineProps<{
  node: IslandComponentNode;
  state: IslandState;
  now: number;
  schedules: ScheduleDto[];
  editing: boolean;
  selectedId: string;
  alertNodeId: string;
  parentHasWidth?: boolean;
}>();
const emit = defineEmits<{ select: [id: string]; drag: [event: PointerEvent, id: string] }>();
function select(event: MouseEvent) {
  if (!props.editing) return;
  event.stopPropagation();
  emit('select', props.node.id);
}
const container = computed(() => ['group', 'stack', 'slide', 'rolling'].includes(props.node.kind));
const current = computed(() => {
  const d = new Date(props.now),
    t = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return props.schedules.find((s) => s.startTime <= t && s.endTime > t);
});
const next = computed(() => {
  const d = new Date(props.now),
    t = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return props.schedules.find((s) => s.startTime > t);
});
const hidden = computed(
  () =>
    !props.editing &&
    ((['notification', 'homework', 'call'].includes(props.node.kind) &&
      (!props.state.active || props.state.mode === 'hidden' || props.node.id !== props.alertNodeId)) ||
      props.node.advanced.hideRules.some(
        (r) =>
          (r === 'in-class' && props.state.inClass) ||
          (r === 'no-message' && !props.state.active) ||
          (r === 'no-class' && !current.value),
      )),
);
const visibleChildren = computed(() =>
  props.node.kind === 'slide'
    ? props.node.children.filter(
        (_, i) =>
          i ===
          Math.floor(props.now / (props.node.settings.interval * 1000)) %
            Math.max(1, props.node.children.length),
      )
    : props.node.children,
);
const content = computed(() => {
  const n = props.node,
    d = new Date(props.now);
  if (n.kind === 'date')
    return d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
  if (n.kind === 'clock')
    return d.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      ...(n.settings.seconds ? { second: '2-digit' } : {}),
      hour12: n.settings.hour12,
    });
  if (n.kind === 'text')
    return n.settings.template
      ? n.settings.text
          .replaceAll('{date}', d.toLocaleDateString('zh-CN'))
          .replaceAll('{time}', d.toLocaleTimeString('zh-CN'))
          .replaceAll('{course}', current.value?.course?.name || '暂无课程')
      : n.settings.text;
  if (n.kind === 'countdown') {
    const time = n.settings.target === 'school' ? props.schedules.at(-1)?.endTime : next.value?.startTime;
    if (!time) return '今日课程已结束';
    const [h, m] = time.split(':').map(Number);
    const end = new Date(d);
    end.setHours(h!, m!, 0, 0);
    const left = Math.max(0, Math.ceil((end.getTime() - props.now) / 1000));
    return `${n.settings.target === 'school' ? '距放学' : '距上课'} ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  }
  return '';
});
const lessons = computed(() =>
  props.node.settings.display === 'today'
    ? props.schedules.slice(0, props.node.settings.count)
    : [props.node.settings.display === 'next' ? next.value : current.value].filter((s): s is ScheduleDto =>
        Boolean(s),
      ),
);
const style = computed<CSSProperties>(() => {
  const n = props.node,
    a = n.appearance,
    override = a.resourceOverridingEnabled;
  const color =
    a.background +
    Math.round((a.customBackgroundOpacityEnabled ? a.backgroundOpacity : 1) * 255)
      .toString(16)
      .padStart(2, '0');
  return {
    opacity: a.opacity,
    width: n.advanced.width ? `${n.advanced.width}px` : undefined,
    maxWidth: n.advanced.maxWidth ? `${n.advanced.maxWidth}px` : undefined,
    alignSelf: !props.parentHasWidth
      ? undefined
      : ({ stretch: 'stretch', start: 'flex-start', center: 'center', end: 'flex-end' } as const)[
          n.advanced.align
        ],
    textAlign: n.advanced.align === 'center' ? 'center' : 'start',
    color: override && a.customForegroundEnabled ? a.foreground : undefined,
    background: override && a.customBackgroundEnabled ? color : undefined,
    borderRadius: override && a.customCornerRadiusEnabled ? `${a.cornerRadius}px` : undefined,
    fontSize: override ? `${a.bodyFontSize}px` : undefined,
    '--secondary': override ? `${a.secondaryFontSize}px` : undefined,
    '--emphasized': override ? `${a.emphasizedFontSize}px` : undefined,
    '--large': override ? `${a.largeFontSize}px` : undefined,
    '--rolling-duration': `${Math.max(1, 200 / n.settings.speed)}s`,
    flexDirection: container.value ? (n.settings.direction === 'vertical' ? 'column' : 'row') : undefined,
    gap: container.value ? `${n.settings.gap}px` : undefined,
    display: container.value ? 'flex' : undefined,
  };
});
</script>
<template>
  <div
    v-if="!hidden"
    class="component-node"
    :class="[{ selected: editing && selectedId === node.id, container, 'node-editing': editing }, node.kind]"
    :style="style"
    :data-node="node.id"
    @click="select"
  >
    <button
      v-if="editing"
      class="node-handle"
      :data-kind="node.kind"
      aria-label="拖动组件"
      @pointerdown.stop="emit('drag', $event, node.id)"
    >
      ⠿ {{ ISLAND_COMPONENT_LABELS[node.kind] }}
    </button>
    <template v-if="container">
      <ComponentNode
        v-for="child in visibleChildren"
        :key="child.id"
        :node="child"
        :state="state"
        :now="now"
        :schedules="schedules"
        :editing="editing"
        :selected-id="selectedId"
        :alert-node-id="alertNodeId"
        :parent-has-width="Boolean(node.advanced.width || node.advanced.maxWidth)"
        @select="emit('select', $event)"
        @drag="(e, id) => emit('drag', e, id)"
      >
        <template #alerts><slot name="alerts" /></template>
      </ComponentNode>
    </template>
    <template v-else-if="node.kind === 'separator'"><span aria-hidden="true">│</span></template>
    <template v-else-if="node.kind === 'schedule'">
      <div v-for="(s, i) in lessons" :key="s.id">
        <small v-if="node.settings.showPeriod">第 {{ i + 1 }} 节 · {{ s.startTime }}</small>
        <strong>{{ s.course?.name }}</strong>
      </div>
      <span v-if="!lessons.length">暂无课程</span>
    </template>
    <template v-else-if="['notification', 'homework', 'call'].includes(node.kind)">
      <slot v-if="node.id === alertNodeId" name="alerts" />
      <span v-else-if="editing">{{ ISLAND_COMPONENT_LABELS[node.kind] }}内容组件</span>
    </template>
    <span v-else :class="{ emphasized: node.kind === 'clock' || node.kind === 'countdown' }">
      {{ content }}
    </span>
  </div>
</template>
<style scoped>
.component-node {
  min-width: 0;
  overflow: hidden;
  padding: 6px;
  flex-shrink: 0;
  position: relative;
}
.component-node:not(.node-editing) {
  line-height: 1.4;
}
.clock {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.date,
.countdown {
  white-space: nowrap;
}
.schedule > div {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.schedule > div + div {
  margin-top: 8px;
}
.separator > span {
  display: block;
  width: 1px;
  height: 24px;
  overflow: hidden;
  background: currentColor;
  font-size: 0;
  opacity: 0.25;
}
.container {
  align-items: center;
}
.stack {
  flex-wrap: wrap;
}
.rolling {
  overflow: hidden;
}
.rolling > :deep(.component-node) {
  animation: rolling var(--rolling-duration) linear infinite;
}
.selected {
  outline: 2px solid #85aaff;
  border-radius: 8px;
  background: #759cff14;
}
.node-handle {
  touch-action: none;
  cursor: grab;
  display: block;
  font:
    10px 'Microsoft YaHei',
    sans-serif;
  padding: 3px 6px;
  border: 0;
  border-radius: 4px;
  min-height: 24px;
  margin-bottom: 4px;
  color: #ffffff80;
  background: #ffffff0d;
}
.node-handle:hover {
  background: #ffffff20;
  color: #fff;
}
.notification,
.homework,
.call {
  padding: 0;
}
.notification.node-editing,
.homework.node-editing,
.call.node-editing {
  padding: 6px;
  flex-basis: auto;
}
.node-editing {
  cursor: pointer;
}
.node-editing:hover {
  box-shadow: inset 0 0 0 1px #ffffff28;
  border-radius: 8px;
}
small {
  font-size: var(--secondary, 12px);
  opacity: 0.7;
}
strong,
.emphasized {
  font-size: var(--emphasized, 20px);
}
.large {
  font-size: var(--large, 28px);
}
@keyframes rolling {
  from {
    transform: translateX(30%);
  }
  to {
    transform: translateX(-80%);
  }
}
</style>
