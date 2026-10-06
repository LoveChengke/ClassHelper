<script setup lang="ts">
/**
 * 学期周次（仅管理员）。
 *
 * 为什么要有这一页：课表、作业、成绩都按**教学周**组织，而"开学日期 + 每周七天"的
 * 线性推算遇到法定节假日调休、周末补课、错峰开学就会**整体错位**（错一周全错）。
 * 所以这里支持逐周指定实际的起止日期：
 *
 *   1. 先填学期开始日期 → 点「按开学日期生成」得到一份标准学期；
 *   2. 再把调休那几周的日期范围改掉（也可以先点「拉取放假安排」看看今年哪些天不上课）；
 *   3. 保存后变更会随课表**下发给教室的 ClassHelper 班级端**。
 *
 * `classId` 留空 = 全校默认；某个班有自己的配置时优先用它。
 */
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  MAX_TERM_WEEK,
  type ClassDto,
  type HolidaySuggestionDto,
  type TermWeekDto,
  type TermWeeksDto,
} from '@classhelper/shared';
import { classApi, termApi } from '@/api';

const loading = ref(false);
const saving = ref(false);
const classes = ref<ClassDto[]>([]);
const term = ref<TermWeeksDto | null>(null);
/** '' = 全校默认 */
const scope = ref('');
/** 本地编辑中的逐周区间（保存前的草稿） */
const weeks = ref<TermWeekDto[]>([]);
const termStartDate = ref('');

const scopeLabel = computed(() => (scope.value ? (classes.value.find((item) => item.id === scope.value)?.name ?? scope.value) : '全校默认'));

/** 有没有改动（保存按钮的可用状态） */
const dirty = computed(() => {
  const current = term.value;
  if (!current) return false;
  if (termStartDate.value !== current.termStartDate) return true;
  if (weeks.value.length !== current.weeks.length) return true;
  return weeks.value.some((week, index) => {
    const origin = current.weeks[index];
    return (
      !origin ||
      origin.weekNumber !== week.weekNumber ||
      origin.startDate !== week.startDate ||
      origin.endDate !== week.endDate ||
      origin.note !== week.note
    );
  });
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    const result = await termApi.get(scope.value || undefined);
    term.value = result;
    weeks.value = result.weeks.map((item) => ({ ...item }));
    termStartDate.value = result.termStartDate;
  } finally {
    loading.value = false;
  }
}

async function onScopeChange(): Promise<void> {
  await load();
}

/** 一键生成：按学期开始日期铺满整个学期（配置的起点，之后逐周微调） */
async function autoGenerate(): Promise<void> {
  if (!termStartDate.value) {
    ElMessage.warning('请先填写学期开始日期（第 1 教学周的周一）');
    return;
  }
  saving.value = true;
  try {
    const result = await termApi.auto({
      classId: scope.value || null,
      termStartDate: termStartDate.value,
      maxWeek: term.value?.maxWeek ?? MAX_TERM_WEEK,
    });
    term.value = result;
    weeks.value = result.weeks.map((item) => ({ ...item }));
    ElMessage.success(`已生成 ${result.weeks.length} 周的日期区间，可继续手动调整`);
  } finally {
    saving.value = false;
  }
}

async function save(): Promise<void> {
  if (weeks.value.length === 0) {
    await ElMessageBox.confirm(
      '当前没有逐周区间，保存后会回到"按学期开始日期线性推算"的方式。确认继续？',
      '确认',
      { type: 'warning' },
    );
  }
  saving.value = true;
  try {
    const result = await termApi.save({
      classId: scope.value || null,
      termStartDate: termStartDate.value,
      weeks: weeks.value.map((week) => ({
        weekNumber: week.weekNumber,
        startDate: week.startDate,
        endDate: week.endDate,
        note: week.note,
      })),
    });
    term.value = result;
    weeks.value = result.weeks.map((item) => ({ ...item }));
    ElMessage.success('已保存；变更会随课表下发给教室的 ClassHelper 班级端');
  } finally {
    saving.value = false;
  }
}

function addWeek(): void {
  const next = (weeks.value[weeks.value.length - 1]?.weekNumber ?? 0) + 1;
  weeks.value.push({ weekNumber: next, startDate: '', endDate: '', note: '' });
}

function removeWeek(index: number): void {
  weeks.value.splice(index, 1);
}

/* ------------------------------------------------------------ 调休建议（联网，可选） */

const holiday = ref<HolidaySuggestionDto | null>(null);
const holidayLoading = ref(false);

/**
 * 拉取法定节假日安排。
 * **机房没有外网时 `ok:false` 是正常结果**，这里只提示、不影响手动配置。
 */
async function fetchHolidays(): Promise<void> {
  holidayLoading.value = true;
  try {
    const result = await termApi.holidays(new Date().getFullYear());
    holiday.value = result;
    if (result.ok) {
      ElMessage.success(`已获取 ${result.year} 年的放假安排（${result.holidays.length} 天）`);
    } else {
      ElMessage.warning(result.error ?? '暂时无法获取放假安排，可手动调整周次');
    }
  } finally {
    holidayLoading.value = false;
  }
}

