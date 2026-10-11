import { ref } from 'vue';
import { defineStore } from 'pinia';
import type { DesktopStoredConfig } from '../../types/desktop.js';

/**
 * 界面偏好（主题 / 侧边栏折叠 / 关怀模式）。
 *
 * 持久化在主进程配置（DesktopStoredConfig.theme / sidebarCollapsed / careMode）里，
 * 与灵动岛外观等设置同一套落盘机制；浏览器调试（无 window.desktop）回落 localStorage。
 * 深色主题 = 在 <html> 上挂 .dark 类（Element Plus dark css-vars + styles/index.css 的
 * html.dark 品牌变量），应用主题的全部入口都必须走 setTheme，保证类名与配置同步。
 *
 * 关怀模式 = 在 <html> 上挂 .care-mode 类（styles/index.css 末尾那个集中覆盖块），
 * 只放大正文与控件字号，不动任何几何令牌 —— 理由写在那个块的注释里。
 */

const THEME_KEY = 'classhelper.theme';
const SIDEBAR_KEY = 'classhelper.sidebarCollapsed';
const CARE_MODE_KEY = 'classhelper.careMode';
const DEVELOPER_MODE_KEY = 'classhelper.developerMode';

function applyThemeClass(theme: 'light' | 'dark'): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

/**
 * 关怀模式的类名开关。**只碰这一个类**：放大规则全在 CSS 里，
 * JS 侧不逐个元素改字号（那样既漏元素又把主题与字号耦合在一起）。
 */
function applyCareModeClass(enabled: boolean): void {
  document.documentElement.classList.toggle('care-mode', enabled);
}

export const useUiStore = defineStore('ui', () => {
  const theme = ref<'light' | 'dark'>('light');
  const sidebarCollapsed = ref(false);
  const careMode = ref(false);
  /**
   * 开发者模式（需求 10）。
   *
   * 它既是主进程配置（`config.developerMode`，决定日志级别），也是**侧栏的一项** ——
   * 所以必须放在 store 里：关掉开关时「开发者」菜单项要立刻消失、路由守卫也要立刻生效，
   * 而「通用」页与 `ClientLayout.vue` 是两个不同的组件，靠各自的本地 ref 是传不过去的
   * （此前"改完设置要重启客户端才看到"多半就是这个原因）。
   */
  const developerMode = ref(false);

  /** 启动时从主进程配置恢复（App.vue 的 boot 流程里调用，早于首屏渲染） */
  async function init(): Promise<void> {
    if (window.desktop) {
      const config = await window.desktop.getConfig().catch(() => null);
      if (config) {
        theme.value = config.theme === 'dark' ? 'dark' : 'light';
        sidebarCollapsed.value = config.sidebarCollapsed === true;
        applyCareMode(config.careMode === true);
        developerMode.value = config.developerMode === true;
      }
    } else {
      theme.value = localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light';
      sidebarCollapsed.value = localStorage.getItem(SIDEBAR_KEY) === '1';
      applyCareMode(localStorage.getItem(CARE_MODE_KEY) === '1');
      developerMode.value = localStorage.getItem(DEVELOPER_MODE_KEY) === '1';
    }
    applyThemeClass(theme.value);
  }

  /** 切换主题（外观页单选 / 顶栏快捷切换共用），写回配置 */
  async function setTheme(next: 'light' | 'dark'): Promise<void> {
    theme.value = next;
    applyThemeClass(next);
    if (window.desktop) {
      await window.desktop.saveConfig({ theme: next }).catch(() => undefined);
    } else {
      localStorage.setItem(THEME_KEY, next);
    }
  }

  function toggleTheme(): void {
    void setTheme(theme.value === 'dark' ? 'light' : 'dark');
  }

  /** 主侧边栏折叠/展开（汉堡按钮），写回配置 */
  async function setSidebarCollapsed(collapsed: boolean): Promise<void> {
    sidebarCollapsed.value = collapsed;
    if (window.desktop) {
      await window.desktop.saveConfig({ sidebarCollapsed: collapsed }).catch(() => undefined);
    } else {
      localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0');
    }
  }

  function toggleSidebar(): void {
    void setSidebarCollapsed(!sidebarCollapsed.value);
  }

  /**
   * 应用关怀模式（需求 14）：只挂类名 + 记状态，**不落盘**。
   * 启动时由 `init()` 在首屏渲染前调用，所以刷新页面不会看到"先正常、后放大"的跳变。
   */
  function applyCareMode(enabled: boolean): void {
    careMode.value = enabled;
    applyCareModeClass(enabled);
  }

  /**
   * 切换关怀模式（「通用」设置页的开关）：立刻生效并写回配置。
   *
   * 注意：用户明确开启时**不放大侧栏导轨**（见 styles/index.css 的 care-mode 块），
   * 也**不做**任何 AI 助手按钮的联动 —— 本客户端目前没有助手入口，那条联动只存在于
   * Web 管理端；这里不为了"看起来对称"去造一个入口。
   */
  async function setCareMode(enabled: boolean): Promise<void> {
    applyCareMode(enabled);
    if (window.desktop) {
      await window.desktop.saveConfig({ careMode: enabled }).catch(() => undefined);
    } else {
      localStorage.setItem(CARE_MODE_KEY, enabled ? '1' : '0');
    }
  }

  /**
   * 切换开发者模式（「通用」设置页的开关）：立刻生效并写回配置。
   *
   * 打开之后有三件事同时发生，这里只负责**状态与落盘**：
   * 1. 侧栏「设置」分组里出现「开发者」项（`ClientLayout.vue` 按 `ui.developerMode` 渲染）；
   * 2. `main/index.ts` 在下次启动时把日志级别调到 debug（`logger.setVerbose`）——
   *    本次会话的日志级别**不重开**，避免开着日志复现问题时把级别改来改去；
   * 3. 「通用」页上给出"debug 级日志已开启"的提示。
   */
  async function setDeveloperMode(enabled: boolean): Promise<void> {
    developerMode.value = enabled;
    if (window.desktop) {
      await window.desktop.saveConfig({ developerMode: enabled }).catch(() => undefined);
    } else {
      localStorage.setItem(DEVELOPER_MODE_KEY, enabled ? '1' : '0');
    }
  }

  return {
    theme,
    sidebarCollapsed,
    careMode,
    developerMode,
    init,
    setTheme,
    toggleTheme,
    setSidebarCollapsed,
    toggleSidebar,
    applyCareMode,
    setCareMode,
    setDeveloperMode,
  };
});

/** 供类型检查使用（仅引用类型） */
export type UiConfig = Pick<DesktopStoredConfig, 'theme' | 'sidebarCollapsed' | 'careMode' | 'developerMode'>;
