<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox, type MenuInstance } from 'element-plus';
import { SOCKET_EVENTS, type NotificationDto } from '@classhelper/shared';
import { startIslandBridge, stopIslandBridge } from '../island/bridge.js';
import { useAppStore } from '../stores/app.js';
import { useAuthStore } from '../stores/auth.js';
import { useNotificationStore } from '../stores/notifications.js';
import { useRealtimeStore } from '../stores/realtime.js';
import { useUiStore } from '../stores/ui.js';

const route = useRoute();
const router = useRouter();
const appStore = useAppStore();
const auth = useAuthStore();
const realtime = useRealtimeStore();
const notifications = useNotificationStore();
const ui = useUiStore();

/**
 * 主侧边栏。
 *
 * - **一级项**：课表 / 作业 / 通知 / 成绩 —— 直接铺在侧栏上，**不再套「学习」分组**。
 *   分组标题白占一行、还得多点一次展开，折叠成图标导轨时尤其明显（用户要求拆掉）。
 * - **分组**：只剩「设置」（通用 / 外观 / 灵动岛 / 提醒 / 账号 / 关于，各自是独立路由）。
 *   6 个子项平铺太长，保留分组与"默认只展开当前路由所在分组"。折叠后是图标导轨，
 *   分组子项与一级项一样以图标列出（见 styles/index.css 的折叠态规则）。
 *
 * 顶栏左侧汉堡按钮把整栏收成图标导轨（状态持久化在主进程配置里）。
 */
const primaryItems = [
  { path: '/schedule', title: '课表', icon: 'Calendar' },
  { path: '/homeworks', title: '作业', icon: 'Notebook' },
  { path: '/notifications', title: '通知', icon: 'Bell' },
  { path: '/grades', title: '成绩', icon: 'Trophy' },
];

const menuGroups = [
  {
    title: '设置',
    icon: 'Setting',
    items: [
      { path: '/settings/general', title: '通用', icon: 'Tools' },
      { path: '/settings/appearance', title: '外观', icon: 'Brush' },
      { path: '/settings/island', title: '灵动岛', icon: 'MagicStick' },
      { path: '/settings/reminder', title: '提醒', icon: 'AlarmClock' },
      { path: '/settings/account', title: '账号', icon: 'UserFilled' },
      { path: '/settings/about', title: '关于', icon: 'InfoFilled' },
    ],
  },
];

/** 未读红点挂在「通知」项的图标右上角 */
function showBadge(path: string): boolean {
  return path === '/notifications' && notifications.unreadCount > 0;
}

/** 高亮当前菜单：直接比较路由路径，避免依赖路由名 */
const activeMenu = computed(() => route.path);

/** 当前路由所属的分组标题（用于"只默认展开所在分组"，与 ClassIsland 一致） */
const activeGroupTitle = computed(() => {
  const group = menuGroups.find((item) => item.items.some((entry) => route.path === entry.path));
  // 落在**一级项**（课表/作业/通知/成绩）上没有所属分组 —— 返回 null，别拿某个组的名字顶上去
  return group?.title ?? null;
});

/**
 * 分组展开控制：默认只展开**当前路由所在的分组**（一级项不属于任何分组，此时一个都不展开）。
 *
 * 窗口默认高度与 ClassIsland 对齐（582px），设置组 6 个子项展开后会超出可视高度、
 * 把底部的「账号 / 关于」挤出屏幕；只展开当前组既符合 ClassIsland 的观感（它也只展开当前组），
 * 又让小窗口下的侧栏始终完整可见。用户手动展开其它分组不受限制（可多个同时展开）。
 */
const menuRef = ref<MenuInstance>();
const openedGroups = ref<string[]>(activeGroupTitle.value ? [activeGroupTitle.value] : []);

