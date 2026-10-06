<script setup lang="ts">
/**
 * ClassIsland 课程表（ClassPlan）导入弹窗，支持单双周。
 *
 * 流程：粘贴 JSON / 选择 .json 文件（整份 ClassIsland 档案）
 *      → 解析预览（后端解析 TimeLayouts + ClassPlans + Subjects，单双周取 WeekCountDiv/WeekCountDivTotal）
 *      → 查看解析出的课程、缺失科目与校验结果 → 选择覆盖(replace) / 合并(merge) → 导入。
 *
 * 安全与一致性：
 * - JSON 语法错误、结构无法识别、没有解析出任何课程时后端返回 errors（或 400），
 *   导入按钮会被禁用/阻止，原课表不会被改成"导入一半"的脏状态；
 * - 缺失的科目在导入时由后端自动补建（预览里提前列出，避免意外建课）；
 * - 权限与课表管理一致（管理员或本班班主任），科任老师看不到入口，后端亦会二次校验。
 */
import { computed, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { WEEK_PARITY_LABELS, type ClassPlanEntryDto, type ClassPlanPreviewDto } from '@classhelper/shared';
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
        { "StartTime": "08:45:00", "EndTime": "08:55:00", "TimeType": 1, "BreakName": "课间" },
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
  '粘贴 ClassIsland 导出的档案 JSON（含 TimeLayouts / ClassPlans / Subjects），或点击「选择 .json 文件」';

const jsonText = ref('');
const mode = ref<'replace' | 'merge'>('replace');
const preview = ref<ClassPlanPreviewDto | null>(null);
const parsing = ref(false);
const importing = ref(false);
const fileInputRef = ref<HTMLInputElement>();

watch(visible, (value) => {
  if (value) {
    jsonText.value = '';
    preview.value = null;
    mode.value = 'replace';
  }
});

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

/** JSON 语法错误由后端统一报错，这里保留原文让后端给出精确原因 */
function parseJsonOrText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
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

/** 解析预览：把 JSON 文本或对象交给后端解析（不写库） */
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
    preview.value = await importApi.previewClassPlan({
      classId: props.classId,
      mode: mode.value,
      payload: parseJsonOrText(jsonText.value),
    });
    if (preview.value.errors.length > 0) {
      ElMessage.warning(`解析发现 ${preview.value.errors.length} 个问题，请修正后再导入`);
    } else {
      ElMessage.success(
        `解析成功：共 ${preview.value.entries.length} 节课${parityCount.value ? `（${parityCount.value}）` : ''}`,
      );
    }
  } catch {
    preview.value = null;
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

  importing.value = true;
  try {
    const result = await importApi.importClassPlan({
      classId: props.classId,
      mode: mode.value,
      payload: parseJsonOrText(jsonText.value),
    });
    ElMessage.success(`${result.created} 新增 / ${result.updated} 更新`);
    emit('imported');
    visible.value = false;
  } finally {
    importing.value = false;
  }
}

function fillSample(): void {
  jsonText.value = CLASS_PLAN_SAMPLE;
  preview.value = null;
}

function parityLabel(item: ClassPlanEntryDto): string {
  return WEEK_PARITY_LABELS[item.weekParity] ?? item.weekParity;
}
</script>

<template>
  <el-dialog v-model="visible" title="导入 ClassIsland 课程表（支持单双周）" width="860px" top="5vh">
    <el-alert type="info" :closable="false" show-icon class="mb-12">
      <template #title>
        支持 ClassIsland 档案 JSON（含 TimeLayouts / ClassPlans / Subjects 的 Guid 字典）。单双周由 ClassPlan
        的 WeekCountDiv / WeekCountDivTotal 决定（两条 ClassPlan = 单周 +
        双周各一节）；课间（TimeType=1）会自动跳过。解析失败不会修改原有课表。
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
      <el-button size="small" @click="pickFile">选择 .json 文件</el-button>
      <el-button size="small" @click="fillSample">填入示例</el-button>
      <input ref="fileInputRef" type="file" accept=".json" class="hidden-input" @change="onFileChange" />
    </div>

    <el-input v-model="jsonText" type="textarea" :rows="7" :placeholder="TEXTAREA_PLACEHOLDER" />

    <template v-if="preview">
      <div class="preview-meta">
        <span>解析课程：{{ preview.entries.length }} 节</span>
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
.hidden-input {
  display: none;
}
.preview-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  margin-top: 10px;
  color: var(--ch-text-secondary);
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
</style>
