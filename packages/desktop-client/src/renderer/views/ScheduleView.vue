<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import {
  SOCKET_EVENTS,
  WEEKDAYS,
  WEEKDAY_LABELS,
  buildWeekOptions,
  formatWeekRange,
  type ScheduleDto,
  type ScheduleWeekView,
} from '@classhelper/shared';
import { dashboardApi, scheduleApi } from '../api/index.js';
import { fetchWithCache } from '../cache/index.js';
import { useAppStore } from '../stores/app.js';
import { useAuthStore } from '../stores/auth.js';
import { useRealtimeStore } from '../stores/realtime.js';

const appStore = useAppStore();
const auth = useAuthStore();
const realtime = useRealtimeStore();

const loading = ref(false);
const grid = ref<ScheduleWeekView | null>(null);
const items = ref<ScheduleDto[]>([]);
const week = ref(appStore.currentWeek);
const fromCache = ref(false);
const updatedAt = ref<number | null>(null);
const weekOptions = ref<number[]>(buildWeekOptions(20));

const periods = computed(() => {
  const buckets = new Map<string, ScheduleDto[]>();
  for (const item of items.value) {
    const key = `${item.startTime}-${item.endTime}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(item);
    buckets.set(key, bucket);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, list]) => {
      const [start, end] = key.split('-');
      return { start: start ?? '', end: end ?? '', items: list };
    });
});

function cellItems(period: { items: ScheduleDto[] }, dayOfWeek: number): ScheduleDto[] {
  return period.items.filter((item) => item.dayOfWeek === dayOfWeek);
}

const todayWeekday = computed(() => {
  const day = new Date().getDay();
  return day === 0 ? 7 : day;
});

const courseCount = computed(() => new Set(items.value.map((item) => item.courseId)).size);

async function loadTerm(): Promise<void> {
  const result = await fetchWithCache('classes', 'term', () => dashboardApi.term(), {
    currentWeek: 1,
    maxWeek: 20,
  });
  appStore.currentWeek = result.data.currentWeek;
  appStore.maxWeek = result.data.maxWeek;
  weekOptions.value = buildWeekOptions(result.data.maxWeek);
  if (!week.value || week.value === 1) week.value = result.data.currentWeek;
}

async function loadSchedules(): Promise<void> {
  const classId = auth.classId ?? undefined;
  loading.value = true;
  try {
    const result = await fetchWithCache<ScheduleDto[]>(
      'schedules',
      `week:${week.value}`,
      () => scheduleApi.list({ classId, week: week.value }),
      [],
    );
    items.value = result.data;
    fromCache.value = result.fromCache;
    updatedAt.value = result.updatedAt;
    grid.value = {
      week: week.value,
      columns: WEEKDAYS.map((dayOfWeek) => ({
        dayOfWeek,
        label: WEEKDAY_LABELS[dayOfWeek] ?? '',
        items: result.data.filter((item) => item.dayOfWeek === dayOfWeek),
      })),
    };
    if (!result.fromCache) appStore.markSynced();
  } finally {
    loading.value = false;
  }
}

async function changeWeek(delta: number): Promise<void> {
  const next = week.value + delta;
  if (next < 1 || next > appStore.maxWeek) return;
  week.value = next;
  await loadSchedules();
}

function onScheduleEvent(): void {
  void loadSchedules();
}

function onRecovered(): void {
  void loadSchedules();
}

onMounted(async () => {
  await loadTerm();
  await loadSchedules();
  realtime.on(SOCKET_EVENTS.scheduleUpdated, onScheduleEvent);
  appStore.onServerRecovered(onRecovered);
});

onUnmounted(() => {
  realtime.off(SOCKET_EVENTS.scheduleUpdated, onScheduleEvent);
  appStore.offServerRecovered(onRecovered);
});
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">我的课表</h2>
        <p class="page-subtitle">
          第 {{ week }} 周 · 共 {{ items.length }} 节课 · {{ courseCount }} 门课程
          <el-tag v-if="fromCache" class="mt-12" size="small" type="warning" effect="plain">离线缓存</el-tag>
        </p>
      </div>
      <div class="toolbar">
        <el-button :icon="'ArrowLeft'" :disabled="week <= 1" @click="changeWeek(-1)">上一周</el-button>
        <el-select v-model="week" style="width: 120px" @change="loadSchedules">
          <el-option v-for="item in weekOptions" :key="item" :label="`第 ${item} 周`" :value="item" />
        </el-select>
        <el-button :disabled="week >= appStore.maxWeek" @click="changeWeek(1)">
          下一周
          <el-icon class="el-icon--right"><ArrowRight /></el-icon>
        </el-button>
        <el-button :icon="'Refresh'" @click="loadSchedules">刷新</el-button>
      </div>
    </div>

    <el-card v-loading="loading" shadow="never">
      <el-empty v-if="periods.length === 0" description="该周暂无课程安排" />
      <el-table v-else :data="periods" border size="small" :cell-class-name="() => ''">
        <el-table-column label="节次" width="110" fixed>
          <template #default="{ row }">
            <div>{{ row.start }}</div>
            <div class="timetable-meta">{{ row.end }}</div>
          </template>
        </el-table-column>
        <el-table-column
          v-for="day in WEEKDAYS"
          :key="day"
          :label="`${WEEKDAY_LABELS[day]}${day === todayWeekday ? ' · 今天' : ''}`"
          min-width="132"
        >
          <template #default="{ row }">
            <div v-for="item in cellItems(row, day)" :key="item.id" class="timetable-cell">
              <div class="timetable-course">{{ item.course?.name ?? '课程' }}</div>
              <div class="timetable-meta">{{ item.location ?? '未填地点' }}</div>
              <div class="timetable-meta">{{ formatWeekRange(item.weekStart, item.weekEnd) }}</div>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>
