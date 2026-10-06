---
title: ClassIsland 插件
description: 联动插件的契约、镜像为什么要带节次时间、上课时段暂存，以及部署与调试。
---

# ClassIsland 插件

源码在 `packages/classisland-plugin/`，是一个 **.NET 8 / C#** 的 ClassIsland 插件
（ClassIsland 插件 API 2.0）。它**独立于 pnpm workspace**，不参与 `pnpm install`。

## 三条链路

```
ClassIsland（教室机器）
    │  ① 上报：状态 + 课表 + 节次时间（每次上报顺带取回一条待弹提醒）
    ▼
/api/integrations/classisland/report      ← X-ClassIsland-Token（设备令牌，非 JWT）
    │
    │  ② 下发：老师在 Web 端发提醒 → 落库 → 插件下次上报时取回 → ClassIsland 全屏弹出 → ack
    ▼
/api/integrations/classisland/pending、/ack

    │  ③ 镜像（可选）：服务端把本班课表下发，插件在 ClassIsland 里新建一份档案课表
    ▼
/api/integrations/classisland/class-plan
```

## 为什么走 HTTP 而不是 IPC

ClassIsland 的跨进程 IPC 数据质量不足以还原课表。插件内部**直接读**
`ILessonsService`（课程状态）与 `IProfileService`（档案课表）最准。

与后端之间用「**上报即拉取**」：每次上报的返回值里顺带带一条待弹出的提醒 ——
插件因此**不需要 WebSocket 依赖**，故障面更小，而且**上报间隔本身就是心跳**。

提醒是**轮询取回**的（默认最多 10 秒延迟，设置页「提醒轮询间隔」可调到 5 秒）。

## 设备令牌

- 令牌是**设备级**的，不是用户级；
- 插件在本机保存明文，服务端只存 **sha256** 与一个前缀提示（`chci_xxxxxxxx`）用于人眼识别；
- 同一班级下按 `deviceKey`（机器码）唯一 —— 插件重装后带同一 `deviceKey` 会**自动重绑**到原记录，
  不会在设备列表里堆重复项；
- 关闭设备的「启用」开关后，该设备的上报与下发一律 403。

## 提醒的排队规则

| 提醒类型                                               | 上课时段                     | 下课 / 放学 |
| ------------------------------------------------------ | ---------------------------- | ----------- |
| 通知类（`kind=notification`：通知发布页 / 联动页下发） | **暂存不弹**                 | 自动补弹    |
| 主动通知：紧急提醒、**叫人**（`kind=call`）            | **立刻弹**（老师正在等学生） | 立刻弹      |

插件侧的实现在 `ClassHelperNotificationProvider`（`_deferred` + `FlushDeferred`，订阅课程事件）；
客户端侧的实现在 `renderer/island/bridge.ts`。**改这条规则要两端一起改。**

暂存期间**不回执**，所以服务端会一直保留着待提醒；`ClassIslandPush.expiresAt` 到期后不再补发
（避免学生几天后突然弹出旧提醒）。

## 镜像：为什么必须带 `startTime` / `endTime`

ClassIsland 的 `ClassPlan.Classes[i]` **强制与时间表里第 i 个 `TimeType == 0`（上课）的时间点对齐**。

所以镜像下发时，每一条课目都要带上自己的 `startTime` / `endTime`。

> **少一个时间点，整份课表就会错位** —— 而且表现为"课表看着有内容、每节课都对不上"，
> 极难排查。这是插件契约里最容易踩的坑。

另外镜像进 ClassIsland 的课表还要**带课间**：每两节之间补一段（上一节下课 → 下一节上课），
**最后一节之后不补**（放学）。实现见 `ClassPlanWriter.BuildTimeLayout`（自己按课目时间算），
服务端合成节次时间表用的是同一口径。

## 上报课表：单向还是双向

