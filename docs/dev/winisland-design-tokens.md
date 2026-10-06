# WinIsland 视觉设计系统（Design Token 规格）

来源：`D:\classhelper\.cache\winisland-ref\WinIsland-master`（只读 checkout）。
所有数值均取自代码常量，标注了「常量名 = 值 @ 文件」。未在代码中找到的项明确写「未找到」。

关键前提：**岛内所有几何尺寸都乘以 `compact_scale`（默认 1.0）或 `expanded_scale`（默认 1.0）**，
下文数值默认 scale = 1.0。文字颜色在渲染入口被硬编码为 `Color::WHITE`（`src/core/render.rs`
`draw_expanded_layer` / `draw_compact_layer` 传 `text_color: Color::WHITE`, `text_color_sec: Color::WHITE`），
所有"次级/次要"文字靠 **alpha** 或 **灰度通道值** 表达，而不是换颜色。

---

## 1. 几何（几何 token）

### 1.1 两个状态的尺寸

| 项       | compact / mini                  | expanded                             | 来源                                                                                          |
| -------- | ------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------- |
| 宽       | `base_width = 120.0`            | `expanded_width = 360.0`             | `src/core/config.rs` `AppConfig::default()`                                                   |
| 高       | `base_height = 27.0`            | `expanded_height = 200.0`            | 同上                                                                                          |
| 圆角 r   | `h / 2`（=13.5）→ 胶囊/体育场形 | `min(48*scale, w/2, h/2)` = **48.0** | `src/window/app/frame.rs` `default_target_r`；`src/utils/shape.rs` `expanded_island_radius()` |
| 全局缩放 | `compact_scale = 1.0`           | `expanded_scale = 1.0`               | `src/core/config.rs`                                                                          |

圆角函数原文（`src/utils/shape.rs`）：

```rust
pub(crate) fn expanded_island_radius(w: f32, h: f32, scale: f32) -> f32 {
    (48.0 * scale).min(w / 2.0).min(h / 2.0).max(0.0)
}
```

compact 圆角：`IslandSprings::new` 里 `r = (base_height * compact_scale) / 2.0`（`src/window/app.rs`）；
展开时 `default_target_r = compact_content_h / 2.0`（`src/window/app/frame.rs` `update_spring_targets`）。

### 1.2 compact 宽度的动态规则（不是固定 120）

`src/window/app/layout.rs` `compute_lyric_target_width()`：

- 无媒体 / 不在播放态：宽 = `base_width` = **120**
- 有媒体但无歌词：宽 = `base_width + 35.0` = **155**
- 有歌词（不滚动）：`w = 60.0 + 文本宽`，再 `clamp(base_width+35, MAX_LYRIC_WIDTH)`
  - `min_w = base_width + 35.0`、`MAX_LYRIC_WIDTH = 700.0`（`src/core/config.rs`）
- 有歌词（滚动模式，`lyrics_scroll = true`）：`natural_w = 60.0 + text_w`，超过 `lyrics_scroll_max_width`（默认
  `300.0`，`default_lyrics_scroll_max_width`）则固定为该上限；内部可用文本宽 = `(fixed_w - 59.0) * compact_scale`
- 二级歌词存在时：高度 = `max(base_height*scale, mini_lyric_pair_height)`，
  其中 `lyric_pair_height = 主字号*(1 + 0.85 + 0.18) + 8*scale`
  （`SECONDARY_LYRIC_SCALE = 0.85`、`LYRIC_PAIR_GAP_SCALE = 0.18` @ `src/core/render/mini.rs`）
  → 默认字号 12 时 = 12×2.03 + 8 = **32.36 px 高**，r ≈ 16.18

### 1.3 挂件（compact widget）导致的最小宽度

`src/ui/widget/compact/mod.rs`：

- `CONTENT_EDGE_INSET = 9.0`、`CONTENT_GAP = 7.0`
- `widget_width()`：`Time = 48.0`、`ResourceUsage = 132.0`
- 三组对齐宽度：`aligned_layout_width = 9*2 + left + center + right + 7*(占用组数-1)`
- 单侧扩展宽：`extension_width = CONTENT_EDGE_INSET + strip_width + CONTENT_GAP`
  （例：左 Time → 9+48+7 = **64**；ResourceUsage → 9+132+7 = **148**）
- 最终 compact 宽 = `max(布局宽, base_width)`

### 1.4 compact overlay（通知 / 音量）会替换 base 尺寸

| overlay | 宽                                         | 高                                        | 圆角             | 来源                                                                                                    |
| ------- | ------------------------------------------ | ----------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------- |
| 通知    | `max(base_width, 330.0) * scale` = **330** | `max(base_height, 82.0) * scale` = **82** | `h/2` = **41**   | `src/ui/compact/notification.rs` `target_size()`；r 取自 `src/window/app/frame.rs`（`size.height/2.0`） |
| 音量    | `(base_width + 72.0) * scale` = **192**    | `(base_height + 10.0) * scale` = **37**   | `h/2` = **18.5** | `src/ui/compact/volume.rs` `target_size()`                                                              |

### 1.5 隐藏态尺寸

- `hidden_width` 默认 `5.0`（`default_hidden_width` @ `src/core/config.rs`），
- `MIN_HIDDEN_WIDTH = 0.0`、`MAX_HIDDEN_WIDTH = 400.0`
- 隐藏时高度收缩到 `hidden_width * compact_scale`，并保留 `hidden_reveal_h = 1.0`（1px 可点击边）；
  位移距离 `hide_distance = concealed_height + TOP_OFFSET`（`src/window/app/layout.rs`）

### 1.6 锚点（两种状态之间什么不动）

定位全部来自 `src/window/app/layout.rs` `compute_island_layout()` / `compute_window_position()`：

- **顶部居中停靠（默认）**：`island_y = TOP_OFFSET = 10.0`（**顶边固定**），
  `offset_x = (os_w - w) / 2.0`（**水平中心固定**）
- **底部停靠**：`island_y = os_h - TOP_OFFSET - h`（**底边固定**，向上生长）
- **左/右停靠**：`offset_x = TOP_OFFSET` 或 `os_w - TOP_OFFSET - w`（对应侧边固定）
- `TOP_OFFSET: i32 = 10`（`src/core/config.rs`）＝ 岛顶边距屏幕顶 10 px
- 状态切换由三个弹簧同时插值：`w/h/r` 参数为 `stiffness = 0.10, damping = 0.68`（`src/window/app/frame.rs`），
  页面横移 `view` 用 `0.12 / 0.68`；隐藏用 `(0.12, 0.70)` 隐藏 / `(0.08, 0.78)` 显示
