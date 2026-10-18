---
title: 开发文档
description: ClassHelper的架构、接口、数据模型、权限、动效层，以及验收与发版流程。
---

# 开发文档

ClassHelper是一个 **pnpm monorepo**，一份代码产出四个交付物：

| 交付物     | 位置                      | 形态                                                            |
| ---------- | ------------------------- | --------------------------------------------------------------- |
| 后端服务   | `packages/server`         | Express 5 + Prisma 7 + Socket.IO，接口前缀 `/api`               |
| Web 管理端 | `packages/web-admin`      | Vue 3 + Vite + Element Plus（教师 / 管理员用，PWA 可安装）      |
| 桌面客户端 | `packages/desktop-client` | Electron + Vue 3（ClassHelper 班级端 / 教室机器，含灵动岛浮窗） |
| 共享契约   | `packages/shared`         | 三端共用的类型 / 常量 / 权限 / 工具函数                         |

核心链路：

```
教师在 Web 端发布内容
        │  REST API（JWT 鉴权）
        ▼
   后端服务（Express + Prisma）
        │  写库 + 按班级房间广播
        ▼
 Socket.IO ──► class:{classId} 房间 ──► 学生桌面客户端实时更新 UI（含灵动岛）

                                  ▲                          │
                                  └──── 老师下发的提醒 ◄──────┘
```

## 这一章有什么

| 页面                                         | 内容                                             |
| -------------------------------------------- | ------------------------------------------------ |
| [架构总览](architecture.md)                  | 目录结构、技术栈、模块化设计、几条贯穿全局的约定 |
| [REST API](api.md)                           | 接口分组、常用路径与权限边界                     |
| [实时事件（Socket.IO）](realtime.md)         | 事件清单、房间规则、新增事件要改哪三处           |
| [数据模型](data-model.md)                    | 模型职责、迁移与快照边界                         |
| [角色与权限](permissions.md)                 | 权限矩阵与实现位置                               |
| [动效层与主题](motion.md)                    | beUI 令牌、CSS `linear()` 弹簧、深色主题         |
| [灵动岛设计令牌](winisland-design-tokens.md) | 岛逐项的几何 / 配色 / 排版 token                 |
| [验收与测试](testing.md)                     | 隔离验收、后台冒烟与显式视觉模式                 |
| [版本迭代与发布](release.md)                 | 改版本号、出安装包、发 Release 的完整流程        |

## 仓库里另外两份文档

- **[功能与源码索引](../reference.md)** —— 各帮助章节与源码入口的统一索引；功能行为在对应章节维护，按源码核验。
- **[`AGENTS.md`](https://github.com/LoveChengke/classhelper/blob/master/AGENTS.md)** ——
  工程约定与开发环境注意事项，**改代码前必读**。里面每一条硬约定都对应一处容易踩空的地方，
  规则与实际实现冲突时应查源码并同步修正。
