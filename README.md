# 班级小助手（Class Helper）

班级信息管理系统，采用 pnpm monorepo，包含**后端服务**、**Web 管理端**（教师/管理员）、
**桌面客户端**（学生）与 **ClassIsland 联动插件**（教室机器）。核心链路：

```
教师在 Web 端发布内容
        │  REST API（JWT 鉴权）
        ▼
   后端服务（Express + Prisma）
        │  写入数据库 + 按班级房间广播
        ▼
 Socket.IO ──►  class:{classId} 房间  ──►  学生桌面客户端实时更新 UI

ClassIsland（教室机器）──► 联动插件 ──► /api/integrations/classisland/*（设备令牌鉴权）
                                ▲                        │
                                └──── 老师下发的提醒 ◄────┘
```

> 本文档与代码同步维护：**改动交付形态 / 新增功能后请一并更新本文**。
> 文中出现的条数、计数均标注了实测日期；条目数由脚本自行统计，不要写死过期的总数。

## 当前交付范围

| 阶段 | 内容                                                                                                       | 状态                                                       |
| ---- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1    | pnpm monorepo 脚手架、TypeScript / ESLint / Prettier / 环境变量                                            | ✅ 已完成                                                  |
| 2    | 后端：Prisma schema + 迁移 + 种子数据 + JWT 认证 + RBAC + 模块化 REST API + Socket.IO                      | ✅ 已完成                                                  |
| 3    | Web 管理端：登录、主布局、仪表盘、班级/学生/课表/作业/通知/成绩页面、Axios 封装、实时提示                  | ✅ 已完成                                                  |
| 4    | EXE 客户端：Electron 主进程/preload/渲染进程、登录、课表/作业/通知/成绩/设置、实时推送、IndexedDB 离线缓存 | ✅ 已完成                                                  |
| 5    | 三端联调脚本、打包命令、完整 README                                                                        | ✅ 已完成                                                  |
| 6    | 测试账号与种子数据说明                                                                                     | ✅ 已完成（见下文）                                        |
| 7    | 生产化：服务端安装程序（内置 Node）、Web 端 PWA 可安装、Docker + Nginx 部署、生产加固与运维文档            | ✅ 已完成（见 [`docs/production.md`](docs/production.md)） |
| 8    | 客户端灵动岛（通知浮窗，上课隐藏 / 下课弹出 / 紧急立即展开）与上课时段紧急通知二次确认                     | ✅ 已完成                                                  |
| 9    | 导入：成绩 / 名单表格导入、ClassIsland 时间配置与课程表导入（支持单双周）                                  | ✅ 已完成                                                  |
| 10   | 学生端主体改为**班级账号**（班级码 + 班级密码登录，代全班操作）                                            | ✅ 已完成                                                  |
| 11   | 灵动岛照 WinIsland 重写（连续圆角 + 弹簧形变 + 固定包围盒窗口 + 6 停靠位 + 个性化设置）                    | ✅ 已完成                                                  |
| 12   | **ClassIsland 联动**：教室机器装插件 → 课表/上课状态上报、老师在 Web 端发提醒 → ClassIsland 全屏弹出       | ✅ 已完成                                                  |
| 13   | 作业**按所属日期**查看（日期高亮）+ 教室机器直接录入作业（自定义快捷短语）                                 | ✅ 已完成                                                  |

> **与原始提示词的两处偏差（已与用户确认）**
>
> 1. 桌面客户端采用 **Electron + Vue 3**（而非 Avalonia/FluentAvalonia）：正文 90% 的要求
>    （Socket.IO Client、Pinia、IndexedDB 离线缓存、electron-builder）都基于 Electron。
> 2. 数据库 **先用 SQLite（libSQL 内嵌）跑通 MVP，并预留 MySQL 切换**：`docs/mysql.md` 给出云数据库
>    切换的完整步骤，`deploy/` 提供 MySQL 版与 SQLite 版 Compose。

## 交付产物

| 产物                            | 产物文件位置（打包后）                                               | 用途                                                                                          |
| ------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **服务端 + Web 管理端安装程序** | `release-server/班级小助手服务端-<版本>-x64-setup.exe`               | 装到教师电脑/校服务器即完整系统，**内置 Node 运行时**，双击安装、开机自启、自动建库建号       |
| **学生客户端安装程序**          | `packages/desktop-client/release/班级小助手-<版本>-x64-setup.exe`    | 学生机安装（NSIS 安装包）                                                                     |
| **学生客户端单文件版**          | `packages/desktop-client/release/班级小助手-<版本>-x64-portable.exe` | 免安装直接运行（U 盘分发）                                                                    |
| Web 管理端（PWA）               | 由服务端在 `/` 直接托管                                              | 浏览器打开即用，可在 Edge/Chrome 中「安装为应用」；**已适配手机小屏**（1Panel 风格抽屉导航）  |
| **ClassIsland 联动插件**        | `releases/classisland-plugin/ClassHelper.ClassIslandPlugin.cipx`     | 装在教室机器的 ClassIsland 上（也可直接把 `ClassHelper.ClassIslandPlugin/` 目录丢进 Plugins） |

> 这些产物**都不入库**（`release-server/`、`packages/*/release/`、`releases/` 均已忽略）。
> 本仓库的约定是把它们归集到根目录 `releases/`（`client/`、`server/`、`classisland-plugin/`），详见 [AGENTS.md](AGENTS.md) §4。

生产部署请看 **[docs/production.md](docs/production.md)**，四种形态按场景选：

| 场景                                | 形态                                                            | 入口                                                                                   |
| ----------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 学校机房 / 教师电脑（Windows 单机） | Windows 服务端安装程序（内置 Node，双击即用）                   | `release-server/班级小助手服务端-<版本>-x64-setup.exe`                                 |
| 云服务器 / 多终端共享（推荐长期）   | Docker Compose + MySQL（另有 SQLite 单容器版）                  | `deploy/Dockerfile`、`deploy/docker-compose{,.sqlite}.yml`                             |
| **已有 Linux 服务器**               | **systemd + SQLite 一键脚本（含 Nginx 反代与 WebSocket 配置）** | `sudo bash deploy/install-linux.sh`（先 `--check` 体检）、`deploy/classhelper.service` |
| 自定义 / 已有 Node 环境             | 手动部署免安装目录                                              | `pnpm dist:server` → `release-server/classhelper-server/`                              |

## 目录结构

```
class-helper/
├── package.json                 # 根脚本（dev / build / db:* / verify:* / dist:* / icons）
├── pnpm-workspace.yaml          # workspace 定义 + allowBuilds（pnpm 11 依赖构建白名单）
├── tsconfig.base.json           # 共享 TS 基础配置
├── eslint.config.mjs            # ESLint 扁平配置（TS + Vue）
├── .prettierrc.json             # 单引号 / 110 列 / LF / 尾逗号
├── .dockerignore                # 容器构建上下文排除项
├── build/icon.{ico,png}         # 应用图标（由 pnpm icons 生成）
├── scripts/
│   ├── use-database.mjs         # SQLite ⇄ MySQL provider 切换助手（改写 schema.prisma 的 provider）
│   ├── generate-icons.mjs       # 用 Electron 渲染 SVG 生成 PNG/ICO 图标
│   ├── icons/render.cjs         # 图标渲染脚本（CommonJS）
│   ├── dist-server.mjs          # 服务端 + Web 管理端 打包（免安装目录 + NSIS 安装程序）
│   ├── verify-packaged.mjs      # 对打包后/已安装的客户端 EXE 复跑冒烟
│   ├── lib/electron-env.mjs     # 启动 Electron 的公共处理（清理 RUN_AS_NODE + 定位可执行文件）
│   ├── lib/node-runtime.mjs     # 定位真正的 node.exe（打包与 electron-builder 用）
│   ├── nsis/server-installer.nsi# 安装程序脚本模板
│   └── ui-smoke/                # Web 管理端 UI 真实点击回归（Electron 驱动 + 上课时段探针）
├── deploy/                      # 生产部署：Dockerfile / docker-compose{,.sqlite}.yml / nginx.conf
│   ├── install-linux.sh         # Linux 一键部署（systemd + SQLite，含 .env 生成与就绪探针）
│   ├── classhelper.service      # systemd 单元模板（脚本会替换 __NODE__/__DIR__/__USER__）
│   ├── package.runtime.json     # 运行时依赖清单（安装包 / 容器 / Linux 部署共用）
│   └── .env.example / .env.sqlite.example
├── docs/
│   ├── production.md            # 生产部署指南（四种形态 + Linux systemd + 运维 + 安全清单）
│   ├── mysql.md                 # MySQL 切换指南
│   ├── winisland-design-tokens.md  # 灵动岛照 WinIsland 提取的设计 token
│   └── screenshots/             # 回归测试自动留档的截图（island / client / web-mobile / classisland）
└── packages/
    ├── shared/                  # 三端共享：类型契约、常量、权限矩阵、工具函数
    │   └── src/{types,constants,permissions,utils,index}.ts
    ├── server/                  # 后端服务
    │   ├── prisma/schema.prisma         # 数据模型（14 个 model）
    │   ├── prisma/migrations/           # 迁移历史（9 个）
    │   ├── prisma/seed.ts               # 种子数据
    │   ├── prisma.config.ts             # Prisma 7 配置（迁移/种子/连接串）
    │   ├── scripts/verify-e2e.mjs       # 后端端到端验收脚本
    │   ├── scripts/verify-classisland.mjs  # 联动链路验收脚本
    │   └── src/
    │       ├── app.ts                   # Express 装配（静态托管 + 探针 + 限流 + 模块挂载）
    │       ├── index.ts                 # 启动入口（自检/初始化 + HTTP + Socket.IO + 优雅退出）
    │       ├── config/env.ts            # 环境变量校验（zod）+ 生产配置自检
    │       ├── lib/                     # access(RBAC) / class-account / session / db / db-bootstrap /
    │       │                            #   snapshot(全库 JSON 快照) / web-static / http / jwt / logger /
    │       │                            #   mappers / password / schemas / term
    │       ├── tools/apply-snapshot.ts  # 跨库迁移的子进程入口（编译到 dist/tools/）
    │       ├── middleware/              # auth / error / validate / security(helmet+限流+耗时日志)
    │       ├── realtime/                # socket.ts + bus.ts（事件总线）
    │       └── modules/                 # 14 个功能模块 + registry.ts（模块注册表）
    │           └── database/             # 数据库管理（状态/备份/导入导出/定时/一键切换，仅管理员）
    ├── classisland-plugin/      # ClassIsland 联动插件（.NET 8 / C#，独立于 pnpm workspace）
    │   ├── src/Plugin.cs                # 插件入口（读配置 → 注册提醒提供方/设置页/联动服务）
    │   ├── src/Models/PluginSettings.cs
    │   ├── src/Services/BridgeService.cs                    # 上报 / 接收 / 镜像主循环
    │   ├── src/Services/ScheduleMapper.cs                   # 课表与单双周映射
    │   ├── src/Services/ClassPlanWriter.cs                  # 镜像回 ClassIsland（含课间时间点）
    │   ├── src/Services/ClassHelperNotificationProvider.cs  # 把老师发的提醒显示到 ClassIsland 上
    │   ├── src/Views/BridgeSettingsPage.axaml(.cs)          # 「班级小助手联动」设置页（Avalonia）
    │   ├── src/Interop/ClassHelperClient.cs                 # 后端 HTTP 客户端 + 与服务端对齐的 DTO
    │   ├── manifest.yml                 # ClassIsland 插件清单（id / apiVersion / entranceAssembly）
    │   └── scripts/{build,verify}.mjs   # 构建打包（.cipx）与静态契约校验
    ├── web-admin/               # Web 管理端（Vue 3 + Vite + Element Plus + PWA）
    │   ├── public/                      # manifest.webmanifest / sw.js / 图标（由 pnpm icons 生成）
    │   └── src/{api,stores,router,layouts,views,components,composables,styles}
    └── desktop-client/          # EXE 客户端（Electron + Vue 3）
        ├── electron-builder.yml         # 打包配置（nsis 安装包 + portable 单文件）
        ├── build/icon.ico               # 应用图标（electron-builder 自动使用）
        ├── vite.config.mts              # 渲染进程构建（base: './'，hash 路由）
        ├── scripts/{build-main,dev,smoke,dist-win}.mjs
        └── src/
            ├── main/                    # 主进程：窗口/单实例/配置持久化(IPC)/托盘/灵动岛/冒烟
            ├── preload/                 # contextBridge 安全桥（index.ts + island.ts）
            ├── island/                  # 灵动岛渲染进程（独立透明置顶窗口）
            ├── types/desktop.d.ts       # 主进程 <-> 渲染进程契约
            └── renderer/                # 渲染进程：api / stores / cache / router / layouts / views
```

## 技术栈

| 层         | 选型                                                                 | 版本（`package.json` 实际声明）                       |
| ---------- | -------------------------------------------------------------------- | ----------------------------------------------------- |
| 包管理     | pnpm workspace                                                       | 11.8.0                                                |
| 语言       | TypeScript                                                           | 5.9.3（`typescript-eslint` 要求 < 6.1，因此未用 7.x） |
| 后端       | Node.js + Express                                                    | ≥ 20.19（本机 24.19） / 5.2                           |
| ORM        | Prisma + driver adapter                                              | 7.10（+ `@prisma/adapter-libsql`）                    |
| 实时       | Socket.IO                                                            | 4.8                                                   |
| 认证       | jsonwebtoken + bcryptjs                                              | 9.0 / 3.0                                             |
| 校验       | zod                                                                  | 4.6                                                   |
| Web 端     | Vue + Vite + Element Plus + Pinia + Vue Router + Axios + ECharts     | 3.5 / 8.3 / 2.14 / 4.0 / 5.3 / 1.20 / 6.1             |
| EXE 客户端 | Electron + Vue + Element Plus + Pinia + Socket.IO Client + IndexedDB | 44.3 / 3.5 / 2.14 / 4.0 / 4.8                         |
| 打包       | electron-builder（nsis / portable）                                  | 26.15                                                 |
| Lint/格式  | ESLint 10 + typescript-eslint 8 + eslint-plugin-vue 10；Prettier 3   | —                                                     |

## 快速开始

```bash
# 1. 安装依赖（Node >= 20.19，pnpm >= 10）
pnpm install

# 2. 准备环境变量（后端）
cp packages/server/.env.example packages/server/.env
#    → 至少修改 JWT_SECRET；TERM_START_DATE 建议设为当学期第 1 教学周的周一

# 3. 生成 Prisma Client、应用迁移、写入种子数据
pnpm db:generate
pnpm --filter @classhelper/server db:deploy   # 注意：根 scripts 里没有 db:deploy
pnpm build:shared                             # shared 是三端与 seed 的前置产物，必须先构建
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
> Web 管理端地址是 **5173** 端口（构建后由后端在 4000 托管）。

也可以分开启动：`pnpm dev:server`（仅后端）、`pnpm dev:web`（仅 Web 端）。

### 启动 EXE 客户端（学生端）

```bash
# 开发模式：自动构建主进程 + 启动 Vite 渲染进程(5174) + 打开 Electron 窗口（支持热更新）
pnpm dev:desktop

# 已构建产物的冒烟验证（不弹窗，跑完自动退出）
pnpm build:desktop
pnpm verify:desktop
```

> Electron 二进制**不会**随 `pnpm install` 自动下载，缺失时先手动装一次（见 [AGENTS.md](AGENTS.md) §7 第 5 条）。

客户端首次启动会带上默认服务器地址 `http://127.0.0.1:4000`，输入**班级码 + 班级密码**（种子数据：`G101` / `123456`）即可进入班级。
若要验证"断网可查看缓存"，登录并浏览过程程后关闭后端（`Ctrl+C` 停掉 `pnpm dev:server`），
客户端会在顶部提示「当前处于离线状态」，页面继续显示本地缓存数据；重新启动后端后会自动同步。

### 验收脚本

```bash
# 另开一个终端先启动后端：pnpm dev:server
pnpm verify:e2e         # 后端端到端：REST + Socket.IO + RBAC + 上课时段拦截 + 叫人 + 单双周课表
                        #   + ClassIsland 课程表导入 + 班级账号代全班操作 + 教师录入 + 删除教师级联护栏（2026-09-30 实测 173 项全过）
pnpm verify:classisland # ClassIsland 联动链路：设备令牌 / 上报 / 提醒下发与回执 / 镜像契约 / 幽灵行清理（实测 42 项）
pnpm verify:classisland-plugin
                        # 插件静态契约：清单一致性 / 注册完整性 / C# DTO ↔ 服务端 zod 与路由 / 已修复坑的护栏（实测 68 项，不需要后端）
pnpm verify:web         # Web 管理端真实点击回归（Electron 驱动，需 Web 产物已构建）
pnpm verify:desktop     # 客户端冒烟（Electron，无人工点击）
pnpm verify:packaged    # 对**打包后/已安装**的客户端 EXE 跑同一套冒烟（--exe 指定路径）
```

> **Electron 相关的三套（`verify:web` / `verify:desktop` / `verify:packaged`）在 AI 会话里也能跑**：
> 早期文档说"AI 会话启动 Electron GUI 会崩"是**误诊** —— 真正原因是我们构建出的产物被打上了
> Low 完整性标签（Chromium 的沙箱子进程读不到自己的文件），修好标签后 `verify:packaged`
> 在 AI 会话里完整跑通（2026-09-30 实测：见下方验收表）。若它们又"启动即崩"，
> 先看 [AGENTS.md](AGENTS.md) §7 第 7 条，别急着甩锅给会话环境。
> 其余脚本（`verify:e2e` / `verify:classisland` / `verify:classisland-plugin`）本来就能在 AI 会话内跑。

后端脚本验证**实时推送时延、作业完成、成绩下发、权限隔离、上课时段紧急通知拦截、导入与失败回滚、
班级账号代全班操作、老师端导入不越权、单双周课表与 ClassIsland 课程表导入、教师录入、个人学生登录停用**等；
客户端脚本验证 preload 桥接、渲染进程、IndexedDB 读写、断网回退、**灵动岛状态机**与联网集成
（班级账号登录 + 四类数据 + Socket.IO）。
`pnpm verify:packaged --exe "<客户端路径>"` 对**打包后/已安装**的 EXE 跑同一套用例（`packaged: true`），
用于确认交付给学生的那个副本真的带上了本次修复 —— 开发产物通过**不等于**用户机器上的副本通过。

## 默认账号与种子数据

`pnpm db:seed` 会清空业务表并写入一套完整演示数据。**2026-09-30 实测计数**
（种子脚本自身会打印）：

