<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import * as echarts from 'echarts';
import {
  SOCKET_EVENTS,
  averageOf,
  formatDate,
  gradeLevel,
  gradePercent,
  type GradeDto,
} from '@classhelper/shared';
import { gradeApi } from '../api/index.js';
import { fetchWithCache } from '../cache/index.js';
import { useAppStore } from '../stores/app.js';
import { useRealtimeStore } from '../stores/realtime.js';

const appStore = useAppStore();
const realtime = useRealtimeStore();

const loading = ref(false);
const grades = ref<GradeDto[]>([]);
const fromCache = ref(false);
const updatedAt = ref<number | null>(null);
const chartRef = ref<HTMLDivElement>();
let chart: ReturnType<typeof echarts.init> | null = null;

const averagePercent = computed(() =>
  grades.value.length === 0
    ? 0
    : averageOf(grades.value.map((item) => gradePercent(item.score, item.totalScore))),
);

const bestGrade = computed(() => {
  if (grades.value.length === 0) return null;
  return grades.value.reduce((best, item) =>
    gradePercent(item.score, item.totalScore) > gradePercent(best.score, best.totalScore) ? item : best,
  );
});

const latestGrades = computed(() =>
  [...grades.value].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, 5),
);

const levelCounts = computed(() => {
  const levels: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  for (const item of grades.value) {
    levels[gradeLevel(gradePercent(item.score, item.totalScore))] =
      (levels[gradeLevel(gradePercent(item.score, item.totalScore))] ?? 0) + 1;
  }
  return levels;
});

async function loadGrades(): Promise<void> {
  loading.value = true;
  try {
    const result = await fetchWithCache<GradeDto[]>('grades', 'my', () => gradeApi.my(), []);
    grades.value = result.data;
    fromCache.value = result.fromCache;
    updatedAt.value = result.updatedAt;
    if (!result.fromCache) appStore.markSynced();
    renderChart();
  } finally {
    loading.value = false;
  }
}

function renderChart(): void {
  if (!chartRef.value) return;
  chart ??= echarts.init(chartRef.value);

  // 按考试聚合平均得分率（最近 8 次考试）
  const byExam = new Map<string, number[]>();
  for (const item of grades.value) {
    const bucket = byExam.get(item.examName) ?? [];
    bucket.push(gradePercent(item.score, item.totalScore));
    byExam.set(item.examName, bucket);
  }
  const exams = [...byExam.entries()].slice(-8);

  chart.setOption({
    tooltip: { trigger: 'axis' },
    grid: { left: 44, right: 18, top: 30, bottom: 34 },
    xAxis: {
      type: 'category',
      data: exams.map(([name]) => name),
      axisLabel: { interval: 0, rotate: exams.length > 4 ? 20 : 0, fontSize: 11 },
    },
    yAxis: { type: 'value', max: 100, name: '得分率%' },
    series: [
      {
        type: 'bar',
        barMaxWidth: 46,
        itemStyle: { color: '#409eff', borderRadius: [4, 4, 0, 0] },
        label: { show: true, position: 'top', formatter: '{c}%', fontSize: 11 },
        data: exams.map(([, percents]) => averageOf(percents)),
      },
    ],
  });
}

function handleResize(): void {
  chart?.resize();
}

function onGradeEvent(): void {
  void loadGrades();
}

function onRecovered(): void {
  void loadGrades();
}

onMounted(async () => {
  await loadGrades();
  window.addEventListener('resize', handleResize);
  realtime.on(SOCKET_EVENTS.gradeUpdated, onGradeEvent);
  appStore.onServerRecovered(onRecovered);
});

