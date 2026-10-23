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

| 方法与路径（省略 /api）                                                 | 行为及边界                                                                        |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| POST /auth/login、/auth/class-login                                     | 员工/班级登录，共享登录限流；学生无账号                                           |
| GET /auth/me；POST /auth/logout；PATCH /auth/password                   | 当前身份、退出、员工本人改密码                                                    |
| GET/POST /classes；GET/PATCH/DELETE /classes/:id                        | 班级查询/管理，读取 class:read；写入 class:manage 与目标范围，创建/删除需全校范围 |
| PATCH /classes/:id/class-account、/classes/:id/head-teacher             | 班级凭据/班主任维护                                                               |
| PUT /classes/:id/subject-teachers                                       | 任课关系设置，Course 为唯一来源                                                   |
| GET/PATCH /classes/:id/student-grade-query                              | 查看/修改班级个人成绩查询开关，班级端不能修改                                     |
| GET/POST /classes/:id/students；DELETE /classes/:id/students/:studentId | 本班名单及维护，受名单功能权限和班级关系约束                                      |
| /students、/teachers                                                    | 名单与账号 CRUD；读/写使用不同权限键，具体角色限制读取对应模块                    |
| POST /teachers/:id/reset-password                                       | 指定新密码或默认重置；学生无对应接口                                              |
| /permissions/me、/catalog、/groups、/users                              | 当前有效权限、目录、组与账号分组                                                  |

## 教学与文件

| 路径/动作                                                                                                  | 行为及边界                                                                           |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| /courses                                                                                                   | 班级科目与任课关系                                                                   |
| GET /schedules、/grid、/current、/active-week                                                              | 新关系模型的兼容投影，按班级范围读取                                                 |
| POST/PATCH/DELETE /schedules[/:id]                                                                         | 兼容 CRUD，写新模型，不双写旧 Schedule                                               |
| POST /schedules/swap、/overlay、/scheduled；GET /schedules/scheduled；DELETE /schedules/scheduled/:id      | 换课、临时层、预定                                                                   |
| /time-layouts；POST /time-layouts/:id/clone、/:id/import                                                   | 时间表 CRUD/克隆/导入，写入 timetable:manage                                         |
| /class-plans；PUT /class-plans/:id/entries；PATCH /class-plans/:id/enabled                                 | 日课表 CRUD、整表保存、启用，写入 schedule:write + 班主任/管理员                     |
| POST /class-plans/:id/clone、/class-plans/import、/class-plans/import/profile；GET /class-plans/:id/export | 复制、导入导出及完整档案导入；导入另需 import:schedule                               |
| /class-plan-groups；GET /class-plan-groups/selection；POST /class-plan-groups/select                       | 群组及当前/临时选择                                                                  |
| /homeworks、/homeworks/bulk、/:id/status、/:id/submissions                                                 | 作业、批量、完成与未交；员工功能键+科目检查，班级端可录作业                          |
| /notifications、/notifications/bulk、/days、/creators、/unread-count、/:id/read、/read-all                 | 通知、归档和已读；发布需 notification:publish，课堂紧急须确认                        |
| POST /calls                                                                                                | 叫人，call:create + 范围检查                                                         |
| /grades、/grades/bulk、/stats、/levels、/my、/overview、/collective、/student/:studentNo、/exams、/ranking | [成绩与隐私](../app/grades.md)，查询列表参数用 studentId，写入仍按科目               |
| /imports/template、/table/preview、/table/commit                                                           | 表格导入，按 kind 再检查对应导入键、管理键、班级和科目                               |
| /imports/class-plan/preview、/imports/class-plan                                                           | 预览与提交均需 import:schedule + schedule:write；提交走关系化导入                    |
| /imports/time-layout[/:id]、/time-layout/preview                                                           | 时间配置兼容入口，导入需 import:schedule + timetable:manage，删除需 timetable:manage |
| GET /class-plans/profile?classId=                                                                          | 完整档案导出，按班级范围读取，保留时间点与课表关联                                   |
| GET /courseware、/courseware/:id、/:id/download                                                            | 课件目录/详情/下载；员工需 courseware:read，班级端按可见范围                         |
| POST /courseware/upload、/:id/push；PATCH /courseware/:id/visibility；DELETE /courseware/:id               | 写入 courseware:write + 员工身份；本人文件、任课班级与可见范围限制                   |
| GET/POST /courseware/folders；PATCH /courseware/:id/folder                                                 | 员工 courseware:write；目录与课件均限本人                                            |
| GET /courseware/transfers；POST /courseware/transfers/:id/ack                                              | 班级端补领、逐设备回执                                                               |

## 设备、系统与运维

