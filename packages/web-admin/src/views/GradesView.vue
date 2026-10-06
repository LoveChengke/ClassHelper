<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  DEFAULT_LETTER_LEVELS,
  GRADE_LEVEL_TYPES,
  GRADE_LEVEL_TYPE_HINTS,
  GRADE_LEVEL_TYPE_LABELS,
  SOCKET_EVENTS,
  SUBJECT_CATALOG,
  formatDate,
  gradeLevel,
  gradePercent,
  type ClassDto,
  type CourseDto,
  type GradeDto,
  type GradeLevelType,
  type GradeStats,
  type StudentDto,
  type StudentGradeDetailDto,
} from '@classhelper/shared';
import { classApi, courseApi, gradeApi } from '@/api';
import ScoreBarChart from '@/components/ScoreBarChart.vue';
import ScoreLineChart from '@/components/ScoreLineChart.vue';
import TableImportDialog from '@/components/TableImportDialog.vue';
import { useAuthStore } from '@/stores/auth';
import { useRealtimeStore } from '@/stores/realtime';

const auth = useAuthStore();

/**
 * 是否显示成绩的写入入口（**纯展示控制**）。
 *
 * 真正的权限在后端：管理员可以写全部；班主任与科任老师**只能写自己任教科目**的成绩
 * （查 `Course.teacherId`），越权一律 403。因此这里只要是教师就放行按钮，
 * 让老师能看到入口并在被拒时得到明确的后端提示，而不是"按钮凭空消失、不知道为什么"。
 */
const canManageGrades = computed(() => auth.role === 'ADMIN' || auth.role === 'TEACHER');
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
const singleForm = reactive({
  studentId: '',
  courseId: '',
  examName: '',
  score: 90,
  totalScore: 100,
  levelType: 'percent' as GradeLevelType,
  level: '',
});

function openSingle(): void {
  if (!filter.classId) {
    ElMessage.warning('请先选择班级');
    return;
  }
  singleForm.studentId = students.value[0]?.id ?? '';
  singleForm.courseId = filter.courseId || courses.value[0]?.id || '';
  singleForm.examName = filter.examName || '期中考试';
  singleForm.score = 90;
  singleForm.totalScore = 100;
  singleForm.levelType = 'percent';
  singleForm.level = '';
  singleVisible.value = true;
}

async function submitSingle(): Promise<void> {
  if (!singleForm.studentId || !singleForm.examName.trim()) {
    ElMessage.warning('请选择学生并填写考试名称');
    return;
  }
  await gradeApi.create({
    classId: filter.classId,
    courseId: await resolveCourseId(singleForm.courseId),
    studentId: singleForm.studentId,
    examName: singleForm.examName.trim(),
    score: singleForm.score,
    totalScore: singleForm.totalScore,
    levelType: singleForm.levelType,
    // percent 口径留空时由服务端按得分率换算，所以这里只传用户真的填了的值
    ...(singleForm.level.trim() ? { level: singleForm.level.trim() } : {}),
  });
  ElMessage.success('成绩已录入，已实时推送给教室端');
  singleVisible.value = false;
  await loadGrades();
}

/* ------------------------------------------------------------ 批量录入 */

const bulkVisible = ref(false);
const bulkForm = reactive({
  courseId: '',
  examName: '期中考试',
  totalScore: 100,
  levelType: 'percent' as GradeLevelType,
});
const bulkRows = ref<Array<{ studentId: string; name: string; studentNo: string; score: number | null; level: string }>>([]);

function openBulk(): void {
  if (students.value.length === 0) {
    ElMessage.warning('该班级暂无学生');
    return;
  }
  bulkForm.courseId = filter.courseId || courses.value[0]?.id || '';
  bulkForm.examName = filter.examName || '期中考试';
  bulkForm.totalScore = 100;
  bulkForm.levelType = 'percent';
  bulkRows.value = students.value.map((item) => ({
    studentId: item.id,
    name: item.name,
    studentNo: item.studentNo,
    score: null,
    level: '',
  }));
  bulkVisible.value = true;
}

