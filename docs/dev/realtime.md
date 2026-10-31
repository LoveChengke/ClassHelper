---
title: 实时事件（Socket.IO）
description: 实际事件与房间、断线恢复和客户端提醒分工。
---

# 实时事件（Socket.IO）

连接使用 `io(url, { auth: { token } })`，服务端握手校验 JWT 并与 HTTP 共用数据库身份加载。
事件与房间定义在 shared 的 `constants.ts`，载荷类型在 shared 的 `types.ts`，以这些契约和发送点为准。

## 房间与定向推送

| 房间                      | 作用                                               |
| ------------------------- | -------------------------------------------------- |
| class:{classId}:{channel} | 某班级对应读域的业务广播                           |
| session:{id}              | 会话定向名；员工 id 为账号 id，班级端 id 为班级 id |
| role:{role}               | 角色房间名，定义在共享常量                         |
| teacher:{id}              | 教师房间名，定义在共享常量                         |
| students                  | 班级端连接的广播房间，代表全班，不是个人学生账号   |
| teachers                  | 教师和管理员连接的广播房间                         |

`realtime/socket.ts` 按域加入授权班级房间，并加入 session/role 与 students/teachers 房间；connected 载荷列出实际已加入房间。
业务经 `realtime/bus.ts` 的 emitToClass/emitToSession/emitToRooms 推送。
叫人记录属于班级通知，并发送班级广播与班级会话定向事件；学生本身没有连接和个人房间。

## 主要事件

| 事件                                              | 内容                                                       |
| ------------------------------------------------- | ---------------------------------------------------------- |
| connected                                         | `{ sessionId, role, rooms }`                               |
| notification:new / notification:deleted           | 通知新增/撤回；客户端同步列表、缓存和岛队列                |
| homework:new / homework:updated / homework:status | 作业新增、修改/删除与完成状态                              |
| grade:updated                                     | 成绩变化通知；载荷按范围与隐私规则发送，客户端按需重新读取 |
| schedule:updated / class:updated                  | 课表/班级变化，重新加载对应数据                            |
| courseware:changed                                | 课件列表/可见范围/推送变化，触发客户端检查                 |
| client:release-progress                           | 服务端缓存客户端安装包的进度                               |
| call:new                                          | 叫人内容，与 notification:new 按同 id 合并去重             |
| class:join / class:leave / ping                   | 客户端订阅/离开班级、探活；join 重新校验范围               |

事件没有持久离线消息队列保证。重连后由页面和恢复钩子重新拉取业务数据。
普通通知上课暂存是客户端岛控制器的本机行为，服务端仍即时落库广播；
断线通知补弹由客户端未读读取逻辑处理，课件未收任务由服务端保存、客户端心跳补领。
经典/自定义模式的展示差异见[通知与提醒](../app/notifications.md)。

## 修改事件

同步修改共享事件名与载荷、服务端发送点、Web `stores/realtime.ts`、客户端 `stores/realtime.ts` 及相关缓存/岛逻辑。
不要手写事件名；只改服务端会导致前端静默不刷新。涉及成绩时另检查隐私载荷和班级范围。

## 读域订阅

现行班级房间为 `class:{id}:{channel}`。channel 为 core/homework/notification/grade/courseware，事件映射来自 shared 的 SOCKET_EVENT_CHANNELS。旧 `class:{id}` 仅保留兼容名称，生产不订阅。班级端加入本班全部域；教师按对应读键和分配范围加入。`class:join` 接受旧 classId 字符串或 `{classId, channels}`，后者逐通道校验，有任一无权则拒绝整次请求。握手回查账号与角色，权限变更断开旧订阅。
