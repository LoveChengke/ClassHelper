# AGENTS.md — ClassHelper（Class Helper）

本文件写给在本仓库里干活的 AI 编码代理。先读这里，再动代码。
文中「本机环境」「已知坑」两节按**实测**写成；若与本机现状不符，以本机实测为准并顺手改掉这里。

---

## 1. 这是什么

班级信息管理系统，**pnpm monorepo**，一份代码产出多个交付物：

| 交付物               | 位置                          | 形态                                                                           |
| -------------------- | ----------------------------- | ------------------------------------------------------------------------------ |
| 后端服务             | `packages/server`             | Express 5 + Prisma 7 + Socket.IO，`/api` 前缀                                  |
| Web 管理端           | `packages/web-admin`          | Vue 3 + Vite + Element Plus（教师/管理员用，PWA 可安装）                       |
| 桌面客户端           | `packages/desktop-client`     | Electron + Vue 3（学生用，含「灵动岛」浮窗）                                   |
| 共享契约             | `packages/shared`             | 三端共用的类型 / 常量 / 权限 / 工具函数                                        |
| ClassIsland 联动插件 | `packages/classisland-plugin` | .NET 8 / C#（装在教室的 ClassIsland 上：上报课表与上课状态、弹出老师发的提醒） |

核心链路：

```
教师在 Web 端发布内容
        │  REST API（JWT 鉴权）
        ▼
   后端服务（Express + Prisma）
        │  写库 + 按班级房间广播
        ▼
 Socket.IO ──► class:{classId} 房间 ──► 学生桌面客户端实时更新 UI

ClassIsland（教室机器）──► ClassHelper 联动插件 ──► /api/integrations/classisland/*（设备令牌鉴权）
                                   ▲                                  │
                                   └──── 老师下发的提醒（上报返回值里顺带带回）◄┘
```

- 远端：`LoveChengke/ClassHelper`（仓库名大小写不敏感，本地 remote 存的是小写 `classhelper.git`）
- 默认分支：`master`
- 语言：**文档、注释、提交信息、界面文案一律中文**

---

## 2. 目录速查

```
package.json                 根脚本（dev / build / db:* / verify:* / dist:* / icons）
pnpm-workspace.yaml          workspace + allowBuilds（pnpm 11 依赖构建白名单，勿随手删条目）
tsconfig.base.json           共享 TS 基础配置（ESM + NodeNext + strict）
eslint.config.mjs            ESLint 扁平配置（TS + Vue）；ignores 含 releases/ / release-server/ / src/generated/
.prettierrc.json             单引号 / printWidth 110 / trailingComma all / LF / 2 空格
build/classhelper.{png,ico}   图标源（**设计导出、手工放入**；`pnpm icons` 从它派生其余全部图标，见 §5 第 62 条）
scripts/
  use-database.mjs           SQLite ⇄ MySQL 切换（**改写 schema.prisma 里的 provider**，没有第二份 schema）
  generate-icons.mjs         启动 Electron 跑 icons/render.cjs（= `pnpm icons`）
  icons/render.cjs           把 classhelper.png 重采样成各端图标（CommonJS，见 §5 第 62 条）
  dist-server.mjs            服务端 + Web 管理端打包（产物落在 releases/server/<版本>/）
  nsis/server-installer.nsi  服务端 NSIS 安装脚本
  verify-packaged.mjs        对**打包后/已安装**的客户端 EXE 复跑冒烟
  check-icons.mjs            图标注册表静态门禁（漏注册会静默渲染空白，见 §5 第 53 条）
  version.mjs                版本号单一来源的读写与一致性校验（= `pnpm version:*`，见 §4.4）
  ui-smoke/{run,main.cjs,live-probe.mjs}  Web 管理端真实点击回归（Electron 驱动）
  lib/{electron-env,node-runtime}.mjs     启动 Electron / 定位真实 node.exe
deploy/                      Dockerfile / docker-compose{,.sqlite}.yml / nginx.conf / package.runtime.json
                             install.sh（Linux 一键安装器，TUI）/ install-linux.sh（转发壳）
                             classhelper（运维命令本体）/ verify-linux.sh（Linux 验收，自统计 N/N）
                             tools/admin-cli.mjs（离线改密 / SQLite 一致性快照）
                             profile.d/ logrotate.d/ systemd/（装到 /etc 的模板）
                             Dockerfile.linux-package（安装包内那份，--mode docker 用）
                             classhelper.service（systemd 模板，5 个占位符）/ .env{,.sqlite}.example
docs/                        **文档站**（docfx 项目；不进 pnpm workspace）
                             ⚠ 与官网（website/）共用**同一个** GitHub Pages 站点：官网在根、
                               文档站在 /docs/ 下。一个仓库在 Pages 上只有一个站点，
                               拼装由 scripts/build-pages.mjs 完成，见 §4.4「官网与文档站怎么发布」。
                             docfx.json / toc.yml（顶栏）+ 各章节自己的 toc.yml（侧栏）
                             get-started/ app/ management/ dev/（四章内容）
                             management/{production,linux-deploy,mysql}.md（部署与换库）
                             dev/winisland-design-tokens.md
                             images/（**展示图**：文档站 / README / 官网共用的同一份，1× 逻辑像素）
                             screenshots/（回归留档的截图：island / client / web-mobile / classisland，
                                          页面不展示；两者分工见 docs/dev/testing.md「截图留档」）
                             templates/classhelper/（模板覆盖：_master.tmpl + public/main.css + 图标）
                             build.mjs（构建，注入版本号与 404 的 base）/ serve.mjs（本地预览 :5181）
                             _site/（构建产物，gitignored）
                             ⚠ 站点的顶栏版本徽标取自根 package.json（build.mjs 用 --metadata 注入），
                               不要在文档里再写一份版本号。
                             ⚠ 页面里的照片一律指向 images/ —— 它就是 README 与官网吃的那一份。
                               别再往 screenshots/ 引图：那是冒烟脚本滚动的留档，随时被下一次验证覆盖。
                             ⚠ 模板目录里的 logo.png / favicon.png 由 `pnpm icons` 派生（见 §5 第 62 条），
                               别手工替换；改图标只改 build/classhelper.png 再跑 pnpm icons。
                             ⚠ 文档站只发布 docs/ 这一棵树，页面里**不要**写指向 docs/ 之外的相对链接
                               （如 ../AGENTS.md）—— 发布出去全是 404，要用 GitHub 的绝对 URL。
website/                     产品官网（**纯静态、无构建步骤**，不进 pnpm workspace）
                             index.html（门面）/ download.html（下载页，首页的「立即下载」跳到它）
                             assets/{styles.css,motion.js,main.js,download.js,icon.png,shots/}
                             serve.mjs（本地预览）/ tools/capture-shots.mjs（实机图采集）
                             404.html（**站点根** 404，含 {{BASE}} 占位符，由 build-pages.mjs 注入）
                             ⚠ serve.mjs 把 ../docs/_site 挂在 /docs/ 下，为的是让本地与线上同形 ——
                               否则页脚那几个「文档站」链接在本地全是 404。文档站得先 pnpm docs:build。
                             ⚠ 首屏标题第二行是 .reveal-grad：**它不参与逐字揭示**
                               （main.js 会跳过它）。拆成 per-char 的 inline-block 后每个字各自建一层合成，
                               祖先的 background-clip: text 就穿不过去，渐变会整行失效。
                             ⚠ assets/motion.js 是动效层：曲线与弹簧 token 逐条取自 beUI
                               （beui.dev/components/motion，见 docs/reference.md 的「官网」一节）。
                               改官网动效请改 token 表，不要在组件里另写 duration / cubic-bezier。
                             ⚠ assets/shots/ 里全是**跑起来截的**实机图，重采集步骤见
                               docs/dev/testing.md 的「截图留档」；客户端那两张要配合冒烟的
                               ELECTRON_CLIENT_SHOTS_DIR / ELECTRON_SMOKE_ISLAND_* 开关。
                             ⚠ download.html 的版本清单是**当场**读 GitHub Releases 的
                               （assets/download.js）：版本分段控件 → 一行状态 → 「装什么」分段控件
                               （客户端 / 服务端 / 插件，**默认停在客户端**）→ 卡片。卡片是拉到数据之后
                               才建的，建完会派发一次 ch:content，由 main.js 补挂按压反馈
                               （新增动态内容照这个来）。两个分段控件共用同一套指示器实现。
                               卡片排版照 ClassIsland 官网那页：图标 + 名称 + 系统要求 + 主按钮 + 变体下拉
                               （<details>，点别处或 Esc 收起）；插件那张只有一个文件，不摆点不开的箭头。
                               读不到时退回 <meta name="ch-version"> 并按发布命名约定拼直链 ——
                               那个 meta 是 version.mjs 的落点之一，发版必须一起改。
                               命名约定与 README「开始使用」表里那三个名字要对齐
                               （ClassHelper-<版本>-x64-client-setup.exe / -client-portable.exe /
                               -x64-server-setup.exe），它们是离线兜底链接的唯一依据。
packages/shared/src/         types.ts / constants.ts / permissions.ts / motion.ts / utils.ts / index.ts
packages/server/
  prisma/schema.prisma       数据模型（16 个 model，无 enum、无 @db.*；连接串在 prisma.config.ts）
  prisma/migrations/         16 个迁移（到 add_schedule_source 为止是旧模型；之后 6 个是
                             2026-10-06 的角色与权限重构：add_student_table / add_student_grade_query /
                             add_grade_level / add_classhelper_heartbeat / add_archives / add_term_weeks）
  prisma/seed.ts             种子数据（会清空业务表后重建演示数据）
  prisma.config.ts           Prisma 7 配置：schema / migrations / seed / 连接串
  scripts/verify-e2e.mjs     后端端到端验收（条数由脚本统计，2026-10-06 实测 205 项）
  scripts/verify-classisland.mjs        联动链路验收（实测 44 项）
  scripts/apply-column-migrations.cjs  旧库补列（手工覆盖 dist 部署时用）
  src/app.ts                 Express 装配（探针 → 限流 → 模块挂载 → 静态托管 → 兜底）
  src/index.ts               启动入口（自检 + HTTP + Socket.IO + 优雅退出）
  src/config/env.ts          zod 环境变量校验 + 生产自检
  src/lib/                   access(RBAC) class-account db db-bootstrap http jwt logger mappers
                             password schemas session term version(读 package.json) web-static
  src/middleware/            auth validate error security
  src/realtime/              socket.ts（房间）+ bus.ts（事件总线）
  src/modules/               17 个功能模块 + registry.ts + module.types.ts
                             （含 archives 毕业归档、term 学期周次）
packages/web-admin/src/      api stores router layouts views(14) components(5) composables styles config.ts
                             （含 ArchivesView 毕业归档、TermWeeksView 学期周次）
packages/desktop-client/
  src/main/                  主进程：index / config（含作业短语与看板偏好）/ ipc / island / tray / update / logger / smoke
  src/preload/               contextBridge 白名单桥（index.ts + island.ts，**不暴露 ipcRenderer 本体**）
  src/island/                灵动岛渲染进程：IslandApp.vue / spring.ts / squircle.ts / main.ts
  src/renderer/              ClassHelper 班级端渲染进程：api / cache(IndexedDB) / stores / views / island / router
  src/types/desktop.d.ts     主进程 ↔ 渲染进程契约
  scripts/                   build-main / dev / smoke / dist-win
packages/classisland-plugin/ .NET 8 插件（独立于 pnpm workspace，不参与 pnpm install）
  manifest.yml               清单：id=classhelper.classisland.bridge / apiVersion=2.0.0.0 / version=1.2.0.0
  ClassHelper.ClassIslandPlugin.csproj（TargetFramework=net8.0）
  src/Plugin.cs              入口：读配置 → 注册提醒提供方 / 设置页 / BridgeService
  src/Models/PluginSettings.cs
  src/Services/              BridgeService（上报·接收·镜像）/ ScheduleMapper / ClassPlanWriter
                             ClassHelperNotificationProvider（把提醒显示到 ClassIsland 上）
  src/Views/BridgeSettingsPage.axaml(.cs)：Avalonia 设置页
  src/Interop/ClassHelperClient.cs：HTTP 客户端 + 与服务端逐个字段对齐的 DTO
  scripts/                   build.mjs（编译 / 打包 .cipx）/ verify.mjs（静态契约校验，实测 74 项）
```

---

## 3. 本机环境（2026-09-30 实测）

| 项               | 状态                                                                                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node             | **v24.19.0**（`D:\nodejs\node.exe`；要求 ≥ 20.19，Prisma 7 硬性要求）                                                                                                      |
| pnpm             | 11.8.0（`packageManager` 锁定 11.8.0），宿主就是上面这个 node                                                                                                              |
| npm registry     | `https://registry.npmjs.org/`（仓库内无 `.npmrc`，取全局配置）                                                                                                             |
| 依赖             | 已装（707 包，`pnpm install` 实测 2m45s）                                                                                                                                  |
| 后端 `.env`      | 已由 `.env.example` 生成（**gitignored**），`JWT_SECRET` 为本机随机值，`TERM_START_DATE=2026-09-07`                                                                        |
| Prisma Client    | 已生成到 `packages/server/src/generated/prisma`（gitignored）                                                                                                              |
| 数据库           | SQLite `packages/server/prisma/dev.db`：10 个迁移已应用、种子已写入（用户 18 / 班级 3 / 课程 54 / 课表 93 / 作业 15 / 通知 12 / 成绩 90）                                  |
| `shared/dist`    | 已构建（`pnpm build:shared`）—— **它是三端与 seed 的前置产物，缺了会 `ERR_MODULE_NOT_FOUND`**                                                                              |
| Electron 二进制  | 已手动装好（`node_modules/.pnpm/electron@44.3.0/node_modules/electron/dist/electron.exe`，246 MB）                                                                         |
| .NET SDK         | ✅ **8.0.425**（`C:\Program Files\dotnet\sdk`，`dotnet --list-sdks` 有输出）⇒ 插件可编译/打包；**别再照旧文档说"没装"**（`dotnet` 在 PATH 里，`--list-sdks` 才是权威判据） |
| ClassIsland      | **2.1.0.1，装在 `D:\Classisland`**（启动器 `D:\Classisland\ClassIsland.exe`，实际进程 `D:\Classisland\app-2.1.0.1-0\ClassIsland.Desktop.exe`）                             |
| ClassIsland 数据 | 数据根 **`D:\Classisland\data`**：`Config/`、`Profiles/`、`Plugins/`（当前为空，尚未装本插件）、`Logs/`、`Cache/`、`Settings.json`                                         |
| 桌面会话         | 有（`ClassIsland.Desktop.exe` 跑在 session 1）；**Electron GUI 在 AI 会话里也能跑**（需先修完整性标签，见 §7 第 7 条）                                                     |

> **旧文档里的 `F:\classisland` / `F:\data` 已失效**：本机只有 `C:` 与 `D:`，`F:` 盘不存在。
> 另有一份旧副本在 `C:\Users\胡\Desktop\classisland`（数据在它自己的 `data/` 下，2026-09-18 用过），当前以 `D:\Classisland` 为准。

### 从零重建环境（本机实测可行的顺序）

```bash
pnpm install                     # 需要下载 Electron 时加 NODE_OPTIONS=--use-system-ca

# 后端环境变量（.env 不入库，必须自己生成）
cp packages/server/.env.example packages/server/.env   # 至少改 JWT_SECRET；TERM_START_DATE 建议 2026-09-07

pnpm db:generate                                       # 生成 Prisma Client
pnpm --filter @classhelper/server db:deploy            # 应用迁移（根 scripts 里没有 db:deploy，见 §7）
pnpm build:shared                                      # 必须先构建 shared，否则 seed / 服务端启动会失败
pnpm db:seed                                           # 写演示数据

# Electron 二进制不会随 pnpm install 下载，需要手动补：
#   工作目录 node_modules/.pnpm/electron@44.3.0/node_modules/electron
ELECTRON_MIRROR=https://cdn.npmmirror.com/binaries/electron/ node install.js

# ClassIsland 插件（.NET 8 SDK 已装：8.0.425）
pnpm build:classisland-plugin
```

### 演示账号（`pnpm db:seed` 产出）

| 角色           | 用户名                          | 密码         |
| -------------- | ------------------------------- | ------------ |
| 管理员         | `admin`                         | `admin123`   |
| 教师           | `teacher1` / `teacher2`         | `teacher123` |
| ClassHelper 班级端班级账号 | 班级码 `G101` / `G102` / `G203` | `123456`     |

> 密码是**种子脚本里硬编码**的（`admin123` / `teacher123` / 班级 `123456`）；
> `.env` 的 `DEFAULT_CLASS_PASSWORD` 只影响**新建**班级时的初始班级密码。
>
> **学生不是账号**（2026-10-06 起由表结构保证）：`Student` 表里根本没有 `passwordHash` / `role`，
> 学号（`202601`…`202615`）只是名单记录与查询键。拿学号去 `/auth/login` 只会得到 401。
> 教室机器统一用**班级码 + 班级密码**登录（会话主体是班级，角色 `CLASS_DEVICE`）。
>
> 演示数据布局：在读班级 `2026级1班`（码 `G101`）/ `2026级2班`（码 `G102`）/ `2025级3班`（码 `G203`），
> 外加一个**已归档**的 `2023级1班`（3 名毕业生，用于验证「毕业归档」页）。
> 任课关系刻意让**语文**由另一位老师任教，这样班主任在语文上没有编辑权 ——
> 正好覆盖「班主任不自动拥有所有科目作业成绩编辑权」这条规则。

