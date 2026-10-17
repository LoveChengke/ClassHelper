<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import type { ReleaseProgressDto } from '@classhelper/shared';
const progress = ref<ReleaseProgressDto>();
let off: (() => void) | undefined;
const labels = {
  idle: '尚未下载',
  downloading: '下载中',
  verifying: '校验中',
  ready: '完成',
  waiting: '等待安装策略',
  installing: '安装中',
  failed: '失败',
};
onMounted(async () => {
  off = window.desktop?.onUpdateProgress((p) => (progress.value = p));
  progress.value = await window.desktop?.getUpdateProgress();
});
onUnmounted(() => off?.());
</script>
<template>
  <section v-if="progress && progress.stage !== 'idle'" role="status">
    <h3>客户端更新 · {{ labels[progress.stage] }}</h3>
    <el-progress :percentage="progress.percent ?? 0" />
    <p>{{ progress.version }} {{ progress.error }}</p>
  </section>
</template>
