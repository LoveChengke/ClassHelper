import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { STORAGE_KEYS } from '@classhelper/shared';

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/LoginView.vue'),
    meta: { public: true, title: '登录' },
  },
  {
    path: '/',
    component: () => import('@/layouts/AdminLayout.vue'),
    redirect: '/dashboard',
    children: [
      {
        path: 'dashboard',
        name: 'dashboard',
        component: () => import('@/views/DashboardView.vue'),
        meta: { title: '仪表盘', icon: 'Odometer' },
      },
      {
        path: 'classes',
        name: 'classes',
        component: () => import('@/views/ClassesView.vue'),
        meta: { title: '班级管理', icon: 'School' },
      },
      {
        path: 'students',
        name: 'students',
        component: () => import('@/views/StudentsView.vue'),
        meta: { title: '学生管理', icon: 'User' },
      },
      {
        path: 'schedules',
        name: 'schedules',
        component: () => import('@/views/SchedulesView.vue'),
        meta: { title: '课表管理', icon: 'Calendar' },
      },
      {
        path: 'homeworks',
        name: 'homeworks',
        component: () => import('@/views/HomeworksView.vue'),
        meta: { title: '作业发布', icon: 'Notebook' },
      },
      {
        path: 'notifications',
        name: 'notifications',
        component: () => import('@/views/NotificationsView.vue'),
        meta: { title: '通知发布', icon: 'Bell' },
      },
      {
        path: 'grades',
        name: 'grades',
        component: () => import('@/views/GradesView.vue'),
        meta: { title: '成绩录入', icon: 'Trophy' },
      },
    ],
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('@/views/NotFoundView.vue'),
    meta: { public: true, title: '页面不存在' },
  },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach((to) => {
  const token = localStorage.getItem(STORAGE_KEYS.token);
  if (to.meta.public) {
    if (to.name === 'login' && token) return { name: 'dashboard' };
    return true;
  }
  if (!token) {
    return { name: 'login', query: { redirect: to.fullPath } };
  }
  return true;
});

router.afterEach((to) => {
  const title = typeof to.meta.title === 'string' ? to.meta.title : '';
  document.title = title ? `${title} · 班级小助手` : '班级小助手 · 管理端';
});

export default router;
