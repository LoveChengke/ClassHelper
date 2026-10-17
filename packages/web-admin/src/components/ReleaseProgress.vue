<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { SOCKET_EVENTS, type ReleaseProgressDto } from '@classhelper/shared';
import { api } from '@/api/http';
import { useRealtimeStore } from '@/stores/realtime';
const progress = ref<ReleaseProgressDto>();
const realtime = useRealtimeStore();
const labels = {
  idle: '未开始',
  downloading: '下载中',
  verifying: '校验中',
  ready: '完成',
  failed: '失败',
  waiting: '等待安装策略',
  installing: '安装中',
};
const update = (p: unknown) => {
  progress.value = p as ReleaseProgressDto;
};
let timer: ReturnType<typeof setInterval>;
async function load() {
  progress.value = await api.get('/update/client/progress');
}
onMounted(() => {
  void load();
  realtime.on(SOCKET_EVENTS.clientReleaseProgress, update);
  timer = setInterval(() => void load(), 3000);
});
onUnmounted(() => {
  clearInterval(timer);
  realtime.off(SOCKET_EVENTS.clientReleaseProgress, update);
});
</script>
<template>
  <div v-if="progress" role="status">
    <p>
      安装包：{{ labels[progress.stage] }} {{ progress.version }} · {{ progress.downloadedBytes }} /
      {{ progress.totalBytes || '未知' }} 字节
    </p>
    <el-progress
      :percentage="progress.percent ?? 0"
      :indeterminate="progress.percent === null && progress.stage === 'downloading'"
      :status="progress.stage === 'failed' ? 'exception' : undefined"
    />
    <p v-if="progress.error">{{ progress.error }}</p>
  </div>
</template>
