<script setup lang="ts">
import { computed } from 'vue';

/**
 * 轻量折线图（内联 SVG + HTML 数据点，不依赖任何图表库）。
 *
 * 为什么不用 echarts：成绩页只需要一条「各科平均得分率」折线，
 * 而 `import * as echarts from 'echarts'` 会给构建产物加 1.1MB。
 *
 * 实现要点：
 * - 线画在 `viewBox="0 0 100 100"` + `preserveAspectRatio="none"` 的 SVG 里，
 *   于是 viewBox 坐标 (x, y) 精确对应绘图区的 (x%, y%)；`vector-effect="non-scaling-stroke"`
 *   保证非等比拉伸时线宽仍是 2px；
 * - 数据点用**绝对定位的 HTML 圆点**（而不是 SVG `<circle>`），这样非等比拉伸下仍是正圆；
 *   点位与线的坐标共用同一套百分比，天然对齐；
 * - 横轴分类点落在**每个分组的中心**（`(i + 0.5) / n`），与 echarts 的 category 轴一致；
 * - 全程零 resize 监听。
 */
interface LineItem {
  label: string;
  value: number;
}

const props = withDefaults(
  defineProps<{
    items: LineItem[];
    color?: string;
    /** 纵轴上限；不传时按数据最大值向上取整 */
    max?: number;
    unit?: string;
    height?: number;
  }>(),
  { color: '#67c23a', max: undefined, unit: '%', height: 220 },
);

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

const ticks = computed(() => {
  const values = [1, 0.75, 0.5, 0.25, 0].map((ratio) => Math.round(axisMax.value * ratio));
  return [...new Set(values)];
});

/** 数据点：x / y 都是绘图区的百分比坐标（0~100） */
const points = computed(() => {
  const count = props.items.length;
  const max = axisMax.value;
  return props.items.map((item, index) => {
    const ratio = max > 0 ? item.value / max : 0;
    return {
      label: item.label,
      value: item.value,
      x: ((index + 0.5) / count) * 100,
      y: (1 - Math.min(1, Math.max(0, ratio))) * 100,
    };
  });
});

/**
 * Catmull-Rom 转三次贝塞尔，复刻 echarts `smooth: true` 的观感。
 * tension 0.2 与 echarts 的默认平滑强度接近。
 */
const linePath = computed(() => {
  const list = points.value;
  if (list.length < 2) return '';
  const tension = 0.2;
  const round = (value: number) => Number(value.toFixed(2));

  let path = `M ${round(list[0]!.x)} ${round(list[0]!.y)}`;
  for (let index = 0; index < list.length - 1; index += 1) {
    const previous = list[index - 1] ?? list[index]!;
    const current = list[index]!;
    const next = list[index + 1]!;
    const afterNext = list[index + 2] ?? next;

    const control1x = current.x + (next.x - previous.x) * tension;
    const control1y = current.y + (next.y - previous.y) * tension;
    const control2x = next.x - (afterNext.x - current.x) * tension;
    const control2y = next.y - (afterNext.y - current.y) * tension;

    path += ` C ${round(control1x)} ${round(control1y)}, ${round(control2x)} ${round(control2y)}, ${round(
      next.x,
    )} ${round(next.y)}`;
  }
  return path;
});

/** 折线下方的面积：从终点垂到基线，再沿基线回到起点 */
const areaPath = computed(() => {
  const list = points.value;
  if (list.length < 2) return '';
  const first = list[0]!;
  const last = list[list.length - 1]!;
  return `${linePath.value} L ${Number(last.x.toFixed(2))} 100 L ${Number(first.x.toFixed(2))} 100 Z`;
});

function formatValue(value: number): string {
  return `${Number.isInteger(value) ? value : value.toFixed(1)}${props.unit}`;
}
</script>

<template>
  <div class="line-chart" :style="{ height: `${height}px` }">
    <div v-if="items.length === 0" class="line-chart-empty">暂无数据</div>
    <template v-else>
      <div class="axis-y" aria-hidden="true">
        <span v-for="tick in ticks" :key="tick" class="tick">{{ tick }}{{ unit }}</span>
      </div>

      <div class="plot">
        <div class="gridlines" aria-hidden="true">
          <span v-for="tick in ticks" :key="tick" class="gridline"></span>
        </div>

        <svg class="lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <path v-if="areaPath" :d="areaPath" :fill="color" fill-opacity="0.12" />
          <path
            v-if="linePath"
            :d="linePath"
            fill="none"
            :stroke="color"
            stroke-width="2"
            stroke-linejoin="round"
            stroke-linecap="round"
            vector-effect="non-scaling-stroke"
          />
        </svg>

        <div class="points">
          <div v-for="point in points" :key="point.label" class="point-col">
            <span
              class="point"
              :style="{ top: `${point.y}%`, background: color }"
              :title="`${point.label}：${formatValue(point.value)}`"
            ></span>
          </div>
        </div>

        <div class="x-labels" aria-hidden="true">
          <span v-for="point in points" :key="point.label" class="x-label" :title="point.label">
            {{ point.label }}
          </span>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.line-chart {
  display: grid;
  grid-template-columns: 40px 1fr;
  width: 100%;
}

.line-chart-empty {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  font-size: 13px;
  color: var(--el-text-color-placeholder);
}

/* 上下留白与绘图区（.gridlines / .lines / .points 的 inset）严格一致 */
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

.gridlines,
.lines,
.points {
  position: absolute;
  inset: 18px 0 28px;
}

.gridlines {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  pointer-events: none;
}

.gridline {
  height: 0;
  border-top: 1px solid var(--el-border-color-lighter);
}

.lines {
  /* 尺寸完全由上面的 inset 决定（left/right/top/bottom 都给了），不要再写 width/height，
     否则会和 inset 打架 */
  pointer-events: none;
}

.points {
  display: flex;
}

.point-col {
  flex: 1 1 0;
  min-width: 0;
  position: relative;
}

.point {
  position: absolute;
  left: 50%;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  transform: translate(-50%, -50%);
}

.x-labels {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 28px;
  display: flex;
  pointer-events: none;
}

.x-label {
  flex: 1 1 0;
  min-width: 0;
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
