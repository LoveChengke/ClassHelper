<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import { STORAGE_KEYS } from '@classhelper/shared';
import { authApi } from '@/api';
import { useAuthStore } from '@/stores/auth';
import { useRealtimeStore } from '@/stores/realtime';
import { useResponsive } from '@/composables/useResponsive';
import { APP_TITLE } from '@/config';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const realtime = useRealtimeStore();
const { isMobile } = useResponsive();

/**
 * 菜单项与可见角色（与后端 `@classhelper/shared/permissions` 矩阵保持一致）：
 * - 班级管理 / 学生管理 / 教师管理：仅管理员（班主任与科任老师都没有班级增删改与人员分配权限）
 * - 课表管理：管理员 + 班主任（页面内再按"是否本班班主任"控制增删改按钮）
 * - 成绩录入：管理员 + 教师；页面内只对"管理员或所选班级的班主任"显示写入/导入按钮
 *   （需求 6：成绩与表格导入老师端可用且不越权；科任老师只能看，写入会被后端 403）
 * - 作业 / 通知：所有教师
 * - ClassIsland 联动：管理员 + 教师（设备令牌按班签发，页面内再按"能否管理该班"控制按钮）
 * - 数据库管理：仅管理员（备份/恢复/导入导出/一键切换是最高危操作，后端同样 requireRole('ADMIN')）
 */
const menuItems = [
  { path: '/dashboard', title: '仪表盘', icon: 'Odometer', roles: ['ADMIN', 'TEACHER'] },
  { path: '/classes', title: '班级管理', icon: 'School', roles: ['ADMIN'] },
  { path: '/students', title: '学生管理', icon: 'User', roles: ['ADMIN'] },
  { path: '/teachers', title: '教师管理', icon: 'UserFilled', roles: ['ADMIN'] },
  { path: '/schedules', title: '课表管理', icon: 'Calendar', roles: ['ADMIN', 'TEACHER'] },
  { path: '/homeworks', title: '作业发布', icon: 'Notebook', roles: ['ADMIN', 'TEACHER'] },
  { path: '/notifications', title: '通知发布', icon: 'Bell', roles: ['ADMIN', 'TEACHER'] },
  { path: '/grades', title: '成绩录入', icon: 'Trophy', roles: ['ADMIN', 'TEACHER'] },
  { path: '/integrations', title: 'ClassIsland 联动', icon: 'Connection', roles: ['ADMIN', 'TEACHER'] },
  { path: '/database', title: '数据库管理', icon: 'Coin', roles: ['ADMIN'] },
];

/** 当前账号可见的菜单（班级/学生管理仅管理员可见） */
const visibleMenuItems = computed(() =>
  menuItems.filter((item) => (auth.role ? item.roles.includes(auth.role) : false)),
);

/** 高亮当前菜单：直接比较路由路径，避免依赖路由名 */
const activeMenu = computed(() => route.path);

/** 顶栏显示的当前页面标题（小屏下替代侧边栏的"我在哪"提示，1Panel 同款做法） */
const currentTitle = computed(() => menuItems.find((item) => item.path === route.path)?.title ?? APP_TITLE);

/** 小屏：侧边栏收进抽屉，由顶栏汉堡按钮唤出 */
const drawerVisible = ref(false);

watch(
  () => route.path,
  () => {
    drawerVisible.value = false;
  },
);

watch(isMobile, (mobile) => {
  if (!mobile) drawerVisible.value = false;
});

/**
 * 菜单点击回调。
 * 注意：el-menu 的 @select 抛出的是 el-menu-item 的 index（这里即路由路径），
 * 不能当作路由名使用（router.push({ name }) 会因找不到同名路由而静默失败）。
 */
function handleMenuSelect(index: string): void {
  void router.push(index);
  drawerVisible.value = false;
}

/** 开发期自检：菜单路径必须存在于路由表中，防止再次出现"点了没反应" */
if (import.meta.env.DEV) {
  const knownPaths = new Set(router.getRoutes().map((item) => item.path));
  for (const item of menuItems) {
    if (!knownPaths.has(item.path)) {
      console.error(`[AdminLayout] 菜单项未注册对应路由：${item.path}`);
    }
  }
}

const connectionText = computed(() => {
  if (realtime.connected) return '实时通道已连接';
  if (realtime.connecting) return '实时通道连接中';
  return '实时通道已断开';
});

