<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import axios from 'axios';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import {
  NOTIFICATION_PRIORITIES,
  PRIORITY_LABELS,
  dayKeyLocal,
  type AiInterpretResult,
  type ApiErrorResponse,
  type ClassDto,
  type ClassPeriod,
  type CourseDto,
  type NotificationPriority,
  type StudentDto,
} from '@classhelper/shared';
import { aiApi, callApi, classApi, courseApi, homeworkApi, notificationApi } from '@/api';
import { useAuthStore } from '@/stores/auth';
import { useResponsive } from '@/composables/useResponsive';
import { findClassInSession } from '@/composables/useClassInSession';
import UrgentClassWarning from '@/components/UrgentClassWarning.vue';

/**
 * AI 助手：**一句话 → 待确认的草稿 → 老师确认后才落库**。
 *
 * 三条边界（与服务端 `modules/ai/ai.service.ts` 的设计一一对应）：
 * 1. 助手**只解析、不写业务表**：`POST /ai/interpret` 返回的是结构化参数与中文预览，
 *    真正发布走的仍是既有端点（`POST /homeworks` / `/notifications` / `/calls`）——
 *    于是科目权限断言、上课时段紧急通知保护、ClassIsland 推送全部自动复用，不会另开一条旁路。
 * 2. **参数可改**：模型的输出不可信（服务端自己也会用同一份 zod 再校验一遍），
 *    所以解析结果一律填进表单让老师过目、修改，而不是直接提交。
 * 3. **教师不读配置**：`GET /ai/settings` 要 `ai:manage`，教师读会 403 且响应拦截器会弹一条错误提示。
 *    所以只有管理者才去读配置判断"是否启用"，教师侧走"探测式"——
 *    直接解析，服务端回 `AI_NOT_CONFIGURED` 时再切到空态（见 interpret()）。
 */

const auth = useAuthStore();
const router = useRouter();
const { isMobile } = useResponsive();

const canManage = computed(() => auth.can('ai:manage'));

/* -------------------------------------------------------------- 可用性 */

/** checking = 管理者正在读配置；ready = 可以用；disabled = 还没启用（显示空态） */
type AssistantState = 'checking' | 'ready' | 'disabled';
const state = ref<AssistantState>('checking');
const disabledReason = ref('助手还没启用，请管理员在「大模型设置」里配置');

/* -------------------------------------------------------------- 输入 */

const text = ref('');
const interpreting = ref(false);
const result = ref<AiInterpretResult | null>(null);
/** 发布失败的中文原因（常驻在结果卡片里，不只靠一条会消失的 toast） */
const publishError = ref('');
const publishing = ref(false);

/**
 * 上课时段发布紧急通知的全屏二次确认（3 秒倒计时）。
 *
 * **这里曾经缺失**：助手发布走的是既有端点，服务端的 409 `URGENT_DURING_CLASS` 兜底还在，
 * 但「手动发布页」在提交前会先查一遍上课状态、命中就弹这个全屏警告，而助手这条路径直接提交 ——
 * 于是老师在上课时用助手发紧急通知**一次警告都没有**（2026-10-11 用户实测反馈）。
 * 判据与手动页共用 `composables/useClassInSession.ts`，两边必须同时命中才谈得上"一致"。
 */
const urgentWarning = reactive({
  visible: false,
  period: null as ClassPeriod | null,
  title: '',
});

/* -------------------------------------------------------------- 表单 */

const classes = ref<ClassDto[]>([]);
const courseOptions = ref<CourseDto[]>([]);
const students = ref<StudentDto[]>([]);
/** 叫人时按姓名匹配的结果说明（没匹配到要让老师自己选，不能默默留空） */
const studentHint = ref('');

const formRef = ref<FormInstance>();
const form = reactive({
  classId: '',
  courseId: '',
  title: '',
  content: '',
  assignDate: dayKeyLocal(new Date()),
  priority: 'NORMAL' as NotificationPriority,
  studentId: '',
  message: '',
});

const rules = computed<FormRules>(() => {
  const action = result.value?.action;
  const base: FormRules = {
    classId: [{ required: true, message: '请选择班级', trigger: 'change' }],
  };
  if (action === 'create_homework' || action === 'create_notification') {
    base.title = [{ required: true, message: '请填写标题', trigger: 'blur' }];
    base.content = [{ required: true, message: '请填写内容', trigger: 'blur' }];
  }
  if (action === 'call_student') {
    base.studentId = [{ required: true, message: '请选择要叫的同学', trigger: 'change' }];
  }
  return base;
});