onMounted(async () => {
  classes.value = await classApi.list().catch(() => []);
  await load();
});
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">学期周次</h2>
        <p class="page-subtitle">
          逐周指定实际日期区间（调休、周末补课、错峰开学都能表达）。
          保存后会随课表<b>下发给教室的 ClassHelper 班级端</b>，让教室里的"第几周"与这里一致
        </p>
      </div>
      <div class="toolbar">
        <el-select v-model="scope" placeholder="全校默认" clearable style="width: 200px" @change="onScopeChange">
          <el-option label="全校默认（所有班级）" value="" />
          <el-option v-for="item in classes" :key="item.id" :label="item.name" :value="item.id" />
        </el-select>
        <el-button :icon="'Refresh'" :loading="loading" @click="load">刷新</el-button>
        <el-button type="warning" :icon="'Calendar'" :loading="holidayLoading" @click="fetchHolidays">
          拉取放假安排
        </el-button>
        <el-button type="primary" :loading="saving" :disabled="!dirty" @click="save">保存</el-button>
      </div>
    </div>

    <el-alert type="info" :closable="false" show-icon style="margin-bottom: 12px">
      <template #title>
        当前配置范围：{{ scopeLabel }} · 共 {{ weeks.length }} 周
        <span v-if="term">（当前第 {{ term.currentWeek }} 教学周，学期周数上限 {{ term.maxWeek }}）</span>
        <span v-if="term && !term.configured"> · 尚未逐周配置，按学期开始日期线性推算</span>
      </template>
      <template #default>
        留空某个班时，该班使用「全校默认」。班里有特殊安排（例如整周外出实习）时，再单独为它配一遍。
      </template>
    </el-alert>

    <el-card shadow="never" style="margin-bottom: 12px">
      <div class="toolbar">
        <span class="label">学期开始日期</span>
        <el-date-picker
          v-model="termStartDate"
          type="date"
          value-format="YYYY-MM-DD"
          placeholder="第 1 教学周的周一"
          style="width: 200px"
        />
        <el-button type="primary" plain :loading="saving" @click="autoGenerate">
          按开学日期生成
        </el-button>
        <span class="hint">先生成一份标准学期，再把调休那几周改掉 —— 比一周周填快得多</span>
      </div>
    </el-card>

    <!-- 联网拉到的放假安排（只作参考，不会自动改任何数据） -->
    <el-card v-if="holiday?.ok && holiday.holidays.length > 0" shadow="never" style="margin-bottom: 12px">
      <template #header>
        <span>{{ holiday.year }} 年放假安排（参考，不会自动改周次）</span>
      </template>
      <el-tag v-for="item in holiday.holidays" :key="item.startDate" size="small" effect="plain" class="holiday-tag">
        {{ item.name }} {{ item.startDate }}
      </el-tag>
    </el-card>

    <el-card v-loading="loading" shadow="never" class="table-card">
      <template #header>
        <div class="card-header">
          <span>逐周日期区间（{{ weeks.length }} 周）</span>
          <el-button size="small" :icon="'Plus'" @click="addWeek">添加一周</el-button>
        </div>
      </template>

      <el-table :data="weeks" empty-text="还没有逐周配置，可点「按开学日期生成」" max-height="560">
        <el-table-column label="教学周" width="110">
          <template #default="{ row }">
            <el-input-number v-model="row.weekNumber" :min="1" :max="60" size="small" controls-position="right" />
          </template>
        </el-table-column>
        <el-table-column label="日期区间" width="320">
          <template #default="{ row }">
            <!-- 用 :model-value + @update 而不是 v-model：数据模型里是 startDate/endDate 两个字段，
                 el-date-picker 的 daterange 给的是一个数组，直接 v-model 会写到一个不存在的 range 上 -->
            <el-date-picker
              :model-value="row.startDate && row.endDate ? [row.startDate, row.endDate] : null"
              type="daterange"
              value-format="YYYY-MM-DD"
              range-separator="→"
              start-placeholder="开始"
              end-placeholder="结束"
              size="small"
              style="width: 300px"
              @update:model-value="
                (value: [string, string] | null) => {
                  row.startDate = value?.[0] ?? '';
                  row.endDate = value?.[1] ?? '';
                }
              "
            />
          </template>
        </el-table-column>
        <el-table-column label="备注" min-width="180">
          <template #default="{ row }">
            <el-input v-model="row.note" size="small" maxlength="64" placeholder="例如：国庆调休、期中考试周" />
          </template>
        </el-table-column>
        <el-table-column label="操作" width="90">
          <template #default="{ $index }">
            <el-button link type="danger" @click="removeWeek($index)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<style scoped>
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.label {
  font-size: 13px;
  color: var(--ch-text-secondary);
  min-width: 84px;
}

.hint {
  font-size: 12px;
  color: var(--ch-text-muted);
}

.holiday-tag {
  margin: 0 6px 6px 0;
}
</style>
