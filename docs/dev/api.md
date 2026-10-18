---
title: REST API
description: 现行接口分组、关键路径和权限边界。
---

# REST API

API 前缀 /api，JWT 使用 Authorization: Bearer。成功/失败结构以 `lib/http.ts` 为准，
校验错误映射 422 VALIDATION_ERROR，表格体积超限为 413 IMPORT_TOO_LARGE。
全部挂载入口以 `modules/registry.ts` 为准；完整参数、返回类型、权限和枚举以模块的 module/schemas/service 与 shared 契约为准。
本页列常用入口，不重复复制每条路由实现。

## 身份与班级

| 方法与路径（省略 /api）                                                 | 行为及边界                                                     |
| ----------------------------------------------------------------------- | -------------------------------------------------------------- |
| POST /auth/login、/auth/class-login                                     | 员工/班级登录，共享登录限流；学生无账号                        |
| GET /auth/me；POST /auth/logout；PATCH /auth/password                   | 当前身份、退出、员工本人改密码                                 |
| GET/POST /classes；GET/PATCH/DELETE /classes/:id                        | 班级查询/管理，写入需 class:manage 与管理员业务断言            |
| PATCH /classes/:id/class-account、/classes/:id/head-teacher             | 班级凭据/班主任维护                                            |
| PUT /classes/:id/subject-teachers                                       | 任课关系设置，Course 为唯一来源                                |
| GET/PATCH /classes/:id/student-grade-query                              | 查看/修改班级个人成绩查询开关，班级端不能修改                  |
| GET/POST /classes/:id/students；DELETE /classes/:id/students/:studentId | 本班名单及维护，受名单功能权限和班级关系约束                   |
| /students、/teachers                                                    | 名单与账号 CRUD；读/写使用不同权限键，具体角色限制读取对应模块 |
| POST /teachers/:id/reset-password                                       | 指定新密码或默认重置；学生无对应接口                           |
| /permissions/me、/catalog、/groups、/users                              | 当前有效权限、目录、组与账号分组                               |

## 教学与文件

| 路径/动作                                                                                                  | 行为及边界                                                             |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| /courses                                                                                                   | 班级科目与任课关系                                                     |
| GET /schedules、/grid、/current、/active-week                                                              | 新关系模型的兼容投影，按班级范围读取                                   |
| POST/PATCH/DELETE /schedules[/:id]                                                                         | 兼容 CRUD，写新模型，不双写旧 Schedule                                 |
| POST /schedules/swap、/overlay、/scheduled；GET /schedules/scheduled；DELETE /schedules/scheduled/:id      | 换课、临时层、预定                                                     |
| /time-layouts；POST /time-layouts/:id/clone、/:id/import                                                   | 时间表 CRUD/克隆/导入，写入 timetable:manage                           |
| /class-plans；PUT /class-plans/:id/entries；PATCH /class-plans/:id/enabled                                 | 日课表 CRUD、整表保存、启用，写入 schedule:write + 班主任/管理员       |
| POST /class-plans/:id/clone、/class-plans/import、/class-plans/import/profile；GET /class-plans/:id/export | 复制、导入导出及完整档案导入                                           |
| /class-plan-groups；GET /class-plan-groups/selection；POST /class-plan-groups/select                       | 群组及当前/临时选择                                                    |
| /homeworks、/homeworks/bulk、/:id/status、/:id/submissions                                                 | 作业、批量、完成与未交；员工功能键+科目检查，班级端可录作业            |
| /notifications、/notifications/bulk、/days、/creators、/unread-count、/:id/read、/read-all                 | 通知、归档和已读；发布需 notification:publish，课堂紧急须确认          |
| POST /calls                                                                                                | 叫人，call:create + 范围检查                                           |
| /grades、/grades/bulk、/stats、/levels、/my、/overview、/collective、/student/:studentNo、/exams、/ranking | [成绩与隐私](../app/grades.md)，查询列表参数用 studentId，写入仍按科目 |
| /imports/template、/table/preview、/table/commit                                                           | 表格导入，按 kind 再检查角色、导入权限、班级和科目                     |
| /imports/class-plan/preview、/imports/class-plan                                                           | 旧预览与完整档案提交；提交走关系化导入                                 |
| /imports/time-layout[/:id]、/time-layout/preview                                                           | 时间配置兼容入口，写入/删除需 timetable:manage                         |
| GET /courseware、/courseware/:id、/:id/download                                                            | 课件目录/详情/下载；员工需 courseware:read，班级端按可见范围           |
| POST /courseware/upload、/:id/push；PATCH /courseware/:id/visibility；DELETE /courseware/:id               | 写入 courseware:write + 员工身份；本人文件、任课班级与可见范围限制     |
| GET /courseware/transfers；POST /courseware/transfers/:id/ack                                              | 班级端补领、逐设备回执                                                 |

## 设备、系统与运维

| 路径/动作                                                                                               | 行为及边界                                                           |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| POST /clients/heartbeat、/clients/commands/:id/ack                                                      | 登录设备心跳/回执，校验 deviceKey 和归属                             |
| GET /clients/devices；DELETE /clients/devices/:id                                                       | 设备读取/维护，分别检查功能键和范围                                  |
| POST /clients/commands                                                                                  | remote:control + 对应范围，白名单动作                                |
| POST /clients/updates                                                                                   | client:update，安装策略 immediate/after-school/idle                  |
| GET /update/check                                                                                       | 员工需 update:check；强制刷新另检查 update:force                     |
| GET /update/client/releases                                                                             | 缓存版本读取，按路由允许的读取权限                                   |
| POST /update/client/fetch、/update/client/releases；DELETE /update/client/releases/:version             | 安装包写入口统一 client:update                                       |
| GET /update/client/download/:version                                                                    | 已登录下载，不挂员工权限键，供班级端更新                             |
| /term；POST /term/auto；GET /term/holidays                                                              | 学期读取/编辑/假日建议，term:read/term:write                         |
| GET/PUT /term/promotion；POST /term/promotion/run                                                       | 升级计划、预览和执行，system:manage，执行还做业务校验                |
| /archives、/archives/transferred、/archives/transferred/:id/restore                                     | 历史归档与撤回转出，archive:manage；不提供创建归档代替年度升级的入口 |
| /database/status、/test-connection、/backups、/export、/import、/sqlite-file、/backup-schedule、/switch | database:manage；目标空库、快照及换库子进程保护                      |
| /system/settings、/autostart、/diagnostics                                                              | system:manage，非安装形态自启动返回不可用原因                        |
| /ai/settings、/interpret、/audit                                                                        | ai:manage/ai:use；只解析待确认动作，密钥只进不出                     |
| /dashboard/summary、/dashboard/term                                                                     | 按范围读取看板与周次                                                 |

探针 /healthz 和 /readyz 不带 API 前缀；/api/health 提供版本与模块详情。
课件上传是原始文件流，512 MB 限制独立于表格 JSON 的 12 MB 限制；metadata 走上传查询 schema。
心跳 agentProtocol:2 使用统一响应 data，旧协议兼容字段只用于升级过渡。
更多说明见[权限](permissions.md)、[实时事件](realtime.md)、[数据模型](data-model.md)。
