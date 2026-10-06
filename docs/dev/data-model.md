---
title: 数据模型
description: 14 张表的职责、跨库通用约定、迁移历史与启动时自动迁移。
---

# 数据模型

模型定义只有一份：`packages/server/prisma/schema.prisma`。

## 跨库通用约定

- 默认是 **SQLite**（Prisma 7 的 libSQL driver adapter，数据文件 `packages/server/prisma/dev.db`）；
- 字段**只用** `String / Int / Float / Boolean / DateTime`，**不用 Prisma enum、不用 `@db.*` 原生类型**；
  角色与优先级存字符串，在 API 层用 zod 校验 —— 这样 SQLite 与 MySQL 行为完全一致；
- 因此切库只需改 `provider` 与连接串（`pnpm db:switch:mysql` 就地改写它，没有第二份 schema）；
- 主键统一用 cuid 字符串，便于多端离线生成与合并。

## 14 张表

| 表                  | 职责                                           | 值得注意的字段                                                                    |
| ------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------- |
| `User`              | 教师 / 管理员 / 学生统一存储                   | `role`、`classId`；学生 `passwordHash` 是空串占位，不能登录                       |
| `Class`             | 班级                                           | `code` + `passwordHash`（班级账号）、`termWeeks`、`notificationChannel`           |
| `ClassTeacher`      | 教师-班级 分配关系（协作教师）                 | `@@unique([classId, teacherId])`                                                  |
| `Enrollment`        | 学生-班级 归属记录                             | 与 `User.classId` 同步，为将来多班预留                                            |
| `Course`            | 课程（班级维度）                               | `@@unique([classId, name])`                                                       |
| `Schedule`          | 课表条目                                       | `weekStart` / `weekEnd` / `weekParity`（单双周）/ `source`（manual｜classisland） |
| `Homework`          | 作业                                           | `assignDate`（所属日期）、`attachmentUrl`；`dueAt` 是已下线的遗留列               |
| `HomeworkStatus`    | 学生作业完成状态                               | `@@unique([homeworkId, userId])`                                                  |
| `Notification`      | 通知                                           | `priority`                                                                        |
| `NotificationRead`  | 已读记录                                       | `@@unique([notificationId, userId])`                                              |
| `TimeLayout`        | 节次时间配置（ClassIsland 同款 JSON 导入得到） | `items` 是 JSON 字符串：`[{ index, name, startTime, endTime, type, skipped }]`    |
| `Grade`             | 成绩                                           | `score` / `totalScore` / `examName`                                               |
| `IntegrationDevice` | ClassIsland 联动设备                           | `tokenHash`（只存 sha256）、`tokenHint`、两个开关、最后一次上报的快照字段         |
| `ClassIslandPush`   | 下发给 ClassIsland 的提醒                      | `kind`（notification｜call）、`ackedAt`、`expiresAt`                              |

### 三个容易忽略的设计

**`ClassIslandPush` 与 `IntegrationDevice`** —— 提醒是**落库**的，不是"发出去就算"。
设备离线时通知不丢：插件重连后拉取未确认的那条立即弹出，弹完回执（`ackedAt`）。
`expiresAt` 防止学生几天后突然弹出旧提醒。

**`Schedule.source`** —— 决定插件全量上报时能清理哪些行：只清 `classisland` 来源且本次未再上报的行。
**`source` 只在 create 时确定，update 一律保持原值**（否则手排的课会被"收养"后又被清掉）。

**`Homework.dueAt`** —— 截止时间功能已下线，UI 与接口都不再读写它。
保留列是为了**不对已安装的库做破坏性迁移**；新库里它恒为 `null`。

## 迁移历史（10 个）

```
init → add_time_layout → add_class_account → add_schedule_week_parity →
add_class_term_weeks → add_classisland_integration → add_class_notification_channel →
add_homework_assign_date → add_push_kind → add_schedule_source
```

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

「数据库管理」里的备份 / 导出导入 / 跨库迁移共用一种 JSON 快照：14 张表按拓扑序导出，
恢复时**临时关闭外键检查** —— 因为 `User.classId → Class` 与 `Class.teacherId → User`
**互相引用**，任何排序都会被其中一侧卡死。见[数据库管理](../management/database.md)。

## 开发时的模型改动

1. 改 `schema.prisma`；
2. 在 `prisma/migrations/` 下加一个迁移目录（本机用
   `pnpm --filter @classhelper/server db:deploy` 应用，**别用 `pnpm db:migrate`** ——
   它在 Windows 上不可靠）；
3. 改 schema 时先看**哪些外键指向 `User` 且是 Cascade**，再回来核对
   `deleteTeacher` 的护栏清单（它必须覆盖 `Class.teacherId` / `Course.teacherId` /
   `ClassTeacher.teacherId` / `Homework.createdBy` / `Notification.createdBy` 五项）。

模型总数与迁移个数会随版本增长，以 `schema.prisma` 与 `prisma/migrations/` 的实际内容为准；
本文里的数字标注的是当前版本（1.1.2）的状态。
