---
title: 数据模型
description: 现行模型职责、迁移与快照边界。
---

# 数据模型

模型定义以 `packages/server/prisma/schema.prisma` 为准，迁移以 `prisma/migrations/` 为准。
仅维护一份 schema，SQLite/MySQL 切换改 provider；不使用 Prisma enum 和 `@db.*`。

## 模型职责

| 模型                   | 职责                                               |
| ---------------------- | -------------------------------------------------- |
| `User`                 | 教师与管理员账号；学生不在此表，班级凭据在 Class   |
| `Student`              | 学生名单、学号、在读/转出/毕业状态，无密码和角色   |
| `StudentClassTransfer` | 调班与转出历史，保留班级/姓名快照                  |
| `ArchivedYear`         | 毕业届别与统计快照                                 |
| `TermWeek`             | 逐周日期区间，classId 空串为全校默认               |
| `Class`                | 班级、班级码/密码、班主任、周数与成绩查询开关      |
| `Course`               | 班级+科目+教师任课关系，含简称和室外标记           |
| `Schedule`             | 旧课表迁移审计来源，现行接口不再以它为业务真值     |
| `Homework`             | 作业与本地 assignDate；dueAt 为遗留列              |
| `HomeworkStatus`       | 按 studentId 记录作业完成状态                      |
| `Notification`         | 通知/叫人记录、优先级与本地 assignDate             |
| `NotificationRead`     | 按 studentId 记录已读                              |
| `TimeLayout`           | 共享或班级自有时间表；旧 items JSON 保留迁移审计   |
| `Grade`                | studentId、课程、考试、分数和等级                  |
| `PermissionGroup`      | 默认/自定义/岗位组及 scope/scopeValue              |
| `PermissionGroupItem`  | 组内权限键                                         |
| `UserPermissionGroup`  | 账号与组的多对多分配                               |
| `AppSetting`           | 周次、升级、AI 和系统设置                          |
| `ClientDevice`         | deviceKey、心跳、更新目标与状态                    |
| `ClientCommand`        | 白名单远控、有效期与执行回执                       |
| `ClientRelease`        | 服务端缓存安装包、SHA256 与大小                    |
| `AiAudit`              | 助手解析审计，不保存 API Key                       |
| `Exam`                 | 考试名称与是否计入总分                             |
| `TimeLayoutItem`       | 有序时间点及类型，被课程显式引用                   |
| `ClassPlanGroup`       | 班级课表群组、全局/默认标记                        |
| `ClassPlan`            | 日课表、时间表、轮换、启用与临时层规则             |
| `ClassPlanEntry`       | 日课表与时间点、课程的外键关联、空课/停用/换课标记 |
| `ScheduledClassPlan`   | 按本地日期预定日课表                               |
| `PromotionRun`         | 年度升级幂等与审计                                 |
| `Courseware`           | 文件元数据、上传教师、存储路径与 SHA256            |
| `CoursewareVisibility` | 课件可见班级                                       |
| `CoursewarePush`       | 按班级的推送任务                                   |
| `CoursewareReceipt`    | 按设备的课件接收回执                               |

学生和账号分离：Student 没有密码/角色；教师/管理员存 User，CLASS_DEVICE 只是 Class 登录形成的会话。
任课关系只在 Course；班主任关系在 Class.teacherId，可以与任课关系指向同一账号。
课表真值是 ClassPlan/ClassPlanEntry/TimeLayoutItem，旧 Schedule 与 TimeLayout.items 不再参与现行业务写入。
周次口径见[课表](../app/schedules.md)，成绩限制见[成绩](../app/grades.md)。

## 迁移与启动

不要删除或重写已应用的 SQLite 迁移目录。源码开发使用 `pnpm --filter @classhelper/server db:deploy`。
安装形态由 `lib/db-bootstrap.ts` 执行启动迁移，账本 `_ch_migrations` 记录已执行目录。
升级迁移包含学生表拆分、联动退役、关系化课表、权限范围、年度升级和课件表；具体顺序读取 migrations。
历史学生迁移中的 STUDENT 只用于搬运旧数据，不是现行账号角色。
MySQL 建模走受支持的换库流程，不能直接执行 SQLite SQL，详见[MySQL](../management/mysql.md)。

## 快照与文件

`lib/snapshot.ts` 的 `SNAPSHOT_TABLES` 是备份/导入/跨库迁移表清单，按依赖顺序导出，恢复阶段临时关闭外键检查并分批写入。
模型新增或删除必须同步此清单；不要在文档复制固定表数。
JSON 快照包含课件元数据、可见范围、推送与回执，**不含文件实体**；完整备份需带上课件目录。
User.careMode 是预留列；当前 Web 偏好在 localStorage，客户端偏好在本机 config.json，不宣称已有跨设备同步。

## 修改模型时

1. 同步 schema、迁移、shared 契约、服务层、相关前端与快照清单。
2. 核对外键级联与删除护栏，特别是教师的班级、课程、作业、通知和课件。
3. 在临时库验证新建和旧库升级；不对真实业务库运行 seed/reset。
4. 重新生成 Prisma Client，并按修改范围执行[验收](testing.md)。
