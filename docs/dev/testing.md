---
title: 验收与测试
description: 五套验收脚本怎么跑、覆盖什么、哪些用例是脆弱的，以及怎么判断失败是不是真回归。
---

# 验收与测试

这个仓库的验收方式是**跑真东西**：真的起后端、真的开 Electron 窗口、真的点击菜单、
真的发一条通知。不是单元测试，是端到端回归。

## 五套脚本

| 命令                             | 覆盖                                                                             | 需要什么                    |
| -------------------------------- | -------------------------------------------------------------------------------- | --------------------------- |
| `pnpm verify:e2e`                | 后端 + 实时推送 + RBAC 越权 + 上课时段 + 导入 + 班级账号 + 数据库管理 + 更新检查 | **后端已启动**              |
| `pnpm verify:web`                | Web 管理端真实点击回归（Electron 驱动）                                          | 后端已启动 + Web 产物已构建 |
| `pnpm verify:desktop`            | 客户端冒烟（Electron，无人工点击）                                               | 已构建的客户端产物          |
| `pnpm verify:packaged`           | 对**打包后 / 已安装**的客户端 EXE 复跑同一套冒烟（`--exe` 指定路径）             | 打包产物                    |
| `pnpm verify:classisland`        | 设备令牌 / 上报 / 提醒下发与回执 / 镜像契约 / 幽灵行清理                         | 后端已启动                  |
| `pnpm verify:classisland-plugin` | 插件静态契约（清单一致性 / 注册完整性 / C# DTO ↔ 服务端 zod 与路由）             | 不需要 .NET，也不需要后端   |

条目数由脚本自行统计并打印（`=== 结果：N/N 项通过 ===`），**文档里不写死容易过期的总数** ——
每次跑完看脚本输出。

另外三套是"门禁"而不是验收：`pnpm typecheck`、`pnpm lint`、`pnpm check:icons`。

### 一次完整的交付前检查

```bash
pnpm lint                # ESLint，0 error 是底线
pnpm typecheck           # 全仓库类型检查（含 vue-tsc）

pnpm dev:server          # 另开一个终端
pnpm verify:e2e
pnpm verify:classisland
pnpm verify:classisland-plugin

pnpm build:desktop && pnpm verify:desktop
pnpm build && pnpm verify:web
```

改动涉及打包/交付形态时，再加 `pnpm dist:all` 与
`pnpm verify:packaged --exe "<客户端路径>"`（**开发产物通过不等于用户机器上的副本通过**）。

## 失败时先别改代码

下面这些用例**不是回归**，遇到时先看条件。完整清单在 `AGENTS.md` 的「已知脆弱用例」表。

| 用例                                                      | 触发条件                                                                                                                                         |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `verify:desktop`「真实通知链路」「灵动岛标为已读」等 3 项 | 要求**当前不在上课时段**。种子课表恰有课正在进行时，客户端会**正确地**把普通通知暂存到下课 —— 这三项就会红（日志里会写 `客户端判定上课中=true`） |
| `verify:e2e`「上课状态接口（at=周一 08:10）」             | 种子把周一第 1 节限制在第 1 周，且用例把 `2026-09-07` 当第 1 周。`.env` 的 `TERM_START_DATE` 对齐即可全绿                                        |
| `verify:web`「课表科目为全校统一目录」                    | 种子给每个班建满了全部科目，下拉里就没有可自动建课的「统一科目」分组                                                                             |
| `verify:desktop`「课表今天时间轴」                        | 凌晨约 00:00–03:00 时「已结束」探针被夹紧成 0 长度而被过滤                                                                                       |
| `verify:desktop`「作业看板全屏自适应」                    | 演示数据某天有 6 条长作业、而冒烟窗口只有约 543px 高时，缩放被下限 0.45 钳住 → 必然溢出                                                          |
| 岛交互 / 岛动画 / 岛截图留档                              | **AI 会话里会间歇性失败**：置顶透明小窗的 rAF 被限流、形变采样抓不到帧。**先原样重跑一次再动手改**                                               |