- **compact 内容不跟随变大的岛做垂直居中重排**：mini 内容画在 `stable_island_y`（= 顶边）加上 `base_h` 带内居中
  （`src/core/render/mini.rs`：封面 `y = stable_offset_y + (base_h - size)/2`，歌词 `center_y = stable_offset_y + base_h/2`）。
  效果＝岛向下长大，胶囊内容始终贴在顶部那条带里。
- 交叉淡出：`expanded_alpha = expansion_progress² * (1-hide_progress)`，
  `mini_alpha = clamp(1 - expansion_progress*1.5, 0, 1) * (1-hide_progress)`
  （`MINI_FADE_RATE = 1.5` @ `src/core/render.rs`）→ 即进度 0~0.667 之间完成交叉淡出

### 1.7 有没有"挖孔/刘海"造型？

**没有。** 代码里没有 `SetWindowRgn` / `CreateRoundRectRgn` / notch / cutout 相关调用（已全仓 grep 确认），
也没有"顶部贴边 + 上方两角变直角"的特例分支。造型是：

- 一个**悬浮胶囊**（compact，r = h/2），**距屏幕顶 10 px**；
- 展开后是**四角一致的连续超椭圆**（squircle），r 最大 48。

圆角实现不是普通圆弧，而是 Flutter `RoundedSuperellipse` 的移植（`src/utils/shape.rs`，
注释标明 "Rounded-superellipse geometry adapted from Flutter under the BSD-3-Clause license"）：

- `superellipse_parameters()`：11 项查表 `PARAMETERS`（如 `(2.0, 1.13276676) … (6.43023796, 2.98020421)`），
  ratio > 5 时线性外推 `exponent = 6.43023796 + 1.559599389*(ratio-5.0)`、`factor = 2.98020421 + 0.522807185*(ratio-5.0)`
- `Octant::new()`：13 项 `BEZIER_FACTORS`（`(0.7078, 8.3194) … (0.9705, 1.2880)`），用 conic + cubic 拼四分之一角
- 路径缓存 `PATH_CACHE_CAPACITY = 64`
- **Web 复刻提示**：CSS `border-radius` 是正圆角，观感会偏"软"；要还原请用 SVG path 或
  `corner-shape: squircle`（若可用）/ `clip-path` 近似。**未找到**等价的简单圆角公式——真实几何就是上面那张表。
- **本仓库的落地实现**（`packages/desktop-client/src/island/squircle.ts`）：不查表，用单参数超椭圆近似
  `point = center + r·(sign(cos a)·|cos a|^p, sign(sin a)·|sin a|^p)`，`p = 2/n`、`n = 4.2`，
  四角分别以 `TR(w-r,r) → BR(w-r,h-r) → BL(r,h-r) → TL(r,r)`、起始角 `-π/2, 0, π/2, π` 各扫 `π/2`，
  每角 14 段。**四个角必须各用自己的圆心 + 角度参数**：早期版本四个角共用同一个"偏移向量"，
  左上/右下被切成缺一块（用户反馈的"左上角和右下角怎么缺一块 / 圆角边缘割裂"），
  现已由 `verify:desktop` 的「连续圆角四角一致」断言（四角沿对角线边界步进两两一致 + 路径绕行 \|winding\|≈2π）长期守住。

### 1.8 窗口留白 / 裁切

- `PADDING: f32 = 80.0`（`src/core/config.rs`）；窗口尺寸 = `(岛宽 + 80, 岛高 + 80)`
  （`src/window/app/layout.rs` `required_window_size()`）→ **岛四周各 40 px 透明留白**，供阴影/动画使用
- 绘制时 `canvas.clip_path(island_path, ClipOp::Intersect)`，所有内容裁在岛形内；
  1px 描边在 `canvas.restore()` **之后**绘制（`src/core/render.rs` `draw_island()`）
- 挂件网格额外内缩，避免内容进圆角（`src/ui/widget/expanded/mod.rs` `widget_grid_layout`）：
  ```rust
  corner_inset = radius * (1.0 - FRAC_1_SQRT_2);      // 48 * 0.29289 = 14.06
  inset = (corner_inset + 8.0*scale).max(24.0*scale); // = 24.0（scale=1）
  gap = 7.0 * scale;
  ```

### 1.9 expanded 内容网格

- `WIDGET_GRID_COLS = 6`、`WIDGET_GRID_ROWS = 3`、`WIDGET_GRID_SLOTS = 18`（`src/core/config.rs`）
- 槽位宽 = `(inner_w - 7*5) / 6`，高 = `(inner_h - 7*2) / 3`；
  用 360×200、inset 24 计算：inner = 312×152 → **slot ≈ 46.17 × 46.0**（`src/ui/widget/expanded/mod.rs`）
- 组件占格 `WidgetKind::span()`：`Clock = (2,1)`、`ResourceUsage = (2,1)`、`Calendar = (2,2)`、`Settings = (1,1)`
  （`src/core/config.rs`）

---

## 2. 配色（颜色 token）

### 2.1 岛背景（`src/core/render/background.rs` `draw_background()`）

| 样式                        | 颜色值                                                         | 说明                 |
| --------------------------- | -------------------------------------------------------------- | -------------------- |
| `default`（`SOLID_STYLE`）  | `Color::BLACK` = **#000000**，完全不透明                       | `bg_color`           |
| `glass` + host backdrop     | `Color::from_argb(150, 10, 10, 14)` = **rgba(10,10,14,0.588)** | `draw_host_glass()`  |
| `glass` 无 backdrop（回退） | `Color::from_argb(205, 32, 32, 36)` = **rgba(32,32,36,0.804)** | `fallback_color`     |
| `dynamic` 底色              | `Color::from_rgb(32, 32, 36)` = **#202024**，不透明            | `draw_effect_base()` |
| `dynamic` 叠加层            | `Color::from_argb(120, 20, 20, 24)` = **rgba(20,20,24,0.471)** | 盖在旋转模糊封面之上 |
| `dynamic` 无封面回退        | 同 glass 分支（150/10,10,14 或 205/32,32,36）                  |                      |

`dynamic` 封面动效参数（同一函数）：

- 集显：`rotate_speed = 0.015 rad/s, drift_speed_x = 0.075, drift_speed_y = 0.06, drift_amp_x = 10.0, drift_amp_y = 7.5`
- 独显：`rotate_speed = 0.03, drift_speed_x = 0.15, drift_speed_y = 0.12, drift_amp_x = 20.0, drift_amp_y = 15.0`
- 旋转矩形边长 `side_len = diagonal * 1.3`

