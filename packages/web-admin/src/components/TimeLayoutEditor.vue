<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  TIME_POINT_TYPES,
  type CourseDto,
  type TimeLayoutDetailDto,
  type TimePointDto,
  type TimePointType,
} from '@classhelper/shared';
import ArchiveIcon from './ArchiveIcon.vue';

/**
 * 时间表编辑器（ClassIsland 档案编辑器的「时间表」页）。
 *
 * 左侧切换时间表，顶部按类型添加时间点，中间提供列表/时间轴两种视图，
 * 右侧编辑选中时间点，底部调整默认时长与缩放。组件直接改父组件传入的
 * `layout.points`，保存与脏数据比较仍由 PlanEditorView 负责。
 */
const props = defineProps<{
  layouts: TimeLayoutDetailDto[];
  courses: CourseDto[];
  canEdit: boolean;
  saving: boolean;
  /** 引用当前时间表的日课表数量，显示在「时间表信息」里。 */
  planCount: number;
}>();
const layout = defineModel<TimeLayoutDetailDto | undefined>('layout', { default: undefined });
const emit = defineEmits<{
  'select-layout': [id: string];
  create: [];
  clone: [];
  save: [];
  refresh: [];
  'delete-layout': [];
  'import-points': [sourceId: string];
  'apply-default': [pointId: string];
}>();

const TYPE_LABELS: Record<TimePointType, string> = {
  LESSON: '上课',
  BREAK: '课间休息',
  DIVIDER: '分割线',
  ACTION: '行动',
};
const TYPE_ICONS: Record<TimePointType, string> = {
  LESSON: 'lesson',
  BREAK: 'break',
  DIVIDER: 'divider',
  ACTION: 'action',
};

const search = ref('');
const view = ref<'list' | 'timeline'>('list');
const zoom = ref(100);
const selectedId = ref('');
const lessonMinutes = ref(40);
const breakMinutes = ref(10);
const durationsOpen = ref(true);
const infoVisible = ref(false);
const importSource = ref('');
const timelineScroller = ref<HTMLElement>();
const nowMinutes = ref(currentMinutes());
let nowTimer: ReturnType<typeof setInterval> | null = null;
let reorderFrom = '';
let reorderTo = '';

const visibleLayouts = computed(() => props.layouts.filter((item) => item.name.includes(search.value)));
const points = computed(() => layout.value?.points ?? []);
const selected = computed<TimePointDto | undefined>(() =>
  points.value.find((point) => point.id === selectedId.value),
);
const pxPerMinute = computed(() => Math.max(0.4, zoom.value / 100));
const tickMinutes = computed(() => (zoom.value >= 120 ? 30 : 60));
const ticks = computed(() => {
  const step = tickMinutes.value;
  return Array.from({ length: Math.ceil((24 * 60) / step) }, (_, index) => index * step);
});
const blocks = computed(() =>
  points.value.map((point) => {
    const start = toMinutes(point.startTime);
    const end = Math.max(start, toMinutes(point.endTime));
    return {
      point,
      top: start * pxPerMinute.value,
      height: Math.max(2, (end - start) * pxPerMinute.value),
      duration: end - start,
    };
  }),
);
const nowTop = computed(() => nowMinutes.value * pxPerMinute.value);
const globalLayout = computed(() => Boolean(layout.value) && !layout.value?.classId);

