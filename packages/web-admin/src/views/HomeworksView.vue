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
import { classApi, courseApi, courseIdFromExistsError, homeworkApi } from '@/api';
import { useAuthStore } from '@/stores/auth';
import { useRealtimeStore } from '@/stores/realtime';
import { useResponsive } from '@/composables/useResponsive';

const auth = useAuthStore();
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

/**
 * 详情里的附件链接。
 *
 * 服务端已限制为 http(s) / 站内相对路径，这里在渲染端再兜一层：
 * 该值最终会进 `<a href>`，一旦放行 `javascript:` 就是一条存储型 XSS（老师写、管理员点）。
 */
const attachmentHref = computed(() => {
  const value = current.value?.attachmentUrl;
  if (!value) return '';
  return (/^\/(?![\/\\])/.test(value) && !value.includes('\\')) || /^https?:\/\//i.test(value) ? value : '';
});

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
/**
 * 当前这名单属于**哪一份作业**。
 *
 * 上面两个 ref 是页面级共享状态，而详情抽屉可以连续打开不同作业（loadSubmissions 是
 * 并发发出的），因此必须记住数据归属并给请求编号：否则慢响应会把 A 的名单显示成 B 的，
 * 老师点"保存"就把 A 的未交名单整份写到 B 上（服务端会对全班逐个 upsert，且没有二次确认）。
 */
const submissionsHomeworkId = ref('');
let submissionsRequestId = 0;

const notSubmittedNames = computed(() =>
  submissionStudents.value.filter((item) => notSubmittedIds.value.includes(item.studentId)),
);

/** 打开详情时顺带读一次未交名单（教师/管理员都有权限） */
async function loadSubmissions(homeworkId: string): Promise<boolean> {
  const requestId = ++submissionsRequestId;
  submissionsLoading.value = true;
  try {
    const result = await homeworkApi.submissions(homeworkId);
    // 迟到的响应：用户已经切到别的作业了，直接丢弃
    if (requestId !== submissionsRequestId) return false;
    submissionStudents.value = result.students;
    notSubmittedIds.value = result.notSubmitted.map((item) => item.studentId);
    submissionsHomeworkId.value = homeworkId;
    return true;
  } catch {
    if (requestId !== submissionsRequestId) return false;
    submissionStudents.value = [];
    notSubmittedIds.value = [];
    submissionsHomeworkId.value = homeworkId;
    return false;
  } finally {
    if (requestId === submissionsRequestId) submissionsLoading.value = false;
  }
}

async function openSubmissions(): Promise<void> {
  if (!current.value) return;
  // 每次都以"当前这份作业"为准重新拉一次：不能因为共享状态里还有数据就跳过 ——
  // 那些数据可能属于上一次打开的作业，保存时会写到错误的作业上。
  await loadSubmissions(current.value.id);
  submissionsVisible.value = true;
}

