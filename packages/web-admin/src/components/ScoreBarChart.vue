<script setup lang="ts">
import { computed } from 'vue';

/**
 * 轻量柱状图（纯 HTML/CSS，不依赖任何图表库）。
 *
 * 为什么不用 echarts：成绩页只需要「分组柱 + 数值标签 + 坐标轴」这点东西，
 * 而 `import * as echarts from 'echarts'` 会给构建产物加 1.1MB。
 *
 * 实现要点（决定了这里为什么不需要 resize 监听）：
 * - 柱高用**百分比**：`.bar-track` 是行方向 flex 里 `flex:1` 的子项，高度确定，
 *   柱子的 `height: X%` 直接按它解析；
 * - 刻度与网格线用**零高度 flex 行 + `justify-content: space-between`**：
 *   零高度元素的中心正好落在 i/(N-1) 处，与柱状区上下边界精确对齐；
 * - 纵轴刻度列与绘图区共用同一套上下留白（数值行 18px / 标签行 28px），因此永远对齐。
 *
 * 与桌面客户端那份（`packages/desktop-client/src/renderer/components/ScoreBarChart.vue`）
 * 是刻意分开的两份：两端的设计令牌体系不同（`--ch-*` 浅/深色 vs `--el-*`），
 * 合用一个组件反而要塞一堆条件样式。
 */
interface BarItem {
  label: string;
  value: number;
}

const props = withDefaults(
  defineProps<{
    /** 每根柱：分类名 + 数值 */
    items: BarItem[];
    /** 柱色 */
    color?: string;
    /** 纵轴上限；不传时按数据最大值向上取整到「好看」的刻度 */
    max?: number;
    /** 数值单位（显示在刻度与柱顶数值后面） */
    unit?: string;
    /** 图表高度（px） */
    height?: number;
  }>(),
  { color: '#409eff', max: undefined, unit: '', height: 220 },
);

/** 把数值向上取整到 1/2/5 × 10^n，让刻度落在整数上 */
function niceCeil(value: number): number {
  if (value <= 0) return 1;
  const base = 10 ** Math.floor(Math.log10(value));
  const normalized = value / base;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * base;
}

const axisMax = computed(() => {
  if (props.max !== undefined) return props.max;
  const dataMax = props.items.reduce((max, item) => Math.max(max, item.value), 0);
  return niceCeil(dataMax);
});

/** 纵轴刻度（自上而下）：100% / 75% / 50% / 25% / 0%，去重后最多 5 条 */
const ticks = computed(() => {
  const values = [1, 0.75, 0.5, 0.25, 0].map((ratio) => Math.round(axisMax.value * ratio));
  return [...new Set(values)];
});

function barHeight(value: number): string {
  const ratio = axisMax.value > 0 ? value / axisMax.value : 0;
  return `${Math.min(1, Math.max(0, ratio)) * 100}%`;
}

function formatValue(value: number): string {
  return `${Number.isInteger(value) ? value : value.toFixed(1)}${props.unit}`;
}
</script>

<template>
  <div class="bar-chart" :style="{ height: `${height}px` }">
    <div v-if="items.length === 0" class="bar-chart-empty">暂无数据</div>
    <template v-else>
      <div class="axis-y" aria-hidden="true">
        <span v-for="tick in ticks" :key="tick" class="tick">{{ tick }}{{ unit }}</span>
      </div>

      <div class="plot">
        <div class="gridlines" aria-hidden="true">
          <span v-for="tick in ticks" :key="tick" class="gridline"></span>
        </div>

        <div class="bars">
          <div v-for="item in items" :key="item.label" class="bar-col">
            <div class="bar-value">{{ formatValue(item.value) }}</div>
            <div class="bar-track">
              <div
                class="bar"
                :style="{ height: barHeight(item.value), background: color }"
                :title="`${item.label}：${formatValue(item.value)}`"
              ></div>
            </div>
            <div class="bar-label" :title="item.label">{{ item.label }}</div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.bar-chart {
  display: grid;
  grid-template-columns: 40px 1fr;
  width: 100%;
}

.bar-chart-empty {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  font-size: 13px;
  color: var(--el-text-color-placeholder);
}

.axis-y {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: 18px 0 28px;
}

.tick {
  height: 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding-right: 8px;
  font-size: 11px;
  line-height: 1;
  white-space: nowrap;
  color: var(--el-text-color-secondary);
}

.plot {
  position: relative;
  min-width: 0;
}

.gridlines {
  position: absolute;
  inset: 18px 0 28px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  pointer-events: none;
}

.gridline {
  height: 0;
  border-top: 1px solid var(--el-border-color-lighter);
}

.bars {
  display: flex;
  align-items: stretch;
  gap: 8px;
  height: 100%;
  padding: 0 6px;
}

.bar-col {
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  height: 100%;
}

.bar-value {
  flex: none;
  height: 18px;
  font-size: 11px;
  line-height: 1;
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  color: var(--el-text-color-secondary);
}

.bar-track {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  align-items: flex-end;
  justify-content: center;
}

.bar {
  width: 46%;
  max-width: 46px;
  border-radius: 4px 4px 0 0;
  transition: height 0.2s ease;
}

.bar-label {
  flex: none;
  height: 28px;
  padding-top: 6px;
  font-size: 11px;
  line-height: 1.3;
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--el-text-color-secondary);
}
</style>
