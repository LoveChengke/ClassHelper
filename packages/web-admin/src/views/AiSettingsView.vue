<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  formatDate,
  type AiAuditDto,
  type AiSettingsDto,
  type SystemDiagnosticsDto,
  type UpdateAiSettingsRequest,
  type AiModelInfo,
  type AiReasoningEffort,
} from '@classhelper/shared';
import { aiApi, systemApi } from '@/api';
import { useAuthStore } from '@/stores/auth';
import { useResponsive } from '@/composables/useResponsive';

/** 模型配置只回传 Key 状态；使用记录同时包含计划和业务执行结果。 */

const auth = useAuthStore();
const { isMobile } = useResponsive();

/** 开发者模式/诊断属于 `system:manage`，与页面本身的 `ai:manage` 不是一回事 */
const canManageSystem = computed(() => auth.can('system:manage'));

type TabName = 'model' | 'audit' | 'system';
const activeTab = ref<TabName>('model');

/* ------------------------------------------------------------ 模型配置 */

type Provider = AiSettingsDto['provider'];

const loading = ref(true);
const saving = ref(false);
const clearingKey = ref(false);

const form = reactive({
  enabled: false,
  provider: 'openai' as Provider,
  baseUrl: '',
  model: '',
  reasoningEffort: 'auto' as AiReasoningEffort,
  systemPromptExtra: '',
});

/** 已保存的密钥信息（只用于显示，永不回填到输入框） */
const hasApiKey = ref(false);
const keyHint = ref('');
/** 本次要写入的新密钥；留空 = 保持原密钥不变 */
const apiKeyInput = ref('');
const models = ref<AiModelInfo[]>([]),
  modelsLoading = ref(false),
  modelsError = ref('');
const effortLabels: Record<AiReasoningEffort, string> = {
  auto: '自动',
  none: '快速 · 不启用推理',
  low: '低',
  medium: '中',
  high: '高',
  max: '最高',
};
const effortOptions = computed(
  () =>
    models.value.find((item) => item.id === form.model)?.efforts ??
    (['auto', 'none', 'low', 'medium', 'high'] as AiReasoningEffort[]),
);
async function loadModels(): Promise<void> {
  if (!form.baseUrl.trim() || (!hasApiKey.value && !apiKeyInput.value.trim()) || modelsLoading.value) return;
  modelsLoading.value = true;
  modelsError.value = '';
  try {
    models.value = await aiApi.models({
      baseUrl: form.baseUrl.trim(),
      ...(apiKeyInput.value.trim() ? { apiKey: apiKeyInput.value.trim() } : {}),
    });
    if (!form.model) form.model = models.value[0]?.id ?? '';
  } catch {
    modelsError.value = '获取失败，可重试或手动填写模型名。';
  } finally {
    modelsLoading.value = false;
  }
}
function modelChanged(): void {
  if (!effortOptions.value.includes(form.reasoningEffort)) form.reasoningEffort = 'auto';
}

const providerHint = computed(() =>
  form.provider === 'mock'
    ? '离线示例解析：不联网，只按关键词猜测，供演示与验收。'
    : 'OpenAI 兼容接口，支持基础地址或完整 /chat/completions 地址。',
);

function applySettings(settings: AiSettingsDto): void {
  form.enabled = settings.enabled;
  form.provider = settings.provider;
  form.baseUrl = settings.baseUrl;
  form.model = settings.model;
  form.reasoningEffort = settings.reasoningEffort ?? 'auto';
  form.systemPromptExtra = settings.systemPromptExtra;
  hasApiKey.value = settings.hasApiKey;
  keyHint.value = settings.keyHint;
  apiKeyInput.value = '';
}

async function loadSettings(): Promise<void> {
  loading.value = true;
  try {
    applySettings(await aiApi.settings());
    if (form.provider === 'openai') await loadModels();
  } catch {
    // 响应拦截器已经弹过服务端的中文提示，这里只保证页面不是一片空白
  } finally {
    loading.value = false;
  }
}

