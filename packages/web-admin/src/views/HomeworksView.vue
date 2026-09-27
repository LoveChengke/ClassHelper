<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import {
  SOCKET_EVENTS,
  SUBJECT_CATALOG,
  dayKeyLocal,
  formatDate,
  shiftDayKey,
  truncate,
  type ClassDto,
  type CourseDto,
  type HomeworkDto,
  type HomeworkSubmissionsDto,
} from '@classhelper/shared';
import { classApi, courseApi, homeworkApi } from '@/api';
import { useRealtimeStore } from '@/stores/realtime';
import { useResponsive } from '@/composables/useResponsive';

const realtime = useRealtimeStore();
const { isMobile } = useResponsive();

/** 小屏下详情描述改为单列，避免文字被压成竖排 */
const detailColumns = computed(() => (isMobile.value ? 1 : 2));

const loading = ref(false);
const classes = ref<ClassDto[]>([]);
const courses = ref<CourseDto[]>([]);
const homeworks = ref<HomeworkDto[]>([]);
const filter = reactive({ classId: '', courseId: '', keyword: '', date: '' });
/** 有作业的日期（日期选择器高亮），来自 GET /homeworks/days */
const dayMarks = ref<Map<string, number>>(new Map());
const detailVisible = ref(false);
const current = ref<HomeworkDto | null>(null);

const classStudents = ref<Array<{ id: string; name: string }>>([]);
const completedMap = computed(() => {
  const total = classStudents.value.length;
  const done = current.value?.completedCount ?? 0;
  return { total, done, rate: total === 0 ? 0 : Math.round((done / total) * 100) };
});

/* ------------------------------------------------------------ 未交名单（勾选谁没交） */

const submissionsVisible = ref(false);
const submissionsLoading = ref(false);
const submissionsSaving = ref(false);
const submissionStudents = ref<HomeworkSubmissionsDto['students']>([]);
/** 勾选 = 未交（保存后其余学生一律标记为已交） */
const notSubmittedIds = ref<string[]>([]);

const notSubmittedNames = computed(() =>
  submissionStudents.value.filter((item) => notSubmittedIds.value.includes(item.userId)),
);

/** 打开详情时顺带读一次未交名单（教师/管理员都有权限） */
async function loadSubmissions(homeworkId: string): Promise<void> {
  submissionsLoading.value = true;
  try {
    const result = await homeworkApi.submissions(homeworkId);
    submissionStudents.value = result.students;
    notSubmittedIds.value = result.notSubmitted.map((item) => item.userId);
  } catch {
    submissionStudents.value = [];
    notSubmittedIds.value = [];
  } finally {
    submissionsLoading.value = false;
  }
}

async function openSubmissions(): Promise<void> {
  if (!current.value) return;
  if (submissionStudents.value.length === 0) await loadSubmissions(current.value.id);
  submissionsVisible.value = true;
}

async function saveSubmissions(): Promise<void> {
  if (!current.value) return;
  submissionsSaving.value = true;
  try {
    const result = await homeworkApi.saveSubmissions(current.value.id, notSubmittedIds.value);
    submissionStudents.value = result.students;
    notSubmittedIds.value = result.notSubmitted.map((item) => item.userId);
    if (current.value) current.value.completedCount = result.completedCount;
    ElMessage.success(`未交名单已保存（未交 ${result.notSubmitted.length} / ${result.total} 人）`);
    submissionsVisible.value = false;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存未交名单失败');
  } finally {
    submissionsSaving.value = false;
  }
}

function markAllSubmitted(): void {
  notSubmittedIds.value = [];
}

function markAllNotSubmitted(): void {
  notSubmittedIds.value = submissionStudents.value.map((item) => item.userId);
}

async function loadClasses(): Promise<void> {
  classes.value = await classApi.list();
  if (!filter.classId && classes.value.length > 0) filter.classId = classes.value[0]?.id ?? '';
  await loadCourses();
}

async function loadCourses(): Promise<void> {
  courses.value = filter.classId ? await courseApi.list(filter.classId) : [];
}

