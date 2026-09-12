<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { startIslandBridge, stopIslandBridge, subscribeIslandMarkRead } from './island/bridge.js';
import { useAppStore } from './stores/app.js';
import { useAuthStore } from './stores/auth.js';
import { useRealtimeStore } from './stores/realtime.js';

const router = useRouter();
const appStore = useAppStore();
const auth = useAuthStore();
const realtime = useRealtimeStore();

const booting = ref(true);
const bootText = ref('正在读取本地配置...');

/**
 * 启动流程：
 * 1) 从主进程配置恢复服务器地址与登录令牌
 * 2) 先用缓存资料渲染，再尝试向服务器刷新（不可达则进入离线会话）
 * 3) 已登录则建立 Socket.IO 连接并进入主界面
 */
onMounted(async () => {
  try {
    bootText.value = '正在恢复登录状态...';
    const session = await auth.restore();

    // 连通性探测与健康轮询放到后台，不阻塞进入界面（离线时也能立刻看到缓存数据）
    void appStore.init(session.serverUrl);

    if (auth.token) realtime.connect(appStore.serverUrl, auth.token);

    // 灵动岛：开始按课表计算上课状态（上课隐藏、下课自动弹出）
    if (auth.token) startIslandBridge();

    // 灵动岛"标为已读" → 同步通知中心（未读红点）
    subscribeIslandMarkRead();

    if (auth.isAuthenticated) await router.replace('/schedule');
    else await router.replace('/login');
  } finally {
    booting.value = false;
  }
});

onUnmounted(() => {
  stopIslandBridge();
});
</script>

<template>
  <div v-if="booting" class="boot-screen">
    <el-icon :size="30" class="is-loading" color="#409eff"><Loading /></el-icon>
    <p class="boot-title">班级小助手</p>
    <p class="boot-text">{{ bootText }}</p>
  </div>
  <router-view v-else />
</template>

<style scoped>
.boot-screen {
  height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  background: linear-gradient(135deg, #1f2d3d 0%, #3a5169 60%, #409eff 100%);
  color: #fff;
}

.boot-title {
  margin: 6px 0 0;
  font-size: 20px;
  font-weight: 600;
}

.boot-text {
  margin: 0;
  font-size: 13px;
  color: rgba(255, 255, 255, 0.75);
}
</style>
