<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import {
  SOCKET_EVENTS,
  WEEKDAYS,
  WEEKDAY_LABELS,
  WEEK_PARITY_LABELS,
  buildWeekOptions,
  formatWeekRange,
  resolveClassStatus,
  timeToMinutes,
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
/** 时间轴 / 周视图 切换（默认时间轴，对齐 ClassIsland 的"今天"观感） */
const activeTab = ref<'today' | 'week'>('today');

/** 当前时刻（每秒刷新，用于大时钟与"进行中/倒计时"） */
const now = ref(new Date());
let clockTimer: ReturnType<typeof setInterval> | null = null;

const todayWeekday = computed(() => {
  const day = now.value.getDay();
  return day === 0 ? 7 : day;
});

const clockText = computed(() =>
  now.value.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }),
);
const clockSeconds = computed(() => String(now.value.getSeconds()).padStart(2, '0'));
const dateText = computed(() =>
  now.value.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }),
);
const weekdayText = computed(() => WEEKDAY_LABELS[todayWeekday.value] ?? '');

/** 查看的是否为当前教学周（只有当前周才计算"进行中"） */
const isCurrentWeek = computed(() => week.value === appStore.currentWeek);

const todayItems = computed(() =>
  [...items.value]
    .filter((item) => item.dayOfWeek === todayWeekday.value)
    .sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime)),
);

const classStatus = computed(() =>
  isCurrentWeek.value
    ? resolveClassStatus(todayItems.value, now.value, week.value)
    : { inClass: false, current: null, next: null },
);

type LessonState = 'past' | 'current' | 'next' | 'upcoming';

interface TimelineLesson {
  id: string;
  start: string;
  end: string;
  course: string;
  location: string;
  weekRange: string;
  /** 单双周标签（'单周' / '双周'；每周的课为空串） */
  parityLabel: string;
  state: LessonState;
  /** 进行中：距下课剩余；下一节：距上课剩余（分钟） */
  remainMinutes: number;
  /** 进行中：本节课进度 0~100 */
  progress: number;
}

const timeline = computed<TimelineLesson[]>(() =>
  todayItems.value.map((item) => {
    const start = timeToMinutes(item.startTime);
    const end = timeToMinutes(item.endTime);
    const nowMinutes = now.value.getHours() * 60 + now.value.getMinutes();
    const isCurrent =
      isCurrentWeek.value && classStatus.value.current?.scheduleId === item.id && nowMinutes < end;
    const isNext = isCurrentWeek.value && classStatus.value.next?.scheduleId === item.id;
    const state: LessonState = isCurrent
      ? 'current'
      : nowMinutes >= end
        ? 'past'
        : isNext
          ? 'next'
          : 'upcoming';
    return {
      id: item.id,
      start: item.startTime,
      end: item.endTime,
      course: item.course?.name ?? '课程',
      location: item.location ?? '未填地点',
      weekRange: formatWeekRange(item.weekStart, item.weekEnd),
      /** 单双周标签（每周的课不显示） */
      parityLabel: (item.weekParity ?? 'ALL') === 'ALL' ? '' : WEEK_PARITY_LABELS[item.weekParity],
      state,
      remainMinutes: state === 'current' ? end - nowMinutes : start - nowMinutes,
      progress: state === 'current' ? Math.round(((nowMinutes - start) / Math.max(1, end - start)) * 100) : 0,
    };
  }),
);

/** 头部摘要：正在上课 / 下一节 */
const headline = computed(() => {
  const status = classStatus.value;
  if (status.current) {
    return {
      title: `正在上 ${status.current.courseName}`,
      detail: `${status.current.startTime}-${status.current.endTime}${status.current.location ? ` · ${status.current.location}` : ''}`,
      remain: timeline.value.find((item) => item.state === 'current')?.remainMinutes ?? 0,
      kind: 'current' as const,
    };
  }
  if (status.next) {
    const remain = timeline.value.find((item) => item.state === 'next')?.remainMinutes ?? 0;
    return {
      title: `下一节 ${status.next.courseName}`,
      detail: `${status.next.startTime} 开始${status.next.location ? ` · ${status.next.location}` : ''}`,
      remain,
      kind: 'next' as const,
    };
  }
  return {
    title: todayItems.value.length > 0 ? '今天的课都上完了' : '今天没有课程安排',
    detail: todayItems.value.length > 0 ? '好好休息一下，别忘了复习' : '可以看看作业和通知',
    remain: 0,
    kind: 'idle' as const,
  };
});

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

