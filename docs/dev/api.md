---
title: REST API
description: ClassHelper后端全部接口一览：方法、路径、权限与说明。
---

# REST API

## 通用约定

- 所有接口前缀 `/api`（设备接口也一样）；
- 统一响应体：`{ "success": true, "data": {}, "message": "" }`，错误为 `success: false` + `code`；
- 除登录、健康检查与设备接口外，都需要 `Authorization: Bearer <token>`；
- **ClassIsland 设备接口用 `X-ClassIsland-Token`**，不走 JWT（见[ClassIsland 插件](classisland-plugin.md)）；
- 请求体校验走 zod（`middleware/validate.ts`），错误由 `middleware/error.ts` 统一映射。

## 接口一览

| 方法                        | 路径                                                          | 权限                         | 说明                                                                           |
| --------------------------- | ------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------ |
| POST                        | `/auth/login`                                                 | 公开                         | 登录（教师 / 管理员的**工号** + 密码）；学生不是账号，拿学号登录只会得到 401   |
| POST                        | `/auth/class-login`                                           | 公开                         | **班级账号登录**：班级码 + 班级密码 → 班级会话                                 |
| GET                         | `/auth/me`                                                    | 登录                         | 当前用户（学生附带班级 / 年级）                                                |
| PATCH                       | `/auth/password`                                              | 登录                         | 修改自己的密码（班级会话 → 班级密码）                                          |
| POST                        | `/auth/logout`                                                | 登录                         | 退出（无状态，客户端丢弃 token）                                               |
| GET                         | `/classes`                                                    | 登录                         | 班级列表（按权限收敛）                                                         |
| GET                         | `/classes/:id`                                                | 班级可见                     | 班级详情（学生 / 课程 / 班主任 / 各科任课老师）                                 |
| POST                        | `/classes`                                                    | 管理员                       | 创建班级（自动生成班级码，可指定班主任）                                       |
| PATCH / DELETE              | `/classes/:id`                                                | 管理员 / 教师                | 编辑 / 删除班级                                                                |
| PATCH                       | `/classes/:id/class-account`                                  | 管理员                       | 设置 / 重置班级账号（班级码 + 班级密码）                                       |
| PATCH                       | `/classes/:id/head-teacher`                                   | 管理员                       | 设置 / 更换班主任                                                              |
| GET                         | `/classes/:id/classisland-status`                             | 班级可见                     | 本班 ClassIsland 联动状态（教室客户端设置页用）                                |
| GET                         | `/classes/:id/notification-channel`                           | 班级可见                     | 读取「通知显示到哪个端」                                                       |
| PATCH                       | `/classes/:id/notification-channel`                           | 班级账号 / 教师 / 管理员     | 设置「通知显示到哪个端」                                                       |
| GET / POST                  | `/classes/:id/students`                                       | 班级可见 / ADMIN·TEACHER     | 学生名单 / 添加学生                                                            |
| DELETE                      | `/classes/:id/students/:userId`                               | ADMIN·TEACHER                | 移出学生                                                                       |
| PUT                         | `/classes/:id/subject-teachers`                               | ADMIN                        | 设置各科任课老师（班级 + 科目 + 教师）                                         |
| GET / POST / PATCH / DELETE | `/courses`                                                    | 登录（写：班主任 / 管理员）  | 课程管理                                                                       |
| GET                         | `/schedules?classId=&week=&dayOfWeek=`                        | 登录                         | 课表列表（`week` 过滤周次范围）                                                |
| GET                         | `/schedules/grid?classId=&week=`                              | 登录                         | 周视图（7 列结构，供客户端直接渲染）                                           |
| GET                         | `/schedules/current?classId=&at=`                             | 登录                         | 当前上课状态（`inClass` / `current` / `next`；`at` 为诊断用时间覆盖）          |
| POST / PATCH / DELETE       | `/schedules[/:id]`                                            | 班主任 / 管理员              | 课表增删改（广播 `schedule:updated`）                                          |
| GET                         | `/homeworks?classId=&courseId=&date=&pendingOnly=&keyword=`   | 登录                         | 作业列表（支持按所属日期；学生带完成状态，教师带完成人数）                     |
| GET                         | `/homeworks/days?classId=&from=&to=`                          | 登录                         | 哪些天有作业（日期高亮）                                                       |
| GET                         | `/homeworks/:id`                                              | 班级可见                     | 作业详情                                                                       |
| POST                        | `/homeworks`                                                  | 教师 / 管理员 / **班级账号** | 发布作业（附 `assignDate`；班级账号用于教室机器录入，归属班主任）              |
| PATCH / DELETE              | `/homeworks/:id`                                              | 教师 / 管理员                | 修改 / 删除（广播 `homework:new` / `homework:updated`）                        |
| PATCH                       | `/homeworks/:id/status`                                       | 登录                         | 标记完成 / 取消（广播 `homework:status`）                                      |
| GET / PATCH                 | `/homeworks/:id/submissions`                                  | 登录                         | 未交名单：读名单 / 回写全班完成状态                                            |
| GET                         | `/notifications?classId=&priority=&unreadOnly=&keyword=`      | 登录                         | 通知列表（带已读状态）                                                         |
| GET                         | `/notifications/unread-count`                                 | 登录                         | 未读数（红点）                                                                 |
| POST                        | `/notifications`                                              | 教师 / 管理员                | 发布通知（广播 `notification:new`）；上课时段发紧急通知需 `confirmDuringClass` |
| POST                        | `/notifications/:id/read`、`/notifications/read-all`          | 登录                         | 标记已读（班级设备会写全班）                                                   |
| DELETE                      | `/notifications/:id`                                          | 教师 / 管理员                | 删除通知                                                                       |
| POST                        | `/calls`                                                      | 教师 / 管理员                | **叫人**（`urgent` 决定 URGENT / HIGH；广播 `notification:new` 与 `call:new`） |
| GET                         | `/grades/my`                                                  | 登录                         | 个人成绩（班级会话 → 全班总览）                                                |
| GET                         | `/grades?classId=&courseId=&userId=&examName=`                | 教师 / 管理员                | 班级成绩                                                                       |
| GET                         | `/grades/stats?classId=&courseId=&examName=`                  | 教师 / 管理员                | 等级分布 + 各课程平均得分率                                                    |
| POST                        | `/grades`、`/grades/bulk`                                     | 班主任 / 管理员              | 单条 / 批量录入（广播 `grade:updated`）                                        |
| PATCH / DELETE              | `/grades/:id`                                                 | 班主任 / 管理员              | 修改 / 删除成绩                                                                |
| GET                         | `/students?classId=&keyword=`                                 | **管理员**                   | 学生名单                                                                       |
| POST / PATCH / DELETE       | `/students[/:id]`                                             | **管理员**                   | 学生名单增删改（无密码概念；重置密码接口已下线 → 404）                         |
| GET                         | `/teachers?keyword=`                                          | **管理员**                   | 教师列表                                                                       |
| POST / PATCH / DELETE       | `/teachers[/:id]`                                             | **管理员**                   | 新建 / 编辑 / 删除教师账号                                                     |
| POST                        | `/teachers/:id/reset-password`                                | **管理员**                   | 修改 / 重置教师密码（`newPassword` 可选，留空 = 默认初始密码）                 |
| GET                         | `/dashboard/summary`、`/dashboard/term`                       | 登录                         | 仪表盘汇总 / 学期周次                                                          |
| GET                         | `/imports/template?kind=&format=`                             | 管理员 / 班主任              | 导入模板下载（`csv` 走 JSON，`xlsx` 走二进制）                                 |
| POST                        | `/imports/table/preview`                                      | 管理员 / 班主任              | 上传表格（base64）解析预览：列名 + 前 20 行 + 校验问题 + 建议映射              |
| POST                        | `/imports/table/commit`                                       | 管理员 / 班主任              | 按字段映射与写入模式导入（成绩 / 学生名单 / 教师名单）                         |
| POST                        | `/imports/time-layout/preview`                                | 管理员 / 本班班主任          | 解析 ClassIsland 时间配置 JSON（只解析不落库）                                 |
| GET / POST / DELETE         | `/imports/time-layout[/:id]`                                  | 管理员 / 本班班主任          | 时间配置列表 / 导入（`replace` 覆盖、`merge` 合并）/ 删除                      |
| POST                        | `/imports/class-plan/preview`、`/imports/class-plan`          | 管理员 / 本班班主任          | ClassIsland 课程表解析预览 / 导入（支持单双周）                                |
| GET / POST / PATCH / DELETE | `/integrations/devices[/:id]`                                 | 管理员 / 教师                | ClassIsland 联动设备管理（令牌只存 sha256，令牌前缀用于人眼识别）              |
| POST                        | `/integrations/devices/:id/token`                             | 管理员 / 教师                | 重置设备令牌（旧令牌立即失效，明文只返回一次）                                 |
| POST                        | `/integrations/classisland/notify`                            | 管理员 / 教师                | 下发提醒到该班 ClassIsland 设备（广播 `classisland:notification`）             |
| GET                         | `/database/status`                                            | **管理员**                   | 数据库状态（连接 / 版本 / 体积 / 16 张表行数 / 备份列表 / 定时配置）           |
| POST                        | `/database/test-connection`                                   | **管理员**                   | 测试任意目标库连通性（provider 仅 sqlite / mysql）                             |
| GET / POST                  | `/database/backups`                                           | **管理员**                   | 备份列表 / 立即备份（gzip JSON 快照，存 `<数据目录>/backups/`）                |
| POST / DELETE               | `/database/backups/:name/restore` · `/database/backups/:name` | **管理员**                   | 从备份恢复（整库覆盖）/ 删除备份                                               |
| GET                         | `/database/export`、`/database/sqlite-file`                   | **管理员**                   | 下载 JSON 快照 / 下载数据库文件（后者仅 SQLite）                               |
| POST                        | `/database/import`                                            | **管理员**                   | 导入快照（base64，整库覆盖；可在 SQLite / MySQL 之间互迁）                     |
| GET / PUT                   | `/database/backup-schedule`                                   | **管理员**                   | 定时备份配置（enabled / intervalHours / keepCount）                            |
| POST / GET                  | `/database/switch`、`/database/switch/jobs/:id`               | **管理员**                   | **一键切换数据库**（异步任务）/ 轮询进度                                       |
| POST                        | `/integrations/classisland/report`                            | **设备令牌**                 | 插件上报状态 + 课表 + 节次时间                                                 |
| GET                         | `/integrations/classisland/pending`                           | **设备令牌**                 | 插件拉取尚未确认的提醒（离线期间老师发的通知，重连后补齐）                     |
| POST                        | `/integrations/classisland/ack`                               | **设备令牌**                 | 插件确认提醒已弹出（确认后不再补发）                                           |
| GET                         | `/integrations/classisland/class-plan`                        | **设备令牌**                 | 插件拉取本班课表（开启镜像时）用于写回 ClassIsland                             |
| GET                         | `/update/check`                                               | 登录                         | 更新检查（服务端代查 GitHub 最新 Release；`?force=1` 绕过缓存仅管理员生效）    |
| GET                         | `/health`                                                     | 公开                         | 健康检查（含版本号与已挂载模块）                                               |

