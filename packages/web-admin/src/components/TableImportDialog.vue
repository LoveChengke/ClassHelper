<script setup lang="ts">
/**
 * 表格导入弹窗（成绩 / 学生名单通用）。
 *
 * 流程：下载模板 → 选择文件（xlsx/xls/csv）→ 上传预览（列名 + 前 20 行 + 校验问题 + 建议映射）
 *      → 确认字段映射与写入模式 → 提交 → 展示结果统计与错误行（行号 + 原因）。
 *
 * 设计要点：
 * - 解析、校验、去重全部由后端完成，前端只负责收集与展示，避免前后端规则漂移；
 * - 预览失败（缺必填列 / 空文件 / 格式错误）会直接显示后端给出的原因；
 * - 错误行保留行号，方便老师在 Excel 里定位修改后重新导入。
 */
import { computed, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import {
  API_PATHS,
  STORAGE_KEYS,
  type TableImportPreview,
  type TableImportResult,
} from '@classhelper/shared';
import { API_BASE_URL } from '@/config';
import { importApi } from '@/api';

type Kind = 'grades' | 'students' | 'teachers';

interface FieldDef {
  key: string;
  label: string;
  required: boolean;
}

/** 与后端 IMPORT_FIELDS 保持一致（仅用于展示标签与必填提示） */
const FIELDS: Record<Kind, FieldDef[]> = {
  grades: [
    { key: 'username', label: '学生用户名', required: false },
    { key: 'name', label: '学生姓名', required: false },
    { key: 'examName', label: '考试名称', required: true },
    { key: 'score', label: '分数', required: true },
    { key: 'totalScore', label: '总分', required: false },
    { key: 'courseName', label: '课程', required: false },
  ],
  students: [
    { key: 'username', label: '用户名', required: true },
    { key: 'name', label: '姓名', required: true },
    { key: 'password', label: '初始密码', required: false },
  ],
  teachers: [
    { key: 'username', label: '用户名', required: true },
    { key: 'name', label: '姓名', required: true },
    { key: 'password', label: '初始密码', required: false },
    { key: 'role', label: '角色', required: false },
  ],
};

const props = defineProps<{
  modelValue: boolean;
  kind: Kind;
  /** 教师名单与班级无关，可以不传 */
  classId?: string;
}>();

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void;
  (event: 'imported', result: TableImportResult): void;
}>();

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value),
});

const loading = ref(false);
const committing = ref(false);
const fileName = ref('');
const contentBase64 = ref('');
const preview = ref<TableImportPreview | null>(null);
const mapping = ref<Record<string, string>>({});
const mode = ref<'append' | 'upsert'>('upsert');
const result = ref<TableImportResult | null>(null);
const fileInputRef = ref<HTMLInputElement>();

const fields = computed(() => FIELDS[props.kind]);
const title = computed(() => {
  if (props.kind === 'grades') return '导入成绩表格';
  return props.kind === 'teachers' ? '导入教师名单' : '导入学生名单';
});
/** 教师名单不需要班级（教师不属于任何班级） */
const needsClass = computed(() => props.kind !== 'teachers');

watch(visible, (value) => {
  if (value) reset();
});

function reset(): void {
  preview.value = null;
  result.value = null;
  fileName.value = '';
  contentBase64.value = '';
  mapping.value = {};
  mode.value = 'upsert';
  if (fileInputRef.value) fileInputRef.value.value = '';
}

function close(): void {
  visible.value = false;
}

/**
 * 模板下载。
 *
 * 两种格式在服务端的返回形态**不同**，必须分开处理：
 * - xlsx：直接 `res.send(Buffer)` 返回二进制，因此这里用 fetch 取流；
 * - csv：走统一 JSON 响应体（`{ data: { content } }`），必须解析出 content 再自己生成文件。
 *   之前两种格式共用同一段 `response.blob()`，于是"下载 CSV 模板"得到的是一个
 *   名为 template-grades.csv、内容却是一整行 JSON 的文件，老师照它填完再导入必然失败。
 */