const actionLabel = computed(() => {
  switch (result.value?.action) {
    case 'create_homework':
      return '布置作业';
    case 'create_notification':
      return '发布通知';
    case 'call_student':
      return '叫同学来';
    default:
      return '没听懂';
  }
});

const confidencePercent = computed(() => `${Math.round((result.value?.confidence ?? 0) * 100)}%`);
const confidenceType = computed(() => ((result.value?.confidence ?? 0) < 0.5 ? 'warning' : 'success'));

/* -------------------------------------------------------------- 工具 */

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isPriority(value: unknown): value is NotificationPriority {
  return typeof value === 'string' && (NOTIFICATION_PRIORITIES as readonly string[]).includes(value);
}

/**
 * 统一的错误读取。
 *
 * `api/http.ts` 的响应拦截器**已经弹过一次**服务端的中文提示（这就是不在这里重复 toast 的原因），
 * 这里只是把状态码与业务码取出来，好做分支判断（403 科目越权 / 409 上课时段紧急通知）。
 */
function readServerError(error: unknown): { status: number; code: string; message: string } {
  if (axios.isAxiosError<ApiErrorResponse>(error)) {
    return {
      status: error.response?.status ?? 0,
      code: error.response?.data?.code ?? '',
      message: error.response?.data?.message ?? error.message,
    };
  }
  return { status: 0, code: '', message: error instanceof Error ? error.message : '请求失败' };
}

/* -------------------------------------------------------------- 加载 */

async function loadClasses(): Promise<void> {
  try {
    classes.value = await classApi.list();
  } catch {
    // 拦截器已提示；拿不到班级时后面的表单会缺选项，但不至于整页报错
    classes.value = [];
  }
}

async function refreshCourses(): Promise<void> {
  courseOptions.value = form.classId ? await courseApi.list(form.classId).catch(() => []) : [];
}

async function refreshStudents(): Promise<void> {
  students.value = form.classId ? await classApi.students(form.classId).catch(() => []) : [];
}

/** 换班级：科目与名单都得跟着换，否则会把 A 班的科目发到 B 班 */
async function onClassChange(): Promise<void> {
  form.courseId = '';
  form.studentId = '';
  studentHint.value = '';
  await refreshCourses();
  if (result.value?.action === 'call_student') await refreshStudents();
}

/**
 * 叫人的学生匹配：助手的 `call_student` 通常只给 `studentName`（预览也按姓名查过），
 * 而 `POST /calls` 要的是 `studentId`。同名或没匹配到都**不猜**，交给老师在下拉里选。
 */
async function resolveStudent(params: Record<string, unknown>): Promise<void> {
  await refreshStudents();
  const byId = str(params.studentId);
  if (byId && students.value.some((item) => item.id === byId)) {
    form.studentId = byId;
    studentHint.value = '';
    return;
  }
  const name = str(params.studentName);
  if (!name) {
    studentHint.value = '助手没识别出学生姓名，请手动选择。';
    return;
  }
  const matched = students.value.filter((item) => item.name === name);
  if (matched.length === 1) {
    form.studentId = matched[0]?.id ?? '';
    studentHint.value = '';
    return;
  }
  studentHint.value =
    matched.length > 1
      ? `本班有 ${matched.length} 位「${name}」，请手动选择是哪一位。`
      : `本班没找到「${name}」，请手动选择。`;
}

/* -------------------------------------------------------------- 解析 */

async function interpret(): Promise<void> {
  const value = text.value.trim();
  if (!value) {
    ElMessage.warning('先说说要做什么，例如「给高一二班布置作业，让他们把卷子写完」');
    return;
  }

  interpreting.value = true;
  publishError.value = '';
  try {
    const data = await aiApi.interpret({ text: value, classId: form.classId || undefined });
    result.value = data;
    await fillForm(data);
  } catch (error) {
    const info = readServerError(error);
    // 未启用 / 没配服务地址与密钥：服务端用同一个业务码区分，这里统一切到空态
    if (info.code === 'AI_NOT_CONFIGURED') {
      state.value = 'disabled';
      disabledReason.value = info.message;
      result.value = null;
    }
  } finally {
    interpreting.value = false;
  }
}

