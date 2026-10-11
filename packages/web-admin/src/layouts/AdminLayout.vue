<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import { STORAGE_KEYS, type PermissionKey, type UserRole } from '@classhelper/shared';
import { authApi } from '@/api';
import UpdateCheckDialog from '@/components/UpdateCheckDialog.vue';
import { useAuthStore } from '@/stores/auth';
import { useRealtimeStore } from '@/stores/realtime';
import { useUiStore, CARE_SCALE_DEFAULT, CARE_SCALE_MAX, CARE_SCALE_MIN } from '@/stores/ui';
import { useResponsive } from '@/composables/useResponsive';
import { useThemeReveal } from '@/composables/motion';
import { APP_TITLE } from '@/config';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const realtime = useRealtimeStore();
const ui = useUiStore();
const { isMobile } = useResponsive();

/**
 * 顶栏的主题切换。整页"从点击位置扩散的圆"由 `useThemeReveal()` 提供
 * （与桌面客户端共用同一份实现，见 composables/motion.ts）。
 *
 * 入口只放在**登录后的主布局**里：登录页是刻意固定的深色渐变底（AGENTS.md §5 第 46 条），
 * 它不随主题走，在那里放一个切换按钮只会让人以为按钮坏了。
 */
const revealThemeChange = useThemeReveal();

function handleThemeToggle(event: MouseEvent): void {
  revealThemeChange(event, () => ui.toggleTheme());
}

/* ---------------------------------------------------------------- 侧栏折叠 */

/**
 * 顶栏左侧的汉堡按钮（仅桌面端；≤768px 侧栏已经收进抽屉，用的是另一个 `nav-toggle`）。
 *
 * 它**只改一个布尔值**：栏宽、文字的淡出、图标位置、行高、滚动条全都交给
 * `styles/index.css` 里 `.ch-nav.is-collapsed …` 那一段（那里有完整推导）——
 * 模板里没有任何 `v-if` 增删菜单项，折叠才是连续的收拢动画而不是"重排一下"。
 *
 * 缓动刻意与桌面客户端同一套参数（`--nav-dur` / `--nav-ease`，AGENTS.md §5 第 49 条）：
 * 这里不要换成 EASE_OUT 之类的"起步快"曲线 —— 两端观感要一致，且自动化会量到中间态。
 */
const collapseLabel = computed(() => (ui.sidebarCollapsed ? '展开菜单' : '收起菜单'));

/* ---------------------------------------------------------------- 关怀模式 */

/**
 * 关怀模式的入口放在顶栏的 `el-popover` 里，**不放进用户下拉菜单**：
 * 下拉菜单点一下（甚至点里面的滑块）就会收起，滑块根本拖不动。
 * 气泡里的开关与滑块都不是"点一下就走"的控件，放在气泡里正好。
 */
/** 放大倍数按百分比显示（1.2 → 120%），比裸小数好读 */
const careScalePercent = computed(() => `${Math.round(ui.careScale * 100)}%`);

/** el-switch 的 payload 是 `boolean | string | number` 的联合（active-value 可自定义），这里收口 */
function handleCareModeChange(value: boolean | string | number): void {
  ui.setCareMode(value === true);
}

/** el-slider 单值模式发 `number`、范围模式发 `number[]`，这里只接单值 */
function handleCareScaleChange(value: number | number[]): void {
  ui.setCareScale(Array.isArray(value) ? (value[0] ?? CARE_SCALE_DEFAULT) : value);
}

/* -------------------------------------------------------------- AI 助手入口 */

/** 顶栏的 AI 助手快捷入口：与侧栏菜单项同一道**生效权限**门控（默认管理员与教师都有） */
const canUseAssistant = computed(() => auth.can('ai:use'));

function openAssistant(): void {
  void router.push('/assistant');
}