---

## 4. 常用命令

| 命令                                                      | 说明                                                                                                  |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `pnpm dev`                                                | 并行启动 shared(tsc watch) + 后端(4000) + Web 端(5173)                                                |
| `pnpm dev:server` / `pnpm dev:web`                        | 只启动后端 / 只启动 Web 端                                                                            |
| `pnpm dev:desktop`                                        | 客户端开发模式（Vite 5174 + Electron，热更新）                                                        |
| `pnpm build`                                              | 构建 shared + 后端 + Web 端 + 客户端                                                                  |
| `pnpm build:shared`                                       | 只构建 shared（改完 `packages/shared` 必须跑）                                                        |
| `pnpm build:desktop`                                      | 只构建客户端（esbuild 主进程/preload + Vite 渲染进程）                                                |
| `pnpm build:classisland-plugin`                           | 构建 ClassIsland 联动插件（.NET 8；缓存/临时目录自动指到 `.cache/`）                                  |
| `pnpm dist:classisland-plugin`                            | 打包插件为 `.cipx` 并归集到 `releases/classisland-plugin/<版本>/`                                     |
| `pnpm typecheck`                                          | 全仓库类型检查（含 `vue-tsc`）                                                                        |
| `pnpm lint` / `pnpm lint:fix`                             | ESLint                                                                                                |
| `pnpm check:icons`                                        | 图标注册表门禁（两端 build 已内联，这里可单独跑；见 §5 第 53 条）                                     |
| `pnpm format` / `pnpm format:check`                       | Prettier（`format:check` 在 master 基线上本就失败，见 §7 第 21 条）                                   |
| `pnpm db:generate`                                        | 生成 Prisma Client                                                                                    |
| `pnpm db:migrate`                                         | `prisma migrate dev`（本机不可靠，别用；见 §7）                                                       |
| `pnpm --filter @classhelper/server db:deploy`             | 应用已有迁移（**本机推荐**；根 scripts 里没有 `db:deploy`）                                           |
| `pnpm db:seed` / `pnpm db:reset`                          | 写种子 / 重置并重播种子                                                                               |
| `pnpm db:studio`                                          | Prisma Studio                                                                                         |
| `pnpm db:switch:mysql` / `db:switch:sqlite`               | 改写 `schema.prisma` 的 provider（配合 `docs/management/mysql.md`）                                              |
| `pnpm verify:e2e`                                         | 后端端到端验收（**需后端已启动**；2026-10-06 实测 205 项全过）                                        |
| `pnpm verify:web`                                         | Web 管理端真实点击回归（Electron 驱动，需后端已启动且 Web 产物已构建）                                |
| `pnpm verify:desktop`                                     | 客户端冒烟（Electron，无人工点击）                                                                    |
| `pnpm verify:packaged`                                    | 对**打包后/已安装**的客户端 EXE 跑同一套冒烟（`--exe` 指定路径）                                      |
| `pnpm verify:classisland`                                 | ClassIsland 联动链路（设备令牌 / 上报 / 提醒下发与回执 / 镜像契约 / 幽灵行清理；实测 44 项）          |
| `pnpm verify:classisland-plugin`                          | 插件静态契约校验（清单一致性 / 注册完整性 / C# DTO ↔ 服务端 zod 与路由 / 已修复坑的护栏；实测 74 项） |
| `pnpm dist:server` / `dist:win` / `dist:dir` / `dist:all` | 打包服务端安装程序 / 客户端安装包 / 免安装目录 / 全部                                                 |
| `pnpm dist:server:linux`                                  | 打包 **Linux 服务端安装包**（`classhelper-server-linux-x64-<版本>.tar.gz` + `.sha256`）—— 见 §5 第 59 条 |
| `pnpm icons`                                              | 从 `build/classhelper.png` 派生全部图标（PWA / favicon / 托盘 / 安装包 / 插件 / 官网 / 文档站 / 界面内品牌标） |
| `pnpm version:check`                                      | 逐处列出并比对 14 个落点的版本号，不一致即 exit 1（见 §4.4「版本迭代」）                              |
| `pnpm version:bump patch\|minor\|major`                   | **改版本号的唯一入口**：一次改写全部 14 处（含插件清单、C# 里的常量、官网上手写的三处，以及下载页的兜底值） |
| `pnpm docs:build`                                         | 构建文档站到 `docs/_site`（需要 .NET SDK 8 + `dotnet tool install -g docfx`）                         |
| `pnpm docs:serve`                                         | 构建文档站并起本地预览 → http://127.0.0.1:5181                                                        |
| `pnpm docs:check`                                         | 构建文档站并把 docfx 的警告当错误（发布前用；最常见的警告是"某个 .md 没被任何 toc.yml 引用"）          |
| `pnpm pages:build`                                        | 把官网（根）与文档站（/docs/）拼成一份 GitHub Pages 产物到 `.cache/pages`（CI 用；见 §4.4）           |
| `pnpm dev:site`                                           | 构建文档站后起官网预览 → http://127.0.0.1:5180（文档站挂在同端口的 /docs/ 下，与线上同形）            |

### 端口

| 端口 | 用途                                                      |
| ---- | --------------------------------------------------------- |
| 4000 | 后端 REST + Socket.IO + （生产/构建后）Web 管理端静态托管 |
| 5173 | Web 管理端开发服务器（`/api`、`/socket.io` 代理到 4000）  |
| 5174 | 桌面客户端渲染进程开发服务器                              |
| 5180 | 官网本地预览（`node website/serve.mjs`）                  |
| 5181 | 文档站本地预览（`pnpm docs:serve`）                       |

### 交付产物归集

**三个打包脚本都直接输出到仓库根 `releases/<组件>/<版本>/`，没有中间输出目录**
（该目录 gitignore + eslint ignore），人工归集这一步已经取消：

```
releases/
  client/<版本>/
    安装包/      ClassHelper-<版本>-x64-setup.exe / -portable.exe（+ .blockmap）
    免安装/      electron-builder 的 win-unpacked 内容
    构建中间/    builder-*.yml、*.nsis.7z
  server/<版本>/
    安装包/      ClassHelper 服务端-<版本>-x64-setup.exe
    免安装/      classhelper-server 免安装目录（含 .env、node.exe、data/、logs/）
    linux-x64/   classhelper-server-linux-x64-<版本>.tar.gz + .sha256 + 同内容解包目录
    构建中间/    server-installer.generated.nsi
  classisland-plugin/<版本>/
    安装包/      ClassHelper.ClassIslandPlugin.cipx
    免安装/      ClassHelper.ClassIslandPlugin/（解压即用，丢进 Plugins 目录即可加载）
    checksums.md
  SHA256SUMS-<版本>.txt    跨组件哈希清单（人读，由发布流程维护）
```

版本号取自根 `package.json`（插件用 `manifest.yml` 的前三段，与产品版本对齐）；
重新打包只清**当前版本目录**里的产物，历史版本原样保留 —— 所以同版本多次构建留下的
不同产物要自己改名归档（例如 `1.0.0-重构建20261005/`），别把上一次的覆盖掉。

```bash
pnpm dist:server          # 服务端 Windows（首次会跑一次 npm install；重试可加 --reuse-deps 跳过）
pnpm dist:server:linux    # Linux 安装包（**必须在 Linux 上跑**，见 §5 第 59 条 ④）
pnpm dist:win             # 客户端：安装包 + 免安装目录；dist:dir 只出免安装目录
pnpm dist:classisland-plugin
```

`dist-win.mjs` 用 `--config.directories.output` 覆盖 electron-builder 自己的输出目录，打包成功后
再把原始布局整理成上面的分层（`win-unpacked/` → `免安装/`、`*.exe` → `安装包/`、`*.yml` → `构建中间/`）；
显式传 `-c.directories.output=<路径>` 时不再覆盖，整理以传入路径为准。
**交付物的完整性标签修正（§7 第 7 条）也挂在这条收尾链路上，别把 `tidyArtifacts` 之后的
`normalizeIntegrityLabel(destDir)` 拆掉。**

### 版本迭代（每一次 releases，不是每一次提交）

> **版本号按「发布」迭代，不按「提交」迭代。** 日常的 `feat` / `fix` 提交不动版本号；
> 只有要产出一批安装包、在 GitHub 上开一个 Release 时才走一次。
> 理由很实际：安装包名、`.cipx`、Docker 镜像 tag、文档站顶栏的版本徽标、更新检查接口
> 全都按版本号对齐 —— 每次提交都动它，等于每天都在发版，用户那边的「检查更新」就废了。
>
> 算一次发布：攒够一批功能 / 修好一个用户能感知的 bug / 要给别人一份新安装包。
> 不算：改注释、改文档、重构、加测试。

**同一个版本号写在 14 处（12 个文件）里**（5 份 `package.json`、`deploy/package.runtime.json`、
两个 `docker-compose*.yml` 的镜像 tag、插件 `manifest.yml`、插件 C# 里的 `PluginVersion` 常量、
官网首页上三处手写值，以及下载页 `<meta name="ch-version">` 那个兜底值）。
手工改必然漏一处，而漏掉的那处**不会报错** —— 只会在某个不常走的分支上表现为"版本号对不上"
（官网那三处的后果是首页一直挂着旧版本号；下载页那一处的后果是离线访客点到一串不存在的直链）。
所以**改版本号的唯一入口是脚本**：

```bash
pnpm version:check              # 逐处列出并比对，不一致 exit 1（默认就是检查模式）
pnpm version:bump patch         # 1.1.2 → 1.1.3（另有 minor / major）
pnpm version:check              # 再确认一次
```

`scripts/version.mjs` 按表逐个改写，**任何一处没匹配到或匹配到多处就直接失败退出**，
不做"尽力而为"的部分改写。

插件版本是**四段** `x.y.z.0`：前三段跟产品版本走，第 4 段留给"只改插件、不动产品版本"的补丁发布。
`--bump` / `--set` 会把第 4 段归零；要单独发插件补丁就手工改清单与 `BridgeService.cs` 那两处。

#### 一次完整发布的命令序列

```bash
# ① 改版本号
pnpm version:check && pnpm version:bump patch

# ② 本地体检
pnpm lint && pnpm typecheck && pnpm check:icons && pnpm docs:check

# ③ 跑验收（另开一个终端跑着 pnpm dev:server）
pnpm verify:e2e
pnpm verify:classisland
pnpm verify:classisland-plugin
pnpm build:desktop && pnpm verify:desktop
pnpm build && pnpm verify:web

# ④ 打安装包（产物落在 releases/<组件>/<版本>/）
pnpm dist:all
pnpm verify:packaged --exe "releases/client/<版本>/免安装/ClassHelper.exe"

# ⑤ 整理跨组件哈希清单 releases/SHA256SUMS-<版本>.txt（人读；Linux 那一行由 CI 合并进来）
# ⑥ 提交并推上去
git add -A && git commit -m "chore(release): <版本>" && git push origin master

# ⑦ 开 Release（gh release create 会创建并推送 tag，从而触发 Linux 包的 CI；见下）
gh release create v<版本> --title "v<版本>" --generate-notes
gh release upload v<版本> \
  releases/client/<版本>/安装包/*.exe \
  releases/classisland-plugin/<版本>/安装包/*.cipx \
  releases/server/<版本>/安装包/*.exe \
  releases/SHA256SUMS-<版本>.txt --clobber
```

> **上传前把三个 EXE 改成 ASCII 名。** 构建产物是中文名（客户端 `ClassHelper-<版本>-x64-setup.exe`
> / `-x64-portable.exe`，服务端 `ClassHelper 服务端-<版本>-x64-setup.exe`），而 Release 上的名字
> 是给别人看、要贴进脚本的 —— 一律用 ASCII 形式，与构建产物一一对应（内容相同、sha256 相同）：
>
> | 构建产物                    | Release 上的名字                            |
> | --------------------------- | ------------------------------------------- |
> | `<客户端>-x64-setup.exe`    | `ClassHelper-<版本>-x64-client-setup.exe`    |
> | `<客户端>-x64-portable.exe` | `ClassHelper-<版本>-x64-client-portable.exe` |
> | `<服务端>-x64-setup.exe`    | `ClassHelper-<版本>-x64-server-setup.exe`    |
>
> **这三个名字是外部契约**：README 的「开始使用」表、官网下载页的离线兜底直链都按它们拼 ——
> 改名要三处一起改。上传前改名比上传后 `gh release edit` 省事：
>
> ```bash
> V=<版本>
> mkdir -p .cache/release-staging
> cp "releases/client/$V/安装包/"*-x64-setup.exe    ".cache/release-staging/ClassHelper-$V-x64-client-setup.exe"
> cp "releases/client/$V/安装包/"*-x64-portable.exe ".cache/release-staging/ClassHelper-$V-x64-client-portable.exe"
> cp "releases/server/$V/安装包/"*-x64-setup.exe    ".cache/release-staging/ClassHelper-$V-x64-server-setup.exe"
> cp "releases/classisland-plugin/$V/安装包/ClassHelper.ClassIslandPlugin.cipx" .cache/release-staging/
> gh release upload v$V .cache/release-staging/* "releases/SHA256SUMS-$V.txt" --clobber
> ```

**第 ⑦ 步的顺序有讲究**：`.github/workflows/release-linux-server.yml` 由 tag 推送触发，
它在**最后一步**才把自己的那一行**合并进** Release 上已有的 `SHA256SUMS-<版本>.txt`
（`grep -v` 掉旧的 linux 行再追加，Windows / 插件那几行原样保留）。
所以本地那份清单必须**先上传**；万一手速反了，重跑一次就能补回来：

```bash
gh workflow run release-linux-server.yml -f tag=v<版本> -f attach=true
```

**Linux 包只能在 Linux 上构建**（`@libsql/linux-x64-gnu` 这类依赖是平台相关的），
所以 `pnpm dist:all` 里没有它，必须走 CI（见 §5 第 59 条）。

**已发布的版本号不要复用**：客户端把它记进「忽略此版本」，两端各有 30 分钟缓存 ——
同号换内容会让「检查更新」永久失灵。要修就 `pnpm version:bump patch` 发新号。

#### 官网与文档站怎么发布

**不用做任何事。** 推 master 时只要 `website/**`、`docs/**`、`scripts/build-pages.mjs` 或
`package.json` 变过，`.github/workflows/pages.yml` 就会构建并部署到 GitHub Pages：

```
https://lovechengke.github.io/ClassHelper/          ← 官网（website/，纯静态无构建）
https://lovechengke.github.io/ClassHelper/download.html   ← 下载页（同一棵树里的一个页面）
https://lovechengke.github.io/ClassHelper/docs/     ← 文档站（docfx 构建 docs/）
```

> **一个仓库在 GitHub Pages 上只有一个站点**，所以两者是拼在一起发的
> （`scripts/build-pages.mjs` 把 `website/` 放到根、`docs/_site/` 放到 `docs/` 下）。
> 官网在根是因为产品页的地址最短最好分享；文档站多一层路径没有代价。
> 改这个布局要同时动三处：`scripts/build-pages.mjs`、本 workflow 里的 `DOCS_BASE`，
> 以及文档站模板 `docs/templates/classhelper/layout/_master.tmpl` 里那个 `{{_rel}}../` 的「官网」入口。

- 顶栏的版本徽标取自根 `package.json`（`docs/build.mjs` 用 `--metadata _chVersion=…` 注入），
  **不要在文档里再写一份版本号**；官网首页那排芯片里的 `v1.1.2` 与下载页的
  `<meta name="ch-version">` 是手写的，发版时要一起改（都在 `pnpm version:bump` 的 14 个落点里）；
- 下载页的版本清单**不在站点里存副本**：每次打开都由 `assets/download.js` 当场读
  GitHub Releases（匿名接口 60 次/小时/IP），读不到才退回上面那个 meta 按发布命名约定拼直链。
  所以发完 Release 不用重新部署这一页，但**兜底值必须跟着发版改**；
- 首次启用需要在仓库 Settings → Pages 把 Source 选成「GitHub Actions」（只需一次）；
- 404 页的 `<base>` 由 `scripts/build-pages.mjs`（本地 `./`）与 workflow（CI 传 `/<仓库名>/`）注入 ——
  项目页挂在 `/<仓库名>/` 子路径下，而浏览器是按**被请求的路径**解析 404 页里的相对链接的；
- 本地预览：`pnpm dev:site`（官网在 http://127.0.0.1:5180，文档站挂在同一个端口的 `/docs/` 下，
  与线上同形）；只想单独看文档站用 `pnpm docs:serve`。

---

## 5. 架构硬约定（改代码前必须知道）

