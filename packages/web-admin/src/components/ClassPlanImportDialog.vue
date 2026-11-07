<script setup lang="ts">
/**
 * 课表导入弹窗：ClassIsland 档案 JSON + 课表 YAML 两种格式。
 *
 * 流程：粘贴文本 / 选择 .json、.yaml、.yml 文件
 *      → 自动识别格式（JSON 能解析走 ClassIsland 档案接口，否则走 YAML 接口）
 *      → 解析预览（课程、单双周、缺失科目、校验结果）→ 覆盖(replace) / 合并(merge) → 导入。
 *
 * YAML 是给「手写 / 大模型生成」准备的简化格式，弹窗里内置可复制的 AI 提示词、
 * 示例 YAML（来自 shared，与服务端解析器共用同一份）与下载入口。
 *
 * 安全与一致性：
 * - 语法错误、结构无法识别、没有解析出任何课程时后端返回 errors（导入接口返回 400），
 *   导入按钮会被禁用/阻止，原课表不会被改成"导入一半"的脏状态；
 * - 缺失的科目在导入时由后端自动补建（预览里提前列出，避免意外建课）；
 * - 权限与课表管理一致（管理员或本班班主任），科任老师看不到入口，后端亦会二次校验。
 */
import { computed, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import {
  CLASS_PLAN_YAML_AI_PROMPT,
  CLASS_PLAN_YAML_SAMPLE,
  WEEK_PARITY_LABELS,
  type ClassPlanEntryDto,
  type ClassPlanPreviewDto,
  type ClassPlanYamlEntryDto,
  type ClassPlanYamlPreviewDto,
} from '@classhelper/shared';
import { importApi } from '@/api';

const props = defineProps<{
  modelValue: boolean;
  classId: string;
  className?: string;
}>();

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void;
  (event: 'imported'): void;
}>();

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value),
});

/**
 * 真实 ClassIsland 档案结构示例：Guid 字典 + PascalCase。
 * 单双周 = 同一天两条 ClassPlan（WeekCountDiv 1/2，WeekCountDivTotal 2）；
 * 注意 TimeLayouts 必须在 ClassPlans 之前（Classes 按下标与"上课"时间点一一对应）。
 */
const CLASS_PLAN_SAMPLE = `{
  "Name": "示例班级",
  "TimeLayouts": {
    "11111111-1111-4111-8111-111111111111": {
      "Name": "周一作息",
      "Layouts": [
        { "StartTime": "08:00:00", "EndTime": "08:45:00", "TimeType": 0, "BreakName": "" },
        { "StartTime": "08:45:00", "EndTime": "08:55:00", "TimeType": 1, "BreakName": "课间休息" },
        { "StartTime": "08:55:00", "EndTime": "09:40:00", "TimeType": 0, "BreakName": "" }
      ]
    }
  },
  "ClassPlans": {
    "aaaaaaaa-0001-4000-8000-000000000001": {
      "Name": "周一-单周",
      "TimeLayoutId": "11111111-1111-4111-8111-111111111111",
      "TimeRule": { "WeekDay": 1, "WeekCountDiv": 1, "WeekCountDivTotal": 2 },
      "Classes": [
        { "SubjectId": "bbbbbbbb-0001-4000-8000-000000000001", "IsEnabled": true },
        { "SubjectId": "bbbbbbbb-0002-4000-8000-000000000002", "IsEnabled": true }
      ]
    },
    "aaaaaaaa-0002-4000-8000-000000000002": {
      "Name": "周一-双周",
      "TimeLayoutId": "11111111-1111-4111-8111-111111111111",
      "TimeRule": { "WeekDay": 1, "WeekCountDiv": 2, "WeekCountDivTotal": 2 },
      "Classes": [
        { "SubjectId": "bbbbbbbb-0001-4000-8000-000000000001", "IsEnabled": true },
        { "SubjectId": "bbbbbbbb-0003-4000-8000-000000000003", "IsEnabled": true }
      ]
    }
  },
  "Subjects": {
    "bbbbbbbb-0001-4000-8000-000000000001": { "Name": "语文", "TeacherName": "王芳" },
    "bbbbbbbb-0002-4000-8000-000000000002": { "Name": "数学", "TeacherName": "李梅" },
    "bbbbbbbb-0003-4000-8000-000000000003": { "Name": "英语", "TeacherName": "张伟" }
  }
}`;

/** 输入框提示（用常量避免模板里的引号破坏 lint 规则） */
const TEXTAREA_PLACEHOLDER =
  '粘贴 ClassIsland 档案 JSON（含 TimeLayouts / ClassPlans / Subjects），或课表 YAML（含 version / subjects / schedules）；也可以点击「选择文件」';

