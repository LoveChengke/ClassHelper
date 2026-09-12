<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import {
  SOCKET_EVENTS,
  WEEKDAYS,
  WEEKDAY_LABELS,
  buildWeekOptions,
  formatWeekRange,
  type ClassDto,
  type CourseDto,
  type CreateScheduleRequest,
  type ScheduleDto,
  type ScheduleWeekView,
} from '@classhelper/shared';
import { classApi, courseApi, dashboardApi, scheduleApi } from '@/api';
import { useRealtimeStore } from '@/stores/realtime';

const realtime = useRealtimeStore();

const loading = ref(false);
const classes = ref<ClassDto[]>([]);
const courses = ref<CourseDto[]>([]);
const grid = ref<ScheduleWeekView | null>(null);
const rawSchedules = ref<ScheduleDto[]>([]);

const query = reactive({ classId: '', week: 1 });
const weekOptions = ref<number[]>(buildWeekOptions(20));

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

async function loadBase(): Promise<void> {
  const [classList, term] = await Promise.all([classApi.list(), dashboardApi.term()]);
  classes.value = classList;
  weekOptions.value = buildWeekOptions(term.maxWeek);
  query.week = term.currentWeek;
  if (!query.classId && classList.length > 0) query.classId = classList[0]?.id ?? '';
  if (query.classId) await loadCourses();
}

async function loadCourses(): Promise<void> {
  courses.value = query.classId ? await courseApi.list(query.classId) : [];
}

async function loadSchedules(): Promise<void> {
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
    grid.value = weekGrid;
    rawSchedules.value = list;
  } finally {
    loading.value = false;
  }
}

async function onClassChange(): Promise<void> {
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
  form.courseId = courses.value[0]?.id ?? '';
  form.dayOfWeek = 1;
  form.startTime = '08:00';
  form.endTime = '08:45';
  form.location = '';
  form.weekStart = 1;
  form.weekEnd = weekOptions.value.at(-1) ?? 20;
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
  formVisible.value = true;
}

async function submitForm(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;
  if (form.startTime >= form.endTime) {
    ElMessage.warning('结束时间必须晚于开始时间');
    return;
  }

  const payload: CreateScheduleRequest = {
    classId: query.classId,
    courseId: form.courseId,
    dayOfWeek: Number(form.dayOfWeek),
    startTime: form.startTime,
    endTime: form.endTime,
    location: form.location || null,
    weekStart: Number(form.weekStart),
    weekEnd: Number(form.weekEnd),
  };

  if (editingId.value) {
    await scheduleApi.update(editingId.value, payload);
    ElMessage.success('课表已更新');
  } else {
    await scheduleApi.create(payload);
    ElMessage.success('课表已新增');
  }
  formVisible.value = false;
  await loadSchedules();
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
        <el-button :icon="'Refresh'" @click="loadSchedules">刷新</el-button>
        <el-button type="primary" :icon="'Plus'" @click="openCreate">新增课表</el-button>
      </div>
    </div>

    <el-card v-loading="loading" shadow="never" class="table-card">
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
              <div class="timetable-course">{{ item.course?.name ?? '-' }}</div>
              <div class="timetable-meta">{{ item.location ?? '未填地点' }}</div>
              <div class="timetable-meta">{{ formatWeekRange(item.weekStart, item.weekEnd) }}</div>
              <div>
                <el-button link type="primary" size="small" @click="openEdit(item)">编辑</el-button>
                <el-button link type="danger" size="small" @click="removeSchedule(item)">删除</el-button>
              </div>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="formVisible" :title="editingId ? '编辑课表' : '新增课表'" width="480px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="90px">
        <el-form-item label="课程" prop="courseId">
          <el-select v-model="form.courseId" placeholder="选择课程" style="width: 100%">
            <el-option v-for="item in courses" :key="item.id" :label="item.name" :value="item.id" />
          </el-select>
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
      </el-form>
      <template #footer>
        <el-button @click="formVisible = false">取消</el-button>
        <el-button type="primary" @click="submitForm">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>
