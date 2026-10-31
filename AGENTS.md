# AGENTS.md — ClassHelper（Class Helper）

本文件供本仓库的 AI 编码代理使用。先读这里，再改代码。当前工作目录为 `F:\ClassHelper`。
现行规则按工作区源码维护；产品说明见 `docs/app/`，开发契约见 `docs/dev/`，部署见 `docs/management/`。
查证路径见 `docs/reference.md`。文档与代码冲突时，阅读实现及其校验规则后同步修正文档，不沿用历史报告中的结论。

## 1. 项目与目录

pnpm monorepo，根 `package.json` 是版本单一来源。文档、注释、界面文案及提交描述使用中文。
远端为 `LoveChengke/ClassHelper`，默认分支 `master`。

| 目录                       | 用途                                                      |
| -------------------------- | --------------------------------------------------------- |
| `packages/shared/src/`     | 三端共享类型、权限、常量、动效、岛方案与课件契约          |
| `packages/server/`         | Express、Prisma、Socket.IO；API 前缀 `/api`               |
| `packages/web-admin/`      | Vue Web 管理端，PWA                                       |
| `packages/desktop-client/` | Electron 主进程、preload、主窗口与独立灵动岛渲染进程      |
| `scripts/`                 | 版本、构建、验证、打包、图标与 Pages 脚本                 |
| `deploy/`                  | Windows/Linux/Docker 部署与运维模板                       |
| `docs/`                    | docfx 文档；`images/` 为展示图，`screenshots/` 为回归截图 |
| `website/`                 | 纯静态官网与下载页                                        |
| `releases/`                | 按组件和版本存放本地交付物，gitignored                    |

不要在文档中手抄模块、表、权限键、测试用例的总数；分别查注册表、schema、共享目录与本次验证输出。

## 2. 服务端与数据边界

- 模块由 `packages/server/src/modules/registry.ts` 注册；新增或下线功能改注册表，不另改 `app.ts` 挂载。
- 路由用 `middleware/validate.ts` 与 zod；响应复用 `lib/http.ts`，错误交给统一中间件。
- 学生是 `Student` 名单记录，没有账号、角色或密码。教师/管理员存 `User`；班级登录读取 `Class.code/passwordHash`，会话角色 `CLASS_DEVICE`，主体 id 为班级 id。
- 任课关系只在 `Course(classId, name, teacherId)`。班主任不自动获得别的科目的作业、成绩写权限，统一走 `lib/authz/assert.ts` 的 `assertContentWrite`。班级端可录作业，不可写成绩；员工还须对应功能权限。
- 功能、范围、关系统一由 `lib/authz/` 判定，所有服务显式传权限键。ADMIN 固定全部能力；TEACHER 永久忽略管理员专用键；CLASS_DEVICE 为空集，接口明确允许并校验本班。权限管理仅 ADMIN。
- 岗位模板只管能力与建议范围，生效范围存 `UserPermissionGroup.scope/scopeValue`，使用 TEACHING/HEAD/GRADE/DIVISION/ALL。无显式分配的教师使用默认模板与固定 TEACHING；空或未知年级拒绝。按键独立合并范围，无键查询为空集；班级账号/学期设置永远要求本班班主任，科目写检查原/目标科目。具体断言和迁移见 `docs/dev/permissions.md`。
- 只有一份 `prisma/schema.prisma`，切库改 provider；保持 SQLite/MySQL 通用，不加 Prisma enum 或 `@db.*`。模型变动同步迁移、`lib/snapshot.ts` 的 `SNAPSHOT_TABLES` 与旧库兼容逻辑。
- `deleteTeacher` 必须保护班主任、课程任课、发布的作业/通知和所属课件，避免级联删除业务内容。
- 作业和通知按本地 `assignDate` 归类，使用 `dayKeyLocal/isDayKey/shiftDayKey`，不用 UTC 日期切片。
- 批量通知/作业逐班返回结果；跨班作业按科目名匹配既有课程，找不到则该班失败，不自动把发布者设为任课老师。
- 两个登录接口共用登录限流。附件链接校验 scheme；表格文件上限 8 MB、JSON 请求体 12 MB，超限映射 413。
- AI 助手只解析待确认动作，前端确认后调既有发布接口；参数重新校验，Key 加密存储且不回传。自动化用 mock，不访问外网。