function currentMinutes(): number {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}
function toMinutes(time: string): number {
  const [hour, minute] = time.split(':').map(Number);
  return (hour ?? 0) * 60 + (minute ?? 0);
}
function toTime(minutes: number): string {
  const total = Math.max(0, Math.min(24 * 60 - 1, Math.round(minutes)));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
function duration(point: TimePointDto): number {
  return Math.max(0, toMinutes(point.endTime) - toMinutes(point.startTime));
}
function durationText(point: TimePointDto): string {
  const minutes = duration(point);
  if (point.timeType === 'DIVIDER') return '分割线';
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours} 小时 ${minutes % 60} 分钟` : `${minutes} 分钟`;
}
function pointLabel(point: TimePointDto): string {
  if (point.timeType === 'BREAK') return point.breakName || point.name || '课间休息';
  if (point.timeType === 'DIVIDER') return '分割线';
  if (point.timeType === 'ACTION') return point.name || '行动';
  return point.name || '课时';
}
function defaultCourseName(point: TimePointDto): string {
  return props.courses.find((course) => course.id === point.defaultClassId)?.name ?? '';
}
function sortPoints(): void {
  if (!layout.value) return;
  layout.value.points.sort(
    (a, b) => toMinutes(a.startTime) - toMinutes(b.startTime) || a.position - b.position,
  );
  layout.value.points.forEach((point, index) => (point.position = index));
}
function overlaps(start: number, end: number, ignoreId = ''): boolean {
  return points.value.some((point) => {
    if (point.timeType === 'DIVIDER' || point.id === ignoreId) return false;
    const pointStart = toMinutes(point.startTime);
    const pointEnd = toMinutes(point.endTime);
    return end > pointStart && start < pointEnd;
  });
}
function addPoint(type: TimePointType): void {
  if (!layout.value || !props.canEdit) return;
  const minutes = type === 'DIVIDER' ? 0 : type === 'BREAK' ? breakMinutes.value : lessonMinutes.value;
  const selectedPoint = selected.value;
  const lastEnd = points.value.reduce((max, point) => Math.max(max, toMinutes(point.endTime)), 0);
  const candidates: number[] = [];
  if (selectedPoint) {
    candidates.push(toMinutes(selectedPoint.endTime), toMinutes(selectedPoint.startTime) - minutes);
  }
  candidates.push(points.value.length ? lastEnd : 8 * 60, 8 * 60);
  const start = candidates.find(
    (value) => value >= 0 && value + minutes < 24 * 60 && !overlaps(value, value + minutes),
  );
  if (start === undefined) {
    ElMessage.warning('所选时间点前后没有可用时段');
    return;
  }
  const lessons = points.value.filter((point) => point.timeType === 'LESSON').length;
  const name =
    type === 'LESSON'
      ? `第 ${lessons + 1} 节`
      : type === 'BREAK'
        ? '课间'
        : type === 'DIVIDER'
          ? '分割线'
          : '行动';
  const point: TimePointDto = {
    id: `draft-${crypto.randomUUID()}`,
    position: points.value.length,
    name,
    startTime: toTime(start),
    endTime: toTime(start + minutes),
    timeType: type,
    isHideDefault: false,
    defaultClassId: null,
    breakName: type === 'BREAK' ? '课间休息' : '',
    actionSet: '{}',
  };
  layout.value.points.push(point);
  sortPoints();
  selectedId.value = point.id;
  void scrollToPoint(point);
}
function deletePoint(): void {
  if (!layout.value || !props.canEdit || !selected.value) return;
  layout.value.points.splice(layout.value.points.indexOf(selected.value), 1);
  selectedId.value = '';
}
function setType(type: TimePointType): void {
  const point = selected.value;
  if (!point || !props.canEdit) return;
  point.timeType = type;
  if (type !== 'LESSON') {
    point.defaultClassId = null;
    point.isHideDefault = false;
  }
  if (type === 'BREAK' && !point.breakName) point.breakName = '课间休息';
  if (type === 'DIVIDER') point.endTime = point.startTime;
  if (type === 'LESSON' && point.endTime <= point.startTime)
    point.endTime = toTime(Math.min(24 * 60 - 1, toMinutes(point.startTime) + lessonMinutes.value));
}
function setTimePart(edge: 'start' | 'end', part: 'hour' | 'minute', value: number | undefined): void {
  const point = selected.value;
  if (!point || !props.canEdit) return;
  const key = edge === 'start' ? 'startTime' : 'endTime';
  const total = toMinutes(point[key]);
  const minutes =
    part === 'hour'
      ? (Number(value ?? 0) % 24) * 60 + (total % 60)
      : Math.floor(total / 60) * 60 + Math.min(59, Math.max(0, Number(value ?? 0)));
  if (edge === 'start') point.startTime = toTime(Math.min(minutes, toMinutes(point.endTime) - 1));
  else point.endTime = toTime(Math.max(minutes, toMinutes(point.startTime) + 1));
}
async function applyDefault(): Promise<void> {
  const point = selected.value;
  if (!point?.defaultClassId || !props.canEdit) return;
  try {
    await ElMessageBox.confirm(
      `将「${defaultCourseName(point)}」写入所有引用此时间表的日课表？已有科目会被覆盖。`,
      '覆盖现有课程',
      { type: 'warning', confirmButtonText: '覆盖', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  emit('apply-default', point.id);
}
function selectPoint(id: string): void {
  selectedId.value = id;
}
function zoomBy(delta: number): void {
  zoom.value = Math.max(50, Math.min(400, zoom.value + delta));
}
function onWheel(event: WheelEvent): void {
  if (!event.ctrlKey) return;
  event.preventDefault();
  zoomBy(event.deltaY < 0 ? 25 : -25);
}
/* ---------------------------------------------------------------- 时间轴拖动 */
const drag = ref<{ id: string; edge: 'start' | 'end'; startY: number; start: number; end: number }>();
function startHandle(event: PointerEvent, point: TimePointDto, edge: 'start' | 'end'): void {
  if (!props.canEdit) return;
  event.preventDefault();
  event.stopPropagation();
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  selectedId.value = point.id;
  drag.value = {
    id: point.id,
    edge,
    startY: event.clientY,
    start: toMinutes(point.startTime),
    end: toMinutes(point.endTime),
  };
}
function moveHandle(event: PointerEvent): void {
  const state = drag.value;
  if (!state) return;
  const point = points.value.find((item) => item.id === state.id);
  if (!point) return;
  const delta = Math.round((event.clientY - state.startY) / pxPerMinute.value);
  if (state.edge === 'start')
    point.startTime = toTime(Math.min(state.end - 1, Math.max(0, state.start + delta)));
  else point.endTime = toTime(Math.max(state.start + 1, Math.min(24 * 60 - 1, state.end + delta)));
}
function endHandle(): void {
  if (drag.value) sortPoints();
  drag.value = undefined;
}
/* ---------------------------------------------------------------- 列表拖动排序 */
function reorderStart(event: PointerEvent, point: TimePointDto): void {
  if (!props.canEdit) return;
  reorderFrom = point.id;
  reorderTo = point.id;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}
function reorderMove(event: PointerEvent): void {
  const row = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-point]');
  if (row) reorderTo = row.dataset.point || reorderTo;
}
function reorderEnd(): void {
  if (layout.value && reorderFrom && reorderTo && reorderFrom !== reorderTo) {
    const from = layout.value.points.findIndex((point) => point.id === reorderFrom);
    const to = layout.value.points.findIndex((point) => point.id === reorderTo);
    if (from >= 0 && to >= 0) {
      layout.value.points.splice(to, 0, ...layout.value.points.splice(from, 1));
      layout.value.points.forEach((point, index) => (point.position = index));
    }
  }
  reorderFrom = '';
  reorderTo = '';
}
async function scrollToPoint(point?: TimePointDto): Promise<void> {
  if (!point || view.value !== 'timeline') return;
  await nextTick();
  if (!timelineScroller.value) return;
  timelineScroller.value.scrollTop = Math.max(0, toMinutes(point.startTime) * pxPerMinute.value - 60);
}
async function scrollToFirst(): Promise<void> {
  if (view.value !== 'timeline') return;
  const first = [...points.value].sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime))[0];
  await scrollToPoint(first);
}
watch(view, () => void scrollToFirst());
watch(
  () => layout.value?.id,
  () => {
    selectedId.value = '';
    importSource.value = '';
    void scrollToFirst();
  },
);
onMounted(() => {
  nowTimer = setInterval(() => (nowMinutes.value = currentMinutes()), 30_000);
  void scrollToFirst();
});
onUnmounted(() => {
  if (nowTimer) clearInterval(nowTimer);
});
</script>

<template>
  <div class="layout-workspace">
    <aside class="layout-explorer" aria-label="时间表列表">
      <el-input v-model="search" placeholder="搜索时间表" clearable />
      <div class="explorer-actions">
        <button class="command" :disabled="!canEdit" @click="emit('create')">
          <ArchiveIcon name="plus" />
          新时间表
        </button>
        <button class="command" :disabled="!canEdit || !layout" @click="emit('clone')">
          <ArchiveIcon name="transfer" />
          复制
        </button>
      </div>
      <button
        v-for="item in visibleLayouts"
        :key="item.id"
        class="plan-item"
        :class="{ active: layout?.id === item.id }"
        @click="emit('select-layout', item.id)"
      >
        <strong>{{ item.name }}</strong>
        <small>{{ item.classId ? '班级时间表' : '全校时间表' }} · {{ item.points.length }} 个时间点</small>
      </button>
    </aside>

    <main class="layout-main">
      <header class="layout-toolbar">
        <button class="command" :disabled="!canEdit || !layout" @click="addPoint('LESSON')">
          <ArchiveIcon name="lesson" />
          上课
        </button>
        <button class="command" :disabled="!canEdit || !layout" @click="addPoint('BREAK')">
          <ArchiveIcon name="break" />
          课间休息
        </button>
        <button class="command" :disabled="!canEdit || !layout" @click="addPoint('DIVIDER')">
          <ArchiveIcon name="divider" />
          分割线
        </button>
        <button class="command" :disabled="!canEdit || !layout" @click="addPoint('ACTION')">
          <ArchiveIcon name="action" />
          行动
        </button>
        <span class="command-separator" />
        <button class="command" :disabled="!canEdit || !selected" @click="deletePoint">
          <ArchiveIcon name="trash" />
          删除
        </button>
        <button class="command" @click="emit('refresh')">
          <ArchiveIcon name="refresh" />
          刷新
        </button>
        <button class="command" :disabled="!layout" @click="infoVisible = true">
          <ArchiveIcon name="clock" />
          时间表信息
        </button>
        <button class="command danger" :disabled="!canEdit || !layout" @click="emit('delete-layout')">
          <ArchiveIcon name="trash" />
          删除时间表
        </button>
        <button class="command primary" :disabled="!canEdit || !layout || saving" @click="emit('save')">
          <ArchiveIcon name="save" />
          保存时间表
        </button>
      </header>

      <div class="tl-body">
        <div class="layout-canvas" :inert="saving">
          <div v-if="!layout" class="panel-empty">
            <ArchiveIcon name="clock" />
            <p>新建一份时间表开始编辑</p>
            <button class="command" :disabled="!canEdit" @click="emit('create')">＋ 新时间表</button>
          </div>
          <div v-else-if="view === 'list'" class="point-list" aria-label="时间点列表">
            <div
              v-for="point in layout.points"
              :key="point.id"
              :data-point="point.id"
              class="time-point-row"
              :class="[point.timeType.toLowerCase(), { selected: selectedId === point.id }]"
              tabindex="0"
              @click="selectPoint(point.id)"
              @keydown.enter="selectPoint(point.id)"
            >
              <button
                class="drag"
                :disabled="!canEdit"
                aria-label="拖动时间点排序"
                @pointerdown.stop="reorderStart($event, point)"
                @pointermove="reorderMove"
                @pointerup="reorderEnd"
                @pointercancel="reorderEnd"
              >
                ⠿
              </button>
              <ArchiveIcon class="type-icon" :name="TYPE_ICONS[point.timeType]" />
              <span class="point-time">
                {{ point.startTime }}
                <template v-if="point.timeType !== 'DIVIDER'">– {{ point.endTime }}</template>
              </span>
              <el-input
                v-model="point.name"
                :disabled="!canEdit"
                placeholder="名称"
                class="point-name"
                @click.stop
              />
              <span class="point-duration">{{ durationText(point) }}</span>
              <span v-if="point.timeType === 'LESSON' && point.isHideDefault" class="point-badge">
                默认隐藏
              </span>
              <span
                v-if="point.timeType === 'LESSON' && defaultCourseName(point)"
                class="point-badge default"
              >
                默认 {{ defaultCourseName(point) }}
              </span>
              <button
                class="command small"
                :disabled="!canEdit"
                :aria-label="`删除 ${pointLabel(point)}`"
                @click.stop="
                  selectedId = point.id;
                  deletePoint();
                "
              >
                <ArchiveIcon name="trash" />
              </button>
            </div>
            <p v-if="!layout.points.length" class="list-hint">
              还没有时间点，用上方按钮添加上课、课间休息或分割线。
            </p>
          </div>
          <div v-else class="timeline">
            <div ref="timelineScroller" class="timeline-scroll" @wheel.ctrl.prevent="onWheel">
              <div
                class="timeline-canvas"
                :style="{ height: `${24 * 60 * pxPerMinute}px` }"
                @click.self="selectedId = ''"
              >
                <div class="timeline-ruler" aria-hidden="true">
                  <span
                    v-for="tick in ticks"
                    :key="tick"
                    class="timeline-tick"
                    :style="{ top: `${tick * pxPerMinute}px` }"
                  >
                    {{ toTime(tick) }}
                  </span>
                </div>
                <div class="timeline-blocks">
                  <div
                    v-for="block in blocks"
                    :key="block.point.id"
                    class="time-block"
                    :class="[block.point.timeType.toLowerCase(), { selected: selectedId === block.point.id }]"
                    :style="{ top: `${block.top}px`, height: `${block.height}px` }"
                    :title="`${pointLabel(block.point)} ${block.point.startTime}–${block.point.endTime}`"
                    @click.stop="selectPoint(block.point.id)"
                  >
                    <span v-if="block.height >= 20" class="block-label">
                      <strong>{{ pointLabel(block.point) }}</strong>
                      <small v-if="block.height >= 34">
                        {{ block.point.startTime }}–{{ block.point.endTime }}
                      </small>
                    </span>
                    <template
                      v-if="canEdit && selectedId === block.point.id && block.point.timeType !== 'DIVIDER'"
                    >
                      <button
                        class="handle start"
                        aria-label="拖动开始时间"
                        @pointerdown.stop="startHandle($event, block.point, 'start')"
                        @pointermove="moveHandle"
                        @pointerup="endHandle"
                        @pointercancel="endHandle"
                      />
                      <button
                        class="handle end"
                        aria-label="拖动结束时间"
                        @pointerdown.stop="startHandle($event, block.point, 'end')"
                        @pointermove="moveHandle"
                        @pointerup="endHandle"
                        @pointercancel="endHandle"
                      />
                    </template>
                  </div>
                  <div
                    v-if="nowMinutes >= 0"
                    class="now-line"
                    :style="{ top: `${nowTop}px` }"
                    aria-hidden="true"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        <aside class="point-inspector" aria-label="编辑时间点">
          <h3>编辑时间点</h3>
          <template v-if="selected">
            <label class="inspector-field">
              <span>开始时间</span>
              <div class="time-parts">
                <el-input-number
                  :model-value="Math.floor(toMinutes(selected.startTime) / 60)"
                  :min="0"
                  :max="23"
                  :controls="false"
                  :disabled="!canEdit || selected.timeType === 'DIVIDER'"
                  aria-label="开始小时"
                  @update:model-value="setTimePart('start', 'hour', $event ?? undefined)"
                />
                <span>时</span>
                <el-input-number
                  :model-value="toMinutes(selected.startTime) % 60"
                  :min="0"
                  :max="59"
                  :controls="false"
                  :disabled="!canEdit || selected.timeType === 'DIVIDER'"
                  aria-label="开始分钟"
                  @update:model-value="setTimePart('start', 'minute', $event ?? undefined)"
                />
                <span>分</span>
              </div>
            </label>
            <label class="inspector-field">
              <span>结束时间</span>
              <div class="time-parts">
                <el-input-number
                  :model-value="Math.floor(toMinutes(selected.endTime) / 60)"
                  :min="0"
                  :max="23"
                  :controls="false"
                  :disabled="!canEdit || selected.timeType === 'DIVIDER'"
                  aria-label="结束小时"
                  @update:model-value="setTimePart('end', 'hour', $event ?? undefined)"
                />
                <span>时</span>
                <el-input-number
                  :model-value="toMinutes(selected.endTime) % 60"
                  :min="0"
                  :max="59"
                  :controls="false"
                  :disabled="!canEdit || selected.timeType === 'DIVIDER'"
                  aria-label="结束分钟"
                  @update:model-value="setTimePart('end', 'minute', $event ?? undefined)"
                />
                <span>分</span>
              </div>
            </label>
            <div class="inspector-field">
              <span>类型</span>
              <div class="type-switch">
                <button
                  v-for="type in TIME_POINT_TYPES"
                  :key="type"
                  :class="{ active: selected.timeType === type }"
                  :disabled="!canEdit"
                  @click="setType(type)"
                >
                  <ArchiveIcon :name="TYPE_ICONS[type]" />
                  {{ TYPE_LABELS[type] }}
                </button>
              </div>
            </div>
            <label v-if="selected.timeType === 'BREAK'" class="inspector-field">
              <span>课间名称</span>
              <el-input v-model="selected.breakName" :disabled="!canEdit" placeholder="课间休息" />
            </label>
            <label v-if="selected.timeType === 'LESSON'" class="inspector-field">
              <span>默认课程</span>
              <el-select
                v-model="selected.defaultClassId"
                :disabled="!canEdit || globalLayout"
                clearable
                placeholder="不设置"
              >
                <el-option
                  v-for="course in courses"
                  :key="course.id"
                  :value="course.id"
                  :label="course.name"
                />
              </el-select>
            </label>
            <p v-if="selected.timeType === 'LESSON' && globalLayout" class="hint">
              全校时间表供多个班级共用，默认课程请在班级时间表中设置。
            </p>
            <el-checkbox
              v-if="selected.timeType === 'LESSON'"
              v-model="selected.isHideDefault"
              :disabled="!canEdit"
              class="inspector-check"
            >
              默认隐藏
            </el-checkbox>
            <p v-if="selected.timeType === 'LESSON' && selected.isHideDefault" class="hint">
              启用后只有轮到这个时间点时才会在主界面显示。
            </p>
            <button
              v-if="selected.timeType === 'LESSON' && selected.defaultClassId && !globalLayout"
              class="command wide"
              :disabled="!canEdit"
              @click="applyDefault"
            >
              <ArchiveIcon name="transfer" />
              覆盖现有课程
            </button>
            <label v-if="selected.timeType === 'ACTION'" class="inspector-field">
              <span>行动配置（JSON）</span>
              <el-input
                v-model="selected.actionSet"
                type="textarea"
                :rows="5"
                :disabled="!canEdit"
                placeholder="行动配置 JSON（仅保存）"
              />
            </label>
            <p class="hint">课间休息与默认隐藏的时间点折叠时完全隐藏，轮到它才展开。</p>
          </template>
          <p v-else class="inspector-empty">选中时间点以编辑</p>
        </aside>
      </div>

      <footer class="layout-footer">
        <section class="durations" :class="{ collapsed: !durationsOpen }">
          <button class="durations-toggle" @click="durationsOpen = !durationsOpen">
            时间点时长
            <ArchiveIcon name="chevron" :class="{ flipped: durationsOpen }" />
          </button>
          <div v-if="durationsOpen" class="duration-fields">
            <label>
              默认上课时间点时长
              <el-input-number v-model="lessonMinutes" :min="1" :max="180" :controls="false" />
              <span>分钟</span>
            </label>
            <label>
              默认课间时间点时长
              <el-input-number v-model="breakMinutes" :min="1" :max="120" :controls="false" />
              <span>分钟</span>
            </label>
          </div>
        </section>
        <div class="view-switch">
          <button
            class="icon-command"
            :class="{ active: view === 'list' }"
            aria-label="列表视图"
            :aria-pressed="view === 'list'"
            @click="view = 'list'"
          >
            <ArchiveIcon name="list" />
          </button>
          <button
            class="icon-command"
            :class="{ active: view === 'timeline' }"
            aria-label="时间轴视图"
            :aria-pressed="view === 'timeline'"
            @click="view = 'timeline'"
          >
            <ArchiveIcon name="timeline" />
          </button>
          <span class="command-separator" />
          <button class="icon-command" aria-label="缩小" :disabled="zoom <= 50" @click="zoomBy(-25)">
            <ArchiveIcon name="zoom-out" />
          </button>
          <span class="zoom-label">{{ zoom }}%</span>
          <button class="icon-command" aria-label="放大" :disabled="zoom >= 400" @click="zoomBy(25)">
            <ArchiveIcon name="zoom-in" />
          </button>
          <button class="command small" aria-label="重置缩放" @click="zoom = 100">100%</button>
        </div>
      </footer>
    </main>

    <el-dialog v-model="infoVisible" title="时间表信息" width="440px" class="layout-info">
      <el-form v-if="layout" label-position="top">
        <el-form-item label="名称">
          <el-input v-model="layout.name" :disabled="!canEdit" maxlength="64" />
        </el-form-item>
        <el-form-item label="范围">
          <span>{{ layout.classId ? '班级时间表' : '全校时间表' }}</span>
        </el-form-item>
        <el-form-item label="引用课表">
          <span>{{ planCount }} 张</span>
        </el-form-item>
        <el-form-item label="从其他时间表导入时间点">
          <div class="import-row">
            <el-select v-model="importSource" placeholder="选择来源时间表" clearable>
              <el-option
                v-for="item in layouts.filter((item) => item.id !== layout?.id)"
                :key="item.id"
                :value="item.id"
                :label="item.name"
              />
            </el-select>
            <el-button :disabled="!canEdit || !importSource" @click="emit('import-points', importSource)">
              导入
            </el-button>
          </div>
        </el-form-item>
      </el-form>
      <p class="hint">上课提醒、课程显示与天气提醒由客户端本机设置，不随服务端时间表保存。</p>
    </el-dialog>
  </div>
</template>

<style scoped>
.layout-workspace {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.layout-explorer {
  display: flex;
  flex: 0 0 210px;
  width: 210px;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  overflow: auto;
  border-right: 1px solid var(--ch-border);
}
.explorer-actions {
  display: flex;
  gap: 4px;
}
.layout-explorer .command {
  flex: 1;
  justify-content: flex-start;
}
.plan-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  width: 100%;
  padding: 9px 10px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--ch-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.plan-item strong {
  overflow: hidden;
  max-width: 100%;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plan-item small {
  color: var(--ch-text-muted);
  font-size: var(--el-font-size-extra-small);
  line-height: 1.4;
}
.plan-item:hover,
.plan-item.active {
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
}
.layout-explorer :deep(.el-input) {
  width: 100%;
}
.layout-main {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
}
.layout-toolbar {
  display: flex;
  flex-shrink: 0;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  min-height: 48px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--ch-border);
}
.command {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 32px;
  padding: 6px 9px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--ch-text-secondary);
  font: inherit;
  cursor: pointer;
  white-space: nowrap;
}
.command .archive-icon {
  width: 17px;
  height: 17px;
}
.command:hover:not(:disabled) {
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
}
.command:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.command.primary {
  background: var(--el-color-primary);
  color: #fff;
}
.command.primary:hover:not(:disabled) {
  background: var(--el-color-primary-dark-2);
  color: #fff;
}
.command.danger {
  color: var(--el-color-danger);
}
.command.small {
  min-height: 28px;
  padding: 3px 6px;
}
.command.wide {
  justify-content: flex-start;
  width: 100%;
  border: 1px solid var(--ch-border);
}
.command-separator {
  flex: 0 0 1px;
  height: 22px;
  margin: 0 3px;
  background: var(--ch-border);
}
.tl-body {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.layout-canvas {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
}
.panel-empty {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 240px;
  color: var(--ch-text-muted);
}
.point-list {
  flex: 1;
  min-height: 0;
  padding: 8px 12px 16px;
  overflow: auto;
}
.time-point-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 46px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--ch-border);
  cursor: pointer;
}
.time-point-row:hover {
  background: var(--ch-surface-alt);
}
.time-point-row.selected {
  background: var(--el-color-primary-light-9);
}
.time-point-row.break {
  color: var(--ch-text-secondary);
}
.drag {
  padding: 6px 2px;
  border: 0;
  background: transparent;
  color: var(--ch-text-muted);
  cursor: grab;
  touch-action: none;
}
.type-icon {
  width: 18px;
  height: 18px;
  color: var(--ch-text-secondary);
}
.point-time {
  min-width: 112px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.point-name {
  flex: 1;
  min-width: 90px;
}
.point-duration {
  min-width: 80px;
  color: var(--ch-text-muted);
  font-size: var(--el-font-size-small);
  white-space: nowrap;
}
.point-badge {
  padding: 1px 6px;
  border: 1px solid var(--ch-border);
  border-radius: 999px;
  color: var(--ch-text-muted);
  font-size: var(--el-font-size-extra-small);
  white-space: nowrap;
}
.point-badge.default {
  border-color: var(--el-color-primary-light-5);
  color: var(--el-color-primary);
}
.list-hint {
  padding: 24px 8px;
  color: var(--ch-text-muted);
}
.timeline {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.timeline-scroll {
  height: 100%;
  overflow: auto;
}
.timeline-canvas {
  position: relative;
  display: flex;
  min-height: 100%;
  padding-right: 8px;
}
.timeline-ruler {
  position: relative;
  flex: 0 0 58px;
  width: 58px;
  border-right: 1px solid var(--ch-border);
}
.timeline-tick {
  position: absolute;
  right: 6px;
  color: var(--ch-text-muted);
  font-size: var(--el-font-size-extra-small);
  font-variant-numeric: tabular-nums;
  transform: translateY(-50%);
  white-space: nowrap;
}
.timeline-blocks {
  position: relative;
  flex: 1;
  min-width: 0;
  margin-left: 8px;
  border-left: 1px solid var(--ch-border);
}
.time-block {
  position: absolute;
  right: 6px;
  left: 6px;
  display: flex;
  overflow: visible;
  align-items: center;
  padding: 2px 8px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: var(--el-color-primary-light-8);
  color: var(--el-color-primary-dark-2);
  cursor: pointer;
}
.time-block.break {
  background: var(--ch-surface-hover);
  color: var(--ch-text-secondary);
}
.time-block.action {
  background: var(--el-color-warning-light-8);
  color: var(--el-color-warning-dark-2);
}
.time-block.divider {
  right: 0;
  left: 0;
  padding: 0;
  min-height: 2px;
  border: 0;
  border-radius: 0;
  background: var(--ch-text-muted);
}
.time-block.selected {
  border-color: var(--el-color-primary);
  box-shadow: 0 0 0 1px var(--el-color-primary);
  z-index: 2;
}
.block-label {
  display: flex;
  overflow: hidden;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.block-label strong,
.block-label small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.block-label small {
  opacity: 0.8;
  font-variant-numeric: tabular-nums;
}
.handle {
  position: absolute;
  left: 50%;
  width: 14px;
  height: 14px;
  margin-left: -7px;
  border: 2px solid var(--el-color-primary);
  border-radius: 50%;
  background: #fff;
  cursor: ns-resize;
  touch-action: none;
}
.handle.start {
  top: -7px;
}
.handle.end {
  bottom: -7px;
}
.now-line {
  position: absolute;
  right: 0;
  left: 0;
  height: 1px;
  background: var(--el-color-danger);
  pointer-events: none;
  z-index: 3;
}
.now-line::before {
  content: '';
  position: absolute;
  left: -3px;
  top: -2px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--el-color-danger);
}
.point-inspector {
  display: flex;
  flex: 0 0 300px;
  width: 300px;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  overflow: auto;
  border-left: 1px solid var(--ch-border);
  background: var(--ch-surface-alt);
}
.point-inspector h3 {
  margin: 0;
  font-size: var(--el-font-size-base);
  font-weight: 600;
}
.inspector-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  color: var(--ch-text-secondary);
  font-size: var(--el-font-size-small);
}
.inspector-field :deep(.el-select) {
  width: 100%;
}
.time-parts {
  display: flex;
  align-items: center;
  gap: 6px;
}
.time-parts :deep(.el-input-number) {
  width: 76px;
}
.time-parts span {
  color: var(--ch-text-muted);
  font-size: var(--el-font-size-small);
}
.type-switch {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}
.type-switch button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-height: 34px;
  padding: 4px 6px;
  border: 1px solid var(--ch-border);
  border-radius: 8px;
  background: var(--ch-surface);
  color: var(--ch-text);
  font: inherit;
  cursor: pointer;
}
.type-switch button.active {
  border-color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
}
.type-switch button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
.type-switch .archive-icon {
  width: 16px;
  height: 16px;
}
.inspector-check {
  height: auto;
}
.hint {
  margin: 0;
  color: var(--ch-text-muted);
  font-size: var(--el-font-size-extra-small);
  line-height: 1.5;
}
.inspector-empty {
  color: var(--ch-text-muted);
}
.layout-footer {
  display: flex;
  flex-shrink: 0;
  align-items: flex-end;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 12px;
  border-top: 1px solid var(--ch-border);
}
.durations {
  min-width: 210px;
  padding: 8px 10px;
  border: 1px solid var(--ch-border);
  border-radius: 8px;
  background: var(--ch-surface);
}
.durations.collapsed {
  padding: 4px 8px;
}
.durations-toggle {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 2px;
  border: 0;
  background: transparent;
  color: var(--ch-text);
  font: inherit;
  font-weight: 500;
  cursor: pointer;
}
.durations-toggle .archive-icon {
  width: 16px;
  height: 16px;
  transition: transform 0.15s;
}
.durations-toggle .archive-icon.flipped {
  transform: rotate(180deg);
}
.duration-fields {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 6px;
}
.duration-fields label {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--ch-text-secondary);
  font-size: var(--el-font-size-small);
}
.duration-fields :deep(.el-input-number) {
  width: 68px;
}
.view-switch {
  display: flex;
  align-items: center;
  gap: 4px;
}
.icon-command {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 4px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--ch-text-secondary);
  cursor: pointer;
}
.icon-command:hover:not(:disabled),
.icon-command.active {
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
}
.icon-command:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}
.icon-command .archive-icon {
  width: 18px;
  height: 18px;
}
.zoom-label {
  min-width: 42px;
  color: var(--ch-text-secondary);
  font-size: var(--el-font-size-small);
  font-variant-numeric: tabular-nums;
  text-align: center;
}
.import-row {
  display: flex;
  gap: 8px;
  width: 100%;
}
.import-row :deep(.el-select) {
  flex: 1;
}
@media (max-width: 1180px) {
  .layout-explorer {
    flex-basis: 170px;
    width: 170px;
  }
  .point-inspector {
    flex-basis: 260px;
    width: 260px;
    padding: 10px;
  }
  .point-duration,
  .point-badge {
    display: none;
  }
}
@media (max-width: 768px) {
  .layout-workspace {
    flex-direction: column;
  }
  .layout-explorer {
    width: 100%;
    flex: 0 0 120px;
    border-right: 0;
    border-bottom: 1px solid var(--ch-border);
  }
  .tl-body {
    flex-direction: column;
  }
  .point-inspector {
    width: 100%;
    flex: 0 0 auto;
    max-height: 260px;
    border-top: 1px solid var(--ch-border);
    border-left: 0;
  }
  .layout-footer {
    flex-wrap: wrap;
  }
}
</style>
