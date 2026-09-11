# 班级小助手（Class Helper）

班级信息管理系统，采用 pnpm monorepo，包含**后端服务**、**Web 管理端**（教师/管理员）与
**桌面客户端**（学生）三端。核心链路：

```
教师在 Web 端发布内容
        │  REST API（JWT 鉴权）
        ▼
   后端服务（Express + Prisma）
        │  写入数据库 + 按班级房间广播
        ▼
 Socket.IO  ──►  class:{classId} 房间  ──►  学生桌面客户端实时更新 UI
```

## 当前交付范围

| 阶段 | 内容                                                                                      | 状态                                          |
| ---- | ----------------------------------------------------------------------------------------- | --------------------------------------------- |
| 1    | pnpm monorepo 脚手架、TypeScript / ESLint / Prettier / 环境变量                           | ✅ 已完成                                     |
| 2    | 后端：Prisma schema + 迁移 + 种子数据 + JWT 认证 + RBAC + 模块化 REST API + Socket.IO     | ✅ 已完成                                     |
| 3    | Web 管理端：登录、主布局、仪表盘、班级/学生/课表/作业/通知/成绩页面、Axios 封装、实时提示 | ✅ 已完成                                     |
| 4    | EXE 客户端（Electron + Vue 3 + Element Plus + Socket.IO Client + 离线缓存）               | ⏳ 待开发                                     |
| 5    | 三端联调脚本、打包命令、完整 README                                                       | 🟡 后端联调脚本与文档已完成，EXE 打包待阶段 4 |
| 6    | 测试账号与种子数据说明                                                                    | ✅ 已完成（见下文）                           |

> **与原始提示词的两处偏差（已与你确认）**
>
> 1. 桌面客户端采用 **Electron + Vue 3**（而非 Avalonia/FluentAvalonia）：正文 90% 的要求
>    （Socket.IO Client、Pinia、IndexedDB 离线缓存、electron-builder）都基于 Electron，
>    且本机没有 .NET SDK。
> 2. 数据库 **先用 SQLite（libSQL 内嵌）跑通 MVP，并预留 MySQL 切换**：本机没有可用 MySQL
>    实例；`docs/mysql.md` 给出云数据库切换的完整步骤。

## 目录结构

```
class-helper/
├── package.json                 # 根脚本（dev / build / db:* / verify:e2e）
├── pnpm-workspace.yaml          # workspace 定义 + allowBuilds（pnpm 11 依赖构建白名单）
├── tsconfig.base.json           # 共享 TS 基础配置
├── eslint.config.mjs            # ESLint 扁平配置（TS + Vue）
├── scripts/use-database.mjs     # SQLite ⇄ MySQL provider 切换助手
├── docs/mysql.md                # MySQL 切换与生产部署指南
└── packages/
    ├── shared/                  # 三端共享：类型契约、常量、工具函数
    │   └── src/{types,constants,utils,index}.ts
    ├── server/                  # 后端服务
    │   ├── prisma/schema.prisma         # 数据模型
    │   ├── prisma/migrations/           # 迁移历史（已生成并应用）
    │   ├── prisma/seed.ts               # 种子数据
    │   ├── prisma.config.ts             # Prisma 7 配置（迁移/种子/连接串）
    │   ├── scripts/verify-e2e.mjs       # 端到端验收脚本（54 项）
    │   └── src/
    │       ├── app.ts                   # Express 装配（健康检查 + 模块挂载）
    │       ├── index.ts                 # 启动入口（HTTP + Socket.IO + 优雅退出）
    │       ├── config/env.ts            # 环境变量校验（zod）
    │       ├── lib/                     # db / http / jwt / password / access(RBAC) / mappers
    │       ├── middleware/              # auth / error / validate
    │       ├── realtime/                # socket.ts + bus.ts（事件总线）
    │       └── modules/                 # 功能模块 + registry.ts
    └── web-admin/               # Web 管理端（Vue 3 + Vite + Element Plus）
        └── src/{api,stores,router,layouts,views,styles}
```

## 技术栈

| 层     | 选型                                                               | 版本                                                  |
| ------ | ------------------------------------------------------------------ | ----------------------------------------------------- |
| 包管理 | pnpm workspace                                                     | 11.8.0                                                |
| 语言   | TypeScript                                                         | 5.9.3（`typescript-eslint` 要求 < 6.1，因此未用 7.x） |
| 后端   | Node.js + Express                                                  | 24.18 / 5.2                                           |
| ORM    | Prisma + driver adapter                                            | 7.10（+ `@prisma/adapter-libsql`）                    |
| 实时   | Socket.IO                                                          | 4.8                                                   |
| 认证   | jsonwebtoken + bcryptjs                                            | 9.0 / 3.0                                             |
| 校验   | zod                                                                | 4.6                                                   |
| Web 端 | Vue 3 + Vite + Element Plus + Pinia + Vue Router + Axios + ECharts | 3.5 / 8.3 / 2.14 / 4.0 / 5.3 / 1.20 / 6.1             |