/**
 * 菜单项与可见角色（与后端 `@classhelper/shared/permissions` 矩阵保持一致）：
 * - 班级管理 / 学生管理 / 教师管理：仅管理员（班主任与科任老师都没有班级增删改与人员分配权限）
 * - 课表管理：管理员 + 班主任（页面内再按"是否本班班主任"控制增删改按钮）
 * - 成绩录入：管理员 + 教师；页面内只对"管理员或所选班级的班主任"显示写入/导入按钮
 *   （需求 6：成绩与表格导入老师端可用且不越权；科任老师只能看，写入会被后端 403）
 * - 作业 / 通知：所有教师
 * - ClassIsland 联动：管理员 + 教师（设备令牌按班签发，页面内再按"能否管理该班"控制按钮）
 * - 数据库管理：仅管理员（备份/恢复/导入导出/一键切换是最高危操作，后端同样 requireRole('ADMIN')）
 * - 权限组管理 / 客户端设备：`roles` 只是粗筛（管理员 + 教师），真正的门控是**生效权限**
 *   （`permission:manage` / `client:manage`）—— 教师被某个权限组授予它之后同样该看见
 *   （见 `visibleMenuItems`）
 */
interface MenuItem {
  path: string;
  title: string;
  icon: string;
  roles: UserRole[];
  /** 可选的**生效权限**门控：有值时还要 `auth.can()` 通过才显示（角色判不出来这一层） */
  permission?: PermissionKey;
}

const menuItems: MenuItem[] = [
  { path: '/dashboard', title: '仪表盘', icon: 'Odometer', roles: ['ADMIN', 'TEACHER'] },
  { path: '/classes', title: '班级管理', icon: 'School', roles: ['ADMIN'] },
  { path: '/students', title: '学生管理', icon: 'User', roles: ['ADMIN'] },
  { path: '/teachers', title: '教师管理', icon: 'UserFilled', roles: ['ADMIN'] },
  { path: '/schedules', title: '课表管理', icon: 'Calendar', roles: ['ADMIN', 'TEACHER'] },
  { path: '/homeworks', title: '作业发布', icon: 'Notebook', roles: ['ADMIN', 'TEACHER'] },
  { path: '/notifications', title: '通知发布', icon: 'Bell', roles: ['ADMIN', 'TEACHER'] },
  { path: '/grades', title: '成绩录入', icon: 'Trophy', roles: ['ADMIN', 'TEACHER'] },
  {
    path: '/assistant',
    title: 'AI 助手',
    icon: 'MagicStick',
    // `ai:use` 默认给 ADMIN + TEACHER（教师用一句话发布作业/通知/叫人），
    // 但仍走**生效权限**细筛：管理员把 ai:use 从某个权限组收回后这里就该消失。
    roles: ['ADMIN', 'TEACHER'],
    permission: 'ai:use',
  },
  { path: '/integrations', title: 'ClassIsland 联动', icon: 'Connection', roles: ['ADMIN', 'TEACHER'] },
  {
    path: '/permissions',
    title: '权限组',
    icon: 'Lock',
    roles: ['ADMIN', 'TEACHER'],
    permission: 'permission:manage',
  },
  {
    path: '/clients',
    title: '客户端设备',
    icon: 'Monitor',
    // 与「权限组」同样按**生效权限**门控：教师默认没有 client:manage（见 shared/permissions.ts
    // 的默认模板只给 ADMIN），所以这里不能只写 roles —— 被权限组授予后教师也该看见。
    roles: ['ADMIN', 'TEACHER'],
    permission: 'client:manage',
  },
  {
    path: '/ai-settings',
    title: '大模型设置',
    icon: 'Setting',
    // 与「权限组」「客户端设备」同一道门控：只有 ai:manage（默认仅管理员）才看得见，
    // 页面里的配置读写也要求它（教师访问会 403）。
    roles: ['ADMIN', 'TEACHER'],
    permission: 'ai:manage',
  },
  { path: '/database', title: '数据库管理', icon: 'Coin', roles: ['ADMIN'] },
];

/**
 * 当前账号可见的菜单。
 *
 * 两道筛子：`roles` 是粗筛（角色级，与后端 `requireRole` 对齐），`permission` 是细筛
 * （生效权限级）——「权限组」必须走后者：教师被权限组授予 `permission:manage` 后
 * 角色还是 TEACHER，靠 `roles` 判断不出来。管理员在 `can()` 里短路为 true，
 * 所以这里不会因为权限还没拉回来而少显示一项。
 */
const visibleMenuItems = computed(() =>
  menuItems.filter((item) => {
    if (!auth.role || !item.roles.includes(auth.role)) return false;
    return !item.permission || auth.can(item.permission);
  }),
);

/** 高亮当前菜单：直接比较路由路径，避免依赖路由名 */
const activeMenu = computed(() => route.path);

