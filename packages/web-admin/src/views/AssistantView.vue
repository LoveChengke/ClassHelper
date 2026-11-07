<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import axios from 'axios';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  COURSEWARE_MAX_BYTES,
  type AiAttachment,
  type AiCapability,
  type AiConversationResult,
  type AiConversationRequest,
  type AiTaskDto,
  type AiPlanStep,
  type ClassDto,
  type ClassPeriod,
} from '@classhelper/shared';
import { aiApi, classApi } from '@/api';
import { api } from '@/api/http';
import { useAuthStore } from '@/stores/auth';
import { hashAttachment, importFileBase64 } from '@/composables/assistantFiles';
import { findClassInSession } from '@/composables/useClassInSession';
import AssistantData from '@/components/AssistantData.vue';
import UrgentClassWarning from '@/components/UrgentClassWarning.vue';
import { observeTask } from '@/composables/assistantStream';
interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  result?: AiConversationResult;
  activity?: string[];
  state?: 'working' | 'done' | 'stopped';
}
const auth = useAuthStore();
const text = ref(''),
  classId = ref(''),
  classes = ref<ClassDto[]>([]),
  capabilities = ref<AiCapability[]>([]);
const messages = ref<ChatMessage[]>([]),
  attachments = ref<AiAttachment[]>([]);
const files = new Map<string, File>();
const input = ref<HTMLInputElement>(),
  conversation = ref<HTMLElement>();
const busy = ref(false),
  hashing = ref(false),
  executing = ref(false),
  progress = ref(0),
  error = ref('');
const followScroll = ref(true);
const disabled = ref(false),
  dragging = ref(false),
  active = ref<AiConversationResult>();
const credentials = reactive<Record<string, Record<string, string>>>({});
const urgent = reactive({ visible: false, period: null as ClassPeriod | null, title: '' });
let resolveUrgent: ((confirmed: boolean) => void) | undefined;
let controller: AbortController | undefined;
let disposed = false;
let observing = false;
let lastRequest: AiConversationRequest | undefined;
const taskId = ref(''),
  taskHistory = ref<AiTaskDto[]>([]);
