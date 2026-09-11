import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { STORAGE_KEYS, type LoginResponse, type StudentDto } from '@classhelper/shared';
import { authApi } from '../api/index.js';
import { setApiBaseUrl, setTokenProvider } from '../api/http.js';
import { cacheGet, cacheSet } from '../cache/db.js';
import { normalizeServerUrl } from '../config.js';

const PROFILE_KEY = 'me';

/**
 * 登录态。
 * token 通过 IPC 交给主进程用 safeStorage 加密落盘，刷新/重启后可直接离线进入；
 * 用户资料同时写入 IndexedDB，断网时也能显示姓名与班级。
 */
export const useAuthStore = defineStore('auth', () => {
  const token = ref<string | null>(null);
  const user = ref<StudentDto | null>(null);
  const loading = ref(false);
  const offlineSession = ref(false);

  const isAuthenticated = computed(() => Boolean(token.value));
  const displayName = computed(() => user.value?.name ?? '未登录');
  const classId = computed(() => user.value?.classId ?? null);

  setTokenProvider(() => token.value);

  function applyToken(next: string | null): void {
    token.value = next;
    setTokenProvider(() => token.value);
  }

  async function persistSession(
    serverUrl: string,
    username: string,
    nextToken: string | null,
  ): Promise<void> {
    if (!window.desktop) return;
    await window.desktop.saveConfig({ serverUrl, username, token: nextToken });
  }

  /** 登录：写主进程配置 + 缓存资料 */
  async function login(serverUrl: string, username: string, password: string): Promise<void> {
    const normalized = normalizeServerUrl(serverUrl);
    if (!normalized) throw new Error('服务器地址格式不正确，例如 http://127.0.0.1:4000');

    setApiBaseUrl(normalized);
    loading.value = true;
    try {
      const payload: LoginResponse = await authApi.login({ username, password });
      applyToken(payload.token);
      user.value = payload.user as StudentDto;
      offlineSession.value = false;
      await cacheSet('profile', PROFILE_KEY, user.value);
      await persistSession(normalized, username, payload.token);
    } finally {
      loading.value = false;
    }
  }

  /**
   * 启动恢复：先用缓存资料立即渲染，再尝试向服务器刷新。
   * 服务器不可达时保持离线会话（可查看缓存数据）。
   */
  async function restore(): Promise<{ serverUrl: string; username: string }> {
    let serverUrl = '';
    let username = '';
    if (window.desktop) {
      const config = await window.desktop.getConfig();
      serverUrl = config.serverUrl;
      username = config.username;
      applyToken(config.token);
    }
    if (serverUrl) setApiBaseUrl(serverUrl);
    if (!serverUrl) {
      const fallback = localStorage.getItem(STORAGE_KEYS.serverUrl);
      if (fallback) {
        serverUrl = fallback;
        setApiBaseUrl(fallback);
      }
    }

    const cachedProfile = await cacheGet<StudentDto>('profile', PROFILE_KEY).catch(() => null);
    if (cachedProfile) user.value = cachedProfile.value;

    // 服务器刷新放到后台，绝不阻塞启动：离线时也能立刻进入界面看缓存数据
    if (token.value) void refreshProfile();

    return { serverUrl, username };
  }

  /** 后台刷新个人资料；服务器不可达时保持缓存资料与离线会话标记 */
  async function refreshProfile(): Promise<void> {
    if (!token.value) return;
    try {
      const profile = await authApi.me();
      user.value = profile;
      offlineSession.value = false;
      await cacheSet('profile', PROFILE_KEY, profile);
    } catch {
      offlineSession.value = Boolean(user.value);
    }
  }

  async function logout(): Promise<void> {
    try {
      if (token.value) await authApi.logout();
    } catch {
      // 离线退出忽略错误
    }
    applyToken(null);
    user.value = null;
    offlineSession.value = false;
    if (window.desktop) await window.desktop.saveConfig({ token: null });
  }

  return {
    token,
    user,
    loading,
    offlineSession,
    isAuthenticated,
    displayName,
    classId,
    login,
    restore,
    refreshProfile,
    logout,
    applyToken,
  };
});
