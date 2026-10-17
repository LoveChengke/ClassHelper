<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessageBox } from 'element-plus';
import { api } from '@/api/http';
type Status = {
  config: { month: number; day: number; hour: number; classCount: number };
  year: number;
  pending: boolean;
  runs: {
    year: number;
    status: string;
    message: string;
    classCount: number;
    studentCount: number;
    snapshotPath: string;
  }[];
};
const status = ref<Status>();
async function load() {
  status.value = await api.get('/term/promotion');
}
async function save() {
  if (status.value) await api.put('/term/promotion', status.value.config);
  await load();
}
async function catchUp() {
  if (!status.value) return;
  const preview = await api.post<{ classCount: number; studentCount: number }>('/term/promotion/run', {
    year: status.value.year,
    dryRun: true,
  });
  await ElMessageBox.confirm(
    `将影响 ${preview.classCount} 个班、${preview.studentCount} 名学生。执行前自动保存全库快照；高三归档，其余升一级，新建高一骨架。`,
    '补跑学年升级',
    { type: 'warning' },
  );
  await api.post('/term/promotion/run', { year: status.value.year, dryRun: false });
  await load();
}
onMounted(load);
</script>
<template>
  <el-card v-if="status">
    <h3>每年自动学年升级</h3>
    <el-form inline>
      <el-form-item label="月">
        <el-input-number v-model="status.config.month" :min="1" :max="12" />
      </el-form-item>
      <el-form-item label="日">
        <el-input-number v-model="status.config.day" :min="1" :max="31" />
      </el-form-item>
      <el-form-item label="时">
        <el-input-number v-model="status.config.hour" :min="0" :max="23" />
      </el-form-item>
      <el-form-item label="新高一班级数">
        <el-input-number v-model="status.config.classCount" :min="1" :max="99" />
      </el-form-item>
      <el-button @click="save">保存升级时间</el-button>
    </el-form>
    <p>新学年开学日重置为 9 月 1 日，保留总周数上限；新班主任与任课关系由管理员指定。</p>
    <el-alert
      v-if="status.pending"
      title="有尚未执行的学年升级，请预览影响后补跑"
      type="warning"
      :closable="false"
    />
    <el-button v-if="status.pending" @click="catchUp">预览并补跑 {{ status.year }} 学年</el-button>
    <el-table :data="status.runs">
      <el-table-column prop="year" label="学年" />
      <el-table-column prop="status" label="结果" />
      <el-table-column prop="classCount" label="班级数" />
      <el-table-column prop="studentCount" label="学生数" />
      <el-table-column prop="message" label="执行记录" />
      <el-table-column prop="snapshotPath" label="执行前快照" />
    </el-table>
  </el-card>
</template>
