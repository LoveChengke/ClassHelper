<script setup lang="ts">
/**
 * ClassIsland 课表时间配置导入弹窗。
 *
 * 流程：粘贴 JSON / 选择 .json 文件 → 预览（后端容错解析，秒与 HH:mm 两种写法都支持）
 *      → 查看节次列表与校验结果 → 选择覆盖(replace) / 合并(merge) → 导入。
 *
 * 安全与一致性：
 * - 解析失败（JSON 语法错误、时间无法识别、结束早于开始）后端返回 400，
 *   教务端会提示"原有配置保持不变"，不会出现"导入一半"的脏状态；
 * - 权限与课表管理一致（管理员或本班班主任），科任老师看不到入口，后端亦会二次校验。
 */
import { computed, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { formatDate, type TimeLayoutDto, type TimeLayoutParsePreview } from '@classhelper/shared';
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

const LAYOUT_SAMPLE = `{
  "TimeLayouts": [
    { "Name": "第 1 节", "StartTime": "8:0:0", "EndTime": "8:45:0", "TimeType": 0 },
    { "Name": "课间休息", "StartTime": "8:45:0", "EndTime": "8:55:0", "TimeType": 1 }
  ]
}`;

/** 输入框提示（用常量避免模板里的引号破坏 lint 规则） */
const TEXTAREA_PLACEHOLDER =
  '粘贴 ClassIsland 导出的 JSON，例如 {"TimeLayouts":[{"Name":"第 1 节","StartTime":"8:0:0","EndTime":"8:45:0"}]}';

const jsonText = ref('');
const layoutName = ref('默认时间表');
const mode = ref<'replace' | 'merge'>('replace');
const preview = ref<TimeLayoutParsePreview | null>(null);
const existing = ref<TimeLayoutDto[]>([]);
const parsing = ref(false);
const importing = ref(false);
const fileInputRef = ref<HTMLInputElement>();

watch(visible, async (value) => {
  if (value) {
    jsonText.value = '';
    preview.value = null;
    layoutName.value = '默认时间表';
    mode.value = 'replace';
    await loadExisting();
  }
});

async function loadExisting(): Promise<void> {
  if (!props.classId) {
    existing.value = [];
    return;
  }
  try {
    existing.value = await importApi.listTimeLayouts(props.classId);
  } catch {
    existing.value = [];
  }
}

function pickFile(): void {
  fileInputRef.value?.click();
}

async function onFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  if (!/\.json$/i.test(file.name)) {
    ElMessage.warning('请选择 ClassIsland 导出的 .json 文件');
    input.value = '';
    return;
  }
  jsonText.value = await file.text();
  preview.value = null;
  ElMessage.success(`已读取 ${file.name}（${jsonText.value.length} 字符），请点击「解析预览」`);
}

/** 解析预览：把 JSON 文本或对象交给后端容错解析 */
async function doPreview(): Promise<void> {
  if (!jsonText.value.trim()) {
    ElMessage.warning('请先粘贴 JSON 或选择 .json 文件');
    return;
  }
  if (!props.classId) {
    ElMessage.warning('请先在页面上选择班级');
    return;
  }

  parsing.value = true;
  try {
    const payload = parseJsonOrText(jsonText.value);
    preview.value = await importApi.previewTimeLayout({
      classId: props.classId,
      name: layoutName.value,
      mode: mode.value,
      payload,
    });
    if (preview.value.errors.length > 0) {
      ElMessage.warning(`解析发现 ${preview.value.errors.length} 个问题，请修正后再导入`);
    } else {
      ElMessage.success(`解析成功：共 ${preview.value.items.length} 节`);
    }
  } catch {
    preview.value = null;
  } finally {
    parsing.value = false;
  }
}

/** JSON 语法错误由后端统一报错，这里保留原文让后端给出精确原因 */
function parseJsonOrText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function doImport(): Promise<void> {
  if (!preview.value || preview.value.items.length === 0) {
    ElMessage.warning('请先解析预览并确认节次');
    return;
  }
  if (preview.value.errors.length > 0) {
    ElMessage.warning('存在解析错误，已阻止导入（原配置不会被修改）');
    return;
  }

  importing.value = true;
  try {
    const result = await importApi.importTimeLayout({
      classId: props.classId,
      name: layoutName.value,
      mode: mode.value,
      payload: parseJsonOrText(jsonText.value),
    });
    ElMessage.success(
      mode.value === 'merge'
        ? `合并导入成功：覆盖 ${result.merged} 节 / 新增 ${result.replaced} 节（共 ${result.layout.items.length} 节）`
        : `覆盖导入成功：共 ${result.layout.items.length} 节`,
    );
    await loadExisting();
    emit('imported');
  } finally {
    importing.value = false;
  }
}