/** 顶栏显示的当前页面标题（小屏下替代侧边栏的"我在哪"提示，1Panel 同款做法） */
const currentTitle = computed(() => menuItems.find((item) => item.path === route.path)?.title ?? APP_TITLE);

/* -------------------------------------------------------------- 导航指示器 */

/**
 * 侧栏激活项的**滑动指示器**（beUI 的 `shared-layout-bg` / tabs 的 layoutId 手法）。
 *
 * 做法是**一个**绝对定位的药丸跟着激活项平移，而不是让每个菜单项各自画一块底色。
 * 后者在切换时是"旧的瞬间消失、新的瞬间出现"，看不出两者之间的关系；
 * 前者的滑动把「我从这一项去了那一项」这个关系画了出来 —— 这是整个动效层里
 * 唯一一处"传达信息"而非"装饰"的动画。
 *
 * 位置靠**量 DOM**而不是写死数值：菜单项的位置由 Element Plus 的 padding 与行高决定，
 * 写死会在组件库升级、字号变化或菜单文案变长时错位。
 * 用 ResizeObserver 而不是 window.resize：侧栏宽度/菜单重排都可能由非窗口因素触发。
 */
/**
 * `el-aside` 是**组件**而不是原生标签：模板 ref 拿到的是组件实例，
 * 直接 `.querySelector()` 会 `TypeError: not a function`（实测踩过，而且被
 * `app.config.errorHandler` 吞成了控制台里一行中文异常，界面看着毫无异样）。
 * 组件实例的 `$el` 才是它真正渲染出来的那个 `<aside>` 元素。
 */
type AsideRef = { $el?: HTMLElement } | HTMLElement | null;
const asideRef = ref<AsideRef>(null);

function asideElement(): HTMLElement | null {
  const value = asideRef.value;
  if (!value) return null;
  return value instanceof HTMLElement ? value : (value.$el ?? null);
}

const indicator = ref({ x: 0, y: 0, width: 0, height: 0, visible: false });
/** 指示器的裁剪框 = 菜单**视口**（滚动容器自身），滚动时激活项滚出去就跟着被裁掉 */
const indicatorClip = ref({ top: 0, left: 0, width: 0, height: 0 });

/** 菜单滚动容器：桌面侧栏里的 .el-menu（小屏是抽屉里的另一个 el-menu，没有指示器） */
function menuScroller(): HTMLElement | null {
  return asideElement()?.querySelector<HTMLElement>('.layout-menu') ?? null;
}

function syncIndicator(): void {
  const aside = asideElement();
  const scroller = menuScroller();
  const active = scroller?.querySelector<HTMLElement>('.el-menu-item.is-active');
  if (!aside || !scroller || !active) {
    indicator.value = { ...indicator.value, visible: false };
    return;
  }
  const asideRect = aside.getBoundingClientRect();
  const box = scroller.getBoundingClientRect();
  /*
   * 以菜单视口为基准量，而不是以整个侧栏为基准。
   *
   * 菜单列是可滚动的（见 .layout-menu 的 overflow）：量侧栏的话，激活项被滚出视口后
   * 指示器会"贴"到品牌区/页脚上。裁剪框跟着菜单视口，指示器就只在菜单里可见。
   */
  indicatorClip.value = {
    top: box.top - asideRect.top,
    left: box.left - asideRect.left,
    width: box.width,
    height: box.height,
  };
  const rect = active.getBoundingClientRect();
  indicator.value = {
    x: rect.left - box.left,
    y: rect.top - box.top,
    width: rect.width,
    height: rect.height,
    visible: rect.width > 0 && rect.height > 0,
  };
}

const indicatorClipStyle = computed(() => ({
  top: `${indicatorClip.value.top}px`,
  left: `${indicatorClip.value.left}px`,
  width: `${indicatorClip.value.width}px`,
  height: `${indicatorClip.value.height}px`,
}));

const indicatorStyle = computed(() => ({
  width: `${indicator.value.width}px`,
  height: `${indicator.value.height}px`,
  transform: `translate(${indicator.value.x}px, ${indicator.value.y}px)`,
  opacity: indicator.value.visible ? '1' : '0',
}));