1. **模块注册表是唯一入口。** 服务端每个功能是 `src/modules/<name>/`（`*.module.ts` 路由、
   `*.schemas.ts` zod 校验、`*.service.ts` 业务）。当前 17 个：`auth / classes / courses / schedules /
homeworks / notifications / calls / imports / integrations / grades / students / teachers / archives /
term / dashboard / database / update`。
   新增/下线功能**只改 `src/modules/registry.ts`**（加一行 / 改 `enabled: false`），不要动 `app.ts`。
2. **统一响应与校验。** 用 `src/lib/http.ts` 的 `sendOk / sendCreated / …` 返回，用
   `middleware/validate.ts` 挂 zod schema；错误交给 `middleware/error.ts`，不要各写一套。
3. **鉴权 = JWT + RBAC + 班级内角色。** 路由级用 `requireRole('ADMIN', 'TEACHER')`；班级维度用
   `@classhelper/shared` 的 `resolveClassRole` → `ADMIN / HEAD（班主任）/ SUBJECT（科任）/
   CLASS_DEVICE（班级端）/ NONE`，权限判 `canManageSchedule` / `canPublishNotification` /
   `canManageRoster` / `canManageGrades` / `canManageSubjectContent` 等
   （人类可读矩阵是 `PERMISSION_MATRIX`），**不要在页面里另写一套规则**。
4. **学生不是账号 —— 这是表结构保证的，别在代码里"兼容"学生账号。**
   `Student` 表没有 `passwordHash` / `role`，学生不能登录、没有任何密码接口；
   学号（`Student.studentNo`）是学生的唯一标识与查询键（名单 / 成绩 / 作业提交 / 导入导出全用它）。
   曾经那套"`User.role='STUDENT'` + 空串密码占位 + 登录前判 role 再 403"的写法在 2026-10-06
   整体删除，**不要再加回来**：任何 `role === 'STUDENT'` 的分支都是回归。
5. **任课关系的唯一来源是 `Course`（班级 + 科目 + 教师）。** 没有第二张任课表
   （历史上那张无科目的 `ClassTeacher` 已删除）。作业与成绩的写权限必须走
   **`assertCanManageSubjectContent(user, classId, courseId, action, { allowClassDevice })`**：
   挂了科目就只能由该科的任课老师改，没挂科目则归班主任 / 管理员；
   班级端只有**作业**可以写（成绩不给）。**新增"发布内容"类入口必须复用它**，否则又会出现
   "某个页面能改别人的科目"。
6. **共享契约只在 `packages/shared`。** 三端都 `import ... from '@classhelper/shared'`；它产出 `dist`，
   改完要 `pnpm build:shared`（或跑着 `pnpm dev` 的 watch）。类型/常量**不要在两端各写一份**。
7. **数据模型跨库通用。** `schema.prisma` 只用 String / Int / Float / Boolean / DateTime，不用 Prisma enum、
   不用 `@db.*`；角色与优先级存字符串并在 API 层用 zod 校验（这样 SQLite / MySQL 行为一致）。
   **只有一份 `schema.prisma`**：切库是改写它的 `provider`（`pnpm db:switch:mysql`），没有 `schema.mysql.prisma`。
   改模型要同步 `prisma/migrations/`（本机用 `pnpm --filter @classhelper/server db:deploy` 应用）。
8. **周次口径唯一。** 当前教学周 = `shared.resolveCurrentWeek(TERM_START_DATE, now, MAX_TERM_WEEK)`，
   `MAX_TERM_WEEK = 30`，班级还有自己的 `Class.termWeeks`（默认 20，**上限也是 30**）。别在别处重新实现周次换算。
   周次上限三处必须一致：`MAX_TERM_WEEK`、`lib/schemas.ts` 的 `weekNumberSchema`、`classes.schemas.ts` 的 `termWeeks`
   （曾经班级能设到 40 而课表只到 30，等于对外承诺了系统兑现不了的学期长度）。
   `Class.termWeeks` 只有**管理员**能改（`assertCanManageClasses`），班主任不行。
9. **Electron 安全边界。** `src/preload/` 只通过 contextBridge 暴露白名单方法，**不要暴露 `ipcRenderer` 本体**；
   主进程 ↔ 渲染进程的类型统一写在 `src/types/desktop.d.ts`。

   **跨桥接只能传纯数据。** contextBridge 在参数跨越「主窗口 → 隔离世界」时就做结构化克隆，
   传 Vue 的 `ref.value` / `reactive()` 对象（Proxy）会抛 `An object could not be cloned.`——
   而且它在**进入 preload 函数体之前**就失败了，所以桥接层**无法兜底**，只能由调用方展开成
   字面量再传（`saveConfig({ island: { ...island.value } })`）。这类失败是"半静默"的：
   界面数字照常变化、只多一行 console error，看起来就是"设置不生效"。设置页曾因此翻车，
   `verify:desktop` 里的「设置页真实 UI：拖拽滑块即时改变灵动岛外观」就是为它加的回归。

10. **客户端离线优先。** 渲染进程数据先落 IndexedDB（`renderer/cache/`），断网回退缓存并在顶部提示离线；
    新增页面/数据源要按这个模式接。
11. **Web 端设计令牌集中。** 圆角/投影写在 `packages/web-admin/src/styles/index.css` 的 `:root`
    （`--ch-radius-xl/lg/md/sm/pill`、`--ch-shadow-sm/md`），组件里**不要写死数值**；Element Plus 通过覆盖它的
    CSS 变量对齐。手机小屏（≤768px）用抽屉导航 + 卡片内横向滚动，新增页面沿用 `useResponsive.ts` + `.table-card`。
12. **ClassIsland 联动是独立鉴权通道，不要塞进 JWT。** 插件用设备令牌（`X-ClassIsland-Token`，库里只存 sha256，
    明文前缀为 `chci_`）调 `/api/integrations/classisland/*`；Web 端管理设备仍走 JWT + `requireRole`。
    新增插件接口时，路由挂 `integrations.module.ts`，并在 `integrations.schemas.ts` 里写 zod —— 插件侧的 C# DTO
    必须**逐字段对齐**（`pnpm verify:classisland-plugin` 会校验字段名与路由）。
13. **课表镜像契约必须带 `startTime`/`endTime`。** ClassIsland 的 `ClassPlan.Classes[i]` 强制与时间表里
    **第 i 个 `TimeType == 0`（上课）的时间点**对齐：镜像下发少一个时间点，整份课表就会错位，
    而且表现为"课表看着有内容、每节课都对不上"，极难排查。
14. **所有发布入口共用同一份 ClassIsland 推送实现**（`integrations.service.ts` 的 `pushToClassIsland`）：
    通知发布 / 叫人 / 联动页的下发都走它。新增「发通知」类入口时**必须**复用，不要再各写一套 ——
    否则又会出现「某个页面发的通知不联动 ClassIsland」。
15. **提醒弹在哪个端由教室客户端选**，值存在 `Class.notificationChannel`（`both` / `client` / `classisland`）：
    客户端设置页写它（班级账号也有写权限，见 `PATCH /api/classes/:id/notification-channel`），
    服务端据此决定是否推 ClassIsland（`shouldPushToClassIsland`）。改动这条链路要同时动三处：
    客户端设置页与本地配置、`lib/mappers` 的 DTO、服务端推送判断。
16. **灵动岛的左右边距只在「左/右停靠」时生效**：默认是「顶部居中」，水平锚点就是屏幕中线，
    此时调 marginX 不会有任何变化（设置页会把滑块置灰并说明，别把这个提示删掉 ——
    用户就是因此以为「调了不生效」）。上下边距与所有停靠位置都相关，不受影响。
17. **镜像进 ClassIsland 的课表要带课间**：每两节之间补一段（上一节下课 → 下一节上课），
    **最后一节之后不补**（放学）。实现见 `ClassPlanWriter.BuildTimeLayout`（自己按课目时间算），
    服务端合成节次时间表同口径。
18. **提醒分两类，决定"上课时段弹不弹"**：`ClassIslandPush.kind` = `notification`（通知类，上课时段
    客户端与插件都**暂存**、下课补弹）/`call`（叫人，算「主动通知」，立刻弹）；紧急（`URGENT`）同样立刻弹。
    插件侧的实现在 `ClassHelperNotificationProvider`（`_deferred` + `FlushDeferred`，订阅课程事件），
    客户端的实现在 `renderer/island/bridge.ts`。改这条规则要两端一起改。
19. **作业按「所属日期」归类，不要用 createdAt 当"哪一天"**：`Homework.assignDate` 是本地日期
    （`YYYY-MM-DD`，不带时区），按天查看 / 日期高亮 / 客户端"今天"都看它。
    UTC 切片（`toISOString().slice(0,10)`）在晚上的录入会算到第二天 —— 统一用 `@classhelper/shared` 的
    `dayKeyLocal / isDayKey / shiftDayKey`。新增按天接口时同样用 `?date=YYYY-MM-DD` + zod 的 `isDayKey` 校验。
20. **教室机器能录入作业**：`POST /homeworks` 的路由**故意不加 `requireRole`**，权限在
    `homeworks.service.createHomework` 里判（staff 或本班班级账号）。班级账号的 `sub` 是**班级 id**，
    写 `createdBy` 前要换成该班班主任，否则撞 `User` 外键。
21. **灵动岛不要用窗口背景材质（`win.setBackgroundMaterial()`）**。它看起来像 WinIsland 的
    `DWMWA_USE_HOSTBACKDROPBRUSH`，其实是**整窗系统材质**：刷在整个窗口矩形上（岛是"固定大包围盒窗口"，
    卡片之外还有留白），且明暗跟随应用主题（本客户端是浅色 Fluent 主题 ⇒ 材质必然是浅色），
    于是卡片周围会出现一圈浅色"白底面板"。更坑的是**调用过一次就再也回不去逐像素透明**
    （含 `'none'`：Electron 会让窗口回落到默认不透明底色 `#FFF`），所以从 `glass` 切到
    `black`/`tinted` 后会永久留一圈**纯白**。CSS `backdrop-filter` 也替代不了（透明窗口里采样不到桌面）。
    `glass` 因此用 CSS 半透明深色卡（WinIsland 无 backdrop 时的降级色 `rgba(32,32,36,.804)`）。
    回归用例：「个性设置：卡片外圈透出桌面（三种风格都没有白底面板）」—— 它**整屏截图**取样
    （`webContents.capturePage()` 拍不到窗口之后的材质，是当初漏掉这个 bug 的原因），
    并在岛底下垫一块已知颜色的底板窗口，好让"环 = 底板色"可以被精确断言。
22. **灵动岛位置由「屏幕工作区 + 边距」算，默认边距 8px（`DEFAULT_ISLAND_APPEARANCE.marginX/marginY`）**：
    改默认值会直接改外观，`verify:desktop` 的「停靠位置生效（6 个锚点）」断言的是像素坐标，一动就红。
    新增边距类设置请只改"可调范围"，别动默认值（夹紧规则收口在主进程 `normalizeIslandAppearance`）。
23. **课表行有"来源"字段 `Schedule.source`**（`manual` / `classisland`）。插件每次全量上报时，
    服务端只清理「`source='classisland'` 且本次未再上报」的行 —— 这样老师在 ClassIsland 里删掉/挪动一节
    能真正同步下来（原先 merge 只 upsert，服务端会永远留着幽灵课），**老师在小助手这边手排的课一律不删**。
    因此：**新增写课表的入口要显式定 source**（Web 端录入/导入保持默认 `manual`，只有插件上报用 `classisland`），
    否则要么幽灵课清不掉，要么手排的课被误删。回归用例见 `verify:classisland` 的「幽灵行清理」两条。
    **`source` 只在 create 时确定，update 一律保持原值。** merge 的去重键是「星期 + 开始时间 + 单双周」，
    老师在 Web 端手排的同一时间槽会被上报"收养"；若收养时把来源改成 `classisland`，
    下一次清理就会把这行手排的课删掉 —— 这个坑踩过一次：种子课表被删掉 2 行，
    `verify:e2e` 的「上课状态接口」用例（AGENTS.md §7 已列为脆弱用例）随即报红。
    同步时**不要**覆盖 `weekStart/weekEnd`：插件上报契约里没有周次范围，硬写"整学期"会把老师设的「第 1~10 周」抹掉。
24. **两个登录入口都必须挂 `loginRateLimiter()`**（`app.ts` 用数组形式同时挂 `/auth/login` 与 `/auth/class-login`）。
    班级密码默认是 `123456`、班级码是固定字符集，班级登录曾是唯一没有暴力破解防护的入口。
    另外 `auth.service.login` 里**角色判定必须在密码校验之前**：否则"密码错(401) / 密码对但学生账号已停用(403)"
    的差异会把学生账号密码变成可离线验证的预言机。
25. **凡是会渲染成链接的字段都要校验 scheme。** `Homework.attachmentUrl` 在服务端用
    `attachmentUrlSchema`（只允许 `http(s)://` 或 `/` 开头的站内相对路径），Web 端渲染前再兜一层
    （`HomeworksView.vue` 的 `attachmentHref`）。放行 `javascript:` / `data:text/html` 就是一条存储型 XSS。
26. **桌面端必须保留 CSP**（`index.html` / `island.html` 的 `meta http-equiv="Content-Security-Policy"`）。
    渲染进程通过 preload 能拿到 `getConfig()` 的**明文 token**（代表全班身份），CSP 是唯一能拦住
    "加载并执行远程脚本"的一层。配套的两条导航防线也别删：主窗口 `isAllowedNavigation`（按同源/同一文件精确比对，
    不要退回 `startsWith`）、灵动岛窗口的 `setWindowOpenHandler` + `will-navigate` 全拒。

27. **桌面端产物里不得出现任何凭据，构建有门禁。** `dist/main/index.js` 与 `dist/renderer/assets/*.js`
    会被 electron-builder 打进 `app.asar` 发给每台学生机，而 asar 可直接解包
    （历史问题：冒烟/自检代码里写死了 `teacher1/teacher123`，`grep` 产物即命中）。
    冒烟与自检用的账号口令、班级码/班级密码**一律通过环境变量注入**
    （`ELECTRON_SMOKE_USER` / `ELECTRON_SMOKE_PASSWORD` / `ELECTRON_SMOKE_CLASS_CODE` / `..._CLASS_PASSWORD`）：
    preload 读环境变量 → `window.desktop.smokeCredentials` → `setSmokeTeacherCredentials()`，
    由 `scripts/smoke.mjs` 与 `scripts/verify-packaged.mjs` 提供（那两个脚本不进安装包）。
    **把静态 import 改成 `await import('./smoke.js')` 解决不了这个问题**：esbuild 在
    `format:'cjs'` + `bundle:true` 下不做代码分割，动态 import 同样被内联进同一个产物（已实测）。
    `pnpm build:desktop` 结尾会跑 `check-bundle-secrets`（`packages/desktop-client/scripts/check-bundle-secrets.mjs`），
    产物里出现种子口令/把种子班级码当凭据的写法即构建失败 —— 别把这条门禁摘掉。
28. **表格导入的体积上限是"请求体 12MB ↔ 文件 8MB"**：文件以 base64 放进 JSON（约 4/3 倍），
    因此 `express.json({ limit: '12mb' })` 必须留够余量，否则声明了 8MB 却连 1.5MB 的文件都传不进来。
    超限由 `middleware/error.ts` 映射成 413 `IMPORT_TOO_LARGE`（**不要**让它落进 500 兜底分支：
    原先用户看到的是一句英文的「服务器内部错误：request entity too large」）。
29. **删除类接口的护栏要与 schema 的级联关系对齐。** `deleteTeacher` 的检查项必须覆盖
    `Class.teacherId` / `Course.teacherId` / `ClassTeacher.teacherId` / `Homework.createdBy` /
    `Notification.createdBy` 五项（后两项曾经漏检，会静默删掉该教师在各班发过的作业与通知；
    回归用例见 `verify:e2e` 的「删除教师护栏覆盖"发布过作业/通知"的账号」）。
    **改 schema 时先看哪些外键指向 `User` 且是 Cascade，再回来核对这个清单。**
30. **灵动岛在触摸屏上必须走「触摸模式」（`touchMode`）。** 打开命中的两条链路
    （渲染进程的 mousemove 转发、主进程读 `screen.getCursorScreenPoint()`）**都以"鼠标指针移动"
    为前提**，而手指触摸既不产生 mousemove、也不移动系统光标 ⇒ 窗口永远停在
    `setIgnoreMouseEvents(true)` 的穿透态，**手指点不开岛**（用户反馈：希沃白板）。
    触摸屏上唯一的解法是"触摸点处窗口可命中"：Electron 没有 `SetWindowRgn`，
    所以渲染进程按 `navigator.maxTouchPoints > 0` 上报（`island:set-touch-mode`）后，
    主进程把窗口**贴合岛体**（`windowBox` = 当前形态 + 2×阴影留白）并**始终接收输入**
    （`setInteractive` 在触摸模式下把入参强制为 true）。三条护栏别动：

- **窗口可见期间只增不减**：`syncTouchLayout()` 里 `if (shrinking && this.win.isVisible()) return;`
  —— 需要变小一律等窗口隐藏之后再做（`syncWindow()` 的"不可见时对齐包围盒"那条）。立刻缩小既会裁掉
  形变中的卡片，又会因为 DWM 还没重画桌面而留下上一帧（用户拍照反馈过"收回一瞬间闪一下"）；
  （注：`cardFitsFormSize()` 这个"按岛体矩形判断能不能缩"的旧判据**已无调用**，别再照它理解现状。）
