import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { ROLE_LABELS, STORAGE_KEYS, type LoginRequest, type LoginResponse, type SessionUser } from '@classhelper/shared';
import { authApi } from '@/api';

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

  const isAuthenticated = computed(() => Boolean(token.value));
  const role = computed(() => user.value?.role ?? null);
  const isStaff = computed(() => role.value === 'ADMIN' || role.value === 'TEACHER');
  const isAdmin = computed(() => role.value === 'ADMIN');
  const displayName = computed(() => user.value?.name ?? '未登录');
  const roleLabel = computed(() => (role.value ? ROLE_LABELS[role.value] : '未登录'));

  function persist(): void {
    if (token.value) localStorage.setItem(STORAGE_KEYS.token, token.value);
    else localStorage.removeItem(STORAGE_KEYS.token);
    if (user.value) localStorage.setItem(STORAGE_KEYS.user, JSON.stringify(user.value));
    else localStorage.removeItem(STORAGE_KEYS.user);
  }

  function setSession(payload: LoginResponse): void {
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
    persist();
  }

  return {
    token,
    user,
    loading,
    isAuthenticated,
    isStaff,
    isAdmin,
    role,
    displayName,
    roleLabel,
    login,
    logout,
    fetchProfile,
    clear,
  };
});
