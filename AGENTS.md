# AGENTS.md — 班级小助手（Class Helper）

本文件写给在本仓库里干活的 AI 编码代理。先读这里，再动代码。

---

## 1. 这是什么

班级信息管理系统，**pnpm monorepo**，一份代码产出三个交付物：

| 交付物     | 位置                      | 形态                                         |
| ---------- | ------------------------- | -------------------------------------------- |
| 后端服务   | `packages/server`         | Express + Prisma + Socket.IO，`/api` 前缀    |
| Web 管理端 | `packages/web-admin`      | Vue 3 + Vite + Element Plus（教师/管理员用） |
| 桌面客户端 | `packages/desktop-client` | Electron + Vue 3（学生用，含「灵动岛」浮窗） |
| 共享契约   | `packages/shared`         | 三端共用的类型 / 常量 / 权限 / 工具函数      |

核心链路：

```
教师在 Web 端发布内容
        │  REST API（JWT 鉴权）
        ▼
   后端服务（Express + Prisma）
        │  写库 + 按班级房间广播
        ▼
 Socket.IO ──► class:{classId} 房间 ──► 学生桌面客户端实时更新 UI
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
eslint.config.mjs            ESLint 扁平配置（TS + Vue）
packages/shared/src/         types / constants / permissions / utils
packages/server/
  prisma/schema.prisma       数据模型（sqlite；另有 schema.mysql.prisma）
  prisma/migrations/         迁移历史（已生成并应用）
  prisma/seed.ts             种子数据（会清空业务表后重建演示数据）
  prisma.config.ts           Prisma 7 配置：schema / migrations / seed / 连接串
  src/app.ts                 Express 装配（探针 → 限流 → 模块挂载 → 静态托管 → 兜底）
  src/index.ts               启动入口（自检 + HTTP + Socket.IO + 优雅退出）
  src/config/env.ts          zod 环境变量校验 + 生产自检
  src/lib/                   db / jwt / access(RBAC) / http / mappers / term / web-static
  src/middleware/            auth / validate / error / security
  src/realtime/              socket.ts（房间）+ bus.ts（事件总线）
  src/modules/               功能模块 + registry.ts（模块注册表）
  scripts/verify-e2e.mjs     后端端到端验收（163 项）
packages/web-admin/src/      api / stores / router / layouts / views / styles / components
packages/desktop-client/
  src/main/                  主进程：窗口 / 单实例 / IPC 配置 / 托盘 / 灵动岛 / smoke
  src/preload/               contextBridge 白名单桥（**不暴露 ipcRenderer 本体**）
  src/island/                灵动岛独立透明置顶窗口的渲染进程
  src/renderer/              学生端渲染进程：api / stores / cache(IndexedDB) / views
  src/types/desktop.d.ts     主进程 ↔ 渲染进程契约
  scripts/                   build-main / dev / smoke / dist-win
scripts/                     use-database.mjs / generate-icons.mjs / dist-server.mjs / ui-smoke/
deploy/                      Dockerfile / docker-compose.yml / nginx.conf / install-linux.sh
docs/                        production.md（生产部署）/ mysql.md / winisland-design-tokens.md
README.md                    完整产品与交付说明（改动交付形态时同步更新）
```

---

## 3. 本机环境（已配置好，可直接开工）

| 项              | 状态                                                                                         |
| --------------- | -------------------------------------------------------------------------------------------- |
| Node            | v22.15.0（要求 ≥ 20.19，Prisma 7 硬性要求）                                                  |
| pnpm            | 11.19.0（`packageManager` 锁定 11.8.0）                                                      |
| npm registry    | `https://registry.npmmirror.com/`（全局 pnpm 配置；仓库内无 `.npmrc`）                       |
| 依赖            | `pnpm install` 已完成（707 包）                                                              |
| 后端 `.env`     | 已由 `.env.example` 生成 `packages/server/.env`（**gitignored**），`JWT_SECRET` 为本机随机值 |
| Prisma Client   | 已生成到 `packages/server/src/generated/prisma`（gitignored）                                |
| 数据库          | SQLite `packages/server/prisma/dev.db`，5 个迁移已应用、种子已写入                           |
| Electron 二进制 | 已下载（`node_modules/.pnpm/electron@44.3.0/node_modules/electron/dist/electron.exe`）       |