async function loadHomeworks(): Promise<void> {
  loading.value = true;
  try {
    const params: { classId?: string; courseId?: string; keyword?: string; date?: string } = {};
    if (filter.classId) params.classId = filter.classId;
    if (filter.courseId) params.courseId = filter.courseId;
    if (filter.keyword.trim()) params.keyword = filter.keyword.trim();
    // 按天查看：选了日期就只列那一天的作业
    if (filter.date) params.date = filter.date;
    homeworks.value = await homeworkApi.list(params);
  } finally {
    loading.value = false;
  }
}

async function onClassChange(): Promise<void> {
  filter.courseId = '';
  await loadCourses();
  await loadDayMarks();
  await loadHomeworks();
}

/** 拉取"哪些天有作业"（日期选择器高亮）；范围取今天前后各 45 天 */
async function loadDayMarks(): Promise<void> {
  try {
    const today = dayKeyLocal(new Date());
    const result = await homeworkApi.days({
      classId: filter.classId || undefined,
      from: shiftDayKey(today, -45),
      to: shiftDayKey(today, 45),
    });
    dayMarks.value = new Map(result.days.map((item) => [item.date, item.count]));
  } catch {
    dayMarks.value = new Map();
  }
}

/** 日期选择器：有作业的日期加高亮类 */
function dayCellClass(date: Date): string {
  return dayMarks.value.has(dayKeyLocal(date)) ? 'day-has-homework' : '';
}

/* ------------------------------------------------------------ 发布 / 编辑 */

const formVisible = ref(false);
const formRef = ref<FormInstance>();
const editingId = ref<string | null>(null);
const form = reactive({
  classId: '',
  courseId: '',
  title: '',
  content: '',
  attachmentUrl: '',
  /** 作业所属日期（YYYY-MM-DD）：决定它出现在哪一天的「按天查看」里 */
  assignDate: dayKeyLocal(new Date()),
});

/**
 * 发布弹窗里的「其他科目（新建）」选项前缀。
 * 下拉只有课程 id 一个 v-model，新建科目用 `subject:语文` 这种带前缀的伪值表达，
 * 提交时再解析成「复用同名课程 / 新建课程」。
 */
const NEW_SUBJECT_PREFIX = 'subject:';
/** 弹窗里所选班级的课程（与页面筛选用的 courses 分开，避免互相污染） */
const formCourses = ref<CourseDto[]>([]);
/** 课程列表加载中：加载完成前不展示「其他科目（新建）」，避免把该班已有科目误当成新科目 */
const formCoursesLoading = ref(false);

/** 该班还没有的科目（来自 shared 的 SUBJECT_CATALOG） */
const newSubjectOptions = computed(() => {
  const existing = new Set(formCourses.value.map((item) => item.name));
  return SUBJECT_CATALOG.filter((name) => !existing.has(name));
});

async function loadFormCourses(): Promise<void> {
  if (!form.classId) {
    formCourses.value = [];
    return;
  }
  formCoursesLoading.value = true;
  try {
    formCourses.value = await courseApi.list(form.classId);
  } catch {
    formCourses.value = [];
  } finally {
    formCoursesLoading.value = false;
  }
}

const rules: FormRules = {
  classId: [{ required: true, message: '请选择目标班级', trigger: 'change' }],
  title: [{ required: true, message: '请输入作业标题', trigger: 'blur' }],
  content: [{ required: true, message: '请输入作业内容', trigger: 'blur' }],
};

function openCreate(): void {
  editingId.value = null;
  form.classId = filter.classId || classes.value[0]?.id || '';
  form.courseId = '';
  form.title = '';
  form.content = '';
  form.attachmentUrl = '';
  // 默认跟当前「按天查看」的日期一致：老师多半就是在给这一天留作业
  form.assignDate = filter.date || dayKeyLocal(new Date());
  formVisible.value = true;
  void loadFormCourses();
}

function openEdit(row: HomeworkDto): void {
  editingId.value = row.id;
  form.classId = row.classId;
  form.courseId = row.courseId ?? '';
  form.title = row.title;
  form.content = row.content;
  form.attachmentUrl = row.attachmentUrl ?? '';
  form.assignDate = row.assignDate;
  formVisible.value = true;
  void loadFormCourses();
}

