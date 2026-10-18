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

默认权限组、岗位范围、科目写权限分别由 permissions/permission-scope/access 维护，范围并集不授予任课权。
全校周数上限在 `term.maxWeeks`，默认 30、允许 1–60；开学日和逐周区间支持全校与班级设置。
个人成绩查询关闭后只返回服务端集体聚合，个人明细、原始全班成绩与排名拒绝读取；样本不足或稀疏分段抑制。
年度升级由 `term.promotionAt` 和 `PromotionRun.year` 管理，先存快照；运行期到点执行，启动漏跑需管理员预览补跑。
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
