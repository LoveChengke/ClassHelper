<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  SOCKET_EVENTS,
  SUBJECT_CATALOG,
  formatDate,
  gradeLevel,
  gradePercent,
  type ClassDto,
  type CourseDto,
  type GradeDto,
  type GradeStats,
  type StudentDto,
} from '@classhelper/shared';
import { classApi, courseApi, gradeApi } from '@/api';
import ScoreBarChart from '@/components/ScoreBarChart.vue';
import ScoreLineChart from '@/components/ScoreLineChart.vue';
import TableImportDialog from '@/components/TableImportDialog.vue';
import { useAuthStore } from '@/stores/auth';
import { useRealtimeStore } from '@/stores/realtime';

const auth = useAuthStore();

/**
 * 成绩写入/导入权限：管理员，或"所选班级的班主任"（需求 6：老师端可用且不越权）。
 * 科任老师只能查看列表与统计，写入会被后端 403（需求 7：科任仅作业/叫人/通知）。
 */
const canManageGrades = computed(() => {
  if (auth.role === 'ADMIN') return true;
  if (auth.role !== 'TEACHER') return false;
  const current = classes.value.find((item) => item.id === filter.classId);
  return Boolean(current && current.teacherId === auth.user?.id);
});
const realtime = useRealtimeStore();

const loading = ref(false);
const classes = ref<ClassDto[]>([]);
const courses = ref<CourseDto[]>([]);
const grades = ref<GradeDto[]>([]);
const students = ref<StudentDto[]>([]);
const stats = ref<GradeStats | null>(null);
const filter = reactive({ classId: '', courseId: '', examName: '' });

/** 等级分布柱状图的数据（count 是整数，纵轴上限交给组件按数据自动取整） */
const levelItems = computed(() =>
  (stats.value?.distribution ?? []).map((item) => ({ label: `${item.level} 等`, value: item.count })),
);

/** 各课程平均得分率折线图的数据 */
const courseItems = computed(() =>
  (stats.value?.byCourse ?? []).map((item) => ({ label: item.courseName, value: item.averagePercent })),
);

const averagePercent = computed(() => {
  if (grades.value.length === 0) return 0;
  const sum = grades.value.reduce((total, item) => total + gradePercent(item.score, item.totalScore), 0);
  return Math.round((sum / grades.value.length) * 10) / 10;
});

const examOptions = computed(() => [...new Set(grades.value.map((item) => item.examName))]);

async function loadClasses(): Promise<void> {
  classes.value = await classApi.list();
  if (!filter.classId && classes.value.length > 0) filter.classId = classes.value[0]?.id ?? '';
  if (filter.classId) {
    courses.value = await courseApi.list(filter.classId);
    students.value = await classApi.students(filter.classId);
  }
}

/** 请求序号：快速切班级时先发的慢响应不能覆盖新数据（否则出现"显示 A 班成绩、按钮按 B 班权限"） */
let gradesRequestId = 0;

async function loadGrades(): Promise<void> {
  if (!filter.classId) return;
  const requestId = ++gradesRequestId;
  loading.value = true;
  try {
    const params: { classId?: string; courseId?: string; examName?: string } = { classId: filter.classId };
    if (filter.courseId) params.courseId = filter.courseId;
    if (filter.examName) params.examName = filter.examName;

    const [list, statistic] = await Promise.all([gradeApi.list(params), gradeApi.stats(params)]);
    if (requestId !== gradesRequestId) return;
    grades.value = list;
    stats.value = statistic;
  } finally {
    if (requestId === gradesRequestId) loading.value = false;
  }
}

async function onClassChange(): Promise<void> {
  filter.courseId = '';
  filter.examName = '';
  courses.value = await courseApi.list(filter.classId);
  students.value = await classApi.students(filter.classId);
  await loadGrades();
  await loadTeacherSuggestions();
}

/* ------------------------------------------------------------ 图表
 *
 * 等级分布与各课程得分率原先用 echarts 渲染（`import * as echarts from 'echarts'`
 * 会给构建产物加 1.1MB）。现在换成两个自包含的轻量组件：
 *   - ScoreBarChart：纯 HTML/CSS 柱状图
 *   - ScoreLineChart：内联 SVG 折线 + HTML 数据点
 * 两者都是响应式的（百分比布局），因此不再需要 resize 监听，
 * 数据也直接从上面两个 computed 流过去，不需要手写 setOption。
 */