onUnmounted(() => {
  window.removeEventListener('resize', handleResize);
  chart?.dispose();
  chart = null;
  realtime.off(SOCKET_EVENTS.gradeUpdated, onGradeEvent);
  appStore.offServerRecovered(onRecovered);
});
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">我的成绩</h2>
        <p class="page-subtitle">
          共 {{ grades.length }} 条记录 · 平均得分率 {{ averagePercent }}%
          <el-tag v-if="fromCache" size="small" type="warning" effect="plain">离线缓存</el-tag>
        </p>
      </div>
      <div class="toolbar">
        <el-button :icon="'Refresh'" @click="loadGrades">刷新</el-button>
      </div>
    </div>

    <el-row :gutter="12">
      <el-col :xs="24" :md="8">
        <div class="stat-card">
          <div class="stat-label">平均得分率</div>
          <div class="stat-value">{{ averagePercent }}%</div>
          <div class="stat-hint">共 {{ grades.length }} 次记录</div>
        </div>
        <div class="stat-card mt-12">
          <div class="stat-label">最好成绩</div>
          <div class="stat-value">
            {{ bestGrade ? `${bestGrade.score}/${bestGrade.totalScore}` : '-' }}
          </div>
          <div class="stat-hint">{{ bestGrade?.examName ?? '暂无数据' }}</div>
        </div>
        <div class="stat-card mt-12">
          <div class="stat-label">等级分布</div>
          <div class="level-list">
            <el-tag v-for="(count, level) in levelCounts" :key="level" effect="plain">
              {{ level }} 等：{{ count }}
            </el-tag>
          </div>
        </div>
      </el-col>

      <el-col :xs="24" :md="16">
        <el-card v-loading="loading" shadow="never">
          <template #header><span>各次考试平均得分率</span></template>
          <div ref="chartRef" class="chart"></div>
        </el-card>
      </el-col>
    </el-row>

    <el-card shadow="never" class="mt-16">
      <template #header><span>成绩明细</span></template>
      <el-table :data="grades" empty-text="暂无成绩" max-height="420">
        <el-table-column prop="examName" label="考试" min-width="150" />
        <el-table-column label="课程" width="110">
          <template #default="{ row }">{{ row.course?.name ?? '-' }}</template>
        </el-table-column>
        <el-table-column label="分数" width="130">
          <template #default="{ row }">{{ row.score }} / {{ row.totalScore }}</template>
        </el-table-column>
        <el-table-column label="得分率" width="200">
          <template #default="{ row }">
            <el-progress
              :percentage="gradePercent(row.score, row.totalScore)"
              :stroke-width="10"
              :status="gradePercent(row.score, row.totalScore) >= 60 ? 'success' : 'exception'"
            />
          </template>
        </el-table-column>
        <el-table-column label="等级" width="80">
          <template #default="{ row }">
            {{ gradeLevel(gradePercent(row.score, row.totalScore)) }}
          </template>
        </el-table-column>
        <el-table-column label="发布时间" width="170">
          <template #default="{ row }">{{ formatDate(row.publishedAt, true) }}</template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card v-if="latestGrades.length > 0" shadow="never" class="mt-16">
      <template #header><span>最近更新</span></template>
      <el-timeline>
        <el-timeline-item
          v-for="item in latestGrades"
          :key="item.id"
          :timestamp="formatDate(item.publishedAt, true)"
          placement="top"
        >
          {{ item.examName }} · {{ item.course?.name ?? '未关联课程' }}：
          <strong>{{ item.score }}/{{ item.totalScore }}</strong>
        </el-timeline-item>
      </el-timeline>
    </el-card>
  </div>
</template>

<style scoped>
.stat-card {
  background: #fff;
  border: 1px solid var(--ch-border);
  border-radius: 10px;
  padding: 16px;
}

.stat-label {
  font-size: 13px;
  color: #909399;
}

.stat-value {
  margin-top: 6px;
  font-size: 26px;
  font-weight: 700;
}

.stat-hint {
  margin-top: 4px;
  font-size: 12px;
  color: #c0c4cc;
}

.level-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.chart {
  width: 100%;
  height: 300px;
}
</style>
