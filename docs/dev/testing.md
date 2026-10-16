---
title: 验收与测试
description: 验收验收脚本怎么跑、覆盖什么、哪些用例是脆弱的，以及怎么判断失败是不是真回归。
---

# 验收与测试

验收分为后台快速冒烟、隔离的接口与逻辑回归、显式视觉验收。日常默认不显示窗口、不占用前台；
涉及动画、桌面像素和灵动岛几何时，再单独运行视觉验收。

## 验收脚本

| 命令                   | 覆盖                                                                             | 需要什么                    |
| ---------------------- | -------------------------------------------------------------------------------- | --------------------------- |
| `pnpm verify:e2e`      | 后端 + 实时推送 + RBAC 越权 + 上课时段 + 导入 + 班级账号 + 数据库管理 + 更新检查 | **后端已启动**              |
| `pnpm verify:web`      | Web 管理端真实点击回归（Electron 驱动）                                          | 后端已启动 + Web 产物已构建 |
| `pnpm verify:desktop`  | 客户端冒烟（Electron，无人工点击）                                               | 已构建的客户端产物          |
| `pnpm verify:packaged` | 对**打包后 / 已安装**的客户端 EXE 复跑同一套冒烟（`--exe` 指定路径）             | 打包产物                    |

条目数由脚本自行统计并打印（`=== 结果：N/N 项通过 ===`），**文档里不写死容易过期的总数** ——
每次跑完看脚本输出。

客户端维护专项回归：

- `pnpm verify:client-agent`：模拟操作系统验证远控、回执重试与安装策略，不执行真实关机或安装器。
- `pnpm verify:client-migrations`：创建临时旧库验证升级、联动移除与默认组编辑持久化。
- `pnpm verify:clients-api`：面向 `http://127.0.0.1:4199` 的演示测试库（可用 `VERIFY_BASE_URL` 指定），验证权限、远控与更新接口。会创建并清理测试记录，请使用隔离测试服务。
- `pnpm verify:review-client`：无窗口验证缓存故障恢复、通知竞态、教学周同步、管理员界面权限与崩溃恢复。
- `pnpm verify:review-api`：针对审查缺陷验证接口权限、导入边界和实时删除等，必须连接隔离测试服务。

另外三套是"门禁"而不是验收：`pnpm typecheck`、`pnpm lint`、`pnpm check:icons`。

### 一次完整的交付前检查

```bash
pnpm lint                # ESLint，0 error 是底线
pnpm typecheck           # 全仓库类型检查（含 vue-tsc）

pnpm dev:server          # 另开一个终端
pnpm verify:e2e

pnpm build:desktop && pnpm verify:desktop
pnpm build && pnpm verify:web
```

改动涉及打包/交付形态时，再加 `pnpm dist:all` 与
`pnpm verify:packaged --exe "<客户端路径>"`（**开发产物通过不等于用户机器上的副本通过**）。

## 失败时先别改代码

下面这些用例**不是回归**，遇到时先看条件。完整清单在 `AGENTS.md` 的「已知脆弱用例」表。

| 用例                                                             | 触发条件                                                                                                                                         |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `verify:desktop:visual`「真实通知链路」「灵动岛标为已读」等 3 项 | 要求**当前不在上课时段**。种子课表恰有课正在进行时，客户端会**正确地**把普通通知暂存到下课 —— 这三项就会红（日志里会写 `客户端判定上课中=true`） |
| `verify:e2e`「上课状态接口（at=周一 08:10）」                    | 种子把周一第 1 节限制在第 1 周，且用例把 `2026-09-07` 当第 1 周。`.env` 的 `TERM_START_DATE` 对齐即可全绿                                        |
| `verify:web`「课表科目为全校统一目录」                           | 种子给每个班建满了全部科目，下拉里就没有可自动建课的「统一科目」分组                                                                             |
| `verify:desktop:visual`「课表今天时间轴」                        | 凌晨约 00:00–03:00 时「已结束」探针被夹紧成 0 长度而被过滤                                                                                       |
| `verify:desktop:visual`「作业看板全屏自适应」                    | 演示数据某天有 6 条长作业、而冒烟窗口只有约 543px 高时，缩放被下限 0.45 钳住 → 必然溢出                                                          |
| 岛交互 / 岛动画 / 岛截图留档                                     | 窗口被遮挡或跑在远程会话里时会间歇性失败：置顶透明小窗的 rAF 被限流、形变采样抓不到帧。**先原样重跑一次再动手改**                                |

## 大面积报「登录失败 / 401」时