async function downloadTemplate(format: 'csv' | 'xlsx'): Promise<void> {
  try {
    if (format === 'csv') {
      const result = await importApi.template(props.kind, 'csv');
      saveBlob(new Blob([result.content], { type: 'text/csv;charset=utf-8' }), result.fileName);
      ElMessage.success('模板已开始下载');
      return;
    }

    const token = localStorage.getItem(STORAGE_KEYS.token) ?? '';
    const response = await fetch(
      `${API_BASE_URL}${API_PATHS.imports}/template?kind=${props.kind}&format=xlsx`,
      { headers: token ? { Authorization: `Bearer ${token}` } : {} },
    );
    if (!response.ok) {
      ElMessage.error(`模板下载失败（${response.status}）`);
      return;
    }
    saveBlob(await response.blob(), `template-${props.kind}.xlsx`);
    ElMessage.success('模板已开始下载');
  } catch (error) {
    ElMessage.error(`模板下载失败：${(error as Error).message}`);
  }
}

/** 触发浏览器保存一个 Blob */
function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function pickFile(): void {
  fileInputRef.value?.click();
}

async function onFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  const allowed = /\.(xlsx|xls|csv|tsv)$/i.test(file.name);
  if (!allowed) {
    ElMessage.warning('只支持 .xlsx / .xls / .csv 文件');
    input.value = '';
    return;
  }
  if (file.size > 8 * 1024 * 1024) {
    ElMessage.warning('文件超过 8MB，请拆分后分批导入');
    input.value = '';
    return;
  }

  loading.value = true;
  result.value = null;
  try {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const base64 = btoa(binary);

    fileName.value = file.name;
    contentBase64.value = base64;

    const data = await importApi.previewTable({
      kind: props.kind,
      fileName: file.name,
      contentBase64: base64,
    });
    preview.value = data;
    mapping.value = { ...data.suggestedMapping };
    if ((data.errors ?? []).length > 0) {
      ElMessage.warning('表格已解析，但存在需要处理的问题（见下方提示）');
    } else {
      ElMessage.success(`解析成功：共 ${data.totalRows} 行数据`);
    }
  } catch {
    preview.value = null;
    contentBase64.value = '';
    // 必须把 input 的值也清掉：否则修好表格后重选**同一个文件名**时 @change 不会触发
    // （input 的 value 没变），界面会停在失败状态、"重新选择文件"按钮点了没反应。
    if (fileInputRef.value) fileInputRef.value.value = '';
    fileName.value = '';
  } finally {
    loading.value = false;
  }
}

const mappedRequired = computed(() =>
  fields.value.filter((field) => field.required).every((field) => Boolean(mapping.value[field.key])),
);

async function submit(): Promise<void> {
  if (needsClass.value && !props.classId) {
    ElMessage.warning('请先在页面上选择班级');
    return;
  }
  if (!contentBase64.value) {
    ElMessage.warning('请先选择要导入的文件');
    return;
  }
  if (!mappedRequired.value) {
    ElMessage.warning('请先完成必填字段的列映射');
    return;
  }

  committing.value = true;
  try {
    const data = await importApi.commitTable({
      kind: props.kind,
      ...(needsClass.value && props.classId ? { classId: props.classId } : {}),
      fileName: fileName.value,
      contentBase64: contentBase64.value,
      mapping: mapping.value,
      mode: mode.value,
    });
    result.value = data;
    ElMessage.success(
      `导入完成：新增 ${data.inserted} / 更新 ${data.updated} / 跳过 ${data.skipped} / 失败 ${data.failed}`,
    );
    emit('imported', data);
  } finally {
    committing.value = false;
  }
}
</script>

