import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';

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
      {
        path: 'settings',
        name: 'settings',
        component: () => import('../views/SettingsView.vue'),
        meta: { title: '设置' },
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
  return true;
});

export default router;
