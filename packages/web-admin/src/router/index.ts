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
        meta: { title: '班级管理', icon: 'School', roles: ['ADMIN'] },
      },
      {
        path: 'students',
        name: 'students',
        component: () => import('@/views/StudentsView.vue'),
        meta: { title: '学生管理', icon: 'User', roles: ['ADMIN'] },
      },
      {
        path: 'teachers',
        name: 'teachers',
        component: () => import('@/views/TeachersView.vue'),
        meta: { title: '教师管理', icon: 'UserFilled', roles: ['ADMIN'] },
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
      {
        path: 'integrations',
        name: 'integrations',
        component: () => import('@/views/IntegrationsView.vue'),
        // 与后端 requireRole('ADMIN','TEACHER') 对齐：学生角色不该看到这一页
        meta: { title: 'ClassIsland 联动', icon: 'Connection', roles: ['ADMIN', 'TEACHER'] },
      },
      {
        path: 'database',
        name: 'database',
        component: () => import('@/views/DatabaseView.vue'),
        // 与后端 requireRole('ADMIN') 对齐：改动数据库是最高危操作，仅管理员
        meta: { title: '数据库管理', icon: 'Coin', roles: ['ADMIN'] },
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

/** 读取已保存的登录用户角色（路由守卫用；未登录/解析失败返回 null） */
function storedRole(): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.user);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { role?: string };
    return parsed?.role ?? null;
  } catch {
    return null;
  }
}

router.beforeEach((to) => {
  const token = localStorage.getItem(STORAGE_KEYS.token);
  if (to.meta.public) {
    if (to.name === 'login' && token) return { name: 'dashboard' };
    return true;
  }
  if (!token) {
    return { name: 'login', query: { redirect: to.fullPath } };
  }
  // 仅管理员可见的页面（班级/学生/教师管理）：直接输网址也要挡回去，
  // 不能依赖"菜单隐藏"——菜单隐藏只是看不见，不是权限。
  const roles = to.meta.roles;
  if (Array.isArray(roles) && roles.length > 0) {
    const role = storedRole();
    if (!role || !(roles as string[]).includes(role)) {
      return { name: 'dashboard' };
    }
  }
  return true;
});

router.afterEach((to) => {
  const title = typeof to.meta.title === 'string' ? to.meta.title : '';
  document.title = title ? `${title} · 班级小助手` : '班级小助手 · 管理端';
});

export default router;
