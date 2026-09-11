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

| 阶段 | 内容                                                                                                       | 状态                                           |
| ---- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 1    | pnpm monorepo 脚手架、TypeScript / ESLint / Prettier / 环境变量                                            | ✅ 已完成                                      |
| 2    | 后端：Prisma schema + 迁移 + 种子数据 + JWT 认证 + RBAC + 模块化 REST API + Socket.IO                      | ✅ 已完成                                      |
| 3    | Web 管理端：登录、主布局、仪表盘、班级/学生/课表/作业/通知/成绩页面、Axios 封装、实时提示                  | ✅ 已完成                                      |
| 4    | EXE 客户端：Electron 主进程/preload/渲染进程、登录、课表/作业/通知/成绩/设置、实时推送、IndexedDB 离线缓存 | ✅ 已完成（冒烟验证 9/9 通过）                 |
| 5    | 三端联调脚本、打包命令、完整 README                                                                        | ✅ 已完成（electron-builder 打包 Windows EXE） |
| 6    | 测试账号与种子数据说明                                                                                     | ✅ 已完成（见下文）                            |

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
├── package.json                 # 根脚本（dev / build / db:* / verify:* / dist:*）
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
    │   ├── scripts/verify-e2e.mjs       # 后端端到端验收脚本（54 项）
    │   └── src/
    │       ├── app.ts                   # Express 装配（服务首页 + 健康检查 + 模块挂载）
    │       ├── index.ts                 # 启动入口（HTTP + Socket.IO + 优雅退出）
    │       ├── config/env.ts            # 环境变量校验（zod）
    │       ├── lib/                     # db / http / jwt / password / access(RBAC) / mappers
    │       ├── middleware/              # auth / error / validate
    │       ├── realtime/                # socket.ts + bus.ts（事件总线）
    │       └── modules/                 # 功能模块 + registry.ts
    ├── web-admin/               # Web 管理端（Vue 3 + Vite + Element Plus）
    │   └── src/{api,stores,router,layouts,views,styles}
    └── desktop-client/          # EXE 客户端（Electron + Vue 3）
        ├── electron-builder.yml         # 打包配置（nsis 安装包 + portable 单文件）
        ├── vite.config.mts              # 渲染进程构建（base: './'，hash 路由）
        ├── scripts/{build-main,dev,smoke}.mjs
        └── src/
            ├── main/                    # 主进程：窗口/单实例/配置持久化(IPC)/冒烟验证
            ├── preload/                 # contextBridge 安全桥（不暴露 ipcRenderer 本体）
            ├── types/desktop.d.ts        # 主进程 <-> 渲染进程契约
            └── renderer/                # 渲染进程：api / stores / cache / router / layouts / views
```

## 技术栈

| 层         | 选型                                                                   | 版本                                                  |
| ---------- | ---------------------------------------------------------------------- | ----------------------------------------------------- |
| 包管理     | pnpm workspace                                                         | 11.8.0                                                |
| 语言       | TypeScript                                                             | 5.9.3（`typescript-eslint` 要求 < 6.1，因此未用 7.x） |
| 后端       | Node.js + Express                                                      | 24.18 / 5.2                                           |
| ORM        | Prisma + driver adapter                                                | 7.10（+ `@prisma/adapter-libsql`）                    |
| 实时       | Socket.IO                                                              | 4.8                                                   |
| 认证       | jsonwebtoken + bcryptjs                                                | 9.0 / 3.0                                             |
| 校验       | zod                                                                    | 4.6                                                   |
| Web 端     | Vue 3 + Vite + Element Plus + Pinia + Vue Router + Axios + ECharts     | 3.5 / 8.3 / 2.14 / 4.0 / 5.3 / 1.20 / 6.1             |
| EXE 客户端 | Electron + Vue 3 + Element Plus + Pinia + Socket.IO Client + IndexedDB | 44.3 / 3.5 / 2.14 / 4.0 / 4.8                         |
| 打包       | electron-builder（nsis / portable）                                    | 26.15                                                 |

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

| 服务                                       | 地址                             |
| ------------------------------------------ | -------------------------------- |
| Web 管理端（开发）                         | http://127.0.0.1:5173            |
| 后端服务首页（浏览器可读，列出已挂载模块） | http://127.0.0.1:4000            |
| 后端 API                                   | http://127.0.0.1:4000/api        |
| 健康检查                                   | http://127.0.0.1:4000/api/health |

> 后端只提供 REST API 与 WebSocket，没有业务网页界面。直接访问
> `http://127.0.0.1:4000/` 会返回服务首页（带 `Accept: application/json` 时返回结构化信息）；
> 其它未匹配路径统一返回 `{ "success": false, "code": "NOT_FOUND" }`。
> Web 管理端地址是 **5173** 端口，请勿访问 80 端口（会连接被拒绝）。