- `expectedHitRect` 必须按**窗口实际尺寸**算偏移（触摸模式下窗口不再是固定包围盒）；
- 失焦宽限期用 `BLUR_GRACE_TOUCH_MS`（1200ms）：触摸没有光标，`isCursorOnIsland()` 恒为 false，
  而实测假失焦出现在 70~520ms（跨过 500ms 边界 ⇒ 会把刚展开的岛缩回胶囊）。
  非触摸屏机器**完全不走这条路**（窗口仍是固定大包围盒 + 按光标命中），
  `verify:desktop` 会先 `setTouchMode(false)` 再跑既有的光标注入用例，末尾单独断言触摸模式。

31. **"改密码"的入口只剩 Web 管理端两处，客户端一个都没有。** 教师/管理员改本人密码走
    Web 顶栏下拉（`PATCH /api/auth/password`）；班级密码由管理员在「班级管理 → 修改班级账号」
    （`PATCH /classes/:id/class-account`）维护；教师设指定新密码用
    `POST /teachers/:id/reset-password`（可选 `newPassword`，留空 = 默认初始密码）。
    **2026-10-01 起学生个人账号整体清理**：学生只是名单（成绩/未交/叫人/已读按名单记录），
    `POST /students/:id/reset-password` 已删除（调用返回 404，e2e 有负断言）、新建学生不设密码
    （`User.passwordHash` 空串占位，`STUDENT` 的 403 登录判定在密码校验之前）、
    `DEFAULT_STUDENT_PASSWORD` 已删；客户端设置页的「修改密码」按钮**是按用户要求主动移除的**
    （防教室机器误改班级密码）——别当成"丢入口"的回归补回来。
32. **灵动岛卡片的投影（CSS `filter`）必须常驻，形态切换只能改参数。**
    不要把 `filter: drop-shadow(...)` 只挂在 `.island-card.expanded` 上：**给元素增删 CSS filter**
    会让 Chromium 新建/销毁它的渲染表面（effect node），首帧的合成可能早于新表面栅格化完成，
    那一帧被当成空内容画出去 —— 而**卡片的底色恰好画在这个被过滤的元素上**（`.shape path` 的 `fill`），
    于是开/合的那一瞬间底座会闪掉一帧、只剩未过滤的文字层（用户反馈的"开合时一瞬间的闪动"）。
    正确写法见 `IslandApp.vue` 的 `.shape path`：filter 常驻，胶囊态用 `0 0 0` 的退化投影
    （硬轮廓正好压在路径底下，肉眼等同无投影，与 WinIsland「只有展开态有投影」的观感一致）。
    回归用例：`verify:desktop` / `verify:packaged` 的「灵动岛任意形态的投影都常驻」。

33. **多条通知时展开是「竖排列表」，卡片高度由主进程与渲染进程**各算一次同一个数**。**
    `@classhelper/shared` 的 `islandListLayout()`（度量表 `ISLAND_LIST_METRICS`）是唯一算法：
    默认只显示 `defaultVisibleRows`（3）条 + `展开更多（还有 N 条）`，按重要程度排序
    （`PRIORITY_RANK`，同级按时间新的在前）；点"展开更多"后铺到 `maxCardHeight` 为止，
    仍然放不下的改成「更多请前往应用内操作」——`maxCardHeight` 是主进程按工作区/任务栏算出的可用高度，
    随状态下发。两条硬约束：
    - **窗口包围盒必须跟着列表长高**（`IslandApp.vue` 的列表比任何普通形态都高，窗口不够高会把底部按钮裁掉）；
      长高发生在卡片形变**之前**（`setState` 里先 `relayout()` 再 `emit()`），用户看不到这一步；
    - 列表态 CSS 的每个尺寸（行高/行距/内边距/标题行/提示行/按钮行）都要与那份度量**一一对应**，
      改 CSS 必须改常量，否则"最后一行被切掉"这类问题会以"看着有内容、按钮点不到"的形式出现。
      回归用例：`verify:desktop` 的「多条通知竖向排列…」「点展开更多…」「通知多到屏幕放不下…」。
      写这类用例时注意：**断言"单条卡片"的用例（紧急卡/叫人卡/截图比例）必须先 `drainIsland()` 排空队列**，
      否则量到的是列表高度。

34. **"知道了 / 标为已读"之后是「状态同步落地 + 窗口淡出」，没有跨进程的收回握手。**
    收起一律是**主进程单向**的：`handleAction()` 收到 `dismiss` / `dismiss-all` / `mark-read` /
    `mark-all-read` → `dismissActive()`（还有下一条则退胶囊）或 `clearPendingForClose()`
    → `hide()` → `fadeOut()`（每帧 `setOpacity(-0.2)`，到 0.02 后 `win.hide()`）。
    状态在**同一帧就写成** `hidden` / 清空，**不等渲染进程任何回执** —— 调用方与冒烟按"同步语义"断言
    （`island.ts` 的 `clearPendingForClose()` 注释：「状态同步落地（渲染进程随之收起卡片，窗口由 `hide()` 淡出）」）。
    渲染进程那侧只有本地弹簧形变（`spring.ts` 的 `targetSize/progress`），是纯视觉动画，不参与淡出时机。

    **曾经有过一层自研的"收回快照"动画，已按用户要求整体删除。** 它叫 `closing` / `closingSnapshot`：
    点"知道了"后把卡片按"胶囊摘要"收回再淡出，是自研的形变状态机，**实测在触摸屏上会露出旧帧/重影**
    （触摸模式窗口贴合岛体、卡片形变时窗口跟着动），用户明确要求"动画就用仓库里那套"，于是整段删掉 ——
    现状见 `IslandApp.vue` 顶部注释。**别照着一份不存在的握手机制去改代码。**
    （`smoke.ts` 里"收回动画是渲染进程收敛上报 → 主进程淡出"只是一句过时注释，代码里没有这条链路。）

    多条通知时这两个按钮都是**整批**操作：`dismiss-all` / `mark-all-read`（作业卡的合成 id
    `homework-<id>` 要在主进程按 kind 过滤掉，否则通知中心会去查一条不存在的通知 ——
    见 `handleAction()` 里 `mark-all-read` 分支的 `.filter((item) => item.kind !== 'homework')`）。
    回归用例：`verify:desktop` 的「多条通知点「知道了」：整批关闭（状态同步清空，窗口淡出隐藏）」。

    排查"收回时闪一下"这类反馈时注意：**先看是不是自动化验证实例的叠影**（见第 41、42 条），
    别往这套已经不存在的握手机制上找原因。

35. **本机录入的作业不再上灵动岛。** 服务端是**先广播 `homework:new`、后回响应**的，
    等响应拿到 id 再登记就晚了（事件可能已经到了、岛已经弹出来了）——所以
    `renderer/island/bridge.ts` 在**发请求之前**按内容登记指纹（班级 + 日期 + 标题 + 正文），
    回执拿到 id 后再补记一次，投递前用 id / 指纹双重判定。改作业录入入口时别忘了在请求前调
    `markHomeworkCreatedLocally()`。回归用例：「本机录入的作业不再上灵动岛」。

36. **触摸模式下收回动画期间，窗口必须一动不动**（窗口可见期间一律不缩窗口，见 `syncTouchLayout()`）。
    触摸模式窗口是"贴合岛体"的，而收回时卡片正在缩小：若跟着缩窗口，**中心停靠下窗口 x 还要右移**，
    "让出去"的那块区域会留着上一帧（DWM 还没重画桌面）——同一帧里能看到"旧展开卡的左半截 + 新胶囊"
    两份画面（用户拍照反馈的"收回一瞬间闪一下"）。窗口尺寸一律等**隐藏之后**再对齐
    （`syncWindow` 里"不可见时对齐包围盒"那条，不可见时改尺寸不会有残影）。
    回归用例：「触摸模式收回：动画期间窗口不动」逐帧采样窗口矩形（只在"窗口可见 / 正在收回"时追究，
    收完隐藏后对齐尺寸是正常的）；「收回动画期间卡片不被窗口裁切」。
    另：**别再去代码里找 `closing` 或 `cardFitsFormSize()`** —— 自研的那层"收回快照"（§5 第 34 条已说明
    整体删除）与"按岛体矩形判断能否缩小"这个旧判据都已不在调用链上，最终判据只有上面那条
    `shrinking && isVisible` 早退。"隐藏态改边距不生效"则是由 `setAppearance()` 无条件 `relayout()`
    加 `applyWindowLayout()` 的"矩形没变就不调 setBounds"守卫保证的，同样不需要额外的可见性判断。

37. **开合时胶囊内容禁止跟着卡片重排/横移。** 卡片在 268 ⇄ 424 之间变宽变窄，中心停靠下左右边都在动；
    胶囊内容若按卡片宽度布局，就会出现"文字先按宽卡片铺开、再随卡片收窄被省略号收回"
    （用户反馈的"新消息那行字往右跳一下再缩回"）。所以 `IslandApp.vue` 的胶囊层里套了一层
    `.pill-inner`，**固定成胶囊自己的几何**（`width: var(--island-w)`），并按停靠方式对齐
    （`data-anchor` = left/center/right → `justify-content` flex-start/center/flex-end）：
    左/右停靠贴对应边，居中则居中 —— 静止态外观与之前完全一致，动画全程文字位置与省略号都不变。
    回归用例：「灵动岛开合时胶囊内容不横移」，逐帧采样 `.pill-title` 左右边缘，波动必须 ≤ 2px。

38. **跑自动化验证时，验证实例的岛要挪到左上角 + 真实输入穿透。**
    `verify:desktop` / `verify:packaged` 会真的在屏幕上放一个灵动岛窗口（顶部居中），而用户自己的客户端
    默认也在同一位置（他的设置常是 `top-center` + 较大 `marginY`）—— 两个岛一高一低叠在一起，用户会以为
    **"屏幕上出现了第二个灵动岛"**，而且点它"反应不对"（它归验证脚本控制，会自己展开/收起/消失）。
    实测踩过：用户连续两条反馈（"收回去的时候闪一下/下半被截断"）其实都是这个叠影造成的。
    所以 `runIslandChecks` 开头把验证实例的岛做成**一眼可辨**：
    `island.setAppearance({ accent: '#e91e8c', style: 'tinted' })`（洋红 = 验证实例；跑完不必还原，
    验证用的是独立 profile），并且全程 `island.setTestInputPassthrough(true)` 让真实点击穿透。
    **只改颜色、不要改停靠位置**：命中/几何断言都是按默认位置写的，把岛挪到角落会把
    「空闲细缝态命中跟随光标」这类用例弄红（实测踩过）。
    另外：冒烟会**真发通知**给当前班级（实时链路用例必须打到客户端所在班），所以验证期间用户的通知列表/
    岛上会短暂出现几条「张老师 · _自检_」——它们用完即删（`createSmokeNotification` / `islandRealtimeCleanup`），
    若验证被中途 kill 会留下残条，收尾时顺手清一下（标题里带「自检 / 红点位置校验」的那几条）。

39. **冒烟期间要让真实鼠标点击穿透（`island.setTestInputPassthrough(true)`）。** 自动化要跑几分钟，
    而用户很可能正在同一块屏幕上 —— 他的客户端那个岛和冒烟这个窗口都在屏幕顶部居中、互相叠着，
    他点到的是**冒烟这个窗口**：实测冒烟收到了人发出的 `collapse` / `mark-read`，把「点胶囊展开」
    「点空白处收起」等用例整片弄红。开关只忽略**真实**输入：`cursorOverride`（`setHitTestCursor`）
    一旦注入就照常按注入位置判定，所以「光标轮询校正命中」「岛外穿透」「触摸模式始终接收输入」
    这些断言不受影响（触摸模式那条会临时关掉开关）。跑完在收尾处恢复。

40. **作业页的 `?date=` 深链必须在"已在作业页"时也生效。** `route.query.date` 只在组件 setup 里读
    一次的话，同路由再推 query（冒烟切到"最近有作业的日期"、用户从别处深链回来）会被复用的组件
    无视，看板停在原日期 —— 表现为"看板明明有历史作业却显示空"。修法是 watch `route.query.date`
    （`HomeworkView.vue`，与 `selectDate` 的 `router.replace` 形成环时靠"值相同就跳过"防死循环）。
    同理，冒烟里"切到有作业的日期"的判据是**看板里没有 `.board-card`**，不是"没有 `.board-host`"
    （空看板照样渲染容器，拿容器当判据兜底永远不会触发）。

41. **打包版冒烟自检发的通知要"任何时段都可见"**：用 `priority: 'URGENT'` + `confirmDuringClass: true`
    （上课时段普通通知会被**正确地**暂存到下课、紧急通知不带确认会被 409 `URGENT_DURING_CLASS` 拒掉 ——
    两个都是产品功能，别为了测试去改产品行为）。凡是断言"窗口已隐藏"的用例一律**轮询**等待，
    不要写死 sleep：`dismiss` 现在带 ~360ms 收回动画再淡出，机器忙时固定 sleep 会间歇性踩空
    （「关闭空闲细缝后空闲再次完全隐藏」曾因此 4 连红）。

42. **用户报"打包版用不了/装不上"先查两件事，别急着怀疑产物**（2026-10-01 实测，两次全是环境）：
    ① **后端起没起** —— 客户端配置指向 `127.0.0.1:4000`，后端不在就进离线模式、数据全空，
    观感就是"软件坏了"；② **托盘单实例锁** —— 关窗是隐藏到托盘、进程还在，再双击 EXE 会被
    单实例锁秒退（看起来"点了没反应"），安装包也会因"应用正在运行"装不上：先从托盘退出。
    完整性标签（§7 第 7 条）用 `icacls | findstr Mandatory` 一眼可辨，优先排除。

43. **Web 端新手引导（`el-tour`）在自动化里的判据有三条坑**（2026-10-02 实测，`verify:web`
    「首次登录展示新手引导且可跳过」踩过）：
    ① **外壳先出现、内容晚一拍** —— `document.querySelector('.el-tour')` 先于步骤卡片渲染成立，
    急着找 `.el-tour__closebtn` 会拿到 null；出现判据要等 **× 按钮渲染出来**（等 10s 不为过）。
    ② **关闭后内容元素残留** —— 和 el-dialog 一样（本表第 22 条），点 × 生效后 `.el-tour` 仍在 DOM
    （父级 `.el-popper` 被隐藏，computed display 仍是 block）；**关闭判据是 `.el-tour__mask` 卸载**，
    不是 `.el-tour` 消失。跳过 / 走完都会写 `classhelper.onboarding`（版本号），可顺带断言。
    ③ **全高元素（侧边栏）作锚点必须显式 `placement: 'right'`** —— 默认 bottom 会把卡片推到
    视口外（表现为"遮罩挖了洞、卡片不见了"）。
    另外 `ui-smoke` 管理员用例里的 `localStorage.clear()` 会把「已看过」标记一并清掉，管理员登录后
    引导会再次弹出 —— 该用例里必须先跳过它再继续，别只处理首次登录那一次。

44. **数据库管理模块（服务端）** 见 §5 第 36 条；做"切库/备份/迁移"类改动前先读那一条，
    那里写清了快照格式、外键陷阱、切换为什么必须走子进程、以及打包为何要带上 prisma CLI + tsc。

45. **客户端设置页已拆成子路由**（2026-10-02）：`/settings/{general,appearance,island,reminder,account,about}`，
    `/settings` 重定向到 `/settings/general`；旧的单一 `views/SettingsView.vue` **已删除**。
    改设置相关冒烟用例时必须改到对应子路由（`smoke.ts` 里 `location.hash = '#/settings'` 已全部改掉），
    否则会停在通用页、找不到灵动岛滑块或「ClassIsland 联动」卡片而误报失败。

46. **深色主题的实现边界**：颜色一律走 `--ch-*` / `--el-*` 变量（`styles/index.css` 的 `:root`
    是浅色值、`html.dark` 是深色值），**组件里不要写死颜色**。已知的固定深色区域（灵动岛、
    登录页、App 启动过渡页、全屏作业看板）刻意不随主题 —— 改它们会被当成回归。
    主题状态在 `stores/ui.ts`（持久化到主进程配置 `theme`），主窗口 `backgroundColor` 也按主题设置
    （深色下若仍用浅色底会"先白后黑"闪一下）。

    **两端都有深色主题，机制一致**（Web 管理端 2026-10-06 补齐）：`html.dark` + element-plus 的
    `dark/css-vars.css` + 两端各自的 `stores/ui.ts`。语义色令牌是
    `--ch-surface` / `--ch-surface-alt` / `--ch-surface-sunken` / `--ch-surface-hover` 与
    `--ch-text` / `-secondary` / `-muted` / `-placeholder`；**`html.dark` 只覆盖颜色，
    绝不覆盖圆角与动效令牌** —— 两套主题的几何必须完全一致，否则切换时会看到布局跳一下。
    Web 端还要一并同步 `<meta name="theme-color">` 与 `color-scheme`（后者管原生控件：
    滚动条、日期选择器弹层 —— 只改 CSS 变量的话它们仍是浅色）。
    默认**跟随系统**（`prefers-color-scheme`，系统改了就跟着变）；用户手动点过之后以用户为准。
    切换入口两端都在顶栏，都走 `useThemeReveal()`（见第 61 条）。
    改令牌时只改值 —— **不要对样式表跑批量 sed**，理由见第 61 条末尾。

