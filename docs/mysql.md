# MySQL 切换指南

本项目默认使用 **SQLite（libSQL 内嵌模式）** 跑本地开发，数据模型与访问层已按
MySQL 兼容方式设计，可平滑切换到云端 MySQL / MariaDB 统一存储。

## 为什么默认是 SQLite

- 本地零依赖即可跑通全部功能（无需安装数据库服务）
- `schema.prisma` 刻意只使用跨库通用类型
  （`String` / `Int` / `Float` / `Boolean` / `DateTime`，无 `enum`、无 `@db.*` 原生类型）

## 设计上的兼容约定

| 约定                                  | 说明                                                                                                                              |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 不使用 Prisma `enum`                  | 角色（`ADMIN/TEACHER/STUDENT`）与优先级（`LOW/NORMAL/HIGH/URGENT`）以 `String` 存储，由 zod 在 API 层校验，两种数据库行为完全一致 |
| 主键为 `String @default(cuid())`      | 不依赖自增，便于多端离线生成与合并                                                                                                |
| 时间统一 `DateTime`                   | 由应用层与驱动适配器负责时区，不使用数据库原生时间函数                                                                            |
| 唯一约束仅使用 `@@unique` / `@unique` | SQLite 与 MySQL 语义一致                                                                                                          |
| 级联删除使用 Prisma 的 `onDelete`     | 由 Prisma 生成对应外键动作                                                                                                        |

## 切换到 MySQL

### 方式一：Web 管理端「数据库管理 → 一键切换」（推荐，v1.0.0 新增）

管理员在 Web 管理端打开 **数据库管理** 页（`/database`，仅 ADMIN 可见），在「一键切换数据库」卡片里：

1. 选目标类型（SQLite ⇄ MySQL）并填**空库**连接串（有表的库会被拒绝，防误覆盖）；
2. 输入「确认迁移」→ 点「开始迁移」。

界面会自动依次执行（带步骤进度条）：

1. **备份当前数据库**（gzip JSON 快照存 `<数据目录>/backups/`，失败可回滚）；
2. 导出当前数据为快照；
3. 测试目标库连接；
4. 检查目标库为空；
5. 改写 `schema.prisma` 的 provider；
6. 子进程 `prisma generate` 生成新方言的 Prisma 客户端；
7. （打包形态）把生成的 `.ts` 客户端编译进 `dist/generated`；
8. 子进程 `prisma db push` 在目标库建表；
9. 子进程 `dist/tools/apply-snapshot.js` 把快照写入目标库；
10. 全部成功后改写 `.env` 的 `DATABASE_PROVIDER` / `DATABASE_URL`。

**完成后必须重启服务端**（安装版运行 `restart.cmd`，开发模式重跑 `pnpm dev:server`）才会连接新库。
中途任一步失败会**回滚 `schema.prisma`**，`.env` 不被改写 —— 现有数据库与配置保持可用。

> 同一页还提供：连接状态检测（版本 / 体积 / 各表行数）、连接测试、手动与**定时备份**、
> 备份恢复、快照导出导入、SQLite 数据库文件下载。备份与导入导出共用同一种 JSON 快照格式，
> 因此**任意备份都能恢复回任意一种受支持的数据库**。
>
> 只支持 SQLite 与 MySQL 两种主库：Redis 等键值库不是 Prisma 支持的主数据库（无法建表/迁移），
> 接口层直接拒绝。

### 方式二：命令行手工切换

#### 1. 修改 provider

```bash
# 自动把 prisma/schema.prisma 的 provider 改成 mysql
node scripts/use-database.mjs mysql
```

#### 2. MySQL 驱动适配器（自 v1.0.0 起已随包内置）

Prisma 7 要求所有数据库都通过 driver adapter 接入，MySQL 对应 `@prisma/adapter-mariadb`
（该适配器基于 `mariadb` 驱动，兼容 MySQL 8）。**它已在 `packages/server/package.json` 的
依赖里**（数据库管理模块的连接测试/迁移需要），因此无需再手动安装：

```bash
# 仅当从旧版本升级、依赖里还没有时才需要
pnpm --filter @classhelper/server add @prisma/adapter-mariadb
```

`packages/server/src/lib/db.ts` 内置分支：当 `DATABASE_PROVIDER=mysql` 时会动态加载该适配器，
服务端代码无需改动。

#### 3. 配置环境变量

编辑 `packages/server/.env`：

```dotenv
DATABASE_PROVIDER=mysql
DATABASE_URL="mysql://classhelper:your-password@127.0.0.1:3306/classhelper"
```

> 云端部署时把 `127.0.0.1` 换成云数据库内网/公网地址；
> 生产环境请同时修改 `JWT_SECRET` 与 `CORS_ORIGIN`。

#### 4. 重建迁移并生成客户端

SQLite 与 MySQL 的 DDL 方言不同，**必须重新生成迁移文件**：

```bash
# 删除 SQLite 迁移历史（迁移文件是方言相关的）
rm -rf packages/server/prisma/migrations
# 重新生成并应用（需要目标库可连接，且账号有建表权限）
pnpm db:migrate
# 初始化演示数据
pnpm db:seed
```

也可以先只生成 SQL 供 DBA 审核：

```bash
pnpm --filter @classhelper/server exec prisma migrate dev --create-only --name init_mysql
```

> 只搬数据、不要演示数据时，用界面的「下载快照 / 导入快照」更省事：
> 旧库导出 JSON → 切库建表 → 新库导入，一份快照也可用 CLI 迁移：
> `node server/dist/tools/apply-snapshot.js --provider mysql --url "mysql://..." --file snapshot.json`

#### 5. 回到 SQLite

```bash
node scripts/use-database.mjs sqlite
# 同步 .env：DATABASE_PROVIDER=sqlite、DATABASE_URL="file:./prisma/dev.db"
rm -rf packages/server/prisma/migrations   # 若之前已切换成 MySQL 迁移
pnpm db:migrate
```

> 用界面「一键切换」回 SQLite 时，目标库同样必须是空文件：删除旧 `.db` 或指定一个新路径。

## 生产部署注意事项

1. **连接池**：Prisma 7 的 driver adapter 使用底层驱动（`mariadb`）的连接池设置，
   与 Prisma 6 默认值不同（例如默认无连接超时）。建议通过适配器参数显式设置连接上限与时区。
2. **时区**：`Grade.publishedAt`、`Homework.dueAt` 等字段建议在数据库会话中统一为 UTC，
   三端展示时再按本地时区格式化（前端使用 `@classhelper/shared` 的 `formatDate`）。
3. **迁移部署**：CI/CD 中使用 `prisma migrate deploy`（对应 `pnpm db:deploy`）而不是 `migrate dev`。
4. **备份**：切换云数据库后，`packages/server/prisma/dev.db` 不再被使用，可从 `.gitignore` 之外移除。
   界面「定时备份」把快照写进 `<数据目录>/backups/`（MySQL 模式下即安装根 `data/backups/`），
   **服务端进程不运行时不会补跑**；关键环境建议同时用数据库自带的备份策略。
5. **安装包体积**：切换链路需要随包内置 `prisma` CLI 与 `typescript` 编译器（Prisma 7 生成器产出
   `.ts`，切换后需在目标机编译进 `dist/generated`），服务端安装包因此约 34MB → 71MB。