async function save(): Promise<void> {
  saving.value = true;
  try {
    const payload: UpdateAiSettingsRequest = {
      enabled: form.enabled,
      provider: form.provider,
      baseUrl: form.baseUrl.trim(),
      model: form.model.trim(),
      reasoningEffort: form.reasoningEffort,
      systemPromptExtra: form.systemPromptExtra,
    };
    // 只有真的填了新密钥才带上 apiKey：不带 = 保持原值，null = 清除
    const typedKey = apiKeyInput.value.trim();
    if (typedKey) payload.apiKey = typedKey;
    applySettings(await aiApi.updateSettings(payload));
    ElMessage.success('设置已保存');
  } catch {
    // 同上：错误提示由拦截器统一给出
  } finally {
    saving.value = false;
  }
}

async function clearApiKey(): Promise<void> {
  try {
    await ElMessageBox.confirm('清除后助手无法调用真实大模型；确认清除已保存的密钥吗？', '清除密钥', {
      type: 'warning',
      confirmButtonText: '清除',
      cancelButtonText: '取消',
    });
  } catch {
    return;
  }
  clearingKey.value = true;
  try {
    // apiKey: null 是"清除"的约定（空串在服务端同样按清除处理）
    applySettings(await aiApi.updateSettings({ apiKey: null }));
    ElMessage.success('密钥已清除');
  } catch {
    // 拦截器已提示
  } finally {
    clearingKey.value = false;
  }
}

/* ------------------------------------------------------------ 使用记录 */

const audit = ref<AiAuditDto[]>([]);
const auditLoading = ref(false);

const INTENT_LABELS: Record<string, string> = {
  create_homework: '布置作业',
  create_notification: '发布通知',
  call_student: '叫同学来',
  unknown: '没听懂',
};

const STATUS_LABELS: Record<string, string> = {
  interpreted: '已解析，待人工确认',
  unrecognized: '未识别出可用动作',
  pending: '已解析',
  confirmed: '已确认，待执行',
  succeeded: '已完成',
  partial: '部分完成',
  queried: '已查询',
  rejected: '已拒绝或取消',
  blocked: '已停止，待核对',
  cancelled: '已放弃',
  failed: '执行失败',
};

function intentLabel(intent: string): string {
  const parts = intent
    .split(',')
    .filter(Boolean)
    .map((key) => INTENT_LABELS[key] ?? key);
  return parts.length > 2
    ? `${parts.slice(0, 2).join('、')} 等 ${parts.length} 项`
    : parts.join('、') || '未识别';
}

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

async function loadAudit(): Promise<void> {
  auditLoading.value = true;
  try {
    const [rows, tools] = await Promise.all([aiApi.audit(50), aiApi.capabilities().catch(() => [])]);
    for (const tool of tools) INTENT_LABELS[tool.action] = tool.label;
    audit.value = rows;
  } catch {
    // 拦截器已提示
  } finally {
    auditLoading.value = false;
  }
}

/* ------------------------------------------------------------ 系统/开发者 */

const developerMode = ref(false);
const systemSaving = ref(false);
const diagnostics = ref<SystemDiagnosticsDto | null>(null);
const diagnosticsLoading = ref(false);

async function loadSystemSettings(): Promise<void> {
  try {
    developerMode.value = (await systemApi.settings()).developerMode;
  } catch {
    // 拦截器已提示
  }
}

async function handleDeveloperModeChange(value: boolean | string | number): Promise<void> {
  const next = value === true;
  const previous = developerMode.value;
  developerMode.value = next;
  systemSaving.value = true;
  try {
    await systemApi.updateSettings({ developerMode: next });
    ElMessage.success(next ? '开发者模式已开启' : '开发者模式已关闭');
  } catch {
    developerMode.value = previous;
  } finally {
    systemSaving.value = false;
  }
}

async function loadDiagnostics(): Promise<void> {
  diagnosticsLoading.value = true;
  try {
    diagnostics.value = await systemApi.diagnostics();
  } catch {
    // 拦截器已提示
  } finally {
    diagnosticsLoading.value = false;
  }
}