/* ------------------------------------------------------------ 统一科目
 *
 * 与课表一致："科目"是全校统一的固定目录（shared 的 SUBJECT_CATALOG），
 * 下拉里直接列出该班还没有的科目，选中后自动建课 —— 不需要先按班级单独录入课程。
 */

const SUBJECT_PREFIX = 'subject:';

const subjectOptions = computed(() => {
  const existing = new Set(courses.value.map((item) => item.name));
  return SUBJECT_CATALOG.filter((name) => !existing.has(name));
});

/** 把下拉值解析成真实 courseId：`subject:语文` 这类伪值先建课（已存在则复用） */
async function resolveCourseId(value: string): Promise<string | null> {
  if (!value.startsWith(SUBJECT_PREFIX)) return value || null;
  const name = value.slice(SUBJECT_PREFIX.length);
  const existing = courses.value.find((item) => item.name === name);
  if (existing) return existing.id;
  const created = await courseApi.create({ classId: filter.classId, name });
  courses.value = [...courses.value, created];
  return created.id;
}

/* ------------------------------------------------------------ 单条录入 */

const singleVisible = ref(false);
const singleForm = reactive({ userId: '', courseId: '', examName: '', score: 90, totalScore: 100 });

function openSingle(): void {
  if (!filter.classId) {
    ElMessage.warning('请先选择班级');
    return;
  }
  singleForm.userId = students.value[0]?.id ?? '';
  singleForm.courseId = filter.courseId || courses.value[0]?.id || '';
  singleForm.examName = filter.examName || '期中考试';
  singleForm.score = 90;
  singleForm.totalScore = 100;
  singleVisible.value = true;
}

async function submitSingle(): Promise<void> {
  if (!singleForm.userId || !singleForm.examName.trim()) {
    ElMessage.warning('请选择学生并填写考试名称');
    return;
  }
  await gradeApi.create({
    classId: filter.classId,
    courseId: await resolveCourseId(singleForm.courseId),
    userId: singleForm.userId,
    examName: singleForm.examName.trim(),
    score: singleForm.score,
    totalScore: singleForm.totalScore,
  });
  ElMessage.success('成绩已录入，已实时推送给该学生');
  singleVisible.value = false;
  await loadGrades();
}

/* ------------------------------------------------------------ 批量录入 */

const bulkVisible = ref(false);
const bulkForm = reactive({ courseId: '', examName: '期中考试', totalScore: 100 });
const bulkRows = ref<Array<{ userId: string; name: string; username: string; score: number | null }>>([]);

function openBulk(): void {
  if (students.value.length === 0) {
    ElMessage.warning('该班级暂无学生');
    return;
  }
  bulkForm.courseId = filter.courseId || courses.value[0]?.id || '';
  bulkForm.examName = filter.examName || '期中考试';
  bulkForm.totalScore = 100;
  bulkRows.value = students.value.map((item) => ({
    userId: item.id,
    name: item.name,
    username: item.username,
    score: null,
  }));
  bulkVisible.value = true;
}

async function submitBulk(): Promise<void> {
  const items = bulkRows.value
    .filter((row) => row.score !== null && row.score !== undefined)
    .map((row) => ({ userId: row.userId, score: Number(row.score) }));

  if (items.length === 0) {
    ElMessage.warning('至少录入一位学生的成绩');
    return;
  }
  if (!bulkForm.examName.trim()) {
    ElMessage.warning('请填写考试名称');
    return;
  }

  const result = await gradeApi.bulkCreate({
    classId: filter.classId,
    courseId: await resolveCourseId(bulkForm.courseId),
    examName: bulkForm.examName.trim(),
    totalScore: bulkForm.totalScore,
    items,
  });
  ElMessage.success(`已录入 ${result.count} 条成绩并广播到班级`);
  bulkVisible.value = false;
  await loadGrades();
}

/* ------------------------------------------------------------ 表格导入 */

const importVisible = ref(false);