**双向对齐**。插件每次全量上报时，服务端只清理「`source='classisland'` 且本次未再上报」的行：

- 老师在 ClassIsland 里删掉 / 挪动一节 → 小助手这边跟着同步；
- 老师在小助手这边手排的课 → **一律不删**。

merge 的去重键是「星期 + 开始时间 + 单双周」。导入时**不要覆盖 `weekStart` / `weekEnd`** ——
插件上报契约里没有周次范围，硬写"整学期"会把老师设的「第 1~10 周」抹掉。

## 单双周的映射

ClassIsland 的 `WeekCountDiv` / `WeekCountDivTotal` ⇄ 本项目的 `ALL / ODD / EVEN`，
走 `@classhelper/shared` 的 `weekParityFromDiv` / `weekDivFromParity` ——
**服务端与插件共用同一份语义**，两边不会各算各的。

## 代理：本地地址强制直连

`ClassHelperClient` 里有一个 `LocalAwareProxy`：对本地 / 内网地址**强制直连**，
不走系统代理。

原因：教室机器上如果开了系统代理，填好令牌后表现为"立刻 HTTP 404"（其实是代理返回的错误页）。
`pnpm verify:classisland-plugin` 有 4 项断言盯着这段逻辑，别删。

## 构建、打包与验收

```bash
pnpm build:classisland-plugin    # 编译（.NET 8；缓存与临时目录自动指到仓库内 .cache/）
pnpm dist:classisland-plugin     # 打包 .cipx 并归集到 releases/classisland-plugin/<版本>/
pnpm verify:classisland-plugin   # 静态契约校验（不需要 .NET，不需要服务端）
```

`verify:classisland-plugin` 会逐项校验：清单一致性、注册完整性、
**C# DTO ↔ 服务端 zod 与路由的字段对齐**，以及已修复坑的护栏。

### 那个预期内的编译警告

全量编译会有 **1 个警告 `AVLN3001`**：设置页只有 DI 构造函数、没有公开无参构造。
本插件走的是编译期 XAML + ClassIsland 的 DI 实例化，**加个无参构造反而会把 DI 弄坏**。
别为了消警告去改它。

## 部署到教室机器

```powershell
# 1) 完全退出 ClassIsland（它会锁住 DLL）
Get-Process ClassIsland.Desktop | Stop-Process -Force
# 2) 覆盖插件 DLL（**不要覆盖 Settings.json**，那里存着服务器地址与设备令牌）
Copy-Item packages\classisland-plugin\bin\Release\ClassHelper.ClassIslandPlugin.dll `
          D:\Classisland\data\Plugins\classhelper.classisland.bridge\ -Force
# 3) 重新启动
Start-Process D:\Classisland\ClassIsland.exe -WorkingDirectory D:\Classisland
```

改配置要在 **ClassIsland 退出时**改：运行中改会被内存里的副本随时回写覆盖。

### 读日志要用 GBK

.NET 的控制台输出是**系统 ANSI（GBK）**编码。用 UTF-8 读会变成乱码，
**中文关键字一条都搜不到**（只能搜到 ASCII 的类名）：

```powershell
[System.IO.File]::ReadAllLines($path, [System.Text.Encoding]::GetEncoding(936))
```

日志文件被运行中的进程占用时，先 `Copy-Item` 一份再读。

## 真机验收链路

`pnpm verify:classisland`（需要后端在跑）会真的走一遍：设备令牌 → 上报 → 提醒下发与回执 →
镜像契约 → 幽灵行清理。

> 这个脚本开头会先**抽干本班的历史积压提醒**。因为待提醒接口是「本班全部未确认提醒，
> 按时间升序取前 20 条」，而其他冒烟会真的往演示班发通知 —— 攒够 20 条之后，
> 本脚本刚发的提醒会被挤出窗口，表现为"待提醒里找不到刚发的那条"，跟代码对不对毫无关系。
> **别把那个 drain 删掉。**