## 大面积报「登录失败 / 401」时

先核对本机 `teacher1` 的密码 —— 本机实测可能被改成了 `123456`，不是种子默认的 `teacher123`
（原因是「修改密码」弹窗留空会落到默认初始密码）。**处理方式是用环境变量传实际凭据，不要去改数据。**

两个演示账号的口令**不一定一起漂**，所以不能简单地全局替换。

| 脚本              | 覆盖凭据的方式                                                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `verify:desktop`  | `set "ELECTRON_SMOKE_USER=teacher1" && set "ELECTRON_SMOKE_PASSWORD=123456" && pnpm verify:desktop`                           |
| `verify:packaged` | 同上（`ELECTRON_SMOKE_*`）                                                                                                    |
| `verify:web`      | `set "UI_SMOKE_USER=teacher1" && set "UI_SMOKE_PASS=123456" && pnpm verify:web`（另有 `UI_SMOKE_ADMIN*`）                     |
| `verify:e2e`      | **不支持环境变量**，需用临时副本替换（且副本必须放在 `packages/server/scripts/` 里，否则 `import 'socket.io-client'` 会失败） |

## 冒烟会真的动你的屏幕

`verify:web` / `verify:desktop` / `verify:packaged` 会**真的弹窗口**、真的发通知、真的移动鼠标：

- 跑的时候别动键鼠；
- 验证实例的灵动岛是**洋红主题色**（`#e91e8c`），一眼可以与你自己客户端那个区分开。
  两条反馈里的"屏幕上出现了第二个灵动岛""点它反应不对"都源于这个叠影；
- 冒烟会往演示班发几条「张老师 · _自检_」通知，用完即删；中途被 kill 会留下残条。

## 截图留档

截图分两套，各管一件事：

| 目录                | 谁在用                                                      | 谁产出                                                                |
| ------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------- |
| `docs/images/`      | **文档站、README、官网用的是同一份图**，页面上展示的都是它  | `capture-shots.mjs`（Web / 手机）+ 客户端冒烟（客户端 / 灵动岛）      |
| `docs/screenshots/` | 回归留档，页面不展示；`verify:*` 的像素级断言比对的就是它们 | 各冒烟脚本自动写入（island / client / web-mobile / classisland 四组） |

**展示图重新采集**（保证文档站与 README、官网用的是同一份图）：

```bash
pnpm dev:server                                                                    # 后端同时托管 Web 管理端
CAPTURE_OUT=docs/images,website/assets/shots node website/tools/capture-shots.mjs  # → web-*.jpg / mobile-*.jpg

# 客户端与灵动岛走的是冒烟脚本。它除了正片，还会顺手落一份「岛外留白对照图」
# （*-window.png / *-backdrop.png），所以先落到临时目录，再挑要用的拷进去。
ISLAND_SHOTS_DIR="$PWD/.cache/shots" ELECTRON_CLIENT_SHOTS_DIR="$PWD/.cache/shots" \
ELECTRON_SMOKE_ISLAND_ACCENT='#0a84ff' ELECTRON_SMOKE_ISLAND_STYLE=black \
ELECTRON_SMOKE_USER=teacher1 ELECTRON_SMOKE_PASSWORD=123456 \
  node packages/desktop-client/scripts/smoke.mjs
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
ELECTRON_SMOKE_USER=teacher1 ELECTRON_SMOKE_PASSWORD=123456 \
  node packages/desktop-client/scripts/smoke.mjs
```

> 展示图都是**逻辑像素 1×**（灵动岛的 268×44、424×230 就是这个数，不再乘 2），
> 页面按原始尺寸显示即可 —— 换图时别顺手放大，否则整页的尺寸对不上。
> 采集脚本会把窗口真的弹在屏幕上。客户端留档会**临时停掉 CSS 动画**再截图 ——
> 窗口被遮挡时 Chromium 冻结动画，而页面入场动画的起始帧是 `opacity: 0`，
> 不停掉的话截出来是**整片空白**（DOM 里文本齐全，只有图是空的）。
