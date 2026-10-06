<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox, type MenuInstance } from 'element-plus';
import { SOCKET_EVENTS, type NotificationDto } from '@classhelper/shared';
import { startIslandBridge, stopIslandBridge } from '../island/bridge.js';
import { useThemeReveal } from '../composables/motion.js';
import { BRAND_LOGO_URL } from '../config.js';
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

/* -------------------------------------------------------------- 导航指示器 */

/**
 * 侧栏激活项的**滑动指示器**（beUI 的 `shared-layout-bg` / tabs 的 layoutId 手法）。
 *
 * 做法是**一个**绝对定位的底片跟着激活项平移，而不是让每个菜单项各自画一块底色 ——
 * 后者在切换时是"旧的瞬间消失、新的瞬间出现"，看不出两者之间的关系。
 *
 * 位置靠**量 DOM**：菜单项的位置由 Element Plus 的 padding 与行高决定，
 * 写死会在组件库升级或文案变长时错位；折叠成图标导轨时宽度还会变，量出来才跟得上。
 *
 * ⚠️ 这里用 `document.querySelector` 而不是模板 ref：`.aside` 是 `el-aside` **组件**，
 * 模板 ref 拿到的是组件实例（`.querySelector` 不是函数，实测踩过）；
 * 客户端只有一个主侧栏，直接查文档反而更直白。
 */
const indicator = ref({ x: 0, y: 0, width: 0, height: 0, visible: false });

function syncIndicator(): void {
  const aside = document.querySelector<HTMLElement>('.aside.ch-nav');
  const active = aside?.querySelector<HTMLElement>('.el-menu-item.is-active');
  if (!aside || !active) {
    indicator.value = { ...indicator.value, visible: false };
    return;
  }
  const asideRect = aside.getBoundingClientRect();
  const rect = active.getBoundingClientRect();
  indicator.value = {
    x: rect.left - asideRect.left,
    y: rect.top - asideRect.top,
    width: rect.width,
    height: rect.height,
    visible: rect.width > 0 && rect.height > 0,
  };
}

const indicatorStyle = computed(() => ({
  width: `${indicator.value.width}px`,
  height: `${indicator.value.height}px`,
  transform: `translate(${indicator.value.x}px, ${indicator.value.y}px)`,
  opacity: indicator.value.visible ? '1' : '0',
}));

let asideObserver: ResizeObserver | null = null;
let indicatorFrame = 0;

/**
 * 把测量推迟到下一帧再跑。
 *
 * 侧栏折叠时 `.aside` 的宽度有一整段过渡，`ResizeObserver` 会逐帧回调；若在回调里**同步**
 * 读 `getBoundingClientRect()` 再写样式，就是在每一帧中间强行插入一次同步布局
 * （Chromium 还会因此报 "ResizeObserver loop completed with undelivered notifications"）。
 * 放进 rAF 就变成"本帧布局完成后统一量一次"，代价是跟随慢一帧，肉眼无感。
 */
function scheduleIndicatorSync(): void {
  if (indicatorFrame) return;
  indicatorFrame = requestAnimationFrame(() => {
    indicatorFrame = 0;
    syncIndicator();
  });
}

/**
 * 首次测量放在 `onMounted`：子组件先于父组件挂载完成，此刻 `.el-menu-item.is-active`
 * 已在文档里，量完再让浏览器首帧绘制 —— 指示器第一次出现就是正确位置，不会从左上角滑过去。
 *
 * `ResizeObserver` 不是为了窗口缩放，而是为了**侧栏折叠**：折叠时 `.aside` 的宽度
 * 有一整段过渡（`--nav-dur`），观察它会逐帧回调，指示器于是跟着栏宽一起收 ——
 * 否则图标导轨形成后，底片还停在展开态的宽度上。
 */
onMounted(() => {
  syncIndicator();
  const aside = document.querySelector<HTMLElement>('.aside.ch-nav');
  if (aside && typeof ResizeObserver !== 'undefined') {
    asideObserver = new ResizeObserver(scheduleIndicatorSync);
    asideObserver.observe(aside);
  }
});

onUnmounted(() => {
  if (indicatorFrame) cancelAnimationFrame(indicatorFrame);
  indicatorFrame = 0;
  asideObserver?.disconnect();
  asideObserver = null;
});

// 路由变化后菜单的 active 类由 Element Plus 更新，等一拍再量
watch(
  () => route.path,
  () => {
    void nextTick(syncIndicator);
  },
);

/* ---------------------------------------------------------- 主题切换动画 */