另有三个探针（不带 `/api` 前缀）：`/healthz`（存活）、`/readyz`（就绪）、以及 `/api/health`（详情）。

## 几条容易踩的接口约定

| 约定                                         | 说明                                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **`POST /homeworks` 故意不加 `requireRole`** | 权限判在 `homeworks.service.createHomework` 里（staff 或本班班级账号），因为教室机器也要能录作业 |
| **班级账号的 `sub` 是班级 id**               | 写 `createdBy` 前要换成该班班主任，否则撞 `User` 外键                                            |
| **登录限流挂在两个入口上**                   | `/auth/login` 与 `/auth/class-login` 都挂 `loginRateLimiter()`                                   |
| **角色判定在密码校验之前**                   | 否则"密码错 / 密码对但账号停用"的差异会把学生账号密码变成可离线验证的预言机                      |
| **会渲染成链接的字段要校验 scheme**          | `Homework.attachmentUrl` 只允许 `http(s)://` 或站内相对路径                                      |
| **表格导入 8MB ↔ 请求体 12MB**               | 文件以 base64 放进 JSON（约 4/3 倍），超限映射成 413 `IMPORT_TOO_LARGE`                          |

## 相关

- 实时事件见[实时事件（Socket.IO）](realtime.md)；
- 权限矩阵见[角色与权限](permissions.md)；
- 数据模型见[数据模型](data-model.md)。