| 路径/动作                                                                                               | 行为及边界                                                                       |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| POST /clients/heartbeat、/clients/commands/:id/ack                                                      | 登录设备心跳/回执，校验 deviceKey 和归属                                         |
| POST /clients/update-progress                                                                           | 设备上传下载、校验、等待、安装和失败状态，校验设备班级归属                       |
| GET /clients/devices；DELETE /clients/devices/:id                                                       | 设备读取/维护，分别检查功能键和范围                                              |
| POST /clients/commands                                                                                  | remote:control + 对应范围，白名单动作                                            |
| POST /clients/updates                                                                                   | client:update，安装策略 immediate/after-school/idle                              |
| GET /update/check                                                                                       | 员工需 update:check；强制刷新另检查 update:force                                 |
| GET /update/client/releases                                                                             | 缓存版本读取，按路由允许的读取权限                                               |
| POST /update/client/fetch、/update/client/releases；DELETE /update/client/releases/:version             | 安装包写入口统一 client:update                                                   |
| GET /update/client/download/:version                                                                    | 已登录下载，不挂员工权限键，供班级端更新                                         |
| /term；POST /term/auto；GET /term/holidays                                                              | 学期读取/编辑/假日建议，term:read/term:write                                     |
| GET/PUT /term/promotion；POST /term/promotion/run                                                       | 升级计划与执行，promotion:manage + 全校范围，执行要求确认与计划哈希              |
| /archives、/archives/transferred、/archives/transferred/:id/restore                                     | 历史归档需 archive:manage 全校范围；撤回转出需 roster:manage；不提供手动创建归档 |
| /database/status、/test-connection、/backups、/export、/import、/sqlite-file、/backup-schedule、/switch | database:manage；目标空库、快照及换库子进程保护                                  |
| /system/settings、/autostart、/diagnostics                                                              | system:manage，非安装形态自启动返回不可用原因                                    |
| /ai/settings、/interpret、/audit                                                                        | ai:manage/ai:use；只解析待确认动作，密钥只进不出                                 |
| /dashboard/summary、/dashboard/term                                                                     | 按范围读取看板与周次                                                             |

探针 /healthz 和 /readyz 不带 API 前缀；/api/health 提供版本与模块详情。
课件上传是原始文件流，512 MB 限制独立于表格 JSON 的 12 MB 限制；metadata 走上传查询 schema。
心跳 agentProtocol:2 使用统一响应 data，旧协议兼容字段只用于升级过渡。
更多说明见[权限](permissions.md)、[实时事件](realtime.md)、[数据模型](data-model.md)。

## 权限治理与学生年度流程

| 方法与路径（省略 /api）                              | 参数与权限边界                                                                                                                          |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| GET /permissions/scopes                              | permission:manage；返回可选年级、部建议和计划年级                                                                                       |
| GET /permissions/groups/:id/members                  | permission:manage；包含显式分组及角色默认回落的生效成员                                                                                 |
| GET /permissions/audit?page=&pageSize=               | permission:manage；分页操作人、目标、前后 JSON，pageSize 最大 100                                                                       |
| POST/PATCH/DELETE /permissions/groups[/:id]          | permission:manage；范围校验与防提权；默认组仅 ADMIN 可改，内置组不可删                                                                  |
| PUT /permissions/users/:id/groups                    | groupIds 整体替换；默认组角色须匹配，空数组恢复角色默认模板；禁止越键越范围                                                             |
| GET /students?status=&includeArchived=               | roster:read；默认 active，归档单独筛选；历史状态不会再被在读条件覆盖                                                                    |
| POST /students                                       | roster:manage；仅 active/inactive，学号重复 409，班级不得归档                                                                           |
| PATCH /students/:id                                  | roster:manage；仅资料字段；classId/status 明确返回 400                                                                                  |
| POST /students/transfer                              | roster:manage；studentIds、toClassId（null 表示移出）、note；跨年级需 ADMIN、allowGradeChange=true 与备注                               |
| POST /students/transfer-out                          | roster:manage；studentIds、note、toSchool；仅 active/inactive，毕业/归档/重复转出 409                                                   |
| POST /students/transfer-in                           | roster:manage；指定 toClassId，新建用 studentNo/name，重入用 studentId；可传 fromSchool/note                                            |
| POST /students/:id/restore                           | roster:manage；可传 toClassId/note；转出或停用恢复，原班归档时应另选在读班                                                              |
| POST /archives/transferred/:id/restore               | 兼容同上，权限改为 roster:manage                                                                                                        |
| DELETE /students/:id                                 | roster:manage；默认停用；hard=true&confirm=true 仅 ADMIN，存在业务或历史则 409                                                          |
| GET /students/transfers；GET /students/:id/transfers | roster:read；不排除转出状态；支持 studentId/classId/batchId/academicYear 与分页                                                         |
| GET/PUT /term/promotion                              | promotion:manage 全校范围；读取计划、执行时间、应执行学年与记录；保存兼容旧 month/day/hour/classCount，也接受 plan                      |
| POST /term/promotion/preview                         | promotion:manage 全校范围；year；只读返回逐轨道逐班统计、阻断项、警告、新班码、周次影响、planHash                                       |
| POST /term/promotion/run                             | promotion:manage 全校范围；year、planHash、confirm:true；过去学年还须 ADMIN + catchUp:true；未来年份 400；阻断或哈希变化 409 带 details |
| POST /classes/promote                                | promotion:manage 与各目标范围；仅 classIds，不收自由 grade；从计划推导下一学段，毕业学段 409                                            |
| PATCH /classes/:id                                   | 不再接受 grade，旧请求返回 400；改年级须走升级入口                                                                                      |
| DELETE /archives/:id                                 | archive:manage 全校范围；仅撤销归档标记，保留转出与停用状态，不回滚年级、新班及周次                                                     |

生命周期历史以 kind 为事实源，mode 为派生兼容字段；新响应另含 batchId、academicYear、fromGrade/toGrade、fromSchool/toSchool。
归档详情含 inactive 列表、inactiveCount 和按学生去重的 transferInCount；升级记录含 operatorId/operatorName、detailsJson、snapshotSha256、error。
所有学生与历史写入在同一事务，提交后再广播旧班与新班。班级详情只有持 roster:read 且在对应范围内的员工才能获得学生明细。