async function saveSubmissions(): Promise<void> {
  if (!current.value) return;
  if (submissionsHomeworkId.value !== current.value.id) {
    ElMessage.warning('未交名单尚未加载完成，请稍候再保存');
    return;
  }
  submissionsSaving.value = true;
  try {
    const result = await homeworkApi.saveSubmissions(current.value.id, notSubmittedIds.value);
    submissionStudents.value = result.students;
    notSubmittedIds.value = result.notSubmitted.map((item) => item.studentId);
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
  notSubmittedIds.value = submissionStudents.value.map((item) => item.studentId);
}

async function loadClasses(): Promise<void> {
  classes.value = await classApi.list();
  if (!filter.classId && classes.value.length > 0) filter.classId = classes.value[0]?.id ?? '';
  await loadCourses();
}

async function loadCourses(): Promise<void> {
  const classId = filter.classId;
  courses.value = [];
  const list = classId ? await courseApi.list(classId) : [];
  if (classId === filter.classId) courses.value = list;
}

let homeworkRequest = 0;
async function loadHomeworks(): Promise<void> {
  const request = ++homeworkRequest;
  loading.value = true;
  try {
    const params: { classId?: string; courseId?: string; keyword?: string; date?: string } = {};
    if (filter.classId) params.classId = filter.classId;
    if (filter.courseId) params.courseId = filter.courseId;
    if (filter.keyword.trim()) params.keyword = filter.keyword.trim();
    // 按天查看：选了日期就只列那一天的作业
    if (filter.date) params.date = filter.date;
    const list = await homeworkApi.list(params);
    if (request === homeworkRequest) homeworks.value = list;
  } finally {
    if (request === homeworkRequest) loading.value = false;
  }
}

async function onClassChange(): Promise<void> {
  homeworkRequest += 1;
  filter.courseId = '';
  await Promise.all([loadCourses(), loadDayMarks(), loadHomeworks()]);
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

/**
 * 发布弹窗里可选的课程：**只列自己任教的科目**（管理员不受限）。
 *
 * 展示侧的收口与服务端 `assertCanManageSubjectContent` 同源：班主任也不自动拥有
 * 本班所有科目的作业权，所以下拉里不给"别人的科目"这个选项 —— 否则老师选了、
 * 提交、再吃一个 403，只会以为是系统坏了。留空（不指定科目）仍然允许班主任用。
 */
const ownFormCourses = computed(() =>
  auth.isAdmin ? formCourses.value : formCourses.value.filter((item) => item.teacherId === auth.user?.id),
);

/** 该班里能不能新建科目：与课表管理同权限（管理员或本班班主任） */
const canCreateCourse = computed(() => {
  if (auth.isAdmin) return true;
  return classes.value.find((item) => item.id === form.classId)?.teacherId === auth.user?.id;
});

async function loadFormCourses(): Promise<void> {
  const classId = form.classId;
  formCourses.value = [];
  if (!form.classId) {
    formCourses.value = [];
    return;
  }
  formCoursesLoading.value = true;
  try {
    const list = await courseApi.list(classId);
    if (classId === form.classId) formCourses.value = list;
  } catch {
    if (classId === form.classId) formCourses.value = [];
  } finally {
    if (classId === form.classId) formCoursesLoading.value = false;
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
    // 该班已有同名课程（本地列表过期或别人刚建）：复用那一门 ——
    // 服务端对同名课程返回 409 COURSE_EXISTS + details.courseId（不许再建第二门同名的，
    // 否则创建者会凭空成为该科任课老师，绕过科目维度的写权限）。
    const reusedId = courseIdFromExistsError(error);
    if (reusedId) {
      await loadFormCourses();
      return reusedId;
    }
    // 新建课程需要"管理员或本班班主任"权限（与课表管理一致），科任老师会被 403 拦截
    ElMessage.error(
      `新建科目「${name}」失败：${
        error instanceof Error ? error.message : '仅班主任/管理员可以在班级下新建课程'
      }，可改用已有课程或直接留空发布`,
    );
    throw error;
  }
}

const submitFormSaving = ref(false);
async function submitForm(): Promise<void> {
  if (submitFormSaving.value) return;
  submitFormSaving.value = true;
  try {
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
  } finally {
    submitFormSaving.value = false;
  }
}

/* ------------------------------------------------------------------ 批量布置（多班同发） */

/**
 * 批量布置：一次给多个班级布置同一份作业。
 *
 * 科目按**名称**提交（`subjectName`），不是一个 courseId —— 课程是"班级内"的：
 * 同一门「语文」在每个班是不同的 Course 记录，没法共用一个 id。服务端在每个目标班里查同名课程，
 * 某个班没有这门课时只让那个班失败（结果里带原因），不会自动建课、也不会拖垮整批。
 */
const bulkVisible = ref(false);
const bulkSending = ref(false);
const bulkForm = reactive({
  classIds: [] as string[],
  subjectName: '',
  title: '',
  content: '',
  attachmentUrl: '',
  assignDate: dayKeyLocal(new Date()),
});

function openBulk(): void {
  bulkForm.classIds = filter.classId ? [filter.classId] : [];
  bulkForm.subjectName = '';
  bulkForm.title = '';
  bulkForm.content = '';
  bulkForm.attachmentUrl = '';
  // 默认跟当前「按天查看」的日期一致
  bulkForm.assignDate = filter.date || dayKeyLocal(new Date());
  bulkVisible.value = true;
}

function classNameOf(classId: string): string {
  return classes.value.find((item) => item.id === classId)?.name ?? classId;
}

const submitBulkSaving = ref(false);
async function submitBulk(): Promise<void> {
  if (submitBulkSaving.value) return;
  submitBulkSaving.value = true;
  try {
    if (bulkForm.classIds.length === 0) {
      ElMessage.warning('请至少选择一个目标班级');
      return;
    }
    if (!bulkForm.title.trim()) {
      ElMessage.warning('请输入作业标题');
      return;
    }
    if (!bulkForm.content.trim()) {
      ElMessage.warning('请输入作业内容');
      return;
    }

    bulkSending.value = true;
    try {
      const result = await homeworkApi.bulkCreate({
        classIds: bulkForm.classIds,
        subjectName: bulkForm.subjectName || null,
        title: bulkForm.title.trim(),
        content: bulkForm.content,
        assignDate: bulkForm.assignDate || null,
        attachmentUrl: bulkForm.attachmentUrl.trim() || null,
      });

      const failures = result.results.filter((item) => !item.ok);
      if (failures.length === 0) {
        ElMessage.success(`作业已发布到 ${result.succeeded} 个班级，实时推送已发出`);
      } else {
        const detail = failures
          .map((item) => `${classNameOf(item.classId)}（${item.message ?? '失败'}）`)
          .join('；');
        ElMessage({
          type: result.succeeded > 0 ? 'warning' : 'error',
          message: `成功 ${result.succeeded} 个班，失败 ${failures.length} 个班｜${detail}`,
          duration: 8000,
          showClose: true,
        });
      }

      // 全部失败时把弹窗留着，方便老师改科目/改班级后直接重试
      bulkVisible.value = result.succeeded === 0;
      if (result.succeeded > 0) await loadHomeworks();
    } finally {
      bulkSending.value = false;
    }
  } finally {
    submitBulkSaving.value = false;
  }
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
  // 首屏也要拉一次"哪些天有作业"，否则日期选择器上没有任何高亮，直到手动切一次班级才出现
  await loadDayMarks();
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
        <el-button @click="openBulk">批量布置</el-button>
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
            <el-option-group v-if="ownFormCourses.length" label="我的科目">
              <el-option v-for="item in ownFormCourses" :key="item.id" :label="item.name" :value="item.id" />
            </el-option-group>
            <el-option-group
              v-if="canCreateCourse && !formCoursesLoading && newSubjectOptions.length"
              label="其他科目（新建）"
            >
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
                : canCreateCourse
                  ? '只列你任教的科目；该班还没有的科目在「其他科目（新建）」里，选中后自动建课再发布'
                  : '只列你任教的科目；需要别的科目请先由班主任/管理员在课表管理里建好并分配任课老师'
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
          <span class="form-hint">作业会出现在这一天（按天查看与 ClassHelper 班级端都按它归类）</span>
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
        <el-button type="primary" :loading="submitFormSaving" @click="submitForm">
          {{ editingId ? '保存' : '发布' }}
        </el-button>
      </template>
    </el-dialog>

    <!-- 批量布置：多班同发同一份作业；科目按名称匹配，某个班没有这门课只让那个班失败 -->
    <el-dialog v-model="bulkVisible" title="批量布置作业" width="560px">
      <el-form label-width="90px">
        <el-form-item label="目标班级" required>
          <el-select
            v-model="bulkForm.classIds"
            multiple
            filterable
            collapse-tags
            collapse-tags-tooltip
            placeholder="可多选；一次布置到所有选中班级"
            style="width: 100%"
          >
            <el-option v-for="item in classes" :key="item.id" :label="item.name" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="所属科目">
          <el-select
            v-model="bulkForm.subjectName"
            placeholder="不指定科目（仅班主任/管理员可用）"
            clearable
            filterable
            style="width: 100%"
          >
            <el-option v-for="name in SUBJECT_CATALOG" :key="name" :label="name" :value="name" />
          </el-select>
          <div class="form-hint">
            按科目名称匹配：服务端在每个班里找同名课程，某个班没有这门课时只有那个班失败（不会自动建课）
          </div>
        </el-form-item>
        <el-form-item label="所属日期">
          <el-date-picker
            v-model="bulkForm.assignDate"
            type="date"
            value-format="YYYY-MM-DD"
            :cell-class-name="dayCellClass"
            style="width: 200px"
          />
        </el-form-item>
        <el-form-item label="标题" required>
          <el-input v-model="bulkForm.title" maxlength="120" show-word-limit />
        </el-form-item>
        <el-form-item label="内容" required>
          <el-input v-model="bulkForm.content" type="textarea" :rows="5" maxlength="5000" show-word-limit />
        </el-form-item>
        <el-form-item label="附件链接">
          <el-input v-model="bulkForm.attachmentUrl" placeholder="https://..." />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="bulkVisible = false">取消</el-button>
        <el-button type="primary" :loading="bulkSending || submitBulkSaving" @click="submitBulk">
          发布到 {{ bulkForm.classIds.length }} 个班级
        </el-button>
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
                  :key="student.studentId"
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

        <div v-if="attachmentHref" class="mt-12">
          <el-link type="primary" :href="attachmentHref" target="_blank">查看附件</el-link>
        </div>

        <el-alert
          class="mt-16"
          type="info"
          :closable="false"
          title="ClassHelper 班级端实时同步"
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
          description="该班还没有学生，请先在学生名单里添加"
        />
        <el-checkbox-group v-model="notSubmittedIds">
          <el-checkbox
            v-for="student in submissionStudents"
            :key="student.studentId"
            :value="student.studentId"
          >
            {{ student.name }}（学号 {{ student.studentNo }}）
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

.form-hint {
  width: 100%;
  font-size: 12px;
  line-height: 1.5;
  color: var(--ch-text-muted);
  margin-top: 4px;
}

.content-block {
  white-space: pre-wrap;
  line-height: 1.7;
  background: var(--ch-surface-sunken);
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
  border: 1px solid var(--ch-border);
  border-radius: 12px;
  padding: 12px;
}

.submission-list :deep(.el-checkbox-group) {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
</style>