47. **数据库管理模块（`/api/database/*`，仅 ADMIN）——改它之前必须知道的四件事**：
    ① **一切都建立在 `lib/snapshot.ts` 的 JSON 快照上**（备份 / 导入导出 / 跨库迁移共用一种格式，
    14 张表按拓扑序导出、恢复时临时关外键检查、分批 `createMany`）。恢复时**必须**先关外键检查：
    schema 里 `User.classId → Class` 与 `Class.teacherId → User` **互相引用**，任何排序都会被一侧卡死。
    ② **一键切换必须走子进程**：运行中的服务进程缓存的是旧方言的 Prisma Client，改完 provider 后
    只有**新进程**才能加载重新生成的客户端 —— 因此 `generate` / `db push` / 写数据分别用
    `spawn(process.execPath, ...)` 拉起（数据写入走 `dist/tools/apply-snapshot.js`）。
    **顺序不能换**：备份 → 导出 → 测试连接 → 校验目标库为空 → 改 schema → generate → 编译 → db push → 写数据 → 改 .env；
    `.env` 只在**全部成功后**才改写，中途失败回滚 `schema.prisma`（现有库不受影响）。
    ③ **`prisma generate` 的产物是 `.ts`**（`prisma-client` 生成器），所以：dev 由 tsx 直接跑 src；
    **打包形态必须再跑一次 `tsc -p tsconfig.generate.json`** 把新客户端编进 `dist/generated`，
    生产包因此要随包带上 `prisma` CLI、`typescript` 与 `schema.prisma`/`prisma.config.ts`
    （`scripts/dist-server.mjs` 的 `buildRuntime` 已拷；安装包 ~34MB → ~71MB）。
    ④ **主库只支持 SQLite / MySQL**：Redis 等键值库 Prisma 不支持（无法建表/迁移），
    schema 层直接 422 拒绝；这是产品口径，别"顺手"加上。
    e2e 只覆盖校验分支（同库 400 / 非法 provider 422 / 目标库非空），**不真跑切换**（会改写 .env）；
    真实切换用子进程链路单独实测（快照 728 行逐表一致）。切换后**必须重启服务端**才生效。

48. **客户端主窗口初始尺寸与 ClassIsland 对齐（1242×582）**。这个数不是拍的：用
    `GetWindowRect` + `DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)` 量运行中的
    `ClassIsland.Desktop` 主窗口（实测可视区 1242×582，屏幕工作区 1600×852、DPI 100%）。
    `main/index.ts` 的 `createWindow` 按它设 width/height + `center: true`，
    **`minHeight` 必须 ≤ 582**（否则窗口达不到目标高度，用户会看到"设置不了那个大小"）。
    冒烟断言：「初始窗口尺寸与 ClassIsland 对齐（1242x582）」（`win.getSize()`），改尺寸即红。

49. **侧栏是"一级项 + 一个设置分组"，折叠后是图标导轨 —— 五条硬要求**，都是用户报过的问题固化的：
    ① **菜单结构**：课表 / 作业 / 通知 / 成绩是**一级 `el-menu-item`**（2026-10-05 按用户要求把原来的
    「学习」分组拆掉：分组标题白占一行、还得多点一次展开，折叠成导轨时尤其明显）；只有「设置」
    保留 `el-sub-menu`（6 个子项平铺太长）。`layoutNavigationSelfTest` 里有断言盯着
    "一级项不能还挂在任何 `.el-sub-menu` 里"。
    ② **折叠是 CSS 收拢动画，不用 `el-menu` 的 `:collapse`** —— 那个 prop 会把每个分组的子项
    卸载进浮层（一次结构切换）并让整条菜单重排一遍：既做不出连续形变，也是"点汉堡卡一下"的渲染侧来源。
    现在折叠只做三件事：栏宽（`.aside` 的 `width` 过渡）、文字（`min-width:0` 让 flex 压得动 +
    `overflow:hidden` 裁切 + `opacity` 淡出）、图标位置（`padding-left` 过渡）。**全程没有结构变化、
    没有 `v-if` 增删**，导轨里分组标题与子项都以图标列出（**不再有悬停浮层**）。
    时长/缓动/图标-文字间距统一在 `styles/index.css` 的 `--nav-dur` / `--nav-ease` / `--nav-gap`。
    ③ **折叠态图标必须与顶部汉堡按钮同一竖列**（冒烟断言中心差 ≤ 2px，实测 11 个图标全 0.0px）。
    几何：64px 栏、菜单项左右各 8px margin、折叠后 padding 左右各 12px ⇒ 图标中心 = 8+12+12 = 32px
    = 64/2；汉堡靠 `padding-left: 18px` 位移到位（**不能用 `justify-content: center`**，它不可过渡）。
    ④ **导轨必须"一眼看全"，不许出现滚动**（用户要求"不要用滚轮、删掉滚动条"）：
    - 折叠态页脚要**把高度也收掉**（`.is-collapsed .aside-footer` 的 `max-height: 0` +
      **`min-height: 0`** —— flex 子项默认 `min-height: auto`，而 CSS 里 min-height 优先于 max-height，
      不显式归零就压不下去）。留着那 ~70px 的话，11 行图标（462px）在 540px 的最小窗口里放不下。
    - 导轨里用 `.is-collapsed .menu { scrollbar-width: none }` 隐藏滚动条；展开态**不隐藏** ——
      那一栏确实会超（设置组展开约 606px > 582px），滚动条是"下面还有内容"的唯一提示。
    - 冒烟断言「导轨无溢出」（先展开设置组造出 11 行的最坏情况，再断言 `scrollHeight ≤ clientHeight`）。
      ⑤ **折叠态文字不能"看得见"** —— 判据已从"没被布局"（老的 `display:none`）改成"看得见"
      （有宽度且未透明）：现在靠 `overflow:hidden` 裁切，文字仍参与布局。冒烟断言「文字残影=无」。
      （另：菜单区仍要 `min-height: 0` + `overflow-y: auto`，footer 是 aside 的兄弟 flex 子项，
      菜单区滚动后它恒定可见 —— 冒烟断言「侧栏底部可见」。）

    改折叠相关样式时的两个坑：
    - **压 Element Plus 的层级缩进必须照抄它的选择器形状**：EP 用**三个不同选择器**分别算
      「一级项 20px / 分组标题 20px / 分组内子项 40px」（特异度 0-4-0 / 0-4-0 / 0-5-0）：
      `.el-menu--vertical:not(.el-menu--collapse):not(.el-menu--popup-container) .el-menu-item`
      （把 `…__title`、以及多加一层 `.el-sub-menu` 的变体都算上）。写成
      `.ch-nav.is-collapsed .el-sub-menu__title` 这种 0-3-0 的一条都压不住 —— **踩过两次**：
      第一版漏了分组标题（偏 8.0px），把「学习」拆成一级项后又漏了一级项（同样偏 8.0px）。
      现在 `index.css` 里那两条（0-5-0 / 0-6-0）把三种形状全覆盖。
    - 图标与文字的间距放在**文字的 `margin-left`** 上，别用 EP 给图标挂的 `margin-right: 5px`
      （那会让图标在 24px 的槽里偏左 2.5px）。

    另：分组**默认只展开当前路由所在分组**（落在四个一级项上时一个都不展开）；
    `el-sub-menu__title` 的点击是 **toggle**，自动化里要先判"子项是否可见"再决定点不点标题
    （盲点会把已展开的组收起来，后续点不到子项）。

50. **深色主题：渲染进程里除固定深色区域外，颜色一律走 `--ch-*` 变量。**
    §5 第 46 条讲了机制，这里补具体踩坑：课表页时间轴卡片曾写死 `rgba(255, 255, 255, 0.6)`，
    深色主题下变成"浅灰卡 + 近白字"几乎不可读（用户截图）。自查命令：
    `grep -rn "rgba(255, 255, 255\|rgba(0, 0, 0\|#fff" packages/desktop-client/src/renderer`，
    除**明确固定深色**的区域（全屏作业看板、登录页渐变、App 启动过渡页、灵动岛自身、
    以及 accent 渐变底上的白字）外，都应该是变量。

51. **跑 `verify:desktop` / `verify:packaged` 若大面积报"教师登录失败"，先核对本机 teacher1 的密码**：
    本机实测是 **`123456`**，不是种子默认的 `teacher123` —— 因为「修改密码」弹窗留空会落到
    `DEFAULT_TEACHER_PASSWORD`（=123456），某次人工/脚本操作就会把演示账号改成它。
    处理方式是用环境变量传实际凭据（脚本原生支持，**不要去改数据**）：
    `set "ELECTRON_SMOKE_USER=teacher1" && set "ELECTRON_SMOKE_PASSWORD=123456" && pnpm verify:desktop`。

    **注意两个演示账号的口令不一定一起漂**（2026-10-04 实测）：本机 `teacher1 = 123456`、
    `teacher2` **仍是 `teacher123`**。因此 `verify:e2e`（口令硬编码、不支持环境变量）不能简单地
    全局替换 `teacher123` —— 那样 teacher2 会 401，直接挂掉 9 条科任老师用例。
    正确做法是**只替换 teacher1 那一行**的临时副本，跑完即删：

    ```bash
    sed "/username: 'teacher1'/s/'teacher123'/'123456'/" packages/server/scripts/verify-e2e.mjs \
      > packages/server/scripts/.verify-e2e-local.tmp.mjs
    node packages/server/scripts/.verify-e2e-local.tmp.mjs   # 副本必须放在 scripts/ 内
    rm packages/server/scripts/.verify-e2e-local.tmp.mjs
    ```

    副本**必须放在 `packages/server/scripts/` 里**（不能放 `.cache/`）：脚本要 `import 'socket.io-client'`，
    换个目录就 `ERR_MODULE_NOT_FOUND`。

52. **更新检查：三端共用一套版本口径，但检查路径与"失败即正常"是硬约束。**
    ① **版本号单一来源**：服务端版本由 `lib/version.ts` 读 package.json 得到
    （打包后读的是运行时清单，即 `dist-server.mjs` 用根 package.json 写的那个），
    `app.ts` 里**不要再写字面量版本号**（原先有三处 `'1.0.0'`，而仓库里有 5 份 package.json，必漂）。
    比较逻辑放 `@classhelper/shared` 的 `compareVersions` / `isNewerVersion`，三端共用。
    ② **检查路径不对称是 CSP 逼的，不是随手选的**：Web 端**不能**直连 GitHub
    （`securityHeaders()` 的 `connect-src` 只有 `'self'` / ws / CORS_ORIGIN），必须走
    `GET /api/update/check`；客户端在主进程直连 GitHub（渲染进程的 CSP 与导航防线不要为这个开洞）。
    ③ **`ok:false` 是设计内的结果**：机房与教室机器常常只有内网，离线/超时/限流一律收敛成
    `ok:false` + 一句人话，**失败结果同样进缓存**（否则断网点一次按钮就白等一个超时）。
    ④ **自动化里绝不查外网**：冒烟跳过启动自动检查，`verify:*` 的断言只验"结构完整 + 能降级"，
    断言"一定有新版本"会把用例绑死在外网可达上。`?force=1` 绕过缓存**只对管理员生效**，
    否则任意登录用户都能刷爆 GitHub 匿名限流（60 次/小时/IP）。

53. **Element Plus 图标按需注册，漏注册有构建门禁。** 两端都不再 `import * as ElementPlusIconsVue`
    全量注册 293 个图标（实测全量打包 minified 203KB，实际只用 22 / 33 个），而是各有一份
    `packages/web-admin/src/icons.ts` 与 `packages/desktop-client/src/renderer/icons.ts` 显式列名单。
    **不能改成"模板里逐个 import"**：本项目的图标是按**字符串名**引用的（菜单/路由配置里的
    `icon: 'Odometer'`、`:icon="'Search'"`、`<component :is="item.icon">`），Element Plus 会用
    `<component :is="'Odometer'">` 去解析**全局组件名**，图标必须以全局组件存在。
    漏注册的后果是**界面静默渲染成空白**（只在控制台一条 warning），所以在构建前加了静态门禁
    `scripts/check-icons.mjs`（已挂进两端 `build` 脚本，根上也可 `pnpm check:icons`）：
    它对比"源码里用到的图标 ∪"与"注册表里的名单"，有遗漏即 exit 1 并指出出现位置。
    新增视图时直接用图标名即可，忘了加进注册表会在构建阶段被拦下。

54. **服务端 dist 是运行产物，不带声明与 sourcemap。** `packages/server/tsconfig.build.json` 与
    `tsconfig.generate.json` 都显式关掉 `declaration / declarationMap / sourceMap` 并开 `removeComments`
    —— 根 `tsconfig.base.json` 默认是给"库"用的（三个都开），照搬到服务端会让 dist 从约 0.7MB
    膨胀到 3.8MB（其中 `.d.ts` 1.5MB + `.d.ts.map` 1.1MB + `.js.map` 0.5MB，全是运行时用不到的）。
    需要 sourcemap 调试时用 `tsconfig.json`（`noEmit`）即可。
    **`tsconfig.generate.json` 还必须是自包含的（不 extends 任何配置）**：它随包发布到安装目录的
    `server/` 一层，而 `tsconfig.json` / `tsconfig.base.json` 两级基配置都不在包里 —— 一旦 extends
    就会在打包形态下报 `TS5083 Cannot read file .../server/tsconfig.json`，数据库「一键切换」
    走到"编译新客户端"这一步直接失败（2026-10-05 实测踩到并修掉）。

55. **服务端安装包的体积靠"运行时裁剪"压，规则写在 `scripts/dist-server.mjs` 的 `pruneRuntime()`。**
    打包顺序是 `installDependencies() → buildRuntime() → pruneRuntime() → buildInstaller()`，
    裁剪在最后一份文件就位、打包之前做。当前四条规则与收益（实测删 2329 项 / 省 101MB）：

    | 规则                                                             | 省     | 依据（改之前先看这里）                                                                                                                |
    | ---------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------- |
    | `@prisma/client/runtime` 白名单，只留 sqlite/mysql 的 ESM 方言包 | 61.4MB | 生成的客户端按 **provider 写死**动态 import（`internal/class.ts`），换库重新 generate 只会指向对应方言；`_small_bg` 与 CJS 版永不加载 |
    | `node_modules/**/*.map`                                          | 19.0MB | Node 没开 `--enable-source-maps`                                                                                                      |
    | `prisma/build/` 只留 sqlite/mysql 查询编译器                     | 15.0MB | 部署形态里 CLI 只被用于 `generate` 与 `db push`                                                                                       |
    | 文档（保留 LICENSE/NOTICE）与测试/示例目录                       | 5.2MB  | 不会被 require                                                                                                                        |

    **两条硬护栏（都踩过）**：① 整棵 `@types/**` 不参与裁剪 —— 类型包里的 `test/`、`docs/` 是真实声明
    文件（`@types/node/test/reporters.d.ts` 被 `test.d.ts` 引用），按"测试目录"删掉会让数据库切换的
    `tsc` 报 TS6053；② 名字命中 `DROP_DIRS` 的目录，只要里面含 `*.d.ts` 就跳过。
    改完必须按下面的清单复验（尤其数据库管理模块，它是唯一会调 Prisma CLI 的地方）。

56. **`verify:classisland` 开头会先"抽干"本班的历史积压提醒。** `/integrations/classisland/pending`
    是「本班全部未确认提醒，按时间升序取**前 20 条**」，而 `verify:desktop` / `verify:web` 等冒烟会
    **真的往演示班发通知**（见 §5 第 38 条）——那些条没被确认就会一直堆着，攒够 20 条之后
    本脚本刚发的提醒会被挤出窗口，表现为「待提醒里找不到刚发的那条」，跟代码对不对毫无关系
    （2026-10-05 实测：库里积了 45 条历次冒烟残条，本脚本从 42/42 掉到 35/40）。
    现在脚本用 `drainPending()` 按**真实插件重连后的行为**（补弹并逐条确认）先清空，再开始断言，
    可见范围与插件一致（只看 `deviceId` 为空的本班广播 + 本设备自己的推送）。
    **别把这个 drain 删掉**，否则这个门禁会重新变成"跑几次就红"的随机失败。