```
用户 18（1 管理员 + 2 教师 + 15 名学生名单）/ 班级 3 / 课程 54（每班 18 科）
课表 93（每班 5 天 × 6 节 + 1 条双周对调）/ 作业 15 / 通知 12 / 成绩 90
```

| 角色   | 用户名        | 密码         | 说明                                       |
| ------ | ------------- | ------------ | ------------------------------------------ |
| 管理员 | `admin`       | `admin123`   | 可访问全部班级                             |
| 教师   | `teacher1`    | `teacher123` | 张老师：高一(1)班、高二(3)班班主任         |
| 教师   | `teacher2`    | `teacher123` | 李老师：高一(2)班班主任，高二(3)班协作教师 |
| 班级   | 班级码 `G101` | `123456`     | 高一(1)班（**学生端唯一登录方式**）        |
| 班级   | 班级码 `G102` | `123456`     | 高一(2)班                                  |
| 班级   | 班级码 `G203` | `123456`     | 高二(3)班                                  |

- 密码由**种子脚本硬编码**（`admin123` / `teacher123` / 班级 `123456`）；`.env` 的
  `DEFAULT_CLASS_PASSWORD` 决定**新建**班级时的初始班级密码。
- **学生没有个人账号**（2026-10-01 起彻底清理）：学生只是名单记录（成绩 / 未交名单 / 已读人数 /
  叫人都按名单），没有用户名密码、不能登录；学生端统一用班级码 + 班级密码。班级密码由管理员在
  「班级管理 → 修改班级账号」维护，客户端不再提供改密入口。