watch(
  () => route.path,
  async (path) => {
    const group = menuGroups.find((item) => item.items.some((entry) => path === entry.path));
    if (!group) return;
    // 展开当前组（不主动关闭用户已展开的其它组）
    await nextTick();
    menuRef.value?.open(group.title);
  },
);

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
  for (const group of menuGroups) {
    for (const item of group.items) {
      if (!knownPaths.has(item.path)) {
        console.error(`[ClientLayout] 菜单项未注册对应路由：${item.path}`);
      }
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

/**
 * 通知实时推送：更新通知中心列表与红点。
 *
 * 这里**不再**额外弹一条"收到新通知"的 toast —— `stores/realtime.ts` 收到
 * notification:new 时已经弹过带优先级与标题的那条，两条堆在屏幕上纯属噪音。
 */
function onNotification(payload: unknown): void {
  void notifications.pushRealtime(payload as NotificationDto);
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
  // 灵动岛桥接跟着"已登录布局"的生命周期走：这样退出登录会随布局卸载而停止，
  // 重新登录（或换班登录）时又会重新启动，不会拿旧课表算上课状态。
  if (auth.token) startIslandBridge();
});

onUnmounted(() => {
  realtime.off(SOCKET_EVENTS.notificationNew, onNotification);
  appStore.offServerRecovered(onRecovered);
  stopIslandBridge();
});
</script>

<template>
  <el-container class="layout">
    <el-aside
      :width="ui.sidebarCollapsed ? '64px' : '200px'"
      class="aside ch-nav"
      :class="{ 'is-collapsed': ui.sidebarCollapsed }"
    >
      <div class="brand">
        <button
          type="button"
          class="nav-toggle"
          aria-label="折叠或展开侧边栏"
          :aria-expanded="ui.sidebarCollapsed ? 'false' : 'true'"
          data-test="sidebar-toggle"
          @click="ui.toggleSidebar()"
        >
          <el-icon :size="16"><Expand v-if="ui.sidebarCollapsed" /><Fold v-else /></el-icon>
        </button>
        <!-- 品牌区在折叠时**不是 v-if 删掉**，而是靠 CSS 收宽度 + 淡出：
             v-if 会在动画中途把节点直接摘掉，看上去是"啪"地一跳；收放要连续就得让它们一直在。 -->
        <span class="brand-logo">
          <el-icon :size="16"><School /></el-icon>
        </span>
        <span class="brand-text">班级小助手</span>
      </div>
      <el-menu
        ref="menuRef"
        :default-active="activeMenu"
        :default-openeds="openedGroups"
        class="menu"
        @select="handleMenuSelect"
      >
        <!-- 一级项：直接铺在侧栏上（不再套「学习」分组）。
             下面 el-sub-menu 里的菜单项与本段是同一套标记（图标槽 + 未读红点 + 标题），
             改动时两处要一起改。 -->
        <el-menu-item v-for="item in primaryItems" :key="item.path" :index="item.path">
          <span class="menu-icon-slot">
            <el-icon><component :is="item.icon" /></el-icon>
            <el-badge
              v-if="showBadge(item.path)"
              :value="notifications.unreadCount"
              :max="99"
              class="menu-badge"
            />
          </span>
          <span>{{ item.title }}</span>
        </el-menu-item>
        <el-sub-menu v-for="group in menuGroups" :key="group.title" :index="group.title">
          <template #title>
            <el-icon><component :is="group.icon" /></el-icon>
            <span>{{ group.title }}</span>
          </template>
          <el-menu-item v-for="item in group.items" :key="item.path" :index="item.path">
            <!-- 未读红点挂在图标右上角（之前挂在文字后面，位置不对） -->
            <span class="menu-icon-slot">
              <el-icon><component :is="item.icon" /></el-icon>
              <el-badge
                v-if="showBadge(item.path)"
                :value="notifications.unreadCount"
                :max="99"
                class="menu-badge"
              />
            </span>
            <span>{{ item.title }}</span>
          </el-menu-item>
        </el-sub-menu>
      </el-menu>
      <!-- 同上：折叠时不删节点，只淡出并收掉内边距 -->
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
          <!-- 黑夜/白天快捷切换：外观页里也有同样的设置，两处写同一份配置 -->
          <el-tooltip :content="ui.theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'" placement="bottom">
            <el-button
              class="theme-toggle"
              text
              circle
              data-test="theme-toggle"
              :aria-label="ui.theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'"
              @click="ui.toggleTheme()"
            >
              <el-icon><Sunny v-if="ui.theme === 'dark'" /><Moon v-else /></el-icon>
            </el-button>
          </el-tooltip>
          <el-dropdown trigger="click">
            <span class="user-chip">
              <el-icon><UserFilled /></el-icon>
              {{ auth.displayName }}
              <el-icon><ArrowDown /></el-icon>
            </span>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item @click="go('settings-general')">
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
  /* 展开/收回动画：宽度来自 el-aside 的内联 --el-aside-width，这里只负责过渡。
     overflow:hidden 是必需的 —— 收窄过程中文字要被栏边裁掉，不能溢出到主区域；
     菜单自己的滚动由内部的 .menu（flex:1 + min-height:0 + overflow-y:auto）负责。 */
  overflow: hidden;
  transition: width var(--nav-dur) var(--nav-ease);
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 52px;
  padding: 0 10px 0 12px;
  font-weight: 600;
  font-size: 14px;
  color: var(--ch-text);
  transition:
    padding-left var(--nav-dur) var(--nav-ease),
    gap var(--nav-dur) var(--nav-ease);
}

/* 汉堡按钮：折叠/展开整个侧边栏（状态持久化） */
.nav-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
  border: none;
  border-radius: var(--ch-radius-control);
  background: transparent;
  color: var(--ch-text-secondary);
  cursor: pointer;
  transition: background 0.15s ease;
}

.nav-toggle:hover {
  background: var(--ch-hover-soft);
}

/* 折叠态：侧栏只剩 64px，汉堡按钮水平居中。
   用**位移 padding-left** 而不是 `justify-content: center` —— 后者不可过渡，会在动画中途"跳"一下。
   汉堡宽 28px，padding-left 18px ⇒ 中心 = 18 + 14 = 32px，正好是 64/2，与折叠后的图标导轨同列
   （冒烟断言中心差 ≤ 2px）。
   这里刻意用**自己的类名**（`.is-collapsed`）而不是 `:has(.el-menu--collapse)`：
   `:has()` 的失效会让 Chromium 标记整棵文档树重新计算样式。 */
