---
title: MySQL 切换指南
description: 通过快照和受支持的换库流程切换 SQLite/MySQL，保留迁移历史。
---

# MySQL 切换指南

默认数据库为 SQLite，服务端也支持 MySQL/MariaDB。唯一 schema 为 packages/server/prisma/schema.prisma；
Prisma 通过 libSQL 或 MariaDB driver adapter 访问，两种适配器已随运行时依赖内置。
角色、优先级等以 String 加 API 校验存储，不用 Prisma enum 或 @db.*。

## 已有数据的切换

管理员在“数据库管理 → 一键切换数据库”填写**空目标库**连接串，并完成界面确认。
还须 database:manage；页面和具体接口各自检查权限。

1. 备份并导出当前数据库为 JSON 快照。
2. 测试目标连接，确认目标为空。
3. 改写 schema provider，子进程生成对应 Prisma Client。
4. 打包形态编译生成的 TypeScript 客户端。
5. 子进程基于当前 schema 建表，并用 apply-snapshot 写入快照。
6. 成功后写入 .env 的 DATABASE_PROVIDER/DATABASE_URL；重启服务端连接新库。

失败时回滚 schema，环境配置仅在成功后写入。快照覆盖的表以 lib/snapshot.ts 为准。
目标已有表时拒绝；回到 SQLite 也应指定新空文件，不能删除正在使用的数据库。
旧源库请保留到验证完成。课件实体不在 JSON 内，换主机时需另复制文件目录，见[课件](../app/courseware.md)。

## 源码开发与配置

scripts/use-database.mjs 只切换 schema provider，不迁移数据、不改 .env、不替代完整换库流程。
如果只准备一个全新的开发环境，可用 pnpm db:switch:mysql，再配置独立空库并生成客户端；
建模和导入仍按受支持流程完成。配置示例：

```dotenv
DATABASE_PROVIDER=mysql
DATABASE_URL="mysql://classhelper:your-password@127.0.0.1:3306/classhelper"
```

SQLite 迁移目录属于仓库升级历史，不要为了切库删除它，也不要对已有数据运行 db:seed/db:reset。
SQLite SQL 不直接应用到 MySQL；换库流程基于当前 schema 建表，保留原迁移用于 SQLite 升级。
Prisma Client 与实际 provider 必须一致；切换后未重启时旧进程仍连接旧库。

## 部署核验

确认新库连接、表行数、班级登录、课表和成绩读取；保留切换前快照。
生产凭据放 .env 或部署密钥中，不提交 Git。完整备份和各形态命令见[数据库管理](database.md)。
Linux 正式包应在 Linux 构建，否则 Prisma engine 可能是宿主平台版本，见[Linux 部署](linux-deploy.md)。