先检查隔离服务是否启动，以及测试管理员的当前口令。不要修改真实班级密码来迁就测试。
联网客户端和 Web 回归会自行创建临时教师与班级；下面的环境变量只配置测试管理员：

| 脚本                | 管理员凭据                                               |
| ------------------- | -------------------------------------------------------- |
| 客户端联网/打包冒烟 | `ELECTRON_SMOKE_ADMIN` / `ELECTRON_SMOKE_ADMIN_PASSWORD` |
| Web 回归            | `UI_SMOKE_ADMIN` / `UI_SMOKE_ADMIN_PASS`                 |
| 后端端到端回归      | 使用隔离种子库，口令由种子脚本与验收脚本约定             |

默认离线快速冒烟不需要服务端凭据。

## 默认后台运行，视觉验收单独执行

`pnpm verify:desktop` 默认运行隐藏、不可聚焦的离屏窗口，仅检查启动、桥接白名单、缓存读写、
跨服务端/跨班级缓存隔离和关闭隐藏。二次启动也只跑快速检查，不再重复整套动画。

需要联网时运行 `pnpm verify:desktop:online`，创建临时教师与临时班级，结束后删除。
不再自动探测并复用真实班级，也不会重置真实班级密码。Web 回归同样使用隔离的验证教师与班级。

`pnpm verify:desktop:visual`（或客户端启动器 `--visual`）才运行灵动岛动画、透明度、桌面截图等完整验收，
这类用例确实需要使用桌面。`verify:packaged` 也默认快速模式，显式传 `--visual` 才跑视觉验收。
视觉验收不适合在用户操作屏幕时自动运行。截图采集命令需要传入 `--visual`（或设置 `ELECTRON_SMOKE_MODE=visual`）。
结果记录模式和耗时；启动器设置超时，避免验证进程无限等待。

## 截图留档

截图分两套，各管一件事：

| 目录                | 谁在用                                                      | 谁产出                                                           |
| ------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------- |
| `docs/images/`      | **文档站、README、官网用的是同一份图**，页面上展示的都是它  | `capture-shots.mjs`（Web / 手机）+ 客户端冒烟（客户端 / 灵动岛） |
| `docs/screenshots/` | 回归留档，页面不展示；`verify:*` 的像素级断言比对的就是它们 | 各冒烟脚本自动写入（island / client / web-mobile 三组）          |

**展示图重新采集**（保证文档站与 README、官网用的是同一份图）：

```bash
pnpm dev:server                                                                    # 后端同时托管 Web 管理端
CAPTURE_OUT=docs/images,website/assets/shots node website/tools/capture-shots.mjs  # → web-*.jpg / mobile-*.jpg

# 客户端与灵动岛走的是冒烟脚本。它除了正片，还会顺手落一份「岛外留白对照图」
# （*-window.png / *-backdrop.png），所以先落到临时目录，再挑要用的拷进去。
ISLAND_SHOTS_DIR="$PWD/.cache/shots" ELECTRON_CLIENT_SHOTS_DIR="$PWD/.cache/shots" \
ELECTRON_SMOKE_ISLAND_ACCENT='#0a84ff' ELECTRON_SMOKE_ISLAND_STYLE=black \
  node packages/desktop-client/scripts/smoke.mjs --visual --online
cp .cache/shots/{island-*,client-*}.png docs/images/
rm -f docs/images/*-window.png docs/images/*-backdrop.png
cp docs/images/{island-*,client-*}.png website/assets/shots/       # 官网那份保持同步
```

**回归留档重新采集**（同一套冒烟，把输出指到留档目录）：

```bash
pnpm dev:server
ISLAND_SHOTS_DIR="$PWD/.cache/island-shots" \
ELECTRON_CLIENT_SHOTS_DIR="$PWD/.cache/client-shots" \
ELECTRON_SMOKE_ISLAND_ACCENT='#0a84ff' ELECTRON_SMOKE_ISLAND_STYLE=black \
  node packages/desktop-client/scripts/smoke.mjs --visual --online
```

> 展示图都是**逻辑像素 1×**（灵动岛的 268×44、424×230 就是这个数，不再乘 2），
> 页面按原始尺寸显示即可 —— 换图时别顺手放大，否则整页的尺寸对不上。
> 采集脚本会把窗口真的弹在屏幕上。客户端留档会**临时停掉 CSS 动画**再截图 ——
> 窗口被遮挡时 Chromium 冻结动画，而页面入场动画的起始帧是 `opacity: 0`，
> 不停掉的话截出来是**整片空白**（DOM 里文本齐全，只有图是空的）。