let asideObserver: ResizeObserver | null = null;
let indicatorFrame = 0;
let scrollerEl: HTMLElement | null = null;
let scrollSettleTimer = 0;
/** 正在跟随滚动：这期间关掉过渡，否则每帧都重新起一段 397ms 的弹簧，看起来"慢吞吞地追" */
const indicatorFollowing = ref(false);
const SCROLL_SETTLE_MS = 140;

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
 * 滚动菜单时**同步**量一次（不走 rAF 版）：滚动本身已经在合成器上跑，
 * 再隔一帧读数会看到指示器明显落后于菜单。
 */
function handleMenuScroll(): void {
  syncIndicator();
  indicatorFollowing.value = true;
  window.clearTimeout(scrollSettleTimer);
  scrollSettleTimer = window.setTimeout(() => {
    indicatorFollowing.value = false;
  }, SCROLL_SETTLE_MS);
}

/** 绑定/解绑菜单滚动监听（小屏没有侧栏，切回来时要重新绑） */
function bindMenuScroller(): void {
  const next = menuScroller();
  if (next === scrollerEl) return;
  scrollerEl?.removeEventListener('scroll', handleMenuScroll);
  scrollerEl = next;
  scrollerEl?.addEventListener('scroll', handleMenuScroll, { passive: true });
}

/**
 * 首次测量放在 onMounted（而不是 nextTick）：子组件先于父组件挂载完成，
 * 此刻 `.el-menu-item.is-active` 已在文档里，量完再让浏览器首帧绘制 ——
 * 于是指示器**第一次出现就是正确位置**，不会从左上角滑过去。
 */
onMounted(() => {
  // 生效权限（`GET /permissions/me`）：菜单里的「权限组」要等它回来才显示。
  // 失败不阻塞布局（store 内已静默吞掉），管理员在 can() 里短路、不受这一拍影响。
  void auth.ensurePermissions();
  syncIndicator();
  bindMenuScroller();
  const aside = asideElement();
  if (aside && typeof ResizeObserver !== 'undefined') {
    asideObserver = new ResizeObserver(scheduleIndicatorSync);
    asideObserver.observe(aside);
  }
});