### 从零重建环境

```bash
pnpm install

# 后端环境变量（.env 不入库，必须自己生成）
cp packages/server/.env.example packages/server/.env   # 然后至少改 JWT_SECRET

pnpm db:generate
pnpm db:deploy        # 应用迁移（见 §7 第 6 条：不要用 db:migrate）
pnpm db:seed          # 写演示数据

pnpm build:shared     # 三端都依赖 shared 的 dist，先构建它
```

Electron 二进制**不会**随 `pnpm install` 自动下载（本机 postinstall 被跳过），需要手动补：

```powershell
$env:ELECTRON_MIRROR="https://cdn.npmmirror.com/binaries/electron/"
$env:ELECTRON_CACHE="F:\ClassHelper\.cache\electron"
$env:NODE_OPTIONS="--use-system-ca"
node install.js   # 工作目录：node_modules/.pnpm/electron@44.3.0/node_modules/electron
```

### 演示账号（`pnpm db:seed` 产出）

| 角色           | 用户名                          | 密码         |
| -------------- | ------------------------------- | ------------ |
| 管理员         | `admin`                         | `admin123`   |
| 班主任         | `teacher1` / `teacher2`         | `teacher123` |
| 学生个人号     | `student01` … `student15`       | `student123` |
| 学生端班级账号 | 班级码 `G101` / `G102` / `G103` | `123456`     |

---

## 4. 常用命令

| 命令                                                      | 说明                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------- |
| `pnpm dev`                                                | 并行启动 shared(tsc watch) + 后端(4000) + Web 端(5173)        |
| `pnpm dev:server` / `pnpm dev:web`                        | 只启动后端 / 只启动 Web 端                                    |
| `pnpm dev:desktop`                                        | 客户端开发模式（Vite 5174 + Electron，热更新）                |
| `pnpm build`                                              | 构建 shared + 后端 + Web 端 + 客户端                          |
| `pnpm build:shared`                                       | 只构建 shared（改完 `packages/shared` 必须跑）                |
| `pnpm build:desktop`                                      | 只构建客户端（esbuild 主进程/preload + Vite 渲染进程）        |
| `pnpm typecheck`                                          | 全仓库类型检查（含 `vue-tsc`）                                |
| `pnpm lint` / `pnpm lint:fix`                             | ESLint                                                        |
| `pnpm format` / `pnpm format:check`                       | Prettier                                                      |
| `pnpm db:generate`                                        | 生成 Prisma Client                                            |
| `pnpm db:deploy`                                          | 应用已有迁移（**本机推荐**）                                  |
| `pnpm db:seed` / `pnpm db:reset`                          | 写种子 / 重置并重播种子                                       |
| `pnpm db:studio`                                          | Prisma Studio                                                 |
| `pnpm db:switch:mysql` / `db:switch:sqlite`               | 切换数据库 provider（配合 `docs/mysql.md`）                   |
| `pnpm verify:e2e`                                         | 后端端到端验收 163 项（**需后端已启动**）                     |
| `pnpm verify:web`                                         | Web 管理端真实点击回归 27 项（需后端已启动且 Web 产物已构建） |
| `pnpm verify:desktop`                                     | 客户端冒烟 77+ 项（Electron，无人工点击）                     |
| `pnpm verify:packaged`                                    | 对**打包后/已安装**的客户端 EXE 跑同一套冒烟                  |
| `pnpm dist:server` / `dist:win` / `dist:dir` / `dist:all` | 打包服务端安装程序 / 客户端安装包 / 免安装目录 / 两者         |
| `pnpm icons`                                              | 生成应用图标（Electron 渲染 SVG → PNG/ICO）                   |

### 端口

| 端口 | 用途                                                      |
| ---- | --------------------------------------------------------- |
| 4000 | 后端 REST + Socket.IO + （生产/构建后）Web 管理端静态托管 |
| 5173 | Web 管理端开发服务器（`/api`、`/socket.io` 代理到 4000）  |
| 5174 | 桌面客户端渲染进程开发服务器                              |

### 交付产物归集（本机约定：`releases/`）

