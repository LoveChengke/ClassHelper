<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { AutostartStatusDto } from '@classhelper/shared';
import { api } from '@/api/http';
const status = ref<AutostartStatusDto>();
const busy = ref(false);
async function load() {
  status.value = await api.get('/system/autostart');
}
async function toggle(value: string | number | boolean) {
  busy.value = true;
  try {
    status.value = await api.put('/system/autostart', { enabled: value === true });
  } finally {
    busy.value = false;
    await load();
  }
}
onMounted(load);
</script>
<template>
  <div class="page-container">
    <h2>系统设置</h2>
    <el-card>
      <h3>服务端开机自启动</h3>
      <el-switch
        :model-value="status?.enabled ?? false"
        :disabled="!status?.supported"
        :loading="busy"
        @change="toggle"
      />
      <p role="status">{{ status?.detail ?? '正在读取系统状态…' }}</p>
    </el-card>
  </div>
</template>
