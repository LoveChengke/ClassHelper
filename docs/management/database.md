---
title: 数据库管理
description: 备份与恢复、导出导入、定时备份，以及 Web 管理端里的「数据库管理」模块。
---

# 数据库管理

Web 管理端有一个「数据库管理」页（`/database`，**仅管理员可见**，后端同样 `requireRole('ADMIN')`），
把过去要手工做的数据库运维都收进了界面。

## 它能做什么

| 能力         | 说明                                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 连接状态检测 | 当前类型（SQLite / MySQL）、连通性与延迟、引擎版本、数据体积、16 张表的行数、连接串（MySQL 密码脱敏）                                                  |
| 连接测试     | 对任意目标库试连（切换前的第一步）                                                                                                                     |
| **一键切换** | SQLite ⇄ MySQL：自动「备份当前库 → 改写 schema provider → 生成客户端 / 建表 → 子进程迁移全部数据 → 改写 `.env`」，异步任务带步骤进度，**失败自动回滚** |
| 备份 / 恢复  | gzip JSON 快照存在 `<数据目录>/backups/`；手动备份 / 从备份恢复（整库覆盖）/ 删除                                                                      |
| 定时备份     | enabled + 间隔小时数 + 保留份数，配置存在 `data/database-settings.json`；服务端每 10 分钟检查一次到点任务（**进程不运行不补跑**）                      |
| 快捷导入导出 | 下载快照 JSON（跨库通用）/ 下载数据库文件（仅 SQLite）/ 导入快照（整库覆盖，base64 上传）                                                              |

## 关键设计：只有一种快照格式

**备份、导入导出、跨库迁移共用同一种「JSON 快照」**：

- 16 张表按**拓扑序**导出；
- 恢复时临时**关闭外键检查** —— 因为 `User.classId → Class` 与 `Class.teacherId → User`
  是**互相引用**的，任何排序都会被其中一侧卡死；
- 分批 `createMany` 写入。

因此**任意一份备份都能恢复回任意一种受支持的数据库**（SQLite 备份可以恢复进 MySQL，反之亦然）。

MySQL 的连接测试 / 建表 / 写入依赖随包内置的 `@prisma/adapter-mariadb`，不需要额外安装。

## 三条边界

1. **主库只支持 SQLite 与 MySQL**。Redis 这类内存键值库 Prisma 不支持建表 / 迁移，
   接口层直接 422 拒绝；PostgreSQL 暂未纳入。
2. **切换完成后必须重启服务端**（安装版跑 `restart.cmd`，开发模式重跑 `pnpm dev:server`）才会连上新库。
   切换失败会自动回滚 `schema.prisma`，`.env` 只在**数据全部迁移成功后**才改写。
3. **目标库必须为空**（有表就拒绝）。

> 安装包体积因此从约 34MB 涨到约 62MB：切换需要随包带上 prisma CLI 与 TypeScript 编译器
> （Prisma 7 的生成器产出 `.ts` 源码，切换后要在目标机上编译进 `dist`）。

## 命令行 / SSH 场景的备份

Web 界面适合日常；服务器上更适合用命令。Linux 安装形态有一套现成的：

```bash
sudo classhelper backup                       # 备份配置 + 数据库
sudo classhelper backup --note "升级前" --keep 7
sudo classhelper backup list
sudo classhelper backup restore 20261005-033000     # 用某个备份覆盖当前配置与数据（会先停服务）
sudo classhelper backup schedule daily        # 每天 03:30 自动备份（systemd timer，保留 7 份）
sudo classhelper backup schedule off
```

备份落在 `/var/backups/classhelper/<时间戳>[-说明]/`：`config.env` + `classhelper.db` + `meta.json`，
目录权限 700、文件 600。

- SQLite 用 `VACUUM INTO` 做**一致性快照** —— 服务在跑也安全，比直接 `cp` 可靠得多；
- MySQL 用 `mysqldump --single-transaction`，密码经环境变量传给子进程，**不进 argv**；
- `restore` 前会先自动备份现状；恢复的对象是**配置与数据**，不是程序。

## 其它形态怎么备份

| 形态              | 备份                                                   | 恢复                         |
| ----------------- | ------------------------------------------------------ | ---------------------------- |
| Windows 安装包    | 停服务后复制 `data\` 目录（里面有 `classhelper.db`）   | 替换后启动                   |
| Linux             | `classhelper backup`（见上）                           | `classhelper backup restore` |
| Docker            | 备份挂载出来的数据卷                                   | 还原数据卷                   |
| MySQL（任意形态） | `mysqldump -u classhelper -p classhelper > backup.sql` | `mysql … < backup.sql`       |

**建议**：每日自动备份 + 保留 7 份，并且**定期真的恢复一次**验证备份可用。

> 变更 `JWT_SECRET` 会让所有用户重新登录，无必要时不要换。
> Linux 上换用 `sudo classhelper key rotate`。
