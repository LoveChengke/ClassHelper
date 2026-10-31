import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import {
  ROLE_LABELS,
  PERMISSION_META,
  STORAGE_KEYS,
  hasPermission,
  type LoginRequest,
  type LoginResponse,
  type PermissionKey,
  type SessionUser,
} from '@classhelper/shared';
import { authApi, permissionApi } from '@/api';
import type { MenuAction } from '@/config/navigation';

/**
 * 会话主体。
 *
 * 学生**不是账号**（只是 `Student` 名单记录，不能登录），所以 Web 管理端里
 * 只可能是 `ADMIN` / `TEACHER`；`CLASS_DEVICE` 是教室机器上的 ClassHelper 班级端，
 * 它走桌面客户端，不会出现在这里 —— 类型仍然带上它，是为了与后端契约一致。
 */
function readStoredUser(): SessionUser | null {
  const raw = localStorage.getItem(STORAGE_KEYS.user);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionUser;
  } catch {
    return null;
  }
}

export const useAuthStore = defineStore('auth', () => {
  const token = ref<string | null>(localStorage.getItem(STORAGE_KEYS.token));
  const user = ref<SessionUser | null>(readStoredUser());
  const loading = ref(false);

  /**
   * 当前账号的**生效权限**（`GET /api/permissions/me`）。
   *
   * 只用来决定"入口显不显示"，**不是**另一套权限规则（AGENTS.md 的现行工程约定）——
   * 真正的拦截始终在服务端。页面刷新后这里是空的，由 `AdminLayout` 挂载时调
   * {@link ensurePermissions} 补上。
   */
  const permissions = ref<PermissionKey[]>([]);
  /** 生效权限是否来自显式分组；没有显式分组时使用可编辑的角色默认组。 */
  const permissionsFromGroups = ref(false);
  const permissionsLoaded = ref(false);
  const classScopes = ref<Partial<Record<PermissionKey, string[]>>>({});
  const manageScopes = ref<Partial<Record<PermissionKey, string[]>>>({});
  const actionScopes = ref<Partial<Record<PermissionKey, string[]>>>({});
  const allScopeKeys = ref<PermissionKey[]>([]);
  function canForClass(key: PermissionKey, classId: string | null | undefined): boolean {
    return (
      can(key) &&
      (classId ? (classScopes.value[key] ?? []).includes(classId) : allScopeKeys.value.includes(key))
    );
  }
  function canManageClass(key: PermissionKey, classId: string | null | undefined): boolean {
    return (
      can(key) &&
      (classId
        ? (manageScopes.value[key] ?? classScopes.value[key] ?? []).includes(classId)
        : allScopeKeys.value.includes(key))
    );
  }
  function canShowMenu(permission: PermissionKey | undefined, actions?: readonly MenuAction[]): boolean {
    if (permission && !can(permission)) return false;
    if (!actions) return true;
    return actions.some((action) => {
      const key = typeof action === 'string' ? action : action.key;
      if (!can(key)) return false;
      if (
        (typeof action !== 'string' && action.scope === 'permission') ||
        PERMISSION_META[key].kind !== 'class'
      )
        return true;
      const ids =
        typeof action !== 'string' && action.scope === 'manage'
          ? (manageScopes.value[key] ?? [])
          : (actionScopes.value[key] ?? []);
      // 全校名单维护还允许新建未分班学生。
      if (
        key === 'roster:manage' &&
        allScopeKeys.value.includes(key) &&
        (!permission || allScopeKeys.value.includes(permission))
      )
        return true;
      return ids.some(
        (id) =>
          !permission ||
          PERMISSION_META[permission].kind !== 'class' ||
          (classScopes.value[permission] ?? []).includes(id),
      );
    });
  }

  const isAuthenticated = computed(() => Boolean(token.value));
  const role = computed(() => user.value?.role ?? null);
  const isAdmin = computed(() => role.value === 'ADMIN');
  const displayName = computed(() => user.value?.name ?? '未登录');
  const roleLabel = computed(() => (role.value ? ROLE_LABELS[role.value] : '未登录'));

  /**
   * 是否有某个生效权限。
   *
   * 页面直接使用服务端生效集合；管理员全集也由服务端返回。
   */
  function can(key: PermissionKey): boolean {
    return hasPermission(permissions.value, key);
  }

  /**
   * 拉取生效权限（幂等，`force` 用于权限改完之后刷新）。
   *
   * 失败**不抛出**：拿不到权限时 `can()` 保持 false（即"少显示几个入口"），
   * 不要因此卡住路由或让整页渲染不出来；错误提示由 http.ts 的响应拦截器负责。
   */
  async function ensurePermissions(force = false): Promise<void> {
    if (!token.value) return;
    if (permissionsLoaded.value && !force) return;
    try {
      const mine = await permissionApi.me();
      permissions.value = mine.permissions;
      classScopes.value = mine.classScopes ?? {};
      manageScopes.value = mine.manageScopes ?? {};
      actionScopes.value = mine.actionScopes ?? {};
      allScopeKeys.value = mine.allScopeKeys ?? [];
      permissionsFromGroups.value = mine.fromGroups;
      permissionsLoaded.value = true;
    } catch {
      // 见上方注释：静默失败，保持"未加载"（下次调用还会重试）
    }
  }

  /** 清掉权限缓存（换账号 / 退出登录时必须调用，否则会沿用上一个账号的权限） */
  function resetPermissions(): void {
    permissions.value = [];
    classScopes.value = {};
    manageScopes.value = {};
    actionScopes.value = {};
    allScopeKeys.value = [];
    permissionsFromGroups.value = false;
    permissionsLoaded.value = false;
  }

  function persist(): void {
    if (token.value) localStorage.setItem(STORAGE_KEYS.token, token.value);
    else localStorage.removeItem(STORAGE_KEYS.token);
    if (user.value) localStorage.setItem(STORAGE_KEYS.user, JSON.stringify(user.value));
    else localStorage.removeItem(STORAGE_KEYS.user);
  }

  function setSession(payload: LoginResponse): void {
    resetPermissions();
    token.value = payload.token;
    user.value = { ...payload.user };
    persist();
  }

  async function login(payload: LoginRequest): Promise<void> {
    loading.value = true;
    try {
      setSession(await authApi.login(payload));
    } finally {
      loading.value = false;
    }
  }

  async function fetchProfile(): Promise<void> {
    if (!token.value) return;
    user.value = await authApi.me();
    persist();
  }

  async function logout(): Promise<void> {
    try {
      if (token.value) await authApi.logout();
    } catch {
      // 退出登录失败不阻塞本地清理
    } finally {
      clear();
    }
  }

  function clear(): void {
    token.value = null;
    user.value = null;
    resetPermissions();
    persist();
  }

  return {
    token,
    user,
    loading,
    permissions,
    permissionsFromGroups,
    permissionsLoaded,
    isAuthenticated,
    isAdmin,
    role,
    displayName,
    roleLabel,
    can,
    canForClass,
    canManageClass,
    canShowMenu,
    ensurePermissions,
    login,
    logout,
    fetchProfile,
    clear,
  };
});
