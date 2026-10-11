import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';
import { useUiStore } from '../stores/ui.js';

/**
 * Electron 生产环境通过 file:// 加载页面，无法使用 history 模式，
 * 因此统一使用 hash 路由（开发与打包行为一致）。
 */
const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('../views/LoginView.vue'),
    meta: { public: true, title: '登录' },
  },
  {
    path: '/',
    component: () => import('../layouts/ClientLayout.vue'),
    redirect: '/schedule',
    children: [
      {
        path: 'schedule',
        name: 'schedule',
        component: () => import('../views/ScheduleView.vue'),
        meta: { title: '课表' },
      },
      {
        path: 'homeworks',
        name: 'homeworks',
        component: () => import('../views/HomeworkView.vue'),
        meta: { title: '作业' },
      },
      {
        path: 'notifications',
        name: 'notifications',
        component: () => import('../views/NotificationView.vue'),
        meta: { title: '通知' },
      },
      {
        path: 'grades',
        name: 'grades',
        component: () => import('../views/GradeView.vue'),
        meta: { title: '成绩' },
      },
      /* 设置：主侧边栏「设置」分组下的六个子页（ClassIsland 式 主菜单+子菜单） */
      {
        path: 'settings',
        redirect: '/settings/general',
      },
      {
        path: 'settings/general',
        name: 'settings-general',
        component: () => import('../views/settings/GeneralSettingsView.vue'),
        meta: { title: '通用设置' },
      },
      {
        path: 'settings/appearance',
        name: 'settings-appearance',
        component: () => import('../views/settings/AppearanceView.vue'),
        meta: { title: '外观' },
      },
      {
        path: 'settings/island',
        name: 'settings-island',
        component: () => import('../views/settings/IslandSettingsView.vue'),
        meta: { title: '灵动岛' },
      },
      {
        path: 'settings/reminder',
        name: 'settings-reminder',
        component: () => import('../views/settings/ReminderSettingsView.vue'),
        meta: { title: '提醒' },
      },
      {
        path: 'settings/account',
        name: 'settings-account',
        component: () => import('../views/settings/AccountSettingsView.vue'),
        meta: { title: '账号' },
      },
      {
        path: 'settings/about',
        name: 'settings-about',
        component: () => import('../views/settings/AboutView.vue'),
        meta: { title: '关于' },
      },
      {
        /**
         * 开发者（需求 10）。入口只在 `config.developerMode === true` 时出现在侧栏上，
         * 但**路由始终注册**：关掉开关后侧栏项消失，已打开的页面靠一条守卫弹回「通用」，
         * 不做成条件注册 —— 条件注册会让 `router.getRoutes()` 随配置变化，
         * ClientLayout 的开发期自检与直接输 URL 的行为都会变得难以预期。
         */
        path: 'settings/developer',
        name: 'settings-developer',
        component: () => import('../views/settings/DeveloperSettingsView.vue'),
        meta: { title: '开发者' },
      },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/schedule' },
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

router.beforeEach((to) => {
  const auth = useAuthStore();
  if (to.meta.public) {
    if (to.name === 'login' && auth.isAuthenticated) return { name: 'schedule' };
    return true;
  }
  if (!auth.isAuthenticated) return { name: 'login' };
  /**
   * 开发者页（需求 10）只在开发者模式开启时可进：侧栏项本身也是条件显示的，
   * 但配置可能是在**停留在这个页面时**被关掉的（「通用」页的开关），
   * 所以需要这条守卫把它弹回「通用」，不让用户在看一个"已经不该存在"的页面。
   *
   * 这里读的是 ui store 里的状态（由 `ui.init()` 在首屏前从主进程配置恢复），
   * 不额外调 `window.desktop.getConfig()` —— 导航守卫是同步高频路径，
   * 每次跳转都跨一次 contextBridge 不值得。
   */
  if (to.name === 'settings-developer' && !useUiStore().developerMode) return { name: 'settings-general' };
  return true;
});

export default router;