onUnmounted(() => {
  if (indicatorFrame) cancelAnimationFrame(indicatorFrame);
  indicatorFrame = 0;
  window.clearTimeout(scrollSettleTimer);
  scrollerEl?.removeEventListener('scroll', handleMenuScroll);
  scrollerEl = null;
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
  // 侧栏是按 v-if 挂载/卸载的：从抽屉切回常驻侧栏后，新的 .el-menu 需要重新绑滚动监听
  void nextTick(() => {
    syncIndicator();
    bindMenuScroller();
  });
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

/* ------------------------------------------------------------ 检查更新 */
/** 顶栏用户菜单「检查更新」弹窗 */
const updateVisible = ref(false);

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
    title: '欢迎使用 ClassHelper',
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
    description: '绿色表示与后端保持实时连接，发布的内容会立刻推送到对应班级的 ClassHelper 班级端与灵动岛。',
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
    <!-- 桌面/平板：常驻深色侧边栏（折叠成 64px 图标导轨，见样式里的 .ch-nav.is-collapsed） -->
    <el-aside
      v-if="!isMobile"
      ref="asideRef"
      :width="ui.sidebarCollapsed ? 'var(--ch-aside-collapsed-width)' : 'var(--ch-aside-width)'"
      class="layout-aside ch-sidebar ch-nav"
      :class="{ 'is-collapsed': ui.sidebarCollapsed }"
      data-tour="side-nav"
    >
      <div class="brand">
        <img class="brand-logo" src="/logo.png" alt="" width="24" height="24" />
        <span class="brand-text">ClassHelper</span>
      </div>
      <!-- 激活项的滑动指示器：单个药丸在菜单项之间平移，位置由 syncIndicator() 量出来。
           外层裁剪框贴着**菜单视口**（菜单列可滚动，激活项滚出去时指示器要一起被裁掉），
           pointer-events:none 是必需的 —— 它盖在菜单项上，否则会把点击吃掉。 -->
      <div class="nav-indicator-clip" :style="indicatorClipStyle" aria-hidden="true">
        <div
          class="nav-indicator"
          :class="{ 'is-following': indicatorFollowing }"
          :style="indicatorStyle"
        />
      </div>
      <el-menu :default-active="activeMenu" class="layout-menu" @select="handleMenuSelect">
        <el-menu-item
          v-for="item in visibleMenuItems"
          :key="item.path"
          :index="item.path"
          :title="ui.sidebarCollapsed ? item.title : undefined"
        >
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
          <!--
            桌面：同一个位置的汉堡按钮负责把侧栏收成图标导轨。
            图标方向跟着**当前状态**走（展开时给「收起」、折叠时给「展开」），
            文案同步进 aria-label 与 title，鼠标悬停时能看出这一下会做什么。
          -->
          <button
            v-else
            type="button"
            class="nav-toggle"
            :aria-label="collapseLabel"
            :aria-expanded="ui.sidebarCollapsed ? 'false' : 'true'"
            :title="collapseLabel"
            data-test="nav-collapse-toggle"
            @click="ui.toggleSidebar()"
          >
            <el-icon :size="20">
              <Expand v-if="ui.sidebarCollapsed" />
              <Fold v-else />
            </el-icon>
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
          <!--
            AI 助手快捷入口：与侧栏「AI 助手」菜单项同一道门控。
            关怀模式打开时挂 .care-emphasis（字号写在 styles/index.css 的关怀模式块里，
            这里不写死数值）—— 这就是需求里"关怀模式下助手入口更大更醒目"那条。
          -->
          <el-tooltip
            v-if="canUseAssistant"
            content="AI 助手：一句话发布作业 / 通知 / 叫人"
            placement="bottom"
          >
            <el-button
              class="assistant-entry"
              :class="{ 'care-emphasis': ui.careMode }"
              text
              circle
              aria-label="打开 AI 助手"
              data-test="assistant-entry"
              @click="openAssistant"
            >
              <el-icon><MagicStick /></el-icon>
            </el-button>
          </el-tooltip>

          <!--
            关怀模式。入口刻意放在 el-popover 而不是用户下拉菜单里：
            下拉菜单点一下（甚至点里面的滑块）就会收起，滑块根本拖不动（见脚本里的注释）。
          -->
          <el-popover placement="bottom-end" :width="264" trigger="click" popper-class="care-popover">
            <template #reference>
              <button
                type="button"
                class="nav-toggle care-toggle"
                :class="{ 'is-on': ui.careMode }"
                :aria-pressed="ui.careMode ? 'true' : 'false'"
                aria-label="关怀模式"
                title="关怀模式"
                data-test="care-toggle"
              >
                <el-icon :size="18"><ZoomIn /></el-icon>
              </button>
            </template>
            <div class="care-panel">
              <div class="care-panel-row">
                <span class="care-panel-title">关怀模式</span>
                <el-switch
                  :model-value="ui.careMode"
                  aria-label="关怀模式"
                  @update:model-value="handleCareModeChange"
                />
              </div>
              <p class="care-panel-desc">放大正文字号与控件，方便不习惯默认字号的老师。</p>
              <div class="care-panel-row">
                <span class="care-panel-label">放大倍数</span>
                <span class="care-panel-value">{{ careScalePercent }}</span>
              </div>
              <el-slider
                :model-value="ui.careScale"
                :min="CARE_SCALE_MIN"
                :max="CARE_SCALE_MAX"
                :step="0.05"
                :disabled="!ui.careMode"
                aria-label="放大倍数"
                @update:model-value="handleCareScaleChange"
              />
              <p class="care-panel-desc">
                100% 是原始大小，最大 150%。关掉关怀模式后字号立即恢复，倍数会记住。
              </p>
            </div>
          </el-popover>

          <!--
            主题切换。与桌面客户端同一套（圆形揭示由 useThemeReveal 提供）。
            注意 `.header-right` 必须是 flex 容器：Element Plus 给 `.el-button` 的是
            `vertical-align: middle`、给 `.el-dropdown` 的是 `vertical-align: top`，
            放在普通 block 里两个 inline-level 子元素会按各自的规则落位、错开几像素
            （AGENTS.md §5 第 58 条，客户端当初就是这么翻的车）。
          -->
          <el-tooltip :content="ui.theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'" placement="bottom">
            <el-button
              class="theme-toggle"
              text
              circle
              data-test="theme-toggle"
              :aria-label="ui.theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'"
              @click="handleThemeToggle"
            >
              <el-icon>
                <Sunny v-if="ui.theme === 'dark'" />
                <Moon v-else />
              </el-icon>
            </el-button>
          </el-tooltip>
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
                <el-dropdown-item divided data-test="update-check-entry" @click="updateVisible = true">
                  <el-icon><Refresh /></el-icon>
                  检查更新
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
        <!--
          这里**刻意不用** `<transition>` 包 router-view。
          页面切换的动效由 `.page > *` 的错峰入场承担（styles/index.css）——
          那是随组件挂载同步触发的，不推迟任何东西。

          包一层过渡（尤其 `mode="out-in"`）会把"旧组件卸载、新组件挂载"推迟到退场动画结束
          （90ms 起）。代价有两个，都不值得：
            ① 点菜单后有一小段时间页面上还是**上一页**，用户和自动化看到的都是旧内容；
            ② 退场判定依赖 `animationend`，窗口被遮挡时 Chromium 冻结 CSS 动画、
               事件永不触发，新页面就永远不挂载 —— 整个应用卡死在第一页。
          真要加回来，必须先确认这两条都有人兜住。
        -->
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
          <img class="brand-logo" src="/logo.png" alt="" width="24" height="24" />
          <span class="brand-text">ClassHelper</span>
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

    <!-- 检查更新：问服务端最新 Release（浏览器受 CSP 限制不能直连 GitHub），见组件内说明 -->
    <UpdateCheckDialog v-model="updateVisible" />

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
  /* 导航指示器（.nav-indicator）的定位父级 */
  position: relative;
  /*
   * 折叠只过渡**栏宽**：宽度是唯一在变的东西，其余（文字淡出、图标位置、行高）
   * 都在 styles/index.css 的 .ch-nav.is-collapsed 段里各自声明过渡。
   * 时长/缓动用 --nav-dur / --nav-ease —— 与桌面客户端同一套参数，改一处两端同步。
   */
  transition: width var(--nav-dur) var(--nav-ease);
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

/*
 * 品牌标：与应用图标同一份图（`public/logo.png`，由 `pnpm icons` 从 `build/classhelper.png` 生成）。
 * 图本身自带圆角与透明边角，所以这里**不要**再加 border-radius / 背景 —— 会叠出第二层圆角。
 * `flex: none` 是必需的：`.brand` 是 flex 容器，不加的话侧栏收窄时这张图会被压扁。
 */
.brand-logo {
  flex: none;
  display: block;
}

.layout-menu {
  border-right: none;
  background: transparent;
  flex: 1;
  /*
   * 菜单列**自己滚动**（这是"小屏状态下菜单无法上下滑动"的修法）：
   * - `min-height: 0` 是关键：flex 项默认 `min-height: auto`，永远不小于内容高度，
   *   于是 overflow 永不生效、超出的菜单项被直接裁掉；
   * - 小屏抽屉里 `.el-drawer__body` 是 `overflow: hidden`，滚动只能由这一列承担，
   *   否则抽屉一关一开就只剩上半截菜单能点。
   * 滚动条做细一点、半透明：深色侧栏上一条系统浅色滚动条太扎眼。
   */
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.18) transparent;
  --el-menu-text-color: #cbd5e1;
  --el-menu-hover-bg-color: rgba(255, 255, 255, 0.08);
  --el-menu-active-color: #ffffff;
}

.layout-menu::-webkit-scrollbar {
  width: 6px;
}

.layout-menu::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.18);
  border-radius: 999px;
}

