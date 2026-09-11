<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { SOCKET_EVENTS, type NotificationDto } from '@classhelper/shared';
import { useAppStore } from '../stores/app.js';
import { useAuthStore } from '../stores/auth.js';
import { useNotificationStore } from '../stores/notifications.js';
import { useRealtimeStore } from '../stores/realtime.js';

const route = useRoute();
const router = useRouter();
const appStore = useAppStore();
const auth = useAuthStore();
const realtime = useRealtimeStore();
const notifications = useNotificationStore();

const menuItems = [
  { name: 'schedule', title: '课表', icon: 'Calendar' },
  { name: 'homeworks', title: '作业', icon: 'Notebook' },
  { name: 'notifications', title: '通知', icon: 'Bell' },
  { name: 'grades', title: '成绩', icon: 'Trophy' },
  { name: 'settings', title: '设置', icon: 'Setting' },
];

const activeMenu = computed(() => `/${String(route.name ?? 'schedule')}`);

const connectionType = computed(() => {
  if (realtime.connected) return 'success';
  if (appStore.serverReachable) return 'warning';
  return 'danger';
});

const connectionText = computed(() => {
  if (realtime.connected) return '实时连接正常';
  if (appStore.serverReachable) return '服务器可达（实时通道重连中）';
  return '离线模式 · 显示缓存数据';
});

function go(name: string): void {
  void router.push({ name });
}

async function handleLogout(): Promise<void> {
  await ElMessageBox.confirm('确认退出当前账号？离线缓存会保留。', '退出登录', { type: 'warning' });
  realtime.disconnect();
  await auth.logout();
  ElMessage.success('已退出登录');
  void router.push({ name: 'login' });
}

/** 通知实时推送：更新列表 + 红点 + 缓存 */
function onNotification(payload: unknown): void {
  void notifications.pushRealtime(payload as NotificationDto);
  ElMessage({ message: '收到新通知，点击「通知」查看', type: 'info', duration: 3000 });
}

/** 服务器从不可达恢复为可达：自动同步一次（联网后自动同步） */
function onRecovered(): void {
  ElMessage.success('已重新连接服务器，正在同步最新数据');
  void notifications.load();
}

onMounted(async () => {
  await notifications.load().catch(() => undefined);
  await notifications.refreshUnreadCount();
  realtime.on(SOCKET_EVENTS.notificationNew, onNotification);
  appStore.onServerRecovered(onRecovered);
});

onUnmounted(() => {
  realtime.off(SOCKET_EVENTS.notificationNew, onNotification);
  appStore.offServerRecovered(onRecovered);
});
</script>

<template>
  <el-container class="layout">
    <el-aside width="190px" class="aside">
      <div class="brand">
        <el-icon :size="20"><School /></el-icon>
        <span>班级小助手</span>
      </div>
      <el-menu :default-active="activeMenu" class="menu" @select="go">
        <el-menu-item v-for="item in menuItems" :key="item.name" :index="`/${item.name}`">
          <el-icon><component :is="item.icon" /></el-icon>
          <span>{{ item.title }}</span>
          <el-badge
            v-if="item.name === 'notifications' && notifications.unreadCount > 0"
            :value="notifications.unreadCount"
            class="menu-badge"
          />
        </el-menu-item>
      </el-menu>
      <div class="aside-footer">
        <div class="aside-meta">第 {{ appStore.currentWeek }} 周</div>
        <div class="aside-meta">最近同步：{{ appStore.lastSyncText }}</div>
      </div>
    </el-aside>

    <el-container>
      <el-header class="header">
        <div class="header-left">
          <el-tag :type="connectionType" size="small" effect="light">{{ connectionText }}</el-tag>
          <el-tag v-if="auth.offlineSession" type="warning" size="small" effect="plain">离线会话</el-tag>
          <span class="server-url">{{ appStore.serverUrl }}</span>
        </div>
        <div class="header-right">
          <el-dropdown trigger="click">
            <span class="user-chip">
              <el-icon><UserFilled /></el-icon>
              {{ auth.displayName }}
              <el-icon><ArrowDown /></el-icon>
            </span>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item @click="go('settings')">
                  <el-icon><Setting /></el-icon>
                  设置
                </el-dropdown-item>
                <el-dropdown-item divided @click="handleLogout">
                  <el-icon><SwitchButton /></el-icon>
                  退出登录
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </el-header>

      <el-main class="main">
        <el-alert
          v-if="appStore.offline && appStore.initialized"
          class="offline-banner"
          type="warning"
          :closable="false"
          show-icon
          title="当前处于离线状态"
          :description="`服务器不可达，正在显示本地缓存数据（最近同步：${appStore.lastSyncText}）。恢复网络后会自动同步。`"
        />
        <router-view v-slot="{ Component }">
          <component :is="Component" />
        </router-view>
      </el-main>
    </el-container>
  </el-container>
</template>

<style scoped>
.layout {
  height: 100vh;
}

.aside {
  background: var(--ch-sidebar);
  color: #fff;
  display: flex;
  flex-direction: column;
}

.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 54px;
  padding: 0 16px;
  font-weight: 600;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.menu {
  flex: 1;
  border-right: none;
  background: transparent;
  --el-menu-text-color: #cbd5e1;
  --el-menu-hover-bg-color: rgba(255, 255, 255, 0.08);
  --el-menu-active-color: #fff;
}

.menu :deep(.el-menu-item) {
  margin: 2px 8px;
  border-radius: 6px;
}

.menu :deep(.el-menu-item.is-active) {
  background: #409eff;
}

.menu-badge {
  margin-left: 10px;
}

.aside-footer {
  padding: 10px 16px 14px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.aside-meta {
  font-size: 12px;
  color: #8fa3b8;
  line-height: 1.8;
}

.header {
  background: #fff;
  border-bottom: 1px solid var(--ch-border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
  overflow: hidden;
}

.server-url {
  font-size: 12px;
  color: #909399;
}

.user-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  outline: none;
}

.main {
  background: var(--ch-bg);
  padding: 0;
  overflow-y: auto;
}
</style>
