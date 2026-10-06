---
title: 开发文档
description: 班级小助手的架构、接口、数据模型、权限、动效层，以及验收与发版流程。
---

# 开发文档

班级小助手是一个 **pnpm monorepo**，一份代码产出四个交付物：

| 交付物               | 位置                          | 形态                                                            |
| -------------------- | ----------------------------- | --------------------------------------------------------------- |
| 后端服务             | `packages/server`             | Express 5 + Prisma 7 + Socket.IO，接口前缀 `/api`               |
| Web 管理端           | `packages/web-admin`          | Vue 3 + Vite + Element Plus（教师 / 管理员用，PWA 可安装）      |
| 桌面客户端           | `packages/desktop-client`     | Electron + Vue 3（学生端 / 教室机器，含灵动岛浮窗）             |
| 共享契约             | `packages/shared`             | 三端共用的类型 / 常量 / 权限 / 工具函数                         |
| ClassIsland 联动插件 | `packages/classisland-plugin` | .NET 8 / C#（**独立于 pnpm workspace**，不参与 `pnpm install`） |

核心链路：

```
教师在 Web 端发布内容
        │  REST API（JWT 鉴权）
        ▼
   后端服务（Express + Prisma）
        │  写库 + 按班级房间广播
        ▼
 Socket.IO ──► class:{classId} 房间 ──► 学生桌面客户端实时更新 UI（含灵动岛）

ClassIsland（教室机器）──► 联动插件 ──► /api/integrations/classisland/*（设备令牌鉴权）
                                  ▲                          │
                                  └──── 老师下发的提醒 ◄──────┘
```

## 这一章有什么

| 页面                                         | 内容                                             |
| -------------------------------------------- | ------------------------------------------------ |
| [架构总览](architecture.md)                  | 目录结构、技术栈、模块化设计、几条贯穿全局的约定 |
| [REST API](api.md)                           | 全部接口一览（方法 / 路径 / 权限）               |
| [实时事件（Socket.IO）](realtime.md)         | 事件清单、房间规则、新增事件要改哪三处           |
| [数据模型](data-model.md)                    | 14 张表、迁移历史、跨库约定                      |
| [角色与权限](permissions.md)                 | 权限矩阵与实现位置                               |
| [动效层与主题](motion.md)                    | beUI 令牌、CSS `linear()` 弹簧、深色主题         |
| [ClassIsland 插件](classisland-plugin.md)    | 插件契约、镜像为什么要带 `startTime`、部署与调试 |
| [灵动岛设计令牌](winisland-design-tokens.md) | 岛逐项的几何 / 配色 / 排版 token                 |
| [验收与测试](testing.md)                     | 五套验收脚本怎么跑、哪些用例是脆弱的             |
| [版本迭代与发布](release.md)                 | 改版本号、出安装包、发 Release 的完整流程        |

## 仓库里另外两份文档

- **[完整参考](../reference.md)** —— 产品说明书 + 验收对照表（原 README 全文），
  功能行为的**权威来源**；仓库首页那份 README 是精简后的门面页，细节都在这里。
- **[`AGENTS.md`](https://github.com/LoveChengke/classhelper/blob/master/AGENTS.md)** ——
  写给 AI 编码代理的工程约定与本机踩坑记录，**改代码前必读**。
  里面每一条硬约定都对应一次真实的翻车，比代码注释更值得先看一遍。
