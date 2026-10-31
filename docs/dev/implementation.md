---
title: 当前实现约定
description: 课表、周次、学年、岛、设备与课件的现行实现入口。
---

# 当前实现约定

本页维护当前工作区的实现契约，不汇总多批构建的验收数字。验证命令与实际范围见[验收与测试](testing.md)。

## 关系化课表

`ClassPlan/ClassPlanEntry/TimeLayoutItem` 是业务真值。时间点外键独立于排序，`Schedule` 与旧 JSON 列仅保留迁移审计来源。
兼容 `/schedules` 写入新模型，日课表、周视图和上课状态共用 `lib/class-plan.ts`。
解析顺序是预定、当日临时课表、同日临时层、有效临时群/选定或默认群的规则匹配、全局群、无群默认。
轮换使用 weekday/weekCountDiv/weekCountDivTotal 与周次范围，支持 1–9 周；没有新增 Profile 实体。
完整档案导入直接保留轮换、空课、停用、时间类型、群组与预定，不经过单双周中间格式。
旧数据同班同日同周同时间冲突仅最小 id 进入新表，旧行保留；缺失的历史群组、临时层与时间点名称无法恢复。

## 权限、成绩与年度升级

能力、分配范围、业务关系统一由 lib/authz 的 principal/scope/relations/assert 维护；access 只提供带显式键的窄封装。ADMIN 固定全集，TEACHER 过滤管理员专用键。
全校周数上限在 `term.maxWeeks`，默认 30、允许 1–60；开学日和逐周区间支持全校与班级设置。
个人成绩查询关闭后只返回服务端集体聚合，个人明细、原始全班成绩与排名拒绝读取；样本不足或稀疏分段抑制。
年度升级由 `term.promotionPlan`、`term.promotionAt` 和 `PromotionRun.year` 管理，先存快照；运行期到点执行，启动漏跑需管理员预览补跑。
毕业班归档，其余升一级，新班不复制任课关系。转出学生由 `lib/students.ts` 统一过滤。

## 岛与本机配置

方案存 `config.json.islandLayout`，默认 fixed。当前 custom 即常驻，归一化将兼容字段 residentEnabled 与 custom 对齐。
`LayoutIslandApp.vue` 选择经典 `IslandApp.vue` 或 `CustomIslandRuntime.vue`，只有一个原生岛窗口。
自定义常态行与无消息展开行独立编辑，通知列表复用 `ClassicNotifications.vue`；编辑页是主窗口设置子路由。
自定义模式通过铃铛提示新消息，点击查看；经典模式普通通知上课暂存、普通叫人可点开胶囊、紧急消息自动展开。
课程提醒配置独立保存，课件传输期间由 `CoursewareTransfer.vue` 显示进度。

## 设备维护与文件

设备心跳和命令只走 `/api/clients/*`。切服务端或登录状态变化要重置代理计时，并隔离迟到响应；deviceKey 不变。
更新从服务端缓存下载，客户端验 SHA256，按下发策略安装；远控白名单动作执行后回执，测试只用假执行器。
课件上限 512 MB，服务端流式落盘后创建元数据和推送，客户端逐设备验摘要并回执，不自动运行文件。
JSON 快照含课件表，完整恢复还必须带文件实体目录。细节见[课件](../app/courseware.md)。

## 学生与权限写入契约

学生状态/班级写入口集中在 `lib/student-lifecycle.ts`，班级名单添加/移出、名单导入、转出和转入均复用它。
资料 PATCH 不承担状态或班级迁移。学生与历史在事务内提交，UUID 标识批次，事务后广播两端班级，历史读取不附带在读过滤。
权限、功能对应范围、业务关系依次断言；权限只在当前请求对象上复用，下一请求重新计算。
范围解析在 shared，实际范围存分配记录，模板范围仅作新分配建议。各键独立合并，无键为空集；默认教师范围固定 TEACHING。
权限组或成员分配与 PermissionAudit 同事务，成员权限一次预取计算。

年度升级服务由计划推导所有轨道的下一学段。预览哈希覆盖配置、班级、学生和周次，执行事务内重新计算；
先保存全库快照并计算 SHA256，再以年份唯一键提交升级。毕业班所有状态挂届别，非毕业班仅升级及清班级开学日覆盖。
周次是否清空由计划决定，预览公开影响。服务保留 runPromotion(year, dryRun) 内部兼容签名；HTTP 执行必须提供哈希、确认并检查年份。

实时班级事件按 core/homework/notification/grade/courseware 分房间，事件总线按 shared 映射选择通道，教师仅订阅对应读键范围。HTTP 与 Socket 握手共用数据库身份加载；敏感权限与账号变更使旧订阅失效。事务路径传递同一数据库连接给授权断言，保留原/目标资源的校验。
