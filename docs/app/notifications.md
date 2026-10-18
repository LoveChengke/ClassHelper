---
title: 通知与提醒
description: 优先级、课堂确认与经典/自定义常驻模式的提醒区别。
---

# 通知与提醒

Web 发布通知需 notification:publish 和班级范围权限。通知按本地 assignDate 归档，支持按日期、发布人查看与批量发布。
服务端保存后立即广播；上课暂存与是否自动展开是客户端本机展示规则。

## 优先级与本机展示

共享优先级为 LOW（低）、NORMAL（普通）、HIGH（重要）、URGENT（紧急）。
经典固定模式和自定义常驻模式有不同展示：

| 场景                   | 经典 fixed                                 | 自定义 custom                          |
| ---------------------- | ------------------------------------------ | -------------------------------------- |
| 普通/重要/低通知、作业 | 课间显示胶囊；上课暂存，下课补弹           | 常驻内容旁提示铃铛与去重数量，点击查看 |
| 紧急通知/紧急叫人      | 无论是否上课立即展开                       | 提示铃铛，由用户主动展开               |
| 普通叫人               | 上课保留可点击胶囊，不自动展开；课间可展开 | 提示铃铛，可主动查看                   |
| 主动查看               | 普通通知受课堂状态限制，叫人和紧急可点开   | 上课也可主动展开                       |

经典紧急通知默认约 45 秒收起；列表与消息处理见[灵动岛](island.md)。课件传输另显示专用进度。

## 课堂发布紧急通知

上课时发布 URGENT，服务端先返回 409 URGENT_DURING_CLASS。
Web 显示全屏确认和倒计时，再次请求带 confirmDuringClass:true 才放行。
这是服务端发布校验，不受客户端选择 fixed/custom 影响；普通叫人和紧急叫人走[叫人](calls.md)的接口规则。

## 已读与撤回

客户端通知页有未读数，打开详情可标已读；班级会话的已读操作代表全班在读学生。
删除需相应员工权限和范围，实时撤回会清理客户端列表、缓存与岛队列。
同 id 的通知与叫人双播合并，不重复计数。

## 接口入口

以下省略 /api，均先鉴权；具体功能键及范围见[REST API](../dev/api.md)。

| 方法与路径                                            | 用途                                                                  |
| ----------------------------------------------------- | --------------------------------------------------------------------- |
| GET /notifications                                    | 列表；classId、priority、unreadOnly、keyword、date/from/to、createdBy |
| GET /notifications/days、/notifications/creators      | 日期与发布人归档                                                      |
| GET /notifications/unread-count                       | 未读数                                                                |
| POST /notifications、/notifications/bulk              | 单班/批量发布，批量逐班返回结果                                       |
| POST /notifications/:id/read、/notifications/read-all | 标记已读                                                              |
| DELETE /notifications/:id                             | 撤回                                                                  |

ClassIsland 在线提醒渠道已移除；本机提醒设置不会写回旧渠道字段。