/** 把解析出的参数填进表单（解析结果只是**草稿**，老师可以逐项改） */
async function fillForm(data: AiInterpretResult): Promise<void> {
  const params = data.params ?? {};
  form.classId = str(params.classId) || form.classId || classes.value[0]?.id || '';
  form.courseId = str(params.courseId);
  form.title = str(params.title);
  form.content = str(params.content);
  form.assignDate = str(params.assignDate) || dayKeyLocal(new Date());
  form.priority = isPriority(params.priority) ? params.priority : 'NORMAL';
  form.studentId = '';
  form.message = str(params.message);
  studentHint.value = '';

  await refreshCourses();
  if (data.action === 'call_student') await resolveStudent(params);

  // 表单是 v-if 出来的：等它挂载完再清掉上一次残留的校验红字
  await nextTick();
  formRef.value?.clearValidate();
}

/* -------------------------------------------------------------- 发布 */

async function confirmPublish(): Promise<void> {
  const current = result.value;
  if (!current || current.action === 'unknown') return;

  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;

  const action = current.action;

  // 上课时段的紧急通知：先查上课状态，命中就弹全屏二次确认（与手动发布页完全同一条判据）
  if (action === 'create_notification' && form.priority === 'URGENT') {
    publishing.value = true;
    try {
      const hit = await findClassInSession([form.classId]);
      if (hit) {
        urgentWarning.period = hit.period;
        urgentWarning.title = form.title.trim();
        urgentWarning.visible = true;
        return;
      }
    } finally {
      publishing.value = false;
    }
  }

  await runPublish(action, false);
}

/** 真正提交并把结果落到结果卡片上（成功 / 失败两条路都收口在这里） */
async function runPublish(action: AiInterpretResult['action'], confirmDuringClass: boolean): Promise<void> {
  publishing.value = true;
  publishError.value = '';
  try {
    await publishOnce(action, confirmDuringClass);
    finishSuccess(action);
  } catch (error) {
    await handlePublishError(error, action);
  } finally {
    publishing.value = false;
  }
}

/** 全屏警告里点了「仍然发布」 */
async function onUrgentConfirmed(): Promise<void> {
  urgentWarning.visible = false;
  const current = result.value;
  if (!current || current.action === 'unknown') return;
  await runPublish(current.action, true);
}

function onUrgentCancelled(): void {
  urgentWarning.visible = false;
  publishError.value = '已取消：正在上课，紧急通知需要二次确认';
}

/** 真正落库：复用既有的发布端点（权限断言 / 上课保护 / ClassIsland 推送都在服务端） */
async function publishOnce(action: AiInterpretResult['action'], confirmDuringClass: boolean): Promise<void> {
  if (action === 'create_homework') {
    await homeworkApi.create({
      classId: form.classId,
      courseId: form.courseId || null,
      title: form.title.trim(),
      content: form.content,
      assignDate: form.assignDate || null,
    });
    return;
  }
  if (action === 'create_notification') {
    await notificationApi.create({
      classId: form.classId,
      title: form.title.trim(),
      content: form.content,
      priority: form.priority,
      ...(confirmDuringClass ? { confirmDuringClass: true } : {}),
    });
    return;
  }
  await callApi.create({
    classId: form.classId,
    studentId: form.studentId,
    message: form.message.trim() || undefined,
  });
}

function finishSuccess(action: AiInterpretResult['action']): void {
  ElMessage.success(
    action === 'create_homework'
      ? '作业已发布，已推送给该班学生'
      : action === 'create_notification'
        ? '通知已发布，已推送给该班学生'
        : '已通知该同学到老师这里',
  );
  // 发布成功后清空结果：同一句话不会被误发第二遍
  result.value = null;
  text.value = '';
  publishError.value = '';
  studentHint.value = '';
}

/**
 * 失败分支。
 *
 * 服务端的 403（如「不是你任教的科目」）与其它 4xx 的中文提示**已经由响应拦截器弹过**，
 * 这里只做两件拦截器做不了的事：
 * 1. 把原因常驻在结果卡片里（toast 会消失，而老师需要边看参数边改）；
 * 2. 上课时段的紧急通知（409 `URGENT_DURING_CLASS`）再问一次 —— 服务端要求二次确认才放行。
 */
async function handlePublishError(error: unknown, action: AiInterpretResult['action']): Promise<void> {
  const info = readServerError(error);

  if (info.status === 409 && info.code === 'URGENT_DURING_CLASS' && action === 'create_notification') {
    try {
      await ElMessageBox.confirm(
        '正在上课，紧急通知需二次确认。确认立即把这条通知发到班级吗？',
        '上课时段发布紧急通知',
        { type: 'warning', confirmButtonText: '继续发布', cancelButtonText: '取消' },
      );
    } catch {
      publishError.value = '已取消：正在上课，紧急通知需要二次确认';
      return;
    }
    try {
      await publishOnce(action, true);
      finishSuccess(action);
    } catch (retryError) {
      publishError.value = readServerError(retryError).message;
    }
    return;
  }

  publishError.value = info.message;
}