const connectionType = computed(() =>
  realtime.connected ? 'success' : realtime.connecting ? 'warning' : 'danger',
);

/**
 * 小屏顶栏的实时通道提示：
 * 连接正常时 **什么都不显示**（旧版只显示一个绿色圆点，看起来像坏掉的元素）；
 * 只有"连接中 / 已断开"这种异常态才显示带文字的紧凑标签。
 */
const mobileConnectionText = computed(() => (realtime.connecting ? '重连中…' : '已断开'));

async function handleLogout(): Promise<void> {
  await ElMessageBox.confirm('确认退出当前账号？', '退出登录', { type: 'warning' });
  await auth.logout();
  ElMessage.success('已退出登录');
  void router.push({ name: 'login' });
}

/* ------------------------------------------------------------ 修改密码 */
const passwordVisible = ref(false);
const passwordFormRef = ref<FormInstance>();
const passwordForm = reactive({ currentPassword: '', newPassword: '', confirmPassword: '' });
const passwordRules: FormRules = {
  currentPassword: [{ required: true, message: '请输入当前密码', trigger: 'blur' }],
  newPassword: [
    { required: true, message: '请输入新密码', trigger: 'blur' },
    { min: 6, message: '新密码至少 6 位', trigger: 'blur' },
  ],
  confirmPassword: [
    {
      validator: (_rule, value: string, callback: (error?: Error) => void) => {
        if (!value) callback(new Error('请再次输入新密码'));
        else if (value !== passwordForm.newPassword) callback(new Error('两次输入的密码不一致'));
        else callback();
      },
      trigger: 'blur',
    },
  ],
};

async function submitPassword(): Promise<void> {
  const valid = await passwordFormRef.value?.validate().catch(() => false);
  if (!valid) return;
  await authApi.changePassword({
    currentPassword: passwordForm.currentPassword,
    newPassword: passwordForm.newPassword,
  });
  passwordVisible.value = false;
  passwordForm.currentPassword = '';
  passwordForm.newPassword = '';
  passwordForm.confirmPassword = '';
  ElMessage.success('密码修改成功，请重新登录');
  await auth.logout();
  void router.push({ name: 'login' });
}

/* ------------------------------------------------------------ 首次登录引导 */

/**
 * 引导版本：内容改版后 +1，看过旧版的老用户会再收到一次新版引导。
 * 「已看过」存 localStorage（STORAGE_KEYS.onboarding，值为版本号）。
 */
const ONBOARDING_VERSION = 1;

const tourOpen = ref(false);

/** 「看过」落盘：走完、跳过（右上角 × / Esc）都算看过，之后不再自动弹出 */
function markOnboardingSeen(): void {
  try {
    localStorage.setItem(STORAGE_KEYS.onboarding, String(ONBOARDING_VERSION));
  } catch {
    // localStorage 不可用（隐私模式等）时仅本次会话内生效
  }
}

onMounted(() => {
  try {
    if (localStorage.getItem(STORAGE_KEYS.onboarding) === String(ONBOARDING_VERSION)) return;
  } catch {
    return;
  }
  // 等布局与首屏数据渲染稳定后再弹，避免和首屏加载抢注意力
  window.setTimeout(() => {
    tourOpen.value = true;
  }, 600);
});

/**
 * 引导锚点：按 data-tour 属性惰性查询 DOM（弹出某一步时才找元素）。
 * 找不到（例如手机小屏没有侧边栏）就返回 null，el-tour 会把卡片放到屏幕居中，不会报错。
 */
function tourTarget(name: string): () => HTMLElement | null {
  return () => document.querySelector<HTMLElement>(`[data-tour="${name}"]`);
}

const tourSteps = computed(() => [
  {
    target: null,
    title: '欢迎使用班级小助手',
    description:
      '教师与管理员在这里发布课表、作业、通知与成绩，学生通过桌面客户端实时接收。花一分钟认识一下界面。',
  },
  isMobile.value
    ? {
        target: tourTarget('nav-toggle'),
        title: '打开功能菜单',
        description: '小屏幕下侧边栏收进抽屉，点左上角按钮即可唤出全部功能页面。',
        placement: 'bottom-start',
      }
    : {
        target: tourTarget('side-nav'),
        title: '左侧功能菜单',
        description:
          '菜单按角色显示：管理员可管理班级、学生与教师；班主任与科任老师可维护课表、发布作业与通知、录入成绩。',
        // 侧栏是全高元素，默认 bottom 会把卡片推到视口外，必须放右侧
        placement: 'right',
      },
  {
    target: tourTarget('conn-tag'),
    title: '实时通道',
    description: '绿色表示与后端保持实时连接，发布的内容会立刻推送到对应班级的学生端与灵动岛。',
  },
  {
    target: tourTarget('user-chip'),
    title: '账号菜单',
    description: '在这里修改密码、退出登录，也可以随时重看本引导。',
  },
  {
    target: null,
    title: '开始使用',
    description: '发布第一条内容试试吧。以后随时可以点右上角头像 →「使用引导」重看。',
  },
]);
</script>