.layout-menu::-webkit-scrollbar-track {
  background: transparent;
}

/*
 * 激活项的底色改由导航指示器承担（见 .nav-indicator）。
 *
 * 这里顺手修掉一个既有小毛病：原先激活项自带 `margin: 0 8px`，把普通项的 `2px 8px`
 * 覆盖掉了，于是**每次切换菜单，激活项上下各少 2px、它下面的所有项都跟着跳 4px**。
 * 现在激活项不再单独改外边距，切换时整列菜单纹丝不动。
 */
.layout-menu :deep(.el-menu-item) {
  margin: 2px 8px;
  border-radius: var(--ch-radius-sm);
  /* 压在指示器之上，文字才不会被盖住 */
  position: relative;
  z-index: 1;
}

.layout-menu :deep(.el-menu-item.is-active) {
  color: #ffffff;
}

/*
 * 导航指示器的裁剪框：贴着菜单视口（.layout-menu 的 border box）。
 * 菜单列可以滚动，激活项滚出视口后指示器必须跟着被裁掉，否则它会画到品牌区/页脚上。
 */
.nav-indicator-clip {
  position: absolute;
  overflow: hidden;
  pointer-events: none;
  z-index: 0;
}

/*
 * 导航指示器：一个跟着激活项平移的药丸。宽高与位移由 syncIndicator() 量出来后内联下发，
 * 这里只负责外观与过渡。
 *
 * 缓动用 LAYOUT 弹簧（397ms）—— 它是"共享布局滑动"的专用参数：比 SWAP（263ms）更有分量，
 * 因为这一跳可能跨越好几个菜单项，太快会显得"闪"而不是"滑"。
 */
