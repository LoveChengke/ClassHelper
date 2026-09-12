<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import {
  SOCKET_EVENTS,
  formatDate,
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
const filter = reactive({ classId: '', courseId: '', keyword: '' });
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
    const params: { classId?: string; courseId?: string; keyword?: string } = {};
    if (filter.classId) params.classId = filter.classId;
    if (filter.courseId) params.courseId = filter.courseId;
    if (filter.keyword.trim()) params.keyword = filter.keyword.trim();
    homeworks.value = await homeworkApi.list(params);
  } finally {
    loading.value = false;
  }
}

async function onClassChange(): Promise<void> {
  filter.courseId = '';
  await loadCourses();
  await loadHomeworks();
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
});

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
  formVisible.value = true;
}

function openEdit(row: HomeworkDto): void {
  editingId.value = row.id;
  form.classId = row.classId;
  form.courseId = row.courseId ?? '';
  form.title = row.title;
  form.content = row.content;
  form.attachmentUrl = row.attachmentUrl ?? '';
  formVisible.value = true;
}

async function submitForm(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;

  const payload = {
    classId: form.classId,
    courseId: form.courseId || null,
    title: form.title.trim(),
    content: form.content,
    attachmentUrl: form.attachmentUrl.trim() || null,
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
          <el-select v-model="form.classId" style="width: 100%" :disabled="Boolean(editingId)">
            <el-option v-for="item in classes" :key="item.id" :label="item.name" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="所属课程">
          <el-select v-model="form.courseId" placeholder="可选" clearable style="width: 100%">
            <el-option v-for="item in courses" :key="item.id" :label="item.name" :value="item.id" />
          </el-select>
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
.text-danger {
  color: #f56c6c;
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
