<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import {
  CLASSISLAND_NOTIFICATION_CHANNEL_HINTS,
  CLASSISLAND_NOTIFICATION_CHANNEL_LABELS,
  CLASSISLAND_NOTIFICATION_CHANNELS,
  formatDate,
  type ClassIslandNotificationChannel,
} from '@classhelper/shared';
import { classIslandStatusApi } from '../../api/index.js';
import { useAppStore } from '../../stores/app.js';
import { useAuthStore } from '../../stores/auth.js';

/**
 * 提醒设置：这台教室机器把提醒弹在哪个端（客户端 / ClassIsland / 两端都弹）。
 * 值同时落本地配置与班级记录（服务端据此决定是否推送 ClassIsland）。
 */
const appStore = useAppStore();
const auth = useAuthStore();

const channelSaving = ref(false);
/**
 * 本班有没有接入 ClassIsland 设备。
 *
 * 只用来禁用「只在 ClassIsland 上弹」——没有设备时选它等于把提醒静默丢掉；
 * 注意**不能**顺手把「两端都弹」也禁掉：那样教室一旦选过"只在客户端"，没设备时就再也切不回来了。
 */
const classIslandConnected = ref(false);
/** 本班 ClassIsland 设备的展示信息（设备名 / 最后上报），来自 /classes/:id/classisland-status */
const classIslandStatus = ref<{
  connected: boolean;
  deviceName: string | null;
  deviceCount: number;
  lastSeenAt: string | null;
  pluginVersion: string | null;
  classIslandVersion: string | null;
} | null>(null);

const classIslandStatusText = computed(() => {
  const status = classIslandStatus.value;
  if (!status || !status.connected) return '未接入';
  const seen = status.lastSeenAt ? `最后上报 ${formatDate(status.lastSeenAt, true)}` : '尚未上报过';
  return `已接入 · ${status.deviceName ?? 'ClassIsland 设备'} · ${seen}`;
});

const channelOptions = computed(() =>
  CLASSISLAND_NOTIFICATION_CHANNELS.map((value) => ({
    value,
    label: CLASSISLAND_NOTIFICATION_CHANNEL_LABELS[value],
    disabled: value === 'classisland' && !classIslandConnected.value,
  })),
);

async function applyChannel(value: ClassIslandNotificationChannel): Promise<void> {
  channelSaving.value = true;
  try {
    const saved = await appStore.setNotificationChannel(auth.classId, value);
    if (saved) ElMessage.success('提醒显示位置已更新');
    else ElMessage.warning('已保存在本机，但同步到服务器失败（离线或权限不足），联网后请再点一次');
  } finally {
    channelSaving.value = false;
  }
}

onMounted(async () => {
  await appStore.loadNotificationChannel(auth.classId);
  // 本班 ClassIsland 联动状态：没接设备就别让选「只在 ClassIsland 上弹」
  if (auth.classId) {
    const status = await classIslandStatusApi.get(auth.classId).catch(() => null);
    classIslandStatus.value = status;
    classIslandConnected.value = status?.connected === true;
  }
});
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">提醒</h2>
        <p class="page-subtitle">老师发通知 / 叫人时，提醒弹在哪个端</p>
      </div>
    </div>

    <el-card shadow="never">
      <template #header><span>ClassIsland 联动</span></template>
      <el-descriptions :column="1" border size="small" class="mb-12">
        <el-descriptions-item label="联动状态">{{ classIslandStatusText }}</el-descriptions-item>
        <el-descriptions-item label="插件 / ClassIsland">
          {{ classIslandStatus?.pluginVersion ?? '—' }} /
          {{ classIslandStatus?.classIslandVersion ?? '—' }}
        </el-descriptions-item>
      </el-descriptions>
      <p class="text-muted">
        <strong>通知模式</strong>
        ：老师在班级小助手上发布通知 / 叫人时，提醒弹在灵动岛还是 ClassIsland，
        由这台教室机器决定。选择会同步到班级，服务端据此决定是否推送到教室的 ClassIsland。
      </p>
      <el-radio-group
        :model-value="appStore.notificationChannel"
        :disabled="channelSaving"
        class="channel-group"
        @change="
          (value: string | number | boolean | undefined) =>
            applyChannel(value as ClassIslandNotificationChannel)
        "
      >
        <el-radio v-for="item in channelOptions" :key="item.value" :value="item.value" :disabled="item.disabled">
          {{ item.label }}
        </el-radio>
      </el-radio-group>
      <p class="text-muted channel-hint">
        {{ CLASSISLAND_NOTIFICATION_CHANNEL_HINTS[appStore.notificationChannel] }}
        <template v-if="!classIslandConnected">
          <br />
          提示：本班还没有接入 ClassIsland 设备（在 Web 端「ClassIsland 联动」里接入后才能选"只在
          ClassIsland 上弹"）。
        </template>
      </p>
    </el-card>
  </div>
</template>

<style scoped>
.channel-group {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  margin-top: 10px;
}

.channel-hint {
  margin-top: 10px;
}

.mb-12 {
  margin-bottom: 12px;
}
</style>