也可以分开启动：`pnpm dev:server`（仅后端）、`pnpm dev:web`（仅 Web 端）。

### 启动 EXE 客户端（学生端）

```bash
# 开发模式：自动构建主进程 + 启动 Vite 渲染进程(5174) + 打开 Electron 窗口（支持热更新）
pnpm dev:desktop

# 已构建产物的冒烟验证（不弹窗，跑完自动退出）
pnpm build:desktop
pnpm verify:desktop
```

客户端首次启动会带上默认服务器地址 `http://127.0.0.1:4000`，可用学生账号 `student01 / student123` 登录。
若要验证"断网可查看缓存"，登录并浏览过程序后关闭后端（`Ctrl+C` 停掉 `pnpm dev:server`），
客户端会在顶部提示「当前处于离线状态」，页面继续显示本地缓存数据；重新启动后端后会自动同步。

### 端到端验收脚本

```bash
# 另开一个终端先启动后端：pnpm dev:server
pnpm verify:e2e          # 后端 + REST + Socket.IO + RBAC：54 项
pnpm verify:desktop      # Electron 客户端（含联网集成）：9 项
```

后端脚本验证**实时推送时延、作业完成、成绩下发、权限隔离**等 54 项，实测通知 37ms、作业 26ms、
成绩 25ms 到达（要求 < 5 秒）；客户端脚本验证 preload 桥接、渲染进程、IndexedDB 读写、
断网回退与联网集成（登录 + 四类数据 + Socket.IO），实测 9/9 通过。

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

| 命令                                        | 说明                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------- |
| `pnpm dev`                                  | 并行启动 shared(tsc watch) + 后端 + Web 端                           |
| `pnpm dev:server` / `pnpm dev:web`          | 只启动后端 / 只启动 Web 端                                           |
| `pnpm dev:desktop`                          | 启动 EXE 客户端开发模式（Vite 5174 + Electron，热更新）              |
| `pnpm build`                                | 构建 shared + 后端 + Web 端 + EXE 客户端                             |
| `pnpm build:desktop`                        | 仅构建 EXE 客户端（esbuild 主进程/preload + Vite 渲染进程）          |
| `pnpm verify:desktop`                       | Electron 冒烟验证（需先 `pnpm build:desktop`；后端在线则含联网集成） |
| `pnpm dist:dir`                             | 打包免安装目录 `release/win-unpacked`（含可执行文件，最快）          |
| `pnpm dist:win`                             | 打包 nsis 安装包 + portable 单文件 EXE                               |
| `pnpm typecheck`                            | 全仓库类型检查（含 `vue-tsc`）                                       |
| `pnpm lint` / `pnpm lint:fix`               | ESLint 检查 / 自动修复                                               |
| `pnpm format` / `pnpm format:check`         | Prettier 格式化 / 检查                                               |
| `pnpm db:generate`                          | 生成 Prisma Client（输出到 `packages/server/src/generated/prisma`）  |
| `pnpm db:migrate`                           | 创建并应用迁移                                                       |
| `pnpm db:seed`                              | 写入种子数据                                                         |
| `pnpm db:reset`                             | 重置数据库并重新执行 seed                                            |
| `pnpm db:studio`                            | 打开 Prisma Studio                                                   |
| `pnpm db:switch:mysql` / `db:switch:sqlite` | 切换数据库 provider                                                  |
| `pnpm verify:e2e`                           | 端到端验收（需后端已启动）                                           |

## EXE 客户端（学生端）

### 进程结构与安全设置

| 进程     | 文件                                             | 职责                                                                                                           |
| -------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| 主进程   | `src/main/*` → `dist/main/index.js`              | 窗口/单实例锁、配置持久化（`safeStorage` 加密 token）、IPC、冒烟验证                                           |
| 预加载   | `src/preload/index.ts` → `dist/preload/index.js` | 通过 `contextBridge` 暴露最小 API（`getConfig/saveConfig/getAppInfo/openExternal`），不暴露 `ipcRenderer` 本体 |
| 渲染进程 | `src/renderer/**` → `dist/renderer/*`            | Vue 3 界面、Axios 请求、Socket.IO 实时、IndexedDB 离线缓存                                                     |

安全基线：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、`webSecurity: true`，
外部链接一律交给系统浏览器打开，禁止应用内导航到非本地地址。

### 功能页面