## 3. 课表、周次、成绩与学年

- 课表真值是 `ClassPlan/ClassPlanEntry/TimeLayoutItem`；旧 `Schedule` 与 `TimeLayout.items` 保留迁移审计用途，不双写或回读复活旧业务。
- `/api/schedules/*` 是新模型兼容门面。启用解析统一走 `lib/class-plan.ts`，在线客户端不得另写启用优先级。
- 时间点有上课、课间、分割线、行动四种；课程显式引用时间点外键。排序不能靠数组下标代替关联。
- 支持 1–9 周轮换、群组、预定及临时层；完整档案导入走 `profile-import.service.ts`，不经过单双周有损格式。
- 全校时间表写入仅管理员；班级时间表按存储 classId 校验 `schedule:write` 与班主任关系，引用班级也校验。日课表/名单在 TEACHING/HEAD 范围要求班主任，显式年级/部/全校分配可在范围内维护。离线整套课表导入可建立班级自有作息，不把 JSON 的 TeacherName 当授权。
- 周次统一 `loadTermContext/resolveCurrentWeek`：班级逐周区间优先于全校区间，缺省再线性推算。开学日会参考班级设置、第 1 周区间、全校设置与环境兜底，详见 `lib/term.ts`。
- 全校周数上限存 `term.maxWeeks`，默认 30、范围 1–60；服务端 `getMaxTermWeeks()`，shared 做归一化与离线兜底。班级周数不超全校上限。
- 关闭个人成绩查询后，班级端仍可看服务端集体聚合；个人明细、原始全班成绩和排名拒绝读取。稀疏样本及补集抑制，不下发原始成绩后在客户端聚合。
- 总分开关属于 `Exam`；排名同学生同科取最高分，并列排名为 1、2、2、4。客户端只展示，不能修改成绩查询或考试配置。
- 年度升级由 `term.promotionAt` 配置，`PromotionRun.year` 保证幂等，升级前保存快照。运行期到点自动执行，启动漏跑先预览补跑；开发机启动不得擅自升级业务数据。
- 高三归档，其余升一级；新班仅建骨架，不复制班主任/任课关系。转出过滤复用 `lib/students.ts`，学号不复用，归档页保留历史与撤回转出。

## 4. 客户端、灵动岛与课件

