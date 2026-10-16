---
title: REST API
description: ClassHelper后端全部接口一览：方法、路径、权限与说明。
---

# REST API

## 通用约定

- 所有接口前缀 `/api`（设备接口也一样）；
- 统一响应体：`{ "success": true, "data": {}, "message": "" }`，错误为 `success: false` + `code`；
- 除登录、健康检查与设备接口外，都需要 `Authorization: Bearer <token>`；
- 请求体校验走 zod（`middleware/validate.ts`），错误由 `middleware/error.ts` 统一映射。

## 接口一览

| 方法                        | 路径                                                          | 权限                         | 说明                                                                              |
| --------------------------- | ------------------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------- |
| POST                        | `/auth/login`                                                 | 公开                         | 登录（教师 / 管理员的**工号** + 密码）；学生不是账号，拿学号登录只会得到 401      |
| POST                        | `/auth/class-login`                                           | 公开                         | **班级账号登录**：班级码 + 班级密码 → 班级会话                                    |
| GET                         | `/auth/me`                                                    | 登录                         | 当前用户（学生附带班级 / 年级）                                                   |
| PATCH                       | `/auth/password`                                              | 登录                         | 修改自己的密码（班级会话 → 班级密码）                                             |
| POST                        | `/auth/logout`                                                | 登录                         | 退出（无状态，客户端丢弃 token）                                                  |
| GET                         | `/permissions/me`                                             | 登录                         | 当前账号的生效权限（**无权限键**；班级端会话返回空集）                            |
| GET                         | `/permissions/catalog`                                        | `permission:manage`          | 权限键目录（权限页整棵勾选树的唯一来源）                                          |
| GET / POST                  | `/permissions/groups`                                         | `permission:manage`          | 权限组列表 / 新建                                                                 |
| PATCH / DELETE              | `/permissions/groups/:id`                                     | `permission:manage`          | 改名 / 改描述 / 整体替换权限键；内置组不可删                                      |
| GET                         | `/permissions/users`                                          | `permission:manage`          | 成员列表（所属权限组 + 生效权限数量）                                             |
| PUT                         | `/permissions/users/:id/groups`                               | `permission:manage`          | 整体替换某账号的权限组（空数组 = 回落角色默认模板）                               |
| GET                         | `/classes`                                                    | 登录                         | 班级列表（按权限收敛）                                                            |
| GET                         | `/classes/:id`                                                | 班级可见                     | 班级详情（学生 / 课程 / 班主任 / 各科任课老师）                                   |
| POST                        | `/classes`                                                    | 管理员                       | 创建班级（自动生成班级码，可指定班主任）                                          |
| PATCH / DELETE              | `/classes/:id`                                                | 管理员 / 教师                | 编辑 / 删除班级                                                                   |
| PATCH                       | `/classes/:id/class-account`                                  | 管理员                       | 设置 / 重置班级账号（班级码 + 班级密码）                                          |
| PATCH                       | `/classes/:id/head-teacher`                                   | 管理员                       | 设置 / 更换班主任                                                                 |
| GET / POST                  | `/classes/:id/students`                                       | 班级可见 / ADMIN·TEACHER     | 学生名单 / 添加学生                                                               |
| DELETE                      | `/classes/:id/students/:userId`                               | ADMIN·TEACHER                | 移出学生                                                                          |
| PUT                         | `/classes/:id/subject-teachers`                               | ADMIN                        | 设置各科任课老师（班级 + 科目 + 教师）                                            |
| GET / POST / PATCH / DELETE | `/courses`                                                    | 登录（写：班主任 / 管理员）  | 课程管理                                                                          |
| GET                         | `/schedules?classId=&week=&dayOfWeek=`                        | 登录                         | 课表列表（`week` 过滤周次范围）                                                   |
| GET                         | `/schedules/grid?classId=&week=`                              | 登录                         | 周视图（7 列结构，供客户端直接渲染）                                              |
| GET                         | `/schedules/current?classId=&at=`                             | 登录                         | 当前上课状态（`inClass` / `current` / `next`；`at` 为诊断用时间覆盖）             |
| POST / PATCH / DELETE       | `/schedules[/:id]`                                            | 班主任 / 管理员              | 课表增删改（广播 `schedule:updated`）                                             |
| GET                         | `/homeworks?classId=&courseId=&date=&pendingOnly=&keyword=`   | 登录                         | 作业列表（支持按所属日期；学生带完成状态，教师带完成人数）                        |
| GET                         | `/homeworks/days?classId=&from=&to=`                          | 登录                         | 哪些天有作业（日期高亮）                                                          |
| GET                         | `/homeworks/:id`                                              | 班级可见                     | 作业详情                                                                          |
| POST                        | `/homeworks`                                                  | 教师 / 管理员 / **班级账号** | 发布作业（附 `assignDate`；班级账号用于教室机器录入，归属班主任）                 |
| PATCH / DELETE              | `/homeworks/:id`                                              | 教师 / 管理员                | 修改 / 删除（广播 `homework:new` / `homework:updated`）                           |
| PATCH                       | `/homeworks/:id/status`                                       | 登录                         | 标记完成 / 取消（广播 `homework:status`）                                         |
| GET / PATCH                 | `/homeworks/:id/submissions`                                  | 登录                         | 未交名单：读名单 / 回写全班完成状态                                               |
| POST                        | `/homeworks/bulk`                                             | `homework:write`             | 一次给多个班级布置同一份作业（`subjectName` 跨班按名匹配科目；逐班结果）          |
| GET                         | `/notifications?classId=&priority=&unreadOnly=&keyword=`      | 登录                         | 通知列表（带已读状态；另支持 `date` / `from` / `to` / `createdBy`）               |
| GET                         | `/notifications/unread-count`                                 | 登录                         | 未读数（红点）                                                                    |
| POST                        | `/notifications`                                              | 教师 / 管理员                | 发布通知（广播 `notification:new`）；上课时段发紧急通知需 `confirmDuringClass`    |
| POST                        | `/notifications/:id/read`、`/notifications/read-all`          | 登录                         | 标记已读（班级设备会写全班）                                                      |
| DELETE                      | `/notifications/:id`                                          | 教师 / 管理员                | 删除通知                                                                          |
| GET                         | `/notifications/days?classId=&from=&to=&createdBy=`           | 登录                         | 通知按天归档（日期 + 条数，日期取 `assignDate`）                                  |
| GET                         | `/notifications/creators?classId=&from=&to=&date=`            | 登录                         | 通知按发布人归档                                                                  |
| POST                        | `/notifications/bulk`                                         | `notification:publish`       | 一次给多个班级发同一条通知（逐班结果，**单班失败不影响整批**）                    |
| POST                        | `/calls`                                                      | 教师 / 管理员                | **叫人**（`urgent` 决定 URGENT / HIGH；广播 `notification:new` 与 `call:new`）    |
| GET                         | `/grades/my`                                                  | 登录                         | 个人成绩（班级会话 → 全班总览）                                                   |
| GET                         | `/grades?classId=&courseId=&userId=&examName=`                | 教师 / 管理员                | 班级成绩                                                                          |
| GET                         | `/grades/stats?classId=&courseId=&examName=`                  | 教师 / 管理员                | 等级分布 + 各课程平均得分率                                                       |
| POST                        | `/grades`、`/grades/bulk`                                     | 班主任 / 管理员              | 单条 / 批量录入（广播 `grade:updated`）                                           |
| PATCH / DELETE              | `/grades/:id`                                                 | 班主任 / 管理员              | 修改 / 删除成绩                                                                   |
| GET                         | `/students?classId=&keyword=`                                 | **管理员**                   | 学生名单                                                                          |
| POST / PATCH / DELETE       | `/students[/:id]`                                             | **管理员**                   | 学生名单增删改（无密码概念；重置密码接口已下线 → 404）                            |
| GET                         | `/teachers?keyword=`                                          | **管理员**                   | 教师列表                                                                          |
| POST / PATCH / DELETE       | `/teachers[/:id]`                                             | **管理员**                   | 新建 / 编辑 / 删除教师账号                                                        |
| POST                        | `/teachers/:id/reset-password`                                | **管理员**                   | 修改 / 重置教师密码（`newPassword` 可选，留空 = 默认初始密码）                    |
| GET                         | `/dashboard/summary`、`/dashboard/term`                       | 登录                         | 仪表盘汇总 / 学期周次                                                             |
| GET                         | `/imports/template?kind=&format=`                             | 管理员 / 班主任              | 导入模板下载（`csv` 走 JSON，`xlsx` 走二进制）                                    |
| POST                        | `/imports/table/preview`                                      | 管理员 / 班主任              | 上传表格（base64）解析预览：列名 + 前 20 行 + 校验问题 + 建议映射                 |
| POST                        | `/imports/table/commit`                                       | 管理员 / 班主任              | 按字段映射与写入模式导入（成绩 / 学生名单 / 教师名单）                            |
| POST                        | `/imports/time-layout/preview`                                | 管理员 / 本班班主任          | 解析 ClassIsland 时间配置 JSON（只解析不落库）                                    |
| GET / POST / DELETE         | `/imports/time-layout[/:id]`                                  | 管理员 / 本班班主任          | 时间配置列表 / 导入（`replace` 覆盖、`merge` 合并）/ 删除                         |
| POST                        | `/imports/class-plan/preview`、`/imports/class-plan`          | 管理员 / 本班班主任          | ClassIsland 课程表解析预览 / 导入（支持单双周）                                   |
| GET                         | `/database/status`                                            | **管理员**                   | 数据库状态（连接 / 版本 / 体积 / 23 张表行数 / 备份列表 / 定时配置）              |
| POST                        | `/database/test-connection`                                   | **管理员**                   | 测试任意目标库连通性（provider 仅 sqlite / mysql）                                |
| GET / POST                  | `/database/backups`                                           | **管理员**                   | 备份列表 / 立即备份（gzip JSON 快照，存 `<数据目录>/backups/`）                   |
| POST / DELETE               | `/database/backups/:name/restore` · `/database/backups/:name` | **管理员**                   | 从备份恢复（整库覆盖）/ 删除备份                                                  |
| GET                         | `/database/export`、`/database/sqlite-file`                   | **管理员**                   | 下载 JSON 快照 / 下载数据库文件（后者仅 SQLite）                                  |
| POST                        | `/database/import`                                            | **管理员**                   | 导入快照（base64，整库覆盖；可在 SQLite / MySQL 之间互迁）                        |
| GET / PUT                   | `/database/backup-schedule`                                   | **管理员**                   | 定时备份配置（enabled / intervalHours / keepCount）                               |
| POST / GET                  | `/database/switch`、`/database/switch/jobs/:id`               | **管理员**                   | **一键切换数据库**（异步任务）/ 轮询进度                                          |
| GET                         | `/update/check`                                               | 登录                         | 更新检查（服务端代查 GitHub 最新 Release；`?force=1` 绕过缓存仅管理员生效）       |
| POST                        | `/clients/heartbeat`                                          | 登录                         | 客户端每 30 秒上报（**无权限键**）；返回更新目标 + 安装包信息 + 一条待执行命令    |
| POST                        | `/clients/commands/:id/ack`                                   | 登录                         | 命令执行回执（**无权限键**，靠 body 的 `deviceKey` 校验归属，幂等）               |
| POST                        | `/clients/commands`                                           | `remote:control`             | 下发远控命令（关机 / 重启 / 注销 / 锁屏；自动撤销该机更早的未回执命令）           |
| GET                         | `/clients/devices?classId=`                                   | `client:manage`              | 客户端设备列表（版本 / 在线 / 待执行命令）                                        |
| POST                        | `/clients/updates`                                            | `client:update-push`         | 统一下发客户端更新（按设备 / 班级 / 全部）                                        |
| DELETE                      | `/clients/devices/:id`                                        | `client:manage`              | 移除设备记录（换机 / 旧机器清理）                                                 |
| GET                         | `/update/client/releases`                                     | `client:manage`              | 服务端已缓存了哪些客户端安装包                                                    |
| POST                        | `/update/client/fetch`                                        | `client:update-push`         | 服务端代教室机器从 GitHub 下载安装包并登记 sha256 + size                          |
| POST                        | `/update/client/releases`                                     | `client:update-push`         | 手工登记已放进磁盘的安装包（内网 / U 盘分发兜底）                                 |
| DELETE                      | `/update/client/releases/:version`                            | `client:update-push`         | 删除缓存的安装包（元数据 + 磁盘文件）                                             |
| GET                         | `/update/client/download/:version`                            | 登录                         | 下载安装包（**故意不挂权限键**，班级端要能下；`res.download`）                    |
| GET / PUT                   | `/ai/settings`                                                | `ai:manage`                  | 大模型设置（API Key 加密存储、**只进不出**，只回 `hasApiKey` / `keyHint`）        |
| POST                        | `/ai/interpret`                                               | `ai:use`                     | 一句话解析（**只解析不落库**）；回 `action` / `params` / `preview` / `confidence` |
| GET                         | `/ai/audit?limit=`                                            | `ai:manage`                  | 助手使用记录（每次解析写一条 `AiAudit`）                                          |
| GET / PUT                   | `/system/settings`                                            | `system:manage`              | 系统设置（`developerMode`：开启后 500 响应带 `error.stack`）                      |
| GET / PUT                   | `/system/autostart`                                           | `system:manage`              | 开机自启状态 / 开关（Windows 注册表 Run 项，Linux systemd 单元）                  |
| GET                         | `/system/diagnostics`                                         | `system:manage`              | 运行诊断（版本 / Node / 运行时长 / 数据目录 / 在线客户端数 / 已加载模块）         |
| GET                         | `/health`                                                     | 公开                         | 健康检查（含版本号与已挂载模块）                                                  |

