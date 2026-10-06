<script setup lang="ts">
import { h, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElButton, ElNotification } from 'element-plus';
import type { UpdateInfo } from '@classhelper/shared';
import {
  startIslandBridge,
  stopIslandBridge,
  subscribeIslandMarkAllRead,
  subscribeIslandMarkRead,
} from './island/bridge.js';
import OnboardingWelcome from './components/OnboardingWelcome.vue';
import { useAppStore } from './stores/app.js';
import { useAuthStore } from './stores/auth.js';
import { useOnboardingStore } from './stores/onboarding.js';
import { useRealtimeStore } from './stores/realtime.js';
import { useUiStore } from './stores/ui.js';

const router = useRouter();
const appStore = useAppStore();
const auth = useAuthStore();
const onboarding = useOnboardingStore();
const ui = useUiStore();
const realtime = useRealtimeStore();

const booting = ref(true);
const bootText = ref('正在读取本地配置...');

/**
 * 启动自动检查发现新版本时的提示（主进程查出后推过来，见 main/update.ts）。
 *
 * **为什么订阅放在 App.vue**：`onUpdateAvailable` 底层是 `ipcRenderer.on`，
 * 桥接层没有对应的 off —— 挂在会随"登出 → 登录"反复挂载的 ClientLayout 里，
 * 处理器会越堆越多（与灵动岛订阅同一个坑）。App.vue 整个应用生命周期只挂载一次。
 *
 * 提示是**一次性**且可永久消音：点「忽略此版本」写进 config.json，同一版本不再提示；
 * 「关于」页里仍可随时手动检查。
 */
function showUpdateAvailable(info: UpdateInfo): void {
  if (!info.latestVersion) return;
  ElNotification({
    title: `发现新版本 v${info.latestVersion}`,
    type: 'info',
    // 不自动消失：这是需要用户决定的事（去下载 / 忽略），滑过去就只能靠「关于」页再想起来
    duration: 0,
    message: h('div', { style: 'line-height: 1.7' }, [
      h('p', { style: 'margin: 0 0 10px' }, `当前版本 ${info.currentVersion}，可前往下载更新。`),
      h('div', { style: 'display: flex; gap: 8px' }, [
        h(
          ElButton,
          {
            size: 'small',
            type: 'primary',
            onClick: () => {
              void window.desktop?.openExternal(info.releaseUrl);
            },
          },
          () => '前往下载',
        ),
        h(
          ElButton,
          {
            size: 'small',
            onClick: () => {
              void window.desktop?.ignoreUpdateVersion(info.latestVersion ?? '');
            },
          },
          () => '忽略此版本',
        ),
      ]),
    ]),
  });
}

/**
 * 启动流程：
 * 1) 从主进程配置恢复服务器地址与登录令牌
 * 2) 先用缓存资料渲染，再尝试向服务器刷新（不可达则进入离线会话）
 * 3) 已登录则建立 Socket.IO 连接并进入主界面
 */
onMounted(async () => {
  try {
    bootText.value = '正在读取本地配置...';
    // 主题与侧栏折叠最先恢复：在首屏渲染前挂好 html.dark，避免"先白后黑"闪一下
    await ui.init();

    bootText.value = '正在恢复登录状态...';
    const session = await auth.restore();

    // 通知显示位置：先用本地配置兜底（断网也要按上次的选择决定本机弹不弹），
    // 登录态就绪后再向服务器对齐一次（服务端才是单一事实来源）
    const storedConfig = await window.desktop?.getConfig?.();
    if (storedConfig?.notificationChannel) {
      appStore.applyLocalNotificationChannel(storedConfig.notificationChannel);
    }
    void appStore.loadNotificationChannel(auth.classId);

    // 连通性探测与健康轮询放到后台，不阻塞进入界面（离线时也能立刻看到缓存数据）
    void appStore.init(session.serverUrl);

    if (auth.token) realtime.connect(appStore.serverUrl, auth.token);

    // 灵动岛：开始按课表计算上课状态（上课隐藏、下课自动弹出）
    if (auth.token) startIslandBridge();

    // 灵动岛"标为已读" → 同步通知中心（未读红点）；多条通知时是整批已读
    subscribeIslandMarkRead();
    subscribeIslandMarkAllRead();

    // 启动自动检查发现新版本时由主进程推过来（订阅只挂一次，理由见 showUpdateAvailable）
    window.desktop?.onUpdateAvailable?.(showUpdateAvailable);

    if (auth.isAuthenticated) await router.replace('/schedule');
    else await router.replace('/login');

    // 初次启动引导：配置里没记「已看过」就自动弹一次（完成/跳过后由引导组件写入配置）。
    // 稍等一拍再弹：让登录页/主界面先渲染完，避免和启动过渡的收尾抢帧。
    window.setTimeout(() => {
      void window.desktop
        ?.getConfig()
        .then((config) => {
          if (config.onboardingDone !== true) onboarding.open();
        })
        .catch(() => undefined);
    }, 400);
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
    <!--
      启动文案会依次经过「读取本地配置 → 恢复登录状态」，直接换字是一下"啪"的跳变。
      交叉淡入（旧的上移淡出、新的从下方淡入）把两次状态读成**同一行字在更新**，
      而不是"屏幕闪了一下"。

      `:duration` 是必需的（理由同 ClientLayout 的页面过渡）：靠 `animationend` 判断的话，
      窗口不可见时动画被冻结、事件不触发，文案会一直停在第一句。
    -->
    <transition name="boot-text" mode="out-in" :duration="{ enter: 200, leave: 90 }">
      <p class="boot-text" :key="bootText">{{ bootText }}</p>
    </transition>
  </div>
  <router-view v-else />
  <!-- 初次启动引导：常驻挂载，由 onboarding store 控制显隐（登录页/主界面/设置页都能唤起） -->
  <OnboardingWelcome v-if="!booting" />
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
  /* 启动页是"整个应用的第一帧"，给标题一点入场分量是值得的 */
  animation: boot-title-in var(--ch-spring-panel-dur) var(--ch-spring-panel) both;
}

@keyframes boot-title-in {
  from {
    opacity: 0;
    transform: translateY(6px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.boot-text {
  margin: 0;
  font-size: 13px;
  color: rgba(255, 255, 255, 0.75);
}

@keyframes boot-text-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

@keyframes boot-text-out {
  from {
    opacity: 1;
    transform: none;
  }
  to {
    opacity: 0;
    transform: translateY(-4px);
  }
}

.boot-text-enter-active {
  animation: boot-text-in var(--ch-dur-base) var(--ch-ease-out) both;
}

.boot-text-leave-active {
  animation: boot-text-out var(--ch-dur-instant) var(--ch-ease-out) both;
}
</style>