> 运行环境要求：**Node.js ≥ 20.19**（Prisma 7 硬性要求，推荐 22/24）。

## 快速开始

```bash
# 1. 安装依赖（Node >= 20.19，pnpm >= 10）
pnpm install

# 2. 准备环境变量（后端）
cp packages/server/.env.example packages/server/.env
#    → 至少修改 JWT_SECRET；本地开发可直接使用仓库内已有的 .env

# 3. 生成 Prisma Client 并建库、写入种子数据
pnpm db:generate
pnpm db:migrate
pnpm db:seed

# 4. 启动（后端 4000 + Web 端 5173 一起启动）
pnpm dev
```

启动后访问：

| 服务               | 地址                             |
| ------------------ | -------------------------------- |
| Web 管理端（开发） | http://127.0.0.1:5173            |
| 后端 API           | http://127.0.0.1:4000/api        |
| 健康检查           | http://127.0.0.1:4000/api/health |

也可以分开启动：`pnpm dev:server`（仅后端）、`pnpm dev:web`（仅 Web 端）。

### 端到端验收脚本

```bash
# 另开一个终端先启动后端：pnpm dev:server
pnpm verify:e2e
```

脚本会自动登录教师与学生账号，验证**实时推送时延、作业完成、成绩下发、权限隔离**等 54 项，
并打印逐项结果与耗时（实测：通知 37ms、作业 26ms、成绩 25ms 到达，远优于 5 秒要求）。

## 默认账号与种子数据

`pnpm db:seed` 会清空业务表并写入一套完整演示数据（1 管理员 / 2 教师 / 3 班级 / 15 学生 /
15 课程 / 90 条课表 / 15 份作业 / 12 条通知 / 90 条成绩）。

| 角色   | 用户名                    | 密码         | 说明                                       |
| ------ | ------------------------- | ------------ | ------------------------------------------ |
| 管理员 | `admin`                   | `admin123`   | 可访问全部班级                             |
| 教师   | `teacher1`                | `teacher123` | 张老师：高一(1)班、高二(3)班班主任         |
| 教师   | `teacher2`                | `teacher123` | 李老师：高一(2)班班主任，高二(3)班协作教师 |
| 学生   | `student01`               | `student123` | 高一(1)班                                  |
| 学生   | `student02` … `student05` | `student123` | 高一(1)班                                  |
| 学生   | `student06` … `student10` | `student123` | 高一(2)班                                  |
| 学生   | `student11` … `student15` | `student123` | 高二(3)班                                  |

- 学生初始密码可用 `DEFAULT_STUDENT_PASSWORD` 配置（默认 `123456`），
  教师也可在「学生管理」里一键重置为默认密码。
- 教学周由 `TERM_START_DATE`（第 1 教学周的周一）换算，当前周次用于课表默认视图。

## 常用命令

| 命令                                        | 说明                                                                |
| ------------------------------------------- | ------------------------------------------------------------------- |
| `pnpm dev`                                  | 并行启动 shared(tsc watch) + 后端 + Web 端                          |
| `pnpm dev:server` / `pnpm dev:web`          | 只启动后端 / 只启动 Web 端                                          |
| `pnpm build`                                | 构建 shared + 后端（tsc 产出 `dist`） + Web 端（Vite 产出 `dist`）  |
| `pnpm typecheck`                            | 全仓库类型检查（含 `vue-tsc`）                                      |
| `pnpm lint` / `pnpm lint:fix`               | ESLint 检查 / 自动修复                                              |
| `pnpm format` / `pnpm format:check`         | Prettier 格式化 / 检查                                              |
| `pnpm db:generate`                          | 生成 Prisma Client（输出到 `packages/server/src/generated/prisma`） |
| `pnpm db:migrate`                           | 创建并应用迁移                                                      |
| `pnpm db:seed`                              | 写入种子数据                                                        |
| `pnpm db:reset`                             | 重置数据库并重新执行 seed                                           |
| `pnpm db:studio`                            | 打开 Prisma Studio                                                  |
| `pnpm db:switch:mysql` / `db:switch:sqlite` | 切换数据库 provider                                                 |
| `pnpm verify:e2e`                           | 端到端验收（需后端已启动）                                          |