**亚克力/backdrop 真实实现**（`src/window/d3d.rs` + `src/utils/win32.rs`）：
Windows 11 `DWMWA_USE_HOSTBACKDROPBRUSH`，失败时退回 `SetWindowCompositionAttribute`
（`AccentPolicy { state: 5, flags: 0, gradient_color: 0 }`，state 5 = host backdrop）；
再用 `Compositor::CreateHostBackdropBrush()` + `RoundedRectangleGeometry` 裁圆角
（`HOST_BACKDROP_INSET = 1.0`，几何 = `w-2, h-2, radius-1`）。
**未找到**任何模糊半径数值——模糊由系统 HostBackdropBrush 决定。

### 2.2 描边（`src/core/render.rs` `draw_island_border()`）

```rust
BORDER_WIDTH = 1.0;  BORDER_INSET = BORDER_WIDTH / 2.0;   // 0.5
SOLID_STYLE = "default";  SOLID_BORDER_ALPHA = 30;  EFFECT_BORDER_ALPHA = 40;
```

- 颜色 = **纯白**，alpha：
  - `default` 样式：`rgba(255,255,255, 30/255=0.118)`，**并再乘 `(1 - expansion_progress)`**（展开后描边消失）
  - `glass` / `dynamic`：`rgba(255,255,255, 40/255=0.157)`，不随展开衰减
- 描边矩形 = `(x+0.5, y+0.5, w-1, h-1)`，圆角 `r-0.5`

### 2.3 阴影（`src/core/render.rs` `draw_expanded_shadow()`，仅展开时）

- 颜色 `Color::from_argb((28.0 * opacity) as u8, 0,0,0)` = **rgba(0,0,0,0.11)**
- `opacity = expansion_progress² * (1 - hide_progress)`，`opacity <= 0.01` 直接跳过
- 偏移 `offset_y = 2.0 * scale`；模糊 `sigma = min(3.0*scale, margin/3.0)`（margin = 到画布边界的余量）
- 用 `ClipOp::Difference` 只画在岛形之外
- **未找到内阴影**（没有任何 inner shadow 实现）

### 2.4 分隔线

| 位置                 | 颜色                                               | 尺寸                                                               | 来源                                              |
| -------------------- | -------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------- |
| compact 挂件之间     | `rgba(255,255,255, 0.14*alpha)`                    | 宽 `max(scale,1)`，从 `top+25%h` 到 `bottom-25%h`                  | `src/ui/widget/compact/mod.rs` `draw_separator()` |
| compact 资源占用内部 | `rgba(255,255,255, 0.10*alpha)`                    | 宽 `max(0.75*scale, 0.75)`，半高 `DIVIDER_HALF_HEIGHT = 6.0*scale` | `src/ui/widget/compact/resource_usage.rs`         |
| expanded 资源环分隔  | `rgba(白, 0.09*alpha)`                             | 宽 `scale.max(0.75)`，从 `y+0.2h` 到 `y+0.8h`                      | `src/ui/widget/expanded/resource_usage.rs`        |
| 设置窗口分隔线       | `rgba(255,255,255,26)` 暗 / `rgba(20,28,40,18)` 亮 | —                                                                  | `src/utils/color.rs`                              |

### 2.5 文字颜色与不透明度分层

主文字一律 **#FFFFFF**；次级用 alpha：

| 元素               | 有效颜色                                                     | 来源                                                 |
| ------------------ | ------------------------------------------------------------ | ---------------------------------------------------- |
| 通知 app 名        | `rgba(255,255,255, 0.65*alpha)`                              | `src/ui/compact/notification.rs`                     |
| 通知标题           | `rgba(255,255,255, alpha)`                                   | 同上                                                 |
| 通知详情           | `rgba(255,255,255, 0.72*alpha)`                              | 同上                                                 |
| 音量标签           | `rgba(255,255,255, 0.9*alpha)`                               | `src/ui/compact/volume.rs`                           |
| expanded 歌手      | `rgba(白, alpha*0.6)`                                        | `src/ui/expanded/music_view.rs` `draw_track_text()`  |
| 迷你歌词主行       | 白 alpha                                                     | `src/core/render/mini.rs`                            |
| 迷你歌词次行       | `rgb(176,176,176)`（`SECONDARY_LYRIC_CHANNEL = 176`）        | 同上                                                 |
| 逐字歌词"未唱"部分 | `rgb(190,190,190)`（`PENDING_LYRIC_CHANNEL = 190`）          | 同上                                                 |
| 进度条时间         | 白，`PROGRESS_TIME_IDLE_ALPHA = 0.5` → hover 1.0（线性插值） | `src/ui/expanded/music_view.rs`                      |
| 挂件时钟           | 白 alpha（bold）                                             | `src/ui/widget/expanded/time.rs`                     |
| 挂件日历 月        | `0.78*alpha`                                                 | `src/ui/widget/expanded/calendar.rs`                 |
| 挂件日历 日        | `1.0*alpha`                                                  | 同上                                                 |
| 挂件日历 星期      | `0.62*alpha`                                                 | 同上                                                 |
| 挂件资源 数值      | `1.0*alpha`（bold）                                          | `src/ui/widget/expanded/resource_usage.rs`           |
| 挂件资源 标签      | `0.58*alpha`                                                 | 同上                                                 |
| 封面占位块         | `rgba(白, 0.15*alpha)`                                       | `src/ui/expanded/music_view.rs` `draw_placeholder()` |

### 2.6 强调色 / 状态色

岛内（`src/ui/widget/resource_usage.rs`）：

```rust
CPU_COLOR      = rgb(50, 190, 246)   // #32BEF6
RAM_COLOR      = rgb(175, 82, 222)   // #AF52DE
WARNING_COLOR  = rgb(255, 159, 10)   // #FF9F0A
CRITICAL_COLOR = rgb(255, 69, 58)    // #FF453A
```

阈值曲线 `usage_color(base, usage)`：

- `usage <= 0.75` → base
- `0.75 < usage <= 0.9` → base ↔ WARNING 线性混合，`t = (usage-0.75)/0.15`
- `0.9 < usage` → WARNING ↔ CRITICAL 线性混合，`t = (usage-0.9)/0.1`
  采样间隔 `SAMPLE_INTERVAL = 1s`；无数值时显示 `—`。

进度条/音量条（`src/ui/expanded/music_view.rs`、`src/ui/compact/volume.rs`）：

```rust
PROGRESS_TRACK_ALPHA = 0.15;      // 轨道 rgba(白, 0.15*alpha)
PROGRESS_TIME_IDLE_ALPHA = 0.5;   // 时间文字静止透明度
// 音量轨道 rgba(255,255,255, 0.28*alpha)，填充纯白 alpha
```

音量的"填充"就是**白色**（不是强调色），图标仍是白色。

可视化条颜色**来自专辑封面**（`src/ui/expanded/music_view/palette.rs`）：

