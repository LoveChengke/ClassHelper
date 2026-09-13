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
  { path: '/schedule', title: '课表', icon: 'Calendar' },
  { path: '/homeworks', title: '作业', icon: 'Notebook' },
  { path: '/notifications', title: '通知', icon: 'Bell' },
  { path: '/grades', title: '成绩', icon: 'Trophy' },
  { path: '/settings', title: '设置', icon: 'Setting' },
];

/** 高亮当前菜单：直接比较路由路径，避免依赖路由名 */
const activeMenu = computed(() => route.path);

/**
 * 菜单点击回调。
 * 注意：el-menu 的 @select 抛出的是 index（这里即路由路径），
 * 不能当作路由名传给 router.push({ name })，否则会静默失败（点击无反应）。
 */
function handleMenuSelect(index: string): void {
  void router.push(index);
}

/** 按路由名跳转（下拉菜单、按钮等程序化调用） */
function go(name: string): void {
  void router.push({ name });
}

/** 开发期自检：菜单路径必须存在于路由表中 */
if (import.meta.env.DEV) {
  const knownPaths = new Set(router.getRoutes().map((item) => item.path));
  for (const item of menuItems) {
    if (!knownPaths.has(item.path)) {
      console.error(`[ClientLayout] 菜单项未注册对应路由：${item.path}`);
    }
  }
}

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
    <el-aside width="200px" class="aside ch-nav">
      <div class="brand">
        <span class="brand-logo">
          <el-icon :size="16"><School /></el-icon>
        </span>
        <span class="brand-text">班级小助手</span>
      </div>
      <el-menu :default-active="activeMenu" class="menu" @select="handleMenuSelect">
        <el-menu-item v-for="item in menuItems" :key="item.path" :index="item.path">
          <!-- 未读红点挂在图标右上角（之前挂在文字后面，位置不对） -->
          <span class="menu-icon-slot">
            <el-icon><component :is="item.icon" /></el-icon>
            <el-badge
              v-if="item.path === '/notifications' && notifications.unreadCount > 0"
              :value="notifications.unreadCount"
              :max="99"
              class="menu-badge"
            />
          </span>
          <span>{{ item.title }}</span>
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
  background: var(--ch-bg);
}

.aside {
  display: flex;
  flex-direction: column;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 52px;
  padding: 0 16px;
  font-weight: 600;
  font-size: 14px;
  color: var(--ch-text);
}

/* Fluent 品牌标：强调色圆角方块 + 白色图标 */
.brand-logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 6px;
  color: #fff;
  background: linear-gradient(135deg, var(--ch-accent) 0%, #4d94d1 100%);
}

.brand-text {
  letter-spacing: 0.2px;
}

.menu {
  flex: 1;
  border-right: none;
  background: transparent;
  --el-menu-bg-color: transparent;
  --el-menu-hover-bg-color: rgba(0, 0, 0, 0.04);
  --el-menu-text-color: var(--ch-text);
  --el-menu-active-color: var(--ch-text);
}

/* 图标槽：作为未读红点的定位父级（红点在图标右上角） */
.menu-icon-slot {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

/*
 * 未读红点：定位到图标"右上角外侧"。
 * el-badge 默认把角标中线压在包裹元素右上角（translateY(-50%) translateX(100%)），
 * 这里显式覆盖成相对图标槽的负 top / 负 right，保证红点在图标右上方而不是右侧或下方。
 */
.menu-badge {
  position: absolute;
  top: 0;
  right: 0;
  width: 0;
  height: 0;
  margin: 0;
  pointer-events: none;
}

.menu-badge :deep(.el-badge__content) {
  position: absolute;
  top: -7px;
  right: -11px;
  transform: none;
  height: 16px;
  min-width: 16px;
  padding: 0 4px;
  line-height: 16px;
  font-size: 11px;
  border: none;
}

.aside-footer {
  padding: 10px 16px 14px;
  border-top: 1px solid var(--ch-divider);
}

.aside-meta {
  font-size: 12px;
  color: var(--ch-text-tertiary);
  line-height: 1.9;
}

.header {
  height: 52px;
  background: rgba(255, 255, 255, 0.6);
  backdrop-filter: blur(20px);
  border-bottom: 1px solid var(--ch-border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 16px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
  overflow: hidden;
}

.server-url {
  font-size: 12px;
  color: var(--ch-text-tertiary);
}

.user-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: var(--ch-radius-control);
  cursor: pointer;
  outline: none;
  transition: background 0.15s ease;
}

.user-chip:hover {
  background: rgba(0, 0, 0, 0.04);
}

.main {
  background: var(--ch-bg);
  padding: 0;
  overflow-y: auto;
}
</style>