- preload 仅暴露 contextBridge 白名单，不暴露 ipcRenderer；跨桥接传纯数据，不传 Vue Proxy。契约写在 `src/types/desktop.d.ts`。
- 保留 CSP、导航同源校验与弹窗限制。安装包不能含凭据，保留 `check-bundle-secrets` 构建门禁。
- 离线缓存按服务端与班级隔离，缓存故障不应阻断在线读取。退出、切服务器时清理会话状态，设备 `deviceKey` 保持不变，渲染层不能改写它。
- 设备维护只走 `/api/clients/*`，管理页 `ClientsView.vue`；心跳、进度、回执仅接受本班 CLASS_DEVICE，deviceKey 不可跨班迁移。心跳约 30 秒，90 秒窗口判在线；未登录不报，401/403 退避，切配置重置计时并隔离迟到响应。
- 远控须 `remote:control`，只允许 shutdown/restart/logoff/lock，客户端立即执行、持久去重并回执。冒烟始终假执行，不得真关机/重启/注销/锁屏。
- 安装包登记/删除为管理员 `client:update`；班级推送用 `client:update-push`；服务端缓存包并登记 SHA256，教室机从本服务下载；无哈希拒收，按立即/放学后/空闲策略执行，关闭自动更新不得强装。冒烟不运行安装器。
- 灵动岛方案保存在本机 `config.json.islandLayout`，默认 `layout=fixed`；`custom` 当前即常驻模式，旧 `residentEnabled` 是兼容字段。新尺寸上报仅在 custom 模式执行。
- `LayoutIslandApp.vue` 选择经典 `IslandApp.vue` 或 `CustomIslandRuntime.vue`，共用一个原生岛窗口；课件传输状态优先显示 `CoursewareTransfer.vue`。
- 经典模式：普通通知/作业上课暂存；普通叫人保留可点击胶囊；紧急消息立即展开。自定义常驻模式：消息先提示铃铛数量，用户主动展开；上课也可主动查看。不要把两个模式规则混写。
- 自定义方案的常态 `rows` 与无消息展开 `expandedRows` 分开编辑。课程、时钟、容器等使用 shared 组件契约；测量自然内容并按工作区约束适配。
- 保留经典岛连续圆角、投影常驻、触摸输入、失焦宽限与固定窗口几何护栏。不要调用 `setBackgroundMaterial()` 破坏逐像素透明。左右边距仅左/右停靠生效。
- 消息按 id 去重，通知/叫人双播不得重复；列表布局复用 shared 度量。崩溃恢复保持限流，冒烟不得自重启。
- 课件权限和任课范围独立校验：拥有文件、文件可见范围与本人授课班级共同约束推送，岗位范围不代替任课授权。
- 课件最大 512 MB，流式收发、临时文件、SHA256 校验；客户端不自动运行文件，每设备独立回执。JSON 快照只含元数据，完整备份另带文件目录。

## 5. 实时、界面与资源

- 事件名与房间名取 shared 常量。班级房间为 `class:{id}:{channel}`，教师按每域读键及范围订阅，班级端仅本班全部通道；握手回查数据库身份。业务用 `emitToClass/emitToSession`，由总线选择事件域。
- 会话房间为 `session:{id}`；教师/管理员 id 为账号 id，班级端为班级 id。`students` 是班级端广播房间，不是个人学生账号房间。
- 新实时事件同步服务端、Web 订阅、客户端订阅。成绩实时载荷不可泄漏个人成绩。
- Web 菜单分组在 `config/navigation.ts`，标题/图标/权限取路由；守卫与服务端都检查权限，前端隐藏不能代替鉴权。
- 侧栏折叠用 CSS 保持 DOM，关怀模式放大字号/控件，不改变几何令牌。使用语义色，动效统一 shared 令牌；图标新增后检查注册表。
- 图标源是 `build/classhelper.png` 与设计导出的 `.ico`，`pnpm icons` 派生其余资源。ICO 原样透传，客户端兜底 `build/icon.*` 同步保留。
- Web 品牌图用 `/logo.png`，客户端用 `BRAND_LOGO_URL`，避免 file:// 绝对路径问题。
- 官网和文档站共用一个 Pages 站点，`scripts/build-pages.mjs` 拼装根站与 `/docs/`；文档不写指向 docs 树外的相对链接，源码用 GitHub 绝对链接。
- 展示图引用 `docs/images/`，回归图放 `docs/screenshots/`。官网 `.reveal-grad` 不拆逐字节点，动效改 token 表。
- ClassIsland 联动插件、设备令牌、提醒渠道与镜像接口已退役；保留离线 JSON 导入和设计参考，不恢复在线联动依赖。

## 6. 本机命令与验证

脚本以根/各包 `package.json` 为准；端口：后端 4000，Web dev 5173，客户端 dev 5174，官网 5180，文档 5181。
先构建 shared 再启动下游。新环境按需执行 install → db:generate → server db:deploy → build:shared；`db:seed/db:reset` 会清业务表，只用于明确选择的演示/隔离库。

本机 Node 路径为 `D:\Node.js\node.exe`。受限终端的 pnpm 可能解析到运行时兜底版本，先看 `Get-Command pnpm` 与 `pnpm --version`。
仓库锁定 pnpm 11.8.0，可用 `C:\Users\hck16\AppData\Local\node\corepack\v1\pnpm\11.8.0\bin\pnpm.cjs`。
经 DSH 转发壳时可设置：