- 把封面画到 8×8 的 GPU surface（`PALETTE_SAMPLE_SIZE = 8`）读回求平均 RGB
- `primary = brighten(avg, 1.3)`、`secondary = brighten(avg, 1.5)`
- `brighten` 用 BT.601 亮度 `0.299R + 0.587G + 0.114B`；若 < 80 则整体加 `80 - brightness`（抬到最低亮度 80）
- 调色板 = `[primary, secondary, primary]`，缓存上限 50 条
- 无封面默认值（`default_media_palette`）：`rgb(180,180,180)` + `rgb(100,100,100)`
- 采样完全失败的兜底：`rgb(200,200,200)`

### 2.7 不同状态是否不同配色？

- **同一套**：底 + 白字 + alpha 分层；通知 / 音量 / 音乐 / 挂件没有各自的独立配色，
  视觉区分靠 **尺寸（330×82 / 192×37 / 120×27）** 与 **内容排版**，而不是换色。
- 差异只在两处：**可视化条用封面取色**（2.6），**资源占用用 CPU/RAM/警告/危险四色**（2.6）。
- 岛背景三样式（default/glass/dynamic）才是真正的配色分支（2.1）。

### 2.8 设置窗口色板（另一套，`src/utils/color.rs`，供参考）

暗色主题 `dark_settings_theme()`：

```
win_bg #1C1C1E  sidebar_bg #242426  group_bg #2C2C2E  card_highlight #48484A
accent #0A84FF  text_pri #F5F5F7   text_sec #AEAEB2  disabled #636366
danger #E6372D  toggle_on #30D158  toggle_off #636366
sidebar_hover rgba(255,255,255,20)  separator rgba(255,255,255,26)
popup_bg #323234  popup_border rgba(255,255,255,40)  popup_shadow rgba(0,0,0,60)
popup_separator rgba(255,255,255,30)  control_bg #3A3A3C  control_hover #48484A
control_disabled #303032  control_border rgba(255,255,255,36)
group_border rgba(255,255,255,24)  shadow rgba(0,0,0,45)  scrollbar rgba(255,255,255,60)
```

亮色主题 `light_settings_theme()`：

```
win_bg #F4F5F7  sidebar_bg #FAFAFC  group_bg #FFFFFF  card_highlight #EFF2F7
text_pri #1F2228  text_sec #5B626E  disabled #9297A1  accent #0067C0
danger #C42B1C  toggle_on #0078D4  toggle_off #B0B5BE
selection_bg #E0EEFA  selection_text #005599
sidebar_hover rgba(20,32,48,14)  separator rgba(24,32,44,18)
popup_bg #FFFFFF  popup_border rgba(20,28,40,24)  popup_shadow rgba(20,28,40,20)
control_bg #F7F8FA  control_hover #EBEFF4  control_disabled #F1F2F5
control_border rgba(20,28,40,24)  group_border rgba(20,28,40,14)
shadow rgba(20,28,40,20)  scrollbar rgba(52,58,68,52)
```

设置窗口另有"岛预览"配色（与真实渲染略有差异，`src/utils/settings_ui/renderer/widget_preview.rs`）：
glass 预览 `rgba(24,24,28,220)`；dynamic 预览为线性渐变 **`rgb(18,12,36)` → `rgb(8,24,48)`**（左上→右下）；
default 预览 `rgb(10,10,10)`；预览描边 alpha `52`(glass) / `38`(其他)；预览阴影 `rgba(0,0,0,72)`，偏移 +4。
→ 若前端需要一张**静态渐变**替代 `dynamic`，这两个色值就是现成可抄的。

---

## 3. 排版（字体 token）

### 3.1 字体族（`src/utils/font.rs`）

1. 用户自定义字体：`config.custom_font_path` → `FontMgr::new_from_data()`（优先于全部）
2. ASCII 文本：`"Microsoft YaHei"` → `"Segoe UI"` → 系统默认（`legacy_make_typeface`）
3. 非 ASCII：逐字符匹配 `match_family_style_character("", style, &["zh-CN","ja-JP","en-US"], ch)`，
   再依次尝试 `"Segoe UI Emoji"` → `"Microsoft YaHei"` → `"Segoe UI Symbol"` → `"Segoe UI"`
4. 合成粗体：`needs_synthetic_bold()` = 请求 `weight >= 600` 且字体本身 `weight < 600` → `font.set_embolden(true)`
5. 亚像素渲染始终开启 `font.set_subpixel(true)`

字重只有两档：`FontStyle::bold()`（700）与 `FontStyle::normal()`（400）；
滚动文本判定粗体用 `style.weight() >= 700`（`src/utils/scroll.rs`）。

**字距 / 行高**：代码里**未找到** letter-spacing 或 line-height 参数；
行距全部通过显式 y 偏移实现（见下表）。文本绘制走 Skia `draw_str`，
大字文本（标题/歌手）`render_as_paths = true`（`src/utils/scroll.rs` 调用点）。

### 3.2 字号表（默认 `config.font_size = 0.0` 时用内置值；>0 时用户值参与计算）