const pending = computed(
  () => active.value?.steps.some((step) => !['succeeded', 'blocked'].includes(step.status)) ?? false,
);
const ready = computed(
  () =>
    pending.value &&
    active.value!.steps.every((step) =>
      ['prepared', 'confirmed', 'failed', 'succeeded'].includes(step.status),
    ),
);
const statusLabels: Record<string, string> = {
  draft: '准备附件',
  prepared: '待确认',
  confirmed: '已确认',
  running: '执行中',
  succeeded: '已完成',
  failed: '失败',
  blocked: '已停止，请核对',
};
function failure(e: unknown): string {
  return axios.isAxiosError(e)
    ? (e.response?.data?.message ?? e.message)
    : e instanceof Error
      ? e.message
      : '操作失败';
}
function clearCredentials(): void {
  for (const key of Object.keys(credentials)) delete credentials[key];
  for (const step of active.value?.steps ?? []) credentials[step.id] = {};
}
async function scroll(): Promise<void> {
  await nextTick();
  if (!followScroll.value) return;
  conversation.value?.scrollTo({ top: conversation.value.scrollHeight, behavior: 'smooth' });
}
async function selectFiles(selected: FileList | File[]): Promise<void> {
  if (busy.value || executing.value || hashing.value || pending.value) return;
  hashing.value = true;
  error.value = '';
  controller = new AbortController();
  try {
    for (const file of [...selected]) {
      if (!file.size || file.size > COURSEWARE_MAX_BYTES)
        throw new Error('文件大小须在 1 字节到 512 MB 之间');
      if (attachments.value.length >= 8) throw new Error('一次最多添加 8 个文件');
      const attachment = await hashAttachment(file, controller.signal);
      if (disposed) return;
      if (
        attachments.value.some((item) => item.sha256 === attachment.sha256 && item.name === attachment.name)
      )
        continue;
      files.set(attachment.id, file);
      attachments.value.push(attachment);
    }
  } catch (e) {
    if (!disposed && !axios.isCancel(e) && !(e instanceof DOMException && e.name === 'AbortError'))
      error.value = failure(e);
  } finally {
    hashing.value = false;
  }
}
function choose(event: Event): void {
  const target = event.target as HTMLInputElement;
  if (target.files) void selectFiles(target.files);
  target.value = '';
}
function drop(event: DragEvent): void {
  dragging.value = false;
  if (event.dataTransfer?.files) void selectFiles(event.dataTransfer.files);
}
function removeFile(id: string): void {
  files.delete(id);
  attachments.value = attachments.value.filter((item) => item.id !== id);
}
async function prepare(result: AiConversationResult): Promise<void> {
  if (!result.planId || !result.steps.some((step) => step.status === 'draft')) return;
  const payload: Record<string, { contentBase64: string }> = {};
  for (const step of result.steps.filter((item) => item.status === 'draft')) {
    const id = step.attachmentId!,
      file = files.get(id);
    if (!file) throw new Error('请重新选择原附件');
    if (!payload[id]) payload[id] = { contentBase64: await importFileBase64(file) };
  }
  for (const [id, file] of Object.entries(payload))
    result.steps = await aiApi.prepare(result.planId, { [id]: file });
}
async function retryTask(): Promise<void> {
  if (lastRequest) await send(true);
}
async function send(retrying = false): Promise<void> {
  if ((!retrying && !text.value.trim()) || busy.value || executing.value || hashing.value) return;
  busy.value = true;
  error.value = '';
  controller = new AbortController();
  let message: ChatMessage | undefined;
  const uploadFiles = attachments.value.map((attachment) => ({ attachment, file: files.get(attachment.id) }));
  try {
    if (active.value?.planId && pending.value) await aiApi.discard(active.value.planId);
    clearCredentials();
    active.value = undefined;
    const content = retrying ? lastRequest!.text : text.value.trim(),
      history = messages.value.slice(-18).map(({ role, content }) => ({ role, content }));
    if (!retrying) {
      lastRequest = {
        text: content,
        classId: classId.value || undefined,
        messages: history,
        attachments: [...attachments.value],
      };
      messages.value.push({ role: 'user', content });
    }
    message = reactive<ChatMessage>({ role: 'assistant', content: '', activity: [], state: 'working' });
    messages.value.push(message);
    text.value = '';
    followScroll.value = true;
    await scroll();
    if (!retrying || !taskId.value) {
      taskId.value = (await aiApi.createTask(lastRequest!)).id;
      message.activity!.push(
        attachments.value.length ? '正在上传附件，完成后将转入后台' : '任务已提交到后台',
      );
      for (const { attachment, file } of uploadFiles) {
        if (!file) throw new Error('请重新选择原附件');
        await api.stageAiAttachment(taskId.value, attachment.id, file, controller.signal);
      }
    }
    controller.signal.throwIfAborted();
    await aiApi.startTask(taskId.value);
    if (disposed) return;
    observing = true;
    const result = reactive(
      await observeTask(
        taskId.value,
        (event) => {
          if (disposed || controller?.signal.aborted) return;
          if (event.type === 'status' && message!.activity?.at(-1) !== event.message)
            message!.activity = [...(message!.activity ?? []), event.message].slice(-60);
          if (event.type === 'message') message!.content = event.text;
          void scroll();
        },
        controller.signal,
      ),
    );
    if (disposed) return;
    active.value = result;
    message.content = result.message;
    message.result = result;
    try {
      await prepare(result);
    } finally {
      message.result = result;
    }
    for (const step of result.steps) credentials[step.id] = {};
  } catch (e) {
    if (controller.signal.aborted) {
      if (message) message.content = '已停止生成，任务已保留，可继续重试。';
    } else if (!disposed && !axios.isCancel(e)) {
      error.value = failure(e);
      if (message) message.content = '任务尚未完成，可继续重试。';
      if (typeof e === 'object' && e && 'code' in e && e.code === 'AI_NOT_CONFIGURED') disabled.value = true;
    }
  } finally {
    observing = false;
    if (message) message.state = controller.signal.aborted || error.value ? 'stopped' : 'done';
    busy.value = false;
    if (!disposed) taskHistory.value = await aiApi.tasks().catch(() => taskHistory.value);
    await scroll();
  }
}
function composerKey(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void send();
  }
}
async function newConversation(): Promise<void> {
  if (busy.value || executing.value || hashing.value) return;
  if (pending.value && active.value?.planId) {
    try {
      await ElMessageBox.confirm('开始新对话将取消当前待确认计划。', '新对话', {
        confirmButtonText: '开始新对话',
        cancelButtonText: '保留当前对话',
      });
    } catch {
      return;
    }
    await aiApi.discard(active.value.planId);
  }
  clearCredentials();
  active.value = undefined;
  messages.value = [];
  attachments.value = [];
  files.clear();
  lastRequest = undefined;
  text.value = '';
  error.value = '';
}
async function urgentConfirmation(period: ClassPeriod | null, title: string): Promise<boolean> {
  urgent.period = period;
  urgent.title = title;
  urgent.visible = true;
  return new Promise((resolve) => {
    resolveUrgent = resolve;
  });
}
function finishUrgent(value: boolean): void {
  urgent.visible = false;
  resolveUrgent?.(value);
  resolveUrgent = undefined;
}
async function refreshPlan(result: AiConversationResult): Promise<void> {
  if (result.planId) result.steps = await aiApi.plan(result.planId);
}
function tablePreview(
  step: AiPlanStep,
): { columns: string[]; fields: { key: string; label: string; required: boolean }[] } | null {
  const value = step.preview as
    { columns?: string[]; fields?: { key: string; label: string; required: boolean }[] } | undefined;
  return value?.columns && value.fields ? { columns: value.columns, fields: value.fields } : null;
}
function mapping(step: AiPlanStep): Record<string, string> {
  return (step.params?.mapping as Record<string, string>) ?? {};
}
async function updateMapping(step: AiPlanStep, key: string, value: string): Promise<void> {
  if (!active.value?.planId) return;
  busy.value = true;
  try {
    active.value.steps = await aiApi.prepare(
      active.value.planId,
      {},
      { [step.id]: { ...mapping(step), [key]: value } },
    );
  } catch (e) {
    error.value = failure(e);
  } finally {
    busy.value = false;
  }
}
async function execute(urgentConfirmed = false): Promise<void> {
  const result = active.value;
  if (!result?.planId || !ready.value || executing.value) return;
  executing.value = true;
  error.value = '';
  progress.value = 0;
  controller = new AbortController();
  try {
    const danger = result.steps.filter((step) => step.dangerous && step.status !== 'succeeded');
    if (danger.length)
      await ElMessageBox.confirm(danger.map((step) => step.summary).join('；'), '确认执行这些操作', {
        type: 'warning',
        confirmButtonText: '确认执行',
        cancelButtonText: '取消',
      });
    for (const step of result.steps)
      if (
        step.action.startsWith('notifications.') &&
        step.params?.priority === 'URGENT' &&
        step.status !== 'succeeded' &&
        !urgentConfirmed
      ) {
        const ids = step.params.classId
            ? [String(step.params.classId)]
            : ((step.params.classIds as string[]) ?? []),
          hit = await findClassInSession(ids);
        if (hit) {
          if (!(await urgentConfirmation(hit.period, String(step.params.title ?? '')))) return;
          urgentConfirmed = true;
        }
      }
    if (!taskId.value) throw new Error('请重新打开本次后台任务');
    await aiApi.executeTask(taskId.value, {
      confirmed: true,
      extraConfirmed: danger.length > 0,
      urgentConfirmed,
      secrets: { ...credentials },
    });
    clearCredentials();
    const activity = reactive<ChatMessage>({
      role: 'assistant',
      content: '',
      activity: [],
      state: 'working',
    });
    messages.value.push(activity);
    try {
      const completed = await observeTask(
        taskId.value,
        (event) => {
          if (event.type === 'status' && activity.activity!.at(-1) !== event.message)
            activity.activity!.push(event.message);
          void scroll();
        },
        controller.signal,
      );
      result.steps = completed.steps;
      activity.content = '所有步骤已完成。';
    } finally {
      activity.state = error.value ? 'stopped' : 'done';
    }
    await refreshPlan(result);
    messages.value.push({
      role: 'assistant',
      content: `已完成 ${result.steps.filter((step) => step.status === 'succeeded').length} 项操作。`,
    });
    ElMessage.success('操作已完成');
  } catch (e) {
    if (e !== 'cancel' && e !== 'close') error.value = failure(e);
    await refreshPlan(result).catch(() => undefined);
  } finally {
    executing.value = false;
    await scroll();
  }
}
async function cancelPlan(): Promise<void> {
  if (executing.value) {
    if (taskId.value) await aiApi.stopTask(taskId.value);
    controller?.abort();
    return;
  }
  if (active.value?.planId) {
    await aiApi.discard(active.value.planId);
    if (taskId.value) await aiApi.stopTask(taskId.value);
    await refreshPlan(active.value);
  }
  clearCredentials();
}
async function stopGeneration(): Promise<void> {
  if (taskId.value) await aiApi.stopTask(taskId.value);
  controller?.abort();
}
async function resumeTask(id: string): Promise<void> {
  if (busy.value || executing.value) return;
  error.value = '';
  const saved = await aiApi.task(id);
  taskId.value = id;
  lastRequest = { text: saved.text };
  const message = reactive<ChatMessage>({
    role: 'assistant',
    content: saved.result?.message ?? '',
    activity: saved.events.filter((item) => item.type === 'status').map((item) => item.message),
    state: 'done',
    result: saved.result,
  });
  messages.value = [{ role: 'user', content: saved.text }, message];
  active.value = saved.result;
  clearCredentials();
  if (saved.error) error.value = saved.error;
  if (!['planning', 'executing'].includes(saved.state)) {
    await scroll();
    return;
  }
  busy.value = saved.state === 'planning';
  executing.value = saved.state === 'executing';
  message.state = 'working';
  controller = new AbortController();
  try {
    const result = reactive(
      await observeTask(
        id,
        (event) => {
          if (event.type === 'status' && message.activity!.at(-1) !== event.message)
            message.activity!.push(event.message);
          if (event.type === 'message') message.content = event.text;
          void scroll();
        },
        controller.signal,
      ),
    );
    active.value = result;
    message.result = result;
    message.content = saved.state === 'executing' ? '任务已完成。' : result.message;
    clearCredentials();
  } catch (e) {
    if (!disposed && !controller.signal.aborted) error.value = failure(e);
  } finally {
    message.state = error.value ? 'stopped' : 'done';
    busy.value = false;
    executing.value = false;
    await scroll();
  }
}
function size(value: number): string {
  return value < 1024 * 1024 ? `${Math.ceil(value / 1024)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`;
}
onMounted(async () => {
  try {
    [capabilities.value, classes.value] = await Promise.all([
      aiApi.capabilities(),
      classApi.list().catch(() => []),
    ]);
    taskHistory.value = await aiApi.tasks();
    const latest =
      taskHistory.value.find((item) => ['planning', 'executing'].includes(item.state)) ??
      taskHistory.value[0];
    if (latest) await resumeTask(latest.id);
  } catch (e) {
    error.value = failure(e);
  }
});
onBeforeUnmount(() => {
  disposed = true;
  if (observing || executing.value || hashing.value) controller?.abort();
  finishUrgent(false);
  clearCredentials();
  files.clear();
});
</script>

