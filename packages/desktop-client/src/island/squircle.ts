/**
 * 连续圆角（squircle / Apple 连续曲率圆角）路径生成。
 *
 * 参考实现：WinIsland `src/utils/shape.rs` —— 它用八分体（Octant）+ 超椭圆参数表
 * 构造 `continuous_rounded_rect_path`，而不是普通圆弧圆角；展开卡的半径取
 * `expanded_island_radius = min(48 * scale, w/2, h/2)`。
 *
 * 这里用等价的超椭圆角公式生成 SVG path：
 *   角点区域按  x = r * (1 - cos^p(t)),  y = r * (1 - sin^p(t))  采样，
 *   其中 p = 2/n、n 取 4.2 时最接近 Apple 的"连续曲率"观感（普通圆角相当于 n = 2）。
 * 直边部分保持完全笔直，因此与 WinIsland 的"直边 + 连续圆角"一致。
 *
 * 生成的是**像素坐标**路径（w/h 为卡片实际像素尺寸），所以圆角半径恒定、不被拉伸。
 */

/** 超椭圆指数：2 = 标准圆弧圆角，越大越"方"但曲率越连续（Apple 观感约 4~5） */
const SUPERELLIPSE_EXPONENT = 4.2;

/** 每个角的采样段数（越多越平滑；4 个角共 4x 段） */
const CORNER_SEGMENTS = 14;

function cornerPoints(radius: number): { x: number; y: number }[] {
  const p = 2 / SUPERELLIPSE_EXPONENT;
  const points: { x: number; y: number }[] = [];
  for (let index = 0; index <= CORNER_SEGMENTS; index += 1) {
    const t = (index / CORNER_SEGMENTS) * (Math.PI / 2);
    const cos = Math.max(0, Math.cos(t));
    const sin = Math.max(0, Math.sin(t));
    // t=0 → 角外侧（贴直边），t=π/2 → 角内侧
    points.push({
      x: radius * (1 - Math.pow(cos, p)),
      y: radius * (1 - Math.pow(sin, p)),
    });
  }
  return points;
}

const round = (value: number): number => Math.round(value * 100) / 100;

/**
 * 生成连续圆角矩形路径。
 *
 * @param width  卡片宽度（px）
 * @param height 卡片高度（px）
 * @param radius 四角基准半径（px，会被裁剪到 min(w/2, h/2)）
 */
export function squirclePath(width: number, height: number, radius: number): string {
  const w = Math.max(1, Math.round(width * 100) / 100);
  const h = Math.max(1, Math.round(height * 100) / 100);
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));

  if (r <= 0.5) return `M0,0 H${round(w)} V${round(h)} H0 Z`;

  const corner = cornerPoints(r);
  const parts: string[] = [];

  // 从左上角的"上方直边起点"开始，顺时针绘制
  parts.push(`M${round(r)},0`);
  // 上边 → 右上角
  parts.push(`H${round(w - r)}`);
  for (const point of corner) parts.push(`L${round(w - r + point.x)},${round(point.y)}`);
  // 右边 → 右下角
  parts.push(`V${round(h - r)}`);
  for (const point of corner) parts.push(`L${round(w - point.y)},${round(h - r + point.x)}`);
  // 下边 → 左下角
  parts.push(`H${round(r)}`);
  for (const point of corner) parts.push(`L${round(r - point.x)},${round(h - point.y)}`);
  // 左边 → 左上角
  parts.push(`V${round(r)}`);
  for (const point of corner) parts.push(`L${round(point.y)},${round(r - point.x)}`);
  parts.push('Z');

  return parts.join(' ');
}

/** 展开卡半径（与 WinIsland 的 expanded_island_radius 同构：min(48*scale, w/2, h/2)） */
export function expandedRadius(width: number, height: number, radius: number): number {
  return Math.max(0, Math.min(Math.max(radius, 24), width / 2, height / 2));
}
