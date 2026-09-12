/**
 * 连续圆角（squircle / Apple 连续曲率圆角）路径生成。
 *
 * 参考实现：WinIsland `src/utils/shape.rs` —— 它用八分体（Octant）+ 超椭圆参数表构造
 * `continuous_rounded_rect_path`，而不是普通圆弧圆角；展开卡半径取
 * `expanded_island_radius = min(48 * scale, w/2, h/2)`。
 *
 * 做法：把路径拆成「四条直边 + 四段圆角弧」，每段弧都用**自己那个角的圆心 + 角度**参数化：
 *   `point = center + r·(sign(cos a)·|cos a|^p, sign(sin a)·|sin a|^p)`
 * 四个角的圆心依次是右上 `(w-r, r)` → 右下 `(w-r, h-r)` → 左下 `(r, h-r)` → 左上 `(r, r)`，
 * 起始角依次是 `-π/2, 0, π/2, π`（每个角扫 π/2），因此天然是顺时针一圈、没有方向歧义。
 *
 * 早期版本用「相对角起点的偏移向量」拼角，而四个角需要的偏移向量**并不相同**
 * （右上/左下是 `(sin^p, 1-cos^p)`，左上/右下是 `(1-cos^p, sin^p)`）——
 * 于是左上与右下被画成了向内凹的形状，视觉上就是这两个角**缺一块**。
 *
 * 生成的是**像素坐标**路径（w/h 为卡片实际像素尺寸），因此圆角半径恒定、不被拉伸。
 */

/** 超椭圆指数：2 = 标准圆弧圆角，越大越"方"但曲率越连续（Apple 观感约 4~5） */
const SUPERELLIPSE_EXPONENT = 4.2;

/** 每个角的采样段数（越多越平滑；4 个角共 4x 段） */
const CORNER_SEGMENTS = 14;

const round = (value: number): number => Math.round(value * 100) / 100;

/**
 * 生成连续圆角矩形路径。
 *
 * 做法：把路径拆成「四条直边 + 四段圆角弧」，每段弧都用**自己那个角的圆心 + 角度**参数化：
 *   `point = center + r·(sign(cos a)·|cos a|^p, sign(sin a)·|sin a|^p)`
 * 四个角的圆心依次是右上 `(w-r, r)` → 右下 `(w-r, h-r)` → 左下 `(r, h-r)` → 左上 `(r, r)`，
 * 起始角依次是 `-π/2, 0, π/2, π`（每个角扫 π/2），因此天然是顺时针一圈、不会出现方向歧义。
 *
 * 早期版本用「相对起点的偏移向量」拼角，而四个角需要的偏移向量并不相同
 * （右上/左下是 `(sin^p, 1-cos^p)`，左上/右下是 `(1-cos^p, sin^p)`），
 * 于是左上与右下被画成了"向内凹"的形状——视觉上就是这两个角**缺一块**。
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

  const p = 2 / SUPERELLIPSE_EXPONENT;
  const centers = [
    { cx: w - r, cy: r }, // 右上
    { cx: w - r, cy: h - r }, // 右下
    { cx: r, cy: h - r }, // 左下
    { cx: r, cy: r }, // 左上
  ];
  const startAngles = [-Math.PI / 2, 0, Math.PI / 2, Math.PI];

  const parts: string[] = [];
  for (let corner = 0; corner < 4; corner += 1) {
    const center = centers[corner] as { cx: number; cy: number };
    const startAngle = startAngles[corner] as number;
    for (let index = 0; index <= CORNER_SEGMENTS; index += 1) {
      const angle = startAngle + (index / CORNER_SEGMENTS) * (Math.PI / 2);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const px = center.cx + r * Math.sign(cos) * Math.pow(Math.abs(cos), p);
      const py = center.cy + r * Math.sign(sin) * Math.pow(Math.abs(sin), p);
      parts.push(`${index === 0 && corner === 0 ? 'M' : 'L'}${round(px)},${round(py)}`);
    }
  }
  parts.push('Z');

  return parts.join(' ');
}

/** 展开卡半径（与 WinIsland 的 expanded_island_radius 同构：min(48*scale, w/2, h/2)） */
export function expandedRadius(width: number, height: number, radius: number): number {
  return Math.max(0, Math.min(Math.max(radius, 24), width / 2, height / 2));
}
