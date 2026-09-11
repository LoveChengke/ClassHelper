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

## 切换步骤

### 1. 修改 provider

```bash
# 自动把 prisma/schema.prisma 的 provider 改成 mysql
node scripts/use-database.mjs mysql
```

### 2. 安装 MySQL 驱动适配器

Prisma 7 要求所有数据库都通过 driver adapter 接入，MySQL 对应 `@prisma/adapter-mariadb`
（该适配器基于 `mariadb` 驱动，兼容 MySQL 8）。

```bash
pnpm --filter @classhelper/server add @prisma/adapter-mariadb
```

`packages/server/src/lib/db.ts` 已经内置分支：当 `DATABASE_PROVIDER=mysql` 时会动态加载该适配器，
因此只需要安装依赖 + 配置环境变量，服务端代码无需改动。

### 3. 配置环境变量

编辑 `packages/server/.env`：

```dotenv
DATABASE_PROVIDER=mysql
DATABASE_URL="mysql://classhelper:your-password@127.0.0.1:3306/classhelper"
```

> 云端部署时把 `127.0.0.1` 换成云数据库内网/公网地址；
> 生产环境请同时修改 `JWT_SECRET` 与 `CORS_ORIGIN`。

### 4. 重建迁移并生成客户端

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

### 5. 回到 SQLite

```bash
node scripts/use-database.mjs sqlite
# 同步 .env：DATABASE_PROVIDER=sqlite、DATABASE_URL="file:./prisma/dev.db"
rm -rf packages/server/prisma/migrations   # 若之前已切换成 MySQL 迁移
pnpm db:migrate
```

## 生产部署注意事项

1. **连接池**：Prisma 7 的 driver adapter 使用底层驱动（`mariadb`）的连接池设置，
   与 Prisma 6 默认值不同（例如默认无连接超时）。建议通过适配器参数显式设置连接上限与时区。
2. **时区**：`Grade.publishedAt`、`Homework.dueAt` 等字段建议在数据库会话中统一为 UTC，
   三端展示时再按本地时区格式化（前端使用 `@classhelper/shared` 的 `formatDate`）。
3. **迁移部署**：CI/CD 中使用 `prisma migrate deploy`（对应 `pnpm db:deploy`）而不是 `migrate dev`。
4. **备份**：切换云数据库后，`packages/server/prisma/dev.db` 不再被使用，可从 `.gitignore` 之外移除。