## REST API 一览

统一响应体：`{ "success": true, "data": {}, "message": "" }`（错误为 `success:false` + `code`）。
所有接口前缀 `/api`，除登录外均需 `Authorization: Bearer <token>`。

| 方法                        | 路径                                                     | 权限            | 说明                                                       |
| --------------------------- | -------------------------------------------------------- | --------------- | ---------------------------------------------------------- |
| POST                        | `/auth/login`                                            | 公开            | 登录，返回 token + 用户信息                                |
| GET                         | `/auth/me`                                               | 登录            | 当前用户（学生附带班级/年级）                              |
| PATCH                       | `/auth/password`                                         | 登录            | 修改自己的密码                                             |
| POST                        | `/auth/logout`                                           | 登录            | 退出（无状态，客户端丢弃 token）                           |
| GET                         | `/classes`                                               | 登录            | 班级列表（按权限收敛）                                     |
| GET                         | `/classes/:id`                                           | 班级可见        | 班级详情（学生/课程/协作教师）                             |
| POST / PATCH / DELETE       | `/classes` `/classes/:id`                                | 教师/管理员     | 班级增删改                                                 |
| GET / POST                  | `/classes/:id/students`                                  | 班级可见 / 可写 | 学生名单 / 添加学生（已存在账号直接转入）                  |
| DELETE                      | `/classes/:id/students/:userId`                          | 教师/管理员     | 移出学生                                                   |
| POST / DELETE               | `/classes/:id/teachers[/:teacherId]`                     | 教师/管理员     | 分配 / 取消协作教师                                        |
| GET / POST / PATCH / DELETE | `/courses`                                               | 登录 / 教师     | 课程管理                                                   |
| GET                         | `/schedules?classId=&week=&dayOfWeek=`                   | 登录            | 课表列表（week 过滤周次范围）                              |
| GET                         | `/schedules/grid?classId=&week=`                         | 登录            | 周视图（7 列结构，供客户端直接渲染）                       |
| POST / PATCH / DELETE       | `/schedules`                                             | 教师/管理员     | 课表增删改（广播 `schedule:updated`）                      |
| GET                         | `/homeworks?classId=&courseId=&pendingOnly=&keyword=`    | 登录            | 作业列表（学生带完成状态，教师带完成人数）                 |
| GET                         | `/homeworks/:id`                                         | 班级可见        | 作业详情                                                   |
| POST / PATCH / DELETE       | `/homeworks`                                             | 教师/管理员     | 发布/修改/删除（广播 `homework:new` / `homework:updated`） |
| PATCH                       | `/homeworks/:id/status`                                  | 登录            | 标记完成/取消（广播 `homework:status`）                    |
| GET                         | `/notifications?classId=&priority=&unreadOnly=&keyword=` | 登录            | 通知列表（带已读状态）                                     |
| GET                         | `/notifications/unread-count`                            | 登录            | 未读数（红点）                                             |
| POST                        | `/notifications`                                         | 教师/管理员     | 发布通知（广播 `notification:new`）                        |
| POST                        | `/notifications/:id/read`、`/notifications/read-all`     | 登录            | 标记已读                                                   |
| DELETE                      | `/notifications/:id`                                     | 教师/管理员     | 删除通知                                                   |
| GET                         | `/grades/my`                                             | 登录            | 个人成绩                                                   |
| GET                         | `/grades?classId=&courseId=&userId=&examName=`           | 教师/管理员     | 班级成绩                                                   |
| GET                         | `/grades/stats?classId=&courseId=&examName=`             | 教师/管理员     | 等级分布 + 各课程平均得分率                                |
| POST                        | `/grades`、`/grades/bulk`                                | 教师/管理员     | 单条 / 批量录入（广播 `grade:updated`）                    |
| PATCH / DELETE              | `/grades/:id`                                            | 教师/管理员     | 修改 / 删除成绩                                            |
| GET                         | `/students?classId=&keyword=`                            | 教师/管理员     | 学生名单                                                   |
| POST / PATCH / DELETE       | `/students`                                              | 教师/管理员     | 学生账号增删改                                             |
| POST                        | `/students/:id/reset-password`                           | 教师/管理员     | 重置密码                                                   |
| GET                         | `/teachers?keyword=`                                     | 教师/管理员     | 教师列表（分配协作教师用）                                 |
| POST                        | `/teachers`                                              | 管理员          | 新建教师账号                                               |
| GET                         | `/dashboard/summary` / `/dashboard/term`                 | 登录            | 仪表盘汇总 / 学期周次                                      |
| GET                         | `/health`                                                | 公开            | 健康检查（含已挂载模块列表）                               |