.nav-indicator {
  position: absolute;
  top: 0;
  left: 0;
  border-radius: var(--ch-radius-sm);
  background: #409eff;
  /* 必须穿透：它盖在菜单项上，否则点击会被它吃掉 */
  pointer-events: none;
  will-change: transform;
  transition:
    transform var(--ch-spring-layout-dur) var(--ch-spring-layout),
    width var(--ch-spring-layout-dur) var(--ch-spring-layout),
    height var(--ch-spring-layout-dur) var(--ch-spring-layout),
    opacity var(--ch-dur-fast) var(--ch-ease-out);
}

/* 滚动跟随期间关掉过渡：每帧重起一段 397ms 弹簧会变成"慢吞吞地追" */
.nav-indicator.is-following {
  transition: none;
}

.layout-header {
  /* 顶栏跟随圆角设计：底部圆角 + 轻投影，与内容区一体化 */
  border-radius: 0 0 var(--ch-radius-lg) var(--ch-radius-lg);
  box-shadow: var(--ch-shadow-sm);
  background: var(--ch-surface);
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
  background: var(--ch-surface-sunken);
  color: var(--ch-text);
  cursor: pointer;
  transition: background 0.18s ease;
}

.nav-toggle:hover {
  background: var(--ch-surface-hover);
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
  /* 主题按钮与用户名牌之间留一点气口（两者原本紧贴） */
  gap: 4px;
  flex: 0 0 auto;
}

.theme-toggle {
  color: var(--ch-text-muted);
}

.theme-toggle:hover {
  color: var(--ch-text);
}

/*
 * 关怀模式按钮：关掉时与主题按钮同款（安静的文字色），开启时用主色 + 淡底标出"正在生效"。
 * 纯图标按钮必须靠这点颜色区分状态，否则用户看不出自己刚点开过什么。
 */
.care-toggle {
  color: var(--ch-text-muted);
}

.care-toggle:hover {
  color: var(--ch-text);
}

.care-toggle.is-on {
  color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
}

/* 悬停时同样要保持"已开启"的底色（.nav-toggle:hover 的特异度更低，不会覆盖到这里） */
.care-toggle.is-on:hover {
  background: var(--el-color-primary-light-8);
}

/* AI 助手快捷入口：与主题按钮同款文字色；关怀模式下由全局的 .care-emphasis 放大字号 */
.assistant-entry {
  color: var(--ch-text-muted);
}

.assistant-entry:hover {
  color: var(--ch-text);
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

/*
 * 关怀模式气泡的排版。
 *
 * 放在**全局块**里是必需的：el-popover 的内容被 teleport 到 body 上，
 * 组件级 scoped 样式（带 data-v 属性选择器）一个都选不中它 —— 与上面 .ch-sidebar 同一个理由。
 * 字号一律引用 --el-font-size-* 且圆角/投影走 --ch-* 令牌：关怀模式打开时这一块自己也会跟着放大，
 * 不需要在这里再写一份 calc。
 */
.care-popover {
  border-radius: var(--ch-radius-md);
  box-shadow: var(--ch-shadow-md);
}

.care-panel {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.care-panel-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.care-panel-title {
  font-size: var(--el-font-size-base);
  font-weight: 600;
}

.care-panel-label {
  color: var(--ch-text-secondary);
  font-size: var(--el-font-size-small);
}

.care-panel-value {
  color: var(--el-color-primary);
  font-size: var(--el-font-size-small);
  font-variant-numeric: tabular-nums;
}

.care-panel-desc {
  margin: 0;
  color: var(--ch-text-muted);
  font-size: var(--el-font-size-extra-small);
  line-height: 1.5;
}
</style>
