<script setup lang="ts">
import { computed } from 'vue';

/**
 * 轻量柱状图（纯 HTML/CSS，不依赖任何图表库）。
 *
 * 为什么不用 echarts：成绩页只需要「分组柱 + 数值标签 + 坐标轴」这点东西，
 * 而 `import * as echarts from 'echarts'` 会给渲染产物加 1.1MB（客户端里最大的一块），
 * 按需引入 echarts/core 也仍有约 500KB。
 *
 * 实现要点（决定了这里为什么不需要 resize 监听）：
 * - 柱高用**百分比**：`.bar-track` 是行方向 flex 里 `flex:1` 的子项，高度确定，
 *   柱子的 `height: X%` 直接按它解析；
 * - 刻度与网格线用**零高度 flex 行 + `justify-content: space-between`**：
 *   零高度元素的中心正好落在 i/(N-1) 处，与柱状区上下边界精确对齐；
 * - 纵轴刻度列与绘图区共用同一套上下留白（数值行 18px / 标签行 30px），因此永远对齐。
 */
interface BarItem {
  label: string;
  value: number;
}

const props = withDefaults(
  defineProps<{
    /** 每根柱：分类名 + 数值（0 ~ max） */
    items: BarItem[];
    /** 柱色 */
    color?: string;
    /** 纵轴上限 */
    max?: number;
    /** 数值单位（显示在刻度与柱顶数值后面） */
    unit?: string;
    /** 图表高度（px） */
    height?: number;
  }>(),
  { color: '#409eff', max: 100, unit: '%', height: 300 },
);

/** 纵轴刻度（自上而下）：100 / 75 / 50 / 25 / 0（按 max 换算） */
const ticks = computed(() => [1, 0.75, 0.5, 0.25, 0].map((ratio) => Math.round(props.max * ratio)));

function barHeight(value: number): string {
  const ratio = props.max > 0 ? value / props.max : 0;
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
  grid-template-columns: 46px 1fr;
  width: 100%;
}

.bar-chart-empty {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  font-size: 13px;
  color: var(--ch-text-tertiary);
}

/* 纵轴刻度：上下留白与 .bars 里的数值行 / 标签行一一对应 */
.axis-y {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: 18px 0 30px;
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
  color: var(--ch-text-tertiary);
}

.plot {
  position: relative;
  min-width: 0;
}

.gridlines {
  position: absolute;
  inset: 18px 0 30px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  pointer-events: none;
}

.gridline {
  height: 0;
  border-top: 1px solid var(--ch-border);
}

.bars {
  display: flex;
  align-items: stretch;
  gap: 10px;
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
  color: var(--ch-text-secondary);
}

.bar-track {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  align-items: flex-end;
  justify-content: center;
}

.bar {
  width: 100%;
  max-width: 46px;
  border-radius: 4px 4px 0 0;
  transition: height 0.2s ease;
}

.bar-label {
  flex: none;
  height: 30px;
  padding-top: 6px;
  font-size: 11px;
  line-height: 1.3;
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--ch-text-secondary);
}
</style>