| 用途                 | 字号                                         | 字重                  | 说明 / 来源                                                                                        |
| -------------------- | -------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------- |
| mini 歌词主行        | `font_size*0.8*scale` 或 **12.0\*scale**     | normal                | `src/core/render/mini.rs` `lyric_font_size()`                                                      |
| mini 歌词次行        | 主字号 × `SECONDARY_LYRIC_SCALE = 0.85`      | normal                | 同上                                                                                               |
| mini 歌词对高度      | `主*(1+0.85+0.18) + 8*scale`                 | —                     | `lyric_pair_height()`                                                                              |
| mini 插件文字（主）  | `font_size*0.7*scale` 或 **11.0\*scale**     | **bold**              | `PLUGIN_FONT_SCALE = 0.7`、`DEFAULT_PLUGIN_FONT_SIZE = 11.0`                                       |
| mini 插件文字（次）  | 主 × `0.8`                                   | normal                | `PLUGIN_SECONDARY_FONT_SCALE = 0.8`，行距 `font_size*1.3`（`PLUGIN_SECONDARY_LINE_SPACING = 1.3`） |
| expanded 曲名        | `font_size*scale` 或 **15.0\*scale**         | **bold**              | `src/ui/expanded/music_view.rs`                                                                    |
| expanded 歌手        | 同上 **15.0\*scale**                         | normal                | 基线 = 曲名基线 + `22.0*scale`                                                                     |
| 进度时间             | `font_size*0.67*scale` 或 **10.0\*scale**    | normal                | `PROGRESS_TIME_FONT_SCALE = 0.67`、`DEFAULT_PROGRESS_TIME_FONT_SIZE = 10.0`                        |
| 通知 app 名          | **11.0\*scale**                              | normal                | `src/ui/compact/notification.rs`                                                                   |
| 通知标题             | **13.0\*scale**                              | **bold**              | 同上                                                                                               |
| 通知详情             | **11.0\*scale**                              | normal                | 行间距 `DETAIL_LINE_GAP = 21.0*scale`                                                              |
| 音量标签             | **12.0\*scale**                              | normal                | `src/ui/compact/volume.rs`                                                                         |
| compact 时钟挂件     | `clamp(h*0.43, 10, 12)`                      | **bold**              | `src/ui/widget/compact/time.rs`                                                                    |
| compact 资源—标签    | `METRIC_LABEL_SIZE = 7.0*scale`              | **bold**              | `src/ui/widget/compact/resource_usage.rs`                                                          |
| compact 资源—数值    | `METRIC_VALUE_SIZE = 10.0*scale`             | **bold**              | 同上                                                                                               |
| expanded 时钟挂件    | `min(h*0.60, w*0.31)`，最小 `13.0*scale`     | **bold**              | `src/ui/widget/expanded/time.rs`                                                                   |
| expanded 日历—月     | `clamp(h*0.14, 9, 15)*scale`                 | **bold**              | `src/ui/widget/expanded/calendar.rs`                                                               |
| expanded 日历—日     | `min(h*0.53, w*0.70)`，最小 `26.0*scale`     | **bold**              | 同上                                                                                               |
| expanded 日历—星期   | `clamp(h*0.12, 8, 12)*scale`                 | normal                | 同上                                                                                               |
| expanded 资源—圆环值 | `clamp(d*0.27, 7, 10.5*scale)`，d = 圆环直径 | **bold**              | `src/ui/widget/expanded/resource_usage.rs`                                                         |
| expanded 资源—标签   | `clamp(h*0.12, 6, 8*scale)`                  | **bold**              | 同上                                                                                               |
| 设置窗口—行标签/值   | **13.0**                                     | normal                | `src/utils/settings_ui/renderer/items.rs`                                                          |
| 设置窗口—页签标签    | **11.5**                                     | normal（选中为 bold） | `src/window/settings/renderer.rs`                                                                  |
| 设置窗口—弹窗项      | **12.0**                                     | normal                | 同上                                                                                               |
| 设置窗口—Markdown    | `BODY_SIZE = 12.0`，`LINE_HEIGHT = 18.0`     | —                     | `src/window/settings/pages/plugins/markdown.rs`                                                    |

字体基线规则（值得照抄）：

- 居中对齐用 **字形包围盒** 居中：`baseline_y = bounds.top + (bounds.h - glyph.h)/2 - glyph.top`
  （`src/ui/widget/expanded/mod.rs` `draw_widget_text_centered()`）
- 时间文字基线 = 进度条中心 + `0.35*字号`（`PROGRESS_TIME_BASELINE_SCALE = 0.35`）
- 迷你歌词单行时 `primary_y = center_y + size/3`；双行时按堆叠高度对齐（见 5.1）

### 3.3 是否随窗口尺寸 / 用户设置缩放

- 随 `compact_scale` / `expanded_scale` 缩放（乘在所有尺寸上）
- 字号受 `config.font_size`（默认 0 = 用内置值）影响：只有 mini 歌词、mini 插件、expanded 曲名/歌手、进度时间用它
- 挂件字号是**几何驱动**的（按自身矩形宽高 clamp），与 `font_size` 无关
- 设置窗口有自己的 `settings_theme`（`system` / 暗 / 亮）

---

## 4. 层级与效果

### 4.1 圆角

见 1.7。总结：连续超椭圆（squircle），compact 满圆角（h/2），expanded 最大 48。
挂件卡片 `widget_corner_radius = min(12.0*scale, min(w,h)/2)`（`src/ui/widget/expanded/mod.rs`）。
迷你封面 `MINI_COVER_RADIUS = 5.0`，expanded 封面 `16.0*scale`，通知图标 `11.0*scale`。

### 4.2 阴影 / 发光

- **外阴影**：仅 expanded，`rgba(0,0,0,0.11)`，y+2，blur σ = `min(3*scale, margin/3)`（见 2.3）
- **内阴影**：**未找到**
- **发光**：只出现在资源占用圆环——`glow` 圆半径 `diameter*0.57`，颜色 `accent`，alpha `0.07*alpha`
  （`src/ui/widget/expanded/resource_usage.rs`）
- 设置窗口：窗口阴影 `rgba(0,0,0,90)`、弹出菜单阴影 `theme.popup_shadow` + 偏移 +2（`src/window/settings/renderer.rs`）；
  拖拽幽灵阴影 `rgba(0,0,0,90)`，偏移 +4

### 4.3 模糊半径（全部数值）

| 场景                    | 参数                                                                                                        | 来源                        |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------- |
| 运动模糊（整体）        | 横向 = `                                                                                                    | w速度                       | *0.3 +                              | view速度                                                          | *w*0.4`，纵向 = ` | h速度 | *0.3`；上限集显 `(4.0, 3.5)`、独显 `(12.0, 10.0)`；仅在 σ>0.1 时 `saveLayer` | `src/utils/blur.rs` `calculate_blur_sigmas()`、`src/core/render.rs` `MIN_BLUR_SIGMA = 0.1` |
| 封面翻转                | `σ = (1-                                                                                                    | cos                         | )^0.6 * 8.0 * scale`，x 方向再 ×0.3 | `src/ui/expanded/music_view.rs`                                   |
| 暂停按钮速度模糊        | `                                                                                                           | 弹簧速度                    | * 16.0 * scale`，上限 `2.5*scale`   | `PAUSE_CONTROL_BLUR_SCALE = 16.0`、`PAUSE_CONTROL_MAX_BLUR = 2.5` |
| 快进/快退按钮           | `(1 - t/0.3).max(0) * 6.0 * scale`，x×0.3                                                                   | 同文件 `draw_skip_button()` |
| 歌词切换（Blur 模式）   | `σ = 6.0*scale`，x 压缩 `LYRIC_TRANSITION_BLUR_X_SCALE = 0.25`，位移 `LYRIC_TRANSITION_OFFSET = 10.0*scale` | `src/core/render/mini.rs`   |
| dynamic 背景封面        | 先降采样到 **64×64**，再 `image_filters::blur((8.0, 8.0), TileMode::Clamp)`                                 | `src/utils/backdrop.rs`     |
| host backdrop（亚克力） | **未找到数值**（由系统 HostBackdropBrush 决定，仅 `HOST_BACKDROP_INSET = 1.0`）                             | `src/window/d3d.rs`         |

### 4.4 不透明度分层与可见性阈值

```
MIN_VISIBLE_OPACITY = 0.01                // 低于此不绘制
MIN_BLUR_SIGMA      = 0.1
MINI_FADE_RATE      = 1.5                 // mini 淡出速率
COLLAPSED_VISUALIZER_HEIGHT_SCALE = 0.45  // 收起时可视化高度 = 45%
```