/** 运行时长（秒 → 「3 天 4 小时 5 分」），纯展示，不做精度承诺 */
function formatUptime(seconds: number | undefined): string {
  if (seconds === undefined) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} 天`);
  if (hours > 0) parts.push(`${hours} 小时`);
  parts.push(`${minutes} 分`);
  return parts.join(' ');
}

/* ------------------------------------------------------------ 生命周期 */

onMounted(async () => {
  await loadSettings();
  await loadAudit();
  if (canManageSystem.value) {
    await loadSystemSettings();
    await loadDiagnostics();
  }
});
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">大模型设置</h2>
      </div>
    </div>

    <el-tabs v-model="activeTab" class="settings-tabs">
      <el-tab-pane label="模型配置" name="model">
        <el-card v-loading="loading" shadow="never">
          <el-form
            :model="form"
            :label-width="isMobile ? undefined : '132px'"
            :label-position="isMobile ? 'top' : 'right'"
          >
            <el-form-item label="启用助手">
              <el-switch v-model="form.enabled" data-test="ai-enabled" />
              <span class="field-hint">关闭后教师在「AI 助手」页会看到"还没启用"的空态</span>
            </el-form-item>

            <el-form-item label="解析方式">
              <el-radio-group v-model="form.provider">
                <el-radio value="openai">OpenAI 兼容接口</el-radio>
                <el-radio value="mock">离线示例解析</el-radio>
              </el-radio-group>
              <p class="field-hint">{{ providerHint }}</p>
            </el-form-item>

            <template v-if="form.provider === 'openai'">
              <el-form-item label="服务地址">
                <el-input
                  v-model="form.baseUrl"
                  placeholder="https://api.openai.com/v1"
                  class="field-input"
                  @change="loadModels"
                />
                <p class="field-hint">
                  DeepSeek 可填 https://api.deepseek.com/chat/completions，模型名按服务商填写。
                </p>
              </el-form-item>

              <el-form-item label="模型名">
                <el-select
                  v-model="form.model"
                  filterable
                  allow-create
                  default-first-option
                  placeholder="选择或填写模型"
                  class="field-input"
                  :loading="modelsLoading"
                  @change="modelChanged"
                >
                  <el-option v-for="model in models" :key="model.id" :value="model.id" :label="model.name" />
                </el-select>
                <el-button :loading="modelsLoading" @click="loadModels">获取模型</el-button>
                <p v-if="modelsError" class="field-hint">{{ modelsError }}</p>
              </el-form-item>

              <el-form-item label="推理强度">
                <el-select v-model="form.reasoningEffort" class="field-input">
                  <el-option
                    v-for="level in effortOptions"
                    :key="level"
                    :value="level"
                    :label="effortLabels[level]"
                  />
                </el-select>
                <p class="field-hint">自动使用服务商默认值，其他档位以模型支持为准。</p>
              </el-form-item>

              <el-form-item label="API 密钥">
                <div class="key-row">
                  <el-input
                    v-model="apiKeyInput"
                    type="password"
                    show-password
                    class="field-input"
                    @change="loadModels"
                    :placeholder="
                      hasApiKey ? `已配置（尾号 ${keyHint}），留空表示不修改` : '粘贴密钥，保存后不再显示'
                    "
                  />
                  <el-button v-if="hasApiKey" :loading="clearingKey" @click="clearApiKey">清除密钥</el-button>
                </div>
                <p class="field-hint">密钥只保存在服务端；接口永不回传明文，所以这里不会回填。</p>
              </el-form-item>
            </template>

            <el-form-item label="补充提示词">
              <el-input
                v-model="form.systemPromptExtra"
                type="textarea"
                :rows="3"
                class="field-input"
                placeholder="例如：本校的班级叫「高一二班」这样的名字；把「卷子」理解为作业"
              />
              <p class="field-hint">追加在系统提示词末尾，用来补充本校的称呼习惯。</p>
            </el-form-item>

            <el-form-item>
              <el-button type="primary" :loading="saving" data-test="ai-save" @click="save">保存</el-button>
              <el-button :disabled="saving" @click="loadSettings">重新载入</el-button>
            </el-form-item>
          </el-form>
        </el-card>
      </el-tab-pane>

      <el-tab-pane label="使用记录" name="audit">
        <el-card shadow="never">
          <div class="table-toolbar">
            <span class="field-hint">最近 50 条解析记录（只记录解析这一步，发布结果不在这张表里）</span>
            <el-button :loading="auditLoading" @click="loadAudit">刷新</el-button>
          </div>
          <el-table v-loading="auditLoading" :data="audit" class="table-card" empty-text="还没有解析记录">
            <el-table-column label="时间" width="150">
              <template #default="{ row }">
                <span class="cell-muted">{{ formatDate((row as AiAuditDto).createdAt, true) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="操作人" width="120">
              <template #default="{ row }">{{ (row as AiAuditDto).userName || '—' }}</template>
            </el-table-column>
            <el-table-column label="原话" min-width="220" show-overflow-tooltip>
              <template #default="{ row }">{{ (row as AiAuditDto).prompt }}</template>
            </el-table-column>
            <el-table-column label="动作" width="110">
              <template #default="{ row }">
                <el-tag size="small" effect="plain">{{ intentLabel((row as AiAuditDto).intent) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="结果" min-width="220" show-overflow-tooltip>
              <template #default="{ row }">
                <el-tag size="small" type="info" effect="plain">
                  {{ statusLabel((row as AiAuditDto).status) }}
                </el-tag>
                <span class="cell-text">{{ (row as AiAuditDto).message }}</span>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>

      <el-tab-pane v-if="canManageSystem" label="系统" name="system">
        <el-card shadow="never" class="system-card">
          <div class="switch-row">
            <div>
              <p class="switch-title">开发者模式</p>
              <p class="field-hint">
                打开后只把开关记在服务端配置里（用于排查问题时确认环境），不改变老师与学生的日常使用。
              </p>
            </div>
            <el-switch
              :model-value="developerMode"
              :loading="systemSaving"
              @update:model-value="handleDeveloperModeChange"
            />
          </div>
        </el-card>

        <el-card v-loading="diagnosticsLoading" shadow="never" class="system-card">
          <template #header>
            <div class="table-toolbar">
              <span>服务端诊断</span>
              <el-button :loading="diagnosticsLoading" @click="loadDiagnostics">刷新</el-button>
            </div>
          </template>
          <el-descriptions :column="isMobile ? 1 : 2" size="small" border>
            <el-descriptions-item label="版本">{{ diagnostics?.version ?? '—' }}</el-descriptions-item>
            <el-descriptions-item label="Node">{{ diagnostics?.nodeVersion ?? '—' }}</el-descriptions-item>
            <el-descriptions-item label="平台">{{ diagnostics?.platform ?? '—' }}</el-descriptions-item>
            <el-descriptions-item label="已运行">
              {{ formatUptime(diagnostics?.uptimeSeconds) }}
            </el-descriptions-item>
            <el-descriptions-item label="数据库">
              {{ diagnostics?.databaseProvider ?? '—' }}
            </el-descriptions-item>
            <el-descriptions-item label="在线客户端">
              {{ diagnostics?.onlineClientCount ?? '—' }}
            </el-descriptions-item>
            <el-descriptions-item label="已发布客户端版本">
              {{ diagnostics?.clientReleaseCount ?? '—' }}
            </el-descriptions-item>
            <el-descriptions-item label="已加载模块">
              {{ diagnostics?.moduleCount ?? '—' }}
            </el-descriptions-item>
            <el-descriptions-item label="服务端目录" :span="isMobile ? 1 : 2">
              <span class="cell-path">{{ diagnostics?.serverRoot ?? '—' }}</span>
            </el-descriptions-item>
            <el-descriptions-item label="数据目录" :span="isMobile ? 1 : 2">
              <span class="cell-path">{{ diagnostics?.dataDir ?? '—' }}</span>
            </el-descriptions-item>
          </el-descriptions>
        </el-card>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<style scoped>
.settings-tabs {
  margin-top: -4px;
}

.field-input {
  max-width: 420px;
}

.field-hint {
  margin: var(--ch-space-1) 0 0;
  color: var(--ch-text-muted);
  font-size: var(--el-font-size-extra-small);
  line-height: 1.6;
}

.key-row {
  display: flex;
  align-items: center;
  gap: var(--ch-space-2);
  width: 100%;
}

.table-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--ch-space-3);
  margin-bottom: var(--ch-space-3);
}

.cell-muted {
  color: var(--ch-text-secondary);
}

.cell-text {
  margin-left: var(--ch-space-2);
  color: var(--ch-text-secondary);
}

.cell-path {
  word-break: break-all;
  font-family: var(--el-font-family-mono, monospace);
  font-size: var(--el-font-size-extra-small);
}

.system-card + .system-card {
  margin-top: var(--ch-space-4);
}

.switch-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--ch-space-4);
}

.switch-title {
  margin: 0;
  font-weight: 600;
}
</style>
