import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { STORAGE_KEYS, type PermissionKey } from '@classhelper/shared';
import { useAuthStore } from '@/stores/auth';

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
        path: 'courseware',
        name: 'courseware',
        component: () => import('@/views/CoursewareView.vue'),
        meta: {
          title: '课件',
          icon: 'FolderOpened',
          permission: 'courseware:read',
          menuActions: [{ key: 'courseware:write', scope: 'permission' }],
        },
      },
      {
        path: 'plan-editor',
        name: 'plan-editor',
        component: () => import('@/views/PlanEditorView.vue'),
        meta: {
          title: '课表档案',
          icon: 'Calendar',
          permission: 'schedule:read',
          menuActions: ['schedule:write', 'timetable:manage'],
        },
      },
      {
        path: 'roster',
        redirect: (to) => ({ path: '/students', query: to.query, hash: to.hash }),
      },
      {
        path: 'system-settings',
        name: 'system-settings',
        component: () => import('@/views/SystemSettingsView.vue'),
        meta: { title: '系统设置', icon: 'Setting', permission: 'system:manage' },
      },
      {
        path: 'dashboard',
        name: 'dashboard',
        component: () => import('@/views/DashboardView.vue'),
        meta: { title: '仪表盘', icon: 'Odometer', permission: 'dashboard:read' },
      },
      {
        path: 'classes',
        name: 'classes',
        component: () => import('@/views/ClassesView.vue'),
        meta: {
          title: '班级管理',
          icon: 'School',
          permission: 'class:read',
          menuActions: [
            'class:manage',
            'class:account',
            'class:settings',
            'roster:manage',
            'schedule:write',
            { key: 'grade:write', scope: 'manage' },
          ],
        },
      },
      {
        path: 'students',
        name: 'students',
        component: () => import('@/views/StudentsView.vue'),
        meta: {
          title: '学生管理',
          icon: 'User',
          permission: 'roster:read',
          menuActions: ['roster:manage', 'call:create'],
        },
      },
      {
        path: 'teachers',
        name: 'teachers',
        component: () => import('@/views/TeachersView.vue'),
        meta: { title: '教师管理', icon: 'UserFilled', permission: 'teacher:manage' },
      },
      {
        path: 'term-weeks',
        name: 'term-weeks',
        component: () => import('@/views/TermWeeksView.vue'),
        // 改周次会让全校/某班的课表口径整体变化，与「班级管理」同一档权限
        meta: {
          title: '学期周次',
          icon: 'Calendar',
          permission: 'term:read',
          menuActions: ['term:write', 'class:settings'],
        },
      },
      {
        path: 'promotion',
        name: 'promotion',
        component: () => import('@/views/PromotionView.vue'),
        meta: { title: '学年升级', icon: 'Calendar', permission: 'promotion:manage' },
      },
      {
        path: 'archives',
        name: 'archives',
        component: () => import('@/views/ArchivesView.vue'),
        // 毕业归档会改动整届班级与学生的状态，与「班级管理」同一档权限
        meta: { title: '毕业归档', icon: 'FolderOpened', permission: 'archive:manage' },
      },
      {
        path: 'schedules',
        name: 'schedules',
        redirect: '/plan-editor',
        meta: { title: '课表管理', icon: 'Calendar', permission: 'schedule:read' },
      },
      {
        path: 'homeworks',
        name: 'homeworks',
        component: () => import('@/views/HomeworksView.vue'),
        meta: {
          title: '作业发布',
          icon: 'Notebook',
          permission: 'homework:read',
          menuActions: ['homework:write'],
        },
      },
      {
        path: 'notifications',
        name: 'notifications',
        component: () => import('@/views/NotificationsView.vue'),
        meta: {
          title: '通知发布',
          icon: 'Bell',
          permission: 'notification:read',
          menuActions: ['notification:publish', 'notification:delete', 'call:create'],
        },
      },
      {
        path: 'grades',
        name: 'grades',
        component: () => import('@/views/GradesView.vue'),
        meta: {
          title: '成绩录入',
          icon: 'Trophy',
          permission: 'grade:read',
          menuActions: ['grade:write', 'grade:import'],
        },
      },
      {
        path: 'assistant',
        name: 'assistant',
        component: () => import('@/views/AssistantView.vue'),
        // 按**生效权限**门控（教师默认就有 ai:use，见 shared/permissions.ts 的默认模板）：
        // 管理员把 ai:use 从某个权限组收回后，这一页同时从菜单与路由上消失
        meta: { title: 'AI 助手', icon: 'MagicStick', permission: 'ai:use', menuActions: ['ai:use'] },
      },
      {
        path: 'ai-settings',
        name: 'ai-settings',
        component: () => import('@/views/AiSettingsView.vue'),
        // 与后端 requirePermission('ai:manage') 对齐：这一页能改密钥与开关，默认仅管理员
        meta: { title: '大模型设置', icon: 'Setting', permission: 'ai:manage' },
      },
      {
        path: 'database',
        name: 'database',
        component: () => import('@/views/DatabaseView.vue'),
        // 与后端 requireRole('ADMIN') 对齐：改动数据库是最高危操作，仅管理员
        meta: { title: '数据库管理', icon: 'Coin', permission: 'database:manage' },
      },
      {
        path: 'permissions',
        name: 'permissions',
        component: () => import('@/views/PermissionsView.vue'),
        // 管理员专用能力不可下放，菜单与路由仍统一按服务端能力集合过滤。
        meta: { title: '权限与范围', icon: 'Lock', permission: 'permission:manage' },
      },
      {
        path: 'clients',
        name: 'clients',
        component: () => import('@/views/ClientsView.vue'),
        meta: {
          title: '客户端',
          icon: 'Monitor',
          permission: 'client:read',
          menuActions: ['client:manage', 'client:update-push', 'remote:control', 'client:update'],
        },
      },
      { path: 'client-devices', redirect: '/clients' },
    ],
  },
  {
    path: '/no-access',
    name: 'no-access',
    component: () => import('@/views/NoAccessView.vue'),
    meta: { title: '暂无功能授权' },
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

router.beforeEach(async (to) => {
  const token = localStorage.getItem(STORAGE_KEYS.token);
  if (to.meta.public) {
    if (to.name === 'login' && token) return { name: 'dashboard' };
    return true;
  }
  if (!token) {
    return { name: 'login', query: { redirect: to.fullPath } };
  }
  const permission = to.meta.permission;
  if (typeof permission === 'string') {
    const auth = useAuthStore();
    await auth.ensurePermissions();
    if (!auth.can(permission as PermissionKey)) {
      if (auth.can('dashboard:read')) return { name: 'dashboard' };
      const fallback = router
        .getRoutes()
        .find(
          (r) =>
            r.name &&
            typeof r.meta.permission === 'string' &&
            auth.canShowMenu(r.meta.permission, r.meta.menuActions),
        );
      return fallback ? { name: fallback.name! } : { name: 'no-access' };
    }
  }
  return true;
});

router.afterEach((to) => {
  const title = typeof to.meta.title === 'string' ? to.meta.title : '';
  document.title = title ? `${title} · ClassHelper` : 'ClassHelper · 管理端';
});

export default router;
