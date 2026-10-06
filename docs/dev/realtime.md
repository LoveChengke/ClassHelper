---
title: 实时事件（Socket.IO）
description: 事件清单、房间规则，以及新增一个实时事件要同时改哪三处。
---

# 实时事件（Socket.IO）

## 连接

```ts
io(url, { auth: { token } }); // 握手阶段用 JWT 鉴权
```

客户端断线由 Socket.IO 自动重连。教室机器断线期间的变更，重连后靠各页重新拉取补齐
（客户端在检测到服务器恢复时会触发 `onServerRecovered`）；**灵动岛的上课时段暂存通知**由服务端保留、
下课后补发，不依赖重连。

## 事件清单

事件名定义在 `@classhelper/shared` 的 `SOCKET_EVENTS` —— **不要手写字符串**。

| 事件                                  | 方向            | 载荷                                             |
| ------------------------------------- | --------------- | ------------------------------------------------ |
| `connected`                           | 服务端 → 客户端 | `{ userId, role, rooms }`                        |
| `notification:new`                    | 服务端 → 客户端 | `NotificationDto`                                |
| `homework:new`                        | 服务端 → 客户端 | `HomeworkDto`                                    |
| `homework:updated`                    | 服务端 → 客户端 | `HomeworkDto & { deleted?: boolean }`            |
| `homework:status`                     | 服务端 → 客户端 | `HomeworkStatusDto & { classId }`                |
| `grade:updated`                       | 服务端 → 客户端 | `GradeDto`                                       |
| `schedule:updated`                    | 服务端 → 客户端 | `{ classId, action, schedule? }`                 |
| `class:updated`                       | 服务端 → 客户端 | `{ classId, action }`                            |
| `call:new`                            | 服务端 → 客户端 | 叫人消息（定向到 `user:{studentId}` / 班级设备） |
| `classisland:state`                   | 服务端 → 客户端 | `ClassIslandStateEvent`（教室现在上什么课）      |
| `classisland:notification`            | 服务端 → 客户端 | `ClassIslandNotificationEvent`（提醒已下发）     |
| `class:join` / `class:leave` / `ping` | 客户端 → 服务端 | 手动订阅班级（服务端二次校验权限）               |

## 房间规则

房间名定义在 `SOCKET_ROOMS`：

| 房间                  | 谁在里面                          |
| --------------------- | --------------------------------- |
| `class:{classId}`     | 这个班的所有在线端                |
| `user:{userId}`       | 某个用户自己的连接                |
| `teacher:{teacherId}` | 某个教师                          |
| `role:{role}`         | 某一角色（`ADMIN` / `TEACHER` …） |
| `students`            | 全部学生端连接                    |
| `teachers`            | 全部教师端连接                    |

服务端通过 `realtime/bus.ts` 的 `emitToClass` / `emitToUser` 发事件 ——
**业务模块不直接依赖 Socket.IO 实例**，只依赖事件总线。

## 新增一个实时事件要改三处

```
① 服务端    shared/src/constants.ts 的 SOCKET_EVENTS 加常量
            → business service 调 bus.emitToXxx(...)
            → realtime/socket.ts 房间映射（如果需要新房间）
② Web 端    web-admin/src/stores/realtime.ts 订阅
③ 客户端    desktop-client/src/renderer/stores/realtime.ts 订阅
            → 灵动岛也依赖它（renderer/island/bridge.ts）
```

**只改服务端不会报错**，只是前端静静地不更新 —— 所以这三处必须一起改。
事件名一律取自共享常量，不要手写字符串（拼错一个字就是一个静默失效）。

## 事件到达之后发生什么

以通知为例：

```
服务端写库 → bus.emitToClass(classId, notification:new)
   ├─► Web 端 stores/realtime.ts  → 通知列表刷新
   └─► 客户端 stores/realtime.ts  → 更新内存状态 + 写回 IndexedDB
                                    └─► island/bridge.ts → pushNotificationToIsland()
                                          └─► 主进程 IslandController 决定：隐藏 / 胶囊 / 详情
                                                └─► 灵动岛渲染进程 IslandApp.vue
```

上课时段的取舍（隐藏还是立即展开）由主进程的 `IslandController` 按当前上课状态决定，
见[通知与提醒](../app/notifications.md)与[灵动岛](../app/island.md)。