57. **桌面端配置（`config.json`）是"常驻内存 + 异步合并落盘"，别再当成同步写。**
    `main/config.ts` 里配置**只读一次盘**（懒初始化），`getConfig()` / `saveConfig()` 之后一律走内存缓存
    （连已解密的 token 一起缓存，不再每次过一遍 DPAPI）；落盘改成"记下待写 → 120ms 合并窗口 →
    `fs.promises.writeFile`"，同一拍内的多次改动只写最后一次，多次写入之间串行、不会互相覆盖；
    退出前由 `flushConfigSync()`（挂在 `main/index.ts` 的 `shutdownResources()` 里）同步兜底写一次。

    **为什么必须这样**：侧栏折叠、主题切换、通知渠道、作业看板偏好、登录/登出**全都走 `saveConfig`**，
    而它原先一次调用要在**主进程主线程**上做「`readFileSync` + `JSON.parse` + 8 个 normalize」**两遍**
    （开头读一遍、结尾 `getConfig()` 又读一遍）+ `writeFileSync` + DPAPI 解密一遍 —— 主进程是 Electron 的
    消息泵进程，被它摁住的那一拍渲染进程也跟着掉帧。用户反馈的「点侧栏汉堡展开/收回时卡一下」
    就是这一拍（2026-10-05 定位并修掉；当时先误查到灵动岛，那块与它无关）。

    三条硬约束：
    ① **缓存必须懒初始化**：`main/index.ts` 会先 `app.setPath('userData', smokeProfile)` 再读配置，
    在模块顶层立即读盘会读错文件；
    ② **`saveConfig()` 返回时数据可能还没落盘**（最多晚 120ms）。要"读回刚存的值"一律用 `getConfig()`
    （读的就是缓存里的最新值），别去读文件；正常退出（托盘 → 退出）会 flush，只有进程被强杀才会丢
    最后 120ms 内的改动；
    ③ 别把落盘写成"每次保存挂一个 promise 链"—— 拖滑块/连点会排队几十次写。`clearConfig()`（退出登录）
    走 `immediate` 分支，不参与合并窗口。

58. **顶栏右侧（主题切换按钮 + 用户名下拉）必须是 flex 容器。** Element Plus 给 `.el-button` 的是
    `vertical-align: middle`、给 `.el-dropdown` 的是 `vertical-align: top` —— 两个 inline-level
    子元素放在普通 block 容器里会各按各的垂直对齐规则落位，错开几像素（用户反馈的"**深色模式没对齐**"，
    其实两种主题下都偏，只是深色下更显眼）。`.header-right` 必须写
    `display:flex; align-items:center; gap`，与 Web 管理端 `AdminLayout` 的同名容器同一套写法
    （那边一开始就是对的，桌面端当初漏了这条规则）。回归断言在 `layoutChromeSelfTest` 里：
    量主题按钮与 `.user-chip` 的**中线差**，要求 ≤ 1.5px（实测 0.0px）。

59. **Linux 交付链有六条硬约定**（`deploy/install.sh`、`deploy/classhelper`、`scripts/dist-server.mjs`
    的 `--platform linux`、`deploy/verify-linux.sh`）。改这条链路前先读这一节，每条都对应一个踩过的坑：

    ① **配置真身在 `/etc/classhelper/config.env`，安装目录里的 `.env` 必须是指向它的软链。**
    Web 端「数据库管理 → 一键切换」在运行中改写的是 **`<安装目录>/.env`**（`database.service.ts`），
    而 systemd 是通过 `EnvironmentFile=` 注入同一份配置的；dotenv 不覆盖已存在的环境变量，
    所以两处一旦不是同一个文件，切换就会**看起来成功、重启后又连回旧库**（极难排查）。
    权限同时满足"配置文件 600 / 配置目录 700"与服务进程可读写（属主给 `classhelper`）。
    `classhelper doctor` 里有专门一条断言盯着这条软链。

    ② **systemd 单元的 `ReadWritePaths` 必须同时包含安装目录与配置目录。**
    服务端不是只写 `data/`：一键切库会改写 `server/prisma/schema.prisma`、把新客户端编译进
    `server/dist/generated`，并改写 `config.env`。`ProtectSystem=full` 下不显式放行就会失败。
    占位符有 5 个：`__NODE__ __DIR__ __USER__ __CONFIG__ __CONFIGDIR__`（少替换一个，
    systemd 会拿字面量当路径）。

    ③ **升级/回滚替换程序文件必须用"改名 + 就位"，不能 `rm -rf` 再 `cp`。**
    升级时正在运行的就是 `bin/classhelper` 自己：先 `mv bin bin.old-…` 再放新目录，
    运行中的进程继续读旧 inode；直接删掉同名文件会让 bash 读到半个脚本（报莫名其妙的语法错误）。

    ④ **Linux 包只能在 Linux 上构建，产物名固定。** `@libsql/linux-x64-gnu`、`@prisma/adapter-libsql`
    是平台相关依赖，Windows 上装的 `node_modules` 拷过去跑不起来 ⇒ 由
    `.github/workflows/release-linux-server.yml`（ubuntu runner）出包。命名约定
    `classhelper-server-linux-<arch>-<版本>.tar.gz` + 同名 `.sha256`（旁边那份、以及 Release 里的
    `SHA256SUMS-<版本>.txt`），`classhelper upgrade` 按这个名字拼下载地址，**改名即断升级链路**。
    非 Linux 上 `--platform linux` 也能跑（会加 npm 的 `--os=linux --cpu=x64` 按目标平台解析依赖），
    但那是**应急**，已在 2026-10-05 实测核对过包内容：`@libsql/linux-x64-gnu`/`-musl` 就位、无 win32 残留、
    服务端与全部运维命令可用；**只有 Web 端「一键切换数据库」存疑** —— 那条链路要 prisma CLI 的原生
    schema engine，CLI 运行期按平台扫 `@prisma/engines/schema-engine-debian-openssl-3.0.x` 这类路径，
    而交叉包里只有 `schema-engine-windows.exe`。交叉构建会写入 `.cross-built` 标记，
    `classhelper doctor` 据此提示（别改成静默），`upgrade` 替换程序文件时会按新包有无该标记来增删。
    正式产物仍走 CI。**交叉构建时 `tar` 还有两个 Windows 专有坑**（`packLinuxTarball()`）：
    `-f F:\...tar.gz` 里的**盘符冒号**会被 GNU tar 当成 `主机:路径` 的远程归档写法，报
    `tar (child): Cannot connect to F: resolve failed`、退出码 2 —— 现象很误导：包已经整套铺好、
    就差最后打 tar 那一步失败。反斜杠还会被当成转义符。所以那一步把路径统一转成**正斜杠**
    并加 `--force-local`。该选项在 Linux 上无害（本地路径本来就该走本地分支），因此无条件加上、
    不做平台分支 —— **Linux 上路径没有盘符，这个坑在 CI 与真机上永远复现不了**，只在交叉构建时现形。

    ⑤ **密码永远走 stdin，命令行一律不接受密码；调用服务端模块的工具必须压掉它的 stdout 噪声。**
    `classhelper password` 用 `read -s` 优先读 `/dev/tty`、无 tty 回退 stdin（这样既能交互，
    也能被验收脚本用管道喂 —— 都不进 history/ps）。输入循环**必须有界**：stdin 结束时 `read`
    返回非 0，不看这个标记就会在 EOF 上死循环（`verify-linux.sh` 里有一条"不合规时不卡死"的回归）。
    写配置（`config set`）同理：值经临时文件传给 `awk`，不进 argv；敏感键强制交互输入，
    `key rotate` 自己生成的密钥走内部写函数。另外 `tools/admin-cli.mjs` 复用了服务端的
    `config/env.ts` 与 `lib/logger.ts`，**这两个模块会往 stdout 打日志**（dotenv 的
    `◇ injected env …` 提示、Prisma 初始化一行）—— 调它时必须带上
    `LOG_LEVEL=error DOTENV_CONFIG_QUIET=true`，否则 `dump-hash` 写出的"原哈希备份"里会多一行日志，
    变成非法 JSON，**改密失败自动回滚整条链路静默失效**（dotenv 不覆盖已有环境变量，所以这两个
    变量能生效，已实测）。

    ⑥ **内置 Node 要按 glibc 选构建。** Node 官方 linux-x64 二进制要求 glibc ≥ 2.28，
    CentOS 7 是 2.17 —— 装上去的表现为"服务起来就退出、日志什么都没有"。安装器检测 glibc，
    低于 2.28 时自动改用 unofficial-builds 的 `-glibc-217` 变体。CentOS 7 仍属尽力而为。

    两条写这类脚本时的通用坑（本仓库踩过）：**`set -e` 下 `[ cond ] && 可能失败的命令` 会
    在条件为假时……其实不会退出**（bash 对 `&&` 列表里非最后一条失败是豁免的），但
    `A && B` 里 B 失败、以及**用 `$(函数)` 捕获输出时把日志一起捕获**（所以安装器用全局
    `STAGE_DIR` 而不是 `echo` 返回路径）这两类是实打实的 bug；`die` 要先 `trap - ERR` 再退出，
    免得 ERR 钩子再补一句误导的"第 N 行执行失败"。

60. **安全响应头里的 `upgrade-insecure-requests` 与 HSTS 只能在 HTTPS 请求下下发**（`middleware/security.ts`
    的 `buildHelmet(httpsRequest)`，按 `req.secure` 二选一；TRUST_PROXY 开启时 `req.secure` 已含
    `x-forwarded-proto` 判断）。helmet 的默认 CSP **自带 `upgrade-insecure-requests`**，而安装器的
    默认形态是 `http://IP:端口` 直连（无 TLS）：这条指令会把页面**子资源**请求全部改写成 https 发出去，
    服务器没有 TLS 监听，全部连接失败 —— 表现为「管理端一片空白、标签页标题正常」
    （2026-10-05 用户在 98.142.241.144 实测踩到；`/healthz`、登录 API 都正常，纯浏览器侧的资产全灭）。
    HSTS 在明文响应里按规范会被浏览器忽略，但 CSP 指令没有这层豁免，所以两者都要跟着 https 走。
    开发时一直用 localhost（浏览器视为安全上下文、不做改写），所以这个坑在本地永远不复现，
    只有真机 http 直连部署才炸 —— 别因为"本地好好的"就把条件判断摘掉。