打包产物统一归集到仓库根的 `releases/`（已被忽略，不入库）：

```
releases/
  client/  win-unpacked/                        免安装目录（verify:packaged 直接指它）
           班级小助手-<版本>-x64-setup.exe        学生端 NSIS 安装包
           班级小助手-<版本>-x64-portable.exe     学生端单文件版
  server/  classhelper-server/                  免安装目录（内置 node.exe，双击 start.cmd 即用）
           班级小助手服务端-<版本>-x64-setup.exe  服务端安装程序（含 Web 管理端）
```

```bash
# 客户端：electron-builder 支持直接指定输出目录（dist-win.mjs 会把额外参数透传给它）
pnpm build:desktop
node packages/desktop-client/scripts/dist-win.mjs -c.directories.output=<绝对路径>\releases\client

# 服务端：脚本输出路径写死在 release-server/，打完需要自己移进 releases/server/
pnpm dist:server          # 首次会跑 46s 左右的 npm install；重试可加 --reuse-deps 跳过
```

---

## 5. 架构硬约定（改代码前必须知道）

1. **模块注册表是唯一入口。** 服务端每个功能是 `src/modules/<name>/`（`*.module.ts` 路由、
   `*.schemas.ts` zod 校验、`*.service.ts` 业务）。新增/下线功能**只改
   `src/modules/registry.ts`**（加一行 / 改 `enabled: false`），不要动 `app.ts`。
2. **统一响应与校验。** 用 `src/lib/http.ts` 的 `sendOk / sendCreated / …` 返回，用
   `middleware/validate.ts` 挂 zod schema；错误交给 `middleware/error.ts`，不要各写一套。
3. **鉴权 = JWT + RBAC + 班级内角色。** 路由级用 `requireRole('ADMIN', 'TEACHER')`；班级维度用
   `@classhelper/shared` 的 `resolveClassRole` → `ADMIN / HEAD（班主任）/ SUBJECT（科任）/ STUDENT / NONE`，
   权限判 `canManageSchedule` / `canPublishContent` / `canManageRoster` 等，**不要在页面里另写一套规则**。
4. **学生端主体是「班级账号」。** 班级码 + 班级密码登录后，`classId` 即身份；该设备的「已读 / 完成」
   代全班操作，个人学生登录已停用。API 里对此有专门分支，别按个人账号语义改。
5. **实时推送只走房间。** 服务端 `src/realtime/`（`socket.ts` 房间 `class:{classId}`、`user:{id}`；`bus.ts` 事件总线），
   客户端 `renderer/stores/realtime.ts` 订阅。**新增实时事件要同时改三处**：服务端 bus/socket、Web 端订阅、
   客户端订阅（灵动岛也依赖它）。
6. **共享契约只在 `packages/shared`。** 三端都 `import ... from '@classhelper/shared'`；它产出 `dist`，
   改完要 `pnpm build:shared`（或跑着 `pnpm dev` 的 watch）。类型/常量**不要在两端各写一份**。
7. **数据模型跨库通用。** `schema.prisma` 只用 String / Int / Float / Boolean / DateTime，不用 Prisma enum、
   不用 `@db.*`；角色与优先级存字符串并在 API 层用 zod 校验（这样 SQLite / MySQL 行为一致）。
   改模型要同步 `schema.mysql.prisma` 和 `prisma/migrations/`。
8. **周次口径唯一。** 当前教学周 = `shared.resolveCurrentWeek(TERM_START_DATE, now, MAX_TERM_WEEK)`，
   `MAX_TERM_WEEK = 30`，班级还有自己的 `Class.termWeeks`（默认 20）。别在别处重新实现周次换算。
9. **Electron 安全边界。** `src/preload/` 只通过 contextBridge 暴露白名单方法，**不要暴露 `ipcRenderer` 本体**；
   主进程 ↔ 渲染进程的类型统一写在 `src/types/desktop.d.ts`。

   **跨桥接只能传纯数据。** contextBridge 在参数跨越"主窗口 → 隔离世界"时就做结构化克隆，
   传 Vue 的 `ref.value` / `reactive()` 对象（Proxy）会抛 `An object could not be cloned.`——
   而且它在**进入 preload 函数体之前**就失败了，所以桥接层**无法兜底**，只能由调用方展开成
   字面量再传（`saveConfig({ island: { ...island.value } })`）。这类失败是"半静默"的：
   界面数字照常变化、只多一行 console error，看起来就是"设置不生效"。设置页曾因此翻车，
   `verify:desktop` 里的「设置页真实 UI：拖拽滑块即时改变灵动岛外观」就是为它加的回归。