- `expanded_alpha = expansion_progress² * (1 - hide_progress)`（平方 → 展开"迟入场"）
- `mini_alpha     = clamp(1 - expansion_progress*1.5, 0, 1) * (1 - hide_progress)`
- 可视化高度比例 `visualizer_height_scale = 0.45 + 0.55 * expansion_progress`
- 歌词额外淡出 `LYRIC_EXPANSION_FADE_RATE = 2.5`（`src/core/render/mini.rs`）
- 展开页横向滑动：`page_shift = view_offset * current_w`；
  音乐页 `translate(-page_shift)`，挂件页 `translate(current_w - page_shift)`
  （`src/core/render/expanded.rs`）；`view` 弹簧 `0.12/0.68`

### 4.5 卡片四周留白 / 裁切

见 1.8：窗口 = 岛 + 80（每侧 40 透明）；内容 `clip_path(Intersect)`；
描边在裁切外画；挂件网格 inset 24。

---

## 5. 布局骨架

### 5.1 compact（mini）120×27

`src/core/render/mini.rs`：

```
MIN_MINI_CONTENT_WIDTH  = 45.0    // 可用宽小于此不画内容
MINI_COVER_SIZE         = 18.0    // 封面尺寸
MINI_COVER_LEFT_INSET   = 10.0    // 封面左边距
MINI_COVER_RADIUS       = 5.0     // 封面圆角
MINI_VISUALIZER_RIGHT_INSET  = 17.0
MINI_VISUALIZER_WIDTH_SCALE  = 0.55
MINI_VISUALIZER_SMOOTHING    = (0.6, 0.08)   // (上升, 下降)
LYRIC_LEFT_INSET   = 30.0
LYRIC_RIGHT_INSET  = 29.0
```

- **左**：18×18 封面，x = 10，y 垂直居中（`(base_h - 18)/2 = 4.5`），圆角 5，中心裁剪
- **中**：歌词，可用区 x ∈ [30, w-29]，垂直居中；主行居中（滚动模式改为左对齐并从 x=30 起滚动），
  次行始终水平居中；主行单行时 `y = center_y + size/3`，双行时
  `stack_h = size + size*0.85 + size*0.18`，主行 `y = center_y - stack_h/2 + size*0.8`，
  次行 `y = center_y + stack_h/2 - secondary*0.2`
- **右**：可视化条，中心 x = `w - 17`，中心 y = `base_h/2`
- 无媒体时改由 compact 挂件条接管：Left / Center / Right 三组；
  有 mini 内容时只画 Left 与（Center+Right）两组并贴两端，并在内容两侧画竖分隔线
  （`src/ui/widget/compact/mod.rs` `draw()`）
- 挂件宽：时间 **48**、资源 **132**；边缘 inset **9**；组内间距 **7**

### 5.2 expanded 音乐页 360×200

`src/ui/expanded/music_view.rs` 常量全表：

```
CONTENT_PADDING            = 24.0   // 四周内边距
COVER_SIZE                 = 64.0   // 封面 64×64，圆角 16.0*scale，位置 (24,24)
TRACK_TEXT_GAP             = 18.0   // 封面右到文字左
TRACK_TEXT_RIGHT_INSET     = 70.0   // 文字右侧预留（给可视化条）
TRACK_TITLE_BASELINE_OFFSET= 26.0   // 曲名基线 y = 24 + 26 = 50
PROGRESS_TOP_GAP           = 24.0   // 进度条中心 y = 24 + 64 + 24 = 112
PROGRESS_TIME_WIDTH        = 28.0   // 两端时间文字预留宽
PROGRESS_TIME_GAP          = 4.0
PROGRESS_BAR_HEIGHT        = 6.5    // 常态条高
PROGRESS_BAR_HOVER_GROWTH  = 3.5    // hover 增至 10.0
PLAYBACK_CONTROLS_TOP_GAP  = 42.0   // 控制行中心 y = 112 + bar_h/2 + 42 ≈ 157.25
SKIP_BUTTON_GAP            = 75.0   // 上一首/下一首中心距播放键 75
PAGE_ARROW_RIGHT_INSET     = 7.5    // 右侧翻页条 x = w - 7.5，y = h/2
PAGE_ARROW_FADE_RATE       = 5.0
COLLAPSED_VISUALIZER_INSET = 17.0   // 视觉条右侧 inset 随展开 17 → 37
EXPANDED_VISUALIZER_INSET  = 37.0
VISUALIZER_TITLE_OFFSET    = 4.0    // 视觉条中心 y = 曲名基线 - 4
```

- **左**：64 封面；**中**：曲名(15 bold)/歌手(15, α0.6) 两行，x = 24+64+18 = **106**；**右**：可视化条
- 进度条：左右各内缩 24，两端 28 宽时间 + 4 间距；条圆角 = bar_h/2；
  填充宽度 `max(bar_total_w*progress, bar_h)`；填充只圆左端（RRect 左上/左下半径 = bar_h/2，右侧 0）
- 控制行中心 x = 180；播放键在中心、上一首 105、下一首 255
- 点击热区（`src/ui/expanded/music_view/controls.rs`）：播放 **40×40**，上/下一首 **36×36**，
  进度条热区高 **16.0\*scale**，封面整块可双击（激活媒体 App）
- 动画参数：`PROGRESS_SMOOTHING = 0.15`、`PROGRESS_HOVER_SMOOTHING = 0.18`、
  `PROGRESS_HOVER_SNAP_THRESHOLD = 0.005`、`PROGRESS_START_THRESHOLD = 0.02`、`PROGRESS_JUMP_THRESHOLD = 0.3`、
  `PLAY_STATE_RESPONSE = 0.18`、`SKIP_ANIMATION_DURATION_SECS = 0.5`、封面翻转 0.6s、
  `PAUSE_CONTROL_STIFFNESS = 0.18`、`PAUSE_CONTROL_DAMPING = 0.64`、`PAUSE_CONTROL_MIN_SCALE = 0.8`、
  `PAUSE_CONTROL_MAX_SCALE = 1.03`、`PAUSE_CONTROL_PRESS_VELOCITY = -0.18`
- 播放/暂停过渡：`cover_scale = 0.85 + 0.15*pause_t`、`cover_brightness = 0.75 + 0.25*pause_t`
  （即暂停时封面缩小到 85% 并压暗到 75%），图标用 `smoothstep` 交叉淡出

### 5.3 expanded 挂件页（同 360×200）

