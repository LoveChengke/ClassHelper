<script setup lang="ts">
import { computed } from 'vue';
import { PERMISSION_LABELS, type PermissionKey } from '@classhelper/shared';
const props = withDefaults(defineProps<{ value: unknown; depth?: number }>(), { depth: 0 });
const labels: Record<string, string> = {
  id: '记录标识',
  name: '名称',
  version: '版本',
  fileName: '文件',
  notes: '说明',
  current: '当前登记',
  file: '缓存文件',
  fileReady: '文件可用',
  title: '标题',
  content: '内容',
  classId: '班级',
  className: '班级',
  courseId: '科目',
  courseName: '科目',
  studentId: '学生',
  studentName: '学生',
  teacherId: '教师',
  username: '工号',
  role: '角色',
  grade: '年级',
  studentNo: '学号',
  examName: '考试',
  score: '分数',
  level: '等级',
  startTime: '开始',
  endTime: '结束',
  date: '日期',
  assignDate: '所属日期',
  archiveDate: '归档日期',
  points: '时间点',
  entries: '课程安排',
  columns: '列',
  rows: '数据',
  previewRows: '预览',
  suggestedMapping: '字段对应',
  warnings: '提示',
  errors: '问题',
  size: '大小',
  mode: '方式',
  priority: '优先级',
  classIds: '目标班级',
  count: '数量',
  totalRows: '总行数',
  countInTotal: '计入总分',
  isEnabled: '启用',
  weekday: '星期',
  weekStart: '起始周',
  weekEnd: '结束周',
  timeLayoutId: '时间表',
  timeLayoutItemId: '时间点',
  kind: '类型',
  message: '结果',
  createdAt: '创建时间',
  keys: '功能权限',
  scope: '范围',
  scopeValue: '范围值',
  assignments: '岗位分配',
  teacher: '教师',
  classes: '可见班级',
  nameBefore: '修改前',
  nameAfter: '修改后',
};
const hidden =
  /password|secret|token|api.?key|storagePath|contentBase64|sha256|^id$|Ids?$|^fields$|^mapping$|^suggestedMapping$|^templateCsv$/i;
const fileTable = computed(() => {
  const value = props.value as
    | { columns?: string[]; rows?: string[][]; errors?: string[]; warnings?: string[]; totalRows?: number }
    | undefined;
  return value && Array.isArray(value.columns) && Array.isArray(value.rows)
    ? {
        columns: value.columns,
        rows: value.rows.map((row) =>
          Object.fromEntries(value.columns!.map((key, i) => [key, row[i] ?? ''])),
        ),
        errors: value.errors ?? [],
        warnings: value.warnings ?? [],
        total: value.totalRows,
      }
    : null;
});
const entries = computed(() =>
  props.value && typeof props.value === 'object' && !Array.isArray(props.value)
    ? Object.entries(props.value).filter(
        ([key, value]) => !hidden.test(key) && value !== undefined && value !== null,
      )
    : [],
);
const rows = computed(() => (Array.isArray(props.value) ? props.value : []));
const columns = computed(() =>
  [
    ...new Set(
      rows.value.slice(0, 20).flatMap((row) => (row && typeof row === 'object' ? Object.keys(row) : [])),
    ),
  ]
    .filter(
      (key) =>
        key !== 'id' &&
        !key.endsWith('Id') &&
        !hidden.test(key) &&
        rows.value.some(
          (row) =>
            row && typeof row === 'object' && ['string', 'number', 'boolean'].includes(typeof row[key]),
        ),
    )
    .slice(0, 8),
);
function text(value: unknown): string {
  if (value === true) return '是';
  if (value === false) return '否';
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object')
    return Array.isArray(value) ? `${value.length} 项` : 'name' in value ? String(value.name) : '详情';
  const label = (
    {
      ADMIN: '管理员',
      shutdown: '关机',
      restart: '重启',
      logoff: '注销',
      lock: '锁屏',
      TEACHER: '教师',
      TEACHING: '任教班级',
      HEAD: '班主任班级',
      ALL: '全校',
      GRADE: '年级',
      DIVISION: '部',
      URGENT: '紧急',
      NORMAL: '普通',
      HIGH: '重要',
      LOW: '低',
      push: '推送',
      cloud: '云端保存',
      merge: '合并',
      replace: '覆盖',
      upsert: '更新或新增',
      append: '新增',
    } as Record<string, string>
  )[String(value)];
  return label ?? PERMISSION_LABELS[String(value) as PermissionKey] ?? String(value);
}
</script>
<template>
  <div class="assistant-data">
    <template v-if="fileTable">
      <p v-if="fileTable.total">共 {{ fileTable.total }} 行</p>
      <el-alert
        v-for="message in fileTable.errors"
        :key="message"
        :title="message"
        type="warning"
        :closable="false"
      />
      <el-alert
        v-for="message in fileTable.warnings"
        :key="message"
        :title="message"
        type="info"
        :closable="false"
      />
      <el-table :data="fileTable.rows" max-height="360">
        <el-table-column
          v-for="key in fileTable.columns"
          :key="key"
          :prop="key"
          :label="key"
          min-width="110"
        />
      </el-table>
    </template>
    <template v-else-if="Array.isArray(value)">
      <el-table v-if="columns.length" :data="rows.slice(0, 100)" max-height="360" empty-text="暂无记录">
        <el-table-column
          v-for="key in columns"
          :key="key"
          :label="labels[key] || key"
          min-width="100"
          show-overflow-tooltip
        >
          <template #default="{ row }">{{ text(row[key]) }}</template>
        </el-table-column>
      </el-table>
      <ul v-else>
        <li v-for="(row, n) in rows.slice(0, 100)" :key="n">{{ text(row) }}</li>
      </ul>
      <span v-if="rows.length > 100" class="text-muted">共 {{ rows.length }} 项，展示前 100 项</span>
    </template>
    <dl v-else-if="entries.length" class="assistant-fields">
      <template v-for="[key, item] in entries" :key="key">
        <dt>{{ labels[key] || key }}</dt>
        <dd>
          <details v-if="item && typeof item === 'object' && depth < 3">
            <summary>{{ Array.isArray(item) ? `${item.length} 项` : '查看' }}</summary>
            <AssistantData :value="item" :depth="depth + 1" />
          </details>
          <span v-else>{{ text(item) }}</span>
        </dd>
      </template>
    </dl>
    <span v-else>{{ text(value) }}</span>
  </div>
</template>
<style scoped>
.assistant-data {
  overflow: auto;
  font-size: var(--el-font-size-base);
}
.assistant-fields {
  display: grid;
  grid-template-columns: minmax(80px, 120px) minmax(0, 1fr);
  gap: 10px 16px;
  margin: 8px 0;
}
dt {
  color: var(--ch-ui-muted);
}
dd {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
summary {
  cursor: pointer;
  color: var(--el-color-primary);
}
ul {
  padding-left: 20px;
}
</style>