async function submitBulk(): Promise<void> {
  const items = bulkRows.value
    .filter((row) => row.score !== null && row.score !== undefined)
    .map((row) => ({
      studentId: row.studentId,
      score: Number(row.score),
      ...(row.level.trim() ? { level: row.level.trim() } : {}),
    }));

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
    levelType: bulkForm.levelType,
    items,
  });
  ElMessage.success(`已录入 ${result.count} 条成绩并广播到班级`);
  bulkVisible.value = false;
  await loadGrades();
}

/* ------------------------------------------------------------ 等级：单个 / 批量编辑 */

/** 表格里直接改一条等级（percent 口径下相当于"手动覆盖自动换算的结果"） */
async function saveLevel(row: GradeDto, level: string): Promise<void> {
  await gradeApi.update(row.id, { level });
  ElMessage.success('等级已更新');
  await loadGrades();
}

const levelBatchVisible = ref(false);
const levelBatchSaving = ref(false);
const levelBatchForm = reactive({
  courseId: '',
  examName: '',
  levelType: 'letter' as GradeLevelType,
});

function openLevelBatch(): void {
  if (!filter.classId) {
    ElMessage.warning('请先选择班级');
    return;
  }
  levelBatchForm.courseId = filter.courseId || courses.value[0]?.id || '';
  levelBatchForm.examName = filter.examName || examOptions.value[0] || '';
  levelBatchForm.levelType = 'letter';
  levelBatchVisible.value = true;
}

/** 把某个考试某门课的成绩整批改成另一个等级口径（例如百分制 → A/B/C/D） */
async function submitLevelBatch(): Promise<void> {
  if (!levelBatchForm.examName.trim()) {
    ElMessage.warning('请选择要调整的考试');
    return;
  }
  levelBatchSaving.value = true;
  try {
    const result = await gradeApi.updateLevels({
      classId: filter.classId,
      examName: levelBatchForm.examName.trim(),
      courseId: await resolveCourseId(levelBatchForm.courseId),
      levelType: levelBatchForm.levelType,
    });
    ElMessage.success(`已把 ${result.updated} 条成绩改成「${GRADE_LEVEL_TYPE_LABELS[levelBatchForm.levelType]}」`);
    levelBatchVisible.value = false;
    await loadGrades();
  } finally {
    levelBatchSaving.value = false;
  }
}

/* ------------------------------------------------------------ 按学号查成绩明细 */

const detailVisible = ref(false);
const detailLoading = ref(false);
const detailNo = ref('');
const detail = ref<StudentGradeDetailDto | null>(null);

function openDetail(): void {
  if (!filter.classId) {
    ElMessage.warning('请先选择班级');
    return;
  }
  detailNo.value = '';
  detail.value = null;
  detailVisible.value = true;
}