const sourceText = ref('');
const mode = ref<'replace' | 'merge'>('replace');
const preview = ref<ClassPlanPreviewDto | null>(null);
/** 预览时识别到的格式；导入按钮据此决定调哪个接口 */
const previewFormat = ref<'json' | 'yaml' | null>(null);
/** 文件扩展名给出的格式提示：.json 强制走 JSON 以便报"JSON 解析失败"，粘贴文本时清空 */
const sourceHint = ref<'json' | 'yaml' | null>(null);
const aiPanel = ref<string[]>([]);
const parsing = ref(false);
const importing = ref(false);
const fileInputRef = ref<HTMLInputElement>();
let previewRevision = 0;

watch(visible, (value) => {
  if (value) {
    sourceText.value = '';
    preview.value = null;
    previewFormat.value = null;
    sourceHint.value = null;
    mode.value = 'replace';
    aiPanel.value = [];
  }
});

// 输入内容一旦变化，旧预览即失效：避免"改了文本却仍按旧预览导入"。
watch(
  [sourceText, mode, () => props.classId, visible],
  () => {
    previewRevision += 1;
    preview.value = null;
    previewFormat.value = null;
  },
  { flush: 'sync' },
);

/** 文件选择后提示文件来源格式；手动输入时清空提示，回到内容自动识别 */
function onManualInput(): void {
  sourceHint.value = null;
}

function pickFile(): void {
  fileInputRef.value?.click();
}

async function onFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  input.value = '';
  if (file.size > 8 * 1024 * 1024) {
    ElMessage.warning('课表文件不能超过 8 MB');
    return;
  }
  const lower = file.name.toLowerCase();
  if (!/\.(json|ya?ml)$/i.test(lower)) {
    ElMessage.warning('请选择 .json / .yaml / .yml 文件');
    input.value = '';
    return;
  }
  sourceText.value = await file.text();
  preview.value = null;
  previewFormat.value = null;
  sourceHint.value = lower.endsWith('.json') ? 'json' : 'yaml';
  ElMessage.success(
    `已读取 ${file.name}（${sourceText.value.length} 字符），请点击「解析预览」（自动识别 JSON / YAML）`,
  );
}

/** JSON 能解析就按 ClassIsland 档案处理，否则按 YAML；文件扩展名优先。 */
function resolveFormat(): 'json' | 'yaml' {
  if (sourceHint.value) return sourceHint.value;
  try {
    JSON.parse(sourceText.value);
    return 'json';
  } catch {
    return 'yaml';
  }
}

/** 解析出的课程数（单双周会各算一节，便于核对） */
const parityCount = computed(() => {
  const counts = { ODD: 0, EVEN: 0, ALL: 0 };
  for (const item of preview.value?.entries ?? []) counts[item.weekParity] += 1;
  const parts: string[] = [];
  if (counts.ODD > 0) parts.push(`单周 ${counts.ODD} 节`);
  if (counts.EVEN > 0) parts.push(`双周 ${counts.EVEN} 节`);
  if (counts.ALL > 0) parts.push(`每周 ${counts.ALL} 节`);
  return parts.join(' / ');
});

/** YAML 预览里的课表张数（同一天的单周/双周各算一张） */
const yamlPlanCount = computed(() =>
  previewFormat.value === 'yaml' ? ((preview.value as ClassPlanYamlPreviewDto | null)?.planCount ?? 0) : 0,
);

/** 有科目教室时表格才显示「地点」列，避免 JSON 预览多一列空白 */
const showLocationColumn = computed(
  () => preview.value?.entries.some((item) => Boolean((item as ClassPlanYamlEntryDto).location)) ?? false,
);

/** 解析预览：JSON / YAML 自动分流（只解析不写库） */
async function doPreview(): Promise<void> {
  if (!sourceText.value.trim()) {
    ElMessage.warning('请先粘贴课表内容或选择文件');
    return;
  }
  if (!props.classId) {
    ElMessage.warning('请先在页面上选择班级');
    return;
  }

  const format = resolveFormat();
  const revision = previewRevision;
  const input = { classId: props.classId, mode: mode.value, text: sourceText.value };
  parsing.value = true;
  try {
    let result: ClassPlanPreviewDto;
    if (format === 'json') {
      result = await importApi.previewClassPlan({
        classId: input.classId,
        mode: input.mode,
        payload: JSON.parse(input.text),
      });
    } else {
      result = await importApi.previewYamlClassPlan(input);
    }
    if (revision !== previewRevision) return;
    preview.value = result;
    previewFormat.value = format;
    if (preview.value.errors.length > 0) {
      ElMessage.warning(`解析发现 ${preview.value.errors.length} 个问题，请修正后再导入`);
    } else {
      const extra = format === 'yaml' ? ` / ${yamlPlanCount.value} 张课表` : '';
      ElMessage.success(
        `解析成功：共 ${preview.value.entries.length} 节课${extra}${parityCount.value ? `（${parityCount.value}）` : ''}`,
      );
    }
  } catch (error) {
    if (revision !== previewRevision) return;
    if (error instanceof SyntaxError) ElMessage.error('JSON 格式不正确，请检查文件内容');
    preview.value = null;
    previewFormat.value = null;
  } finally {
    parsing.value = false;
  }
}

