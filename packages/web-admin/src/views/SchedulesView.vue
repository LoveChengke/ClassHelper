<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import {
  SOCKET_EVENTS,
  SUBJECT_CATALOG,
  WEEKDAYS,
  WEEKDAY_LABELS,
  WEEK_PARITY_LABELS,
  WEEK_PARITY_VALUES,
  buildWeekOptions,
  formatWeekRange,
  weekParityOf,
  type ClassDto,
  type CourseDto,
  type CreateScheduleRequest,
  type ScheduleDto,
  type ScheduleWeekView,
  type WeekParity,
} from '@classhelper/shared';
import { classApi, courseApi, dashboardApi, scheduleApi } from '@/api';
import ClassPlanImportDialog from '@/components/ClassPlanImportDialog.vue';
import { useAuthStore } from '@/stores/auth';
import { useRealtimeStore } from '@/stores/realtime';

const auth = useAuthStore();
const realtime = useRealtimeStore();

/**
 * 课表管理权限：管理员，或"所选班级的班主任"（Class.teacherId === 当前用户）。
 * 与后端 assertCanManageSchedule 使用同一权限矩阵；科任老师不显示写入口。
 */
const canManageSchedule = computed(() => {
  if (auth.role === 'ADMIN') return true;
  if (auth.role !== 'TEACHER') return false;
  const current = classes.value.find((item) => item.id === query.classId);
  return Boolean(current && current.teacherId === auth.user?.id);
});

const loading = ref(false);
const classes = ref<ClassDto[]>([]);
const courses = ref<CourseDto[]>([]);
const grid = ref<ScheduleWeekView | null>(null);
const rawSchedules = ref<ScheduleDto[]>([]);

const query = reactive({ classId: '', week: 1 });
const weekOptions = ref<number[]>(buildWeekOptions(20));

/** 当前周次的单双周（第 1 周记为单周），用于工具栏提示与课表校验 */
const currentWeekParity = computed(() => weekParityOf(query.week));
const currentWeekParityLabel = computed(
  () => `第 ${query.week} 周 · ${WEEK_PARITY_LABELS[currentWeekParity.value]}`,
);

