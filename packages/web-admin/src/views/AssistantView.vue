<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import axios from 'axios';
import { ElMessage, ElMessageBox } from 'element-plus';
import { PageHeader } from '@classhelper/ui';
import {
  COURSEWARE_MAX_BYTES,
  type AiAttachment,
  type AiCapability,
  type AiConversationResult,
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
interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  result?: AiConversationResult;
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
const disabled = ref(false),
  dragging = ref(false),
  active = ref<AiConversationResult>();
const credentials = reactive<Record<string, Record<string, string>>>({});
const urgent = reactive({ visible: false, period: null as ClassPeriod | null, title: '' });
let resolveUrgent: ((confirmed: boolean) => void) | undefined;
let controller: AbortController | undefined;
let disposed = false;
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
  const last = [...messages.value].reverse().find((message) => message.role === 'user');
  if (last) {
    text.value = last.content;
    await send();
  }
}
async function send(): Promise<void> {
  if (!text.value.trim() || busy.value || executing.value || hashing.value) return;
  busy.value = true;
  error.value = '';
  controller = new AbortController();
  try {
    if (active.value?.planId && pending.value) await aiApi.discard(active.value.planId);
    clearCredentials();
    active.value = undefined;
    const content = text.value.trim(),
      history = messages.value.slice(-18).map(({ role, content }) => ({ role, content }));
    messages.value.push({ role: 'user', content });
    text.value = '';
    await scroll();
    const result = reactive(
      await aiApi.interpret(
        {
          text: content,
          classId: classId.value || undefined,
          messages: history,
          attachments: attachments.value,
        },
        controller.signal,
      ),
    );
    if (disposed) return;
    active.value = result;
    const message = reactive<ChatMessage>({ role: 'assistant', content: result.message, result });
    messages.value.push(message);
    try {
      await prepare(result);
    } finally {
      message.result = result;
    }
    for (const step of result.steps) credentials[step.id] = {};
  } catch (e) {
    if (!disposed && !axios.isCancel(e)) {
      error.value = failure(e);
      if (axios.isAxiosError(e) && e.response?.data?.code === 'AI_NOT_CONFIGURED') disabled.value = true;
    }
  } finally {
    busy.value = false;
    await scroll();
  }
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
    result.steps = await aiApi.confirm(result.planId, {
      confirmed: true,
      extraConfirmed: danger.length > 0,
      urgentConfirmed,
      secrets: { ...credentials },
    });
    clearCredentials();
    for (const step of result.steps) {
      if (step.status === 'succeeded') continue;
      if (!step.request) throw new Error('计划未确认，请刷新后重试');
      const file = step.request.attachmentId ? files.get(step.request.attachmentId) : undefined;
      if (step.request.attachmentId && !file) throw new Error('原附件已移除，请重新生成计划');
      step.status = 'running';
      try {
        step.result = await api.executeAi(step.id, step.request, file, controller.signal, (value) => {
          progress.value = value;
        });
        step.status = 'succeeded';
      } catch (e) {
        const refreshed = await refreshPlan(result)
          .then(() => true)
          .catch(() => false);
        if (!refreshed) {
          step.status = axios.isAxiosError(e) && e.response && e.response.status < 500 ? 'failed' : 'blocked';
          step.error = failure(e);
        }
        if (
          axios.isAxiosError(e) &&
          e.response?.data?.code === 'URGENT_DURING_CLASS' &&
          (await urgentConfirmation(
            e.response.data.details?.period ?? null,
            String(step.params?.title ?? ''),
          ))
        ) {
          executing.value = false;
          await execute(true);
          return;
        }
        throw e;
      }
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
    controller?.abort();
    return;
  }
  if (active.value?.planId) {
    await aiApi.discard(active.value.planId);
    await refreshPlan(active.value);
  }
  clearCredentials();
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
  } catch (e) {
    error.value = failure(e);
  }
});
onBeforeUnmount(() => {
  disposed = true;
  controller?.abort();
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
    <PageHeader title="AI 助手">
      <el-select v-model="classId" clearable filterable placeholder="目标班级" :disabled="busy || executing">
        <el-option v-for="item in classes" :key="item.id" :value="item.id" :label="item.name" />
      </el-select>
      <el-button v-if="auth.can('ai:manage')" @click="$router.push('/ai-settings')">模型设置</el-button>
    </PageHeader>
    <div ref="conversation" class="assistant-conversation" aria-live="polite" :aria-busy="busy || executing">
      <div v-if="!messages.length" class="assistant-welcome">
        <h2>今天需要处理什么？</h2>
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
        <span class="assistant-role">{{ message.role === 'user' ? '你' : '助手' }}</span>
        <p>{{ message.content }}</p>
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
    <el-alert v-if="error" :title="error" type="error" :closable="true" show-icon @close="error = ''" />
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
        @keydown.ctrl.enter.prevent="send"
      />
      <div class="assistant-composer-actions">
        <input ref="input" type="file" multiple hidden @change="choose" />
        <el-button :loading="hashing" :disabled="busy || executing || pending" @click="input?.click()">
          添加文件
        </el-button>
        <span class="text-muted">所有更改先确认</span>
        <el-button v-if="busy || hashing" @click="controller?.abort()">取消</el-button>
        <el-button
          type="primary"
          :loading="busy"
          :disabled="!text.trim() || hashing || executing || disabled"
          @click="send"
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
  max-width: 1120px;
  margin: auto;
  display: flex;
  flex-direction: column;
  height: calc(100dvh - 110px);
  min-height: 0;
  overflow: hidden;
  box-sizing: border-box;
}
.assistant-conversation {
  flex: 1;
  min-height: 240px;
  max-height: calc(100dvh - 380px);
  overflow: auto;
  padding: 8px 2px 24px;
}
.assistant-welcome {
  padding: clamp(20px, 4vw, 56px) 0;
}
.assistant-welcome h2 {
  font-size: 28px;
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
}
.assistant-capabilities {
  margin-top: 16px;
}
.assistant-message {
  margin: 0 0 24px;
  padding: 16px 20px;
  border: 1px solid var(--ch-ui-border);
  border-radius: var(--ch-ui-radius);
  background: var(--ch-ui-surface);
}
.assistant-message.user {
  margin-left: 15%;
  background: var(--el-color-primary-light-9);
}
.assistant-message p {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  margin: 8px 0 0;
  line-height: 1.7;
}
.assistant-role {
  font-size: 12px;
  color: var(--ch-ui-muted);
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
  margin-top: 16px;
  padding: 16px;
  border: 1px solid var(--ch-ui-border);
  border-radius: var(--ch-ui-radius);
  background: var(--ch-ui-surface);
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
    height: auto;
    overflow: visible;
  }
  .assistant-diff {
    grid-template-columns: 1fr;
  }
  .assistant-message.user {
    margin-left: 8%;
  }
  .assistant-conversation {
    max-height: none;
  }
}
</style>
