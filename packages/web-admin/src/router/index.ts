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
        path: 'term-weeks',
        name: 'term-weeks',
        component: () => import('@/views/TermWeeksView.vue'),
        // 改周次会让全校/某班的课表口径整体变化，与「班级管理」同一档权限
        meta: { title: '学期周次', icon: 'Calendar', roles: ['ADMIN'] },
      },
      {
        path: 'archives',
        name: 'archives',
        component: () => import('@/views/ArchivesView.vue'),
        // 毕业归档会改动整届班级与学生的状态，与「班级管理」同一档权限
        meta: { title: '毕业归档', icon: 'FolderOpened', roles: ['ADMIN'] },
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
        path: 'assistant',
        name: 'assistant',
        component: () => import('@/views/AssistantView.vue'),
        // 按**生效权限**门控（教师默认就有 ai:use，见 shared/permissions.ts 的默认模板）：
        // 管理员把 ai:use 从某个权限组收回后，这一页同时从菜单与路由上消失
        meta: { title: 'AI 助手', icon: 'MagicStick', permission: 'ai:use' },
      },
      {
        path: 'integrations',
        name: 'integrations',
        component: () => import('@/views/IntegrationsView.vue'),
        // **已从侧栏摘掉**（2026-10-11 合并进「客户端」）：设备管理与课表下发都搬到那一页了，
        // 这里只保留少数还没搬过去的东西（提醒下发、联动步骤说明），从「客户端 → 详情」进。
        // 路由留着而不是删掉，是为了不把功能一起丢掉；`meta.hidden` 让侧栏不显示它。
        meta: { title: 'ClassIsland 联动（旧）', icon: 'Connection', roles: ['ADMIN', 'TEACHER'], hidden: true },
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
        meta: { title: '数据库管理', icon: 'Coin', roles: ['ADMIN'] },
      },
      {
        path: 'permissions',
        name: 'permissions',
        component: () => import('@/views/PermissionsView.vue'),
        // 这一页**按生效权限**门控而不是按角色：教师被某个权限组授予 permission:manage 后同样可用，
        // 与后端 requirePermission('permission:manage') 对齐（详见下方守卫）
        meta: { title: '权限组管理', icon: 'Lock', permission: 'permission:manage' },
      },
      {
        path: 'clients',
        name: 'clients',
        component: () => import('@/views/ClientHubView.vue'),
        // 「客户端」= 原来的「ClassIsland 联动」+「客户端设备」合并后的一页（2026-10-11）：
        // 一个班一张卡片，两条链路的状态放在一起，勾选可批量下发课表 / 更新，点卡片进详情。
        //
        // 门控与侧栏菜单保持一致：`classisland:notify`（默认 ADMIN + TEACHER）——
        // 这一页同时承载「向教室下发提醒」，教师要用；设备管理类按钮在页内按
        // device:manage / client:update-push / remote:control 各自显示或禁用，
        // 与后端三个接口的权限一一对应（前端隐藏不等于权限）。
        meta: { title: '客户端', icon: 'Monitor', permission: 'classisland:notify' },
      },
      {
        path: 'client-devices',
        name: 'client-devices',
        component: () => import('@/views/ClientsView.vue'),
        // **已从侧栏摘掉**（2026-10-11 合并进「客户端」）：设备清单、远控、下发更新都在新页里，
        // 这里只留新版还没搬过去的部分（客户端安装包缓存管理 —— 不先把包拉下来，就没有版本可下发）。
        // 从「客户端 → 详情 → 安装包与设备记录」进。
        meta: { title: '安装包与设备记录', icon: 'Monitor', permission: 'client:manage', hidden: true },
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

router.beforeEach(async (to) => {
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
  // 按**生效权限**门控的页面（权限组管理）：角色判不出来 —— 教师被权限组授予
  // permission:manage 后同样该放行，所以这里异步取一次生效权限。
  // `ensurePermissions()` 在 store 内是幂等的（本次会话只真拉一次），不会每次跳转都打接口。
  const permission = to.meta.permission;
  if (typeof permission === 'string') {
    const auth = useAuthStore();
    await auth.ensurePermissions();
    if (!auth.can(permission as PermissionKey)) return { name: 'dashboard' };
  }
  return true;
});

router.afterEach((to) => {
  const title = typeof to.meta.title === 'string' ? to.meta.title : '';
  document.title = title ? `${title} · ClassHelper` : 'ClassHelper · 管理端';
});

export default router;