10. **客户端离线优先。** 渲染进程数据先落 IndexedDB（`renderer/cache/`），断网回退缓存并在顶部提示离线；
    新增页面/数据源要按这个模式接。
11. **Web 端设计令牌集中。** 圆角/投影写在 `packages/web-admin/src/styles/index.css` 的 `:root`
    （`--ch-radius-*` / `--ch-shadow-*`），组件里**不要写死数值**；Element Plus 通过覆盖它的 CSS 变量对齐。
    手机小屏（≤768px）用抽屉导航 + 卡片内横向滚动，新增页面沿用 `useResponsive.ts` + `.table-card` 约定。

---

## 6. 代码风格

- **TypeScript ESM + NodeNext**：`package.json` 全是 `"type": "module"`，相对导入**必须带 `.js` 后缀**
  （写 `./foo.js`，即使源文件是 `foo.ts`）。`strict` 开启。
- **Prettier**：单引号、`printWidth: 110`、`trailingComma: all`、`arrowParens: always`、行尾 LF、缩进 2 空格。
- **ESLint**（`eslint.config.mjs`）：`no-explicit-any` 为 warn；未使用变量为 warn，可用 `_` 前缀豁免；
  `consistent-type-imports` 建议用 `import type`。`.cjs`（Electron 图标渲染、UI 冒烟）允许 `require`。
- **Vue**：视图命名 `XxxView.vue`，组件多单词；路由入口用 `meta.roles` 控制（如 `['ADMIN']`），
  隐藏入口之外服务端也必须拦（前端隐藏 ≠ 权限）。
- **提交信息**：Conventional Commits + 模块 scope，描述用中文，可多 scope，例如
  `fix(island): 胶囊"点不动"的根因——窗口必须始终可激活`、
  `feat(teachers,classes,schedules,web): 教师录入（仅管理员）`。
- **改动交付形态 / 新增功能后**，同步更新 `README.md`（它兼作产品说明书与验收对照表）。

---

## 7. 本机环境已知坑（踩过，别再踩）

1. **系统代理会拦截 `127.0.0.1` 的自测请求。**
   `Invoke-WebRequest http://127.0.0.1:4000/api/health` 会返回**别人的 404**（响应带 `Alt-Svc: h3=…`、空 body），
   看起来像后端路由没挂上。实际是走了代理。自测请加 `-NoProxy`（`curl.exe` 用 `--noproxy '*'`）。
   项目内的 Node 脚本（`verify:*`）直连，不受影响。
2. **`pnpm` 由 Electron 宿主承载**（`pnpm config list` 里 `userAgent` 是 `node/v24.19.0`，而 `node -v` 是 v22.15.0）。
   个别情况下依赖的 `.bin` 不会进子进程 PATH，`pnpm run <script>` 报「不是内部或外部命令」。
   规避：直接用 Node 调入口，例如 `node packages/server/node_modules/prisma/build/index.js generate`
   （`prisma.config.ts` 里的 seed 命令已按这个思路写成 `node ./node_modules/tsx/dist/cli.mjs`）。
3. **启动 Electron 的脚本必须清掉 `ELECTRON_RUN_AS_NODE`**，且不要 `import 'electron'` 取可执行文件路径。
   `scripts/lib/electron-env.mjs`、`scripts/lib/node-runtime.mjs` 已封装，新脚本请复用。
4. **Electron 二进制要手动装**（见 §3），否则 `pnpm dev:desktop` / `verify:desktop` / `dist:win` 全部失败。
5. **依赖二进制下载需要 `NODE_OPTIONS=--use-system-ca`**（本机 TLS 中间人证书），否则报
   `unable to verify the first certificate`。