/** 弹窗里改班级：课程下拉要跟着换成该班的课程 */
async function onFormClassChange(): Promise<void> {
  form.courseId = '';
  await loadFormCourses();
}

/**
 * 解析课程下拉的取值：
 * - 已有课程 id → 直接用；
 * - `subject:语文`（其他科目新建）→ 该班已有同名课程则复用，否则先 `courseApi.create` 建课再返回新 id；
 * - 空 → 不关联课程。
 */
async function resolveCourseId(): Promise<string | null> {
  const value = form.courseId;
  if (!value) return null;
  if (!value.startsWith(NEW_SUBJECT_PREFIX)) return value;

  const name = value.slice(NEW_SUBJECT_PREFIX.length);
  const reuse =
    formCourses.value.find((item) => item.name === name) ??
    (await courseApi.list(form.classId).catch(() => [])).find((item) => item.name === name);
  if (reuse) return reuse.id;

  try {
    const created = await courseApi.create({ classId: form.classId, name });
    formCourses.value = [...formCourses.value, created];
    return created.id;
  } catch (error) {
    // 新建课程需要"管理员或本班班主任"权限（与课表管理一致），科任老师会被 403 拦截
    ElMessage.error(
      `新建科目「${name}」失败：${
        error instanceof Error ? error.message : '仅班主任/管理员可以在班级下新建课程'
      }，可改用已有课程或直接留空发布`,
    );
    throw error;
  }
}

async function submitForm(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;

  let courseId: string | null;
  try {
    courseId = await resolveCourseId();
  } catch {
    // 建课失败的提示已在 resolveCourseId 里给出，这里保持弹窗打开让老师改选
    return;
  }

  const payload = {
    classId: form.classId,
    courseId,
    title: form.title.trim(),
    content: form.content,
    attachmentUrl: form.attachmentUrl.trim() || null,
    assignDate: form.assignDate || dayKeyLocal(new Date()),
  };

  if (editingId.value) {
    await homeworkApi.update(editingId.value, payload);
    ElMessage.success('作业已更新');
  } else {
    await homeworkApi.create(payload);
    ElMessage.success('作业已发布，实时推送已发出');
  }
  formVisible.value = false;
  await loadHomeworks();
}

async function removeHomework(row: HomeworkDto): Promise<void> {
  await ElMessageBox.confirm(`删除作业「${row.title}」？`, '确认', { type: 'warning' });
  await homeworkApi.remove(row.id);
  ElMessage.success('已删除');
  await loadHomeworks();
}

async function openDetail(row: HomeworkDto): Promise<void> {
  current.value = await homeworkApi.detail(row.id);
  const students = await classApi.students(row.classId);
  classStudents.value = students.map((item) => ({ id: item.id, name: item.name }));
  void loadSubmissions(row.id);
  detailVisible.value = true;
}

function onHomeworkEvent(): void {
  void loadHomeworks();
}

onMounted(async () => {
  await loadClasses();
  await loadHomeworks();
  realtime.on(SOCKET_EVENTS.homeworkNew, onHomeworkEvent);
  realtime.on(SOCKET_EVENTS.homeworkUpdated, onHomeworkEvent);
  realtime.on(SOCKET_EVENTS.homeworkStatus, onHomeworkEvent);
});

