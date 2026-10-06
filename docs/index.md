---
title: 首页
description: 班级小助手（Class Helper）的官方文档：安装部署、功能说明、运维手册与开发参考。
---

# 班级小助手文档

班级小助手（Class Helper）是给中小学班级用的一套信息管理系统。**一份代码，四个交付物**：
装在服务器上的后端、给老师用的 Web 管理端、装在教室机器的桌面客户端（学生端 / 教室大屏），
以及装在 [ClassIsland](https://classisland.tech) 上的联动插件。

<p class="ch-tagline">
老师发一条通知，教室那台机器上的灵动岛和 ClassIsland 会同时弹出来；学生打开客户端就能看到当天的课表和作业。
</p>

<div class="ch-cards">
  <a class="ch-card" href="get-started/index.md">
    <span class="ch-card-title">第一次装</span>
    <span class="ch-card-desc">从零把服务端、管理端、学生端和 ClassIsland 插件跑起来，大约半小时。</span>
  </a>
  <a class="ch-card" href="app/index.md">
    <span class="ch-card-title">已经在用了</span>
    <span class="ch-card-desc">课表、作业、通知、叫人、成绩、灵动岛，每一项具体怎么用。</span>
  </a>
  <a class="ch-card" href="management/index.md">
    <span class="ch-card-title">负责运维</span>
    <span class="ch-card-desc">部署形态怎么选、备份与恢复、换数据库、升级与回滚。</span>
  </a>
  <a class="ch-card" href="dev/index.md">
    <span class="ch-card-title">要改代码</span>
    <span class="ch-card-desc">架构、接口、数据模型、动效层，以及版本迭代与发布流程。</span>
  </a>
</div>

## 它长什么样

<div class="ch-shots">
  <img src="screenshots/client/01-schedule.png" alt="桌面客户端 · 课表「今天」时间轴" />
  <img src="screenshots/island/island-5-clicked.png" alt="灵动岛 · 点开通知后的详情卡" />
  <img src="screenshots/web-mobile/mobile-2-notifications.png" alt="Web 管理端 · 手机上的通知发布页" />
</div>

> 这些图都是脚本把程序真的跑起来截的，不是示意图。采集方式见 [验收与测试](dev/testing.md)。

## 目录

| 章节                             | 里面有什么                                               | 谁看                 |
| -------------------------------- | -------------------------------------------------------- | -------------------- |
| [快速上手](get-started/index.md) | 系统要求、安装、第一次配置、发布第一条内容               | 第一次部署的人       |
| [应用帮助](app/index.md)         | 逐个功能怎么用，以及行为上的约定（什么时段弹、谁看得见） | 老师、班主任、管理员 |
| [管理运维](management/index.md)  | 部署形态、Linux 运维命令、备份、换库、升级               | 管服务器的人         |
| [开发文档](dev/index.md)         | 架构、REST API、实时事件、数据模型、权限、发布流程       | 改代码的人           |
| [常见问题](faq.md)               | 装不上、连不上、改了不生效……                             | 所有人               |

## 这套系统的三件事

**一、老师发，教室弹。** Web 端发布的内容通过 Socket.IO 按班级房间广播，客户端与灵动岛实时更新；
落到 ClassIsland 上的那部分走设备令牌的独立通道，走 HTTP 上报，不依赖教室机器的网络环境有多好。

**二、上课时段不打扰。** 「上课时段」由课表实时判定，普通通知只进队列、下课自动补弹，
紧急通知和叫人则立刻弹出来 —— 服务端强制拦截，绕开界面直接调接口一样会被拦。

**三、离线可用。** 客户端先写 IndexedDB，断网时回退缓存并在顶部提示；
恢复连接后自动重新拉取，教室网络抖一下不会让大屏变白。

## 关于本文档

- 文档站的源码就在仓库里（`docs/`），用 [docfx](https://github.com/dotnet/docfx) 生成，发布在 GitHub Pages 上。
  每页右下角有「在 GitHub 上编辑这一页」，发现写错或写漏可以直接改。
- 版本号取自仓库根 `package.json`，显示在顶栏，与 [Releases](https://github.com/LoveChengke/classhelper/releases) 对齐。
- 想在自己机器上预览：`pnpm docs:build --serve`。
