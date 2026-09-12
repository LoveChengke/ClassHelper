import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { STORAGE_KEYS, type LoginResponse, type SessionUser } from '@classhelper/shared';
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
  const user = ref<SessionUser | null>(null);
  const loading = ref(false);
  const offlineSession = ref(false);

  const isAuthenticated = computed(() => Boolean(token.value));
  const displayName = computed(() => user.value?.name ?? '未登录');
  const classId = computed(() => user.value?.classId ?? null);
  /** true 表示当前是「班级账号（班级设备）」会话：个人数据按全班读写 */
  const isClassSession = computed(() => user.value?.classSession === true);
  /** 班级码（登录账号，便于设置页展示） */
  const classCode = computed(() => user.value?.classCode ?? '');

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

  /**
   * 班级账号登录（学生端主入口）：班级码 + 班级密码。
   *
   * 需求 1：学生端以「班级」为主体，个人学生不再是登录主体；
   * 服务端据此把作业完成 / 通知已读等个人数据按"全班"范围读写。
   * 保存的 username 字段记录班级码，便于下次预填。
   */
  async function login(serverUrl: string, code: string, password: string): Promise<void> {
    const normalized = normalizeServerUrl(serverUrl);
    if (!normalized) throw new Error('服务器地址格式不正确，例如 http://127.0.0.1:4000');

    setApiBaseUrl(normalized);
    loading.value = true;
    try {
      const payload: LoginResponse = await authApi.classLogin({ code, password });
      applyToken(payload.token);
      user.value = payload.user;
      offlineSession.value = false;
      await cacheSet('profile', PROFILE_KEY, user.value);
      await persistSession(normalized, code, payload.token);
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

    const cachedProfile = await cacheGet<SessionUser>('profile', PROFILE_KEY).catch(() => null);
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
    isClassSession,
    classCode,
    login,
    restore,
    refreshProfile,
    logout,
    applyToken,
  };
});
