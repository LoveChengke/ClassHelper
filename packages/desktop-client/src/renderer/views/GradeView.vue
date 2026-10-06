<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import {
  SOCKET_EVENTS,
  averageOf,
  formatDate,
  gradeLevel,
  gradePercent,
  type GradeDto,
  type StudentGradeDetailDto,
} from '@classhelper/shared';
import { gradeApi } from '../api/index.js';
import { fetchWithCache } from '../cache/index.js';
import ScoreBarChart from '../components/ScoreBarChart.vue';
import { useAppStore } from '../stores/app.js';
import { useAuthStore } from '../stores/auth.js';
import { useRealtimeStore } from '../stores/realtime.js';

const appStore = useAppStore();
/**
 * ClassHelper 班级端看到的是**全班成绩总览**（学生不是账号，登录主体就是班级），
 * 标题与副标题随会话类型变化。
 */
const auth = useAuthStore();
const realtime = useRealtimeStore();

const loading = ref(false);
const grades = ref<GradeDto[]>([]);
const fromCache = ref(false);
const updatedAt = ref<number | null>(null);

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

/**
 * 等级分布：优先用**库里存的等级**（教师可以手改、也可能是自定义等级），
 * 只有老数据没有等级时才按得分率现算 —— 否则教师在 Web 端改过的等级在这里会被"算回去"。
 */
const levelCounts = computed(() => {
  const levels: Record<string, number> = {};
  for (const item of grades.value) {
    const level = item.level || gradeLevel(gradePercent(item.score, item.totalScore));
    levels[level] = (levels[level] ?? 0) + 1;
  }
  return levels;
});

/* ------------------------------------------------------------ 按学号查成绩明细
 *
 * 学生没有账号、不能登录，因此"查自己的成绩"这件事由**教室机器**代做：
 * 输入学号 → 服务端返回该生的全部成绩明细（含等级）。
 * 是否开放由教师/管理员在班级里开关控制（关闭后服务端返回 403，这里直接提示原因）。
 */
const queryNo = ref('');
const queryLoading = ref(false);
const queried = ref<StudentGradeDetailDto | null>(null);
const queryError = ref('');

async function queryByStudentNo(): Promise<void> {
  const studentNo = queryNo.value.trim();
  if (!studentNo) return;
  queryLoading.value = true;
  queryError.value = '';
  queried.value = null;
  try {
    queried.value = await gradeApi.studentDetail(studentNo);
  } catch (error) {
    // 403 的文案由服务端给出（"本班未开放学生自助查询成绩，请联系老师开启"），原样展示最准确
    queryError.value = error instanceof Error ? error.message : '查询失败，请稍后重试';
  } finally {
    queryLoading.value = false;
  }
}

/**
 * 按考试聚合平均得分率（最近 8 次考试），交给 ScoreBarChart 渲染。
 * 这里原先调的是 `echarts.setOption(...)`；改用纯 CSS 柱状图是为了去掉
 * echarts（渲染产物里最大的一块，1.1MB）。聚合口径与之前完全一致。
 */
const examAverages = computed(() => {
  const byExam = new Map<string, number[]>();
  for (const item of grades.value) {
    const bucket = byExam.get(item.examName) ?? [];
    bucket.push(gradePercent(item.score, item.totalScore));
    byExam.set(item.examName, bucket);
  }
  return [...byExam.entries()].slice(-8).map(([label, percents]) => ({ label, value: averageOf(percents) }));
});

async function loadGrades(): Promise<void> {
  loading.value = true;
  try {
    const result = await fetchWithCache<GradeDto[]>('grades', 'my', () => gradeApi.my(), []);
    grades.value = result.data;
    fromCache.value = result.fromCache;
    updatedAt.value = result.updatedAt;
    if (!result.fromCache) appStore.markSynced();
  } finally {
    loading.value = false;
  }
}

function onGradeEvent(): void {
  void loadGrades();
}

function onRecovered(): void {
  void loadGrades();
}

onMounted(async () => {
  await loadGrades();
  realtime.on(SOCKET_EVENTS.gradeUpdated, onGradeEvent);
  appStore.onServerRecovered(onRecovered);
});

onUnmounted(() => {
  realtime.off(SOCKET_EVENTS.gradeUpdated, onGradeEvent);
  appStore.offServerRecovered(onRecovered);
});
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">{{ auth.isClassSession ? '本班成绩' : '我的成绩' }}</h2>
        <p class="page-subtitle">
          共 {{ grades.length }} 条记录 · 平均得分率 {{ averagePercent }}%
          <span v-if="auth.isClassSession">· 班级账号：显示全班成绩总览</span>
          <el-tag v-if="fromCache" size="small" type="warning" effect="plain">离线缓存</el-tag>
        </p>
      </div>
      <div class="toolbar">
        <el-input
          v-model="queryNo"
          placeholder="输入学号查个人明细"
          clearable
          style="width: 200px"
          @keyup.enter="queryByStudentNo"
        />
        <el-button :icon="'Search'" :loading="queryLoading" @click="queryByStudentNo">按学号查询</el-button>
        <el-button :icon="'Refresh'" @click="loadGrades">刷新</el-button>
      </div>
    </div>

    <!-- 按学号查询结果：ClassHelper 班级端代学生查本人明细 -->
    <el-card v-if="queried || queryError" shadow="never" class="mt-12">
      <template #header>
        <div class="query-header">
          <span v-if="queried">
            学号 {{ queried.student.studentNo }} · {{ queried.student.name }}
            <span class="text-muted">（{{ queried.className ?? '未分班' }}）</span>
          </span>
          <span v-else>查询失败</span>
          <el-button link @click="((queried = null), (queryError = ''))">收起</el-button>
        </div>
      </template>
      <el-alert v-if="queryError" type="warning" :closable="false" show-icon :title="queryError" />
      <template v-else-if="queried">
        <div class="text-muted" style="margin-bottom: 8px">
          共 {{ queried.items.length }} 条记录 · 平均得分率 {{ queried.averagePercent }}%
        </div>
        <el-table :data="queried.items" size="small" empty-text="该生还没有成绩记录" max-height="320">
          <el-table-column prop="examName" label="考试" width="150" />
          <el-table-column label="科目" width="110">
            <template #default="{ row }">{{ row.course?.name ?? '-' }}</template>
          </el-table-column>
          <el-table-column label="分数" width="120">
            <template #default="{ row }">{{ row.score }} / {{ row.totalScore }}</template>
          </el-table-column>
          <el-table-column label="等级" width="100">
            <template #default="{ row }">
              <el-tag size="small" effect="plain">{{ row.level || '-' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="发布时间">
            <template #default="{ row }">{{ formatDate(row.publishedAt, true) }}</template>
          </el-table-column>
        </el-table>
      </template>
    </el-card>

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
          <ScoreBarChart :items="examAverages" />
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
  background: var(--ch-layer-solid);
  border: 1px solid var(--ch-border);
  border-radius: 10px;
  padding: 16px;
}

.stat-label {
  font-size: 13px;
  color: var(--ch-text-secondary);
}

.stat-value {
  margin-top: 6px;
  font-size: 26px;
  font-weight: 700;
}

.stat-hint {
  margin-top: 4px;
  font-size: 12px;
  color: var(--ch-text-tertiary);
}

.level-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
</style>