- 6×3 网格，inset 24，gap 7（见 1.9）
- 卡片：背景 `rgba(28,28,30, 0.05*alpha)`，描边 `1px rgba(255,255,255, 0.16*alpha)`，圆角 `min(12*scale, min(w,h)/2)`
- 左侧翻页条 x = **7.5**，y = `h/2`（3×14 圆角矩形，α0.4）；右侧同（x = w-7.5）
- 内置挂件各视图排布：
  - **时钟**：整卡居中，字号 `min(h*0.6, w*0.31)`（≥13），bold，`HH:MM` 格式
  - **日历**：月 `y+0.08h..0.26h`（bold，α0.78）／日 `y+0.27h..0.75h`（bold，字号 `min(0.53h,0.70w)`，≥26）／
    星期 `y+0.78h..0.92h`（normal，α0.62）
  - **资源占用（2×1）**：中间竖分隔（α0.09，`y+0.2h..0.8h`）；两个圆环各占一半：
    环心 `(center_x, top+0.43h)`，直径 `min(0.58h, 0.62w)`（≥20），描边 `min(3*scale, d*0.12)` 圆头，
    底环 α0.13，进度弧从 **-90°** 起扫 `usage*360°`（α0.92），值文字 bold 居中，标签在 `top+0.76h`（α0.58）
  - **设置（1×1）**：整卡居中齿轮图标，`icon_scale = min(w,h)*0.38/24`，α0.72

### 5.4 compact 各业务视图差异

| 视图                                                                                                                                                                     | 尺寸   | 排布                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 时间挂件                                                                                                                                                                 | 48×27  | 居中 `HH:MM`，字号 `clamp(0.43h, 10..12)` bold，基线 `center_y + size*0.36`                                                                         |
| 资源挂件                                                                                                                                                                 | 132×27 | 两个 metric 各 `(w-8)/2` 宽；标签 7px bold 在左（accent α0.78），数值 10px bold 在右（白）；                                                        |
| 文字基线 `center_y + scale`；下方 2px 进度轨（y = 基线+5），轨 α0.13，填充 accent α0.9；中间分隔 α0.1，半高 6                                                            |
| 通知                                                                                                                                                                     | 330×82 | 图标 42×42 圆角 11 @ x+18 垂直居中；文本左 = 有图标 `x+72` / 无图标 `x+20`；右内缩 18；                                                             |
| app 名基线 `top+22`（11px α0.65）；标题 13px bold，基线 `top+34`（无 app 名）/ `top+43`（有 app 名）/ 垂直居中 `top+(h+13)/2`（两者皆无）；详情 11px α0.72 在标题下 21px |
| 音量                                                                                                                                                                     | 192×37 | 喇叭图标 20px，中心 `x = left+21`；标签 12px @ `left+37`（α0.9）；轨道从 `label_x + label_w + 26` 到 `right-14`，高 4 圆角 2，轨 α0.28，填充白 α1.0 |

### 5.5 动画时长（通知 / 音量）

- 通知：`DISPLAY_DURATION = 5s`，`ENTER_DURATION = 220ms`（`ease_out_cubic = 1-(1-t)³`），
  `FADE_DURATION = 280ms`；入场位移 `(1-enter)*7.0*scale`（从上滑下 7px）
- 音量：`DISPLAY_DURATION = 1600ms`，`FADE_DURATION = 240ms`，
  `VOLUME_CHANGE_THRESHOLD = 0.002`（音量变化阈值，低于此不显示）
- 歌词切换进度用 `smoothstep`：`p*p*(3-2p)`（`src/core/render/mini.rs`）
- 长文本跑马灯（`src/utils/scroll.rs`）：先停 **2.0s**，再以 **35.0\*scale px/s** 滚动，
  循环间隔 `full_w + 50*scale`，裁剪区 `(x, y-size*1.2, max_w, size*1.5)`

---

## 6. 图标

**体系**：全部是 Skia 内的 **SVG path 数据 + 填充（`PaintStyle::Fill`）**，没有线性描边图标体系，
也没有 icon font。颜色一律单色：由 `text_color`（= 白）+ alpha 决定；只有资源环用 accent 色。
**未找到**线宽（stroke-width）概念——唯一的描边图标是设置窗口的翻页箭头（`1.8px`, round cap/join）。

| 图标             | 路径坐标系               | 缩放                                                                                  | 实际视觉尺寸                                               | 来源                                                                                             |
| ---------------- | ------------------------ | ------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 播放 ▶           | 640 单位（128..544）     | `0.083 * scale`                                                                       | ≈ 34.5 × 37 px                                             | `src/icons/controls.rs` `draw_play_button`                                                       |
| 暂停 ⏸           | 640 单位                 | `0.083 * scale`                                                                       | ≈ 34.5 × 37 px                                             | `draw_pause_button`                                                                              |
| 快退/快进三角    | 640 单位（中心 336,320） | `path_scale * global_scale`，静止 `0.050`（左）与 `0.055`（右）；动画中 `0.050~0.055` | 约 21 × 22 px                                              | `draw_control_triangle`，`src/ui/expanded/music_view.rs` `draw_skip_button`（中心 ±10.92*scale） |
| 音乐（封面占位） | 1024 单位                | `scale*1.8`，内部 `0.024`                                                             | 随卡片                                                     | `src/icons/music.rs`                                                                             |
| 设置齿轮         | 1024 单位                | `min(w,h)*0.38/24`，内部 `0.024`                                                      | 卡片 38% 短边                                              | `src/icons/settings.rs`                                                                          |
| 音量（4 档）     | 25.75 单位               | `size / 25.75`，偏移 `(-11.089286, -7.883929)`                                        | 传 20.0*scale                                              | `src/icons/volume.rs`；档位 `level<=0→静音, <=1/3→低, <=2/3→中, else→高`                         |
| 翻页指示条       | 不是 path                | —                                                                                     | `3.0*scale × 14.0*scale` 圆角矩形，圆角 `2.0*scale`，α×0.4 | `src/icons/arrows.rs`                                                                            |

其他图标使用点：

- 通知 App 图标：`AppDisplayInfo::GetLogo(Size{64,64})`，按 alpha>8 计算可见包围盒，等比缩放塞进 42×42，圆角 11 裁切
- 封面：64×64（expanded）与 18×18（mini），中心裁剪，`FilterMode::Linear + MipmapMode::Linear`
- 迷你封面圆角 5、expanded 封面圆角 16（连续超椭圆路径，不是普通 `clip_rrect`）

---

## 7. 明确「未找到」的项

1. **刘海/挖孔造型**：不存在（无 `SetWindowRgn`、无顶部直角特例）
2. **内阴影 / inset shadow**：代码中无任何实现
3. **字距（letter-spacing）与行高倍数**：无；行距全靠显式 y 偏移
4. **亚克力的模糊半径/透明度数值**：由 Windows `HostBackdropBrush` 系统决定，代码只给 `HOST_BACKDROP_INSET = 1.0`
   → Electron 侧**没有**等价物：`setBackgroundMaterial('acrylic')` 是整窗系统材质（跟随应用主题、覆盖窗口矩形），
   不能像 `DWMWA_USE_HOSTBACKDROPBRUSH` 那样只画在圆角形状里；本项目因此改用无 backdrop 的降级色（见 §8）