| 页面 | 功能                                                                                      |
| ---- | ----------------------------------------------------------------------------------------- |
| 登录 | 服务器地址 + 用户名 + 密码，附带「测试连接」；已登录但服务器不可达时可「离线进入」        |
| 课表 | 按周展示 7 列课表，支持上一周/下一周/下拉选择周次，高亮"今天"，显示周次范围与地点         |
| 作业 | 列表（全部/未完成/已完成过滤）、详情抽屉、标记完成/取消完成、附件链接、逾期高亮           |
| 通知 | 未读红点（侧边栏徽标）、优先级标签、点击自动标为已读、全部已读、未读过滤、详情抽屉        |
| 成绩 | 表格（分数/得分率进度条/等级）+ ECharts 柱状图（各次考试平均得分率）+ 等级分布 + 最近更新 |
| 设置 | 服务器地址（保存并测试）、账号信息、离线缓存条目统计与清空、客户端版本信息、退出登录      |

### 离线缓存与自动同步

```
                     ┌────────────── 在线 ──────────────┐
请求 → fetchWithCache(store, key, loader, fallback)
                     └── 失败 → 读取 IndexedDB 缓存 → 返回旧数据（UI 标记"离线缓存"）
实时推送(notification:new / grade:updated ...) → 更新内存状态 + 写回 IndexedDB
服务器不可达 → 可达（health 轮询 20s 或任意请求成功）→ 触发 onServerRecovered → 各页自动重新拉取
```

- 缓存按业务域分为 6 个 object store：`profile` / `classes` / `schedules` / `homeworks` / `notifications` / `grades`。
- 缓存写入前统一做 JSON 纯化（Vue 响应式对象是 Proxy，直接写入 IndexedDB 会抛 `could not be cloned`）。
- 登录令牌由主进程用 Electron `safeStorage`（Windows 下为 DPAPI）加密后落盘，因此重启客户端可离线进入。
- 令牌缺失/失效时保持缓存资料可见，恢复网络后自动刷新个人资料。

### 打包 Windows EXE

```bash
pnpm dist:dir     # 免安装目录：packages/desktop-client/release/win-unpacked/班级小助手.exe
pnpm dist:win     # nsis 安装包 + portable 单文件（需联网下载 NSIS 工具，可用镜像）
```

打包脚本 `packages/desktop-client/scripts/dist-win.mjs` 做了三件事，规避常见网络问题：

1. **复用本地已解压的 Electron**：检测到 `node_modules/electron/dist/electron.exe` 时通过
   `--config.electronDist` 直接使用，不再重复下载 150MB+ 发行包；
2. 默认走国内镜像（可用环境变量覆盖）：
   `ELECTRON_MIRROR=https://cdn.npmmirror.com/binaries/electron/`、
   `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`；
3. 构建缓存固定到仓库内 `.cache/`，不污染全局目录。

产物说明：`release/win-unpacked/班级小助手.exe`（约 235MB，Electron 运行时）+ `resources/app.asar`
（约 2.7MB，仅含 `dist/` 与 `package.json`，运行时不需要 node_modules）。
默认使用 Electron 内置图标（未提供 `build/icon.ico`）。

### 客户端冒烟验证（无需人工点击）

`pnpm verify:desktop` 以 `ELECTRON_SMOKE_TEST=1` 启动应用（不弹窗），主进程依次校验后自动退出：

| 校验项                                | 实测结果                                                                            |
| ------------------------------------- | ----------------------------------------------------------------------------------- |
| 渲染进程挂载 + 窗口标题               | ✅ `children=1` / `title=班级小助手`                                                |
| 登录页渲染（三个输入框）              | ✅ 服务器地址 / 用户名 / 密码                                                       |
| preload contextBridge 注入            | ✅ 6 个方法                                                                         |
| IPC 往返（getAppInfo/saveConfig）     | ✅ Electron 44.3.0                                                                  |
| 配置文件写入用户目录                  | ✅ `%APPDATA%\@classhelper\desktop-client\config.json`                              |
| IndexedDB 缓存读写                    | ✅ 读写/统计/删除 + 6 个 store                                                      |
| 断网时回退本地缓存                    | ✅ `fromCache=true`（请求不可达端口）                                               |
| 联网集成（`ELECTRON_SMOKE_ONLINE=1`） | ✅ 登录王小明 / 1 班级 / 5 作业 / 4 通知 / 6 成绩 / 第29周29节课 / Socket.IO 已连接 |

该验证对**开发产物与打包后的 EXE 都适用**（打包后用 `ELECTRON_SMOKE_RESULT=<file>` 写出 JSON 结果，
已实测 `packaged: true`、9/9 通过、退出码 0）。

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

