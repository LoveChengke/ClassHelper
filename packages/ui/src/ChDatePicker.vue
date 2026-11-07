<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useAttrs, watch } from 'vue';
import { ElDatePicker } from 'element-plus';
import { localDay, visibleCalendarRange, type CalendarRange, type DateMark } from './calendar';
defineOptions({ inheritAttrs: false });
const props = withDefaults(
  defineProps<{
    marks?: readonly DateMark[];
    loadMarks?: (range: CalendarRange) => Promise<DateMark[]>;
    scopeKey?: string;
  }>(),
  { marks: () => [], loadMarks: undefined, scopeKey: '' },
);
const attrs = useAttrs();
const valueFormat = computed(() =>
  typeof attrs['value-format'] === 'string'
    ? attrs['value-format']
    : attrs.type === 'datetime' || attrs.type === 'datetimerange'
      ? 'YYYY-MM-DD HH:mm:ss'
      : 'YYYY-MM-DD',
);
const remote = ref<DateMark[]>([]),
  visible = ref(false),
  loading = ref(false);
let revision = 0;
let range = visibleCalendarRange(undefined);
const counts = computed(
  () => new Map([...remote.value, ...props.marks].map((item) => [item.date, item.count])),
);
function dateKey(value: unknown): string {
  return value instanceof Date && Number.isFinite(value.getTime()) ? localDay(value) : '';
}
async function refresh(): Promise<void> {
  const current = ++revision;
  if (!props.loadMarks) return;
  loading.value = true;
  try {
    const marks = await props.loadMarks(range);
    if (current === revision) remote.value = marks;
  } catch {
    // 日历统计失败不阻断日期选择，离线回退由业务缓存负责。
    if (current === revision) remote.value = [];
  } finally {
    if (current === revision) loading.value = false;
  }
}
function onVisible(open: boolean): void {
  visible.value = open;
  if (open) {
    range = visibleCalendarRange(attrs.modelValue ?? attrs['model-value']);
    void refresh();
  }
}
function onPanel(value: unknown): void {
  range = visibleCalendarRange(value);
  void refresh();
}
watch(
  () => props.scopeKey,
  () => {
    ++revision;
    remote.value = [];
    if (visible.value) void refresh();
  },
);
onBeforeUnmount(() => {
  ++revision;
});
</script>

<template>
  <ElDatePicker
    v-bind="$attrs"
    :value-format="valueFormat"
    popper-class="ch-calendar"
    @visible-change="onVisible"
    @panel-change="onPanel"
  >
    <template #default="cell">
      <div
        class="el-date-table-cell ch-calendar-day"
        :aria-label="`${cell.renderText ?? dateKey(cell.date)}${!cell.renderText && counts.get(dateKey(cell.date)) ? `，${counts.get(dateKey(cell.date))} 条记录` : ''}`"
        :title="
          !cell.renderText && counts.get(dateKey(cell.date))
            ? `${counts.get(dateKey(cell.date))} 条记录`
            : undefined
        "
      >
        <span class="el-date-table-cell__text">{{ cell.renderText ?? cell.text }}</span>
        <i v-if="!cell.renderText && counts.get(dateKey(cell.date))" class="ch-calendar-dot" />
      </div>
    </template>
    <template
      v-for="name in Object.keys($slots).filter((name) => name !== 'default')"
      :key="name"
      #[name]="slotProps"
    >
      <slot :name="name" v-bind="slotProps ?? {}" />
    </template>
  </ElDatePicker>
  <span v-if="loading" class="ch-sr-only" role="status">正在加载日期记录</span>
</template>