/** 删除已导入的时间配置（同一班级可保留多份，按名称区分） */
async function removeLayout(item: TimeLayoutDto): Promise<void> {
  await ElMessageBox.confirm(`删除「${item.name}」（${item.items.length} 节）？`, '确认', {
    type: 'warning',
  });
  await importApi.removeTimeLayout(item.id);
  ElMessage.success('已删除');
  await loadExisting();
}

function fillSample(): void {
  jsonText.value = LAYOUT_SAMPLE;
  preview.value = null;
}
</script>

<template>
  <el-dialog v-model="visible" title="导入 ClassIsland 课表时间配置" width="820px" top="5vh">
    <el-alert type="info" :closable="false" show-icon class="mb-12">
      <template #title>
        支持 ClassIsland 导出的时间表 JSON（数组，或含 TimeLayouts / TimeLayoutItems 字段的对象）； 时间可写成
        HH:mm:ss，也可用 StartSecond 秒数。解析失败不会修改原有配置。
      </template>
    </el-alert>

    <el-form label-width="110px" size="small">
      <el-form-item label="目标班级">
        <el-input :model-value="className || classId" disabled style="width: 260px" />
      </el-form-item>
      <el-form-item label="配置名称">
        <el-input v-model="layoutName" placeholder="默认时间表" style="width: 260px" />
      </el-form-item>
      <el-form-item label="导入方式">
        <el-radio-group v-model="mode">
          <el-radio value="replace">覆盖：整体替换现有时间表</el-radio>
          <el-radio value="merge">合并：按开始时间覆盖同节次并保留其它节次</el-radio>
        </el-radio-group>
      </el-form-item>
    </el-form>

    <div class="toolbar mb-8">
      <el-button size="small" :loading="parsing" type="primary" @click="doPreview">解析预览</el-button>
      <el-button size="small" @click="pickFile">选择 .json 文件</el-button>
      <el-button size="small" @click="fillSample">填入示例</el-button>
      <input ref="fileInputRef" type="file" accept=".json" class="hidden-input" @change="onFileChange" />
    </div>

    <el-input v-model="jsonText" type="textarea" :rows="7" :placeholder="TEXTAREA_PLACEHOLDER" />

    <template v-if="preview">
      <div class="preview-meta">
        <span>识别结构：{{ preview.shape }}</span>
        <span>解析节次：{{ preview.items.length }}</span>
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

      <el-table v-if="preview.items.length" :data="preview.items" size="small" max-height="240" class="mt-8">
        <el-table-column prop="index" label="#" width="50" />
        <el-table-column prop="name" label="节次" min-width="140" />
        <el-table-column prop="startTime" label="开始" width="90" />
        <el-table-column prop="endTime" label="结束" width="90" />
        <el-table-column label="类型" width="100">
          <template #default="{ row }">
            {{ row.type === 'break' ? '课间' : row.type === 'divider' ? '分割线' : '上课' }}
          </template>
        </el-table-column>
        <el-table-column label="跳过" width="80">
          <template #default="{ row }">{{ row.skipped ? '是' : '否' }}</template>
        </el-table-column>
      </el-table>
    </template>

    <el-card v-if="existing.length" shadow="never" class="mt-12">
      <template #header><span>该班级已导入的时间配置</span></template>
      <el-table :data="existing" size="small">
        <el-table-column prop="name" label="名称" min-width="140" />
        <el-table-column label="节次" width="80">
          <template #default="{ row }">{{ row.items.length }}</template>
        </el-table-column>
        <el-table-column prop="source" label="来源" width="120" />
        <el-table-column label="更新时间" width="170">
          <template #default="{ row }">{{ formatDate(row.updatedAt, true) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="90">
          <template #default="{ row }">
            <el-button link type="danger" size="small" @click="removeLayout(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <template #footer>
      <el-button @click="visible = false">关闭</el-button>
      <el-button
        type="primary"
        :disabled="!preview || preview.items.length === 0 || preview.errors.length > 0"
        :loading="importing"
        @click="doImport"
      >
        确认导入
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.hidden-input {
  display: none;
}
.preview-meta {
  display: flex;
  gap: 16px;
  margin-top: 10px;
  color: #606266;
  font-size: 13px;
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