async function doImport(): Promise<void> {
  if (!preview.value || preview.value.entries.length === 0) {
    ElMessage.warning('请先解析预览并确认课程');
    return;
  }
  if (preview.value.errors.length > 0) {
    ElMessage.warning('存在解析错误，已阻止导入（原课表不会被修改）');
    return;
  }

  const format = previewFormat.value ?? resolveFormat();
  importing.value = true;
  try {
    if (format === 'yaml') {
      const result = await importApi.importYamlClassPlan({
        classId: props.classId,
        mode: mode.value,
        text: sourceText.value,
      });
      ElMessage.success(
        `${result.created} 新增 / ${result.updated} 更新` +
          `${result.warnings.length > 0 ? `（另有 ${result.warnings.length} 条提示）` : ''}`,
      );
    } else {
      const result = await importApi.importClassPlan({
        classId: props.classId,
        mode: mode.value,
        payload: JSON.parse(sourceText.value),
      });
      ElMessage.success(`${result.created} 新增 / ${result.updated} 更新`);
    }
    emit('imported');
    visible.value = false;
  } finally {
    importing.value = false;
  }
}

function fillSample(): void {
  sourceHint.value = 'json';
  sourceText.value = CLASS_PLAN_SAMPLE;
  preview.value = null;
  previewFormat.value = null;
}

function fillYamlSample(): void {
  sourceHint.value = 'yaml';
  sourceText.value = CLASS_PLAN_YAML_SAMPLE;
  preview.value = null;
  previewFormat.value = null;
  ElMessage.success('已填入示例 YAML，可直接点击「解析预览」');
}

/** 复制文本：优先 Clipboard API，失败时退回隐藏 textarea（HTTP 内网环境也能复制） */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 浏览器拒绝时走下面的兜底 */
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

async function copyAiPrompt(): Promise<void> {
  const ok = await copyText(CLASS_PLAN_YAML_AI_PROMPT);
  if (ok) ElMessage.success('AI 提示词已复制，粘贴给大模型并附上课表内容即可');
  else ElMessage.warning('复制失败，请手动全选提示词复制');
}

