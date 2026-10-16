<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import {
  SOCKET_EVENTS,
  averageOf,
  formatDate,
  gradeLevel,
  gradePercent,
  type ExamDto,
  type ExamRankingDto,
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

/* ------------------------------------------------------------ 考试排名
 *
 * 需求：「服务端选择成绩查询可用时，客户端可以直接查看全部，并且自动排名；
 * 单次考试可选是否把所有科目相加以总分排名，客户端也能看到总分排名和个别单科的排名」。
 *
 * 排名**一律由服务端算**（`GET /api/grades/ranking`）：并列名次（1、2、2、4）、
 * "同一学生同一科补录过多条只取最高分"这些口径写在服务端，三端才不会各算一套。
 * 是否开放由班级上的 `studentGradeQueryEnabled` 决定（关闭时服务端 403），
 * 而"这次考试算不算总分"由老师在 Web 端定（`Exam.countInTotal`）——
 * 客户端只负责显示，两个开关都不在这里。
 */
const examList = ref<ExamDto[]>([]);
const selectedExam = ref('');
const ranking = ref<ExamRankingDto | null>(null);
const rankingLoading = ref(false);
const rankingError = ref('');

async function loadExams(): Promise<void> {
  const classId = auth.user?.classId;
  if (!classId) return;
  try {
    examList.value = await gradeApi.exams(classId);
    if (!selectedExam.value && examList.value.length > 0) {
      // 默认看最近一次：列表按名字排，取最后一条通常就是最新那场考试
      selectedExam.value = examList.value[examList.value.length - 1]?.name ?? '';
    }
    await loadRanking();
  } catch (error) {
    rankingError.value = error instanceof Error ? error.message : '获取考试列表失败';
  }
}

async function loadRanking(): Promise<void> {
  const classId = auth.user?.classId;
  if (!classId || !selectedExam.value) {
    ranking.value = null;
    return;
  }
  rankingLoading.value = true;
  rankingError.value = '';
  try {
    ranking.value = await gradeApi.ranking(classId, selectedExam.value);
  } catch (error) {
    ranking.value = null;
    rankingError.value = error instanceof Error ? error.message : '获取排名失败';
  } finally {
    rankingLoading.value = false;
  }
}

function onGradeEvent(): void {
  void loadGrades();
  void loadExams();
}

function onRecovered(): void {
  void loadGrades();
  void loadExams();
}

onMounted(async () => {
  await loadGrades();
  await loadExams();
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

    <!-- 考试排名：总分榜（老师把这次考试设成"所有科目相加"时才有）+ 单科榜。
         排名与"算不算总分"都由服务端说了算，这里只显示。 -->
    <el-card v-if="auth.isClassSession" v-loading="rankingLoading" shadow="never" class="mt-16">
      <template #header>
        <div class="ranking-header">
          <span>考试排名</span>
          <el-select
            v-model="selectedExam"
            placeholder="选择考试"
            size="small"
            style="width: 200px"
            :disabled="examList.length === 0"
            @change="loadRanking"
          >
            <el-option
              v-for="item in examList"
              :key="item.name"
              :label="`${item.name}（${item.gradeCount} 条）`"
              :value="item.name"
            />
          </el-select>
          <el-button size="small" :icon="'Refresh'" @click="loadRanking">刷新</el-button>
        </div>
      </template>

      <el-alert v-if="rankingError" type="warning" :closable="false" show-icon :title="rankingError" />
      <el-empty
        v-else-if="examList.length === 0"
        description="还没有成绩记录，先在 Web 端录入或导入"
        :image-size="60"
      />
      <template v-else-if="ranking">
        <el-alert v-if="!ranking.countInTotal" type="info" :closable="false" show-icon class="mb-12">
          <template #title>这次考试没有开启总分排名</template>
          <template #default>
            语数外与音体美的分数量纲不同，合不合总分由老师决定 —— 需要总分榜请在 Web 端「成绩录入」
            页把该次考试的「考试口径」打开。
          </template>
        </el-alert>

        <el-table v-if="ranking.countInTotal" :data="ranking.total" size="small" max-height="320">
          <el-table-column label="总分排名" width="96">
            <template #default="{ row }">
              <el-tag :type="row.rank <= 3 ? 'danger' : 'info'" effect="plain" size="small">
                {{ row.rank }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="studentNo" label="学号" width="110" />
          <el-table-column prop="studentName" label="姓名" width="110" />
          <el-table-column label="总分" width="90">
            <template #default="{ row }">{{ row.score }}</template>
          </el-table-column>
          <el-table-column label="科目数" width="90">
            <template #default="{ row }">{{ row.subjectCount }}</template>
          </el-table-column>
        </el-table>

        <el-divider v-if="ranking.countInTotal" content-position="left">单科排名</el-divider>
        <el-tabs v-if="ranking.subjects.length > 0" type="border-card">
          <el-tab-pane
            v-for="subject in ranking.subjects"
            :key="subject.courseName"
            :label="subject.courseName"
          >
            <el-table :data="subject.rows" size="small" max-height="300">
              <el-table-column label="名次" width="80">
                <template #default="{ row }">{{ row.rank }}</template>
              </el-table-column>
              <el-table-column prop="studentNo" label="学号" width="110" />
              <el-table-column prop="studentName" label="姓名" width="110" />
              <el-table-column label="得分" width="120">
                <template #default="{ row }">{{ row.score }} / {{ row.totalScore }}</template>
              </el-table-column>
            </el-table>
          </el-tab-pane>
        </el-tabs>
        <el-empty v-else description="这次考试还没有单科成绩" :image-size="60" />
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
            {{ row.level || gradeLevel(gradePercent(row.score, row.totalScore)) }}
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

.ranking-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.mb-12 {
  margin-bottom: 12px;
}
</style>