/** 把同一时间段的课表行聚合成"节次"行，形成 7 列课表 */
const periods = computed(() => {
  const buckets = new Map<string, ScheduleDto[]>();
  for (const item of rawSchedules.value) {
    const key = `${item.startTime}-${item.endTime}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(item);
    buckets.set(key, bucket);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, items]) => {
      const [start, end] = key.split('-');
      return { start: start ?? '', end: end ?? '', items };
    });
});

function cellItems(period: { items: ScheduleDto[] }, dayOfWeek: number): ScheduleDto[] {
  return period.items.filter((item) => item.dayOfWeek === dayOfWeek);
}

/**
 * 学期信息（班级维度）：`maxWeek` = 该班教学周数（`Class.termWeeks`，默认 20）。
 * 切换班级时要重新取一次，并按新上限收敛周次下拉与当前选中周，
 * 避免出现"实际 20 周却给到 30 周"或选中一个不存在的周。
 */
async function loadTerm(): Promise<void> {
  const term = await dashboardApi.term(query.classId || undefined).catch(() => null);
  if (!term) return;
  weekOptions.value = buildWeekOptions(term.maxWeek);
  const maxWeek = weekOptions.value.at(-1) ?? term.maxWeek;
  if (query.week > maxWeek) query.week = maxWeek;
  if (query.week < 1) query.week = 1;
}

async function loadBase(): Promise<void> {
  const [classList, term] = await Promise.all([classApi.list(), dashboardApi.term()]);
  classes.value = classList;
  weekOptions.value = buildWeekOptions(term.maxWeek);
  query.week = Math.min(Math.max(term.currentWeek, 1), weekOptions.value.at(-1) ?? term.maxWeek);
  if (!query.classId && classList.length > 0) query.classId = classList[0]?.id ?? '';
  if (query.classId) await Promise.all([loadCourses(), loadTerm()]);
}

async function loadCourses(): Promise<void> {
  courses.value = query.classId ? await courseApi.list(query.classId) : [];
}

/**
 * 统一授课科目（需求："课表统一而不是单个班级录入"）。
 *
 * 学校固定的科目目录来自 shared 的 `SUBJECT_CATALOG`（语文/数学/…/听力），
 * 与班级无关：**该班还没有的科目也直接出现在下拉里**，选中后自动为该班建好同名课程，
 * 因此不需要为了排课先去"班级 → 课程"里一个个录一遍。
 * 下拉只有一个 v-model，统一科目用 `subject:语文` 这种带前缀的伪值表达。
 */
const SUBJECT_PREFIX = 'subject:';

const subjectOptions = computed(() => {
  const existing = new Set(courses.value.map((item) => item.name));
  return SUBJECT_CATALOG.filter((name) => !existing.has(name));
});

/** 把表单里的选中值解析成真实 courseId：伪值先建课（已存在则复用） */
async function resolveCourseId(): Promise<string | null> {
  const value = form.courseId;
  if (!value.startsWith(SUBJECT_PREFIX)) return value || null;
  const name = value.slice(SUBJECT_PREFIX.length);
  const existing = courses.value.find((item) => item.name === name);
  if (existing) return existing.id;
  const created = await courseApi.create({ classId: query.classId, name });
  courses.value = [...courses.value, created];
  return created.id;
}

/**
 * 列表/周视图请求的序号：快速的"切班级/切周次"会让多个请求同时在途，
 * 先发出的慢响应若后返回就会覆盖掉新数据（表现为"显示 A 班的课表、按钮却按 B 班权限"）。
 * 因此每次请求领一个号，回来时不是最新一次就直接丢弃。
 */
let schedulesRequestId = 0;

async function loadSchedules(): Promise<void> {
  const requestId = ++schedulesRequestId;
  if (!query.classId) {
    grid.value = null;
    rawSchedules.value = [];
    return;
  }
  loading.value = true;
  try {
    const [weekGrid, list] = await Promise.all([
      scheduleApi.grid({ classId: query.classId, week: query.week }),
      scheduleApi.list({ classId: query.classId, week: query.week }),
    ]);
    if (requestId !== schedulesRequestId) return;
    grid.value = weekGrid;
    rawSchedules.value = list;
  } finally {
    if (requestId === schedulesRequestId) loading.value = false;
  }
}

async function onClassChange(): Promise<void> {
  await loadTerm();
  await loadCourses();
  await loadSchedules();
}

/* ------------------------------------------------------------ 新增 / 编辑 */

const formVisible = ref(false);
const formRef = ref<FormInstance>();
const editingId = ref<string | null>(null);
const form = reactive({
  courseId: '',
  dayOfWeek: 1,
  startTime: '08:00',
  endTime: '08:45',
  location: '',
  weekStart: 1,
  weekEnd: 20,
  /** 单双周：ALL 每周（默认）/ ODD 单周 / EVEN 双周 */
  weekParity: 'ALL' as WeekParity,
});

const rules: FormRules = {
  courseId: [{ required: true, message: '请选择课程', trigger: 'change' }],
  startTime: [{ required: true, message: '请选择开始时间', trigger: 'change' }],
  endTime: [{ required: true, message: '请选择结束时间', trigger: 'change' }],
};

function openCreate(): void {
  if (!query.classId) {
    ElMessage.warning('请先选择班级');
    return;
  }
  editingId.value = null;
  // 默认选第一个统一科目（不是"该班已建课程"，避免新班级下拉为空）
  form.courseId =
    courses.value[0]?.id ?? (SUBJECT_CATALOG[0] ? `${SUBJECT_PREFIX}${SUBJECT_CATALOG[0]}` : '');
  form.dayOfWeek = 1;
  form.startTime = '08:00';
  form.endTime = '08:45';
  form.location = '';
  form.weekStart = 1;
  form.weekEnd = weekOptions.value.at(-1) ?? 20;
  form.weekParity = 'ALL';
  formVisible.value = true;
}

function openEdit(item: ScheduleDto): void {
  editingId.value = item.id;
  form.courseId = item.courseId;
  form.dayOfWeek = item.dayOfWeek;
  form.startTime = item.startTime;
  form.endTime = item.endTime;
  form.location = item.location ?? '';
  form.weekStart = item.weekStart;
  form.weekEnd = item.weekEnd;
  form.weekParity = item.weekParity ?? 'ALL';
  formVisible.value = true;
}

async function submitForm(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;
  if (form.startTime >= form.endTime) {
    ElMessage.warning('结束时间必须晚于开始时间');
    return;
  }

  const courseId = await resolveCourseId();
  if (!courseId) {
    ElMessage.warning('请选择科目');
    return;
  }

  const payload: CreateScheduleRequest = {
    classId: query.classId,
    courseId,
    dayOfWeek: Number(form.dayOfWeek),
    startTime: form.startTime,
    endTime: form.endTime,
    location: form.location || null,
    weekStart: Number(form.weekStart),
    weekEnd: Number(form.weekEnd),
    weekParity: form.weekParity,
  };

  if (editingId.value) {
    await scheduleApi.update(editingId.value, payload);
    ElMessage.success('课表已更新');
  } else {
    await scheduleApi.create(payload);
    ElMessage.success('课表已新增');
  }
  formVisible.value = false;
  await Promise.all([loadCourses(), loadSchedules()]);
}

async function removeSchedule(item: ScheduleDto): Promise<void> {
  await ElMessageBox.confirm(
    `删除 ${WEEKDAY_LABELS[item.dayOfWeek]} ${item.startTime} ${item.course?.name ?? ''} 这节课？`,
    '确认',
    {
      type: 'warning',
    },
  );
  await scheduleApi.remove(item.id);
  ElMessage.success('已删除');
  await loadSchedules();
}

function onScheduleEvent(): void {
  void loadSchedules();
}

/* ------------------------------------------------------------ ClassIsland 课程表导入（支持单双周） */

const classPlanVisible = ref(false);

function openClassPlanImport(): void {
  if (!query.classId) {
    ElMessage.warning('请先选择班级');
    return;
  }
  classPlanVisible.value = true;
}

/** 导入成功后刷新周视图与列表（grid + list 都在 loadSchedules 里） */
async function onClassPlanImported(): Promise<void> {
  await loadCourses();
  await loadSchedules();
}

onMounted(async () => {
  await loadBase();
  await loadSchedules();
  realtime.on(SOCKET_EVENTS.scheduleUpdated, onScheduleEvent);
});

onUnmounted(() => {
  realtime.off(SOCKET_EVENTS.scheduleUpdated, onScheduleEvent);
});
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">课表管理</h2>
        <p class="page-subtitle">按周次维护课程安排，支持单双周范围（起始周 - 结束周）</p>
      </div>
      <div class="toolbar">
        <el-select
          v-model="query.classId"
          placeholder="选择班级"
          style="width: 170px"
          @change="onClassChange"
        >
          <el-option v-for="item in classes" :key="item.id" :label="item.name" :value="item.id" />
        </el-select>
        <el-select v-model="query.week" placeholder="周次" style="width: 130px" @change="loadSchedules">
          <el-option v-for="week in weekOptions" :key="week" :label="`第 ${week} 周`" :value="week" />
        </el-select>
        <el-tag type="info" effect="plain">{{ currentWeekParityLabel }}</el-tag>
        <el-button :icon="'Refresh'" @click="loadSchedules">刷新</el-button>
        <el-button v-if="canManageSchedule" type="primary" :icon="'Plus'" @click="openCreate">
          新增课表
        </el-button>
        <el-button
          v-if="canManageSchedule"
          type="warning"
          plain
          :icon="'Upload'"
          @click="openClassPlanImport"
        >
          导入 ClassIsland 课程表
        </el-button>
      </div>
    </div>

    <el-card v-loading="loading" shadow="never" class="table-card timetable-card">
      <template #header>
        <div class="toolbar">
          <span>
            第 {{ query.week }} 周课表
            <span class="text-muted">（共 {{ rawSchedules.length }} 节课）</span>
          </span>
        </div>
      </template>

      <el-empty v-if="periods.length === 0" description="该周暂无课表，点击右上角新增" />
      <el-table v-else :data="periods" border size="small">
        <el-table-column label="节次" width="120" fixed>
          <template #default="{ row }">
            <div>{{ row.start }}</div>
            <div class="timetable-meta">{{ row.end }}</div>
          </template>
        </el-table-column>
        <el-table-column v-for="day in WEEKDAYS" :key="day" :label="WEEKDAY_LABELS[day]" min-width="130">
          <template #default="{ row }">
            <div v-for="item in cellItems(row, day)" :key="item.id" class="timetable-cell">
              <div class="timetable-course">
                {{ item.course?.name ?? '-' }}
                <el-tag v-if="item.weekParity !== 'ALL'" size="small" effect="plain">
                  {{ WEEK_PARITY_LABELS[item.weekParity] }}
                </el-tag>
              </div>
              <div class="timetable-meta">{{ item.location ?? '未填地点' }}</div>
              <div class="timetable-meta">{{ formatWeekRange(item.weekStart, item.weekEnd) }}</div>
              <div>
                <el-button v-if="canManageSchedule" link type="primary" size="small" @click="openEdit(item)">
                  编辑
                </el-button>
                <el-button
                  v-if="canManageSchedule"
                  link
                  type="danger"
                  size="small"
                  @click="removeSchedule(item)"
                >
                  删除
                </el-button>
              </div>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="formVisible" :title="editingId ? '编辑课表' : '新增课表'" width="480px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="90px">
        <el-form-item label="科目" prop="courseId">
          <el-select v-model="form.courseId" placeholder="选择科目" style="width: 100%" filterable>
            <el-option v-for="item in courses" :key="item.id" :label="item.name" :value="item.id" />
            <el-option-group v-if="subjectOptions.length" label="统一科目（选中后自动建课）">
              <el-option
                v-for="name in subjectOptions"
                :key="name"
                :label="name"
                :value="`${SUBJECT_PREFIX}${name}`"
              />
            </el-option-group>
          </el-select>
          <span class="text-muted" style="width: 100%">
            科目是全校统一的固定目录（语文/数学/…/听力），不必按班级单独录入；
            选这里没有的科目时会自动为该班建好同名课程
          </span>
        </el-form-item>
        <el-form-item label="星期" prop="dayOfWeek">
          <el-select v-model="form.dayOfWeek" style="width: 100%">
            <el-option v-for="day in WEEKDAYS" :key="day" :label="WEEKDAY_LABELS[day]" :value="day" />
          </el-select>
        </el-form-item>
        <el-form-item label="开始时间" prop="startTime">
          <el-time-select
            v-model="form.startTime"
            start="07:00"
            step="00:05"
            end="21:00"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="结束时间" prop="endTime">
          <el-time-select v-model="form.endTime" start="07:00" step="00:05" end="22:00" style="width: 100%" />
        </el-form-item>
        <el-form-item label="地点">
          <el-input v-model="form.location" placeholder="例如 教学楼 A301" />
        </el-form-item>
        <el-form-item label="周次范围">
          <el-input-number v-model="form.weekStart" :min="1" :max="30" />
          <span style="margin: 0 8px">至</span>
          <el-input-number v-model="form.weekEnd" :min="1" :max="30" />
        </el-form-item>
        <el-form-item label="单双周" prop="weekParity">
          <el-radio-group v-model="form.weekParity">
            <el-radio v-for="parity in WEEK_PARITY_VALUES" :key="parity" :value="parity">
              {{ WEEK_PARITY_LABELS[parity] }}
            </el-radio>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="formVisible = false">取消</el-button>
        <el-button type="primary" @click="submitForm">保存</el-button>
      </template>
    </el-dialog>

    <!-- ClassIsland 课程表导入（支持单双周；导入成功后刷新周视图与列表） -->
    <ClassPlanImportDialog
      v-model="classPlanVisible"
      :class-id="query.classId"
      :class-name="classes.find((item) => item.id === query.classId)?.name"
      @imported="onClassPlanImported"
    />
  </div>
</template>

<style scoped>
/*
 * 手机端周视图：7 天列各 130px + 节次列 120px ≈ 1030px，
 * 直接把表格最小宽度撑到 1040px，让单元格保持可读宽度；
 * 外层 el-card__body（全局 .table-card 规则）已是 overflow-x:auto，
 * 因此手指左右拖动能在卡片内看全周一~周日，页面本身不横向滚动。
 */
@media (max-width: 768px) {
  .timetable-card .el-table {
    min-width: 1040px;
  }
}
</style>
