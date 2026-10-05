import type { App } from 'vue';
import {
  AlarmClock,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Bell,
  Brush,
  Calendar,
  CircleCheckFilled,
  Connection,
  Expand,
  Fold,
  FullScreen,
  Guide,
  InfoFilled,
  Key,
  Link,
  Loading,
  Lock,
  MagicStick,
  Moon,
  Notebook,
  Plus,
  Pointer,
  Refresh,
  School,
  Setting,
  Sunny,
  SwitchButton,
  Tools,
  Trophy,
  UserFilled,
  Warning,
} from '@element-plus/icons-vue';

/**
 * Element Plus 图标注册表（桌面客户端渲染进程）。
 *
 * **为什么不 `import * as ElementPlusIconsVue` 全量注册**：
 * 图标库有 293 个组件（实测全量打包 minified 203KB，实际用到的只有 33 个），
 * 全量注册既把死代码打进主 chunk，又要在启动时执行 293 次 `app.component()`。
 *
 * **为什么不改成模板里逐个 import**：本项目的图标是按**字符串名**引用的
 * （`ClientLayout.vue` 的菜单配置 `icon: 'Setting'`、`OnboardingWelcome.vue` 的引导步骤、
 * 按钮上的 `:icon="'FullScreen'"`、`<component :is="item.icon">`），Element Plus 会用
 * `<component :is="'Setting'">` 去解析**全局组件名**，因此图标必须以全局组件存在。
 *
 * 新增视图时若用了新图标，`scripts/check-icons.mjs` 会在构建前报错，
 * 不会静默渲染成空白。
 */
const APP_ICONS = {
  AlarmClock,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Bell,
  Brush,
  Calendar,
  CircleCheckFilled,
  Connection,
  Expand,
  Fold,
  FullScreen,
  Guide,
  InfoFilled,
  Key,
  Link,
  Loading,
  Lock,
  MagicStick,
  Moon,
  Notebook,
  Plus,
  Pointer,
  Refresh,
  School,
  Setting,
  Sunny,
  SwitchButton,
  Tools,
  Trophy,
  UserFilled,
  Warning,
} as const;

/** 供 `scripts/check-icons.mjs` 读取的名单（构建期静态校验用） */
export const APP_ICON_NAMES: readonly string[] = Object.keys(APP_ICONS).sort();

export function registerAppIcons(app: App): void {
  for (const [name, component] of Object.entries(APP_ICONS)) {
    app.component(name, component);
  }
}
