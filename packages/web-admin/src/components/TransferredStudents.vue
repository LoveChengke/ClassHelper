<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessageBox } from 'element-plus';
import { api } from '@/api/http';
import { classApi } from '@/api';
import { useAuthStore } from '@/stores/auth';
import type { ClassDto } from '@classhelper/shared';
const auth = useAuthStore();
const students = ref<
  { id: string; studentNo: string; name: string; transferNote: string; class: { name: string } | null }[]
>([]);
const classes = ref<ClassDto[]>([]),
  target = ref(''),
  restoring = ref(''),
  visible = ref(false),
  saving = ref(false);
async function load() {
  students.value = await api.get('/archives/transferred');
}
async function openRestore(id: string) {
  restoring.value = id;
  target.value = '';
  classes.value = await classApi.list();
  visible.value = true;
}
async function restore() {
  await ElMessageBox.confirm(
    '恢复到所选在读班级；原转出历史保留。原班已归档时必须指定其他在读班。',
    '撤回转出',
  );
  saving.value = true;
  try {
    await api.post(
      `/archives/transferred/${restoring.value}/restore`,
      target.value ? { toClassId: target.value } : {},
    );
    visible.value = false;
    await load();
  } finally {
    saving.value = false;
  }
}
onMounted(load);
</script>
<template>
  <el-card shadow="never">
    <h3>已转出</h3>
    <el-table :data="students">
      <el-table-column prop="studentNo" label="学号" />
      <el-table-column prop="name" label="姓名" />
      <el-table-column prop="class.name" label="原班级" />
      <el-table-column prop="transferNote" label="转出说明" />
      <el-table-column v-if="auth.can('roster:manage')" label="操作">
        <template #default="{ row }">
          <el-button link @click="openRestore(row.id)">撤回转出</el-button>
        </template>
      </el-table-column>
    </el-table>
    <el-dialog v-model="visible" title="撤回转出" width="min(92%, 480px)">
      <el-form label-position="top">
        <el-form-item label="目标在读班级（留空使用原班）">
          <el-select v-model="target" clearable>
            <el-option
              v-for="cls in classes"
              :key="cls.id"
              :value="cls.id"
              :label="`${cls.name} / ${cls.grade}`"
            />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="visible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="restore">确认撤回</el-button>
      </template>
    </el-dialog>
  </el-card>
</template>
