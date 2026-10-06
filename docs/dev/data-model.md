---
title: 数据模型
description: 16 张表的职责、跨库通用约定、迁移历史与启动时自动迁移。
---

# 数据模型

模型定义只有一份：`packages/server/prisma/schema.prisma`。

## 跨库通用约定

- 默认是 **SQLite**（Prisma 7 的 libSQL driver adapter，数据文件 `packages/server/prisma/dev.db`）；
- 字段**只用** `String / Int / Float / Boolean / DateTime`，**不用 Prisma enum、不用 `@db.*` 原生类型**；
  角色与优先级存字符串，在 API 层用 zod 校验 —— 这样 SQLite 与 MySQL 行为完全一致；
- 因此切库只需改 `provider` 与连接串（`pnpm db:switch:mysql` 就地改写它，没有第二份 schema）；
- 主键统一用 cuid 字符串，便于多端离线生成与合并。

## 两条核心不变量

这两条是 2026-10-06 那次重构立下的，后面所有表都围着它们转：

**① 学生不是账号。** `Student` 是独立的一张表，只有学号 / 姓名 / 班级 / 性别 / 家长手机号 /
状态，**没有 `passwordHash`、没有 `role`、没有登录字段** —— 「学生不能登录」由表结构保证，
不再靠"登录前先判 role === 'STUDENT' 并 403"这类代码分支维持。
`User` 因此收缩为**纯账号表**（管理员 / 教师 / ClassHelper 班级端）。

**② 任课关系的唯一来源是 `Course`。** `Course(classId, name, teacherId)` 就是
「班级 + 科目 + 教师」这条关系本身，作业与成绩都挂在它上面；班主任另由 `Class.teacherId` 表示
（每班 1 人）。历史上那张**没有科目**的 `ClassTeacher` 协作表已删除 —— 两套关系并存必然漂移。
同一位教师可以在同一个班同时是班主任和某科科任老师：两处指向同一个 `User`，不重复建号，
权限在 `@classhelper/shared` 的 `resolveClassRole()` 里合并。

## 16 张表

| 表                     | 职责                                       | 值得注意的字段                                                                                        |
| ---------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `User`                 | **纯账号表**：管理员 / 教师 / ClassHelper 班级端 | `username`（教师即**工号**，班级端即班级码）、`role`、`phone`；**学生不在这里**                        |
| `Student`              | 学生名单记录（**没有账号**）               | `studentNo`（学号，唯一，唯一标识与查询键）、`classId`、`status`、`archivedYearId`                     |
| `StudentClassTransfer` | 调班 / 转出历史                            | 班级 id 与班级名**都存快照且不建外键**（班级删了历史仍要能读）、`mode`（single｜batch｜transfer-out）  |
| `ArchivedYear`         | 毕业归档的届别档案                         | `enrollmentYear`（届别，唯一）、`graduationYear`、归档时的统计快照                                     |
| `Class`                | 班级                                       | `name`（**「2026级1班」**，由 `enrollmentYear` + `classIndex` 生成）、`code` + `passwordHash`（班级端账号）、`termWeeks`、`termStartDate`、`notificationChannel`、`studentGradeQueryEnabled`、`archivedYearId` |
| `TermWeek`             | 学期逐周日期区间                           | `classId`（**空串 = 全校默认**）、`weekNumber`、`startDate` / `endDate`                                |
| `Course`               | 课程 = **「班级 + 科目 + 教师」任课关系**   | `teacherId` 就是该班该科的任课老师；`@@unique([classId, name])`                                        |
| `Schedule`             | 课表条目                                   | `weekStart` / `weekEnd` / `weekParity`（单双周）/ `source`（manual｜classisland）                      |
| `Homework`             | 作业                                       | `assignDate`（所属日期）、`attachmentUrl`；`dueAt` 是已下线的遗留列                                    |
| `HomeworkStatus`       | 学生作业完成状态                           | `@@unique([homeworkId, studentId])`                                                                    |
| `Notification`         | 通知                                       | `priority`                                                                                             |
| `NotificationRead`     | 已读记录                                   | `@@unique([notificationId, studentId])`                                                                |
| `TimeLayout`           | 节次时间配置（ClassIsland 同款 JSON 导入得到） | `items` 是 JSON 字符串：`[{ index, name, startTime, endTime, type, skipped }]`                         |
| `Grade`                | 成绩                                       | `studentId`、`score` / `totalScore`、`levelType`（percent｜letter｜custom）与 `level`                  |
| `IntegrationDevice`    | ClassHelper 班级端 / ClassIsland 联动设备   | `tokenHash`（只存 sha256）、`lastHeartbeatAt`（在线判定）、`lastSeenAt`（最后一次带状态的上报）、三个方向开关 |
| `ClassIslandPush`      | 下发给 ClassIsland 的提醒                   | `kind`（notification｜call）、`ackedAt`、`expiresAt`                                                   |

### 几个容易忽略的设计

