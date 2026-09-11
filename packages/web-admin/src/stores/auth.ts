import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { STORAGE_KEYS, type LoginRequest, type LoginResponse, type StudentDto } from '@classhelper/shared';
import { authApi } from '@/api';

function readStoredUser(): StudentDto | null {
  const raw = localStorage.getItem(STORAGE_KEYS.user);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StudentDto;
  } catch {
    return null;
  }
}

export const useAuthStore = defineStore('auth', () => {
  const token = ref<string | null>(localStorage.getItem(STORAGE_KEYS.token));
  const user = ref<StudentDto | null>(readStoredUser());
  const loading = ref(false);

  const isAuthenticated = computed(() => Boolean(token.value));
  const role = computed(() => user.value?.role ?? null);
  const isStaff = computed(() => role.value === 'ADMIN' || role.value === 'TEACHER');
  const displayName = computed(() => user.value?.name ?? '未登录');
  const roleLabel = computed(() => {
    if (role.value === 'ADMIN') return '管理员';
    if (role.value === 'TEACHER') return '教师';
    return '学生';
  });

  function persist(): void {
    if (token.value) localStorage.setItem(STORAGE_KEYS.token, token.value);
    else localStorage.removeItem(STORAGE_KEYS.token);
    if (user.value) localStorage.setItem(STORAGE_KEYS.user, JSON.stringify(user.value));
    else localStorage.removeItem(STORAGE_KEYS.user);
  }

  function setSession(payload: LoginResponse): void {
    token.value = payload.token;
    user.value = { ...payload.user } as StudentDto;
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
    role,
    displayName,
    roleLabel,
    login,
    logout,
    fetchProfile,
    clear,
  };
});
