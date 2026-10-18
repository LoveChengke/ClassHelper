---
title: 功能与源码索引
description: 当前功能说明、开发契约与实现入口，避免重复维护多份产品说明书。
---

# 功能与源码索引

本文为现行文档入口。功能规则在对应章节维护；源码行为发生变化时，同步修改对应章节。
旧任务书、历史审查结论和旧构建验收数字不作为当前功能依据。

| 主题               | 文档                                                                                                     | 工作区源码入口                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 架构与模块         | [架构总览](dev/architecture.md)                                                                          | `server/src/modules/registry.ts`                                           |
| 日课表、作息与轮换 | [课表](app/schedules.md)                                                                                 | `server/src/lib/class-plan.ts`、`modules/class-plans/`                     |
| 学生、教师、班级   | [班级、学生与教师](app/classes.md)                                                                       | `server/src/lib/access.ts`、`modules/students/`                            |
| 权限组与岗位范围   | [角色与权限](dev/permissions.md)                                                                         | `shared/src/permissions.ts`、`server/src/lib/permission-scope.ts`          |
| 作业               | [作业](app/homeworks.md)                                                                                 | `server/src/modules/homeworks/`                                            |
| 通知与叫人         | [通知](app/notifications.md)、[叫人](app/calls.md)                                                       | `server/src/modules/notifications/`、`calls/`                              |
| 课件               | [课件上传与传输](app/courseware.md)                                                                      | 三端 `courseware` 模块与 `shared/src/courseware.ts`                        |
| 成绩与隐私         | [成绩](app/grades.md)                                                                                    | `server/src/modules/grades/`                                               |
| 经典与自定义常驻岛 | [灵动岛](app/island.md)                                                                                  | `desktop-client/src/island/LayoutIslandApp.vue`、`CustomIslandRuntime.vue` |
| 导入               | [表格与课表导入](app/imports.md)                                                                         | `server/src/modules/imports/`、`class-plans/profile-import.service.ts`     |
| API 与实时         | [REST API](dev/api.md)、[实时事件](dev/realtime.md)                                                      | `server/src/modules/`、`realtime/`、`shared/src/constants.ts`              |
| 数据模型与迁移     | [数据模型](dev/data-model.md)                                                                            | `server/prisma/schema.prisma`、`migrations/`                               |
| 数据库管理         | [数据库管理](management/database.md)、[MySQL](management/mysql.md)                                       | `server/src/lib/snapshot.ts`、`modules/database/`                          |
| 安装与升级         | [生产部署](management/production.md)、[Linux](management/linux-deploy.md)、[更新](management/upgrade.md) | `deploy/`、`scripts/dist-server.mjs`                                       |
| 验证与发布         | [验收](dev/testing.md)、[发布](dev/release.md)                                                           | 根 `package.json`、`scripts/`、`.github/workflows/`                        |
| 当前实现约定       | [实现约定](dev/implementation.md)                                                                        | 课表、升级、岛、课件与设备维护的关键边界                                   |

表中的包路径均相对仓库 `packages/`；脚本和部署目录相对仓库根。
源码总入口：[GitHub 仓库](https://github.com/LoveChengke/ClassHelper)。
代理工程规则见 [AGENTS.md](https://github.com/LoveChengke/ClassHelper/blob/master/AGENTS.md)。
ClassIsland 仅保留离线 JSON 导入与设计参考，在线联动插件及相关接口已退役。
