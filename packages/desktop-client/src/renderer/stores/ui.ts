import { ref } from 'vue';
import { defineStore } from 'pinia';
import type { DesktopStoredConfig } from '../../types/desktop.js';

/**
 * 界面偏好（主题 / 侧边栏折叠）。
 *
 * 持久化在主进程配置（DesktopStoredConfig.theme / sidebarCollapsed）里，
 * 与灵动岛外观等设置同一套落盘机制；浏览器调试（无 window.desktop）回落 localStorage。
 * 深色主题 = 在 <html> 上挂 .dark 类（Element Plus dark css-vars + styles/index.css 的
 * html.dark 品牌变量），应用主题的全部入口都必须走 setTheme，保证类名与配置同步。
 */

const THEME_KEY = 'classhelper.theme';
const SIDEBAR_KEY = 'classhelper.sidebarCollapsed';

function applyThemeClass(theme: 'light' | 'dark'): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

export const useUiStore = defineStore('ui', () => {
  const theme = ref<'light' | 'dark'>('light');
  const sidebarCollapsed = ref(false);

  /** 启动时从主进程配置恢复（App.vue 的 boot 流程里调用，早于首屏渲染） */
  async function init(): Promise<void> {
    if (window.desktop) {
      const config = await window.desktop.getConfig().catch(() => null);
      if (config) {
        theme.value = config.theme === 'dark' ? 'dark' : 'light';
        sidebarCollapsed.value = config.sidebarCollapsed === true;
      }
    } else {
      theme.value = localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light';
      sidebarCollapsed.value = localStorage.getItem(SIDEBAR_KEY) === '1';
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

  return { theme, sidebarCollapsed, init, setTheme, toggleTheme, setSidebarCollapsed, toggleSidebar };
});

/** 供类型检查使用（仅引用类型） */
export type UiConfig = Pick<DesktopStoredConfig, 'theme' | 'sidebarCollapsed'>;
