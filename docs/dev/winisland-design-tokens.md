---
title: 灵动岛设计令牌
description: 本地经典/自定义岛的几何、外观与动画入口。
---

# 灵动岛设计令牌

经典岛以 WinIsland 的连续圆角和形变为设计参考，自定义组件行以 ClassIsland 为参考。
当前数值与行为以本仓库 shared 常量和渲染实现为准；本页不把上游音乐/歌词/媒体功能列为 ClassHelper 功能。

## 经典几何与外观

| 来源                                                 | 内容                                                  |
| ---------------------------------------------------- | ----------------------------------------------------- |
| shared/src/constants.ts 的 DEFAULT_ISLAND_APPEARANCE | 默认宽 268、高 44、圆角 20、字号 13、边距 8，顶部居中 |
| ISLAND_APPEARANCE_RANGES                             | 滑块与主进程归一化共用的范围                          |
| ISLAND_SIZE_DELTA                                    | 展开、紧急与叫人相对尺寸                              |
| ISLAND_SHADOW_PAD                                    | 窗口边界的透明留白                                    |
| ISLAND_LIST_METRICS / islandListLayout               | 主进程和渲染层共用列表度量，控制行数与工作区高度      |
| desktop-client/src/island/squircle.ts                | 超椭圆路径                                            |
| desktop-client/src/island/classic-island.css         | 经典底色、文字、图形与状态样式                        |

classic 的 black/glass/tinted 是本地 CSS 外观；glass 使用半透明色，不采样桌面模糊。
不要对透明岛调用 setBackgroundMaterial：系统材质作用于整窗矩形，可能破坏逐像素透明。
投影常驻，只随形态改参数，避免切换 filter 创建合成表面的闪帧。
默认停靠中线不受左右边距影响，只有左/右停靠使用水平边距。

## 自定义常驻行

CLASSISLAND_ISLAND_METRICS 位于 shared/src/island-layout.ts：

| 参数                    | 本地值               |
| ----------------------- | -------------------- |
| 单行基准高度 / 水平留白 | 40 / 12 px           |
| 次要/正文/强调/大字号   | 14 / 16 / 18 / 20 px |
| 默认缩放 / 范围         | 1 / 0.75–2.5         |
| 默认圆角 / 最大         | 8 / 20 px            |
| 默认不透明度 / 行距     | 0.5 / 5 px           |
| 鼠标避让淡化比例        | 0.05                 |

方案有常态 rows 和无通知展开 expandedRows，运行时由 CustomIslandRuntime.vue 测量自然内容，
再按屏幕工作区与方案缩放适配。字体与外观覆盖按组件契约生效，不能拿经典固定宽高解释自定义内容尺寸。

## 动画与命中

经典与自定义岛的形变都使用 src/island/spring.ts 的 SpringValue；默认 stiffness=0.10、damping=0.68，
换向保留部分动量，按剩余距离限速并钳制过冲。不同用途可能覆盖 snapThreshold 等参数，以调用点为准。
这是独立的帧积分，不等同于主窗口 shared/motion.ts 的 CSS 弹簧。
应用内动画开关、原生窗口可见性与文档可见性控制运行时动画和静止落定。

鼠标模式按光标命中控制穿透；触摸模式处理贴合、输入区域与失焦宽限，自定义常驻模式还维护独立交互入口和窗口形状。
几何改变时同步实际窗口、命中矩形和测量，不在动画中反推自然尺寸。
视觉验收必须显式 --visual；本页数值不代表本次已完成像素验收。

## 修改入口

外观范围改 shared，经典样式改 classic-island.css，自定义样式改 custom-runtime.css 和 custom-island.css，
原生窗口与命中改 main/island.ts。组件结构/设置改 shared/island-layout.ts 并同步编辑器和运行时。
展示行为见[灵动岛](../app/island.md)，测试见[验收与测试](testing.md)。