<template>
  <el-dialog v-model="visible" :title="title" width="760px" class="import-dialog" top="6vh">
    <el-alert
      type="info"
      :closable="false"
      show-icon
      title="支持 .xlsx / .xls / .csv；先下载模板填写可以避免列名不符"
      class="mb-12"
    />

    <div class="import-toolbar">
      <el-button size="small" @click="downloadTemplate('xlsx')">下载模板（Excel）</el-button>
      <el-button size="small" @click="downloadTemplate('csv')">下载模板（CSV）</el-button>
      <el-button size="small" type="primary" :loading="loading" @click="pickFile">
        {{ fileName ? '重新选择文件' : '选择文件' }}
      </el-button>
      <input
        ref="fileInputRef"
        type="file"
        accept=".xlsx,.xls,.csv,.tsv"
        class="hidden-input"
        @change="onFileChange"
      />
      <span v-if="fileName" class="file-name">{{ fileName }}</span>
    </div>

    <template v-if="preview">
      <div class="import-meta">
        <span>解析行数：{{ preview.totalRows }}</span>
        <span v-if="preview.columns.length">列：{{ preview.columns.join(' / ') }}</span>
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

      <el-card shadow="never" class="mt-8">
        <template #header><span>字段映射（规范字段 → 表格列）</span></template>
        <el-form label-width="110px" size="small">
          <el-form-item v-for="field in fields" :key="field.key" :label="field.label">
            <el-select v-model="mapping[field.key]" clearable placeholder="不导入该字段" style="width: 260px">
              <el-option v-for="column in preview.columns" :key="column" :label="column" :value="column" />
            </el-select>
            <span v-if="field.required" class="required-hint">必填</span>
          </el-form-item>
        </el-form>
      </el-card>

      <el-card shadow="never" class="mt-8">
        <template #header>
          <span>数据预览（前 {{ preview.rows.length }} 行）</span>
        </template>
        <el-table :data="preview.rows" size="small" max-height="220">
          <el-table-column type="index" label="#" width="50" />
          <el-table-column
            v-for="(column, index) in preview.columns"
            :key="column"
            :label="column"
            min-width="110"
          >
            <template #default="{ row }">{{ row[index] }}</template>
          </el-table-column>
        </el-table>
      </el-card>

      <el-form label-width="110px" size="small" class="mt-12">
        <el-form-item label="重复数据处理">
          <el-radio-group v-model="mode">
            <el-radio value="upsert">已存在则更新</el-radio>
            <el-radio value="append">已存在则跳过</el-radio>
          </el-radio-group>
          <div class="mode-hint">
            {{ kind === 'grades' ? '成绩重复判定：同一学生 + 考试 + 课程' : '名单重复判定：同一用户名' }}
          </div>
        </el-form-item>
      </el-form>

      <el-card v-if="result" shadow="never" class="mt-8 result-card">
        <template #header><span>导入结果</span></template>
        <div class="result-stats">
          <span>总行数：{{ result.total }}</span>
          <span class="ok">新增：{{ result.inserted }}</span>
          <span class="warn">更新：{{ result.updated }}</span>
          <span>跳过：{{ result.skipped }}</span>
          <span class="bad">失败：{{ result.failed }}</span>
        </div>
        <el-table
          v-if="result.errors.length"
          :data="result.errors"
          size="small"
          max-height="180"
          class="mt-8"
        >
          <el-table-column prop="row" label="行号" width="80" />
          <el-table-column prop="message" label="原因" />
        </el-table>
        <el-alert
          v-if="result.errors.length"
          type="warning"
          :closable="false"
          show-icon
          title="失败的行已跳过，其余数据已成功导入；修改后可用「已存在则更新」重新导入"
          class="mt-8"
        />
      </el-card>
    </template>

    <el-empty v-else-if="!loading" description="尚未选择文件" :image-size="70" />

    <template #footer>
      <el-button @click="close">关闭</el-button>
      <el-button type="primary" :disabled="!preview || !contentBase64" :loading="committing" @click="submit">
        开始导入
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.import-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.file-name {
  color: var(--ch-text-secondary);
  font-size: 13px;
}
.hidden-input {
  display: none;
}
.import-meta {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  margin: 12px 0 4px;
  color: var(--ch-text-secondary);
  font-size: 13px;
}
.required-hint {
  margin-left: 8px;
  color: #f56c6c;
  font-size: 12px;
}
.mode-hint {
  width: 100%;
  color: var(--ch-text-muted);
  font-size: 12px;
}
.result-stats {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  font-size: 13px;
}
.result-stats .ok {
  color: #67c23a;
}
.result-stats .warn {
  color: #e6a23c;
}
.result-stats .bad {
  color: #f56c6c;
}
.mb-8 {
  margin-bottom: 8px;
}
.mb-12 {
  margin-bottom: 12px;
}
.mt-8 {
  margin-top: 8px;
}
.mt-12 {
  margin-top: 12px;
}
</style>