function openImport(): void {
  if (!filter.classId) {
    ElMessage.warning('请先选择班级');
    return;
  }
  importVisible.value = true;
}

async function onImported(): Promise<void> {
  await loadGrades();
}

async function removeGrade(row: GradeDto): Promise<void> {
  await ElMessageBox.confirm(`删除 ${row.student?.name ?? ''} 的「${row.examName}」成绩？`, '确认', {
    type: 'warning',
  });
  await gradeApi.remove(row.id);
  ElMessage.success('已删除');
  await loadGrades();
}

/* ------------------------------------------------------------ 教师视角建议：按考试分组统计 */

const teacherCourseSuggestions = ref<CourseDto[]>([]);
async function loadTeacherSuggestions(): Promise<void> {
  teacherCourseSuggestions.value = courses.value;
}

function onGradeEvent(): void {
  void loadGrades();
}

watch(
  () => [filter.courseId, filter.examName],
  () => {
    void loadGrades();
  },
);

onMounted(async () => {
  await loadClasses();
  await loadGrades();
  realtime.on(SOCKET_EVENTS.gradeUpdated, onGradeEvent);
});

onUnmounted(() => {
  realtime.off(SOCKET_EVENTS.gradeUpdated, onGradeEvent);
});
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">成绩录入</h2>
        <p class="page-subtitle">同一学生 + 课程 + 考试重复录入会覆盖旧分数，避免产生重复记录</p>
      </div>
      <div class="toolbar">
        <el-select
          v-model="filter.classId"
          placeholder="选择班级"
          style="width: 170px"
          @change="onClassChange"
        >
          <el-option v-for="item in classes" :key="item.id" :label="item.name" :value="item.id" />
        </el-select>
        <el-select v-model="filter.courseId" placeholder="全部课程" clearable style="width: 150px">
          <el-option v-for="item in courses" :key="item.id" :label="item.name" :value="item.id" />
        </el-select>
        <el-select v-model="filter.examName" placeholder="全部考试" clearable style="width: 160px">
          <el-option v-for="item in examOptions" :key="item" :label="item" :value="item" />
        </el-select>
        <el-button v-if="canManageGrades" type="primary" :icon="'Plus'" @click="openSingle">
          单条录入
        </el-button>
        <el-button v-if="canManageGrades" type="success" :icon="'Upload'" @click="openBulk">
          批量录入
        </el-button>
        <el-button v-if="canManageGrades" type="warning" :icon="'Document'" @click="openImport">
          导入表格
        </el-button>
      </div>
    </div>

    <el-row :gutter="12">
      <el-col :xs="24" :md="6">
        <div class="stat-card">
          <div class="stat-label">成绩记录</div>
          <div class="stat-value">{{ grades.length }}</div>
          <div class="stat-hint">当前筛选条件</div>
        </div>
        <div class="stat-card mt-12">
          <div class="stat-label">平均得分率</div>
          <div class="stat-value">{{ averagePercent }}%</div>
          <div class="stat-hint">按总分换算</div>
        </div>
      </el-col>
      <el-col :xs="24" :md="9">
        <el-card shadow="never">
          <template #header><span>等级分布</span></template>
          <ScoreBarChart :items="levelItems" />
        </el-card>
      </el-col>
      <el-col :xs="24" :md="9">
        <el-card shadow="never">
          <template #header><span>各课程平均得分率</span></template>
          <ScoreLineChart :items="courseItems" :max="100" />
        </el-card>
      </el-col>
    </el-row>

    <el-card shadow="never" class="mt-16 table-card">
      <el-table v-loading="loading" :data="grades" empty-text="暂无成绩记录" max-height="520">
        <el-table-column label="学生" width="140">
          <template #default="{ row }">{{ row.student?.name ?? '-' }}</template>
        </el-table-column>
        <el-table-column label="用户名" width="130">
          <template #default="{ row }">{{ row.student?.username ?? '-' }}</template>
        </el-table-column>
        <el-table-column label="课程" width="110">
          <template #default="{ row }">{{ row.course?.name ?? '-' }}</template>
        </el-table-column>
        <el-table-column prop="examName" label="考试" width="150" />
        <el-table-column label="分数" width="130">
          <template #default="{ row }">{{ row.score }} / {{ row.totalScore }}</template>
        </el-table-column>
        <el-table-column label="得分率" width="190">
          <template #default="{ row }">
            <el-progress
              :percentage="gradePercent(row.score, row.totalScore)"
              :stroke-width="10"
              :status="gradePercent(row.score, row.totalScore) >= 60 ? 'success' : 'exception'"
            />
            <span class="text-muted">{{ gradeLevel(gradePercent(row.score, row.totalScore)) }} 等</span>
          </template>
        </el-table-column>
        <el-table-column label="发布时间" width="170">
          <template #default="{ row }">{{ formatDate(row.publishedAt, true) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="90" fixed="right">
          <template #default="{ row }">
            <el-button v-if="canManageGrades" link type="danger" @click="removeGrade(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 单条录入 -->
    <el-dialog v-model="singleVisible" title="单条成绩录入" width="480px">
      <el-form :model="singleForm" label-width="90px">
        <el-form-item label="学生">
          <el-select v-model="singleForm.userId" filterable style="width: 100%">
            <el-option
              v-for="item in students"
              :key="item.id"
              :label="`${item.name}（${item.username}）`"
              :value="item.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="科目">
          <el-select v-model="singleForm.courseId" clearable filterable style="width: 100%">
            <el-option v-for="item in courses" :key="item.id" :label="item.name" :value="item.id" />
            <el-option-group v-if="subjectOptions.length" label="统一科目（自动建课）">
              <el-option
                v-for="name in subjectOptions"
                :key="name"
                :label="name"
                :value="`${SUBJECT_PREFIX}${name}`"
              />
            </el-option-group>
          </el-select>
        </el-form-item>
        <el-form-item label="考试名称">
          <el-input v-model="singleForm.examName" placeholder="例如 第一次月考" />
        </el-form-item>
        <el-form-item label="分数">
          <el-input-number v-model="singleForm.score" :min="0" :max="singleForm.totalScore" />
          <span style="margin: 0 8px">/</span>
          <el-input-number v-model="singleForm.totalScore" :min="1" :max="1000" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="singleVisible = false">取消</el-button>
        <el-button type="primary" @click="submitSingle">录入并推送</el-button>
      </template>
    </el-dialog>

    <!-- 批量录入 -->
    <el-dialog v-model="bulkVisible" title="批量录入成绩" width="620px">
      <el-form :model="bulkForm" label-width="90px" inline>
        <el-form-item label="科目">
          <el-select v-model="bulkForm.courseId" clearable filterable style="width: 150px">
            <el-option
              v-for="item in teacherCourseSuggestions"
              :key="item.id"
              :label="item.name"
              :value="item.id"
            />
            <el-option-group v-if="subjectOptions.length" label="统一科目（自动建课）">
              <el-option
                v-for="name in subjectOptions"
                :key="name"
                :label="name"
                :value="`${SUBJECT_PREFIX}${name}`"
              />
            </el-option-group>
          </el-select>
        </el-form-item>
        <el-form-item label="考试">
          <el-input v-model="bulkForm.examName" style="width: 170px" />
        </el-form-item>
        <el-form-item label="总分">
          <el-input-number v-model="bulkForm.totalScore" :min="1" :max="1000" />
        </el-form-item>
      </el-form>

      <el-table :data="bulkRows" height="360" size="small">
        <el-table-column prop="name" label="姓名" width="120" />
        <el-table-column prop="username" label="用户名" width="140" />
        <el-table-column label="分数">
          <template #default="{ row }">
            <el-input-number v-model="row.score" :min="0" :max="bulkForm.totalScore" size="small" />
          </template>
        </el-table-column>
      </el-table>

      <template #footer>
        <el-button @click="bulkVisible = false">取消</el-button>
        <el-button type="primary" @click="submitBulk">提交并广播</el-button>
      </template>
    </el-dialog>

    <!-- 表格导入（xlsx/xls/csv：模板下载 + 预览 + 字段映射 + 结果统计） -->
    <TableImportDialog
      v-model="importVisible"
      kind="grades"
      :class-id="filter.classId"
      @imported="onImported"
    />
  </div>
</template>
