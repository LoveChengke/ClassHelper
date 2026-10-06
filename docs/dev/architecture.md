---
title: 架构总览
description: 目录结构、技术栈、模块化设计与几条贯穿全局的工程约定。
---

# 架构总览

## 技术栈

| 层     | 选型                                                                 | 版本（`package.json` 实际声明）                            |
| ------ | -------------------------------------------------------------------- | ---------------------------------------------------------- |
| 包管理 | pnpm workspace                                                       | 11.8.0                                                     |
| 语言   | TypeScript                                                           | 5.9.3（`typescript-eslint` 要求 < 6.1，因此未用 7.x）      |
| 后端   | Node.js + Express                                                    | ≥ 20.19 / 5.2                                              |
| ORM    | Prisma + driver adapter                                              | 7.10（+ `@prisma/adapter-libsql`，切 MySQL 用 `-mariadb`） |
| 实时   | Socket.IO                                                            | 4.8                                                        |
| 认证   | jsonwebtoken + bcryptjs                                              | 9.0 / 3.0                                                  |
| 校验   | zod                                                                  | 4.6                                                        |
| Web 端 | Vue + Vite + Element Plus + Pinia + Vue Router + Axios               | 3.5 / 8.3 / 2.14 / 4.0 / 5.3 / 1.20                        |
| 客户端 | Electron + Vue + Element Plus + Pinia + Socket.IO Client + IndexedDB | 44.3 / 3.5 / 2.14 / 4.0 / 4.8                              |
| 插件   | .NET 8 / C# + Avalonia（ClassIsland 插件 API 2.0）                   | net8.0                                                     |
| 打包   | electron-builder（nsis / portable）+ NSIS                            | 26.15                                                      |
| 文档站 | docfx                                                                | 2.81                                                       |

## 目录结构

```
class-helper/
├── package.json                 # 根脚本（dev / build / db:* / verify:* / dist:* / docs:* / icons）
├── pnpm-workspace.yaml          # workspace 定义 + allowBuilds（pnpm 11 依赖构建白名单）
├── tsconfig.base.json           # 共享 TS 基础配置（ESM + NodeNext + strict）
├── eslint.config.mjs            # ESLint 扁平配置（TS + Vue）
├── .prettierrc.json             # 单引号 / 110 列 / LF / 尾逗号
├── build/classhelper.{png,ico}  # **图标源**（设计导出、手工放入）；pnpm icons 从它派生其余全部图标
├── scripts/
│   ├── use-database.mjs         # SQLite ⇄ MySQL provider 切换助手
│   ├── generate-icons.mjs       # 启动 Electron 跑 icons/render.cjs（= pnpm icons）
│   ├── icons/render.cjs         # 把 classhelper.png 重采样成各端图标（CommonJS）
│   ├── version.mjs              # 版本号单一来源的读写与一致性校验（= pnpm version:*）
│   ├── dist-server.mjs          # 服务端 + Web 管理端打包（免安装目录 + NSIS 安装程序）
│   ├── verify-packaged.mjs      # 对打包后 / 已安装的客户端 EXE 复跑冒烟
│   ├── lib/                     # electron-env / node-runtime / smoke-class
│   ├── nsis/server-installer.nsi# 安装程序脚本模板（版本号由 dist-server 注入）
│   └── ui-smoke/                # Web 管理端 UI 真实点击回归（Electron 驱动）
├── deploy/                      # 生产部署：Dockerfile / docker-compose{,.sqlite}.yml / nginx.conf
│   ├── install.sh               # Linux 一键安装器（TUI；native/docker 双形态；自带 --check 体检）
│   ├── classhelper              # 运维命令本体（软链 /usr/local/bin/classhelper）
│   ├── verify-linux.sh          # Linux 安装/改密/备份/升级/回滚验收（自统计 N/N 项）
│   ├── tools/admin-cli.mjs      # 离线账号工具（改密、列账号、SQLite 一致性快照）
│   ├── classhelper.service      # systemd 单元模板
│   └── package.runtime.json     # 运行时依赖清单（安装包 / 容器 / Linux 部署共用）
├── docs/                        # **文档站**（docfx 项目，发布到 GitHub Pages）
│   ├── docfx.json               # docfx 配置
│   ├── toc.yml                  # 顶栏导航；各子目录各有一份 toc.yml 作为侧栏
│   ├── index.md                 # 首页
│   ├── get-started/ app/ management/ dev/   # 四个章节
│   ├── templates/classhelper/   # docfx 模板覆盖（_master.tmpl + public/main.css + 图标）
│   ├── images/                  # 展示图：文档站 / README / 官网共用的同一份（1× 逻辑像素）
│   ├── screenshots/             # 回归测试留档的截图（island / client / web-mobile / classisland），页面不展示
│   ├── build.mjs                # 构建入口（注入版本号与 404 的 base）
│   ├── serve.mjs                # 本地预览（:5181）
│   └── _site/                   # 构建产物（gitignore）
├── website/                     # 产品官网（纯静态，无构建；node website/serve.mjs 本地预览）
│   └── assets/{styles.css,motion.js,main.js,icon.png,shots/}
└── packages/
    ├── shared/                  # 三端共享：类型契约、常量、权限矩阵、动效令牌、工具函数
    │   └── src/{types,constants,permissions,motion,island-layout,utils,index}.ts
    ├── server/                  # 后端服务
    │   ├── prisma/schema.prisma # 数据模型（14 个 model，只有一份，切库改 provider）
    │   ├── prisma/migrations/   # 迁移历史（10 个）
    │   ├── prisma/seed.ts       # 种子数据（会清空业务表后重建演示数据）
    │   ├── scripts/             # verify-e2e.mjs / verify-classisland.mjs / apply-column-migrations.cjs
    │   └── src/
    │       ├── app.ts           # Express 装配（探针 + 限流 + 模块挂载 + 静态托管 + 兜底）
    │       ├── index.ts         # 启动入口（自检 + HTTP + Socket.IO + 优雅退出）
    │       ├── config/env.ts    # 环境变量校验（zod）+ 生产配置自检
    │       ├── lib/             # access(RBAC) / snapshot(全库 JSON 快照) / db / db-bootstrap /
    │       │                    #   session / web-static / http / jwt / logger / mappers / version …
    │       ├── tools/apply-snapshot.ts  # 跨库迁移的子进程入口
    │       ├── middleware/      # auth / error / validate / security(helmet + 限流 + 耗时日志)
    │       ├── realtime/        # socket.ts（房间）+ bus.ts（事件总线）
    │       └── modules/         # 15 个功能模块 + registry.ts（模块注册表）
    ├── classisland-plugin/      # ClassIsland 联动插件（.NET 8 / C#，独立于 pnpm workspace）
    │   ├── manifest.yml
    │   ├── src/Plugin.cs
    │   ├── src/Services/        # BridgeService / ScheduleMapper / ClassPlanWriter /
    │   │                        #   ClassHelperNotificationProvider
    │   ├── src/Views/           # BridgeSettingsPage.axaml（Avalonia 设置页）
    │   └── src/Interop/ClassHelperClient.cs   # HTTP 客户端 + 逐字段对齐服务端 zod 的 DTO
    ├── web-admin/               # Web 管理端（Vue 3 + Vite + Element Plus + PWA）
    │   └── src/{api,stores,router,layouts,views,components,composables,styles}
    └── desktop-client/          # 桌面客户端（Electron + Vue 3）
        ├── electron-builder.yml
        ├── scripts/{build-main,dev,smoke,dist-win,check-bundle-secrets}.mjs
        └── src/
            ├── main/            # 主进程：窗口 / 单实例 / 配置持久化 / 托盘 / 灵动岛 / 冒烟
            ├── preload/         # contextBridge 安全桥（index.ts + island.ts）
            ├── island/          # 灵动岛渲染进程（独立透明置顶窗口）
            ├── types/desktop.d.ts   # 主进程 ↔ 渲染进程契约
            └── renderer/        # 渲染进程：api / stores / cache / router / views / island
```