<template>
  <el-container class="layout">
    <!-- 桌面/平板：常驻深色侧边栏 -->
    <el-aside v-if="!isMobile" width="210px" class="layout-aside ch-sidebar" data-tour="side-nav">
      <div class="brand">
        <el-icon :size="22"><School /></el-icon>
        <span class="brand-text">班级小助手</span>
      </div>
      <el-menu :default-active="activeMenu" class="layout-menu" @select="handleMenuSelect">
        <el-menu-item v-for="item in visibleMenuItems" :key="item.path" :index="item.path">
          <el-icon><component :is="item.icon" /></el-icon>
          <span>{{ item.title }}</span>
        </el-menu-item>
      </el-menu>
    </el-aside>

    <el-container class="layout-body">
      <el-header class="layout-header">
        <div class="header-left">
          <!-- 小屏：汉堡按钮唤出抽屉菜单 -->
          <button
            v-if="isMobile"
            type="button"
            class="nav-toggle"
            aria-label="打开菜单"
            :aria-expanded="drawerVisible ? 'true' : 'false'"
            data-tour="nav-toggle"
            @click="drawerVisible = true"
          >
            <el-icon :size="20"><Menu /></el-icon>
          </button>
          <span class="header-title">{{ isMobile ? currentTitle : APP_TITLE }}</span>
          <el-tag v-if="!isMobile" :type="connectionType" size="small" effect="light" data-tour="conn-tag">
            <span class="header-conn">{{ connectionText }}</span>
          </el-tag>
          <!-- 小屏：连接正常时不显示任何圆点/标签，只在异常态显示带文字的紧凑标签 -->
          <el-tag
            v-else-if="!realtime.connected"
            :type="connectionType"
            size="small"
            effect="light"
            class="header-conn-mobile"
          >
            {{ mobileConnectionText }}
          </el-tag>
          <el-tag v-if="realtime.eventCount > 0 && !isMobile" size="small" type="info" effect="plain">
            已接收 {{ realtime.eventCount }} 条实时事件
          </el-tag>
        </div>

        <div class="header-right">
          <el-dropdown trigger="click">
            <span class="user-chip" data-tour="user-chip">
              <el-icon><UserFilled /></el-icon>
              <template v-if="!isMobile">
                {{ auth.displayName }}
                <el-tag size="small" type="info" effect="plain">{{ auth.roleLabel }}</el-tag>
              </template>
              <el-icon><ArrowDown /></el-icon>
            </span>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item disabled>{{ auth.displayName }} · {{ auth.roleLabel }}</el-dropdown-item>
                <el-dropdown-item divided @click="passwordVisible = true">
                  <el-icon><Lock /></el-icon>
                  修改密码
                </el-dropdown-item>
                <el-dropdown-item divided @click="tourOpen = true">
                  <el-icon><Guide /></el-icon>
                  使用引导
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

      <el-main class="layout-main">
        <router-view v-slot="{ Component }">
          <component :is="Component" />
        </router-view>
      </el-main>
    </el-container>

    <!-- 小屏抽屉菜单（1Panel 风格：深色侧栏内容与桌面端完全一致） -->
    <el-drawer
      v-model="drawerVisible"
      direction="ltr"
      size="240px"
      :with-header="false"
      class="ch-nav-drawer"
    >
      <div class="ch-sidebar ch-sidebar-drawer">
        <div class="brand">
          <el-icon :size="22"><School /></el-icon>
          <span class="brand-text">班级小助手</span>
        </div>
        <el-menu :default-active="activeMenu" class="layout-menu" @select="handleMenuSelect">
          <el-menu-item v-for="item in visibleMenuItems" :key="item.path" :index="item.path">
            <el-icon><component :is="item.icon" /></el-icon>
            <span>{{ item.title }}</span>
          </el-menu-item>
        </el-menu>
      </div>
    </el-drawer>

    <el-dialog v-model="passwordVisible" title="修改密码" width="420px">
      <el-form ref="passwordFormRef" :model="passwordForm" :rules="passwordRules" label-width="90px">
        <el-form-item label="当前密码" prop="currentPassword">
          <el-input v-model="passwordForm.currentPassword" type="password" show-password />
        </el-form-item>
        <el-form-item label="新密码" prop="newPassword">
          <el-input v-model="passwordForm.newPassword" type="password" show-password />
        </el-form-item>
        <el-form-item label="确认密码" prop="confirmPassword">
          <el-input v-model="passwordForm.confirmPassword" type="password" show-password />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="passwordVisible = false">取消</el-button>
        <el-button type="primary" @click="submitPassword">确认修改</el-button>
      </template>
    </el-dialog>

    <!--
      新手引导：首次登录自动弹出（见 script 的 onMounted），头像菜单「使用引导」可重看。
      target 为 null 的步骤（首尾两步）由 el-tour 放到屏幕居中；其余步骤锚定真实 UI。
    -->
    <el-tour v-model="tourOpen" @close="markOnboardingSeen" @finish="markOnboardingSeen">
      <el-tour-step
        v-for="(step, index) in tourSteps"
        :key="index"
        :target="step.target"
        :title="step.title"
        :description="step.description"
        :placement="step.placement"
      />
    </el-tour>
  </el-container>
