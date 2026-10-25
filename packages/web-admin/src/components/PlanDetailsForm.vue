<script setup lang="ts">
import type { ClassPlanDto, TimeLayoutDetailDto } from '@classhelper/shared';
import ArchiveIcon from './ArchiveIcon.vue';

/**
 * 日课表的触发规则与基本信息。
 *
 * 同一份表单同时用于课表页右侧「课表信息」标签和周视图的详细信息入口，
 * 直接修改父组件传入的 `plan`，保留 PlanEditorView 的脏数据比较。
 */
const plan = defineModel<ClassPlanDto>('plan', { required: true });
const props = defineProps<{
  layouts: TimeLayoutDetailDto[];
  groups: { id: string; name: string; isGlobal: boolean; isDefault: boolean }[];
  maxWeek: number;
  disabled: boolean;
  saving: boolean;
}>();
const emit = defineEmits<{
  'change-layout': [value: string];
  'edit-layout': [];
  save: [];
}>();
</script>

<template>
  <el-form :disabled="disabled" label-position="top" class="plan-details" @submit.prevent>
    <label class="detail-field">
      <span>课表名称</span>
      <el-input v-model="plan.name" maxlength="64" placeholder="例如：星期一课表" />
    </label>
    <label class="detail-field">
      <span>启用星期</span>
      <el-select v-model="plan.weekday">
        <el-option label="任意星期" :value="0" />
        <el-option v-for="day in 7" :key="day" :value="day" :label="`星期${'一二三四五六日'[day - 1]}`" />
      </el-select>
    </label>
    <div class="detail-field">
      <span>轮周设定</span>
      <div class="inline-fields">
        <el-input-number v-model="plan.weekCountDivTotal" :min="1" :max="9" />
        <span>周一轮，使用第</span>
        <el-input-number v-model="plan.weekCountDiv" :min="0" :max="plan.weekCountDivTotal" />
        <span>周</span>
      </div>
      <small>轮换周期第 0 周表示每周使用，支持 1–9 周轮换。</small>
    </div>
    <div class="detail-field">
      <span>生效周次</span>
      <div class="inline-fields">
        <el-input-number v-model="plan.weekStart" :min="1" :max="plan.weekEnd" />
        <span>至</span>
        <el-input-number v-model="plan.weekEnd" :min="plan.weekStart" :max="props.maxWeek" />
        <span>周</span>
      </div>
    </div>
    <div class="detail-field">
      <span>时间表模板</span>
      <el-select
        :model-value="plan.timeLayoutId"
        placeholder="选择时间表"
        @change="emit('change-layout', $event)"
      >
        <el-option v-for="item in props.layouts" :key="item.id" :value="item.id" :label="item.name" />
      </el-select>
      <button class="text-command" type="button" @click="emit('edit-layout')">
        <ArchiveIcon name="clock" />
        编辑时间表
      </button>
    </div>
    <div class="detail-field">
      <span>课表群</span>
      <el-select v-model="plan.associatedGroup" clearable placeholder="未分组">
        <el-option v-for="group in props.groups" :key="group.id" :value="group.id" :label="group.name" />
      </el-select>
    </div>
    <label class="detail-field inline">
      <span>启用课表</span>
      <el-switch v-model="plan.isEnabled" />
    </label>
    <el-button
      type="primary"
      class="save-plan"
      :disabled="props.disabled"
      :loading="props.saving"
      @click="emit('save')"
    >
      保存课表
    </el-button>
  </el-form>
</template>

<style scoped>
.plan-details {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.detail-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  color: var(--ch-text-secondary);
  font-size: var(--el-font-size-small);
}
.detail-field :deep(.el-select),
.detail-field :deep(.el-input) {
  width: 100%;
}
.detail-field small {
  color: var(--ch-text-muted);
  font-size: var(--el-font-size-extra-small);
  line-height: 1.4;
}
.detail-field.inline {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
}
.inline-fields {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.inline-fields :deep(.el-input-number) {
  width: 74px;
}
.inline-fields span {
  white-space: nowrap;
}
.text-command {
  display: inline-flex;
  align-items: center;
  align-self: flex-start;
  gap: 5px;
  padding: 4px 0;
  border: 0;
  background: transparent;
  color: var(--el-color-primary);
  font: inherit;
  cursor: pointer;
}
.text-command .archive-icon {
  width: 16px;
  height: 16px;
}
.save-plan {
  margin-top: 4px;
  width: 100%;
}
</style>