**`ClassIslandPush` 与 `IntegrationDevice`** —— 提醒是**落库**的，不是"发出去就算"。
设备离线时通知不丢：插件重连后拉取未确认的那条立即弹出，弹完回执（`ackedAt`）。
`expiresAt` 防止学生几天后突然弹出旧提醒。

**在线判定看 `lastHeartbeatAt`，不看 `lastSeenAt`** —— 同一台设备的上报其实有两种：
心跳（每 60 秒一次，只表明"我还在线"）与带状态的上报（课表 / 上课状态）。
合成一个字段后无法区分"在线但一直没新状态"和"整个失联"，所以拆开：
`lastHeartbeatAt` 每次上报都刷（60 秒窗口判在线），`lastSeenAt` 只在带运行状态时刷。

**课表同步方向：服务端 → 教室是主方向。**
`IntegrationDevice.mirrorScheduleToClassIsland` 默认 **true**（服务端自动下发），
`syncScheduleToServer` 默认 **false**（教室不再自动回传）。要取教室的课表，走
`POST /integrations/devices/:id/request-schedule` 这个**人工动作**（前端点击前会弹警告）——
自动回传会在老师手排课之后被教室的旧课表悄悄覆盖。

**`Schedule.source`** —— 决定插件上报时能清理哪些行：只清 `classisland` 来源且本次未再上报的行。
**`source` 只在 create 时确定，update 一律保持原值**（否则手排的课会被"收养"后又被清掉）。

**`Homework.dueAt`** —— 截止时间功能已下线，UI 与接口都不再读写它。
保留列是为了**不对已安装的库做破坏性迁移**；新库里它恒为 `null`。

**`TermWeek.classId` 用空串而不是 null 表示"全校默认"** —— SQLite 与 MySQL 的唯一约束都把
NULL 视作互不相同，`@@unique([classId, weekNumber])` 用 null 就形同虚设。

## 迁移历史（16 个）

```
init → add_time_layout → add_class_account → add_schedule_week_parity →
add_class_term_weeks → add_classisland_integration → add_class_notification_channel →
add_homework_assign_date → add_push_kind → add_schedule_source →
add_student_table → add_student_grade_query → add_grade_level →
add_classhelper_heartbeat → add_archives → add_term_weeks
```

`add_student_table` 是一次真正的表重构（不是加列）：新建 `Student` / `StudentClassTransfer`、
把 `User` 里 `role='STUDENT'` 的行**按 id 原样搬过去**、把 `Grade` / `HomeworkStatus` /
`NotificationRead` 的外键从 `userId` 换到 `studentId`、删掉 `Enrollment` 与 `ClassTeacher`。
因为学生行的 id 保持不变，三张个人数据表的 `userId` 可以直接当 `studentId` 用，历史一条不丢。

### 启动时自动迁移

`src/lib/db-bootstrap.ts` 用一张账本表 `_ch_migrations` 记录已执行的迁移目录名：

| 情况     | 行为                                                |
| -------- | --------------------------------------------------- |
| 全新安装 | 依次执行全部迁移并创建初始管理员                    |
| 覆盖安装 | 只补跑账本里没有的迁移（已存在的表 / 索引自动跳过） |
| 已是最新 | **不做任何写操作**                                  |

日志会写明「全新安装 / 升级安装」、应用了几个迁移、跳过了几个已存在对象。
用户因此**不需要手动执行 `prisma migrate deploy`**。

## 备份格式就是这份模型的拓扑序导出

「数据库管理」里的备份 / 导出导入 / 跨库迁移共用一种 JSON 快照：16 张表按拓扑序导出
（见 `lib/snapshot.ts` 的 `SNAPSHOT_TABLES`），恢复时**临时关闭外键检查** ——
因为 `Class.teacherId → User` 与 `Student.classId → Class` 是一条链、
`Class/Student.archivedYearId → ArchivedYear` 又是一条，任何排序都会被其中一侧卡死。
见[数据库管理](../management/database.md)。

## 开发时的模型改动

1. 改 `schema.prisma`；
2. 在 `prisma/migrations/` 下加一个迁移目录（本机用
   `pnpm --filter @classhelper/server db:deploy` 应用，**别用 `pnpm db:migrate`** ——
   它在 Windows 上不可靠）。要改已有表结构而不只是加列时，可以先用
   `pnpm exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`
   生成骨架，再手工补数据搬运语句；
3. 改完核对 **`SNAPSHOT_TABLES`**（新增 / 删除表要同步）与 `deleteTeacher` 的护栏清单
   （它必须覆盖 `Class.teacherId` / `Course.teacherId` / `Homework.createdBy` /
   `Notification.createdBy` 四项；`ClassIslandPush.createdBy` 是裸列、无外键、不级联，不用加）；
   再回到 `packages/server/scripts/apply-column-migrations.cjs` 补上可 `ALTER TABLE` 的简单列。

模型总数与迁移个数会随版本增长，以 `schema.prisma` 与 `prisma/migrations/` 的实际内容为准；
本文里的数字标注的是当前版本（1.2.0）的状态。