另有三个探针（不带 `/api` 前缀）：`/healthz`（存活）、`/readyz`（就绪）、以及 `/api/health`（详情）。

## 几条容易踩的接口约定

| 约定                                         | 说明                                                                                                                                                                       |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`POST /homeworks` 故意不加 `requireRole`** | 权限判在 `homeworks.service.createHomework` 里（staff 或本班班级账号），因为教室机器也要能录作业                                                                           |
| **班级账号的 `sub` 是班级 id**               | 写 `createdBy` 前要换成该班班主任，否则撞 `User` 外键                                                                                                                      |
| **登录限流挂在两个入口上**                   | `/auth/login` 与 `/auth/class-login` 都挂 `loginRateLimiter()`                                                                                                             |
| **角色判定在密码校验之前**                   | 否则"密码错 / 密码对但账号停用"的差异会把学生账号密码变成可离线验证的预言机                                                                                                |
| **会渲染成链接的字段要校验 scheme**          | `Homework.attachmentUrl` 只允许 `http(s)://` 或站内相对路径                                                                                                                |
| **表格导入 8MB ↔ 请求体 12MB**               | 文件以 base64 放进 JSON（约 4/3 倍），超限映射成 413 `IMPORT_TOO_LARGE`                                                                                                    |
| **三个接口故意不挂权限键**                   | `/permissions/me`、`/clients/heartbeat`、`/update/client/download/:version` —— 前两者由班级端（`CLASS_DEVICE`，权限集为空）调用，下载接口要能装包；保护只有"已登录 + 限流" |
| **查询参数校验失败是 422**                   | `middleware/validate.ts` 的 zod 解析错误由错误中间件映射成 422 `VALIDATION_ERROR`（不是 400）                                                                              |
| **批量发布逐班判定、不整批回滚**             | `/notifications/bulk` 与 `/homeworks/bulk` 的单班失败（403 越权 / `URGENT_DURING_CLASS`）不影响其它班，成功班照常落库并实时推送                                            |
| **`/ai/interpret` 只解析不落库**             | 助手只回结构化参数与中文预览；落库由前端确认后调既有端点 —— 权限与上课时段保护都在那条路径上                                                                               |

## 相关

- 实时事件见[实时事件（Socket.IO）](realtime.md)；
- 权限矩阵见[角色与权限](permissions.md)；
- 数据模型见[数据模型](data-model.md)。

客户端心跳可携带 `agentProtocol: 2`，业务数据读取统一响应的 `data`。未带此标记时额外返回旧版需要的顶层字段；放学后更新在到时前不向旧客户端提供安装包。推送更新支持 `mode: immediate | after-school | idle`，`afterSchoolTime` 为服务端本地时区的 `HH:mm`。