.aside.ch-nav.is-collapsed .brand {
  padding-left: 18px;
}

/* Fluent 品牌标：强调色圆角方块 + 白色图标 */
.brand-logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  flex: 0 0 auto;
  border-radius: 6px;
  color: #fff;
  background: linear-gradient(135deg, var(--ch-accent) 0%, #4d94d1 100%);
  overflow: hidden;
  transition:
    width var(--nav-dur) var(--nav-ease),
    opacity calc(var(--nav-dur) * 0.6) var(--nav-ease);
}

/*
 * 品牌文字 / 菜单文字在折叠时**不靠 max-width 归零**（那要么写死一个魔法数字，要么
 * `none → 0` 根本不可过渡），而是：
 *   - `min-width: 0` 让这个 flex 子项能被压缩（默认的 `min-width: auto` 会撑住内容宽度）；
 *   - 宽度自然跟着栏宽收缩，多出来的字被 `overflow: hidden` 裁掉；
 *   - 再叠一层 opacity 淡出，避免在中间帧里留下"半截字"。
 * 于是文字宽度是**跟着侧栏宽度连续变化**的，不需要给它单独设动画终点。
 */
.brand-text {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  letter-spacing: 0.2px;
  transition: opacity calc(var(--nav-dur) * 0.6) var(--nav-ease);
}

/* 折叠：品牌区收成 0 宽并淡出（不是删节点，理由见模板上的注释） */
.aside.ch-nav.is-collapsed .brand {
  gap: 0;
}

/*
 * 图标导轨里**不显示滚动条**：所有图标应当一眼看全（用户要求"不要用滚轮、删掉滚动条"）。
 * 导轨之所以放得下，靠的是页脚在折叠态把高度也收成 0（见 .is-collapsed .aside-footer）——
 * 不再有那 ~70px 的留白，11 行图标（462px）在 540px 的最小窗口里也够。
 * 这里只隐藏滚动条本身，`overflow-y: auto` 保留：窗口被拉到极矮时还能滚，不至于把图标直接裁掉。
 * 展开态**不隐藏** —— 那一栏确实会超（设置组展开时约 606px > 582px），
 * 滚动条是"下面还有内容"的唯一提示，不能拿掉。
 */
.aside.ch-nav.is-collapsed .menu {
  scrollbar-width: none;
}

.aside.ch-nav.is-collapsed .brand-logo {
  width: 0;
  opacity: 0;
}

.aside.ch-nav.is-collapsed .brand-text {
  opacity: 0;
}

.menu {
  flex: 1;
  /* min-height:0 是 flex 子项能滚动的关键：否则内容撑高、底部 footer 被挤出窗口 */
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  border-right: none;
  background: transparent;
  --el-menu-bg-color: transparent;
  --el-menu-hover-bg-color: var(--ch-hover-soft);
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
  overflow: hidden;
  /* max-height 是给折叠动画用的终点：`* { box-sizing: border-box }`，展开态给一个略高于
     内容（约 70px）的值，折叠时归零 —— 导轨里**一个像素都不给页脚留**。
     不这么做的话，文字淡出后仍占着 ~70px，10 个图标在 540px 的最小窗口里就放不下、被迫滚动
     （用户反馈："图标无法完全显示、需要上下滑动、滚动条碍眼"）。 */
  max-height: 96px;
  transition:
    opacity calc(var(--nav-dur) * 0.7) var(--nav-ease),
    padding var(--nav-dur) var(--nav-ease),
    max-height var(--nav-dur) var(--nav-ease),
    border-top-color var(--nav-dur) var(--nav-ease);
}

/* 折叠：页脚淡出、内边距与高度一起收到 0，分隔线也透明掉。
   `min-height: 0` 是必需的：flex 子项默认 `min-height: auto`（= 内容高度），
   而 CSS 里 min-height 优先于 max-height —— 不显式归零的话 max-height:0 根本压不下去。 */
.aside.ch-nav.is-collapsed .aside-footer {
  opacity: 0;
  padding-top: 0;
  padding-bottom: 0;
  max-height: 0;
  min-height: 0;
  border-top-color: transparent;
  pointer-events: none;
}

.aside-meta {
  font-size: 12px;
  color: var(--ch-text-tertiary);
  line-height: 1.9;
}

.header {
  height: 52px;
  background: var(--ch-header-bg);
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

.header-right {
  /* 必须是 flex：Element Plus 的按钮是 `vertical-align: middle`、下拉容器是 `vertical-align: top`，
     放在普通 block 容器里两个 inline-level 子元素会按各自的垂直对齐规则落位，主题切换按钮与
     用户名牌就会错开几像素（用户反馈的"深色模式没对齐"，其实两种主题下都偏，只是深色下更显眼）。
     与 Web 管理端 AdminLayout 的同名容器保持同一套写法。 */
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
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
  background: var(--ch-hover-soft);
}

.theme-toggle {
  /* 与用户名牌的间距由 .header-right 的 gap 负责，这里不再自带 margin */
  color: var(--ch-text-secondary);
}

.main {
  background: var(--ch-bg);
  padding: 0;
  overflow-y: auto;
}
</style>