6. **`pnpm db:migrate`（= `prisma migrate dev`）在本机不可靠**：首次报 `Schema engine error:`（空消息），
   数据库建好后再跑会**长时间挂起**（无输出，需手动结束进程）。
   日常用 **`pnpm db:deploy`**；要写种子直接 `node ./node_modules/tsx/dist/cli.mjs prisma/seed.ts`（cwd 为 `packages/server`）。
7. **后端启动时才发现 Web 产物**：`packages/web-admin/dist` 不存在就跳过静态托管，`http://127.0.0.1:4000/`
   只会返回服务首页（文案「Web 管理端未随本服务托管」）。要跑 `verify:web`，先 `pnpm build` 再重启后端。
8. **原生模块按 Electron ABI 构建**：本项目因此用 libSQL 适配器（`@libsql/win32-x64-msvc` 预编译），
   不要为了图快换回 `better-sqlite3` 之类需要 node-gyp 的方案。
9. **Prisma 版本锁死 7.10.0**：npm `latest` 已指向 8.x-rc；生成器是 `prisma-client`，输出到
   `src/generated/prisma`（gitignored），连接串在 `prisma.config.ts`，并且**必须走 driver adapter**。
10. **服务端安装包里的 `.cmd` 提示是英文**：cmd.exe 按 GBK 解析脚本，中文会乱码，属有意为之（中文在安装向导与 `README.txt`）。
11. **`pnpm dist:server` 生成安装程序时可能报 NSIS `Internal compiler error #12345: error creating mmap the size of N`。**
    原因是模板用了 `SetCompressor /SOLID lzma`，makensis 会在 **`%TEMP%` 所在的盘**建一个上百 MB 的 mmap 临时文件；
    本机 `C:` 只剩约 100 MB 时会失败（免安装目录其实已经生成好了，只是最后一步打不出安装包）。
    规避：把临时目录指到空闲的盘再重试，并加 `--reuse-deps` 跳过依赖安装：
    `$env:TEMP='F:\ClassHelper\.cache\tmp'; $env:TMP=$env:TEMP; node scripts/dist-server.mjs --reuse-deps`。
12. **仓库根 `.gitignore` 是 GBK 编码**（含一段乱码注释），`apply_patch` 与 Prettier 都读不了它。
    要补忽略规则请写 `.git/info/exclude`（本地生效、不入库），别试图整文件重写。

### 已知脆弱用例（不是环境问题，别去"修环境"）

| 用例                                          | 触发条件                                                                                                                                                                                              |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verify:e2e`「上课状态接口（at=周一 08:10）」 | 种子把「周一第 1 节」限制在第 1 周，且用例把 `2026-09-07` 当第 1 周。`TERM_START_DATE` 对齐到 `2026-09-07` 即全绿（本机 `.env` 已这样配；`.env.example` 仍是 `2026-02-23`，重置 `.env` 时记得改回来） |
| `verify:desktop`「课表今天时间轴」            | 凌晨约 00:00–03:00 时「已结束」探针被夹紧成 0 长度而被过滤，`已结束=false` 判定失败                                                                                                                   |
| `verify:web`「课表科目为全校统一目录」        | 种子给每个班建满了全部科目，下拉里没有可自动建课的「统一科目」分组                                                                                                                                    |

---

## 8. 交付前检查

```bash
pnpm lint                # ESLint（0 error 为底线）
pnpm typecheck           # 全仓库类型检查

pnpm dev:server          # 另开终端
pnpm verify:e2e          # 后端 163 项
pnpm verify:web          # Web 27 项
pnpm build:desktop && pnpm verify:desktop   # 客户端冒烟
```

`pnpm format:check` **在 master 基线上本来就是失败的**（175 个文件未过 Prettier，含 `tsconfig.base.json`
与 `scripts/*`），不要拿它当门禁、也不要为了让它变绿去批量格式化。只检查你改过的文件：
`pnpm exec prettier --check <file>`。

改动涉及打包/交付形态时，额外跑 `pnpm dist:all`（或 `dist:server` + `dist:win`），
并用 `pnpm verify:packaged --exe "<客户端路径>"` 对**打包后的副本**复验 ——
开发产物通过不等于用户机器上的副本通过。

自测本地接口记得 `-NoProxy`（见 §7 第 1 条）。