5. **强调色用于岛内 UI**：岛内几乎没有强调色（只有资源占用的 CPU/RAM/警告/危险色）；
   统一强调色 `#0A84FF` 仅存在于**设置窗口**（`COLOR_ACCENT`）
6. **岛自身的亮/暗主题**：岛屿永远是深底白字；明暗主题只在设置窗口
7. **固定渐变色背景**：真实 `dynamic` 背景是封面图，没有固定渐变；
   仅设置页预览用 `rgb(18,12,36) → rgb(8,24,48)`（可当静态替代）
8. **CSS 等价的超椭圆圆角公式**：真实实现是 Flutter 超椭圆查表（`src/utils/shape.rs`），没有简单的 border-radius 参数

---

## 8. 给 Web/Electron 复刻的映射速查

- 岛容器：定位在屏幕顶上 `top: 10px`、水平居中，尺寸与圆角用 spring 插值
  （`cubic-bezier` 或 JS 弹簧，参考 `stiffness 0.10 / damping 0.68`）；`overflow: hidden` 做裁切
- compact：`120×27`（有歌词时宽度跟着文本走，上限 700；只有媒体无歌词时 155），`border-radius: 13.5px`（胶囊）
- expanded：`360×200`，`border-radius: 48px`（想要 iOS 味请用 SVG 超椭圆路径）
- 背景：`#000` 不透明；"glass" **不要**照搬 WinIsland 的 host backdrop —— Electron 的
  `setBackgroundMaterial()` 是"整窗系统材质"，覆盖范围是窗口矩形而不是卡片形状，且明暗跟随应用主题，
  在浅色主题下会给卡片垫出一圈浅色面板（详见 `packages/desktop-client/src/main/island.ts`）；
  我们改用 WinIsland 自己的**无 backdrop 降级色** `rgba(32,32,36,.804)` 画在卡片上；
  "dynamic" 用封面模糊层 + `rgba(20,20,24,.471)` 叠加
- 描边：`1px solid rgba(255,255,255,.118)`（纯色样式，展开时淡出）/ `.157`（glass、dynamic）
- 阴影：仅展开 `0 2px σ rgba(0,0,0,.11)`（σ ≈ 3px）
- 文字：`-apple-system / "Microsoft YaHei" / "Segoe UI"`，白 + alpha 分层（.65 / .72 / .9 / .6 / .5 / .58 / .62）
- 图标：内联 SVG，`fill: currentColor`，播放/暂停按 640 坐标系、尺寸 ≈ 34.5×37

---

## 附：ClassHelper实际采纳了哪些（本次重写对照表）

| WinIsland 做法                                           | 出处                                                                                                 | 我们的落地                                                                                                                         | 验证                                            |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **窗口一次建大包围盒，形变发生在窗口内**                 | `window/app/layout.rs` `required_window_size()` + `PADDING=80`                                       | 窗口固定为「最大形态 + `ISLAND_SHADOW_PAD(10)`」，开合期间**一帧都不 setBounds**                                                   | 逐帧窗口签名恒为 `476x282@482,-2`（只有 1 种）  |
| 尺寸/圆角由弹簧驱动                                      | `utils/physics.rs` + `app.rs` `IslandSprings`（w/h/r = `0.10/0.68`）                                 | `src/island/spring.ts` 同参数同更新式（dt 以帧计、`damping^dt`、换向保留 35% 动量 + 20% 距离上限），并加**零过冲钳制**             | 岛中心/边缘波动 0.00px、无过冲                  |
| 连续圆角（超椭圆）                                       | `utils/shape.rs` `continuous_rounded_rect_path` / `expanded_island_radius = min(48*scale, w/2, h/2)` | `src/island/squircle.ts` 超椭圆角路径；展开半径 `min(48×圆角/20, w/2, h/2)`                                                        | 形状 bbox 与卡片框一致（±2px）                  |
| 内容交叉淡入 `expanded=progress²`、`mini=1-1.5×progress` | `core/render.rs`（`MINI_FADE_RATE=1.5`）                                                             | 两层常驻、透明度按同一公式                                                                                                         | 截图与 DOM 断言                                 |
| 描边 1px 白 alpha 30（纯色）/ 40（glass）                | `core/render.rs` `BORDER_*_ALPHA`                                                                    | `--wn-border` 取同值（`.118` / `.157`）                                                                                            | 计算样式断言                                    |
| 展开投影 `rgba(0,0,0,.11)`、y+2、σ=3                     | `draw_expanded_shadow`                                                                               | `drop-shadow(0 2px 3px rgba(0,0,0,.11))`                                                                                           | 截图                                            |
| 纯黑底 / 亚克力（HostBackdropBrush）                     | `background.rs` + `win32.rs` `DWMWA_USE_HOSTBACKDROPBRUSH`                                           | 纯黑底 / **glass 用 CSS 半透明深色卡**（WinIsland 无 backdrop 降级色 `rgba(32,32,36,.804)`）；**不调用** `setBackgroundMaterial()` | 计算样式 + 「卡片外圈透出桌面」整屏截图像素断言 |
| `set_cursor_hittest` 命中控制                            | `frame.rs`（`set_cursor_hittest`）                                                                   | 默认 `setIgnoreMouseEvents(true,{forward:true})`，渲染层命中测试后切换                                                             | 岛内 true / 岛外 false                          |
| 空闲细缝 `hidden_width = 5`                              | `core/config.rs`                                                                                     | 6px 宽竖条（窗口固定，不再受 Windows 最小窗口高度限制）                                                                            | 空闲 `6x22` → 来消息 `268x44`                   |
| 6 个停靠位 `DockPosition`                                | `core/config.rs`                                                                                     | 顶/底 × 左/中/右 6 锚点，岛（而非窗口）精确落在锚点                                                                                | 6 锚点坐标断言                                  |
| `font_size` = 基础字号 × 各文本系数                      | `core/render/mini.rs`、`ui/expanded/music_view.rs`                                                   | 基础字号 11–20px × 系数表（标题 1.08/正文 0.95/次要 0.78/徽标与按钮 0.76/胶囊 0.92、0.74）                                         | 13→19px 全部文本倍率 1.462                      |
| 未采纳：音乐/歌词/小组件/音量浮窗                        | `ui/expanded/**`、`ui/widget/**`                                                                     | 业务不同（我们做通知/作业/叫人/紧急）                                                                                              | —                                               |