| 验收项                                        | 结果 | 证据                                                                                        |
| --------------------------------------------- | ---- | ------------------------------------------------------------------------------------------- |
| 教师 Web 端发布通知，学生端 5 秒内收到        | ✅   | `verify:e2e`：`notification:new` **37–44ms**                                                |
| 教师发布作业，学生能查看并标记完成            | ✅   | `homework:new` **26–40ms**，`PATCH /homeworks/:id/status` 200 且列表回显 `completed=true`   |
| 教师录入成绩，学生能查看个人成绩              | ✅   | `grade:updated` **21–25ms**，`/grades/my` 返回记录；批量录入与统计接口通过                  |
| 学生能查看课表，支持按周切换                  | ✅   | `/schedules/grid?week=1` 返回 30 节，`week` 过滤 `weekStart ≤ week ≤ weekEnd`               |
| 断网后客户端可查看缓存数据                    | ✅   | 客户端冒烟：`断网时回退到本地缓存 → fromCache=true items=1`；离线横幅 + 缓存统计页可用      |
| 权限隔离：学生不能访问其他班级数据            | ✅   | 10 项越权断言全部 403/401（学生跨班/跨班作业/跨班课表、教师跨班发布、未登录访问…）          |
| 能成功打包 Windows EXE                        | ✅   | `班级小助手-0.1.0-x64-setup.exe`(106.9MB) / `-portable.exe`(106.7MB) / `win-unpacked/*.exe` |
| 提供完整 README（启动、构建、打包、默认账号） | ✅   | 本文档含快速开始、命令表、API、WebSocket、RBAC、模块化、MySQL 切换、打包与常见问题          |

打包产物验证（对最终 EXE 实测，非仅开发产物）：

| 产物                                     | 大小    | 冒烟结果                                                       |
| ---------------------------------------- | ------- | -------------------------------------------------------------- |
| `release/win-unpacked/班级小助手.exe`    | 234.7MB | ✅ 9/9，`packaged: true`，退出码 0                             |
| `release/…-x64-portable.exe`（单文件）   | 106.7MB | ✅ 9/9，含联网集成（登录王小明 / Socket.IO 已连接 / 四类数据） |
| `release/…-x64-setup.exe`（NSIS 安装包） | 106.9MB | ✅ 构建成功（安装后运行同一份 `win-unpacked` 内容）            |

当前实测：`pnpm verify:e2e` → **54/54**；`pnpm verify:desktop` → **9/9**；
`pnpm typecheck`、`pnpm lint`、`pnpm build`、`pnpm dist:win` 全部通过。

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

6. **Electron 二进制下载慢或失败**
   `electron` 的 postinstall 会从 GitHub 拉取约 151MB 发行包，本机实测 10 分钟仍未完成。
   规避：安装前设置镜像与缓存目录（本项目已把 electron 缓存指向 `.cache/electron`）：
   `ELECTRON_MIRROR=https://cdn.npmmirror.com/binaries/electron/`。
   打包阶段 `scripts/dist-win.mjs` 已内置该镜像，并优先复用本地已解压的 Electron。

7. **electron-builder 的构建工具（NSIS / winCodeSign）下载慢**
   通过 `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`
   解决（已内置到 `dist-win.mjs`），实测 nsis-3.0.4.1 与 nsis-resources 正常下载。

8. **打包未提供图标**
   未放置 `packages/desktop-client/build/icon.ico` 时使用 Electron 默认图标。
   放入 256×256 及以上尺寸的 `.ico`（或 256×256 PNG）即可自动使用。

## 交付清单（阶段 4-6 新增）

| 路径                                                                  | 说明                                                        |
| --------------------------------------------------------------------- | ----------------------------------------------------------- |
| `packages/desktop-client/src/main/*`                                  | Electron 主进程：窗口、单实例、配置持久化、IPC、冒烟验证    |
| `packages/desktop-client/src/preload/index.ts`                        | contextBridge 安全桥                                        |
| `packages/desktop-client/src/renderer/api/*`                          | Axios 封装（动态服务器地址、JWT、离线不弹错）               |
| `packages/desktop-client/src/renderer/cache/{db,index}.ts`            | IndexedDB 缓存层 + `fetchWithCache` 离线回退                |
| `packages/desktop-client/src/renderer/stores/*`                       | Pinia：auth / app（可达性与同步）/ realtime / notifications |
| `packages/desktop-client/src/renderer/views/*`                        | 登录 / 课表 / 作业 / 通知 / 成绩 / 设置                     |
| `packages/desktop-client/scripts/{build-main,dev,smoke,dist-win}.mjs` | 构建、开发、冒烟、打包脚本                                  |
| `packages/desktop-client/electron-builder.yml`                        | 打包配置（nsis + portable）                                 |

## 后续可选增强

1. 自定义应用图标与安装向导文案（`build/icon.ico`）。
2. 代码签名证书（消除 SmartScreen 提示）。
3. 客户端"提交类操作离线队列"（当前离线为只读，联网后自动同步读取的数据）。
4. 云数据库部署清单（Docker Compose + `prisma migrate deploy`）与 CI 流水线。
5. 课表按当前时间高亮"正在上的课"与上课提醒（可参考 ClassIsland 的课程提醒设计）。