## 模块化设计

后端每个功能是一个独立目录，统一契约：

```ts
// packages/server/src/modules/registry.ts（当前 15 个模块）
export const apiModules: ApiModule[] = [
  authModule,
  classesModule,
  coursesModule,
  schedulesModule,
  homeworksModule,
  notificationsModule,
  callsModule,
  importsModule,
  integrationsModule,
  gradesModule,
  studentsModule,
  teachersModule,
  dashboardModule,
  databaseModule, // 数据库管理（仅管理员）
  updateModule, // 更新检查（服务端唯一出网请求）
].filter((module) => module.enabled !== false);
```

- **新增功能**：新建 `modules/<name>/`（`*.schemas.ts` 校验、`*.service.ts` 业务、`*.module.ts` 路由），
  在 registry 里加一行即可，`app.ts` 不用改；
- **下线功能**：删掉那一行，或把 `enabled` 置为 `false`，接口立即从路由表消失；
- **实时推送解耦**：业务模块只调 `realtime/bus.ts` 的 `emitToClass/emitToUser`，不直接依赖 Socket.IO 实例；
- **共享契约**：所有 DTO 与类型集中在 `@classhelper/shared`（改完要 `pnpm build:shared`），三端共用。

## 几条贯穿全局的硬约定

这些都是踩过坑之后固化下来的，改代码前值得先看（完整版在 `AGENTS.md`）：

| 约定                         | 为什么                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **统一响应与校验**           | 用 `lib/http.ts` 的 `sendOk/sendCreated`，用 `middleware/validate.ts` 挂 zod，错误交给 `middleware/error.ts` |
| **权限判在服务层**           | 路由只做角色过滤，班级维度的判断用 `lib/access.ts` 断言 —— 前端隐藏 ≠ 权限                                   |
| **周一为新一周的第一天**     | 周次口径唯一：`resolveCurrentWeek(TERM_START_DATE, now, MAX_TERM_WEEK)`                                      |
| **作业按 `assignDate` 归类** | 用 `createdAt`（UTC）会在晚上把作业算到第二天                                                                |
| **新增实时事件要改三处**     | 服务端 bus/socket、Web 端订阅、客户端订阅（灵动岛也依赖）                                                    |
| **跨桥接只传纯数据**         | 传 Vue 的 `ref.value` 会在进入 preload 之前就抛 `could not be cloned`                                        |
| **桌面端产物里不得有凭据**   | asar 可直接解包；构建有 `check-bundle-secrets` 门禁                                                          |
| **图标只有一个图形源**       | 别改 `scripts/icons/` 的派生逻辑，换图标就换 `build/classhelper.{png,ico}`                                   |
| **前端不写死颜色**           | 深色主题靠语义令牌，写死的颜色在深色下会露馅                                                                 |

## 本地开发

```bash
pnpm install
cp packages/server/.env.example packages/server/.env   # 至少改 JWT_SECRET
pnpm db:generate && pnpm --filter @classhelper/server db:deploy
pnpm build:shared        # 必须先构建 shared，否则后续全部 ERR_MODULE_NOT_FOUND
pnpm db:seed             # 演示数据（会清空业务表）
pnpm dev                 # shared watch + 后端 4000 + Web 端 5173
```

常用命令与端口见[安装服务端](../get-started/server.md)；验收脚本见[验收与测试](testing.md)。
