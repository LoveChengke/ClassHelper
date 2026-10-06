import { ref } from 'vue';
import { defineStore } from 'pinia';

/**
 * 界面偏好（当前只有主题）。
 *
 * 机制与桌面客户端（`desktop-client/src/renderer/stores/ui.ts`）保持一套：
 * 深色主题 = 在 `<html>` 上挂 `.dark` 类，由 `styles/index.css` 的 `html.dark` 块
 * 覆盖语义色令牌，Element Plus 的 `dark/css-vars.css`（main.ts 引入）提供 `--el-*` 的深色默认。
 *
 * **没有选过时跟随系统**，且系统切换时会实时跟上；一旦用户手动点过切换按钮，
 * 就以用户的选择为准，不再被系统改回去（这是主题开关的通行语义：
 * 系统的偏好是默认值，不是命令）。
 */

export type AdminTheme = 'light' | 'dark';

const THEME_KEY = 'classhelper.admin.theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(DARK_QUERY).matches;
}

/**
 * 把主题落到 DOM 上。三件事一件都不能少：
 *  1. `html.dark` —— 主题令牌的开关；
 *  2. `color-scheme` —— 让**原生控件**（滚动条、`<input type=date>` 的弹层、自动填充底色）
 *     也跟着变。只改 CSS 变量的话，滚动条和日期选择器在深色下仍是刺眼的浅色；
 *  3. PWA 的 `theme-color` —— 手机端地址栏 / 状态栏的配色，装成应用后尤其明显。
 */
function applyTheme(theme: AdminTheme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.style.colorScheme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', theme === 'dark' ? '#14161a' : '#409eff');
}

function readStored(): AdminTheme | null {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    return raw === 'dark' || raw === 'light' ? raw : null;
  } catch {
    return null;
  }
}

export const useUiStore = defineStore('ui', () => {
  const theme = ref<AdminTheme>('light');

  /** 用户是否显式选过。没选过时系统偏好说了算，且会实时跟随 */
  let explicit = false;

  /**
   * 在 `app.mount()` **之前**调用：主题类要在首帧之前挂好，
   * 否则深色用户会看到"先白后黑"闪一下（与客户端同一条要求）。
   */
  function init(): void {
    const stored = readStored();
    explicit = stored !== null;
    theme.value = stored ?? (systemPrefersDark() ? 'dark' : 'light');
    applyTheme(theme.value);

    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      const query = window.matchMedia(DARK_QUERY);
      const onChange = (): void => {
        if (explicit) return;
        theme.value = query.matches ? 'dark' : 'light';
        applyTheme(theme.value);
      };
      if (typeof query.addEventListener === 'function') query.addEventListener('change', onChange);
      else if (typeof query.addListener === 'function') query.addListener(onChange);
    }
  }

  function setTheme(next: AdminTheme): void {
    explicit = true;
    theme.value = next;
    applyTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // 隐私模式下写不进去：本次会话内仍然生效
    }
  }

  function toggleTheme(): void {
    setTheme(theme.value === 'dark' ? 'light' : 'dark');
  }

  return { theme, init, setTheme, toggleTheme };
});