<template>
  <div
    class="page assistant-page"
    :class="{ 'is-dragging': dragging }"
    @dragover.prevent="dragging = true"
    @dragleave.prevent="dragging = false"
    @drop.prevent="drop"
  >
    <header class="page-header agent-header">
      <div class="agent-brand">
        <span class="agent-mark">AI</span>
        <div>
          <h1>AI 助手</h1>
          <span class="agent-presence">{{ busy || executing ? '正在处理' : '班级工作助手' }}</span>
        </div>
      </div>
      <div class="agent-header-actions">
        <el-select
          v-if="taskHistory.length"
          :model-value="taskId"
          placeholder="最近任务"
          :disabled="busy || executing"
          @change="resumeTask"
        >
          <el-option
            v-for="item in taskHistory"
            :key="item.id"
            :value="item.id"
            :label="item.text.slice(0, 24)"
          />
        </el-select>
        <el-button :disabled="busy || executing || hashing" @click="newConversation">新对话</el-button>
        <el-select
          v-model="classId"
          clearable
          filterable
          placeholder="目标班级"
          :disabled="busy || executing"
        >
          <el-option v-for="item in classes" :key="item.id" :value="item.id" :label="item.name" />
        </el-select>
        <el-button v-if="auth.can('ai:manage')" @click="$router.push('/ai-settings')">模型设置</el-button>
      </div>
    </header>
    <div
      ref="conversation"
      class="assistant-conversation"
      aria-live="polite"
      :aria-busy="busy || executing"
      @scroll="
        followScroll =
          !conversation ||
          conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 100
      "
    >
      <div v-if="!messages.length" class="assistant-welcome">
        <span class="agent-welcome-mark" aria-hidden="true">✦</span>
        <h2>有什么可以帮你？</h2>
        <p>查找信息、整理课表，或把文件交给我。</p>
        <div class="assistant-examples">
          <el-button @click="text = '查看本班今天的作业'">查看作业</el-button>
          <el-button @click="text = '将附件推送到所选班级'">推送文件</el-button>
          <el-button @click="text = '调整所选班级的时间表'">调整时间表</el-button>
        </div>
        <details>
          <summary>可用功能</summary>
          <div class="assistant-capabilities">
            <el-tag v-for="item in capabilities" :key="`${item.kind}:${item.action}`" effect="plain">
              {{ item.label }}
            </el-tag>
          </div>
        </details>
      </div>
      <article
        v-for="(message, index) in messages"
        :key="index"
        class="assistant-message"
        :class="message.role"
      >
        <span class="assistant-role">{{ message.role === 'user' ? '你' : 'ClassHelper' }}</span>
        <details v-if="message.activity?.length" class="agent-activity" :open="message.state === 'working'">
          <summary>
            <span class="agent-indicator" :class="{ 'is-working': message.state === 'working' }" />
            {{
              message.state === 'working'
                ? message.activity.at(-1)
                : message.state === 'stopped'
                  ? '处理已暂停'
                  : '处理过程'
            }}
          </summary>
          <ol>
            <li v-for="(activity, n) in message.activity" :key="n">{{ activity }}</li>
          </ol>
        </details>
        <p v-if="message.content">{{ message.content }}</p>
        <span v-else-if="message.state === 'working'" class="agent-placeholder">
          正在准备回复
          <span class="agent-typing">…</span>
        </span>
        <el-card v-for="(item, n) in message.result?.results" :key="n" shadow="never">
          <template #header>{{ item.label }}</template>
          <AssistantData :value="item.data" />
        </el-card>
      </article>
      <section v-if="active?.steps.length" class="assistant-plan" aria-label="待确认操作计划">
        <el-card v-for="(step, n) in active.steps" :key="step.id" shadow="never" class="assistant-step">
          <template #header>
            <div class="assistant-step-head">
              <strong>{{ n + 1 }}. {{ step.summary }}</strong>
              <el-tag
                :type="
                  step.status === 'succeeded'
                    ? 'success'
                    : ['blocked', 'failed'].includes(step.status)
                      ? 'danger'
                      : 'info'
                "
              >
                {{ statusLabels[step.status] }}
              </el-tag>
            </div>
          </template>
          <p v-if="step.attachmentId">
            {{ attachments.find((file) => file.id === step.attachmentId)?.name }}
          </p>
          <AssistantData v-if="!step.preview" :value="step.params" />
          <div
            v-if="!step.preview && step.before && (!Array.isArray(step.before) || step.before.length)"
            class="assistant-diff"
          >
            <details>
              <summary>修改前</summary>
              <AssistantData :value="step.before" />
            </details>
          </div>
          <el-form v-if="tablePreview(step) && step.status === 'prepared'" label-position="top">
            <el-form-item
              v-for="field in tablePreview(step)!.fields"
              :key="field.key"
              :label="field.label"
              :required="field.required"
            >
              <el-select
                :model-value="mapping(step)[field.key]"
                clearable
                placeholder="选择文件中的列"
                :disabled="busy || executing"
                @change="(value: string) => updateMapping(step, field.key, value)"
              >
                <el-option
                  v-for="column in tablePreview(step)!.columns"
                  :key="column"
                  :value="column"
                  :label="column"
                />
              </el-select>
            </el-form-item>
          </el-form>
          <details v-if="step.preview" open>
            <summary>变更预览</summary>
            <AssistantData :value="step.preview" />
          </details>
          <el-form v-if="step.sensitiveFields.length && step.status !== 'succeeded'" label-position="top">
            <el-form-item
              v-for="key in step.sensitiveFields"
              :key="key"
              :label="key === 'currentPassword' ? '当前密码' : '新密码'"
            >
              <el-input
                v-if="credentials[step.id]"
                v-model="credentials[step.id]![key]"
                type="password"
                show-password
                autocomplete="new-password"
                placeholder="仅用于本次确认，不发送给模型"
                :disabled="executing"
              />
            </el-form-item>
          </el-form>
          <el-alert v-if="step.error" :title="step.error" type="error" :closable="false" show-icon />
          <AssistantData v-if="step.status === 'succeeded' && step.result" :value="step.result" />
        </el-card>
        <div class="assistant-plan-actions">
          <el-button type="primary" :disabled="!ready || busy" :loading="executing" @click="execute()">
            {{ active.steps.some((step) => step.status === 'succeeded') ? '重试未完成步骤' : '确认执行' }}
          </el-button>
          <el-button :disabled="busy" @click="cancelPlan">
            {{ executing ? '停止等待' : '取消计划' }}
          </el-button>
          <el-button
            v-if="active.steps.some((step) => step.status === 'draft')"
            :disabled="busy || executing"
            @click="prepare(active).catch((e) => (error = failure(e)))"
          >
            重试附件预览
          </el-button>
        </div>
        <el-progress v-if="executing && progress > 0" :percentage="progress" />
      </section>
    </div>
    <el-alert v-if="error" :title="error" type="warning" :closable="true" show-icon @close="error = ''" />
    <el-button v-if="error && !active?.steps.length && !busy && !executing" @click="retryTask">
      重试上次任务
    </el-button>
    <div class="assistant-composer">
      <div v-if="attachments.length" class="assistant-attachments">
        <el-tag
          v-for="file in attachments"
          :key="file.id"
          :closable="!pending && !executing"
          @close="removeFile(file.id)"
        >
          {{ file.name }} · {{ size(file.size) }}
        </el-tag>
      </div>
      <el-input
        v-model="text"
        type="textarea"
        :autosize="{ minRows: 2, maxRows: 6 }"
        maxlength="8000"
        placeholder="描述任务，也可以拖入文件"
        :disabled="busy || executing || disabled"
        @keydown="composerKey"
      />
      <div class="assistant-composer-actions">
        <input ref="input" type="file" multiple hidden @change="choose" />
        <el-button :loading="hashing" :disabled="busy || executing || pending" @click="input?.click()">
          添加文件
        </el-button>
        <span class="text-muted">Enter 发送 · Shift + Enter 换行</span>
        <el-button v-if="busy || hashing" @click="stopGeneration">停止生成</el-button>
        <el-button
          type="primary"
          :disabled="!text.trim() || busy || hashing || executing || disabled"
          @click="send()"
        >
          发送
        </el-button>
      </div>
    </div>
    <UrgentClassWarning
      :visible="urgent.visible"
      :period="urgent.period"
      :pending-title="urgent.title"
      @confirm="finishUrgent(true)"
      @cancel="finishUrgent(false)"
    />
  </div>
