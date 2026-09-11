<script setup lang="ts">
import { onMounted, onUnmounted, watch } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { useRealtimeStore } from '@/stores/realtime';

const auth = useAuthStore();
const realtime = useRealtimeStore();

/** 已登录时建立实时连接，退出登录时断开 */
function syncRealtime(token: string | null): void {
  if (token) realtime.connect(token);
  else realtime.disconnect();
}

onMounted(() => {
  syncRealtime(auth.token);
});

watch(
  () => auth.token,
  (token) => syncRealtime(token),
);

onUnmounted(() => {
  realtime.disconnect();
});
</script>

<template>
  <router-view />
</template>