/* -------------------------------------------------------------- 生命周期 */

onMounted(async () => {
  await loadClasses();

  if (canManage.value) {
    // 管理者：读一次配置就能给出准确空态（教师不能读，会 403）
    try {
      const settings = await aiApi.settings();
      if (!settings.enabled) {
        state.value = 'disabled';
        disabledReason.value = '助手还没启用，请管理员在「大模型设置」里配置';
      } else if (settings.provider === 'openai' && (!settings.hasApiKey || !settings.baseUrl)) {
        state.value = 'disabled';
        disabledReason.value = '还没配置大模型服务地址或密钥，请管理员在「大模型设置」里填写';
      } else {
        state.value = 'ready';
      }
    } catch {
      // 读配置失败不该把老师挡在门外：按"可以用"处理，真正的判据交给解析时的报错
      state.value = 'ready';
    }
    return;
  }

  // 教师（或权限还没拉回来时）：探测式 —— 直接允许输入，解析报 AI_NOT_CONFIGURED 再切空态
  state.value = 'ready';
});

function goSettings(): void {
  void router.push('/ai-settings');
}
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">AI 助手</h2>
        <p class="page-subtitle">
          用一句话说清要做什么，助手解析成可修改的草稿；<b>确认发布后</b>才会真正发到班级
        </p>
      </div>
    </div>

    <!-- 读配置中：先占位，避免"先看到输入框、再被空态替换"的闪动 -->
    <el-card v-if="state === 'checking'" v-loading="true" shadow="never" class="ask-card" />

    <!-- 未启用：只说明原因，不给输入框（说了也发不出去） -->
    <el-card v-else-if="state === 'disabled'" shadow="never">
      <el-empty :description="disabledReason">
        <el-button v-if="canManage" type="primary" @click="goSettings">去「大模型设置」</el-button>
      </el-empty>
    </el-card>

    <template v-else>
      <el-card shadow="never" class="ask-card">
        <div class="ask-row">
          <el-input
            v-model="text"
            type="textarea"
            :rows="2"
            maxlength="500"
            show-word-limit
            resize="none"
            placeholder="给高一二班布置作业，让他们把卷子写完"
            @keydown.enter.exact.prevent="interpret"
          />
          <el-button type="primary" :loading="interpreting" data-test="ai-interpret" @click="interpret">
            解析
          </el-button>
        </div>
        <p class="ask-hint">回车解析，Shift + 回车换行｜可以说「布置作业 / 发通知 / 叫某位同学来办公室」</p>
      </el-card>

      <el-card v-if="result" shadow="never" class="result-card">
        <template #header>
          <div class="result-header">
            <span class="result-title">{{ actionLabel }}</span>
            <el-tag :type="confidenceType" size="small" effect="light">
              可信度 {{ confidencePercent }}
            </el-tag>
          </div>
        </template>

        <!-- 没听懂：只给一句提示，不摆一堆用不上的表单 -->
        <el-empty v-if="result.action === 'unknown'" description="没听懂，请换一种说法" />

        <template v-else>
          <el-alert
            v-if="result.confidence < 0.5"
            class="result-alert"
            type="warning"
            show-icon
            :closable="false"
            title="助手把握不大，请仔细核对下面的参数再发布"
          />
          <el-alert
            v-if="publishError"
            class="result-alert"
            type="error"
            show-icon
            :closable="false"
            :title="publishError"
          />

          <p class="result-summary">{{ result.preview.summary }}</p>
          <div class="result-meta">
            <span>班级：{{ result.preview.className || '（未指定）' }}</span>
            <span v-if="result.action === 'create_homework'">
              科目：{{ result.preview.courseName || '（不指定科目，仅班主任/管理员可发）' }}
            </span>
            <span v-if="result.action === 'call_student'">
              学生：{{ result.preview.studentName || '（未识别）' }}
            </span>
          </div>
          <ul v-if="result.preview.warnings.length" class="result-warnings">
            <li v-for="(warning, index) in result.preview.warnings" :key="index">{{ warning }}</li>
          </ul>

          <el-form
            ref="formRef"
            :model="form"
            :rules="rules"
            :label-width="isMobile ? undefined : '82px'"
            :label-position="isMobile ? 'top' : 'right'"
            class="result-form"
          >
            <el-form-item label="班级" prop="classId">
              <el-select
                v-model="form.classId"
                placeholder="选择班级"
                class="result-field"
                @change="onClassChange"
              >
                <el-option v-for="item in classes" :key="item.id" :label="item.name" :value="item.id" />
              </el-select>
            </el-form-item>

            <template v-if="result.action === 'create_homework'">
              <el-form-item label="科目">
                <el-select v-model="form.courseId" clearable placeholder="不指定科目" class="result-field">
                  <el-option v-for="item in courseOptions" :key="item.id" :label="item.name" :value="item.id" />
                </el-select>
              </el-form-item>
              <el-form-item label="标题" prop="title">
                <el-input v-model="form.title" class="result-field" />
              </el-form-item>
              <el-form-item label="内容" prop="content">
                <el-input v-model="form.content" type="textarea" :rows="3" />
              </el-form-item>
              <el-form-item label="日期">
                <el-date-picker
                  v-model="form.assignDate"
                  type="date"
                  value-format="YYYY-MM-DD"
                  placeholder="作业归属日期"
                  class="result-field"
                />
              </el-form-item>
            </template>

            <template v-else-if="result.action === 'create_notification'">
              <el-form-item label="标题" prop="title">
                <el-input v-model="form.title" class="result-field" />
              </el-form-item>
              <el-form-item label="内容" prop="content">
                <el-input v-model="form.content" type="textarea" :rows="3" />
              </el-form-item>
              <el-form-item label="优先级">
                <el-select v-model="form.priority" class="result-field">
                  <el-option
                    v-for="item in NOTIFICATION_PRIORITIES"
                    :key="item"
                    :label="PRIORITY_LABELS[item]"
                    :value="item"
                  />
                </el-select>
              </el-form-item>
            </template>

            <template v-else>
              <el-form-item label="学生" prop="studentId">
                <el-select
                  v-model="form.studentId"
                  filterable
                  placeholder="选择要叫的同学"
                  class="result-field"
                >
                  <el-option
                    v-for="item in students"
                    :key="item.id"
                    :label="`${item.name}（${item.studentNo}）`"
                    :value="item.id"
                  />
                </el-select>
                <p v-if="studentHint" class="result-hint">{{ studentHint }}</p>
              </el-form-item>
              <el-form-item label="留言">
                <el-input v-model="form.message" type="textarea" :rows="2" />
              </el-form-item>
            </template>
          </el-form>

          <div class="result-actions">
            <el-button :disabled="publishing" @click="result = null">放弃</el-button>
            <el-button
              type="primary"
              :loading="publishing"
              data-test="ai-confirm"
              @click="confirmPublish"
            >
              确认发布
            </el-button>
          </div>
        </template>
      </el-card>
    </template>

    <!-- 上课时段发布紧急通知的全屏二次确认（3 秒倒计时）——与手动发布页同一个组件 -->
    <UrgentClassWarning
      :visible="urgentWarning.visible"
      :period="urgentWarning.period"
      :pending-title="urgentWarning.title"
      @cancel="onUrgentCancelled"
      @confirm="onUrgentConfirmed"
    />
  </div>