/** 下载示例 YAML（与「填入示例 YAML」、服务端验收解析的是同一份内容） */
function downloadYamlSample(): void {
  const blob = new Blob([CLASS_PLAN_YAML_SAMPLE], { type: 'text/yaml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = '课表导入示例.yaml';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  ElMessage.success('示例 YAML 已下载');
}

function parityLabel(item: ClassPlanEntryDto): string {
  return WEEK_PARITY_LABELS[item.weekParity] ?? item.weekParity;
}

function entryLocation(item: ClassPlanEntryDto): string {
  return (item as ClassPlanYamlEntryDto).location ?? '';
}
</script>

<template>
  <el-dialog
    v-model="visible"
    title="导入课表（ClassIsland JSON / YAML）"
    width="860px"
    top="5vh"
    class="class-plan-import-dialog"
  >
    <el-alert type="info" :closable="false" show-icon class="mb-12">
      <template #title>
        支持两种格式，粘贴或选择文件后自动识别：① ClassIsland 档案 JSON（含 TimeLayouts / ClassPlans /
        Subjects 的 Guid 字典）；② 课表 YAML（version / subjects / schedules，enable_day 1=周一 … 7=周日，
        weeks 取 all / odd / even）。单双周各一条课表，同一天的单周与双周拆成两条；解析失败不会修改原有课表。
      </template>
    </el-alert>

    <el-form label-width="110px" size="small">
      <el-form-item label="目标班级">
        <el-input :model-value="className || classId" disabled style="width: 260px" />
      </el-form-item>
      <el-form-item label="导入方式">
        <el-radio-group v-model="mode">
          <el-radio value="replace">覆盖：清空该班现有课表后写入</el-radio>
          <el-radio value="merge">合并：保留现有课表，同星期+节次+单双周则更新</el-radio>
        </el-radio-group>
      </el-form-item>
    </el-form>

    <div class="toolbar mb-8">
      <el-button size="small" :loading="parsing" type="primary" @click="doPreview">解析预览</el-button>
      <el-button size="small" @click="pickFile">选择文件（.json / .yaml / .yml）</el-button>
      <el-button size="small" @click="fillSample">填入示例 JSON</el-button>
      <input
        ref="fileInputRef"
        type="file"
        accept=".json,.yaml,.yml"
        class="hidden-input"
        @change="onFileChange"
      />
    </div>

    <el-collapse v-model="aiPanel" class="ai-panel mb-8">
      <el-collapse-item name="ai" title="不会写 YAML？复制 AI 提示词，让大模型按格式生成课表">
        <div class="ai-actions mb-8">
          <el-button size="small" type="primary" @click="copyAiPrompt">复制 AI 提示词</el-button>
          <el-button size="small" @click="fillYamlSample">填入示例 YAML</el-button>
          <el-button size="small" @click="downloadYamlSample">下载示例 YAML</el-button>
        </div>
        <el-input
          :model-value="CLASS_PLAN_YAML_AI_PROMPT"
          type="textarea"
          :rows="7"
          readonly
          class="prompt-box"
        />
      </el-collapse-item>
    </el-collapse>

    <el-input
      v-model="sourceText"
      type="textarea"
      :rows="7"
      :placeholder="TEXTAREA_PLACEHOLDER"
      @input="onManualInput"
    />

    <template v-if="preview">
      <div class="preview-meta">
        <span>识别格式：{{ previewFormat === 'yaml' ? '课表 YAML' : 'ClassIsland JSON' }}</span>
        <span>解析课程：{{ preview.entries.length }} 节</span>
        <span v-if="yamlPlanCount">课表：{{ yamlPlanCount }} 张</span>
        <span v-if="parityCount">单双周分布：{{ parityCount }}</span>
        <span>识别科目：{{ preview.subjects.length }} 个</span>
        <span v-if="preview.layoutNames.length">时间表：{{ preview.layoutNames.join('、') }}</span>
      </div>

      <el-alert
        v-for="(item, index) in preview.errors"
        :key="`e-${index}`"
        type="error"
        :closable="false"
        show-icon
        :title="item"
        class="mb-8"
      />
      <el-alert
        v-for="(item, index) in preview.warnings"
        :key="`w-${index}`"
        type="warning"
        :closable="false"
        show-icon
        :title="item"
        class="mb-8"
      />
      <el-alert
        v-if="preview.missingSubjects.length"
        type="info"
        :closable="false"
        show-icon
        class="mb-8"
        :title="`导入时会自动补建这些课程：${preview.missingSubjects.join('、')}`"
      />

      <el-table
        v-if="preview.entries.length"
        :data="preview.entries"
        size="small"
        max-height="260"
        class="mt-8"
      >
        <el-table-column label="星期" width="80">
          <template #default="{ row }">{{ row.weekdayLabel ?? `周${row.dayOfWeek}` }}</template>
        </el-table-column>
        <el-table-column label="时间" width="130">
          <template #default="{ row }">{{ row.startTime }}-{{ row.endTime }}</template>
        </el-table-column>
        <el-table-column prop="subject" label="科目" min-width="110" />
        <el-table-column v-if="showLocationColumn" label="地点" min-width="110">
          <template #default="{ row }">{{ entryLocation(row) }}</template>
        </el-table-column>
        <el-table-column label="单双周" width="100">
          <template #default="{ row }">
            <el-tag v-if="row.weekParity !== 'ALL'" size="small" effect="plain">
              {{ parityLabel(row) }}
            </el-tag>
            <span v-else class="text-muted">{{ parityLabel(row) }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="planName" label="来源" min-width="120" />
      </el-table>
    </template>

    <template #footer>
      <el-button @click="visible = false">关闭</el-button>
      <el-button
        type="primary"
        :disabled="!preview || preview.entries.length === 0 || preview.errors.length > 0"
        :loading="importing"
        @click="doImport"
      >
        开始导入
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
:global(.el-dialog.class-plan-import-dialog) {
  display: flex;
  flex-direction: column;
  max-height: 90dvh;
}
:global(.class-plan-import-dialog .el-dialog__header),
:global(.class-plan-import-dialog .el-dialog__footer) {
  flex-shrink: 0;
}
:global(.class-plan-import-dialog .el-dialog__body) {
  min-height: 0;
  overflow-y: auto;
}
.hidden-input {
  display: none;
}
.preview-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ch-space-4);
  margin-top: var(--ch-space-3);
  color: var(--ch-text-secondary);
  font-size: 13px;
}
.ai-panel {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--ch-radius-sm);
  padding: 0 var(--ch-space-3);
}
.ai-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ch-space-2);
}
.prompt-box :deep(.el-textarea__inner) {
  font-family: var(--ch-font-mono, Consolas, 'Courier New', monospace);
  font-size: 12px;
  line-height: 1.6;
}
.mb-8 {
  margin-bottom: var(--ch-space-2);
}
.mb-12 {
  margin-bottom: var(--ch-space-3);
}
.mt-8 {
  margin-top: var(--ch-space-2);
}
</style>