onUnmounted(() => {
  realtime.off(SOCKET_EVENTS.homeworkNew, onHomeworkEvent);
  realtime.off(SOCKET_EVENTS.homeworkUpdated, onHomeworkEvent);
  realtime.off(SOCKET_EVENTS.homeworkStatus, onHomeworkEvent);
});
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">作业发布</h2>
        <p class="page-subtitle">发布后立即通过 WebSocket 广播到学生客户端（homework:new）</p>
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
        <el-select
          v-model="filter.courseId"
          placeholder="全部课程"
          clearable
          style="width: 150px"
          @change="loadHomeworks"
        >
          <el-option v-for="item in courses" :key="item.id" :label="item.name" :value="item.id" />
        </el-select>
        <el-date-picker
          v-model="filter.date"
          type="date"
          value-format="YYYY-MM-DD"
          placeholder="按天查看"
          clearable
          class="day-picker"
          :cell-class-name="dayCellClass"
          @change="loadHomeworks"
        />
        <el-input
          v-model="filter.keyword"
          placeholder="搜索标题/内容"
          clearable
          style="width: 170px"
          @keyup.enter="loadHomeworks"
          @clear="loadHomeworks"
        />
        <el-button type="primary" :icon="'Plus'" @click="openCreate">发布作业</el-button>
      </div>
    </div>

    <el-card shadow="never" class="table-card">
      <el-table v-loading="loading" :data="homeworks" empty-text="暂无作业">
        <el-table-column prop="title" label="标题" min-width="200" show-overflow-tooltip />
        <el-table-column label="课程" width="110">
          <template #default="{ row }">{{ row.course?.name ?? '-' }}</template>
        </el-table-column>
        <el-table-column label="已完成" width="100">
          <template #default="{ row }">{{ row.completedCount ?? 0 }} 人</template>
        </el-table-column>
        <el-table-column label="发布时间" width="170">
          <template #default="{ row }">{{ formatDate(row.createdAt, true) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="210" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openDetail(row)">详情</el-button>
            <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button link type="danger" @click="removeHomework(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="formVisible" :title="editingId ? '编辑作业' : '发布作业'" width="560px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="90px">
        <el-form-item label="目标班级" prop="classId">
          <el-select
            v-model="form.classId"
            style="width: 100%"
            :disabled="Boolean(editingId)"
            @change="onFormClassChange"
          >
            <el-option v-for="item in classes" :key="item.id" :label="item.name" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="所属课程">
          <el-select
            v-model="form.courseId"
            placeholder="可选"
            clearable
            filterable
            :loading="formCoursesLoading"
            style="width: 100%"
          >
            <el-option-group v-if="formCourses.length" label="已有课程">
              <el-option v-for="item in formCourses" :key="item.id" :label="item.name" :value="item.id" />
            </el-option-group>
            <el-option-group v-if="!formCoursesLoading && newSubjectOptions.length" label="其他科目（新建）">
              <el-option
                v-for="name in newSubjectOptions"
                :key="`new-${name}`"
                :label="name"
                :value="`${NEW_SUBJECT_PREFIX}${name}`"
              />
            </el-option-group>
          </el-select>
          <div class="form-hint">
            {{
              formCoursesLoading
                ? '正在加载该班课程…'
                : '该班还没有的科目在「其他科目（新建）」里，选中后会自动建课再发布（需班主任/管理员）'
            }}
          </div>
        </el-form-item>
        <el-form-item label="所属日期">
          <el-date-picker
            v-model="form.assignDate"
            type="date"
            value-format="YYYY-MM-DD"
            :cell-class-name="dayCellClass"
            style="width: 200px"
          />
          <span class="form-hint">作业会出现在这一天（按天查看与学生端都按它归类）</span>
        </el-form-item>
        <el-form-item label="标题" prop="title">
          <el-input v-model="form.title" maxlength="120" show-word-limit />
        </el-form-item>
        <el-form-item label="内容" prop="content">
          <el-input v-model="form.content" type="textarea" :rows="5" maxlength="5000" show-word-limit />
        </el-form-item>
        <el-form-item label="附件链接">
          <el-input v-model="form.attachmentUrl" placeholder="https://..." />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="formVisible = false">取消</el-button>
        <el-button type="primary" @click="submitForm">{{ editingId ? '保存' : '发布' }}</el-button>
      </template>
    </el-dialog>

    <el-drawer v-model="detailVisible" size="46%" :title="current?.title ?? '作业详情'">
      <template v-if="current">
        <el-descriptions :column="detailColumns" border size="small">
          <el-descriptions-item label="课程">{{ current.course?.name ?? '-' }}</el-descriptions-item>
          <el-descriptions-item label="发布人">{{ current.creator?.name ?? '-' }}</el-descriptions-item>
          <el-descriptions-item label="发布时间">
            {{ formatDate(current.createdAt, true) }}
          </el-descriptions-item>
          <el-descriptions-item label="完成情况" :span="2">
            已完成 {{ completedMap.done }} / {{ completedMap.total }} 人（{{ completedMap.rate }}%）
            <el-progress :percentage="completedMap.rate" :stroke-width="10" class="mt-12" />
          </el-descriptions-item>
          <el-descriptions-item label="未交名单" :span="2">
            <div v-loading="submissionsLoading" class="submission-summary">
              <template v-if="submissionStudents.length === 0">该班还没有学生账号</template>
              <template v-else-if="notSubmittedNames.length === 0">
                <el-tag type="success" size="small" effect="light">全部已交</el-tag>
              </template>
              <template v-else>
                <el-tag
                  v-for="student in notSubmittedNames"
                  :key="student.userId"
                  type="warning"
                  size="small"
                  effect="light"
                  class="submission-tag"
                >
                  {{ student.name }}
                </el-tag>
              </template>
              <el-button size="small" type="primary" plain @click="openSubmissions">勾选未交</el-button>
            </div>
          </el-descriptions-item>
        </el-descriptions>

        <div class="mt-16">
          <h4>作业内容</h4>
          <p class="content-block">{{ current.content }}</p>
        </div>

        <div v-if="current.attachmentUrl" class="mt-12">
          <el-link type="primary" :href="current.attachmentUrl" target="_blank">查看附件</el-link>
        </div>

        <el-alert
          class="mt-16"
          type="info"
          :closable="false"
          title="学生端实时同步"
          :description="`学生客户端在收到 homework:new / homework:status 事件后会自动刷新列表，并在离线时使用本地缓存（摘要：${truncate(current.content, 30)}）`"
        />
      </template>
    </el-drawer>

    <!-- 未交名单：勾选谁没交，其余学生自动标记为已交 -->
    <el-dialog v-model="submissionsVisible" title="未交名单" width="520px">
      <p class="text-muted" style="margin-top: 0">
        勾选
        <strong>没交作业</strong>
        的同学，保存后其余同学会自动标记为已完成。
      </p>
      <div class="submission-toolbar">
        <el-button size="small" @click="markAllSubmitted">全部已交</el-button>
        <el-button size="small" @click="markAllNotSubmitted">全部未交</el-button>
        <span class="text-muted">未交 {{ notSubmittedIds.length }} / {{ submissionStudents.length }} 人</span>
      </div>
      <div v-loading="submissionsLoading" class="submission-list">
        <el-empty
          v-if="submissionStudents.length === 0 && !submissionsLoading"
          description="该班还没有学生账号"
        />
        <el-checkbox-group v-model="notSubmittedIds">
          <el-checkbox v-for="student in submissionStudents" :key="student.userId" :value="student.userId">
            {{ student.name }}（{{ student.username }}）
          </el-checkbox>
        </el-checkbox-group>
      </div>
      <template #footer>
        <el-button @click="submissionsVisible = false">取消</el-button>
        <el-button type="primary" :loading="submissionsSaving" @click="saveSubmissions">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
/* 日期选择器：有作业的日子加一个圆点，翻月份时一眼看出哪天有作业 */
:deep(.day-has-homework .el-date-table-cell__text)::after {
  content: '';
  position: absolute;
  left: 50%;
  bottom: 2px;
  width: 4px;
  height: 4px;
  margin-left: -2px;
  border-radius: 50%;
  background: currentColor;
}

.day-picker {
  width: 168px;
}

.form-hint {
  margin-left: 10px;
  opacity: 0.65;
  font-size: 12px;
}

.text-danger {
  color: #f56c6c;
}

.form-hint {
  width: 100%;
  font-size: 12px;
  line-height: 1.5;
  color: #909399;
  margin-top: 4px;
}

.content-block {
  white-space: pre-wrap;
  line-height: 1.7;
  background: #fafafa;
  border-radius: 12px;
  padding: 12px;
  margin: 0;
}

/* ---------------------------------------------------------------- 未交名单 */

.submission-summary {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.submission-tag {
  margin: 0;
}

.submission-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.submission-list {
  max-height: 46vh;
  overflow-y: auto;
  border: 1px solid #eef0f5;
  border-radius: 12px;
  padding: 12px;
}

.submission-list :deep(.el-checkbox-group) {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
</style>