</template>

<style scoped>
.layout {
  height: 100vh;
  height: 100dvh;
}

.layout-body {
  min-width: 0;
}

.layout-aside {
  display: flex;
  flex-direction: column;
}

.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 56px;
  padding: 0 16px;
  color: #fff;
  font-weight: 600;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.brand-text {
  font-size: 16px;
}

.layout-menu {
  border-right: none;
  background: transparent;
  flex: 1;
  --el-menu-text-color: #cbd5e1;
  --el-menu-hover-bg-color: rgba(255, 255, 255, 0.08);
  --el-menu-active-color: #ffffff;
}

.layout-menu :deep(.el-menu-item.is-active) {
  background: #409eff;
  border-radius: var(--ch-radius-sm);
  margin: 0 8px;
}

.layout-menu :deep(.el-menu-item) {
  margin: 2px 8px;
  border-radius: var(--ch-radius-sm);
}

.layout-header {
  /* 顶栏跟随圆角设计：底部圆角 + 轻投影，与内容区一体化 */
  border-radius: 0 0 var(--ch-radius-lg) var(--ch-radius-lg);
  box-shadow: var(--ch-shadow-sm);
  background: #fff;
  border-bottom: 1px solid var(--ch-border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 16px;
}

.nav-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  margin-right: 2px;
  border: none;
  border-radius: var(--ch-radius-sm);
  background: #f2f3f5;
  color: #303133;
  cursor: pointer;
  transition: background 0.18s ease;
}

.nav-toggle:hover {
  background: #e6e8eb;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.header-title {
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.header-conn {
  margin-left: 4px;
}

.header-right {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
}

.user-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  outline: none;
}

.layout-main {
  background: var(--ch-bg);
  padding: 0;
  overflow-y: auto;
}

/* 小屏：顶栏更紧凑，正文留出安全区 */
@media (max-width: 768px) {
  .layout-header {
    height: var(--ch-header-height);
    padding: 0 10px;
    gap: 8px;
  }

  .header-title {
    font-size: 15px;
  }

  /* 异常态才出现的实时通道标签：紧凑、不挤占标题 */
  .header-conn-mobile {
    flex: 0 0 auto;
    font-size: 11px;
  }
}
</style>

<style>
/* 侧边栏配色放在全局：桌面 asider 与移动端抽屉复用同一套样式（抽屉内容在 teleport 中，scoped 样式不生效） */
.ch-sidebar {
  /* 圆角设计：深色侧栏右侧做圆角，与内容区形成"卡片浮起"观感 */
  border-radius: 0 var(--ch-radius-xl) var(--ch-radius-xl) 0;
  overflow: hidden;
  background: #1f2d3d;
  color: #fff;
}

.ch-sidebar-drawer {
  height: 100%;
  display: flex;
  flex-direction: column;
}

/* 小屏抽屉：去掉 Element Plus 默认内边距，让深色侧栏铺满 */
.ch-nav-drawer .el-drawer__body {
  padding: 0;
  overflow: hidden;
}
</style>