```powershell
$env:PATH = 'C:\Users\hck16\AppData\Local\deepseek-harness\bin;' + $env:PATH
$env:DSH_NODE = 'D:\Node.js\node.exe'
$env:DSH_PNPM_BIN = 'C:\Users\hck16\AppData\Local\node\corepack\v1\pnpm\11.8.0\bin\pnpm.cjs'
Remove-Item Env:DSH_PNPM -ErrorAction SilentlyContinue
pnpm --version
```

受限 electron-builder 调 pnpm list 曾报 `ERR_SQLITE_ERROR`，这是进程访问限制，不据此认定依赖缺失。
Prisma 使用 driver adapter；本机优先应用已有迁移，不用 `migrate dev` 排查 Windows 初始化问题。
本地 HTTP 探测绕过代理；运行中数据库及 WAL/SHM 不按临时文件清理。

| 命令                                                        | 范围                                                   |
| ----------------------------------------------------------- | ------------------------------------------------------ |
| `pnpm lint` / `pnpm typecheck` / `pnpm check:icons`         | 代码静态门禁；按改动范围执行                           |
| `pnpm docs:check`                                           | 文档严格构建，警告即失败                               |
| `pnpm verify:e2e`                                           | 自动创建临时 SQLite 和账号，无需先开开发服务，禁止外网 |
| `pnpm verify:web:isolated`                                  | 构建 Web 后运行隔离服务和隐藏 UI 回归                  |
| `pnpm verify:courseware` / `pnpm verify:v14`                | 课件/课表等隔离专项                                    |
| `pnpm verify:desktop` / `pnpm verify:packaged --exe <路径>` | 默认后台快速检查，不创建可见岛或托盘                   |
| `pnpm verify:desktop:online`                                | 显式联网，使用临时教师和班级                           |
| `pnpm verify:desktop:visual` / packaged 的 `--visual`       | 显式视觉模式，动画、透明度、截图；会使用桌面           |

禁止为验收回退到真实班级、重置其密码或发送测试通知。验收数量只记录本次实际输出。
仅文档修改做格式、链接、构建检查，不为此反复占用桌面或重打安装包。
Prettier 用 LF，只格式化本次改动；不要为旧基线批量格式化源码。
改 Linux 交付脚本还要 bash 语法检查和 Linux 真机/CI 验证；改打包逻辑需打包后副本复验。

## 7. 发布与工作区清理

- 版本只由 `scripts/version.mjs` 修改；日常维护不涨版，指定固定版本重构建时保持该版本。发布流程见 `docs/dev/release.md`。
- 本地 `pnpm dist:all` 产出 Windows 服务端和客户端；Linux 正式包由 `release-linux-server.yml` 在 Linux runner 构建，非 Linux 交叉构建仅供验证。
- 本地文件名与 Release 的 ASCII 上传名不同，校验清单应明确映射；保留当前版本清单、更新日志及最新包。
- `releases/` 只放交付物及少量构建信息，不留 win-unpacked、服务端 staging、解包副本；staging 在 `.cache/server-staging/`，成功后脚本删除。
- 2026-10-18 按用户要求清除 1.4.0 旧重构建归档，只保留 `client/1.4.0`、`server/1.4.0` 与当前清单/说明。以后同号重构建可临时留回滚副本，最新包验证完成且用户要求清理时再删除。
- 递归删除/移动前核实绝对路径在指定工作区，禁止误删源代码、真实数据库、配置、凭据、工具缓存或其他版本交付物。
- 不清理 `node_modules`、`.pnpm-store`、`.cache/{nuget,npm-cache,dotnet-home,mingit}`、`packages/*/dist`、生成的 Prisma Client，除非任务明确要求。
- 保留已有未提交工作；提交前查看 diff，中文 Conventional Commits 描述。只有用户要求发布/同步时才执行远端发布链。