- **班级账号**（学生端主入口）用班级码 + 班级密码登录；管理员可在「班级管理 → 班级账号」里改班级码或重置密码，
  详见 [学生端班级账号](#学生端班级账号学生端主体--班级)。
- 教学周由 `TERM_START_DATE`（第 1 教学周的周一）换算，当前周次用于课表默认视图。

## 常用命令

| 命令                                          | 说明                                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------- |
| `pnpm dev`                                    | 并行启动 shared(tsc watch) + 后端 + Web 端                                            |
| `pnpm dev:server` / `pnpm dev:web`            | 只启动后端 / 只启动 Web 端                                                            |
| `pnpm dev:desktop`                            | 启动 EXE 客户端开发模式（Vite 5174 + Electron，热更新）                               |
| `pnpm build`                                  | 构建 shared + 后端 + Web 端 + EXE 客户端                                              |
| `pnpm build:desktop`                          | 仅构建 EXE 客户端（esbuild 主进程/preload + Vite 渲染进程）                           |
| `pnpm build:classisland-plugin`               | 构建 ClassIsland 联动插件（.NET 8，产物在 `packages/classisland-plugin/bin/Release`） |
| `pnpm dist:classisland-plugin`                | 打包插件为 `.cipx` 并归集到 `releases/classisland-plugin/`（含免安装目录）            |
| `pnpm icons`                                  | 生成应用图标（PNG/ICO，用 Electron 渲染 SVG）                                         |
| **`pnpm dist:server`**                        | **打包服务端 + Web 管理端**（免安装目录 + NSIS 安装程序，内置 Node）                  |
| `pnpm dist:dir`                               | 打包客户端免安装目录 `release/win-unpacked`（含可执行文件，最快）                     |
| `pnpm dist:win`                               | 打包客户端 nsis 安装包 + portable 单文件 EXE                                          |
| `pnpm dist:all`                               | 服务端安装程序 + 客户端安装包 + 插件一起打                                            |
| `pnpm verify:e2e`                             | 后端端到端验收（需服务端已启动）                                                      |
| `pnpm verify:web`                             | Web 管理端 UI 真实点击测试（Electron 驱动，需桌面会话）                               |
| `pnpm verify:desktop`                         | EXE 客户端冒烟验证（需桌面会话）                                                      |
| `pnpm verify:packaged`                        | 对打包后/已安装的客户端 EXE 跑同一套冒烟（`--exe` 指定路径）                          |
| `pnpm verify:classisland`                     | ClassIsland 联动链路（需服务端已启动）                                                |
| `pnpm verify:classisland-plugin`              | 插件静态契约校验（不需要服务端）                                                      |
| `pnpm typecheck`                              | 全仓库类型检查（含 `vue-tsc`）                                                        |
| `pnpm lint` / `pnpm lint:fix`                 | ESLint 检查 / 自动修复                                                                |
| `pnpm format` / `pnpm format:check`           | Prettier 格式化 / 检查（`format:check` 在 master 基线上本就失败，只检查改过的文件）   |
| `pnpm db:generate`                            | 生成 Prisma Client（输出到 `packages/server/src/generated/prisma`）                   |
| `pnpm db:migrate`                             | 创建并应用迁移（`prisma migrate dev`；本机不可靠，用下面的 db:deploy）                |
| `pnpm --filter @classhelper/server db:deploy` | 应用已有迁移（**本机推荐**；根 scripts 里没有 `db:deploy`）                           |
| `pnpm db:seed`                                | 写入种子数据                                                                          |
| `pnpm db:reset`                               | 重置数据库并重新执行 seed                                                             |
| `pnpm db:studio`                              | 打开 Prisma Studio                                                                    |
| `pnpm db:switch:mysql` / `db:switch:sqlite`   | 切换数据库 provider（改写 `schema.prisma`，无第二份 schema）                          |

## Web 管理端（含手机小屏适配）

布局沿用 **1Panel 风格**：固定深色侧边栏（`#1f2d3d` + 蓝色圆角选中态）+ 白色顶栏（当前页标题/连接状态/用户菜单）+
浅灰底 + 白色圆角卡片内容区。手机小屏下侧边栏收进抽屉，由顶栏汉堡按钮唤出。

页面（路由）共 12 个：登录、仪表盘、班级管理、学生管理、教师管理、课表管理、作业发布、通知发布、
成绩录入、ClassIsland 联动、数据库管理、页面不存在；其中**班级管理 / 学生管理 / 教师管理 / 数据库管理**
为 `meta.roles: ['ADMIN']`（直接输网址会被挡回仪表盘，服务端同样拦），
**ClassIsland 联动**为 `['ADMIN','TEACHER']`。

### 新手引导（首次登录 + 随时重看）

首次登录进入主布局后会自动弹出**聚焦式引导**（Element Plus `el-tour`）：欢迎页 → 侧边菜单（小屏为汉堡按钮，
锚点不存在时卡片自动改为屏幕居中）→ 实时通道状态 → 账号菜单 → 完成。走完或跳过（右上角 × / Esc）即记为
"已看过"（localStorage `classhelper.onboarding`，值为引导版本号，内容改版后 +1 可让老用户再看一次），
之后不再自动弹出；**右上角头像菜单 →「使用引导」可随时重看**。实现集中在 `AdminLayout.vue`（锚点用
`data-tour` 属性惰性查询）。

### 圆角设计（统一设计令牌）

全站圆角与柔和投影集中定义在 `packages/web-admin/src/styles/index.css` 的 `:root` 令牌里，
组件层不写死数值；Element Plus 也通过对齐它的圆角变量（`--el-border-radius-*`）一并改造：

| 令牌                   | 值       | 用在哪                                                       |
| ---------------------- | -------- | ------------------------------------------------------------ |
| `--ch-radius-xl: 22px` | 22px     | 弹窗、抽屉、侧栏外缘                                         |
| `--ch-radius-lg: 18px` | 18px     | 卡片（`el-card`）、统计卡、消息框                            |
| `--ch-radius-md: 14px` | 14px     | 下拉/浮层/气泡、`el-alert`、描述列表、上传区                 |
| `--ch-radius-sm: 10px` | 10px     | 按钮、输入框、下拉框、日期选择、分页、侧栏菜单项、单选按钮组 |
| `--ch-radius-pill`     | 999px    | 标签 `el-tag`、开关、进度条、圆形按钮                        |
| `--ch-shadow-sm/md`    | 两级投影 | 卡片默认 / 悬停与弹窗                                        |

配套观感调整：卡片去掉 1px 灰边框（改用轻投影 + 悬停微浮起）、顶栏底部圆角、深色侧栏右侧圆角、
表头底色统一为 `#f7f9fc`、弹窗头部/底部留白加大。全部通过 CSS 变量与少量类选择器覆盖，未改组件源码。

| 断点             | 布局行为                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `> 992px` 桌面   | 常驻 210px 深色侧边栏 + 顶栏显示连接状态与"已接收 N 条实时事件"                               |
| `769–992px` 平板 | 保留侧边栏，内容区内边距压缩（14px）                                                          |
| `<= 768px` 手机  | 侧边栏**不渲染**，顶栏汉堡按钮 → 240px 深色抽屉菜单；顶栏显示当前页标题；用户菜单收成头像图标 |

手机端细节（1Panel 同款思路：控件纵向铺满、表格卡片内滚动、弹窗自适应）：

| 位置        | 小屏行为                                                                      |
| ----------- | ----------------------------------------------------------------------------- |
| 抽屉菜单    | 点汉堡滑出、点菜单项自动收起；`aria-expanded` 标记状态；桌面端侧边栏视觉不变  |
| 顶栏        | 只保留汉堡 + 当前页标题 + 连接状态圆点 + 头像；身份信息移入用户下拉菜单第一行 |
| 页面工具栏  | 选择器/搜索框/按钮全部铺满整行（`width: 100%`），方便拇指点击                 |
| 表格        | 卡片内横向滚动（`.table-card` + `overflow-x: auto`），页面本身不横向滚动      |
| 弹窗/消息框 | 宽度 `calc(100vw - 24px)`、贴近整屏；表单标签与输入框自适应                   |
| 详情抽屉    | 宽 86vw；`el-descriptions` 由 2~3 列自动降为单列，避免文字被压成竖排          |
| 统计卡片    | `.stat-grid` 两列；登录页卡片自适应宽度并保留安全内边距                       |

实拍（`pnpm verify:web` 自动留档到 `docs/screenshots/web-mobile/`）：

| 场景                                      | 截图                                                                  |
| ----------------------------------------- | --------------------------------------------------------------------- |
| 手机抽屉菜单                              | ![手机抽屉菜单](docs/screenshots/web-mobile/mobile-1-drawer.png)      |
| 手机通知页（工具栏铺满 + 表格卡片内滚动） | ![手机通知页](docs/screenshots/web-mobile/mobile-2-notifications.png) |
| 手机弹窗自适应                            | ![手机弹窗](docs/screenshots/web-mobile/mobile-3-dialog.png)          |

实现位置：`src/composables/useResponsive.ts`（断点 + resize 监听）、`src/layouts/AdminLayout.vue`（抽屉/顶栏）、
`src/styles/index.css`（全局响应式规则）、各视图表格卡片加 `.table-card`。

> 踩坑记录：这套检查必须让窗口**真正可见**（`win.showInactive()`）。
> Chromium 会冻结隐藏页面的 CSS transition，Vue 的 `<Transition>` 收不到 `transitionend`，
> Element Plus 抽屉会一直停在 `enter-from`（表现为"点了没反应"）——冒烟里已按"等抽屉滑到位"断言，避免误判。

> 手机访问：与电脑同一局域网时用 `http://<主机IP>:4000` 打开管理端；
> 支持「添加到主屏幕」（PWA manifest + Service Worker）。

### 人员与班级（仅管理员）

| 能力                     | 说明                                                                                                                                                                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **教师管理**（独立页面） | 侧边栏「教师管理」：**单个录入**（姓名 / 用户名 / 初始密码 / 角色）＋**导入名单**（xlsx/csv，列：用户名、姓名、初始密码、角色）＋编辑（改名/改角色）＋修改密码＋删除                                                                           |
| 录入教师仅管理员         | 页面只对 `ADMIN` 显示，路由 `meta.roles=['ADMIN']` 直接输网址也会被挡回仪表盘；服务端 `/api/teachers` 全量接口 `requireRole('ADMIN')`（教师调用 403，e2e 有断言）                                                                              |
| 删除教师有护栏           | 四种情况一律拒绝（409）：还是**班主任**、名下有课程/班级分配、**发布过作业或通知**（`Homework.createdBy` / `Notification.createdBy` 也是级联删除，删账号会连带删掉他在各班发过的内容）——教师是数据创建者，护栏清单与 schema 的级联关系一一对应 |
| 创建班级仅管理员         | `POST /api/classes` = `requireRole('ADMIN')`，教师（含班主任）403；前端「新建班级」也只在管理员可见                                                                                                                                            |
| **设置 / 更改班主任**    | 新建班级时可直接选班主任（默认自己）；班级详情顶部「更换班主任」下拉随时改（`PATCH /api/classes/:id/head-teacher`，仅管理员），原班主任仍保留在协作教师名单                                                                                    |
| 学生录入（原有）         | 「学生管理」：单个新建（登录名自动生成）＋导入名单；学生端主体是班级账号                                                                                                                                                                       |

> 学生名单接口（`/api/students`）与教师全量接口（`/api/teachers`）都是 **`requireRole('ADMIN')`**；
> 「班级 → 学生名单」（`/api/classes/:id/students`）读接口对班级可见，写接口为 ADMIN/TEACHER（服务层再按班级角色兜底）。

### 授课科目统一（不再按班级一个个录）

全校固定科目目录定义在 `@classhelper/shared` 的 `SUBJECT_CATALOG`（共 18 科）：
**语文 / 数学 / 英语 / 政治 / 历史 / 物理 / 化学 / 地理 / 生物 / 信息技术 / 体育 / 美术 / 音乐 / 班会 / 早读 / 晚读 / 通用技术 / 听力**。

- 课表「新增课表」与成绩「单条/批量录入」的**科目下拉直接列出这个统一目录**（该班还没有的科目显示在「统一科目（选中后自动建课）」分组里）；
- 选中后由前端自动为该班 `POST /api/courses` 建同名课程（已存在则复用），再写入课表/成绩 —— 科任与班主任都不需要先去"班级 → 课程"里把科目建一遍；
- ClassIsland 课程表导入本来就会按导入内容自动补建课程，两者口径一致；
- `pnpm verify:web` 会在真实浏览器里打开「新增课表」，断言统一科目分组存在、选中后课表写入成功，并在收尾删掉这条课表（不留副作用）。

### 登录页

管理端与客户端登录页都**不含任何示例/演示内容**（没有"演示账号点击填充"、没有示例班级码占位符、
不提示种子账号）；`pnpm verify:web` 与 `pnpm verify:desktop` 各自断言登录页正文与占位符里不出现
`演示 / 示例 / admin123 / teacher123 / G101` 等字样，防止以后又被加回去。

## EXE 客户端（学生端）

### 进程结构与安全设置

| 进程     | 文件                                  | 职责                                                                                             |
| -------- | ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 主进程   | `src/main/*` → `dist/main/index.js`   | 窗口/单实例锁、配置持久化（`safeStorage` 加密 token）、IPC、托盘、灵动岛、冒烟验证               |
| 预加载   | `src/preload/*` → `dist/preload/*`    | 通过 `contextBridge` 暴露最小 API（配置读写 / 应用信息 / 灵动岛控制），不暴露 `ipcRenderer` 本体 |
| 渲染进程 | `src/renderer/**` → `dist/renderer/*` | Vue 3 界面、Axios 请求、Socket.IO 实时、IndexedDB 离线缓存                                       |

安全基线：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、`webSecurity: true`，
外部链接一律交给系统浏览器打开，禁止应用内导航到非本地地址（按**同源 / 同一文件**精确比对，不是 `startsWith`）。
渲染进程启用 **CSP**（`index.html` / `island.html` 的 `meta http-equiv`）：`script-src 'self'` 只允许执行本应用脚本 ——
渲染进程能通过桥接拿到明文登录令牌，CSP 是唯一能拦住"加载并执行远程脚本"的那一层；
灵动岛窗口另有独立的导航防线（拒绝一切导航与新开窗口）。

**主窗口初始尺寸与 ClassIsland 对齐（1242×582）**：这个数是从运行中的 ClassIsland 主窗口实测来的
（`GetWindowRect` + `DwmWindowAttribute` 读可视区），启动时居中显示；窗口底色按主题设置，避免深色下"先白后黑"。

**安装包里不得出现任何凭据**：`dist/main/index.js` 与 `dist/renderer/assets/*.js` 会被打进 `app.asar`（可直接解包），因此冒烟/自检代码用的账号口令一律由 `scripts/smoke.mjs` / `scripts/verify-packaged.mjs` 通过环境变量（`ELECTRON_SMOKE_USER` / `ELECTRON_SMOKE_PASSWORD` / `..._CLASS_CODE` / `..._CLASS_PASSWORD`）注入，不写在源码里；`pnpm build:desktop` 结尾会跑 `check-bundle-secrets` 门禁，产物里一旦出现种子口令即构建失败。

### 功能页面

| 页面 | 功能                                                                                                                                                                                                                       |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 登录 | 服务器地址 + **班级码 + 班级密码**，附带「测试连接」；已登录但服务器不可达时可「离线进入」；下方有「查看使用引导」入口                                                                                                     |
| 课表 | 按周展示 7 列课表（周次下拉 + 单双周标签），另有「今天」时间轴视图（大时钟 + 当前状态卡 + 已结束/正在上/下一节）                                                                                                           |
| 作业 | **看板模式**（按科目卡片、全屏放大、显示时间开关、看板字号）＋ 列表模式、详情抽屉、附件链接（只接受 `http(s)://` 或站内相对路径，挡住 `javascript:` 这类可执行链接）；教室设备可**录入作业**（快捷短语）与勾选**未交名单** |
| 通知 | 未读红点（侧边栏徽标）、优先级标签、点击自动标为已读、全部已读、未读过滤、详情抽屉                                                                                                                                         |
| 成绩 | 班级账号看到**全班成绩总览**：表格（分数/得分率/等级）+ ECharts 柱状图 + 等级分布 + 最近更新                                                                                                                               |
| 设置 | 拆成六个子页（见下）：通用（服务器/离线缓存/作业录入短语 + 使用引导）、外观（黑夜/白天）、灵动岛、提醒（ClassIsland 联动）、账号、关于                                                                                     |

### 设置改版：分组侧边栏 + 子页 + 深色模式 + 关于页

**侧边栏（ClassIsland 同款 NavigationView）**：主侧边栏改为「学习」「设置」两个**可展开分组**
（学习 = 课表/作业/通知/成绩；设置 = 通用/外观/灵动岛/提醒/账号/关于，每个子项是独立路由
`/settings/*`）；顶部**汉堡按钮**把整栏折叠成 64px 图标栏（折叠状态持久化到主进程配置，
重启仍记忆）。红点徽标仍挂在「通知」项图标右上角。

**设置子页**：原单页设置按卡片拆为 6 个子页——通用（服务器连接 + 离线缓存 + 作业录入短语 +
「使用引导」）、外观、灵动岛、提醒、账号、关于；设置入口重定向到 `/settings/general`。

**黑夜/白天模式**：外观子页选「浅色 / 深色」，顶栏右上角有日月快捷切换按钮；切换立即生效
（`html.dark` + Element Plus dark css-vars + 品牌变量 `html.dark` 覆盖）并写入主进程配置
（`theme` 字段），启动窗口底色也按主题设置（避免"先白后黑"闪一下）。灵动岛、登录页、
全屏作业看板本来就是深色/固定配色，不随主题变化。

**关于页**（ClassIsland 同款折叠卡片）：应用信息（版本 / Electron / Chromium / Node / 常用链接）、
查看诊断信息（服务器与连接状态、缓存条目、数据目录、**配置文件路径**）、鸣谢；底部寄语。
诊断信息依赖 `getAppInfo` 新增的 `configPath` 字段。

### 初次启动引导（六步向导，可重看）

客户端**首次启动**（配置里没有 `onboardingDone`）会在登录页上自动弹出六步向导：
欢迎 → 连接服务器 → 登录班级 → 登录之后（主界面与离线缓存）→ 灵动岛提醒 → 完成。
完成或跳过（右上角「跳过引导」/ Esc）都会把 `onboardingDone: true` 写入主进程配置（`config.json`），
之后不再自动弹出；**登录页「查看使用引导」与「设置 → 通用 → 使用引导」可随时重看**。

实现说明：引导是自绘遮罩 + `v-if`（`renderer/components/OnboardingWelcome.vue`），关闭即从 DOM 卸载
（特意不用 el-dialog，避免"关闭后 DOM 残留"的断言陷阱）；显隐由 `stores/onboarding.ts` 承载，
让登录页 / 设置页 / App.vue 三处共用一个开关。`verify:desktop` 有一条端到端回归：
「初次启动引导（首启自动弹出、可走完、状态写入配置）」——真实点击把六步走完并断言配置落盘。

**作业看板（学生端）**：默认按科目分卡片（每张卡列该科作业，条目可点开详情），
工具栏可切「看板 / 列表」、开关「显示时间」、拖「字号」（11–28px 即时生效），
点卡片或「全屏看板」进入全屏放大视图；这些偏好写入客户端配置（`homeworkBoard`），重启后仍生效。

看板行为细节（按用户反馈逐条落地）：

| 需求                       | 实现                                                                                                                                                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 只看当天的作业             | 工具栏「只看今天」开关（默认开）：按 `Homework.assignDate`（本地日期）过滤，昨天的作业不再混进看板                                                                                                             |
| 作业要完整显示             | 卡片里同时渲染**标题 + 作业要求全文**（`white-space: pre-wrap`，不截断），列表模式也有「作业要求」列                                                                                                           |
| 全部铺满屏幕、不用上下翻页 | 看板外层高度固定 + `overflow: hidden`，按「内容高度 / 可用高度」算缩放系数用 `transform: scale()` 整体缩到刚好放下（字号仍由滑块决定，工具栏显示当前缩放比例）                                                 |
| 全屏看板要自适应           | 全屏弹窗打开后按「可用宽 × 可用高」枚举 1..N 列，取**单卡面积最大且宽高比最接近 1.15** 的方案注入 `--board-cols`（`fitFullscreen()` 轮询等待弹窗挂载后再算）；列数变了再量一次缩放系数，窗口 resize 时自动重算 |
| 当天时间显示在标题栏正中   | 全屏看板标题栏用 `#header` 插槽：标题左对齐、当天日期时间**绝对居中**显示（受「显示时间」开关控制，每分钟刷新）                                                                                                |
| 未交名单                   | 作业列表/详情里点「未交名单」→ 勾选**没交作业**的同学 → 保存后其余同学自动标记为已完成（`PATCH /api/homeworks/:id/submissions`）；Web 管理端作业详情抽屉里同样可看可改                                         |

**学生端主体 = 班级（学生个人账号已彻底清理）**：学生只是名单记录（作业完成 / 通知已读 / 成绩 /
未交名单 / 叫人按名单记录，由班级会话代全班读写），**没有用户名密码、不能登录** ——
`POST /api/auth/login` 对 `role=STUDENT` 一律返回 **403**；重置学生密码等账号类接口已全部下线。
客户端设置页也不再提供改密入口，班级密码由管理员在「班级管理 → 修改班级账号」维护。

> 通知到达时还会由**灵动岛**在桌面中上方浮出提醒（见下一节），上课时段自动隐藏、紧急通知立即展开。

### 灵动岛（桌面通知浮窗）

客户端有一个独立于主窗口的**灵动岛**：一个无边框、透明、置顶、不占任务栏的窄条窗口。它是"消息到达"的第一现场。

> **联合通知（紧急 + 作业）为什么以前"点不开新作业"**：上课时段里紧急通知会自动展开，
> 学生收起后再来一条作业时 `active` 仍是紧急那条 —— 点击只会反复打开它；而且就算把 active
> 换成新作业，`syncWindow` 的上课时段守卫又会立刻把普通通知隐藏（表现为"点了没反应"）。
> 现在两处都修了：①点击胶囊优先打开**最新**那条未处理消息（队列里更晚的那条）；
> ②上课时段里"用户主动点开"的那条会记入 `explicitShowId`，守卫对它放行（岛完全隐藏时仍严格不打扰）。
>
> **设置页实时生效链路有专项断言**：`window.desktop.islandSetAppearance` → IPC → 主进程 →
> 广播给灵动岛渲染进程（CSS 变量 + 窗口尺寸），岛显示中改尺寸同样立即生效。
>
> **未读红点位置**：客户端侧边栏的未读红点挂在「通知」图标的**右上方**，冒烟用 DOM 几何断言（`dx > 0 且 dy < 0`）守住。

> **视觉与架构参考 [WinIsland](https://github.com/WinIslandProject/WinIsland)（Rust/Direct2D 的 Windows 动态岛）重写**：
> 连续圆角（超椭圆 squircle）而不是 `border-radius`、纯黑／半透明毛玻璃／主题色三种底、
> Apple 系统色强调色、白字 alpha 分级、**所有文本 = 基础字号 × 排版系数**、
> 胶囊 `h/2` 满圆角 + 展开卡 `min(48, w/2, h/2)`（WinIsland `expanded_island_radius`）、
> 顶/底 × 左/中/右 **6 个停靠位**、可选"空闲细缝"（WinIsland `hidden_width`）。
> 逐项从 WinIsland 源码提取的设计 token 见 **[docs/winisland-design-tokens.md](docs/winisland-design-tokens.md)**。
>
> **架构也照搬 WinIsland（同一套做法，而不是"仿个外观"）**：
> 窗口一次创建成**固定包围盒**（最大形态 + 阴影留白），开合过程中**一帧都不移动/缩放窗口**；
> 岛的全部形变（宽/高/圆角/内容交叉淡入）都发生在窗口内的渲染层，由 WinIsland 的弹簧驱动：
> `force=(target-value)*0.10*dt` → `velocity=(velocity+force)*0.68^dt` → `value+=velocity*dt`，
> 并额外加**零过冲钳制**（越过目标立即吸附）。
> 鼠标命中照搬 `set_cursor_hittest`：窗口默认 `setIgnoreMouseEvents(true, { forward: true })` 整块穿透，
> 渲染层做命中测试后只在指针进入岛体时打开命中——**大窗口不会吞掉桌面点击**。
>
> **双保险**：Windows 下 `forward: true` 的 mousemove 转发并不总是可靠，"展开 → 收起"后一旦转发丢失，
> 窗口会永远停在穿透状态（用户反馈的"点开再收起就再也点不开"）。因此渲染进程会把**岛体矩形**上报主进程
> （`island:set-hit-rect`），主进程每 120ms 用 `screen.getCursorScreenPoint()` 与矩形比对校正命中。
>
> **触摸屏（希沃白板等）走「触摸模式」**：上面那套命中逻辑**全部以"鼠标指针移动"为前提** —— 渲染进程的
> mousemove 转发、主进程的 `screen.getCursorScreenPoint()` 都是。手指触摸既不产生 mousemove、也不移动
> 系统光标，于是窗口永远停在穿透态，**手指点不开岛**（用户反馈：希沃白板上触摸灵动岛无法展开）。
> 修法：渲染进程按 `navigator.maxTouchPoints > 0` 上报触摸模式（`island:set-touch-mode`），主进程随即把
> 窗口**贴合岛体**（岛体 + 阴影留白，而不是最大包围盒）并**始终接收输入** —— 触摸点必须落在"可命中的
> 窗口"上，这是 Windows 上唯一可行的办法（Electron 没有 `SetWindowRgn` 那种窗口区域能力）。
> 贴身后多出来的只有投影留白，仍然不会吞掉桌面点击；形变时**变大立即生效、缩小等岛体上报的真实矩形
> 收进目标尺寸后再做**，避免把形变中的卡片裁掉；失焦收起的宽限期在触摸模式下放宽到 1200ms
> （触摸没有光标，`isCursorOnIsland()` 那条兜底恒为 false，而实测的假失焦出现在 70~520ms）。
> `verify:desktop` 有专门断言：触摸模式下窗口贴合岛体且 `interactive=true`，退出后恢复固定包围盒。
>
> 由于窗口固定，Windows 那条"透明窗口最小高度约 36px"的限制不再作用于岛：空闲细缝可以真正做到 6px 宽。

| 场景                            | 灵动岛行为                                                                                                                                                              |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 收到通知（非上课时段）          | **直接出现胶囊**（无"上岛"入场动画）：`新消息 · 共 N 条` + 发送人 + `点击查看`                                                                                          |
| 多条未处理消息                  | 胶囊标题汇总类型：`新消息：叫人/作业/通知（共 3 条）` + `点击查看`，右侧附类型小标签（单条时显示具体类型名）                                                            |
| 点击胶囊（只有一条）            | 展开为**详情卡**（形变 + 淡入，无回弹）：标题、内容、时间、`打开应用 / 标为已读 / 知道了`                                                                               |
| **点击胶囊（多条）**            | 展开为**竖排列表**：按**重要程度**排序（紧急 > 重要 > 普通 > 低，同级按时间新的在前），默认**只显示前三条**，下面一行 `展开更多（还有 N 条）`；列表始终只有**一排按钮** |
| **点"展开更多"**                | 把放得下的通知都铺出来；铺到屏幕工作区下沿（任务栏）仍放不下时，不再硬撑，改成 `更多请前往应用内操作`（卡片高度始终 ≤ 可用高度）                                        |
| **多条时的"知道了 / 标为已读"** | 都是**整批**操作：`知道了` 整批关闭（通知中心仍为未读）、`标为已读` 把这一批全部标为已读并关闭；两者都是状态同步清空 + 窗口淡出隐藏                                     |
| **上课时段的"普通叫人"**        | **不自动展开**（不打断课堂），但保留 `叫人` 胶囊并**允许学生主动点开**；下课自动展开（`isOpenable`：紧急消息与任何叫人都可点开）                                        |
| **收起后胶囊常驻**              | 自动收起 / 手动收起只把卡片回缩为胶囊，**有未处理通知时胶囊不会消失**；彻底消失只在"知道了 / 标为已读"、队列清空或进入上课时段                                          |
| **收起态点击命中**              | 收起瞬间窗口会保持可交互，且渲染进程在每次状态变化后都按**缓存的指针位置**重算命中                                                                                      |
| 点击卡片空白处 / 屏幕任意位置   | 回缩为**胶囊**（不直接消失，仍可再次点开）；展开时窗口临时可聚焦，点到别处即失焦收起                                                                                    |
| **点"标为已读"**                | 通知中心同步标记已读、未读红点立即减少（多条时是整批，见上）                                                                                                            |
| **新作业发布**                  | 也上岛：胶囊显示"新作业"（青蓝描边 + 书本图标），展开可见作业要求（**截止时间功能已下线**）；**本机刚录入的那条不上岛**（自己通知自己没意义，见下）                     |
| **紧急叫人**（老师点名·紧急）   | **上课时段也立即展开**：琥珀金卡片、`叫人` 徽标、"请 XXX 同学找 XXX 老师"、按钮为"收到"（`priority=URGENT`）                                                            |
| **普通叫人**（默认级别）        | 课间先显示 `叫人` 胶囊、点击展开；**上课时段只进队列**（不打断课堂），下课后自动弹出详情（`priority=HIGH`）                                                             |
| 卡片形变                        | 卡片是**固定尺寸、顶部居中锚定**的，窗口只负责露出/裁切透明区域                                                                                                         |
| 上课时间段收到普通通知          | **完全不显示**（窗口直接隐藏，不打扰课堂）并进入待发队列；下课后自动弹出详情 → 收起为胶囊                                                                               |
| 上课时间段收到**紧急**通知      | **无论是否上课立刻展开**显示详情（带内部红色呼吸光晕与"紧急"角标，无需点击），45 秒后收起                                                                               |
| 上课时间段内的任何点击          | 一律不显示（不会展开、也不会回缩出胶囊），只有紧急通知能出现在屏幕上                                                                                                    |
| 退出/断开                       | 主窗口退出时灵动岛一并关闭；上课状态来自 `GET /api/schedules/current`                                                                                                   |

- 动画：窗口尺寸用逐帧缓动实现"形变"，**单调不过冲**——展开 300ms、收回 220ms，统一 `easeOutCubic`
  （早期版本用过冲弹簧缓动，实测窗口会冲到目标之外再回落，观感就是"开合时震一下"，现已移除）；
  卡片只做 180ms 淡入，形变完全交给窗口尺寸，未读点用 `dot-pulse`。
- 光晕：紧急形态的红色呼吸光晕**只用 inset 阴影**画在卡片内部。
  窗口只比卡片大 2~4px，任何向外的 box-shadow/光晕都会被窗口边界裁切，
  在屏幕上表现为"卡片周围一圈奇怪的光晕硬边"——冒烟测试里有一条像素断言守着这一点
  （截图最外圈偏红像素必须为 0）。
- 事件流：`notification:new` → `renderer/stores/realtime.ts` → `pushNotificationToIsland()` →
  主进程 `IslandController`（决定隐藏/胶囊/详情）→ 灵动岛渲染进程 `src/island/IslandApp.vue`。
- **多条通知的列表形态**：卡片高度、能显示几行、要不要"展开更多"由 `@classhelper/shared` 的
  `islandListLayout()` 统一算出（度量表 `ISLAND_LIST_METRICS`）——**主进程与渲染进程各算一次同一个数**：
  主进程据此把窗口包围盒长高（列表比普通展开卡高，窗口不够高会把底部按钮裁掉），渲染进程据此排版。
  改 `IslandApp.vue` 里列表相关 CSS 的尺寸必须同步改那份度量，否则会出现"最后一行被切掉"。
- **点"知道了 / 标为已读"后的收起**：状态是**同步**落地的（调用方与冒烟立刻看到清空），
  窗口随即淡出隐藏（主进程 `handleAction()` → `dismissActive()` / `clearPendingForClose()` → `hide()`
  → `fadeOut()`），**没有跨进程的收回握手**。早先有一层自研的"卡片缩回胶囊再淡出"快照动画，
  因在触摸屏上会露出旧帧/重影，已按用户要求整体删除。
- **本机录入的作业不上岛**：服务端是"先广播 `homework:new`、后回响应"的，因此 `renderer/island/bridge.ts`
  在**发请求之前**就按内容登记指纹（班级 + 日期 + 标题 + 正文），回执拿到 id 后再补记一次；
  投递前用 id / 指纹双重判定，命中就不上岛（冒烟有专项断言）。
- 相关文件：`src/main/island.ts`（控制器 + IPC）、`src/preload/island.ts`、`src/island/IslandApp.vue`、
  `src/renderer/island/bridge.ts`（上课状态轮询与通知转发）。

各形态实拍（由 `pnpm verify:desktop` 自动截取并归档到 `docs/screenshots/island/`，并做像素级校验）：

| 形态                   | 截图                                                                | 尺寸（逻辑 / 图片） | 说明                                      |
| ---------------------- | ------------------------------------------------------------------- | ------------------- | ----------------------------------------- |
| 下课后自动弹出详情     | ![下课后自动弹出](docs/screenshots/island/island-2-after-class.png) | 424×230 / 848×460   | 上课期间暂存的通知，下课后自动弹出        |
| 上课期间紧急通知       | ![紧急通知立即展开](docs/screenshots/island/island-3-urgent.png)    | 440×246 / 880×492   | 卡片**内部**红色光晕 + 紧急角标，无需点击 |
| 非上课时段"新消息"胶囊 | ![新消息胶囊](docs/screenshots/island/island-4-pill.png)            | 268×44 / 536×88     | 直接出现（无入场动画），点击后展开        |
| 点击胶囊后的详情       | ![点击后展开](docs/screenshots/island/island-5-clicked.png)         | 424×230 / 848×460   | 标题/内容/时间 + 打开应用/标为已读/知道了 |
| 新作业胶囊 / 叫人卡片  | `island-7-homework.png` / `island-8-call.png`                       | 424×230 / 456×262   | 作业与叫人各自的配色与徽标                |

> 截图路径可用 `ISLAND_SHOTS_DIR` 覆盖（默认 `.cache/island-shots/`）。

### 界面风格（ClassIsland 同款 Fluent）

客户端整体视觉对齐 ClassIsland 的 Fluent / WinUI 观感：

- 浅色 Mica 底（`#f3f3f3`）+ **半透明亚克力卡片**（`rgba(255,255,255,.7)` + `backdrop-filter: blur(20px)`）
- 强调色 `#0F6CBD`（悬停 `#115EA3`）；选中导航项 = 强调色淡底 + **左侧 3px 强调条**
- 圆角统一：卡片 8px / 控件 4px；描边用半透明黑（`rgba(0,0,0,.06)`）代替灰线；阴影极轻
- 字体 `Segoe UI Variable / 微软雅黑 UI`；表格表头无底色、行分隔为 1px 细线；滚动条改为细圆角
- Element Plus 变量（`--el-color-primary`、`--el-border-radius-base` 等）整体对齐上述规范

**课表「今天」时间轴（ClassIsland 标志性观感）**，`今天 / 本周` 双标签：

| 元素       | 说明                                                                                                                                                              |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 大时钟     | 时:分 大字 + 秒小字（每秒刷新）+ 日期 / 星期 / 第 N 教学周                                                                                                        |
| 当前状态卡 | 「正在上 XXX」+ 时段地点 + **距下课 X 分钟**；无课时显示「今天的课都上完了 / 今天没有课程安排」                                                                   |
| 时间轴     | 左侧时间栏（开始/结束）+ 竖向轨道与节点 + 右侧课卡：**已结束**（置灰）、**正在上课**（强调色实底 + 进度条 + 距下课倒计时）、**下一节**（橙色标记 + 还有多久开始） |
| 周视图     | 保留原"节次 × 星期"表格（`本周` 标签）                                                                                                                            |

实拍（`docs/screenshots/client/`）：

| 页面                  | 截图                                                         |
| --------------------- | ------------------------------------------------------------ |
| 课表 · 今天（时间轴） | ![客户端课表时间轴](docs/screenshots/client/01-schedule.png) |
| 作业                  | ![客户端作业](docs/screenshots/client/02-homeworks.png)      |
| 通知                  | ![客户端通知](docs/screenshots/client/03-notifications.png)  |
| 成绩                  | ![客户端成绩](docs/screenshots/client/04-grades.png)         |
| 设置                  | ![客户端设置](docs/screenshots/client/05-settings.png)       |

### 个性化设置与系统托盘

**设置页结构（2026-10-02 改版）**：侧边栏「设置」分组下六个子页 ——
**通用**（服务器地址 / 离线缓存 / 作业录入短语 / 使用引导）、**外观**（黑夜白天）、
**灵动岛**（下表全部选项）、**提醒**（通知显示位置 / ClassIsland 联动状态）、**账号**（账号信息 / 退出登录）、
**关于**（版本 / 诊断信息 / 鸣谢）。详见上文「设置改版」一节。

> **改密入口（2026-10-01 调整）**：客户端不再提供「修改密码」（曾有过，改的是班级密码；随学生个人
> 账号清理一并移除，防止教室机器上误改班级密码后其他机器被锁在门外）。班级密码由管理员在 Web 端
> 「班级管理 → 修改班级账号」维护；教师 / 管理员本人密码在 Web 管理端顶栏下拉里修改。

| 设置项          | 区间/取值                             | 说明                                                                                                                                                                                                                                                |
| --------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 灵动岛高度      | 36–72px                               | 胶囊高度（默认 44）；展开卡按同差值联动，内容用 flex 承载且不溢出                                                                                                                                                                                   |
| 灵动岛宽度      | 220–420px                             | 默认 268；展开卡按差值联动                                                                                                                                                                                                                          |
| 圆角            | 8–32px                                | 默认 20；胶囊取 `min(圆角, h/2)`，展开卡取 `min(48×圆角/20, w/2, h/2)`                                                                                                                                                                              |
| 不透明度        | 40%–100%                              | 窗口整体不透明度（所有显示路径都会应用，含"隐藏后再弹出胶囊"）                                                                                                                                                                                      |
| **字号**        | **11–20px**（默认 13）                | **基础字号**：岛内所有文本 = 基础字号 × 排版系数（标题 1.08 / 正文 0.95 / 次要 0.78 / 徽标与按钮 0.76 / 胶囊标题 0.92 / 胶囊副题 0.74）                                                                                                             |
| 动画速度        | 0.5×–2×                               | 形变/淡入时长倍率                                                                                                                                                                                                                                   |
| 主题色          | 取色器（默认 Apple 系统蓝 `#0a84ff`） | 用于高亮、按钮、进度条、主题色风格（CSS 变量下发到灵动岛渲染进程）                                                                                                                                                                                  |
| **视觉风格**    | **纯黑（默认）/ 毛玻璃 / 主题色渐变** | 纯黑 = WinIsland `default`；毛玻璃 = **CSS 半透明深色卡**（WinIsland 无 host backdrop 时的降级色 `rgba(32,32,36,.804)`）。**不用** `setBackgroundMaterial()`：它是整窗系统材质，会把卡片外那一圈垫成白底（详见 [AGENTS.md](AGENTS.md) §5 第 21 条） |
| **显示位置**    | **顶部/底部 × 左/中/右（6 个锚点）**  | 默认「顶部居中」；按 `workArea` 计算，顶/底决定不动的是上边还是下边，左/中/右决定水平锚点                                                                                                                                                           |
| 左右 / 上下边距 | 0–200px / 0–160px（默认都是 8px）     | 贴边距离。**左右边距只在"左/右停靠"时生效**：默认「顶部居中」的水平锚点就是屏幕中线，设置页会把该滑块置灰并说明                                                                                                                                     |
| 跟随鼠标屏幕    | 开/关                                 | 多显示器教室电脑：岛出现在鼠标所在那块屏                                                                                                                                                                                                            |
| 动画开关        | 开/关                                 | 关闭后展开/收起瞬时生效（不再逐帧插值）                                                                                                                                                                                                             |
| 始终置顶        | 开/关（默认开）                       | 对应 `setAlwaysOnTop`                                                                                                                                                                                                                               |
| **空闲细缝**    | **开/关（默认关）**                   | 参考 WinIsland `hidden_width`：开启后没有消息时不再完全隐藏，而是留一条 6px 宽的竖条                                                                                                                                                                |

- 越界值在**主进程**统一夹紧（`normalizeIslandAppearance`），用户填坏配置也不会让布局错乱。
- 「预览效果」按钮会本地推一条通知，立刻看到当前尺寸/配色/动画；预览走 `context.preview` 专用通道
  （示例岛**直接展开**、**失焦不收起**、30 秒后自行消失、点「知道了」不留残影）。
- 落盘位置：客户端 `config.json` 的 `island` 字段（旧配置没有该字段时自动补默认值，向后兼容）。

**形变动画**：岛在**固定包围盒窗口内**由弹簧逐帧逼近目标尺寸/圆角（`src/island/spring.ts`，照搬 WinIsland
的 `physics.rs` 参数），窗口本身全程不动；胶囊层与展开层用 WinIsland 的几何进度交叉淡入
（展开层 `progress²`、胶囊层 `1 - 1.5×progress`）；展开动画结束后才取焦点。
为了让"开合"完全没有振动感：①缓动**单调不过冲**；②锚点取整数且**与窗口尺寸无关**（动画开始前算一次，
过程中不逐帧重算）；③卡片宽度取**偶数**（水平居中后中心落在整数像素上）。冒烟脚本逐帧采样窗口矩形与
卡片真实屏幕矩形，对"中心波动 = 0px、上边缘波动 = 0px、窗口全程冻结"做断言。

**系统托盘**：关闭主窗口不退出程序，而是隐藏到托盘后台继续接收通知；
托盘图标（左键单击/双击）恢复主窗口，右键菜单提供「显示主窗口 / 隐藏到托盘 / 退出班级小助手」。
退出时统一清理：销毁托盘 → 销毁灵动岛（含帧循环与定时器）→ 销毁全部窗口，
并用 `app.exit(0)` 兜底，任务管理器中不留残留进程。

**"退出无残留"是被实测出来的**：冒烟脚本在 Electron 进程真正退出之后再做两件事 ——
①删除该次运行独占的 `userData` 目录（含 Chromium `SingletonLock` 与 IndexedDB 文件句柄），
删得掉就说明没有进程还占着句柄；②用**同一个配置目录再启动一次**，若还有残留进程占着单实例锁，
第二次启动会静默退出且不产出结果文件。

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

产物结构：`release/win-unpacked/班级小助手.exe`（Electron 运行时）+ `resources/app.asar`
（仅含 `dist/` 与 `package.json`，运行时不需要 node_modules）。

> **把修复交付到"已安装的客户端"**：`pnpm dist:win` 只产出 `packages/desktop-client/release/`。
> 若学生机上是**安装版**（例如装在 `D:\class\@classhelperdesktop-client`），只更新 release 而不同步安装目录，
> 用户打开的还是旧 `resources/app.asar`，就会出现"改了但设置/界面还是不生效"。
> 覆盖升级（用户配置在 `%APPDATA%`，不受影响）：
>
> ```powershell
> # 1) 先退出客户端（如有进程在跑，用任务管理器/PID 精确结束）
> # 2) 用新产物覆盖安装目录（不删 Uninstall 等安装器文件，所以不加 /MIR）
> robocopy "packages\desktop-client\release\win-unpacked" "D:\class\@classhelperdesktop-client" /E /NFL /NDL /NJH /NJS /R:2 /W:1
> # 3) 实测**那个副本**真的带上了修复（packaged=true）
> pnpm verify:packaged --exe "D:\class\@classhelperdesktop-client\班级小助手.exe"
> ```

### 客户端冒烟验证（无需人工点击）

`pnpm verify:desktop` 以 `ELECTRON_SMOKE_TEST=1` 启动应用（不弹窗），主进程依次校验后自动退出；
设 `ELECTRON_SMOKE_ONLINE=1` 时还会跑联网集成（班级账号登录 + 四类数据 + Socket.IO）与侧边栏点击。
下表是脚本的断言项（供对照，数值取自代码常量与最近一次实测）：

| 校验项                                              | 断言内容                                                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 渲染进程挂载 + 窗口标题                             | `children=1` / `title=班级小助手`                                                                      |
| 登录页渲染（三个输入框）                            | 服务器地址 / **班级码** / 班级密码，且正文不含示例账号字样                                             |
| preload contextBridge 注入                          | 白名单方法齐备（含灵动岛控制）                                                                         |
| IPC 往返（getAppInfo/saveConfig）                   | 配置写入 `%APPDATA%\@classhelper\desktop-client\config.json` 后能读回                                  |
| IndexedDB 缓存读写                                  | 读写/统计/删除 + 6 个 store 齐全                                                                       |
| 断网时回退本地缓存                                  | `fromCache=true`（请求不可达端口）                                                                     |
| 灵动岛窗口创建（置顶/透明/不占任务栏）              | `ready=true`                                                                                           |
| 上课期间普通通知自动隐藏 / 点击不展开               | `mode=hidden queued=1 visible=false`（窗口真的隐藏，不是只改状态）                                     |
| 下课后自动弹出暂存通知详情                          | `mode=expanded reason=after-class`                                                                     |
| 上课期间紧急通知立即展开（无需点击 + 带动画）       | `mode=expanded reason=urgent`，逐帧采样可见中间尺寸，最终尺寸等于目标（无过冲）                        |
| 上课期间收起紧急通知为胶囊                          | `mode=pill visible=true 岛=268x44`                                                                     |
| 普通通知直接显示胶囊（无入场动画）                  | 推送前已隐藏，60ms 内窗口即为 `268x44`、`mode=pill`                                                    |
| 胶囊 → 点击 → 展开详情                              | `新消息 · 共 N 条` → `expanded`（含真实 DOM 断言与截图）                                               |
| 点击卡片空白处 / 右上角收起按钮                     | 真实点击后均回缩为 `mode=pill`                                                                         |
| 灵动岛截图留档 + 像素级校验                         | 各形态截图尺寸/宽高比与状态机配置一致；形态尺寸递增 pill < expanded < urgent < call                    |
| 连续圆角四角一致                                    | 四角沿对角线边界步进两两一致（旧实现四角共用同一偏移向量 → 左上/右下被切掉一块，此断言即该回归的守卫） |
| 紧急红晕不外溢                                      | 截图最外圈偏红像素 = 0（守住"卡片周围不出现光晕硬边"）                                                 |
| 卡片外圈不透底（无白底面板）                        | 三种风格都**整屏截图**取证（岛下垫已知色底板）：环亮度 = 底板亮度、白底像素 0                          |
| 岛外鼠标穿透 / 收起态命中兜底                       | 指针在岛内 `interactive=true`、岛外 `false`；收起后一次状态变化即恢复命中                              |
| 空闲细缝                                            | 空闲 `6x22` → 来消息回到 `268x44`；关闭细缝后空闲 `isVisible=false`                                    |
| WinIsland 排版：字号即时生效                        | 13px → 19px 时各类文本倍率全部 = 19/13                                                                 |
| 个性化：尺寸/透明度/主题色/停靠/置顶/动画/风格/细缝 | 逐项断言生效 + 写入配置后重新读取一致                                                                  |
| 开合不震动                                          | 逐帧采样：岛中心波动 0.00px、上边缘 0.00px；**窗口全程冻结**（只有 1 种窗口签名）                      |
| 退出清理：托盘 / 灵动岛 / 窗口                      | `isTrayReady()=false`、`island.isReady()=false`、窗口全部销毁                                          |
| 退出后无残留（文件锁 + 二次启动）                   | 配置目录可删除（句柄已释放）→ 用同一配置目录二次启动成功                                               |

该验证对**开发产物与打包后的 EXE 都适用**（打包后用 `ELECTRON_SMOKE_RESULT=<file>` 写出 JSON 结果，
实测 `packaged: true`、退出码 0）。灵动岛各状态的窗口截图会写到 `ISLAND_SHOTS_DIR`
（默认 `.cache/island-shots/`，仓库内留档目录 `docs/screenshots/island/`）。
冒烟进程使用独立 userData（`ELECTRON_SMOKE_PROFILE`），因此**用户开着客户端也能跑验证**。
冒烟准备班级凭据时**不改任何数据**：先试冒烟密码与种子默认 `123456`，命中就直接用；
都不通才会临时重置该班密码，并在脚本收尾时恢复为 `123456`。

## 作业（按天查看 · 教室机器录入）

作业以**所属日期**（`Homework.assignDate`，本地日期 `YYYY-MM-DD`）归类，而不是录入时间：
晚上 8 点留的作业算今天（`createdAt` 是 UTC，直接切片会算成明天）。

| 能力             | 客户端（教室机器）                                                | Web 管理端                     |
| ---------------- | ----------------------------------------------------------------- | ------------------------------ |
| 按天查看         | 日期选择器 + 前/后一天 + `?date=` 深链                            | 工具栏日期选择器（同一套接口） |
| 有作业的日期高亮 | ✅ 日期下带圆点（`GET /api/homeworks/days`）                      | ✅ 同上                        |
| 录入作业         | ✅ 教室机器直接录（班级账号可 `POST /api/homeworks`，归属班主任） | ✅ 发布时可选所属日期          |
| 未交名单         | ✅（班级设备）                                                    | ✅                             |

- 客户端作业模块**不再显示"已完成/待完成"**：完成状态是老师端与通知中心的概念，
  教室机器上只做"看作业 + 录作业"（服务端的完成数据与统计接口保持不变，Web 端照旧可用）。
- 录入时可以点**快捷短语**（默认 `P` / `大本` / `小本` / `卷子` / `背诵` / `默写` / `听写` / `预习` / `订正` / `读书`，
  定义在 `@classhelper/shared` 的 `HOMEWORK_PHRASE_DEFAULTS`），点一下追加到标题或内容；
  短语在客户端「设置 → 作业录入」里增删，存在本机配置里。
- **课间**：镜像回 ClassIsland 的课表按「每两节之间一段课间、最后一节之后不补」生成作息；
  服务端合成的节次时间表（没有导入时间表时的兜底）也是同一口径。
- 接口：`GET /homeworks?date=YYYY-MM-DD`（按天）、`GET /homeworks/days?classId=&from=&to=`（哪些天有作业）、
  `POST /homeworks`（附 `assignDate`；**班级账号也能调用**，用于教室机器录入）。

## 叫人（老师点名让学生过来）

老师在 **Web 管理端 → 学生管理 → 叫人**（或 **通知发布 → 叫人**）选中学生，配合**快捷短语**或**自定义消息**发送。
叫人分**两档**，由弹窗里的「级别」单选决定（默认 **普通**）：

| 级别         | 落库级别 | 学生端行为                                                                                              |
| ------------ | -------- | ------------------------------------------------------------------------------------------------------- |
| **普通叫人** | `HIGH`   | 课间：先显示"叫人"胶囊，点击展开；**上课时段：只进队列、不打断课堂**，下课后自动弹出详情（90 秒后收起） |
| **紧急叫人** | `URGENT` | **无视上课时段立即展开**（与紧急通知同待遇），上课时被收起后仍保留胶囊、可再次点开                      |

两档的学生端卡片都是「请 XXX 同学找 XXX 老师」+ 具体事由，徽标 `叫人`、按钮「收到」；点击「收到」复用通知已读机制。

| 位置       | 行为                                                                                                                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 服务端     | `POST /api/calls`（教师/管理员）→ `urgent: true` 落库 `URGENT`，否则 `HIGH`（进学生通知中心、可用已读状态） + 广播 `notification:new`（班级房间）与 `call:new`（定向到被叫学生/班级设备） |
| 快捷短语   | `CALL_QUICK_PHRASES`（共享常量，8 条）：请到办公室/讲台/实验室/门卫处找我、请带上作业本/试卷找我、请到教室门口等我、请马上来一趟；点击选中，再点取消                                      |
| 自定义消息 | 输入框内容优先于快捷短语（最长 200 字），例如"带上昨天的数学作业到办公室"                                                                                                                 |
| 客户端     | `call:new` → 灵动岛 `kind=call`；**是否立即展开只由 `priority` 决定**（`isImmediate` 只认 `URGENT`），与"普通通知"共用同一条排队/隐藏/下课弹出路径                                        |
| 权限       | 学生调用被拒 403；教师只能叫自己班级的学生（跨班/不在本班返回 400/403）                                                                                                                   |

`verify:e2e` 覆盖 8 项（201 + 标题模板、**普通叫人 HIGH**、**紧急叫人 URGENT**、自定义消息优先、上课时段允许、
学生 403、学生通知中心可见且未读、清理）；`verify:web` 覆盖弹窗、级别单选与短语可选中；`verify:desktop`
覆盖「紧急叫人上课中也立即展开 + 徽标/按钮文案」与「普通叫人上课只进队列、下课自动弹出」。

## 上课时段策略（紧急通知二次确认）

"上课时段"由课表实时判定：`GET /api/schedules/current?classId=` 返回
`{ inClass, current, next, week, serverTime }`（`at` 参数可覆盖判定时刻，便于联调与测试）。

**服务端强制拦截**（不是只靠前端提醒）：

```
POST /api/notifications  { classId, title, content, priority: "URGENT" }        → 409 URGENT_DURING_CLASS
POST /api/notifications  { …, priority: "URGENT", confirmDuringClass: true }    → 201
POST /api/notifications  { …, priority: "NORMAL" }（上课时段）                   → 201（不受限）
```

409 响应体携带 `details: { classId, current, next, week, serverTime }`，前端据此渲染"正在上的课"。
这样即使有人绕过界面直接调接口，也一定会被拦下来。

**Web 管理端**：教师在通知发布弹窗选择"紧急"并提交时，先查询班级上课状态，命中则弹出**全屏二次确认**
（`packages/web-admin/src/components/UrgentClassWarning.vue`）：

- 全屏遮罩 + 强警示配色，文案"现在为上课时间段……" + 正在上的课时段 + 待发布标题；
- 确认按钮带 **3 秒倒计时**（圆环进度 + 每秒钟数提示），倒计时结束前不可点击，防止误触；
- 取消则不发；确认后带 `confirmDuringClass: true` 重新提交并成功发布；
- 兜底：并发场景（提交瞬间刚好打铃）仍会收到 409，此时同样弹出该警告。

**EXE 客户端**：上课时段非紧急通知自动隐藏、下课后自动弹出；紧急通知无论是否上课都立即展开（见"灵动岛"一节）。

## 学生端班级账号（学生端主体 = 班级）

需求：学生端不再以"个人学生"为登录主体，改为**班级账号（班级设备）**登录，数据按班级隔离。

### 账号模型

| 项目         | 说明                                                                                                                                      |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 登录凭据     | 班级码（`Class.code`，唯一、4~16 位字母数字、大小写不敏感）+ 班级密码（bcrypt 哈希）                                                      |
| 会话形态     | JWT `{ sub: <classId>, classId: <classId>, role: 'STUDENT', classSession: true }`                                                         |
| 未设密码     | `passwordHash = null` → 班级登录被拒（403 `CLASS_PASSWORD_NOT_SET`），提示管理员设置                                                      |
| 管理入口     | Web 管理端「班级管理」→ 行内「班级账号」按钮（改班级码 / 重置密码），仅管理员                                                             |
| 暴力破解防护 | 班级登录与教师登录**共用同一套登录限流**（默认 10 分钟 20 次/IP 的失败尝试）；班级码用 CSPRNG 生成，登录失败不区分"班级码不存在 / 密码错" |
| 学生个人账号 | **已彻底清理**（2026-10-01）：学生只是名单记录，无用户名密码、不能登录；`/auth/login` 对 `role=STUDENT` 一律 403（提示改用班级登录）      |

### 数据按班级隔离

- `GET /classes`：班级会话只返回自己所在班级（跨班请求一律 403）；
- 作业 / 通知 / 课表 / 成绩：全部按班级收敛，班级会话无法访问其他班级；
- 发布类接口（通知、作业、成绩、课表、叫人）：班级会话是 `STUDENT`，一律 403（**作业录入除外**，见上）；
- 成绩：`GET /grades/my` 对班级会话返回**全班成绩总览**（客户端标题自动变为「本班成绩」）。

### 班级设备代全班操作（个人数据语义）

班级设备代表整个班级，因此"个人记账"类操作由服务端一次性写入**全班学生**：

| 操作                          | 行为                                              | 教师端看到的结果      |
| ----------------------------- | ------------------------------------------------- | --------------------- |
| 通知「标为已读」/「全部已读」 | 为全班学生写入 `NotificationRead`（已存在的跳过） | 已读人数 = 班级学生数 |
| 作业「标记完成/未交名单」     | 为全班学生 upsert `HomeworkStatus.completed`      | 完成人数 = 班级学生数 |
| 叫人「收到」                  | 复用通知已读机制（同上）                          | 该生已读              |

读状态判定统一使用 `userId in 全班学生`（`packages/server/src/lib/session.ts` 的 `resolvePersonalIds()`）；
学生个人账号已清理，班级会话是这些记录的唯一读写入口。

### 实现位置

- `packages/server/src/lib/class-account.ts`：班级码校验/生成、密码设置与重置、登录校验、自助改密码；
- `packages/server/src/lib/session.ts`：`isClassSession` / `resolvePersonalIds` / `personalIdWhere`；
- `packages/server/src/middleware/auth.ts`：班级会话回查 `Class` 表（而不是 `User` 表）；
- `packages/server/src/realtime/socket.ts`：班级会话以班级 id 加入 `user:{classId}` 房间，叫人消息直达班级设备；
- `packages/web-admin/src/views/ClassesView.vue`：班级账号列 + 设置/重置弹窗；
- `packages/desktop-client/src/renderer/views/LoginView.vue`：班级码 + 班级密码登录页（不再展示个人账号入口）。

## 导入（成绩 / 名单表格 + ClassIsland 时间与课程表）

四条导入链路都在服务端完成解析、校验与去重，前端只负责收集文件与展示结果，
因此 Web 端、客户端与后续接口调用者拿到的是**同一套规则与同一份结果统计**。

### 1. 成绩表格导入（管理员 / 本班班主任）

界面：Web 管理端 →「成绩录入」→「导入表格」（组件 `packages/web-admin/src/components/TableImportDialog.vue`）。

1. **下载模板**：`GET /imports/template?kind=grades&format=xlsx|csv`
   模板列：`学生用户名 / 学生姓名 / 考试名称 / 分数 / 总分 / 课程`（CSV 带 BOM，Excel 直接双击不乱码）。
2. **上传预览**：`POST /imports/table/preview` → 列名、前 20 行、`totalRows`、**建议字段映射**与校验问题。
   - 支持 `.xlsx / .xls / .csv / .tsv`（SheetJS，自动识别分隔符），**表格文件上限 8MB**；
     （文件以 base64 放进 JSON，请求体上限设为 12MB 才能让 8MB 文件真正传得进来；超限返回 413 `IMPORT_TOO_LARGE`）
   - 列名按同义词自动映射（如「学号→学生用户名」「得分→分数」「满分→总分」），也可手动改；
   - 缺必填列（考试名称、分数）不会静默通过，直接给出"缺少必填列「…」"提示。
3. **确认导入**：`POST /imports/table/commit`，参数 `mapping`（规范字段 → 列名）+ `mode`：
   - `upsert`（默认）已存在则更新；`append` 已存在则跳过；
   - 成绩重复判定：**同班级 + 同学生 + 同考试 + 同课程**；学生按「用户名」优先、「姓名」兜底匹配；
   - 返回 `{ total, inserted, updated, skipped, failed, errors[], warnings[] }`，
     `errors[].row` 是 **Excel 视角的行号**（含表头），便于老师改完再导。

### 2. 学生名单导入（管理员）

界面：Web 管理端 →「学生管理」→「导入名单」（复用同一组件，`kind=students`）。

- 模板列：`用户名 / 姓名`（学生没有账号属性，**没有密码列**）；用户名必须匹配 `^[A-Za-z0-9_.-]{3,32}$`；
- 重复判定：同一用户名（`append` 跳过 / `upsert` 更新姓名与班级）；
- 用户名被教师/管理员账号占用时该行进错误行，不会覆盖他人账号。

### 3. 教师名单导入（管理员）

界面：Web 管理端 →「教师管理」→「导入名单」（同一组件，`kind=teachers`）。

- 模板列：`用户名 / 姓名 / 初始密码 / 角色`；角色取 `ADMIN` / `TEACHER`（留空按 `TEACHER`）；
- 与新建教师同一套校验（用户名格式、重复占用），导入后可直接登录。

### 4. ClassIsland 课表时间配置导入（管理员 / 本班班主任）

界面：Web 管理端 →「课表管理」→「导入时间配置」
（组件 `packages/web-admin/src/components/TimeLayoutImportDialog.vue`）。

- **输入**：粘贴 JSON 文本或选择 ClassIsland 导出的 `.json` 文件；
- **真实档案形态**（`Profiles/<档案名>.json`，ClassIsland 2.x，字段为 PascalCase）：
  `TimeLayouts` 是 **`{ "<guid>": { Name, Layouts: [ { StartTime: "08:00:00", EndTime, TimeType } ] } }`
  的字典**，条目在各时间表的 `Layouts` 数组里（解析器会把所有时间表的 Layouts 合并后导入）；
  同时兼容更早的写法：顶层数组、`{ TimeLayouts: [...] }`、`{ items | Items | Layouts | TimeLayout: [...] }`
  以及单时间表对象 `{ Name, Layouts: [...] }`；
- **时间字段**：`StartTime`/`EndTime`（`"08:00:00"`）、旧版 `StartSecond`/`EndSecond`（ISO 字符串或秒数）、
  `"8:0"` / `"08:00"` 都能识别；
- **时间点类型**（`TimeType`）：`0=上课`、`1=课间`、`2=分割线`、`3=行动`，与 ClassIsland 一致；
- **校验**：时间无法解析、结束不晚于开始、空配置都会给出**逐条原因**（含条序号与名称）；
  时间重叠、分割线无时间等只作为 `warnings`；
- **写入模式**：`replace` 整体替换该班同名配置；`merge` 以**开始时间**为槽位标识合并
  （同槽位被导入项覆盖，其它旧节次全部保留，不静默丢数据）；
- **失败回滚**：解析存在 `errors` 时返回 400 `IMPORT_INVALID` / `IMPORT_EMPTY`，
  **数据库完全不写入**，界面会提示"原有配置不会被修改"。

### 5. ClassIsland 课程表导入（支持单双周）

界面：Web 管理端 →「课表管理」→「导入 ClassIsland 课程表」
（组件 `packages/web-admin/src/components/ClassPlanImportDialog.vue`）。

- **输入**：同一份 ClassIsland 档案 JSON（含 `TimeLayouts` / `ClassPlans` / `Subjects` 三个 Guid 字典）；
- **单双周来源**：`ClassPlan.TimeRule.WeekCountDiv`（`0=每周`、`1=单周`、`2=双周`）
  ＋ `WeekCountDivTotal`（默认 2）——**与 ClassIsland 源码一致的判定语义**；
  3 周及以上轮换无法用单双周表达，会给出 `warnings` 并按每周处理；
- **节次对齐**：`ClassPlan.Classes[i]` 对应 `Layouts` 里**第 i 个 `TimeType === 0` 的点**
  （课间/分割线不占位），与 ClassIsland 的 `RefreshClassesList()` 行为一致；
- **科目映射**：`Classes[i].SubjectId` → `Subjects[<guid>].Name`；班级里还没有的科目会**自动补建课程**
  （任课老师取该班班主任），预览里会提前列出"待补建科目"；
- **星期换算**：ClassIsland `WeekRule.WeekDay` 是 `0=周日 … 6=周六`，导入时换算成我们的 `1=周一 … 7=周日`；
- **写入模式**：`replace`（清空该班课表后写入，事务内完成）/ `merge`（按 `星期 + 开始时间 + 单双周` 去重）；
- **接口**：`POST /api/imports/class-plan/preview`（只解析不写库）与 `POST /api/imports/class-plan`；
- **课表单双周字段**：`Schedule.weekParity = ALL | ODD | EVEN`；周视图/上课判定都按
  「第 1 周 = 单周」的规则过滤（`weekParityOf(week)`），历史数据默认 `ALL`。

> **学期周数（班主任可调）**：`Class.termWeeks`（默认 20）由班主任在「班级管理 → 编辑班级」里设置，
> `GET /api/dashboard/term?classId=` 返回该班的 `maxWeek`，课表周次下拉与新建课表的默认结束周都按它来。
>
> **课表页入口只保留一个**：「导入 ClassIsland 课程表」——同一份档案 JSON 里的 `TimeLayouts`
> 已经把节次时间带进来了，因此「导入时间配置」按钮已下线（组件与接口仍保留，供旧脚本调用）。

> 手工覆盖 dist 部署（而非跑安装程序）时，已有数据库需要补列：
> `node packages/server/scripts/apply-column-migrations.cjs "<安装目录>/server/dist/lib/db.js"`
> （会幂等补齐 `Schedule.weekParity` 与 `Class.termWeeks`；安装程序覆盖升级会自动补迁移，
> 仅空库首次启动会执行随包迁移 SQL）。

## ClassIsland 联动

课堂里真正"知道现在第几节、在上什么课"的是 [ClassIsland](https://classisland.tech)。
本项目通过一个**ClassIsland 插件**把两边接起来（插件源码在 `packages/classisland-plugin/`），三个方向各解决一件事：

| 方向                       | 做什么                                                                                                                   | 老师在哪看                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| ClassIsland → 班级小助手   | 上报**课表 + 节次时间 + 上课状态**（现在上什么 / 下一节 / 本节的起止时间），写入本班课表                                 | Web 端「ClassIsland 联动」实时状态卡片 |
| 班级小助手 → ClassIsland   | 老师在 Web 端发一条**提醒** → 落库 → 教室机器的插件取回 → ClassIsland 上**全屏弹出**（可语音朗读），播完回执、不会重复弹 | Web 端「ClassIsland 联动 → 下发提醒」  |
| （可选）班级 → ClassIsland | 把班级小助手上排好的课表**镜像**回 ClassIsland：新建一份 `班级小助手-<班级名>` 档案课表，不动老师原有的课表              | 同上页面的「开镜像」开关               |

### 接入流程（三步）

1. **Web 端签发设备令牌**：管理员 / 本班班主任在「ClassIsland 联动」页点「接入新设备」，
   选择班级并生成令牌（形如 `chci_xxxxxxxx…`，**明文只显示这一次**，服务端只存 sha256）；
2. **教室机器填令牌**：在 ClassIsland 的「设置 → 班级小助手联动」里填入后端地址 + 令牌，点「立即上报」；
3. **验证**：页面顶部出现设备卡片与「在线」标记，说明链路通了 —— 之后课表与上课状态会自动同步，
   老师发的提醒也会在这台机器上弹出来。

### 通知从哪些入口发都会联动

三个发布入口共用同一份推送实现（服务端 `pushToClassIsland`），因此不存在「只有某个页面才联动」：

| 入口                                 | 说明                                                 |
| ------------------------------------ | ---------------------------------------------------- |
| 「通知发布」页                       | 与班级通知中心同一条记录，同时推给教室的 ClassIsland |
| 「叫人」                             | 老师点名让某位同学过去，教室大屏也会播报一条         |
| 「ClassIsland 联动」页的「下发提醒」 | 专门发给教室大屏的提醒（支持时长 / 语音 / 优先级）   |

### 上课时段策略：ClassIsland 与客户端同一套规则

老师在**上课时段**发通知时，教室里的两个端都遵守同一条规则（否则学生在客户端看不到、却在 ClassIsland 上被打断）：

| 提醒类型                                               | 上课时段                                      | 下课 / 放学 |
| ------------------------------------------------------ | --------------------------------------------- | ----------- |
| 通知类（`kind=notification`：通知发布页 / 联动页下发） | **暂存不弹**（客户端与 ClassIsland 都先收着） | 自动补弹    |
| **主动通知**：紧急提醒、**叫人**（`kind=call`）        | **立刻弹**（老师正在等学生）                  | 立刻弹      |

> ClassIsland 侧的暂存由插件实现：订阅课程服务，下课后把暂存的提醒补弹出来；未弹出前不回执，服务端会保留待提醒。

### 两个方向各需要哪些开关

| 要同步的内容                     | 需要打开的开关                                                                                                                                                                                             |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 服务端 → ClassIsland（镜像课表） | ① 插件设置「把班级课表镜像回 ClassIsland」+ ② Web 端该设备的「镜像课表」                                                                                                                                   |
| ClassIsland → 服务端（上报课表） | 插件设置「上报课表到班级小助手」（关着时日志会明说"仅状态（开关已关闭）"）；同步是**双向对齐**的：老师在 ClassIsland 里删掉/挪动的节次会一并清理，而在班级小助手 Web 端手排的课（`source=manual`）不会被删 |
| 提醒下发                         | ① 教室客户端「通知模式」不是"只在 ClassHelper" + ② 插件「接收班级小助手提醒」                                                                                                                              |

### 提醒弹在哪个端：由教室客户端自己选

教室机器的 ClassHelper 客户端「设置 → 通知显示位置」里选（选择会同步到班级记录）：

| 选择                                      | ClassHelper 客户端             | ClassIsland |
| ----------------------------------------- | ------------------------------ | ----------- |
| `ClassHelper 与 ClassIsland 都弹`（默认） | 弹窗 + 灵动岛                  | 全屏提醒    |
| `只在 ClassHelper 客户端弹`               | 弹窗 + 灵动岛                  | 不推送      |
| `只在 ClassIsland 上弹`                   | 只进通知中心（不弹窗、不上岛） | 全屏提醒    |

服务端据此决定要不要推 ClassIsland —— 规则只有一条，**任何入口都遵守**（包括联动页的「下发提醒」，
此时会回一句「该班教室已设置为只在 ClassHelper 客户端显示」）。Web 端「ClassIsland 联动」页会展示每个班的当前选择；
教师 / 管理员也可以通过 `PATCH /api/classes/:id/notification-channel` 改，但默认由教室机器自己定。

> 与插件侧的开关是「与」关系：教室客户端要推 + 插件要开着「接收班级小助手提醒」，提醒才会在 ClassIsland 上出现。

### 插件为什么这样设计

- **不用 IPC，而是走 HTTP 上报**：ClassIsland 的跨进程 IPC 缓存的数据质量不足以还原课表，
  插件内部直接读 `ILessonsService`（课程状态）与 `IProfileService`（档案课表）最准；
  与后端之间用"上报即拉取"（每次上报的返回值里顺带带一条待弹出的提醒），
  插件因此不需要 Socket/WebSocket 依赖，故障面更小 —— 上报间隔本身就是心跳。
- **单双周按 ClassIsland 的口径换算**：`WeekCountDiv/WeekCountDivTotal` ⇄ `ALL/ODD/EVEN`
  走 `@classhelper/shared` 的 `weekParityFromDiv` / `weekDivFromParity`（服务端与插件共用同一份语义）；
  3 周以上的轮换无法用单双周表达，会降级为"每周"并在日志里给出提示。
- **镜像时重建时间点**：ClassIsland 的 `ClassPlan.Classes[i]` 必须与时间表里**第 i 个上课点**对齐，
  因此镜像接口会带上每条课目的 `startTime`/`endTime`，插件据此重建时间表；
  少一个时间点整份课表就会错位，这一条是插件契约里最容易踩的坑。

### 本机状态（2026-09-30 实测）

| 项                                    | 状态                                                                                                            |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| ClassIsland 本体                      | ✅ **已装**：2.1.0.1，位置 `D:\Classisland`（进程 `D:\Classisland\app-2.1.0.1-0\ClassIsland.Desktop.exe`）      |
| ClassIsland 数据根                    | `D:\Classisland\data`（`Config/` `Profiles/` `Plugins/` `Logs/` `Settings.json`）；插件目录 `Plugins\` 当前为空 |
| .NET 8 SDK                            | ✅ **已装**：8.0.425（`C:\Program Files\dotnet\sdk`）⇒ 插件**可编译、可打 `.cipx`**（实测 1 警告 0 错误）       |
| `verify:classisland`                  | ✅ 后端链路 42 项全过（不需要 ClassIsland 与 .NET）                                                             |
| `verify:classisland-plugin`           | ✅ 静态契约 68 项全过（不需要 .NET）                                                                            |
| 真机弹出（老师发提醒 → 教室全屏弹出） | 曾在真机上实测通过，留档截图见 [`docs/screenshots/classisland/`](docs/screenshots/classisland/)                 |

- `pnpm build:classisland-plugin` / `pnpm dist:classisland-plugin`：编译并打包成 `.cipx`（需要 .NET 8 SDK）；
- **提醒链路是轮询取回的**（插件不持有长连接）：默认最多 10 秒延迟，设置页「提醒轮询间隔」可调到 5 秒；
- 部署到 `D:\Classisland`（先退出 ClassIsland 再覆盖 DLL，别覆盖 `Settings.json`）的完整步骤见
  [AGENTS.md](AGENTS.md) §7 第 12 条与 §8。

## 数据库管理（仅管理员）

Web 管理端新增「数据库管理」页（`/database`，仅 ADMIN 可见，后端同样 `requireRole('ADMIN')`），
把过去要手工完成的数据库运维全部收进界面：

| 能力         | 说明                                                                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 连接状态检测 | 当前类型（SQLite/MySQL）、连通性与延迟、引擎版本、数据体积、14 张表行数、连接串（MySQL 密码脱敏）                                                             |
| 连接测试     | 任意目标库的连通性试连（切换前的第一步）                                                                                                                      |
| **一键切换** | SQLite ⇄ MySQL：自动「备份当前库 → 改写 schema provider → prisma generate / db push 建表 → 子进程迁移全部数据 → 改写 .env」，异步任务带步骤进度，失败自动回滚 |
| 备份 / 恢复  | gzip JSON 快照存 `<数据目录>/backups/`；手动备份 / 从备份恢复（整库覆盖）/ 删除                                                                               |
| 定时备份     | enabled + 间隔小时数 + 保留份数，存 `data/database-settings.json`；服务端每 10 分钟检查一次到点任务（进程不运行不补跑）                                       |
| 快捷导入导出 | 下载快照 JSON（跨库通用）/ 下载数据库文件（仅 SQLite）/ 导入快照（整库覆盖，base64 上传）                                                                     |

关键设计：**备份、导入导出、跨库迁移共用同一种「JSON 快照」**（`lib/snapshot.ts`，14 张表按拓扑序导出，
恢复时临时关外键检查——`User.classId` 与 `Class.teacherId` 互相引用）。因此任意备份都能恢复回任意一种
受支持的数据库。MySQL 的连接测试/建表/写入依赖随包内置的 `@prisma/adapter-mariadb`（已在依赖里，
不再是"切换时手动安装"）。

> 边界与须知：
>
> - **主库只支持 SQLite 与 MySQL**。Redis 是内存键值库，Prisma ORM 不支持它作为主数据库（无法建表/迁移），
>   接口层直接拒绝（e2e 有 422 断言）；PostgreSQL 暂未纳入。
> - **切换完成后必须重启服务端**（安装版运行 `restart.cmd`，开发模式重跑 `pnpm dev:server`）才会连接新库；
>   切换过程失败会自动回滚 schema.prisma，`.env` 只在数据全部迁移成功后才改写。
> - **目标库必须为空**（有表即拒绝），防止误覆盖。
> - 安装包体积因此增大约 37MB（~34MB → ~71MB）：切换需要随包内置 prisma CLI 与 TypeScript 编译器
>   （Prisma 7 的生成器产出 .ts 源码，切换后要在目标机编译进 dist）。
> - 真实切换（SQLite→MySQL）已在本机用完整子进程链路实测（快照 728 行逐表一致）；
>   e2e 只覆盖校验分支（同库 400 / 非法 provider 422 / 目标库非空拒绝），避免测试改写 `.env`。

## REST API 一览

统一响应体：`{ "success": true, "data": {}, "message": "" }`（错误为 `success:false` + `code`）。
所有接口前缀 `/api`，除登录/健康检查外均需 `Authorization: Bearer <token>`
（ClassIsland 设备接口用 `X-ClassIsland-Token`）。

| 方法                        | 路径                                                          | 权限                         | 说明                                                                             |
| --------------------------- | ------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------- |
| POST                        | `/auth/login`                                                 | 公开                         | 登录（教师 / 管理员）；`role=STUDENT` 返回 403（学生只有名单，改用班级登录）     |
| POST                        | `/auth/class-login`                                           | 公开                         | **班级账号登录**：班级码 + 班级密码 → `classSession` 会话                        |
| GET                         | `/auth/me`                                                    | 登录                         | 当前用户（学生附带班级/年级）                                                    |
| PATCH                       | `/auth/password`                                              | 登录                         | 修改自己的密码                                                                   |
| POST                        | `/auth/logout`                                                | 登录                         | 退出（无状态，客户端丢弃 token）                                                 |
| GET                         | `/classes`                                                    | 登录                         | 班级列表（按权限收敛）                                                           |
| GET                         | `/classes/:id`                                                | 班级可见                     | 班级详情（学生/课程/协作教师）                                                   |
| POST                        | `/classes`                                                    | 管理员                       | 创建班级（自动生成班级码 = 班级账号，可指定班主任）                              |
| PATCH / DELETE              | `/classes/:id`                                                | 管理员 / 教师                | 编辑 / 删除班级                                                                  |
| PATCH                       | `/classes/:id/class-account`                                  | 管理员                       | 设置 / 重置班级账号（班级码 + 班级密码）                                         |
| PATCH                       | `/classes/:id/head-teacher`                                   | 管理员                       | 设置 / 更换班主任                                                                |
| GET                         | `/classes/:id/classisland-status`                             | 班级可见                     | 本班 ClassIsland 联动状态（教室客户端设置页用）                                  |
| GET                         | `/classes/:id/notification-channel`                           | 班级可见                     | 读取"通知显示到哪个端"                                                           |
| PATCH                       | `/classes/:id/notification-channel`                           | 班级账号 / 教师 / 管理员     | 设置"通知显示到哪个端"（默认由教室机器自己选）                                   |
| GET / POST                  | `/classes/:id/students`                                       | 班级可见 / ADMIN·TEACHER     | 学生名单 / 添加学生（已存在账号直接转入）                                        |
| DELETE                      | `/classes/:id/students/:userId`                               | ADMIN·TEACHER                | 移出学生                                                                         |
| POST / DELETE               | `/classes/:id/teachers[/:teacherId]`                          | ADMIN·TEACHER                | 分配 / 取消协作教师                                                              |
| GET / POST / PATCH / DELETE | `/courses`                                                    | 登录（写：班主任/管理员）    | 课程管理                                                                         |
| GET                         | `/schedules?classId=&week=&dayOfWeek=`                        | 登录                         | 课表列表（week 过滤周次范围）                                                    |
| GET                         | `/schedules/grid?classId=&week=`                              | 登录                         | 周视图（7 列结构，供客户端直接渲染）                                             |
| GET                         | `/schedules/current?classId=&at=`                             | 登录                         | 当前上课状态（`inClass` / `current` / `next`；`at` 为诊断用时间覆盖）            |
| POST / PATCH / DELETE       | `/schedules[/:id]`                                            | 班主任 / 管理员              | 课表增删改（广播 `schedule:updated`）                                            |
| GET                         | `/homeworks?classId=&courseId=&date=&pendingOnly=&keyword=`   | 登录                         | 作业列表（支持按所属日期；学生带完成状态，教师带完成人数）                       |
| GET                         | `/homeworks/days?classId=&from=&to=`                          | 登录                         | 哪些天有作业（日期高亮）                                                         |
| GET                         | `/homeworks/:id`                                              | 班级可见                     | 作业详情                                                                         |
| POST                        | `/homeworks`                                                  | 教师 / 管理员 / **班级账号** | 发布作业（附 `assignDate`；班级账号用于教室机器录入，归属班主任）                |
| PATCH / DELETE              | `/homeworks/:id`                                              | 教师 / 管理员                | 修改 / 删除（广播 `homework:new` / `homework:updated`）                          |
| PATCH                       | `/homeworks/:id/status`                                       | 登录                         | 标记完成/取消（广播 `homework:status`）                                          |
| GET / PATCH                 | `/homeworks/:id/submissions`                                  | 登录                         | 未交名单：读名单 / 回写全班完成状态                                              |
| GET                         | `/notifications?classId=&priority=&unreadOnly=&keyword=`      | 登录                         | 通知列表（带已读状态）                                                           |
| GET                         | `/notifications/unread-count`                                 | 登录                         | 未读数（红点）                                                                   |
| POST                        | `/notifications`                                              | 教师 / 管理员                | 发布通知（广播 `notification:new`）；上课时段发布紧急通知需 `confirmDuringClass` |
| POST                        | `/notifications/:id/read`、`/notifications/read-all`          | 登录                         | 标记已读（班级设备会写全班）                                                     |
| DELETE                      | `/notifications/:id`                                          | 教师 / 管理员                | 删除通知                                                                         |
| POST                        | `/calls`                                                      | 教师 / 管理员                | **叫人**（`urgent` 决定 URGENT / HIGH；广播 `notification:new` 与 `call:new`）   |
| GET                         | `/grades/my`                                                  | 登录                         | 个人成绩（班级会话 → 全班总览）                                                  |
| GET                         | `/grades?classId=&courseId=&userId=&examName=`                | 教师 / 管理员                | 班级成绩                                                                         |
| GET                         | `/grades/stats?classId=&courseId=&examName=`                  | 教师 / 管理员                | 等级分布 + 各课程平均得分率                                                      |
| POST                        | `/grades`、`/grades/bulk`                                     | 班主任 / 管理员              | 单条 / 批量录入（广播 `grade:updated`）                                          |
| PATCH / DELETE              | `/grades/:id`                                                 | 班主任 / 管理员              | 修改 / 删除成绩                                                                  |
| GET                         | `/students?classId=&keyword=`                                 | **管理员**                   | 学生名单                                                                         |
| POST / PATCH / DELETE       | `/students[/:id]`                                             | **管理员**                   | 学生名单增删改（无密码概念；重置密码接口已下线 → 404）                           |
| GET                         | `/teachers?keyword=`                                          | **管理员**                   | 教师列表                                                                         |
| POST / PATCH / DELETE       | `/teachers[/:id]`                                             | **管理员**                   | 新建 / 编辑 / 删除教师账号                                                       |
| POST                        | `/teachers/:id/reset-password`                                | **管理员**                   | 修改 / 重置教师密码（`newPassword` 可选，留空 = 默认初始密码）                   |
| GET                         | `/dashboard/summary` / `/dashboard/term`                      | 登录                         | 仪表盘汇总 / 学期周次                                                            |
| GET                         | `/imports/template?kind=&format=`                             | 管理员 / 班主任              | 导入模板下载（`csv` 走 JSON，`xlsx` 走二进制）                                   |
| POST                        | `/imports/table/preview`                                      | 管理员 / 班主任              | 上传表格（base64）解析预览：列名 + 前 20 行 + 校验问题 + 建议映射                |
| POST                        | `/imports/table/commit`                                       | 管理员 / 班主任              | 按字段映射与写入模式导入（成绩 / 学生名单 / 教师名单）                           |
| POST                        | `/imports/time-layout/preview`                                | 管理员 / 本班班主任          | 解析 ClassIsland 时间配置 JSON（只解析不落库）                                   |
| GET / POST / DELETE         | `/imports/time-layout[/:id]`                                  | 管理员 / 本班班主任          | 时间配置列表 / 导入（`replace` 覆盖、`merge` 合并）/ 删除                        |
| POST                        | `/imports/class-plan/preview`、`/imports/class-plan`          | 管理员 / 本班班主任          | ClassIsland 课程表解析预览 / 导入（支持单双周）                                  |
| GET / POST / PATCH / DELETE | `/integrations/devices[/:id]`                                 | 管理员 / 教师                | ClassIsland 联动设备管理（令牌只存 sha256，令牌前缀用于人眼识别）                |
| POST                        | `/integrations/devices/:id/token`                             | 管理员 / 教师                | 重置设备令牌（旧令牌立即失效，明文只返回一次）                                   |
| POST                        | `/integrations/classisland/notify`                            | 管理员 / 教师                | 下发提醒到该班 ClassIsland 设备（广播 `classisland:notification`）               |
| GET                         | `/database/status`                                            | **管理员**                   | 数据库状态（连接/版本/体积/14 张表行数/备份列表/定时配置）                       |
| POST                        | `/database/test-connection`                                   | **管理员**                   | 测试任意目标库连通性（切换前置检查；provider 仅 sqlite / mysql）                 |
| GET / POST                  | `/database/backups`                                           | **管理员**                   | 备份列表 / 立即备份（gzip JSON 快照，存 `<数据目录>/backups/`）                  |
| POST / DELETE               | `/database/backups/:name/restore` · `/database/backups/:name` | **管理员**                   | 从备份恢复（整库覆盖）/ 删除备份                                                 |
| GET                         | `/database/export`、`/database/sqlite-file`                   | **管理员**                   | 下载 JSON 快照 / 下载数据库文件（后者仅 SQLite）                                 |
| POST                        | `/database/import`                                            | **管理员**                   | 导入快照（base64，整库覆盖；可在 SQLite/MySQL 之间互迁）                         |
| GET / PUT                   | `/database/backup-schedule`                                   | **管理员**                   | 定时备份配置（enabled/intervalHours/keepCount，存 data/database-settings.json）  |
| POST / GET                  | `/database/switch`、`/database/switch/jobs/:id`               | **管理员**                   | **一键切换数据库**（异步任务：备份→建表→迁数据→改 .env，需重启生效）/ 轮询进度   |
| POST                        | `/integrations/classisland/report`                            | **设备令牌**                 | 插件上报状态 + 课表 + 节次时间（`X-ClassIsland-Token`，非 JWT）                  |
| GET                         | `/integrations/classisland/pending`                           | **设备令牌**                 | 插件拉取尚未确认的提醒（离线期间老师发的通知，重连后补齐）                       |
| POST                        | `/integrations/classisland/ack`                               | **设备令牌**                 | 插件确认提醒已弹出（确认后不再补发）                                             |
| GET                         | `/integrations/classisland/class-plan`                        | **设备令牌**                 | 插件拉取本班课表（开启镜像时）用于写回 ClassIsland                               |
| GET                         | `/health`                                                     | 公开                         | 健康检查（含已挂载模块列表）；另有 `/healthz` 存活探针与 `/readyz` 就绪探针      |

## WebSocket 事件

连接方式：`io(url, { auth: { token } })`，握手阶段用 JWT 鉴权。事件名定义在 `@classhelper/shared` 的
`SOCKET_EVENTS`（**不要手写字符串**）。

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

房间规则（`@classhelper/shared` 的 `SOCKET_ROOMS`）：
`class:{classId}`、`user:{userId}`、`teacher:{teacherId}`、`role:{role}`、`students`、`teachers`。
客户端断线由 Socket.IO 自动重连（Web 端 store 与 EXE 端共用同一套事件名）。

## 角色与权限模型（RBAC）

班级内的角色由"账号角色 + 与该班级的关系"共同决定，前后端共用同一份矩阵
（`packages/shared/src/permissions.ts`，后端 `lib/access.ts` 复用，前端用它隐藏入口）：

| 角色               | 判定方式                       | 可见范围                   |
| ------------------ | ------------------------------ | -------------------------- |
| `ADMIN` 管理员     | `User.role = ADMIN`            | 全部班级                   |
| 班主任 `HEAD`      | `Class.teacherId === 当前用户` | 本班                       |
| 科任老师 `SUBJECT` | `ClassTeacher` 中存在当前用户  | 被分配的班级               |
| 学生 `STUDENT`     | `User.classId` / 班级账号      | 自己的班级（只读业务数据） |

**权限矩阵**（`PERMISSION_MATRIX`，验收脚本按此逐条断言）：

| 操作                                   | 管理员 |    班主任    | 科任老师 |
| -------------------------------------- | :----: | :----------: | :------: |
| 班级创建 / 修改 / 删除                 |   ✅   |      ❌      |    ❌    |
| 分配班主任与科任老师                   |   ✅   |      ❌      |    ❌    |
| 学生名单管理（增删 / 修改密码 / 导入） |   ✅   |      ❌      |    ❌    |
| 教师录入（新建 / 导入名单 / 修改密码） |   ✅   |      ❌      |    ❌    |
| 课表管理（增删改 / 时间配置导入）      |   ✅   | ✅（仅本班） |    ❌    |
| 布置作业                               |   ✅   |      ✅      |    ✅    |
| 叫人                                   |   ✅   |      ✅      |    ✅    |
| 发布通知                               |   ✅   |      ✅      |    ✅    |
| 成绩录入 / 修改 / 导入（仅本班）       |   ✅   | ✅（仅本班） |    ❌    |

实现要点：

- `src/middleware/auth.ts`：JWT 校验后**回查数据库**，班级/角色变更立即生效。
- `src/lib/access.ts`：`resolveUserClassRole()` 解析班级内角色，`assertCanManageClasses` /
  `assertCanAssignTeachers` / `assertCanManageRoster` / `assertCanManageSchedule` /
  `assertCanPublishContent` / `assertCanManageGrades` 在**服务层**断言（路由只做角色过滤）。
- `resolveClassScope()` 收敛列表数据（`classId in [...]`），单条接口直接断言；越权一律 `403`。
- 前端按同一矩阵隐藏入口：教师端侧边栏不再显示「班级管理 / 学生管理 / 教师管理」，
  课表页的增删改按钮仅对"管理员或本班班主任"显示，成绩页的录入/删除按钮管理员与班主任可用。
- **`叫人`入口位置调整**：班主任与科任老师都需要叫人，而「学生管理」页是管理员专属，
  因此教师的叫人入口放在「通知发布 → 叫人」（选班级 → 选学生 → 快捷短语/自定义消息），
  管理员在学生管理里仍保留逐行「叫人」。

> **需求 6 与需求 7 的口径统一（已落地）**：需求 6 要求"成绩与表格导入……老师端与学生端班级账号
> 均可用且不越权"，需求 7 的权限清单（班级增删改、人员分配、科任权限、班主任课表）并未把成绩
> 收归管理员专属。因此成绩相关写入按"老师端可用 + 不越权"实现：
>
> | 能力                       | 管理员 |  班主任   | 科任老师 | 学生 / 班级账号 |
> | -------------------------- | :----: | :-------: | :------: | :-------------: |
> | 录入 / 修改 / 删除成绩     |   ✅   | ✅ 仅本班 |    ❌    |       ❌        |
> | 成绩模板下载 / 预览 / 导入 |   ✅   | ✅ 仅本班 |    ❌    |       ❌        |
> | 学生名单模板 / 预览 / 导入 |   ✅   |    ❌     |    ❌    |       ❌        |
> | 课表时间配置导入           |   ✅   | ✅ 仅本班 |    ❌    |       ❌        |
>
> 越权路径全部由**服务层**兜底（`assertCanManageGrades(user, classId)` → `resolveUserClassRole`）：
> 班主任跨班 403、科任老师 403、学生与班级账号 403，前端只是按同一矩阵隐藏/显示入口。

## 模块化设计（可随时增删模块）

后端每个功能是一个独立目录，统一契约 `ApiModule = { name, basePath, router, enabled? }`：

```ts
// packages/server/src/modules/registry.ts（当前 14 个模块）
export const apiModules: ApiModule[] = [
  authModule,
  classesModule,
  coursesModule,
  schedulesModule,
  homeworksModule,
  notificationsModule,
  callsModule,
  importsModule,
  integrationsModule, // ← ClassIsland 联动
  gradesModule,
  studentsModule,
  teachersModule,
  dashboardModule,
  databaseModule, // ← 数据库管理（仅管理员）
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
- 模型设计为跨库通用（无 enum、无 `@db.*` 原生类型），**切换到 MySQL 只需改 provider + 连接串**
  （`schema.prisma` 只有一份，`scripts/use-database.mjs` 会就地改写它的 `provider`）。
- 完整步骤见 [`docs/mysql.md`](docs/mysql.md)：

```bash
pnpm db:switch:mysql
pnpm --filter @classhelper/server add @prisma/adapter-mariadb
# 修改 packages/server/.env 的 DATABASE_PROVIDER / DATABASE_URL
pnpm db:generate && pnpm --filter @classhelper/server db:deploy && pnpm db:seed
```

数据模型共 **14 张表**：`User` / `Class` / `ClassTeacher` / `Enrollment` / `Course` / `Schedule` /
`Homework` / `HomeworkStatus` / `Notification` / `NotificationRead` / `TimeLayout` / `Grade` /
`IntegrationDevice` / `ClassIslandPush`。其中：
`Class.code` / `Class.passwordHash` 是班级账号字段；`Class.notificationChannel` 决定提醒弹在哪端；
`Homework.assignDate` 是作业的"所属日期"；`Schedule.weekParity` 是单双周；
`ClassIslandPush.kind` 区分通知类与叫人。

迁移历史（9 个，按时间顺序）：`init` → `add_time_layout` → `add_class_account` →
`add_schedule_week_parity` → `add_class_term_weeks` → `add_classisland_integration` →
`add_class_notification_channel` → `add_homework_assign_date` → `add_push_kind`。

### 启动时迁移（安装版自动升级）

`packages/server/src/lib/db-bootstrap.ts` 用一张账本表 `_ch_migrations` 记录已执行的迁移目录名：

- **全新安装**：库中无业务表 → 依次执行 `prisma/migrations/` 下全部迁移，并创建初始管理员；
- **覆盖安装升级**：只补跑账本里没有记录的迁移（已存在的表/索引自动跳过），
  因此新增表（如 `TimeLayout`）无需用户手动执行 `prisma migrate deploy`；
- **已是最新**：直接跳过，不做任何写操作。

日志会明确写出 `全新安装` / `升级安装`、应用了几个迁移、跳过了几个已存在对象，便于排障。

## 验收标准对照

| 验收项                                                  | 结果 | 证据                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 教师 Web 端发布通知，学生端 5 秒内收到                  | ✅   | `verify:e2e`：`notification:new` 实测 30–50ms 到达（要求 < 5 秒）                                                                                                                                                                                                                                                                                                                                                         |
| 教师发布作业，学生能查看并标记完成                      | ✅   | `homework:new` 实时到达，`PATCH /homeworks/:id/status` 200 且列表回显 `completed=true`                                                                                                                                                                                                                                                                                                                                    |
| 教师录入成绩，学生能查看个人成绩                        | ✅   | `grade:updated` 实时到达，`/grades/my` 返回记录；批量录入与统计接口通过                                                                                                                                                                                                                                                                                                                                                   |
| 学生能查看课表，支持按周切换                            | ✅   | `/schedules/grid?week=1` 返回周视图条目，`week` 过滤 `weekStart ≤ week ≤ weekEnd`，单双周按第 1 周=单周过滤                                                                                                                                                                                                                                                                                                               |
| 断网后客户端可查看缓存数据                              | ✅   | 客户端冒烟：`断网时回退到本地缓存 → fromCache=true`；离线横幅 + 缓存统计页可用                                                                                                                                                                                                                                                                                                                                            |
| 权限隔离：学生不能访问其他班级数据                      | ✅   | e2e 中 10 余项越权断言全部 403/401（学生跨班/跨班作业/跨班课表、教师跨班发布、未登录访问…）                                                                                                                                                                                                                                                                                                                               |
| 上课时段发布紧急通知必须二次确认                        | ✅   | 服务端 409 `URGENT_DURING_CLASS`（`confirmDuringClass` 后 201）；Web 端全屏警告 + 3 秒倒计时                                                                                                                                                                                                                                                                                                                              |
| 客户端灵动岛：上课隐藏 / 下课弹出 / 紧急立即展开        | ✅   | `verify:desktop` 状态断言 + 像素级截图（`docs/screenshots/island/`）                                                                                                                                                                                                                                                                                                                                                      |
| 灵动岛：收回无"方框"闪烁 / 点击屏幕任意处收回           | ✅   | 逐帧采样卡片尺寸恒定（窗口固定包围盒）+ 失焦自动收回                                                                                                                                                                                                                                                                                                                                                                      |
| 灵动岛"标为已读"同步通知中心                            | ✅   | 真实链路：点击后 `read=false → true`、未读数减少                                                                                                                                                                                                                                                                                                                                                                          |
| **多条通知展开为竖排列表**                              | ✅   | `verify:desktop`：按重要程度排序、默认 3 行 + `展开更多（还有 N 条）`、卡片高度与 `islandListLayout()` 一致；点"展开更多"铺满；放不下时提示 `更多请前往应用内操作` 且卡片高度 ≤ 可用高度                                                                                                                                                                                                                                  |
| **多条通知的整批操作**                                  | ✅   | `verify:desktop`：`知道了` 整批关闭且状态同步清空、窗口随后淡出隐藏；`标为已读` 经真实链路把**两条**通知都标为已读                                                                                                                                                                                                                                                                                                        |
| **本机录入的作业不再上岛**                              | ✅   | `verify:desktop`：按 id 与内容指纹双重判定，投递后灵动岛状态不变；别的作业照常上岛                                                                                                                                                                                                                                                                                                                                        |
| 作业发布也上岛（"新作业"胶囊）                          | ✅   | `kind=homework` + 展开显示作业要求；**截止时间功能已下线**（接口不再返回 `dueAt`，e2e 有断言）                                                                                                                                                                                                                                                                                                                            |
| **灵动岛收起后始终可再次打开**                          | ✅   | `verify:desktop`：收起后胶囊常驻、「收起态点击可再次展开」、「空闲细缝态保持可交互」                                                                                                                                                                                                                                                                                                                                      |
| 叫人（老师点名，分紧急/普通两级）                       | ✅   | `verify:e2e` 8 项（普通 HIGH / 紧急 URGENT）+ `verify:desktop`「紧急叫人上课也立即展开」「普通叫人上课只进队列、下课弹出」                                                                                                                                                                                                                                                                                                |
| 成绩 / 名单表格导入（xlsx·xls·csv）                     | ✅   | 模板下载 + 预览映射 + 重复处理 + 行号级错误：`verify:e2e` 覆盖 20 余项，`verify:web` 弹窗实测                                                                                                                                                                                                                                                                                                                             |
| ClassIsland 时间配置导入（覆盖 / 合并 / 回滚）          | ✅   | 合法 200、非法 400 `IMPORT_INVALID` 且原配置仍在、merge 覆盖与保留行为符合预期                                                                                                                                                                                                                                                                                                                                            |
| 安装版覆盖升级自动补迁移                                | ✅   | 真实旧库升级日志：`升级安装：已应用 N 个迁移文件，跳过 M 个已存在对象`，新表自动建好                                                                                                                                                                                                                                                                                                                                      |
| 学生端主体 = 班级（班级码 + 班级密码登录）              | ✅   | `verify:e2e` 班级账号 19 项：登录 / 错误密码 401 / 跨班 403 / 发布 403 / 班级码重复 400 / 密码重置 / 班级码用后还原                                                                                                                                                                                                                                                                                                       |
| 班级设备代全班操作（已读 · 完成 · 成绩总览）            | ✅   | 标记已读写入全班、教师端 `readCount` = 班级学生数、`completedCount` 一致、`/grades/my` 返回全班成绩                                                                                                                                                                                                                                                                                                                       |
| 客户端只保留班级登录入口                                | ✅   | `verify:desktop`：导航「成绩」标题变为「本班成绩」；个人学生登录 403                                                                                                                                                                                                                                                                                                                                                      |
| **教师录入（仅管理员）**                                | ✅   | `verify:e2e`：教师读/建教师 403、管理员建 201 → 编辑 → 重置密码（新密码 200/旧密码 401）→ 删除（有职责 409 / 无职责 200）；`verify:web`：管理员真人点「教师管理 → 新建教师 → 保存 → 列表出现 → 删除」                                                                                                                                                                                                                     |
| **教师名单表格导入（仅管理员）**                        | ✅   | `verify:e2e`：教师预览 403、管理员预览/提交 200（`inserted=1`）、导入账号可登录；模板列＝用户名/姓名/初始密码/角色                                                                                                                                                                                                                                                                                                        |
| **教师/学生的「修改密码」（管理员）**                   | ✅   | 服务端 `POST /teachers\|students/:id/reset-password` 本来就收可选 `newPassword`，但界面原先只发空请求、按钮还叫「重置密码」——等于**只能重置成默认密码，没法改成指定值**（用户指着教师列表问"教师修改密码呢"）。现两个页面都改成「修改密码」弹框输入：**填了就设成填的值，留空才是默认初始密码**。实测（真实浏览器点界面）：设 `teacher777` → 新密码可登录、旧密码 401；留空 → 落到 `DEFAULT_TEACHER_PASSWORD`（`123456`） |
| **教室机器自助改密（班级账号 / 教师账号）**             | ✅   | 客户端「设置 → 账号信息 → 修改密码」；服务端同一个 `PATCH /auth/password` 按会话分流（班级账号 → 班级密码，教师/管理员 → 本人密码）。实测：班级账号改 `123456`→`class999` 后新密码可登录、旧密码 401；`verify:desktop` 断言该入口存在且对话框有 3 个密码框                                                                                                                                                                |
| **触摸屏触摸灵动岛可展开（希沃白板）**                  | ⏳   | 触摸模式下窗口贴合岛体 + 始终接收输入（见「灵动岛」一节）；`verify:desktop` 断言「触摸模式窗口=岛体 + 2×阴影留白、`interactive=true`、退出后恢复固定包围盒」。**真机（希沃白板）触摸需在装有触摸屏的机器上人工复验** —— AI 会话里跑不了 Electron GUI（见 AGENTS.md §7）                                                                                                                                                   |
| **创建班级仅管理员 + 设置/更改班主任**                  | ✅   | `verify:e2e`：教师建班 403；管理员建班可带 `teacherId`、`PATCH /classes/:id/head-teacher` 落库生效；`verify:web`：教师直接访问 `/teachers` 被挡回仪表盘                                                                                                                                                                                                                                                                   |
| **授课科目统一（18 科固定目录）**                       | ✅   | `verify:web`：新增课表的科目下拉出现「统一科目（选中后自动建课）」，选中 → 自动建课 → 写入课表成功（收尾删除该条课表）                                                                                                                                                                                                                                                                                                    |
| **登录页无示例内容**                                    | ✅   | `verify:web`（管理端）与 `verify:desktop`（客户端）都断言登录页正文/占位符不含 `演示 / 示例 / admin123 / teacher123 / G101`                                                                                                                                                                                                                                                                                               |
| **初次启动引导（首启弹出 + 随时重看）**                 | ✅   | Web 管理端：首次登录弹出 `el-tour` 聚焦引导，头像菜单「使用引导」重看（`verify:web`：「首次登录展示新手引导且可跳过」）；学生端：首启六步向导，登录页 / 设置页可重看（`verify:desktop`：「初次启动引导（首启自动弹出、可走完、状态写入配置）」）                                                                                                                                                                          |
| **数据库管理（仅管理员：状态/备份/导入导出/一键切换）** | ✅   | `verify:e2e` 新增 13 项：状态与 14 表行数、教师全端点 403、连接测试（当前库可达 / 不可达 MySQL ok=false）、**Redis 主库 422**、切换校验分支（同库 400）、备份→快照导入→备份恢复 roundtrip（临时数据被清除）、定时配置校验、SQLite 文件下载；**切换子进程链路真机实测**：快照 728 行 → generate → db push → apply-snapshot 逐表写入一致；`verify:web`：「数据库管理页（仅管理员）」状态卡与备份表渲染                      |
| **客户端设置改版（分组侧栏/深色模式/关于页）**          | ✅   | `verify:desktop`：「侧边栏点击导航」适配「学习/设置」分组结构；「主题切换与侧边栏折叠（真实点击、写回配置）」——html.dark 翻转 + 折叠宽度 200→64 + 双双落盘；「关于页渲染（应用信息/诊断信息/鸣谢）」含 configPath；四个设置页用例改走子路由后全过（101/101 + 二次启动 88/88）                                                                                                                                             |
| **其他页面发通知也会联动 ClassIsland**                  | ✅   | `verify:classisland`：「通知发布页发的通知也会推送」「叫人也会推送」；真机实测截图 [03-from-notify-page](docs/screenshots/classisland/03-from-notify-page.png)                                                                                                                                                                                                                                                            |
| **作业按天查看（日期选择器 + 有作业日期高亮）**         | ✅   | `verify:e2e`：`assignDate` 默认服务器当天、`?date=` 只返回该天、`/homeworks/days` 返回有作业日期、非法日期 422                                                                                                                                                                                                                                                                                                            |
| **支持在客户端录入作业（含自定义快捷短语）**            | ✅   | `verify:e2e`：班级账号录入 201（归属班主任）、跨班 403；客户端录入弹窗 + 「设置 → 作业录入」管理短语                                                                                                                                                                                                                                                                                                                      |
| **提醒弹在哪个端由客户端自行选择**                      | ✅   | 客户端「设置 → 通知显示位置」三选一（`verify:desktop`：设置页真实点击 → 写回本地配置）；服务端按班级设置决定是否推送（`verify:classisland`：client 时通知与联动页下发都被跳过）                                                                                                                                                                                                                                           |
| **班级小助手能读取 ClassIsland 的课表**                 | ✅   | `verify:classisland`：插件上报课表 → 本班课表新增/更新（重复上报幂等）、节次时间写入、设备状态快照可在 Web 端展示；`verify:web`：教师在「ClassIsland 联动」页真实签发设备令牌                                                                                                                                                                                                                                             |
| **用户可选择通知是否在 ClassIsland 上显示**             | ✅   | 插件设置页开关「接收班级小助手提醒」（本机总闸）+ Web 端「下发提醒」（标题/内容/时长/优先级/语音朗读/是否同步通知中心）；`verify:classisland`：提醒落库 → 待提醒 → 回执 → 确认后不补发                                                                                                                                                                                                                                    |
| 能成功打包 Windows EXE                                  | ✅   | `-x64-setup.exe` / `-x64-portable.exe` / `win-unpacked/*.exe`（见下表）                                                                                                                                                                                                                                                                                                                                                   |
| 提供完整 README（启动、构建、打包、默认账号）           | ✅   | 本文档含快速开始、命令表、API、WebSocket、RBAC、模块化、MySQL 切换、打包与常见问题                                                                                                                                                                                                                                                                                                                                        |

验收脚本实测（**2026-10-02**，本机）：

| 验证                                                                                                     | 结果                                                                    |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `pnpm verify:e2e`（后端 + REST + Socket.IO + RBAC + 上课时段 + 导入 + 班级账号 + 教师录入 + 数据库管理） | **186/186** ✅（2026-10-02 实测）                                       |
| `pnpm verify:desktop`（客户端冒烟，不弹窗）                                                              | **101/101** ✅ + 二次启动 **88/88** ✅                                  |
| `pnpm verify:web`（Web 管理端真实点击回归）                                                              | **30/31** ✅（未过的 1 项是既有脆弱用例，见下）                         |
| `pnpm verify:classisland`（设备令牌 / 上报 / 提醒下发与回执 / 镜像契约）                                 | **42/42** ✅                                                            |
| `pnpm verify:classisland-plugin`（插件静态契约）                                                         | **68/68** ✅                                                            |
| `pnpm dist:server`（服务端安装包 + Web 端）                                                              | ✅ 打出 71MB 安装程序（体积增大是因随包内置切换链路所需的依赖）         |
| `pnpm typecheck` / `pnpm lint`                                                                           | 全过 ✅（lint 0 error，1 条既有 warning）                               |
| 数据库切换子进程链路（快照 → generate → db push → 写入目标库）                                           | ✅ 实测：728 行逐表一致（users=18 / schedules=93 / grades=98 抽查一致） |
| 安装程序完整生命周期（静默安装 → 启动 → 卸载，装到 `%LOCALAPPDATA%\Programs`）                           | 通过 ✅（2026-09-30 实测：安装 76 个文件，启动出窗口，卸载干净）        |
| 便捷版（单文件）解包启动                                                                                 | 通过 ✅（2026-09-30 实测：wrapper + 6 个进程，主窗口正常）              |
| Docker / Nginx 部署样例                                                                                  | 文件已提供（含 Linux systemd 脚本），本机无 Docker/Linux 未实测 ⚠️      |

> 本轮 `verify:web` 未过的 1 项是**既有脆弱用例**（AGENTS.md 「已知脆弱用例」表已列明）：
> 「课表科目为全校统一目录」——种子给每个班建满了全部科目，下拉里没有可自动建课的「统一科目」分组。

> 打包版冒烟未过的都是**应用功能用例**（与打包/安装无关）。其中前两项是**测试自身的 bug、已修**
> （2026-09-30 复跑确认不再失败）：
>
> - ~~触摸模式窗口矩形断言~~ → 断言原先写死了"窗口 = 胶囊尺寸 + 留白"，而那一刻岛是胶囊还是卡片取决于
>   前面用例留下的状态，形态一变就误报。现改为**与形态无关的不变量**：「窗口 = 卡片实测尺寸 + 2×阴影留白」。
> - ~~设置页「修改密码」对话框取消后未关闭~~ → Element Plus 关闭 `el-dialog` 后**会把 DOM 留在文档里**
>   （只把 `.el-overlay` 置为 `display:none`），断言用 `querySelector('.el-dialog')` 判存在恒为真。
>   现改为看 overlay 的 `display`。
>
> 剩下两项与本轮改动无关、仍待办：设置页「左右边距」滑块在左停靠时岛未移动（页面还显示 `undefined`）、
> 作业看板全屏自适应。**2026-09-30 复核**：`pnpm verify:packaged` 首次 **89/91**、二次 **79/79**，
> 失败项正是这两条 —— 也就是说除了这两条功能用例，打包版冒烟已全绿。

打包产物（最近一次打包实测，产物本身不入库）：

| 产物                                   | 大小   | 冒烟结果                                                             |
| -------------------------------------- | ------ | -------------------------------------------------------------------- |
| 服务端安装程序（内置 Node + Web 端）   | ~34MB  | ✅ 静默安装（升级保留 `.env` 与数据库）→ 自动建库建号 → 服务就绪     |
| `release/win-unpacked/班级小助手.exe`  | ~235MB | ✅ 打包版冒烟全绿，`packaged: true`，退出码 0                        |
| `release/…-x64-portable.exe`（单文件） | ~107MB | ✅ 打包后冒烟全绿，`packaged: true`，退出码 0                        |
| `release/…-x64-setup.exe`（客户端）    | ~107MB | ✅ 构建成功，已嵌入自定义图标                                        |
| `releases/classisland-plugin/….cipx`   | ~88KB  | ✅ 全量编译通过（1 警告 0 错误），包内 DLL 哈希与 `bin/Release` 一致 |

## 常见问题（本机环境已知坑）

1. **`pnpm db:deploy` 在根目录不存在**
   现象：`Command "db:deploy" not found`（还会附带一句莫名的 `文件名、目录名或卷标语法不正确。`）。
   原因：根 `package.json` 只声明了 `db:generate / db:migrate / db:seed / db:reset / db:studio`，
   `db:deploy` 在 `packages/server` 包里。
   规避：`pnpm --filter @classhelper/server db:deploy`。

2. **`pnpm db:migrate`（`prisma migrate dev`）在本机不可靠**
   首次报 `Schema engine error:`（空消息），库建好后会长时间挂起。
   规避：用 `db:deploy` 应用迁移；要写种子直接 `pnpm db:seed`。

3. **`pnpm db:seed` 报 `Cannot find module '.../@classhelper/shared/dist/index.js'`**
   原因：`packages/shared` 还没构建（它产出 `dist`，三端与 seed 都依赖）。
   规避：先 `pnpm build:shared`（`pnpm dev*` / `build` / `typecheck` 已内联这一步）。

4. **Electron 二进制缺失 / 下载慢或失败**
   现象：`pnpm install` 不会下载 Electron 二进制（实测 postinstall 未执行），
   `pnpm dev:desktop` / `verify:desktop` / `verify:web` 全部失败。
   规避：手动装一次（约 150MB，支持镜像）：

   ```bash
   cd node_modules/.pnpm/electron@44.3.0/node_modules/electron
   ELECTRON_MIRROR=https://cdn.npmmirror.com/binaries/electron/ NODE_OPTIONS=--use-system-ca node install.js
   ```

5. **客户端装不上 / 便捷版双击没反应 / 应用一闪就没（0x80000003）**
   现象：安装程序跑到一半报"拒绝访问"或直接失败；便捷版双击毫无反应；即使装上，应用启动即退出，
   连日志都不写。`electron.exe --version` 都打印不出东西，加 `--no-sandbox` 变成 0xC0000005，
   但同一个 exe 加 `ELECTRON_RUN_AS_NODE=1` 当 Node 跑却完全正常。
   原因：**构建出的交付物被打上了 Low 完整性标签**（本仓库目录树带此标签、可继承，
   在仓库内构建就会继承）。带 Low 标签的 exe 会被 Windows 降级到低完整性运行，
   于是写不进 `%LOCALAPPDATA%` / `%TEMP%`（安装、解包都失败）；即使装上了，
   Chromium 的 GPU/渲染子进程（AppContainer，完整性更低）也读不到这些文件而秒崩。
   修法：`pnpm dist:win` 收尾已自动把交付物的标签改成 Medium，无需手工干预；
   手工补救与排查命令见 [AGENTS.md](AGENTS.md) §7 第 7 条。
   注意**别把安装测试装进仓库目录里**（会在那儿又继承 Low，看起来像"装完还是坏的"）。

6. **插件编译需要的 .NET 8 SDK 已装**（8.0.425，`C:\Program Files\dotnet\sdk`）
   判断依据要看 `dotnet --list-sdks` 有没有输出，**别只看目录存在与否**（曾一度误判为"没装"）。
   脚本已把 NuGet 缓存与临时目录指到仓库内 `.cache/`（`dotnet` 默认写 C 盘）；手敲 `dotnet build` 时自己带上
   `NUGET_PACKAGES / TEMP / TMP / DOTNET_CLI_HOME`。

   两个坑：**别把增量构建的输出当编译证据** —— 源码没变时 `dotnet build` 会空转，照样打印
   `已成功生成 / 0 警告 0 错误`，但 `CoreCompile` 没跑；要证明"真的编译过"用
   `node packages/classisland-plugin/scripts/build.mjs -t:Rebuild -v:n` 看有没有 `csc.dll`。
   另一个：全量编译会有 **1 个警告 `AVLN3001`**（设置页 `BridgeSettingsPage` 只有 DI 构造函数、无公开无参构造，
   Avalonia 说它走不了运行时加载器）——这是**预期内的**，本插件走编译期 XAML + ClassIsland DI 实例化，
   别为了消警告加无参构造函数（会把 DI 弄坏）。

7. **`Electron` / 原生模块相关的坑**：本项目用 **libSQL 适配器**（`@libsql/win32-x64-msvc` 预编译包），
   不做本地编译，彻底避开 `node-gyp` 与 Electron ABI 不一致的问题，不要为了图快换回 `better-sqlite3`。

8. **本机 TLS 中间人证书导致依赖二进制下载失败**
   现象：`prebuild-install warn install unable to verify the first certificate`。
   规避：下载时设置 `NODE_OPTIONS=--use-system-ca`（Node ≥ 22.15 支持），
   并确保 `npm_config_cache` 指向可写目录（如仓库内 `.cache/npm-cache`）。

9. **Prisma 7 与旧版本差异**
   `prisma` 的 npm `latest` 标签当前指向 8.x，本项目**显式锁定 7.10.0**；
   生成器为 `prisma-client`（输出到 `src/generated/prisma`，已 gitignore），
   连接串在 `prisma.config.ts` 中配置，且必须通过 driver adapter 接入数据库。

10. **electron-builder 的构建工具（NSIS / winCodeSign）下载慢**
    通过 `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`
    解决（已内置到 `dist-win.mjs`）。`scripts/dist-server.mjs` 会直接复用 electron-builder 缓存里的 `makensis`。

11. **makensis 建不了临时文件时，NSIS 那一步会失败**（`dist:server` 与 `dist:win` 都会踩）
    - `pnpm dist:server` 报 `Internal compiler error #12345: error creating mmap…`：makensis 会在
      `%TEMP%` 所在盘建上百 MB 的 mmap 临时文件，盘紧就失败。规避：
      `TEMP='D:\classhelper\.cache\tmp' node scripts/dist-server.mjs --reuse-deps`。
    - `pnpm dist:win` 报 `!tempfile: Unable to create temporary file!` / `Error in macro _Switch`：
      **不是空间不足**，而是 Git Bash 里 `TEMP=TMP=/tmp`，makensis 把 `/tmp` 当成「当前盘下的 tmp」
      （`D:\tmp`）解析，该目录不存在。规避：`mkdir -p .cache/tmp` 后
      `TEMP='D:\classhelper\.cache\tmp' TMP='D:\classhelper\.cache\tmp' node packages/desktop-client/scripts/dist-win.mjs`
      —— 此时 `win-unpacked` 与 `release/*.nsis.7z` 都已生成，重跑只补 NSIS 打包那一步，不必重建前端。

12. **应用图标**
    `pnpm icons` 会用 Electron 渲染 SVG 生成 `packages/desktop-client/build/icon.ico`（多尺寸）、
    PWA 所需的 PNG 与 `favicon.svg`。electron-builder 与 NSIS 安装程序都会自动使用该图标。

13. **服务端安装包内的 `.cmd` 脚本为什么是英文提示？**
    cmd.exe 按 OEM 代码页（GBK）解析脚本文件，UTF-8 中文会产生乱码甚至语法错误，
    因此脚本提示统一用 ASCII，中文说明放在安装向导与 `README.txt` 中。

14. **服务端改了代码要重启才生效**
    `tsx src/index.ts` 不热载；开发时用 `pnpm dev:server`（watch）。验证脚本突然报错时先确认后端是不是最新代码。

15. **`pnpm format:check` 在 master 基线上本来就是失败的**
    不要拿它当门禁、也不要为了让它变绿去批量格式化；只检查你改过的文件
    （`pnpm exec prettier --check <file>`）。

16. **ClassIsland 相关路径（2026-09-30 起）**
    - 程序：`D:\Classisland`（数据根 `D:\Classisland\data`）；旧文档里的 `F:\classisland` / `F:\data` 已失效；
    - 插件 DLL 覆盖到 `D:\Classisland\data\Plugins\classhelper.classisland.bridge\`，**必须先退出 ClassIsland**；
    - 插件设置：`D:\Classisland\data\Config\Plugins\<id>\Settings.json`（**运行中改会被回写覆盖**，别覆盖令牌）；
    - 日志：`D:\Classisland\data\Logs\`，读的时候用 **GBK（936）** 编码，否则中文关键字搜不到。

## 交付清单（按阶段）

阶段 7（生产化）：

| 路径                                                     | 说明                                                                                      |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `scripts/dist-server.mjs`                                | 服务端 + Web 端打包（内置 Node、依赖、迁移、启停脚本、安装程序）                          |
| `scripts/nsis/server-installer.nsi`                      | NSIS 安装程序模板（安装/快捷方式/开机自启/卸载保留数据）                                  |
| `scripts/generate-icons.mjs` + `scripts/icons/`          | 图标生成（Electron 渲染 SVG → PNG/ICO）                                                   |
| `scripts/ui-smoke/`                                      | Web 管理端 UI 真实点击回归测试                                                            |
| `packages/server/src/middleware/security.ts`             | helmet + 限流（通用/登录）+ 请求耗时日志                                                  |
| `packages/server/src/lib/web-static.ts`                  | Web 管理端静态托管 + SPA 回退 + 缓存策略                                                  |
| `packages/server/src/lib/db-bootstrap.ts`                | 首启动自动迁移 + 自动创建管理员                                                           |
| `packages/web-admin/public/{manifest.webmanifest,sw.js}` | PWA：可安装为应用 + 离线外壳                                                              |
| `deploy/*`                                               | 云部署与 HTTPS 反代样例（含 SQLite 单容器 compose 与 Linux 一键脚本）                     |
| `docs/production.md`                                     | 生产部署指南（Windows / Docker+MySQL / Linux systemd / 手动，含运维、安全清单与故障排查） |

阶段 8（灵动岛 + 上课时段策略）：

| 路径                                                         | 说明                                                                 |
| ------------------------------------------------------------ | -------------------------------------------------------------------- |
| `packages/desktop-client/src/main/island.ts`                 | 灵动岛控制器（窗口/状态机/动画/超时/IPC）                            |
| `packages/desktop-client/src/preload/island.ts`              | 灵动岛 preload 桥（`islandGetState/islandPush/islandSetClassState`） |
| `packages/desktop-client/src/island/IslandApp.vue`           | 灵动岛界面（胶囊 / 详情 / 紧急三种形态 + 动画）                      |
| `packages/desktop-client/src/renderer/island/bridge.ts`      | 上课状态轮询与通知转发                                               |
| `packages/server/src/modules/schedules/schedules.service.ts` | `computeClassStatus` / `getClassStatus`（上课时段判定）              |
| `packages/web-admin/src/components/UrgentClassWarning.vue`   | 上课时段发布紧急通知的全屏二次确认（3 秒倒计时）                     |
| `scripts/ui-smoke/live-probe.mjs`                            | UI 回归测试的"真实上课时段"探针（自建课表 + 用后清理）               |
| `scripts/lib/{electron-env,node-runtime}.mjs`                | Electron/Node 运行时定位与宿主环境兼容处理                           |
| `docs/screenshots/island/*.png`                              | 灵动岛各形态的自动化留档截图（由冒烟验证生成，含像素级断言）         |

阶段 9（导入能力）：

| 路径                                                           | 说明                                                                       |
| -------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `packages/server/src/modules/imports/imports.module.ts`        | 导入路由（模板 / 表格预览与提交 / 时间配置 / 课程表）                      |
| `packages/server/src/modules/imports/imports.schemas.ts`       | Zod 校验（base64 文件、字段映射、写入模式、时间配置与课程表 payload）      |
| `packages/server/src/modules/imports/table-import.service.ts`  | SheetJS 解析 + 模板生成 + 同义词映射 + 成绩/名单写入与结果统计             |
| `packages/server/src/modules/imports/time-layout.service.ts`   | ClassIsland 时间配置容错解析（多形态/多字段名/秒与 HH:mm）+ 覆盖/合并      |
| `packages/server/src/modules/imports/class-plan.service.ts`    | ClassIsland 课程表解析（节次对齐、单双周、科目补建）                       |
| `packages/web-admin/src/components/TableImportDialog.vue`      | 成绩 / 名单导入弹窗（模板、预览、字段映射、模式、结果与错误行）            |
| `packages/web-admin/src/components/TimeLayoutImportDialog.vue` | ClassIsland 时间配置导入弹窗（粘贴/选文件、解析预览、覆盖/合并、已存列表） |
| `packages/web-admin/src/components/ClassPlanImportDialog.vue`  | ClassIsland 课程表导入弹窗（预览待补建科目、覆盖/合并）                    |

阶段 10（学生端班级账号）：

| 路径                                                       | 说明                                                                    |
| ---------------------------------------------------------- | ----------------------------------------------------------------------- |
| `packages/server/src/lib/class-account.ts`                 | 班级码校验/生成、班级密码设置与重置、登录校验、班级账号自助改密码       |
| `packages/server/src/lib/session.ts`                       | `isClassSession` / `resolvePersonalIds` / `personalIdWhere`（全班范围） |
| `packages/server/prisma/migrations/*_add_class_account/`   | `Class.code` / `Class.passwordHash` 迁移（老数据回填 `C00001` 形式）    |
| `packages/desktop-client/src/renderer/views/LoginView.vue` | 班级码 + 班级密码登录页（客户端唯一登录方式）                           |
| `packages/web-admin/src/views/ClassesView.vue`             | 班级账号列与设置/重置弹窗                                               |
| `packages/desktop-client/scripts/smoke.mjs`                | 冒烟前通过管理端接口准备可用班级凭据（兼容全新安装与升级安装）          |

阶段 11（参考 WinIsland 重写灵动岛）：

| 路径                                               | 说明                                                                                                       |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `docs/winisland-design-tokens.md`                  | 从 WinIsland 源码逐条提取的设计 token（几何/配色/排版/层级/布局/图标 + 动效与设置模型）                    |
| `packages/desktop-client/src/island/squircle.ts`   | 连续圆角（超椭圆角）路径生成，对齐 WinIsland `utils/shape.rs` 的 continuous rounded rect                   |
| `packages/desktop-client/src/island/spring.ts`     | 弹簧逐帧插值（照搬 WinIsland `physics.rs` 参数 + 零过冲钳制）                                              |
| `packages/desktop-client/src/island/IslandApp.vue` | 灵动岛 UI 全量重写：squircle + 三种底 + Apple 系统色 + 字号系数驱动的排版 + 无回弹过渡                     |
| `packages/desktop-client/src/main/island.ts`       | 固定包围盒窗口、6 锚点、边距、空闲细缝、鼠标命中开关（**刻意不设窗口背景材质**，见 AGENTS.md §5 第 21 条） |

阶段 12（ClassIsland 联动插件）：

| 路径                                                               | 说明                                                                                            |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `packages/server/src/modules/integrations/`                        | 联动模块：设备令牌鉴权（sha256）/ 上报写库 / 提醒下发与回执 / 课表镜像（复用导入模块口径）      |
| `packages/server/prisma/migrations/*_add_classisland_integration/` | `IntegrationDevice` + `ClassIslandPush` 迁移（跨库通用，只用基础类型）                          |
| `packages/server/scripts/verify-classisland.mjs`                   | 联动链路端到端验收（需服务端已启动）                                                            |
| `packages/classisland-plugin/`                                     | ClassIsland 插件（.NET 8）：入口 / 联动主循环 / 提醒提供方 / 设置页 / 契约 DTO                  |
| `packages/classisland-plugin/scripts/{build,verify}.mjs`           | 插件编译打包（`.cipx` 归集到 `releases/`）与静态契约校验                                        |
| `docs/screenshots/classisland/*.png`                               | 真机联调留档：普通/紧急提醒在 ClassIsland 上的弹出效果                                          |
| `packages/web-admin/src/views/IntegrationsView.vue`                | Web 端「ClassIsland 联动」页：设备卡片与列表、令牌签发/重置、下发提醒表单                       |
| `packages/shared/src/{types,constants,utils}.ts` 的联动契约        | `IntegrationDeviceDto` / `ClassIslandReportRequest` / `weekParityFromDiv` ⇄ `weekDivFromParity` |

阶段 13（作业按天 + 教室机器录入）：

| 路径                                                                     | 说明                                                                    |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `packages/shared/src/utils.ts` 的 `dayKeyLocal / isDayKey / shiftDayKey` | 本地日期口径（避免 UTC 切片把晚上的作业算成第二天）                     |
| `packages/server/prisma/migrations/*_add_homework_assign_date/`          | `Homework.assignDate` 迁移                                              |
| `packages/server/src/modules/homeworks/`                                 | 按天查询（`?date=`）、有作业日期（`/days`）、未交名单（`/submissions`） |
| `packages/desktop-client/src/renderer/views/HomeworkView.vue`            | 日期选择器 + 前/后一天 + 录入作业弹窗 + 快捷短语                        |
| `packages/desktop-client/src/main/config.ts`                             | `homeworkPhrases`（默认取自共享常量 `HOMEWORK_PHRASE_DEFAULTS`）        |

## 后续可选增强

1. 代码签名证书（消除 SmartScreen 提示）。
2. 客户端"提交类操作离线队列"（当前离线为只读，联网后自动同步读取的数据）。
3. Socket.IO 多实例广播（引入 `@socket.io/redis-adapter`）与 CI 流水线。
4. 灵动岛在「跟随鼠标屏幕」之外，支持记住每块屏幕各自的外观偏好。