## WebSocket 事件

连接方式：`io(url, { auth: { token } })`，握手阶段用 JWT 鉴权。

| 事件                                  | 方向            | 载荷                                  |
| ------------------------------------- | --------------- | ------------------------------------- |
| `connected`                           | 服务端 → 客户端 | `{ userId, role, rooms }`             |
| `notification:new`                    | 服务端 → 客户端 | `NotificationDto`                     |
| `homework:new`                        | 服务端 → 客户端 | `HomeworkDto`                         |
| `homework:updated`                    | 服务端 → 客户端 | `HomeworkDto & { deleted?: boolean }` |
| `homework:status`                     | 服务端 → 客户端 | `HomeworkStatusDto & { classId }`     |
| `grade:updated`                       | 服务端 → 客户端 | `GradeDto`                            |
| `schedule:updated`                    | 服务端 → 客户端 | `{ classId, action, schedule? }`      |
| `class:updated`                       | 服务端 → 客户端 | `{ classId, action }`                 |
| `class:join` / `class:leave` / `ping` | 客户端 → 服务端 | 手动订阅班级（服务端二次校验权限）    |

房间规则（`@classhelper/shared` 的 `SOCKET_ROOMS`）：
`class:{classId}`、`user:{userId}`、`role:{role}`、`students`、`teachers`。
客户端断线由 Socket.IO 自动重连（Web 端 store 与后续 EXE 端共用同一套事件名）。

## 权限模型（RBAC）

| 角色      | 可见范围                                                      | 写权限                                  |
| --------- | ------------------------------------------------------------- | --------------------------------------- |
| `ADMIN`   | 全部班级                                                      | 全部                                    |
| `TEACHER` | 自己创建（`Class.teacherId`）或被分配（`ClassTeacher`）的班级 | 仅上述班级                              |
| `STUDENT` | 仅自己所在班级（`User.classId` + `Enrollment`）               | 无（仅能标记自己的作业状态 / 已读通知） |

实现要点：

- `src/middleware/auth.ts`：JWT 校验后会**回查数据库**，班级/角色变更立即生效。
- `src/lib/access.ts`：集中实现 `assertClassAccess` / `assertClassWritable` / `resolveClassScope`，
  列表接口通过 scope 收敛数据（`classId in [...]`），单条接口直接断言。
- 越权请求统一返回 `403`，未登录返回 `401`（验收脚本已覆盖 10 项越权场景）。

## 模块化设计（可随时增删模块）

后端每个功能是一个独立目录，统一契约 `ApiModule = { name, basePath, router, enabled? }`：

```ts
// packages/server/src/modules/registry.ts
export const apiModules: ApiModule[] = [
  authModule,
  classesModule,
  coursesModule,
  schedulesModule,
  homeworksModule,
  notificationsModule,
  gradesModule,
  studentsModule,
  teachersModule, // ← 新增模块只需在这里加一行
  dashboardModule,
].filter((module) => module.enabled !== false);
```

- **新增模块**：新建 `modules/<name>/`（`*.schemas.ts` 校验、`*.service.ts` 业务、`*.module.ts` 路由），
  在 registry 里加一行即可，`app.ts` 无需改动。
- **移除/下线模块**：删掉对应行，或把 `enabled` 置为 `false`，其接口立即从路由表消失。
- **实时推送解耦**：业务模块只调用 `realtime/bus.ts` 的 `emitToClass/emitToUser`，
  不直接依赖 Socket.IO 实例，因此「移除实时通道」不影响业务代码。
- **共享契约**：所有 DTO 与类型集中在 `@classhelper/shared`，三端共用，避免契约漂移。

## 数据库

- 默认：SQLite（Prisma 7 的 libSQL driver adapter，数据文件 `packages/server/prisma/dev.db`）。
- 模型设计为跨库通用（无 enum、无 `@db.*` 原生类型），**切换到 MySQL 只需改 provider + 连接串**。
- 完整步骤见 [`docs/mysql.md`](docs/mysql.md)：

```bash
pnpm db:switch:mysql
pnpm --filter @classhelper/server add @prisma/adapter-mariadb
# 修改 packages/server/.env 的 DATABASE_PROVIDER / DATABASE_URL
pnpm db:migrate && pnpm db:seed
```

