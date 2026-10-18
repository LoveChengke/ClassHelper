<script setup lang="ts">
import { computed } from 'vue';
import type { ClientDeviceDto } from '@classhelper/shared';
const props = defineProps<{ device: ClientDeviceDto }>();
const progress = computed(() => props.device.updateProgress);
const labels = {
  idle: '等待客户端接收',
  downloading: '当前客户端正在下载更新包',
  verifying: '正在校验更新包',
  ready: '更新包已就绪',
  waiting: '已下载，等待安装时机',
  installing: '当前客户端正在更新，将会短暂离线',
  completed: '客户端已完成更新',
  failed: '客户端更新失败',
};
const waiting = computed(() =>
  props.device.updateMode === 'immediate'
    ? '立即安装'
    : props.device.updateMode === 'after-school'
      ? `放学后安装${props.device.updateNotBefore ? ' · ' + new Date(props.device.updateNotBefore).toLocaleString() : ''}`
      : '课间且主窗口隐藏满五分钟后安装',
);
const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;
</script>
<template>
  <div class="update-status">
    <template v-if="progress">
      <strong>
        {{ labels[progress.stage] }}
        <template v-if="progress.stage === 'completed'">，版本 {{ progress.version }}</template>
      </strong>
      <el-progress
        v-if="['downloading', 'verifying', 'waiting'].includes(progress.stage)"
        :percentage="progress.percent || 0"
        :indeterminate="progress.percent === null"
      />
      <small v-if="progress.totalBytes">
        {{ mb(progress.downloadedBytes) }} / {{ mb(progress.totalBytes) }}
      </small>
      <small v-if="progress.stage === 'waiting'">{{ waiting }}</small>
      <el-text v-if="progress.error" type="danger">{{ progress.error }}</el-text>
      <small v-if="progress.updatedAt">上次报告：{{ new Date(progress.updatedAt).toLocaleString() }}</small>
      <el-text v-if="progress.stage === 'installing' && !device.online" type="warning">
        正在等待新版上线确认
      </el-text>
    </template>
    <template v-else-if="device.updateTargetVersion">
      <strong>已下发 {{ device.updateTargetVersion }}，等待客户端接收</strong>
      <small>{{ waiting }}</small>
    </template>
    <span v-else>暂无更新任务</span>
    <el-text
      v-if="device.updateTargetVersion && !device.autoUpdate && progress?.stage !== 'completed'"
      type="warning"
    >
      客户端已关闭自动更新，请在客户端开启后重试
    </el-text>
  </div>
</template>
<style scoped>
.update-status {
  display: grid;
  gap: 6px;
  padding-block: 6px;
  overflow-wrap: anywhere;
}
small {
  color: var(--el-text-color-secondary);
}
</style>