const courseCount = computed(() => new Set(items.value.map((item) => item.courseId)).size);

function remainText(minutes: number): string {
  if (minutes <= 0) return '即将下课';
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}

async function loadTerm(): Promise<void> {
  // 带 classId：周次上限取本班"教学周数"（班主任可调，默认 20 周）
  const result = await fetchWithCache('classes', 'term', () => dashboardApi.term(auth.classId ?? undefined), {
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
  clockTimer = setInterval(() => {
    now.value = new Date();
  }, 1000);
  realtime.on(SOCKET_EVENTS.scheduleUpdated, onScheduleEvent);
  appStore.onServerRecovered(onRecovered);
});

onUnmounted(() => {
  if (clockTimer) clearInterval(clockTimer);
  clockTimer = null;
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
          第 {{ week }} 周 · 今天 {{ todayItems.length }} 节 · 本周共 {{ items.length }} 节 ·
          {{ courseCount }} 门课程
          <el-tag v-if="fromCache" class="ml-8" size="small" type="warning" effect="plain">离线缓存</el-tag>
        </p>
      </div>
      <div class="toolbar">
        <el-select v-model="week" style="width: 118px" @change="loadSchedules">
          <el-option v-for="item in weekOptions" :key="item" :label="`第 ${item} 周`" :value="item" />
        </el-select>
        <el-button :icon="'ArrowLeft'" :disabled="week <= 1" @click="changeWeek(-1)" />
        <el-button :disabled="week >= appStore.maxWeek" @click="changeWeek(1)">
          <el-icon><ArrowRight /></el-icon>
        </el-button>
        <el-button :icon="'Refresh'" @click="loadSchedules">刷新</el-button>
      </div>
    </div>

    <el-tabs v-model="activeTab" class="schedule-tabs">
      <!-- ---------------------------------------------------- 今天（时间轴） -->
      <el-tab-pane label="今天" name="today">
        <div class="hero">
          <div class="hero-clock">
            <span class="clock-main">{{ clockText }}</span>
            <span class="clock-seconds">{{ clockSeconds }}</span>
          </div>
          <div class="hero-meta">
            <div class="hero-date">{{ dateText }} · {{ weekdayText }}</div>
            <div class="hero-week">第 {{ week }} 教学周{{ isCurrentWeek ? '' : '（查看中）' }}</div>
          </div>
          <div class="hero-status" :class="`status-${headline.kind}`">
            <div class="status-title">{{ headline.title }}</div>
            <div class="status-detail">{{ headline.detail }}</div>
            <div v-if="headline.kind !== 'idle'" class="status-remain">
              {{ headline.kind === 'current' ? '距下课' : '距上课' }} {{ remainText(headline.remain) }}
            </div>
          </div>
        </div>

        <el-card v-loading="loading" shadow="never" class="timeline-card">
          <el-empty v-if="timeline.length === 0" description="今天没有课程安排" :image-size="90" />
          <ul v-else class="timeline">
            <li
              v-for="lesson in timeline"
              :key="lesson.id"
              class="timeline-item"
              :class="`is-${lesson.state}`"
              :data-state="lesson.state"
            >
              <div class="timeline-time">
                <span class="time-start">{{ lesson.start }}</span>
                <span class="time-end">{{ lesson.end }}</span>
              </div>
              <div class="timeline-rail" aria-hidden="true"><span class="rail-dot"></span></div>
              <div class="timeline-card-inner">
                <div class="lesson-head">
                  <span class="lesson-course">{{ lesson.course }}</span>
                  <el-tag v-if="lesson.state === 'current'" size="small" effect="dark" class="lesson-tag">
                    正在上课
                  </el-tag>
                  <el-tag
                    v-else-if="lesson.state === 'next'"
                    size="small"
                    type="warning"
                    effect="plain"
                    class="lesson-tag"
                  >
                    下一节 · {{ remainText(lesson.remainMinutes) }}后
                  </el-tag>
                  <el-tag
                    v-else-if="lesson.state === 'past'"
                    size="small"
                    type="info"
                    effect="plain"
                    class="lesson-tag"
                  >
                    已结束
                  </el-tag>
                </div>
                <div class="lesson-meta">
                  <span>{{ lesson.location }}</span>
                  <span class="lesson-sep">·</span>
                  <span>{{ lesson.weekRange }}</span>
                  <!-- 单双周：只有单周/双周上的课才打标签，避免"每周"的课被噪音刷屏 -->
                  <template v-if="lesson.parityLabel">
                    <span class="lesson-sep">·</span>
                    <el-tag size="small" effect="plain" class="lesson-parity">
                      {{ lesson.parityLabel }}
                    </el-tag>
                  </template>
                  <template v-if="lesson.state === 'current'">
                    <span class="lesson-sep">·</span>
                    <span class="lesson-remain">距下课 {{ remainText(lesson.remainMinutes) }}</span>
                  </template>
                </div>
                <el-progress
                  v-if="lesson.state === 'current'"
                  class="lesson-progress"
                  :percentage="lesson.progress"
                  :stroke-width="4"
                  :show-text="false"
                  color="#ffffff"
                />
              </div>
            </li>
          </ul>
        </el-card>
      </el-tab-pane>

      <!-- ---------------------------------------------------- 本周（周视图） -->
      <el-tab-pane label="本周" name="week">
        <el-card v-loading="loading" shadow="never" class="table-card">
          <el-empty v-if="periods.length === 0" description="该周暂无课程安排" />
          <el-table v-else :data="periods" border size="small">
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
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<style scoped>
.schedule-tabs :deep(.el-tabs__header) {
  margin-bottom: 12px;
}

/* ------------------------------------------------------------ 顶部概览卡（ClassIsland 的"当前课"卡片） */

.hero {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 16px 20px;
  margin-bottom: 12px;
  border: 1px solid var(--ch-border);
  border-radius: var(--ch-radius-card);
  background: var(--ch-layer);
  backdrop-filter: blur(20px) saturate(1.1);
  box-shadow: var(--ch-shadow-card);
}

.hero-clock {
  display: flex;
  align-items: baseline;
  gap: 2px;
  min-width: 118px;
}

.clock-main {
  font-size: 40px;
  font-weight: 600;
  letter-spacing: -1px;
  font-variant-numeric: tabular-nums;
  line-height: 1;
}

.clock-seconds {
  font-size: 14px;
  color: var(--ch-text-tertiary);
  font-variant-numeric: tabular-nums;
}

.hero-meta {
  flex: 0 0 auto;
  padding-right: 18px;
  border-right: 1px solid var(--ch-divider);
}

.hero-date {
  font-size: 13.5px;
  font-weight: 600;
}

.hero-week {
  margin-top: 4px;
  font-size: 12px;
  color: var(--ch-text-secondary);
}

.hero-status {
  flex: 1;
  min-width: 0;
  padding: 10px 14px;
  border-radius: var(--ch-radius-control);
  background: var(--ch-accent-soft);
}

.hero-status.status-current {
  background: linear-gradient(135deg, var(--ch-accent) 0%, #2b7fc4 100%);
  color: #fff;
}

.hero-status.status-idle {
  background: rgba(0, 0, 0, 0.03);
}

.status-title {
  font-size: 15px;
  font-weight: 600;
}

.status-detail {
  margin-top: 3px;
  font-size: 12.5px;
  opacity: 0.85;
}

.status-remain {
  margin-top: 6px;
  font-size: 12.5px;
  font-weight: 600;
}

.hero-status.status-current .status-detail,
.hero-status.status-current .status-remain {
  opacity: 0.92;
}

/* ------------------------------------------------------------ 时间轴 */

.timeline-card :deep(.el-card__body) {
  padding: 8px 16px 12px !important;
}

.timeline {
  margin: 0;
  padding: 0;
  list-style: none;
}

.timeline-item {
  display: flex;
  align-items: stretch;
  gap: 0;
  padding: 8px 0;
}

.timeline-time {
  flex: 0 0 66px;
  padding-top: 10px;
  text-align: right;
  padding-right: 12px;
}

.time-start {
  display: block;
  font-size: 15px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.time-end {
  display: block;
  font-size: 11.5px;
  color: var(--ch-text-tertiary);
  font-variant-numeric: tabular-nums;
}

/* 竖向轨道 + 节点：ClassIsland 时间轴的标志性观感 */
.timeline-rail {
  position: relative;
  flex: 0 0 18px;
  display: flex;
  justify-content: center;
}

.timeline-rail::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: -16px;
  width: 2px;
  background: var(--ch-divider);
}

.timeline-item:last-child .timeline-rail::before {
  bottom: 50%;
}

.rail-dot {
  position: relative;
  z-index: 1;
  margin-top: 14px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #fff;
  border: 2px solid var(--ch-border-strong);
}

.timeline-item.is-current .rail-dot {
  border-color: var(--ch-accent);
  background: var(--ch-accent);
  box-shadow: 0 0 0 4px var(--ch-accent-soft-strong);
}

.timeline-item.is-past .rail-dot {
  border-color: var(--ch-border);
  background: var(--ch-bg);
}

.timeline-card-inner {
  flex: 1;
  min-width: 0;
  padding: 10px 14px;
  border: 1px solid var(--ch-border);
  border-radius: var(--ch-radius-card);
  background: rgba(255, 255, 255, 0.6);
  transition:
    border-color 0.15s ease,
    background 0.15s ease,
    transform 0.15s ease;
}

.timeline-item:hover .timeline-card-inner {
  border-color: var(--ch-border-strong);
  transform: translateY(-1px);
}

/* 正在进行：强调色实底（ClassIsland 用它突出"当前课"） */
.timeline-item.is-current .timeline-card-inner {
  border-color: transparent;
  color: #fff;
  background: linear-gradient(135deg, var(--ch-accent) 0%, #2b7fc4 100%);
  box-shadow: 0 4px 12px rgba(15, 108, 189, 0.28);
}

.timeline-item.is-past .timeline-card-inner {
  background: rgba(255, 255, 255, 0.35);
  color: var(--ch-text-tertiary);
}

.lesson-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.lesson-course {
  font-size: 15px;
  font-weight: 600;
}

.lesson-tag {
  margin-left: auto;
}

.lesson-meta {
  margin-top: 5px;
  font-size: 12.5px;
  color: var(--ch-text-secondary);
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.timeline-item.is-current .lesson-meta {
  color: rgba(255, 255, 255, 0.9);
}

.timeline-item.is-past .lesson-meta {
  color: var(--ch-text-tertiary);
}

.lesson-sep {
  opacity: 0.5;
}

/* 单双周标签：比正文小一号，颜色跟随主题色，避免抢标题 */
.lesson-parity {
  height: 18px;
  padding: 0 6px;
  font-size: 11px;
  color: var(--ch-accent, #409eff);
  border-color: currentColor;
}

.lesson-remain {
  font-weight: 600;
}

.lesson-progress {
  margin-top: 8px;
}

.lesson-progress :deep(.el-progress-bar__outer) {
  background: rgba(255, 255, 255, 0.28);
}

@media (max-width: 720px) {
  .hero {
    flex-wrap: wrap;
    gap: 12px;
  }

  .hero-meta {
    border-right: none;
    padding-right: 0;
  }
}
</style>