数据库表：`User` / `Class` / `ClassTeacher` / `Enrollment` / `Course` / `Schedule` /
`Homework` / `HomeworkStatus` / `Notification` / `NotificationRead` / `Grade`（共 11 张）。

## 验收标准对照

| 验收项                                        | 结果      | 证据                                                                                      |
| --------------------------------------------- | --------- | ----------------------------------------------------------------------------------------- |
| 教师 Web 端发布通知，学生端 5 秒内收到        | ✅        | `verify:e2e`：`notification:new` **37–44ms**                                              |
| 教师发布作业，学生能查看并标记完成            | ✅        | `homework:new` **26–40ms**，`PATCH /homeworks/:id/status` 200 且列表回显 `completed=true` |
| 教师录入成绩，学生能查看个人成绩              | ✅        | `grade:updated` **21–25ms**，`/grades/my` 返回记录；批量录入与统计接口通过                |
| 学生能查看课表，支持按周切换                  | ✅        | `/schedules/grid?week=1` 返回 30 节，`week` 过滤 `weekStart ≤ week ≤ weekEnd`             |
| 断网后客户端可查看缓存数据                    | ⏳ 阶段 4 | 依赖 EXE 客户端（IndexedDB 缓存 + 联网后同步）                                            |
| 权限隔离：学生不能访问其他班级数据            | ✅        | 10 项越权断言全部 403/401（学生跨班/跨班作业/跨班课表、教师跨班发布、未登录访问…）        |
| 能成功打包 Windows EXE                        | ⏳ 阶段 4 | 待 EXE 客户端完成后用 electron-builder 打包                                               |
| 提供完整 README（启动、构建、打包、默认账号） | 🟡        | 启动/构建/账号已完成；EXE 打包命令随阶段 4 补充                                           |

当前实测：`pnpm verify:e2e` → **54/54 项通过**；`pnpm typecheck`、`pnpm lint`、`pnpm build` 全部通过。

## 常见问题（本机环境已知坑）

1. **在 DSH 桌面端（Electron 宿主）里执行 pnpm 时，依赖的 `.bin` 不会被注入 PATH**
   现象：`pnpm run <script>` 报 `'prisma' 不是内部或外部命令`。
   原因：本机 pnpm 由 Electron 进程承载，bin 目录位于
   `node_modules/.pnpm/node_modules/.bin`，未注入子进程 PATH。
   规避：直接用 Node 调用 CLI 入口，例如
   `node packages/server/node_modules/prisma/build/index.js generate`、
   `node packages/web-admin/node_modules/vite/bin/vite.js build`。
   在普通终端（非 Electron 宿主）中 `pnpm <script>` 一切正常。

2. **原生模块会按 Electron ABI 构建**
   同一原因会让 `node-gyp` / `prebuild-install` 以 `runtime=electron` 为目标，
   装出的 `.node` 在 Node 进程里无法加载。本项目因此改用 **libSQL 适配器**
   （`@libsql/win32-x64-msvc` 为 npm 预编译包，无需本地编译），彻底规避该问题。

3. **本机 TLS 中间人证书导致依赖二进制下载失败**
   现象：`prebuild-install warn install unable to verify the first certificate`。
   规避：安装时设置 `NODE_OPTIONS=--use-system-ca`（Node ≥ 22.15 支持），
   并确保 `npm_config_cache` 指向可写目录（如仓库内 `.cache/npm-cache`）。

4. **受限沙箱下 Vite 构建报 `spawn EPERM`**
   Vite 在 Windows 上通过 `execFile` 解析真实路径，需要放开子进程管道限制后再构建。

5. **Prisma 7 与旧版本差异**
   `prisma` 的 npm `latest` 标签当前指向 `8.0.0-rc`，本项目**显式锁定 7.10.0**；
   生成器为 `prisma-client`（输出到 `src/generated/prisma`，已 gitignore），
   连接串在 `prisma.config.ts` 中配置，且必须通过 driver adapter 接入数据库。

## 后续计划（阶段 4-6）

1. **阶段 4 · EXE 客户端**：`packages/desktop-client`（Electron 主进程 + Vue 渲染进程），
   登录页（服务器地址/用户名/密码）、侧边栏（课表/作业/通知/成绩/设置）、
   Socket.IO 实时更新、IndexedDB 离线缓存与联网后自动同步、`electron-builder` 打包 Windows EXE。
2. **阶段 5**：三端联调脚本（含 EXE 端时延与断网恢复用例）、根目录一键打包命令。
3. **阶段 6**：打包产物分发说明、云端 MySQL 部署清单（Docker Compose）、CI 流水线。
