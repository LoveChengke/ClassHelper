import { computed, onMounted, onUnmounted, readonly, ref } from 'vue';

/**
 * 响应式断点（与 1Panel 风格一致：小屏把侧边栏收进抽屉，内容区单列铺满）。
 *
 * - `<= 768px`  手机：侧边栏抽屉化、顶部工具栏铺满、表格卡片内横向滚动
 * - `769-992px` 平板：保留侧边栏，内容做适度压缩
 * - `> 992px`   桌面：维持原有双栏布局
 */
export const MOBILE_MAX_WIDTH = 768;
export const TABLET_MAX_WIDTH = 992;

function currentWidth(): number {
  return typeof window === 'undefined' ? 1280 : window.innerWidth;
}

/**
 * 视口响应式状态。
 * 同一时刻可以有多个组件使用（各自持有监听），只做一次 `innerWidth` 读取 + resize 监听。
 */
export function useResponsive() {
  const width = ref(currentWidth());

  const sync = (): void => {
    width.value = currentWidth();
  };

  onMounted(() => {
    sync();
    window.addEventListener('resize', sync, { passive: true });
    window.addEventListener('orientationchange', sync, { passive: true });
  });

  onUnmounted(() => {
    window.removeEventListener('resize', sync);
    window.removeEventListener('orientationchange', sync);
  });

  const isMobile = computed(() => width.value <= MOBILE_MAX_WIDTH);
  const isTablet = computed(() => width.value > MOBILE_MAX_WIDTH && width.value <= TABLET_MAX_WIDTH);
  const isDesktop = computed(() => width.value > TABLET_MAX_WIDTH);

  return {
    width: readonly(width),
    isMobile,
    isTablet,
    isDesktop,
    /** 手动同步一次（例如窗口尺寸被外部改变后） */
    sync,
  };
}