async function queryDetail(): Promise<void> {
  const studentNo = detailNo.value.trim();
  if (!studentNo) {
    ElMessage.warning('请输入学号');
    return;
  }
  detailLoading.value = true;
  try {
    detail.value = await gradeApi.studentDetail(studentNo, filter.classId);
  } finally {
    detailLoading.value = false;
  }
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
        <el-button v-if="canManageGrades" :icon="'Sort'" @click="openLevelBatch">批量改等级</el-button>
        <el-button :icon="'Search'" @click="openDetail">按学号查明细</el-button>
      </div>
    </div>

    <el-alert type="info" :closable="false" style="margin-top: 8px">
      成绩按<b>科目</b>授权：科任老师只能录入 / 修改 / 删除<b>自己任教科目</b>的成绩；
      班主任若不教这一科，同样改不了这一科（不指定科目的内容归班主任与管理员）。
    </el-alert>

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
        <el-table-column label="学生" width="130">
          <template #default="{ row }">{{ row.student?.name ?? '-' }}</template>
        </el-table-column>
        <el-table-column label="学号" width="130">
          <template #default="{ row }">{{ row.student?.studentNo ?? '-' }}</template>
        </el-table-column>
        <el-table-column label="科目" width="110">
          <template #default="{ row }">{{ row.course?.name ?? '-' }}</template>
        </el-table-column>
        <el-table-column prop="examName" label="考试" width="150" />
        <el-table-column label="分数" width="120">
          <template #default="{ row }">{{ row.score }} / {{ row.totalScore }}</template>
        </el-table-column>
        <el-table-column label="得分率" width="170">
          <template #default="{ row }">
            <el-progress
              :percentage="gradePercent(row.score, row.totalScore)"
              :stroke-width="10"
              :status="gradePercent(row.score, row.totalScore) >= 60 ? 'success' : 'exception'"
            />
          </template>
        </el-table-column>
        <el-table-column label="等级" width="180">
          <template #default="{ row }">
            <div class="level-cell">
              <el-tag size="small" effect="plain">{{ GRADE_LEVEL_TYPE_LABELS[row.levelType as GradeLevelType] }}</el-tag>
              <!-- 单个编辑：percent 口径下相当于手动覆盖自动换算的结果 -->
              <el-select
                v-if="canManageGrades"
                :model-value="row.level"
                size="small"
                style="width: 88px"
                @change="(value: string) => saveLevel(row, value)"
              >
                <el-option
                  v-for="item in [...new Set([row.level, ...DEFAULT_LETTER_LEVELS, '优', '良', '合格'])]"
                  :key="item"
                  :label="item"
                  :value="item"
                />
              </el-select>
              <span v-else>{{ row.level || `${gradeLevel(gradePercent(row.score, row.totalScore))} 等` }}</span>
            </div>
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
    <el-dialog v-model="singleVisible" title="单条成绩录入" width="520px">
      <el-form :model="singleForm" label-width="90px">
        <el-form-item label="学生">
          <el-select v-model="singleForm.studentId" filterable style="width: 100%">
            <el-option
              v-for="item in students"
              :key="item.id"
              :label="`${item.name}（${item.studentNo}）`"
              :value="item.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="科目">
          <el-select v-model="singleForm.courseId" clearable filterable style="width: 100%">
            <el-option v-for="item in courses" :key="item.id" :label="`${item.name}（${item.teacher?.name ?? ''}）`" :value="item.id" />
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
        <el-form-item label="等级口径">
          <el-select v-model="singleForm.levelType" style="width: 100%">
            <el-option
              v-for="type in GRADE_LEVEL_TYPES"
              :key="type"
              :label="GRADE_LEVEL_TYPE_LABELS[type]"
              :value="type"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="分数">
          <el-input-number v-model="singleForm.score" :min="0" :max="singleForm.totalScore" />
          <span style="margin: 0 8px">/</span>
          <el-input-number v-model="singleForm.totalScore" :min="1" :max="1000" />
        </el-form-item>
        <el-form-item label="等级">
          <el-select
            v-model="singleForm.level"
            :placeholder="singleForm.levelType === 'percent' ? '留空按得分率自动换算' : '请选择或输入等级'"
            allow-create
            filterable
            clearable
            style="width: 100%"
          >
            <el-option v-for="item in DEFAULT_LETTER_LEVELS" :key="item" :label="item" :value="item" />
            <el-option v-for="item in ['优', '良', '合格', '待提高']" :key="item" :label="item" :value="item" />
          </el-select>
        </el-form-item>
      </el-form>
      <div class="dialog-hint">{{ GRADE_LEVEL_TYPE_HINTS[singleForm.levelType] }}</div>
      <template #footer>
        <el-button @click="singleVisible = false">取消</el-button>
        <el-button type="primary" @click="submitSingle">录入并推送</el-button>
      </template>
    </el-dialog>

    <!-- 批量录入 -->
    <el-dialog v-model="bulkVisible" title="批量录入成绩" width="720px">
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
        <el-form-item label="等级口径">
          <el-select v-model="bulkForm.levelType" style="width: 180px">
            <el-option
              v-for="type in GRADE_LEVEL_TYPES"
              :key="type"
              :label="GRADE_LEVEL_TYPE_LABELS[type]"
              :value="type"
            />
          </el-select>
        </el-form-item>
      </el-form>

      <el-table :data="bulkRows" height="360" size="small">
        <el-table-column prop="name" label="姓名" width="110" />
        <el-table-column prop="studentNo" label="学号" width="130" />
        <el-table-column label="分数">
          <template #default="{ row }">
            <el-input-number v-model="row.score" :min="0" :max="bulkForm.totalScore" size="small" />
          </template>
        </el-table-column>
        <el-table-column label="等级（留空则自动换算）">
          <template #default="{ row }">
            <el-select v-model="row.level" size="small" allow-create filterable clearable style="width: 140px">
              <el-option v-for="item in DEFAULT_LETTER_LEVELS" :key="item" :label="item" :value="item" />
              <el-option v-for="item in ['优', '良', '合格', '待提高']" :key="item" :label="item" :value="item" />
            </el-select>
          </template>
        </el-table-column>
      </el-table>

      <template #footer>
        <el-button @click="bulkVisible = false">取消</el-button>
        <el-button type="primary" @click="submitBulk">提交并广播</el-button>
      </template>
    </el-dialog>

    <!-- 批量改等级：把一个考试某门课整批改成另一种等级口径 -->
    <el-dialog v-model="levelBatchVisible" title="批量修改等级" width="520px">
      <el-alert type="info" :closable="false" style="margin-bottom: 12px">
        把某个考试某门课的成绩<b>整批</b>换成另一种等级口径。百分制会按得分率重新换算 A~E，
        等级制 / 自定义则直接套用所选口径（原有等级文本保留，可再到表格里逐条微调）。
      </el-alert>
      <el-form :model="levelBatchForm" label-width="90px">
        <el-form-item label="科目">
          <el-select v-model="levelBatchForm.courseId" clearable filterable style="width: 100%">
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
        <el-form-item label="考试">
          <el-select v-model="levelBatchForm.examName" filterable allow-create style="width: 100%">
            <el-option v-for="item in examOptions" :key="item" :label="item" :value="item" />
          </el-select>
        </el-form-item>
        <el-form-item label="改为">
          <el-select v-model="levelBatchForm.levelType" style="width: 100%">
            <el-option
              v-for="type in GRADE_LEVEL_TYPES"
              :key="type"
              :label="GRADE_LEVEL_TYPE_LABELS[type]"
              :value="type"
            />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="levelBatchVisible = false">取消</el-button>
        <el-button type="primary" :loading="levelBatchSaving" @click="submitLevelBatch">确认修改</el-button>
      </template>
    </el-dialog>

    <!-- 按学号查成绩明细（教师端；教室机器在自己的客户端里查同一份数据） -->
    <el-drawer v-model="detailVisible" title="按学号查询成绩明细" size="720px">
      <div class="detail-toolbar">
        <el-input
          v-model="detailNo"
          placeholder="输入学号，如 202601"
          style="width: 240px"
          @keyup.enter="queryDetail"
        />
        <el-button type="primary" :loading="detailLoading" @click="queryDetail">查询</el-button>
      </div>

      <template v-if="detail">
        <el-descriptions :column="2" border class="mt-12">
          <el-descriptions-item label="姓名">{{ detail.student.name }}</el-descriptions-item>
          <el-descriptions-item label="学号">{{ detail.student.studentNo }}</el-descriptions-item>
          <el-descriptions-item label="班级">{{ detail.className ?? '未分班' }}</el-descriptions-item>
          <el-descriptions-item label="平均得分率">{{ detail.averagePercent }}%</el-descriptions-item>
        </el-descriptions>

        <el-table :data="detail.items" class="mt-12" empty-text="该生还没有成绩记录" max-height="440">
          <el-table-column prop="examName" label="考试" width="150" />
          <el-table-column label="科目" width="110">
            <template #default="{ row }">{{ row.course?.name ?? '-' }}</template>
          </el-table-column>
          <el-table-column label="分数" width="110">
            <template #default="{ row }">{{ row.score }} / {{ row.totalScore }}</template>
          </el-table-column>
          <el-table-column label="等级" width="110">
            <template #default="{ row }">
              <el-tag size="small" effect="plain">{{ row.level || '-' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="发布时间">
            <template #default="{ row }">{{ formatDate(row.publishedAt, true) }}</template>
          </el-table-column>
        </el-table>
      </template>
      <el-empty v-else description="输入学号后点查询，即可看到该生的全部成绩明细" />
    </el-drawer>

    <!-- 表格导入（xlsx/xls/csv：模板下载 + 预览 + 字段映射 + 结果统计） -->
    <TableImportDialog
      v-model="importVisible"
      kind="grades"
      :class-id="filter.classId"
      @imported="onImported"
    />
  </div>
</template>

<style scoped>
.level-cell {
  display: flex;
  align-items: center;
  gap: 6px;
}

.detail-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
}

.dialog-hint {
  font-size: 12px;
  color: var(--ch-text-muted);
  padding-left: 90px;
  margin-top: -6px;
}
</style>