/**
 * 顶栏的日夜快捷切换。
 *
 * "从点击位置扩散的圆"那套整页揭示由 `useThemeReveal()` 提供 ——
 * **与 Web 管理端共用同一份实现**（两端 `composables/motion.ts` 里的同名函数），
 * 这里只负责把"点击事件"和"切换主题"接起来。那三条守卫（不支持 View Transition /
 * 减少动态效果 / 文档不可见）都在组合式函数里，别在这里再判一遍。
 */
const revealThemeChange = useThemeReveal();

function handleThemeToggle(event: MouseEvent): void {
  revealThemeChange(event, () => ui.toggleTheme());
}

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
        <img class="brand-logo" :src="BRAND_LOGO_URL" alt="" width="26" height="26" />
        <span class="brand-text">ClassHelper</span>
      </div>
      <!-- 激活项的滑动指示器：单个底片在菜单项之间平移，位置由 syncIndicator() 量出来。
           pointer-events:none 是必需的 —— 它盖在菜单项上，否则会把点击吃掉。 -->
      <div class="nav-indicator" :style="indicatorStyle" aria-hidden="true" />
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
              @click="handleThemeToggle"
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
        <!--
          这里**刻意不用** `<transition>` 包 router-view。
          页面切换的动效由 `.page > *` 的错峰入场承担（styles/index.css）——
          那是随组件挂载同步触发的，不推迟任何东西。

          包一层过渡（尤其 `mode="out-in"`）会把"旧组件卸载、新组件挂载"推迟到退场动画结束
          （90ms 起）。代价有两个，都不值得：
            ① 点菜单后有一小段时间页面上还是**上一页**，用户和自动化看到的都是旧内容；
            ② 退场判定依赖 `animationend`，窗口被遮挡时 Chromium 冻结 CSS 动画、
               事件永不触发，新页面就永远不挂载 —— 整个客户端卡死在当前页。
               教室机器上窗口被别的东西盖住是常态，这条尤其要守。
          真要加回来，必须先确认这两条都有人兜住。
        -->
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
  /* 滑动指示器（.nav-indicator）的定位父级 */
  position: relative;
}

/*
 * 导航指示器：一个跟着激活项平移的底片，承载了原先"激活项底色 + 左侧强调条"两件事。
 *
 * 位置与尺寸都由 syncIndicator() 量出来后内联下发，这里只负责外观与过渡。
 * 缓动用 LAYOUT 弹簧（397ms）—— 它是"共享布局滑动"的专用参数：比 SWAP（263ms）更有分量，
 * 因为这一跳可能跨越好几个菜单项，太快会显得"闪"而不是"滑"。
 *
 * 折叠成图标导轨时，栏宽有一整段 260ms 的过渡，ResizeObserver 会逐帧把新宽度送进来，
 * 底片于是跟着栏宽一起收窄 —— 两个时长不一致是**故意的**：底片比栏慢一点，
 * 读起来像"被栏宽带着走"，同步反而显得僵硬。
 */
.nav-indicator {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 0;
  border-radius: var(--ch-radius-control);
  background: var(--ch-accent-soft);
  /* 必须穿透：它盖在菜单项上，否则点击会被它吃掉 */
  pointer-events: none;
  will-change: transform;
  transition:
    transform var(--ch-spring-layout-dur) var(--ch-spring-layout),
    width var(--ch-spring-layout-dur) var(--ch-spring-layout),
    height var(--ch-spring-layout-dur) var(--ch-spring-layout),
    opacity var(--ch-dur-fast) var(--ch-ease-out);
}

/* 左侧强调条（原有观感，现在跟着底片一起滑） */
.nav-indicator::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 16px;
  border-radius: 2px;
  background: var(--ch-accent);
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

/*
 * 品牌标：与应用图标同一份图（`public/logo.png`，由 `pnpm icons` 从 `build/classhelper.png` 生成）。
 * 上一版这里是"强调色渐变方块 + 白色 School 字形"手搓的占位标，换成真图标之后
 * `background` / `color` / `border-radius` / `overflow` 全部撤掉 —— 圆角与透明边角本来就在图里，
 * 再叠一层只会出现双重圆角。
 *
 * `src` 走 `BRAND_LOGO_URL`（见 `config.ts`）：模板里既不能写字面量的相对 `src`（Vite 会把它
 * 当模块导入去解析、构建失败），也不能写根绝对路径（Electron 生产环境走 file://，会解析到盘符根目录）。
 *
 * 折叠态的 `.is-collapsed .brand-logo { width: 0 }` 照旧生效：img 的 width 一样可过渡，
 * 而且它本来就带 opacity 淡出，收放观感与改造前完全一致。
 */
.brand-logo {
  display: block;
  width: 26px;
  height: 26px;
  flex: 0 0 auto;
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
