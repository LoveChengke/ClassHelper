<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessageBox } from 'element-plus';
import { api } from '@/api/http';
const students = ref<
  { id: string; studentNo: string; name: string; transferNote: string; class: { name: string } | null }[]
>([]);
async function load() {
  students.value = await api.get('/archives/transferred');
}
async function restore(id: string) {
  await ElMessageBox.confirm('撤回后学生恢复到原班，转出历史仍保留。', '撤回转出');
  await api.post(`/archives/transferred/${id}/restore`);
  await load();
}
onMounted(load);
</script>
<template>
  <el-card>
    <h3>已转出</h3>
    <el-table :data="students">
      <el-table-column prop="studentNo" label="学号" />
      <el-table-column prop="name" label="姓名" />
      <el-table-column prop="class.name" label="原班级" />
      <el-table-column prop="transferNote" label="转出说明" />
      <el-table-column label="操作">
        <template #default="{ row }"><el-button link @click="restore(row.id)">撤回转出</el-button></template>
      </el-table-column>
    </el-table>
  </el-card>
</template>