</template>

<style scoped>
.assistant-page {
  max-width: none;
  padding: 0;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  box-sizing: border-box;
}
.assistant-conversation {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 32px max(20px, calc((100% - 800px) / 2)) 24px;
  scrollbar-gutter: stable;
}
.assistant-welcome {
  padding: clamp(24px, 7vh, 80px) 0 24px;
  text-align: center;
}
.assistant-welcome h2 {
  font-size: 2em;
  font-weight: 600;
}
.assistant-examples,
.assistant-capabilities,
.assistant-attachments,
.assistant-composer-actions,
.assistant-plan-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}
.assistant-examples {
  margin: 24px 0;
  justify-content: center;
}
.assistant-capabilities {
  margin-top: 16px;
}
.assistant-message {
  margin: 0 0 24px;
  padding: 8px 0;
}
.assistant-message.user {
  margin-left: auto;
  width: fit-content;
  max-width: 85%;
  padding: 12px 20px;
  border-radius: 20px 20px 4px 20px;
  background: var(--el-fill-color);
}
.assistant-message p {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  margin: 8px 0 0;
  line-height: 1.7;
}
.assistant-role {
  font-size: 0.85em;
  font-weight: 600;
  color: var(--ch-text-secondary);
}
.assistant-message .el-card {
  margin-top: 16px;
}
.assistant-step {
  margin-bottom: 12px;
}
.assistant-step-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}
.assistant-step-head strong {
  min-width: 0;
  overflow-wrap: anywhere;
}
.assistant-step-head .el-tag {
  flex-shrink: 0;
}
.assistant-diff {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  margin: 16px 0;
}
.assistant-plan-actions {
  margin: 16px 0;
}
.assistant-composer {
  width: min(880px, calc(100% - 32px));
  box-sizing: border-box;
  margin: 12px auto 8px;
  padding: 16px;
  border: 1px solid var(--ch-ui-border);
  border-radius: 20px;
  background: var(--ch-ui-surface);
  box-shadow: 0 6px 24px #00000006;
}
.assistant-composer :deep(.el-textarea__inner) {
  box-shadow: none;
  background: transparent;
  padding: 4px;
  resize: none;
}
.assistant-composer:focus-within {
  border-color: var(--el-color-primary);
}
.agent-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 0 16px;
  border-bottom: 1px solid var(--ch-ui-border);
}
.agent-brand,
.agent-header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
.agent-brand h1 {
  margin: 0;
  font-size: 1.15em;
  font-weight: 600;
}
.agent-mark {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border: 1px solid var(--ch-ui-border);
  border-radius: 11px;
  color: var(--el-color-primary);
  font-weight: 700;
}
.agent-presence {
  font-size: 0.8em;
  color: var(--ch-text-muted);
}
.agent-header-actions .el-select {
  width: 155px;
}
.agent-welcome-mark {
  font-size: 2.4em;
  color: var(--el-color-primary);
}
.assistant-welcome > p {
  color: var(--ch-text-muted);
}
.agent-activity {
  margin: 4px 0 12px;
  border-left: 2px solid var(--ch-ui-border);
  padding-left: 12px;
}
.agent-activity summary {
  list-style: none;
  display: flex;
  align-items: center;
  gap: 8px;
}
.agent-activity ol {
  margin: 12px 0;
  padding-left: 20px;
  font-size: 0.85em;
  color: var(--ch-text-muted);
  line-height: 1.9;
}
.agent-indicator {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--el-color-success);
  flex-shrink: 0;
}
.agent-indicator.is-working {
  background: var(--el-color-primary);
  animation: agent-pulse 1.3s ease-in-out infinite;
}
.agent-placeholder {
  color: var(--ch-text-muted);
  font-size: 0.9em;
}
.assistant-page > .el-alert {
  max-width: 880px;
  margin: 8px auto;
  box-sizing: border-box;
}
.assistant-page > .el-button {
  align-self: center;
}
@keyframes agent-pulse {
  50% {
    opacity: 0.35;
  }
}
@media (prefers-reduced-motion: reduce) {
  .agent-indicator.is-working {
    animation: none;
  }
}
.assistant-composer-actions {
  margin-top: 12px;
}
.assistant-composer-actions .text-muted {
  flex: 1;
  font-size: 12px;
}
.assistant-attachments {
  margin-bottom: 12px;
}
.is-dragging {
  outline: 2px dashed var(--el-color-primary);
  outline-offset: -8px;
}
details > summary {
  cursor: pointer;
  color: var(--ch-ui-muted);
  font-size: 13px;
}
@media (max-width: 720px) {
  .assistant-page {
    height: 100%;
  }
  .agent-header {
    flex-wrap: wrap;
  }
  .agent-header-actions {
    flex-wrap: wrap;
    gap: 6px;
  }
  .agent-header-actions .el-select {
    width: 130px;
  }
  .assistant-composer {
    width: 100%;
  }
  .assistant-composer-actions .text-muted {
    display: none;
  }
  .assistant-diff {
    grid-template-columns: 1fr;
  }
  .assistant-message.user {
    max-width: 92%;
  }
}
</style>