61. **动效层：令牌在 `packages/shared/src/motion.ts`，两端各一份组合式函数。**
    移植自 [beUI](https://beui.dev) 的 `lib/ease.ts`（它的组件是 React，用不了；动效语言与框架无关）。
    三组缓动 + 六组具名弹簧（`SPRING_PRESS/SWAP/PANEL/LAYOUT/MOUSE/GLIDE`）。

    - **令牌必须是纯常量**：`packages/shared` 被后端一起消费，它的 tsconfig 是 `lib: ["ES2023"]`
      （不含 DOM），所以 `motion.ts` 里不碰 `document` / `window` / vue。DOM 注入与 Vue 组合式函数
      在两端各自的 `composables/motion.ts`（两端各一份，与 `ScoreBarChart.vue` 同一做法）。
    - **CSS 变量在 `app.mount()` 之前由 JS 注入 `:root`**（两端 `main.ts` 调 `applyMotionTokens()`）。
      CSS 里只引用 `var(--ch-spring-*)`，**不要抄数值** —— 抄了必漂。
    - **弹簧靠数值积分生成 CSS `linear()`**，于是弹簧可以纯 CSS 驱动，不需要每组件一个 rAF 循环。
      算落定时间**不能用包络公式 `6/(ζ·ω0)`**：它只对欠阻尼成立，过阻尼要用较慢的实极点
      `ω0(ζ−√(ζ²−1))`，否则曲线会被截断在 0.87/0.95 上、元素永远差一截没到位（实测踩过）。
    - **`--ch-spring-X` 与 `--ch-spring-X-dur` 必须成对用**：`linear()` 是把 [0,1] 进度重映射，
      时长给短了等于把整条曲线等比压缩 —— 形状还在，但已经不是那组参数的手感了。
    - `linear()` 的进度值可以 >1（过冲）：只能用在不越界无害的属性上。**别用在 `opacity`**。

    **四条硬约束（都对应实测过的坑）**：

    - **路由层不要包 `<transition>`，尤其不要 `mode="out-in"`。** 它把"旧组件卸载、新组件挂载"推迟到
      退场动画结束（90ms 起），后果有两个：① 点菜单后有一小段时间页面上还是上一页，`ui-smoke` 的多条
      用例（"pathname 一变就找新页面的元素"）会整片判红 —— 实测一次掉 9 项；② 退场判定依赖
      `animationend`，**窗口被遮挡时 Chromium 冻结 CSS 动画**（实测 `document.timeline` 1.2 秒推进 0ms），
      事件永不触发 ⇒ 新页面永远不挂载，整个应用卡死在第一页。页面切换的动效改用 `.page > *` 错峰入场，
      那是随组件挂载**同步**触发的。
    - **Vue 的 `<transition>` 一律显式给 `:duration`。** 同上，靠 `animationend` 判断的写法在窗口不可见时
      会永远停住（`UrgentClassWarning` 那块铺满全屏的遮罩尤其致命：不卸载就再也点不动）。
    - **`position: fixed` 的整屏层、以及"自己量几何再据此设尺寸"的元素，不要叠位移类动画。**
      `.page > *` 错峰入场排除了 `.el-overlay`（Element Plus 的 `el-dialog` 默认 `append-to-body=false`，
      声明在视图里的弹窗其遮罩就是 `.page` 的直接子元素）、`.el-loading-mask`、`.board-host`
      （客户端的作业看板按"刚好铺满"算 `transform: scale()`，下移 6px 就溢出屏幕）。
      判定方法是 `getBoundingClientRect()` **包含** transform，而 `clientHeight` / `offsetHeight` 不含。
    - **弹窗面板的动画要挂在 `.el-dialog` 上，不要挂在 `.el-overlay-dialog`（居中容器）上。**
      Element Plus 的 `@opened` 按**根元素**（`.el-overlay`，只有 200ms 淡入）的动画结束触发，
      而外层容器上的弹簧要跑 463ms —— 任何在 `@opened` 里量容器尺寸做自适应的弹窗都会量到
      "还带着 `scale(0.97)` 的缩小版"，被 `minScale` 兜住后反而超出屏幕（作业看板实测 +7px）。
      挂 `.el-dialog` 还有个好处：全屏弹窗能用 `is-fullscreen` 精确豁免（全屏表面本来也不该缩放入场）。

    **两条容易踩的实现细节**：
    - 客户端的 `--nav-ease` **刻意保留** Material 的 `cubic-bezier(.4, 0, .2, 1)`，没有统一成 EASE_OUT。
      EASE_OUT 起步极快，宽度掉到 80px 以下时动画才走了约 35%，而 `layoutChromeSelfTest` 一到读宽度
      判据就往下走、立刻量图标中心，此刻内边距还在动 ⇒ 6 个分组子项偏 2.3px 判红。想换曲线得连那条断言
      一起重新商量。（该断言的宽度判据已从 `≤80` 收紧到 `≤65`，即"真正收拢到稳态"再量 —— 折叠目标宽度是 64px。）
    - **Vue 的 scoped `<style>` 可以引用全局 `@keyframes`**（只有同一个 scoped 块里**定义**的才会被改名）。
      实测：`.login-card` 的 `animation: ch-panel-in …` 原样输出且生效。但 `mode="out-in"` 之类的
      transition 类名仍在 scoped 块里写、元素也带 `data-v`，能正常命中。
    - `el-aside` / `el-menu` 这些是**组件**不是原生标签：模板 ref 拿到的是组件实例，
      `.querySelector` 不是函数（会被 `app.config.errorHandler` 吞成一行中文异常，界面看着毫无异样）。
      用 `$el`，或直接 `document.querySelector`（客户端的主侧栏只有一个，后者更直白）。
    - 降低动态效果：两端 `styles/index.css` 各有一个 `@media (prefers-reduced-motion: reduce)` 全局块，
      把动画压到 1ms（不是删掉，`transition: none` 会让依赖 transitionend 的逻辑失灵）。
      **加载指示旋要豁免**（改为放慢而非停）—— 停掉会让界面看起来像卡死。

    **灵动岛：只移植曲线，不移植弹簧。**
    岛的形变由主进程缓动窗口尺寸（`src/main/island.ts`），而冒烟断言「展开过程不震动」
    「收回过程不抖动」**逐帧采样岛体几何**并要求单调 —— 任何带过冲的弹簧都会直接判红。
    所以岛用 `--ch-ease-out` 这类单调曲线，壳的物理仍归它自己的 `island/spring.ts`（WinIsland 移植），
    不要拿 beUI 的 `SPRING_*` 去换。
    `IslandApp.vue` 是**另一个渲染进程**，不共享主窗口的 `:root`：令牌要在
    `src/island/main.ts` 里**再注入一次**（`applyMotionTokens()`）。漏了的话 `var(--ch-ease-out)`
    解析为空、**整条 `transition` 简写作废**，反而比改造前更差（完全没有过渡）。
    另外岛的 `:hover` 规则必须关在 `@media (hover: hover) and (pointer: fine)` 里 ——
    教室触摸屏的"幽灵 hover"会让点过「知道了」的按钮永远高亮。

    **深色主题的语义色令牌：只改值，不要对样式表跑批量 sed。**
    `--ch-text: #303133` 被"把 #303133 换成 var(--ch-text)"的批量替换一过，就变成
    `--ch-text: var(--ch-text)` —— **自引用**会让整条自定义属性失效，`getPropertyValue` 返回空串，
    全站文字颜色静默回落成继承色（浅色下看着"还行"，深色下就露馅）。实测踩过。

62. **图标：全项目只有一个图形源 `build/classhelper.{png,ico}`，其余一律由 `pnpm icons` 派生。**
    这两个文件是**设计导出、手工放入**的，`pnpm icons` 只读不写 —— 要换图标就换这两个文件，
    别去改脚本。派生清单写在 `scripts/icons/render.cjs` 顶部的注释里，覆盖：Web 端 PWA 三件套
    （`icon-192` / `icon-512` / `apple-touch-icon`）、`favicon`（png + svg 各一份）、
    ClassIsland 插件 `icon.png`、客户端 `build/{classhelper,icon}.{png,ico}`、
    托盘 `public/tray.png`、官网 `assets/icon.png`，以及**两端界面内的品牌标** `public/logo.png`。

    **四条硬约束（都对应实测踩过的坑）**：

    - **ICO 原样透传，不要重新生成。** `classhelper.ico` 里 9 个尺寸
      （16/24/32/48/64/72/96/128/256）是设计工具**逐尺寸栅格化**的，比把那张 345×339 的位图
      缩下去干净得多；脚本只解析它的目录项做日志与校验，然后把整份复制给客户端与 electron-builder。
    - **`packages/desktop-client/build/icon.{png,ico}` 别删。** 它们是与 `classhelper.*` 同步的副本，
      而名字是 **electron-builder 的兜底约定**：`convertIcon()` 的候选表是
      `['<win.icon>', 'icon.ico', 'icons', 'icon', 'icon.png', 'icon.svg', 'icon.icns']`，
      依次在 `[buildResources, projectDir]` 两个根下 stat，**第一个命中的就赢**。
      `win.icon` 现在显式写着 `build/classhelper.ico`（实测 `isFallback = false`，
      解析到 `packages/desktop-client/build/classhelper.ico`），但那条配置一旦被拿掉，
      就会**静默**回落到 `icon.ico` —— 副本同步着，回落也还是新图标。
    - **界面内的品牌标用 `<img>`，且两端 URL 的写法必须不同。** Web 端写根绝对路径 `/logo.png`
      （永远从源站根提供服务；前端是 history 路由，相对路径在 `/classes/1` 这类嵌套路由下会解析错）。
      客户端**必须经 `BRAND_LOGO_URL`（`src/renderer/config.ts`）绑定给 `:src`** ——
      字面量的相对 `src` 会被 Vite 当成模块导入去解析
      （`Rolldown failed to resolve import "logo.png" from "LoginView.vue"`，构建直接失败），
      而根绝对路径在 `file://` 加载的打包形态下会解析到**盘符根目录**。
    - **`School` 字形在两端 `icons.ts` 里的注册不要删**：它仍是「班级管理」菜单项与
      「班级码」输入框前缀的字段图标，只是不再是品牌标。品牌标换成真图标后，
      `.brand-logo` 的 `background` / `color` / `border-radius` / `overflow` 都要撤掉 ——
      圆角与透明边角本来就在图里，再叠一层会出现双重圆角。

    跑完 `pnpm icons` 记得把**生成出来的那些图**一起提交（脚本会比对内容，没变动的不会重写）。
    源图 345×339 不是正方形，脚本按等比缩放居中补透明（补边约 1.7%，肉眼不可见）；
    512 那两档是**放大**，会略软 —— 那是源图分辨率的上限，要更清晰只能换更大的设计导出。

---

63. **实时推送只走房间，而且没有"学生房间"。** 服务端 `src/realtime/`（`SOCKET_ROOMS`：
    `class:{classId}`、**`session:{id}`**、`teacher:{id}`、`role:{role}`、`students`、`teachers`；
    `bus.ts` 事件总线），客户端 `renderer/stores/realtime.ts` 订阅。
    `session:{id}` 里的 id 是**会话主体**：教师/管理员是自己的账号 id，
    ClassHelper 班级端是**班级 id**（见 `socket.ts` 的握手逻辑）—— 「叫人」这类定向消息就发到它。
    **2026-10-06 起把 `user:{id}` 改名成了 `session:{id}` 并且不再有学生房间**：学生不是账号，
    没有任何客户端会订阅它。**新增实时事件要同时改三处**：服务端 bus/socket、Web 端订阅、
    客户端订阅（灵动岛也依赖它）。事件名一律取自共享常量 `SOCKET_EVENTS`，不要手写字符串。

64. **ClassHelper 班级端主体是「班级」，`classId` 即身份。** 班级码 + 班级密码登录后角色是
    `CLASS_DEVICE`，该设备的「作业完成 / 通知已读」由 `lib/session.ts` 的 `resolvePersonalIds()`
    展开成**全班学生 id** 后再写（所以教师端的"完成人数 / 已读人数"统计依然准确）。
    写 `createdBy` 之类的字段前要把它换成该班班主任 —— 班级端的 `sub` 是**班级 id**，
    直接写会撞 `User` 外键（见 §5 第 20 条「教室机器能录入作业」）。
    班级端的成绩查询受 `Class.studentGradeQueryEnabled` 这个**按班开关**控制（默认开启）。

65. **课表同步的主方向是「服务端 → 教室」，教室不再自动回传。**
    `IntegrationDevice.mirrorScheduleToClassIsland` 默认 **true**（服务端改完课表自动下发），
    `syncScheduleToServer` 默认 **false**。要取教室的课表走
    `POST /integrations/devices/:id/request-schedule` —— 它只置一个待办
    （`requestScheduleReport`），插件在下一次心跳看到就把课表推上来并清除标记。
    Web 端点击前**必须弹警告**（会覆盖 / 合并本班课表）。
    插件侧对应 `ReportSettingsDto.scheduleRequested` + `ReportAsync(..., forceSchedule: true)`，
    且补发发生在**镜像之前**（顺序反了会把刚拿到的课表盖掉）——
    `verify:classisland-plugin` 有 6 条护栏盯着这段契约，别删。

66. **学期周次可以逐周配，别再用"开学日期 + 每周七天"硬推。**
    `TermWeek`（`classId = ''` 表示全校默认）存每一周的 `startDate`/`endDate`；
    `lib/term.ts` 的 `loadTermContext(classId)` 负责把"班级覆盖 → 全校默认 → 纯线性"三级回落算出来，
    `resolveCurrentWeek(now, context)` 优先按区间判定。
    **调休 / 周末补课 / 错峰开学会让线性推算整体错位一周以上**，而课表、作业、成绩都按周次组织。
    改周次（`PUT /api/term`、`POST /api/term/auto`）之后要 `notifyScheduleChanged()`，
    让变更随课表下发给教室的 ClassHelper 班级端。
    联网拉取调休建议（`GET /api/term/holidays`）**只给建议、不改数据**，且
    **机房无外网时 `ok:false` 是正常结果**，失败结果同样进缓存（否则断网点一次要白等一个超时）。

## 6. 代码风格

- **TypeScript ESM + NodeNext**：`package.json` 全是 `"type": "module"`，相对导入**必须带 `.js` 后缀**
  （写 `./foo.js`，即使源文件是 `foo.ts`）。`strict` 开启。
- **Prettier**（`.prettierrc.json`）：单引号、`printWidth: 110`、`trailingComma: all`、`arrowParens: always`、
  行尾 LF、缩进 2 空格。
- **ESLint**（`eslint.config.mjs`）：`no-explicit-any` 为 warn；未使用变量为 warn，可用 `_` 前缀豁免；
  `consistent-type-imports` 建议用 `import type`。`.cjs`（Electron 图标渲染、UI 冒烟）允许 `require`。
- **Vue**：视图命名 `XxxView.vue`，组件多单词；路由入口用 `meta.roles` 控制（如 `['ADMIN']`），
  隐藏入口之外服务端也必须拦（前端隐藏 ≠ 权限）。
- **提交信息**：Conventional Commits + 模块 scope，描述用中文，可多 scope，例如
  `fix(island): 胶囊"点不动"的根因——窗口必须始终可激活`、
  `feat(teachers,classes,schedules,web): 教师录入（仅管理员）`。
- **图表不引第三方库。** 全项目只有三张图（桌面端成绩页 1 张柱状图；Web 端成绩页柱状 + 折线各 1 张），
  历史上用 echarts 全量引入，占了桌面端渲染产物 1.12MB（35%）与 Web 端 1.13MB。现在换成
  自包含的轻量组件：`packages/desktop-client/src/renderer/components/ScoreBarChart.vue`、
  `packages/web-admin/src/components/{ScoreBarChart,ScoreLineChart}.vue` ——
  柱状图是纯 HTML/CSS（柱高走百分比、刻度与网格线用**零高度 flex 行 + space-between** 对齐），
  折线图是 `viewBox="0 0 100 100" + preserveAspectRatio="none"` 的 SVG（数据点用 HTML 绝对定位，
  免得非等比拉伸把圆点压成椭圆）。两者都是响应式的，**不要给它们加重算尺寸的 resize 监听**。
  新增图表请沿用这个做法，不要重新引入图表库。
- **改动交付形态 / 新增功能后**，同步更新 `docs/reference.md`（完整参考 = 产品说明书 + 验收对照表）。
  仓库根的 `README.md` 是**展示页**（门面：简介、功能清单、截图、怎么装），不承载细节。改动交付形态、
  新增功能、或**重采了展示图**之后，两边都要看一眼 —— 不要在 README 里堆实现细节。

---

## 7. 本机环境已知坑（踩过，别再踩）

1. **系统代理会拦截 `127.0.0.1` 的自测请求。**
   `Invoke-WebRequest http://127.0.0.1:4000/api/health` 会返回**别人的 404**（响应带 `Alt-Svc: h3=…`、空 body），
   看起来像后端路由没挂上。实际是走了代理。自测请加 `-NoProxy`（`curl.exe` 用 `--noproxy '*'`）。
   项目内的 Node 脚本（`verify:*`）直连，不受影响。
   **同一个坑对 ClassIsland 插件同样成立**：.NET 的 `HttpClient` 默认跟随系统代理，
   教室机器上表现为"填好令牌后立刻 HTTP 404"（其实是代理的错误页）。插件里
   `ClassHelperClient` 用 `LocalAwareProxy` 对本地/内网地址强制直连，
   `verify:classisland-plugin` 有 4 项断言盯着这段逻辑，别删。
2. **`db:deploy` 只在 `packages/server` 包里，根 `package.json` 没有这个脚本。**
   根上跑 `pnpm db:deploy` 会报 `Command "db:deploy" not found`（还会附带一句莫名其妙的
   `文件名、目录名或卷标语法不正确。`）。正确写法：`pnpm --filter @classhelper/server db:deploy`。
   根上只有 `db:generate / db:migrate / db:seed / db:reset / db:studio`。
3. **`pnpm db:migrate`（= `prisma migrate dev`）在本机不可靠**：首次报 `Schema engine error:`（空消息），
   数据库建好后再跑会**长时间挂起**（无输出，需手动结束进程）。日常用 `db:deploy`；
   要写种子直接 `pnpm db:seed`，或 `node ./node_modules/tsx/dist/cli.mjs prisma/seed.ts`（cwd 为 `packages/server`）。
4. **先 `pnpm build:shared`，否则后面全崩**：`packages/shared/dist` 不存在时，`pnpm db:seed` 与任何
   消费 `@classhelper/shared` 的进程都会 `ERR_MODULE_NOT_FOUND`（报错指向
   `packages/server/node_modules/@classhelper/shared/dist/index.js`）。`pnpm dev*` / `build` / `typecheck`
   脚本已内联 `build:shared`，单独跑 `db:seed` 时记得自己先构建。
5. **Electron 二进制要手动装**：`pnpm install` 实测**不会**下载它（`allowBuilds` 里虽然写了 `electron: true`，
   但 postinstall 没跑；日志里只看到 esbuild / prisma）。缺失时 `pnpm dev:desktop` / `verify:desktop` /
   `verify:web` / `dist:win` 全部失败。装法（本机已装好）：

   ```bash
   cd node_modules/.pnpm/electron@44.3.0/node_modules/electron
   ELECTRON_MIRROR=https://cdn.npmmirror.com/binaries/electron/ NODE_OPTIONS=--use-system-ca node install.js
   ```

6. **"AI 会话里启动 Electron GUI 会崩"是一个误诊 —— 真凶是下一条的 Low 完整性标签。**
   2026-09-30 实测：把 Electron 发行目录的标签从 Low 改成 Medium 后，同一个 `electron.exe`
   在 AI 会话里**正常启动**（窗口标题 `Electron`、userData 目录正常创建），
   `pnpm verify:packaged` 也能完整跑完并出结果（86/90、77/78）。
   ⇒ `verify:desktop` / `verify:web` / `verify:packaged` / `dist:win` 在 AI 会话里**都能跑**；
   一旦它们又"启动即崩"，先按第 7 条查完整性标签，别急着甩锅给"会话环境"。
7. **交付物被打了 Low 完整性标签 ⇒ 客户端装不上、便捷版双击没反应、应用 0x80000003 秒崩。**
   症状极易误判：`electron.exe --version` 都不打印就退出（0x80000003 STATUS_BREAKPOINT），
   加 `--no-sandbox` 变成 0xC0000005，任何日志都写不出来（崩在日志初始化之前），
   但 `ELECTRON_RUN_AS_NODE=1` 跑同一个 exe 完全正常、Edge 等系统 Chromium 也正常。
   根因：**本仓库目录树被宿主沙箱打上了 `Mandatory Label\Low Mandatory Level:(OI)(CI)`（可继承）**，
   于是仓库内构建出的一切都继承 Low 标签。后果是双重的：
   - Windows 会把带 Low 标签的 exe **降级到 Low 完整性运行**：`setup.exe` 写不进 `%LOCALAPPDATA%`
     （报"拒绝访问"→ 用户看到"装不上"）、便捷版解不出 `%TEMP%`（→ 双击没反应）；
   - 即便装上了，落在 Low 标签目录里的应用文件也**读不了** —— Chromium 的 GPU/渲染子进程跑在
     AppContainer（更低完整性）里，按"不能向上读"直接秒崩。

   判据与修法（都是实测过的）：

   ```bash
   # 判据：看交付物（以及 node_modules/electron/dist）有没有 Low 标签
   icacls packages\desktop-client\release\win-unpacked\ClassHelper.exe | findstr Mandatory
   # 修法：把交付物改成 Medium。dist-win.mjs 收尾会自动做，手工补救用：
   icacls packages\desktop-client\release /setintegritylevel Medium /T /C
   # 目录自身要还原成继承，否则下次构建时自带 Low 标签的 7za / makensis 写不进去
   icacls packages\desktop-client\release /setintegritylevel "(OI)(CI)Low"
   ```

   连带的三条经验：**归档内部的载荷标签无所谓**（装到仓库外得到的是默认 Medium 文件），
   所以修标签必须在**打包完成之后**做，打包前改 appOutDir 反而会让 7za 读不到而失败；
   **别把安装测试装进仓库树**（`install-test` 之类），那里的文件又会继承 Low；
   **覆盖已存在的产物会被沙箱 ACL 拒绝**（`Can't open output file` / `拒绝访问`），
   `dist-win.mjs` 因此会先清掉上一轮的 `*.exe / *.7z / *.blockmap` 再打包。

8. **.NET 8 SDK 已装（8.0.425）**，`pnpm build:classisland-plugin` / `pnpm dist:classisland-plugin` 都能跑
   （2026-09-30 实测：`-t:Rebuild` 全量编译 8.8s，**1 个警告 0 个错误**；`.cipx` 打包成功，
   包内 DLL 的 sha256 与 `bin/Release` 产物一致）。脚本会自动把
   `NUGET_PACKAGES / TEMP / TMP / DOTNET_CLI_HOME` 指到仓库内 `.cache/`（`dotnet` 默认往 C 盘写，
   C 盘紧张时会构建失败）；手敲 `dotnet build` 时请自己带上这几个变量。

   两个容易自我欺骗的地方：
   - **光看输出会误判"编译通过"**：源码没变时 `dotnet build` 是**空转**（打印
     `所有项目均是最新的，无法还原` + `已成功生成 / 0 警告 0 错误`），`CoreCompile` 根本没执行 ——
     那行 `ClassHelper.ClassIslandPlugin -> …dll` 是拷贝回执，不是编译证据。
     要证明"真的编译过"，用 `node packages/classisland-plugin/scripts/build.mjs -t:Rebuild -v:n`
     看有没有 `csc.dll` 调用，并核对 DLL 的 mtime 晚于所有 `.cs`。
   - **那 1 个警告是预期的，别去"修"**：`AVLN3001: XAML resource
"…/BridgeSettingsPage.axaml" won't be reachable via runtime loader, as no public constructor was found`
     —— 设置页只有 `BridgeSettingsPage(PluginSettings, BridgeService)` 这个 DI 构造函数、
     没有公开无参构造，Avalonia 于是警告它无法走**运行时**加载器；本插件走的是编译期 XAML +
     ClassIsland 的 DI 实例化，加个无参构造反而会把 DI 弄坏。

9. **`.cipx` 打包最后一步要 PowerShell**：SDK 的 `CreateCipx` 目标默认调 `pwsh`，
   本机 PATH 里没有 pwsh 时会失败。构建脚本会探测并把结果透传给 MSBuild
   （`-p:PowershellBinaryName=…`），直接跑 `dotnet build -p:CreateCipx=true` 则要自己加。
10. **仓库根 `.gitignore` 的第 42 行是 GBK 编码**（整文件 CRLF，只有那一行是 GBK 注释），
    `apply_patch` 与 Prettier 都读不了它，按 UTF-8 读会看到 `\uFFFD`。要补忽略规则**只能用追加的方式**
    （`printf 'xxx\n' >> .gitignore`，原有字节一个都别动），别试图整文件重写；临时性的可写
    `.git/info/exclude`（本地生效、不入库）。
    （`packages/classisland-plugin/.gitignore` 是本仓库里唯一能正常编辑的 .gitignore。）
11. **`releases/`（复数）必须在 ESLint 忽略列表里**：本地跑过 `pnpm dist:*` 之后，
    这个目录里是构建后的压缩 JS，不忽略的话 `pnpm lint` 会报出几千条与源码无关的 error
    （`eslint.config.mjs` 里已补 `**/releases/**`，别再删掉；旧的 `release-server/` 条目留作兜底）。
    **它一度只在 ESLint 里被忽略、`.gitignore` 里漏了**（后者只有单数的 `release/` 和 `release-server/`）：
    归集一次客户端产物就有 225MB 的 EXE 变成未跟踪文件，`git add -A` 会直接把安装包提交入库。
    2026-09-30 已在 `.gitignore` 末尾补上 `releases/`。
    （2026-10-05 起 `release-server/`、`packages/desktop-client/release/` 这两个中间输出目录已取消，
    三个打包脚本都直接输出到 `releases/`，见 §4；那两条 ignore 保留作兜底。）
12. **ClassIsland 的数据根是 `D:\Classisland\data`**（**不是**旧文档写的 `F:\data`，F 盘已不存在）：
    - 插件 DLL 覆盖到 `D:\Classisland\data\Plugins\classhelper.classisland.bridge\`（**ClassIsland 运行时会锁住
      DLL，必须先退出它再覆盖**：`Get-Process ClassIsland.Desktop | Stop-Process -Force`）；
    - 插件配置在 `D:\Classisland\data\Config\Plugins\<id>\Settings.json`，**ClassIsland 运行中改会被内存里的
      副本随时回写覆盖**，要改请趁它退出时改；该文件里存着这台机器的服务器地址与设备令牌，**别覆盖**；
    - 改完 DLL 或配置都要重启 ClassIsland，否则跑的还是旧副本。
13. **读 ClassIsland 控制台日志要用 GBK**：`.NET` 的控制台输出是**系统 ANSI（GBK）**编码，
    用 `-Encoding UTF8` 读会变成乱码、**中文关键字一条都搜不到**（只能搜到 ASCII 的类名）。
    正确姿势：`[System.IO.File]::ReadAllLines($path, [System.Text.Encoding]::GetEncoding(936))`；
    日志文件被运行中的进程占用时先 `Copy-Item` 一份再读。
14. **服务端改了代码要重启才生效**（`tsx src/index.ts` 不热载，`pnpm dev:server` 才有 watch）。
    验证脚本报「某个断言突然不对」时，先确认后端跑的是不是最新代码 —— 这个坑踩过一次。
15. **后端启动时才发现 Web 产物**：`packages/web-admin/dist` 不存在就跳过静态托管，`http://127.0.0.1:4000/`
    只会返回服务首页（文案「Web 管理端未随本服务托管」）。要跑 `verify:web`，先 `pnpm build` 再重启后端。
16. **打包版服务端有生产自检**：`NODE_ENV=production` 时拒绝 `dev.db`（"生产环境仍在使用 dev.db"）、
    拒绝短 `JWT_SECRET` 与示例密钥；想用演示数据跑打包版就把库**复制**成 `data/classhelper.db` 再启动。
17. **makensis 建不了临时文件时，NSIS 那一步会失败（`dist:server` 与 `dist:win` 都会踩）。** 两种根因、
    同一个排查动作 —— 先把 `TEMP` 指到仓库内一个**真实存在的 Windows 绝对路径**再重试：
    - `pnpm dist:server` 报 `Internal compiler error #12345: error creating mmap the size of N`：模板用了
      `SetCompressor /SOLID lzma`，makensis 会在 **`%TEMP%` 所在的盘**建一个上百 MB 的 mmap 临时文件，盘紧就失败
      （免安装目录其实已生成好，只是最后一步打不出安装包）。加 `--reuse-deps` 还能跳过依赖安装。
    - `pnpm dist:win` 报 `!tempfile: Unable to create temporary file!` / `Error in macro _Switch`：**不是空间不足**，
      而是 Git Bash 里 `TEMP=TMP=/tmp` —— makensis 是原生程序，把 `/tmp` 当成「当前盘根下的 tmp」解析成
      `D:\tmp`，该目录不存在。`/c` 有 79G、`/d` 有 124G 也会照样失败（2026-09-30 实测）。
      `win-unpacked` 与 `*.nsis.7z` 此时都已生成（整理进 `安装包/`、`免安装/` 的那一步在打包
      成功之后才跑，失败时还没执行），**只需重跑，不必重建前端**：

      ```bash
      mkdir -p .cache/tmp
      TEMP='D:\classhelper\.cache\tmp' TMP='D:\classhelper\.cache\tmp' \
        node packages/desktop-client/scripts/dist-win.mjs
      ```
18. **依赖二进制下载需要 `NODE_OPTIONS=--use-system-ca`**（本机 TLS 中间人证书），否则报
    `unable to verify the first certificate`。
19. **Prisma 版本锁死 7.10.0**：npm `latest` 已指向 8.x；生成器是 `prisma-client`，输出到
    `src/generated/prisma`（gitignored），连接串在 `prisma.config.ts`，并且**必须走 driver adapter**
    （`@prisma/adapter-libsql` + 预编译的 `@libsql/win32-x64-msvc`，避开 electron ABI 的原生编译坑）。
20. **服务端安装包里的 `.cmd` 提示是英文**：cmd.exe 按 GBK 解析脚本，中文会乱码，属有意为之
    （中文在安装向导与 `README.txt`）。
21. **`pnpm format:check` 在 master 基线上本来就是失败的**（含 `tsconfig.base.json` 与 `scripts/*`），
    不要拿它当门禁、也不要为了让它变绿去批量格式化。只检查你改过的文件：
    `pnpm exec prettier --check <file>`。
    **注意它会因为 CRLF 而"全面误报"**：`core.autocrlf=true` 让 git 里存 LF、工作区签出成 CRLF，
    而 Prettier 配的是 `endOfLine: lf`，于是几乎每个文件都被标红。要判断是不是**你的**代码不合风格，
    用 `sed 's/\r$//' <file> | pnpm exec prettier --check --stdin-filepath <file>`。
22. **写冒烟断言时别用"元素还在不在"判断 Element Plus 的弹框关没关。** `el-dialog` 关闭后
    **DOM 会留在文档里**（Element Plus 只把 `.el-overlay` 置成 `display: none`），
    `document.querySelector('.el-dialog')` 恒为真 —— `verify:desktop` / `verify:packaged` 里
    「设置页『修改密码』对话框取消后未关闭」就是这么误报出来的。正确判据：
    `getComputedStyle(dialog.closest('.el-overlay')).display !== 'none'`。
    同理，断言岛体尺寸别写死"胶囊尺寸 + 留白"：那一刻是胶囊还是卡片取决于前面用例留下的状态，
    应改成**与形态无关的不变量**（如"窗口 = 卡片实测尺寸 + 2×阴影留白"）。

23. **客户端安装包有硬底：`ClassHelper.exe` 单独压缩后就有 85~90MB，"压到 60MB"做不到 —— 别再为这个反复折腾。**
    实测（2026-10-05，Electron 44.3.0）：`win-unpacked` 372MB，其中 `ClassHelper.exe`（就是 electron.exe，
    rcedit 只加了 74KB）**234.7MB**；brotli-9 抽样压缩后估算它单独就有 85~90MB。也就是说把渲染产物
    从 3.2MB 压到 2.1MB、把图标从 293 个减到 42 个，对安装包只影响约 1MB。
    剩下能动的只有这些（合计约 12MB，风险不成比例，**当前一律不做**）：
    `dxcompiler.dll + dxil.dll` 26MB（D3D12 着色器编译）、`vk_swiftshader + vulkan-1` 6.2MB、
    `d3dcompiler_47.dll` 4.5MB（D3D11 回退）、`chrome_200_percent.pak` 1.2MB（高 DPI）、`ffmpeg.dll` 3MB。
    教室机器多是老显卡 / 希沃一体机 / 虚拟机，删掉这些就是拿渲染可靠性换体积。
    **唯一做的一条**是语言包：`electron-builder.yml` 的 `electronLanguages: [zh-CN]`
    （官方选项，`app-builder-lib` 的 `removeUnusedLanguagesIfNeeded()` 会精确删掉其余 54 个
    `locales/*.pak`）。实测 `win-unpacked` 372MB → **323MB**、`setup.exe`/`portable.exe`
    107.2MB → **98.7MB / 98.4MB**（表中口径均为 MiB，与本机 `ls -la` / `du` 一致）。

    要真正做到 60MB 只能换渲染运行时（WebView2 / Tauri，安装包可到 5~15MB），代价是把
    `src/main/island.ts`（1840 行）里全部原生窗口行为重写一遍 —— 逐像素透明、鼠标穿透、
    窗口贴合岛体、触摸模式、多屏/DPI，全是 §5 第 10/16/21/22/30/32/36/37 条踩过坑的地方，
    且 `verify:desktop` / `verify:packaged` 的整套回归要重做。属于独立立项，不是顺手优化。

### 已知脆弱用例（不是环境问题，别去"修环境"）

| 用例                                          | 触发条件                                                                                                                                                                                                                                                        |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verify:e2e`「上课状态接口（at=周一 08:10）」 | 种子把「周一第 1 节」限制在第 1 周，且用例把 `2026-09-07` 当第 1 周。`TERM_START_DATE` 对齐到 `2026-09-07` 即全绿（本机 `.env` 已这样配；`.env.example` 仍是 `2026-02-23`，重置 `.env` 时记得改回来）                                                           |
| `verify:desktop`「课表今天时间轴」            | 凌晨约 00:00–03:00 时「已结束」探针被夹紧成 0 长度而被过滤，`已结束=false` 判定失败                                                                                                                                                                             |
| `verify:web`「课表科目为全校统一目录」        | 种子给每个班建满了全部科目，下拉里没有可自动建课的「统一科目」分组                                                                                                                                                                                              |
| `verify:desktop`「作业看板全屏自适应」        | 演示数据里某天有 6 条长作业、而冒烟窗口只有 ~543px 高时，`computeScale` 算出的缩放低于下限 0.45 被 `Math.max(minScale, …)` **钳住**，于是必然溢出（实测 565 > 543）。判据用的是 `host.clientHeight` / `inner.offsetHeight`，**这两个是布局属性、transform 不影响**，所以与动效层无关；数据在冒烟里建了又删，每次跑出来的高度还会差几十像素 |
| 岛交互 / 岛动画 / 岛截图留档这几个用例        | **AI 会话里会间歇性失败**：同一份产物连跑两次，失败项会在「点击展开 / 紧急展开动画 / 各状态截图留档」之间跳（2026-09-30 实测三轮结果各不相同）。根因是置顶透明小窗的 rAF 被限流、形变采样抓不到帧，属时序敏感；**先原样重跑一次再动手改代码**，别把偶发当成回归 |

---

## 8. 交付前检查

```bash
pnpm lint                # ESLint（0 error 为底线）
pnpm typecheck           # 全仓库类型检查

pnpm dev:server          # 另开终端
pnpm verify:e2e          # 后端端到端（2026-10-06 实测 205 项全过）
pnpm verify:classisland  # ClassIsland 联动链路（实测 44 项）
pnpm verify:classisland-plugin          # 插件静态契约（不需要后端，实测 74 项）
pnpm build:desktop && pnpm verify:desktop   # 客户端冒烟（AI 会话可跑，先看 §7 第 7 条）
pnpm build && pnpm verify:web               # Web 端真实点击回归（同上）
```

条目数由脚本自行统计并打印（`=== 结果：N/N 项通过 ===`、`ClassIsland 联动插件静态校验：N/N 项通过`），
文档不要写死容易过期的总数。

改动到 **Linux 交付链**（`deploy/install.sh`、`deploy/classhelper`、`deploy/tools/`、
`scripts/dist-server.mjs` 的 linux 分支、systemd/profile.d/logrotate 模板）时：

```bash
bash -n deploy/install.sh deploy/classhelper deploy/verify-linux.sh deploy/install-linux.sh   # 语法（Windows 上就能跑）
pnpm dist:server:linux      # 只能在 Linux 上跑；开发机是 Windows 时到服务器/CI 上验证

# 真机（任意一台能 SSH 的 Linux，容器也行但 systemd 用例会跳过）
scp releases/server/<版本>/linux-x64/classhelper-server-linux-x64-*.tar.gz deploy/{install.sh,verify-linux.sh} root@<主机>:/tmp/
ssh root@<主机> 'bash /tmp/install.sh --check'
ssh root@<主机> "printf '%s\n' '<密码>' | bash /tmp/install.sh --yes --admin-password-stdin --package /tmp/classhelper-server-linux-x64-*.tar.gz"
ssh root@<主机> "bash /tmp/verify-linux.sh --admin-password-stdin" < <(printf '%s\n' '<密码>')
```

`verify-linux.sh` 会**真的**改一次管理员密码再回滚、真的发一条备份，跑完机器仍是可用状态；
升级/回滚链路要加 `--full --package <新版本包>`（会真的替换一次程序文件）。
**改过这条链路就要在真机上跑一遍**——脚本写在 Windows 上跑不出问题，`set -e` 的坑、
systemd 的 `EnvironmentFile` 解析、glibc 差异都只有在 Linux 上才暴露。

改动到 ClassIsland 插件时，额外跑 `pnpm dist:classisland-plugin` 确认能打出 `.cipx`；
本机已装 ClassIsland 2.1.0.1（`D:\Classisland`）与 .NET 8 SDK（8.0.425），因此**真机验证是可行的**
（直接 `pnpm build:classisland-plugin` 编译，再按 §7 第 12 条部署）：

```powershell
# 1) 退出 ClassIsland（DLL 被占用时无法覆盖）→ 2) 覆盖插件 → 3) 重新启动
Get-Process ClassIsland.Desktop | Stop-Process -Force
Copy-Item packages\classisland-plugin\bin\Release\ClassHelper.ClassIslandPlugin.dll D:\Classisland\data\Plugins\classhelper.classisland.bridge\ -Force
Start-Process D:\Classisland\ClassIsland.exe -WorkingDirectory D:\Classisland
# 4) 在 Web 端「ClassIsland 联动」发一条提醒，看日志里依次出现：
#    取到待弹出提醒 → 已弹出提醒 →（播完）已确认提醒
```

交付时要说明"编译 / 打包 / 静态契约已过，运行期需在装了 ClassIsland 的机器上实测"。

改动涉及打包/交付形态时，额外跑 `pnpm dist:all`（或 `dist:server` + `dist:win`），
并用 `pnpm verify:packaged --exe "<客户端路径>"` 对**打包后的副本**复验 ——
开发产物通过不等于用户机器上的副本通过。

**改过 `pruneRuntime()`（§5 第 55 条）时，还要对免安装目录本身跑一遍**（开发形态跑通不代表裁剪后跑通）。
从 `releases/server/<版本>/免安装/` 起，用**自带的 node.exe**：

```bash
# ① 起服务：探针通 + 能真实查表（AUTO_MIGRATE 会建库；PORT 用环境变量避开开发端口）
cd releases/server/<版本>/免安装 && PORT=4100 ./node.exe server/dist/index.js
curl.exe -s --noproxy '*' http://127.0.0.1:4100/healthz
curl.exe -s --noproxy '*' -X POST http://127.0.0.1:4100/api/auth/login \
  -H "content-type: application/json" -d '{"username":"admin","password":"admin123"}'

# ② 数据库「一键切换」的三步子进程链路（唯一会调用 Prisma CLI 的地方）
cd server
DATABASE_PROVIDER=sqlite DATABASE_URL="file:./prune-test.db" \
  ../node.exe ../node_modules/prisma/build/index.js generate
../node.exe ../node_modules/typescript/lib/tsc.js -p tsconfig.generate.json
DATABASE_PROVIDER=sqlite DATABASE_URL="file:./prune-test.db" \
  ../node.exe ../node_modules/prisma/build/index.js db push --accept-data-loss
```

跑完把这几个测试残留删掉，别带进交付目录：`server/src`、`server/prune-test.db`，
并把 `data/`、`logs/` 清空。
（`prisma db push` 是破坏性命令，Prisma 7.10 的 AI 代理护栏会要求显式同意；
这里的目标是脚本刚建出来的空临时库，不是真实数据。）

自测本地接口记得绕过代理（见 §7 第 1 条）。