</template>

<style scoped>
.ask-card {
  margin-bottom: 16px;
}

.ask-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.ask-row :deep(.el-textarea) {
  flex: 1;
}

.ask-row .el-button {
  /* 与两行输入框的顶部对齐（按钮不该被拉成和输入框一样高） */
  flex: 0 0 auto;
  height: var(--el-component-size);
}

.ask-hint {
  margin: 8px 0 0;
  color: var(--ch-text-muted);
  font-size: var(--el-font-size-extra-small);
}

.result-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.result-title {
  font-weight: 600;
}

.result-alert {
  margin-bottom: 12px;
}

.result-summary {
  margin: 0 0 8px;
  font-size: var(--el-font-size-medium);
  font-weight: 600;
}

.result-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  color: var(--ch-text-secondary);
  font-size: var(--el-font-size-small);
}

.result-warnings {
  margin: 8px 0 0;
  padding-left: 18px;
  color: var(--el-color-warning);
  font-size: var(--el-font-size-small);
}

.result-form {
  margin-top: 16px;
}

/* 表单控件不铺满整行：长输入框在宽屏上读起来很累，也容易看错改错 */
.result-field {
  max-width: 320px;
}

.result-hint {
  margin: 4px 0 0;
  color: var(--el-color-warning);
  font-size: var(--el-font-size-extra-small);
  line-height: 1.5;
}

.result-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
