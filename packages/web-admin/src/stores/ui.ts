import { ref } from 'vue';
import { defineStore } from 'pinia';

/**
 * 界面偏好（主题 / 侧栏折叠 / 关怀模式）。
 *
 * 机制与桌面客户端（`desktop-client/src/renderer/stores/ui.ts`）保持一套：
 * 深色主题 = 在 `<html>` 上挂 `.dark` 类，由 `styles/index.css` 的 `html.dark` 块
 * 覆盖语义色令牌，Element Plus 的 `dark/css-vars.css`（main.ts 引入）提供 `--el-*` 的深色默认。
 *
 * **没有选过时跟随系统**，且系统切换时会实时跟上；一旦用户手动点过切换按钮，
 * 就以用户的选择为准，不再被系统改回去（这是主题开关的通行语义：
 * 系统的偏好是默认值，不是命令）。
 *
 * 三份偏好都存 localStorage；折叠与关怀模式**必须在 `app.mount()` 之前恢复**，
 * 否则首帧会先按默认值画一遍再跳变（深色主题"先白后黑"是同一个道理）。
 */

export type AdminTheme = 'light' | 'dark';

const THEME_KEY = 'classhelper.admin.theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

/** 侧栏折叠（图标导轨） */
const SIDEBAR_KEY = 'classhelper.admin.sidebarCollapsed';
/** 关怀模式开关 */
const CARE_KEY = 'classhelper.admin.careMode';
/** 关怀模式的放大倍数 */
const CARE_SCALE_KEY = 'classhelper.admin.careScale';

/** 关怀模式放大倍数的可调范围（界面上的滑块与这里必须一致） */
export const CARE_SCALE_MIN = 1;
export const CARE_SCALE_MAX = 1.5;
/** 打开关怀模式时的默认倍数：14px → 16.8px，够大又不会撑破表格 */
export const CARE_SCALE_DEFAULT = 1.2;

function clampCareScale(value: number): number {
  if (!Number.isFinite(value)) return CARE_SCALE_DEFAULT;
  return Math.min(CARE_SCALE_MAX, Math.max(CARE_SCALE_MIN, Math.round(value * 100) / 100));
}

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

/** 读一个布尔偏好（localStorage 不可用时一律按"没选过"处理） */
function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // 隐私模式下写不进去：本次会话内仍然生效
  }
}

function readScale(): number {
  try {
    const raw = localStorage.getItem(CARE_SCALE_KEY);
    return raw === null ? CARE_SCALE_DEFAULT : clampCareScale(Number(raw));
  } catch {
    return CARE_SCALE_DEFAULT;
  }
}

/**
 * 把关怀模式落到 DOM：一个类名 + 一个倍数。
 *
 * 类名（`html.care-mode`）是 `styles/index.css` 里**唯一**的放大块开关；
 * 倍数写进 `--ch-font-scale`，那块里的所有 `calc(基准 * var(--ch-font-scale))` 都读它。
 * 关掉时倍数复位成 1（而不是删掉变量）——变量留着，`calc()` 才不会解析失败。
 */
function applyCareMode(enabled: boolean, scale: number): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.toggle('care-mode', enabled);
  root.style.setProperty('--ch-font-scale', String(enabled ? clampCareScale(scale) : 1));
}

export const useUiStore = defineStore('ui', () => {
  const theme = ref<AdminTheme>('light');
  /** 侧栏折叠成图标导轨（桌面端；≤768px 走抽屉，不看这个值） */
  const sidebarCollapsed = ref(false);
  /** 关怀模式：放大正文字号与控件 */
  const careMode = ref(false);
  /** 关怀模式的放大倍数（1.0~1.5） */
  const careScale = ref(CARE_SCALE_DEFAULT);

  /** 用户是否显式选过。没选过时系统偏好说了算，且会实时跟随 */
  let explicit = false;

  /**
   * 在 `app.mount()` **之前**调用：主题类、折叠状态、关怀模式都要在首帧之前落好，
   * 否则深色用户会看到"先白后黑"、折叠用户会看到侧栏先展开再收回（与客户端同一条要求）。
   */
  function init(): void {
    const stored = readStored();
    explicit = stored !== null;
    theme.value = stored ?? (systemPrefersDark() ? 'dark' : 'light');
    applyTheme(theme.value);

    // 折叠状态只需要恢复 ref：`el-aside` 的宽度是绑在 ref 上的，首帧就是折好的宽度
    sidebarCollapsed.value = readFlag(SIDEBAR_KEY);

    // 关怀模式要落到 DOM（html 的类名 + 倍数变量），否则还会按默认字号画一帧
    careScale.value = readScale();
    careMode.value = readFlag(CARE_KEY);
    applyCareMode(careMode.value, careScale.value);

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

  /** 折叠/展开侧栏（顶栏汉堡按钮），写回 localStorage */
  function setSidebarCollapsed(collapsed: boolean): void {
    sidebarCollapsed.value = collapsed;
    writeFlag(SIDEBAR_KEY, collapsed);
  }

  function toggleSidebar(): void {
    setSidebarCollapsed(!sidebarCollapsed.value);
  }

  /** 关怀模式开关（顶栏「关怀模式」气泡里的滑块与开关共用） */
  function setCareMode(enabled: boolean): void {
    careMode.value = enabled;
    writeFlag(CARE_KEY, enabled);
    applyCareMode(enabled, careScale.value);
  }

  /**
   * 调整放大倍数。倍数在**关掉关怀模式时也记下来** ——
   * 下次打开还要用上次调好的那档，否则每次都要重新拖一遍。
   */
  function setCareScale(scale: number): void {
    careScale.value = clampCareScale(scale);
    try {
      localStorage.setItem(CARE_SCALE_KEY, String(careScale.value));
    } catch {
      // 同上：写不进去只影响下次启动
    }
    applyCareMode(careMode.value, careScale.value);
  }

  return {
    theme,
    sidebarCollapsed,
    careMode,
    careScale,
    init,
    setTheme,
    toggleTheme,
    setSidebarCollapsed,
    toggleSidebar,
    setCareMode,
    setCareScale,
  };
});
