---
title: 架构总览
description: 工作区结构、模块注册、共享契约与数据流。
---

# 架构总览

ClassHelper 是 pnpm workspace：Express/Prisma/Socket.IO 服务端、Vue Web 管理端、Electron 桌面客户端与共享包。
依赖版本以根和各包的 `package.json`、`pnpm-lock.yaml` 为准。文档站和纯静态官网不在 workspace 内。

## 目录与入口

| 路径                                          | 职责                                        |
| --------------------------------------------- | ------------------------------------------- |
| `packages/shared/src/`                        | 类型、权限目录、动效、课表/岛/课件契约      |
| `packages/server/src/app.ts`                  | 探针、限流、中间件、模块挂载、静态 Web 托管 |
| `packages/server/src/index.ts`                | 启动、自检、HTTP、Socket.IO 与退出清理      |
| `packages/server/src/modules/registry.ts`     | 全部启用模块的唯一注册表                    |
| `packages/server/src/lib/`                    | 鉴权范围、日课表解析、周次、快照与系统设置  |
| `packages/server/prisma/`                     | 单一 schema、SQLite 迁移、演示 seed         |
| `packages/web-admin/src/router/`              | Web 路由、标题、图标、权限                  |
| `packages/web-admin/src/config/navigation.ts` | 菜单分组，页面属性读取路由                  |
| `packages/desktop-client/src/main/`           | 窗口、配置、岛、设备代理、更新、课件下载    |
| `packages/desktop-client/src/preload/`        | contextBridge 白名单                        |
| `packages/desktop-client/src/island/`         | 经典岛、自定义运行时、课程与课件提醒        |
| `packages/desktop-client/src/renderer/`       | 主窗口页面、状态、IndexedDB 与岛桥接        |
| `scripts/` / `deploy/`                        | 验证、版本、打包、部署与运维                |
| `docs/` / `website/`                          | 文档站与官网，Pages 构建时拼接              |

## 模块与数据流

功能模块使用 `*.module.ts` 路由、`*.schemas.ts` 校验、`*.service.ts` 业务；新增/下线改 `registry.ts`。
注册表包含教学业务、课件、日课表/时间表/群组、权限、客户端、系统、AI、升级和数据管理模块。
路由与模块总数直接读取注册表，不在文档复制另一份数组。

教师在 Web 提交 → 服务端校验权限、班级和科目范围 → 写数据库 → 事件总线按房间广播 → Web/客户端刷新。
客户端先维护 IndexedDB 缓存，断网读取缓存；主窗口通过 preload 与主进程通信，主进程管理唯一原生岛窗口。
课件先流式上传到服务端文件目录，再由客户端下载、验摘要并独立回执。

客户端统一更新由服务端缓存安装包、校验设备权限并通过心跳下发。客户端下载并校验 SHA256 后，
把安装交给独立的 Windows 原生助手；助手从本机 `updates` 目录运行，再次验包并确认就绪，
主进程复核更新策略后才退出。助手等待旧进程结束、执行安装并检查安装版的新版本及启动状态，
失败写入 `install-result.json` 并尝试恢复客户端；成功仍以新版心跳为最终回执。
排障日志为同目录下的 `install-helper.log`。Windows 构建使用系统 .NET Framework 编译器生成助手，
教室机运行时不需要安装开发工具；助手与安装包均随客户端构建，不能只替换主进程 JS。

更新专项验证使用 `pnpm verify:update-download`、Windows 下的 `pnpm verify:update-installer`。
显式执行 `pnpm verify:client-update:real` 会创建临时数据库、班级和独立应用标识，真实安装并升级
测试副本，再卸载测试安装，报告保存在 `.cache/client-update-real/`；它不属于普通冒烟，
不会使用真实班级或桌面自动化，也不修改根版本号。
传入 `--portable --unicode-paths --prefix-version` 可覆盖便携运行转安装版、中文空格路径和带 `v` 的目标版本号。

## 工程边界

- 三端契约只放 shared，改后先 `pnpm build:shared`。
- 学生不是账号；班级会话读取 `Class`，教师/管理员读取 `User`。
- 功能权限在路由判定，范围与科目权限在 service 判定；前端同规则隐藏入口。
- 课表以关系模型为真值，所有在线启用选择走 `lib/class-plan.ts`；周次走 `lib/term.ts`。
- 作业/通知使用本地 `assignDate`；实时使用 `SOCKET_EVENTS/SOCKET_ROOMS` 和 `emitToClass/emitToSession`。
- 数据库备份清单随模型维护，课件文件另行备份。
- Electron 保留 CSP 与导航限制，桥接只传纯数据；打包凭据门禁不能取消。
- ClassIsland 在线联动已退役，仅保留离线 JSON 导入与设计参考。

完整规则见 [AGENTS.md](https://github.com/LoveChengke/ClassHelper/blob/master/AGENTS.md)。

## 开发启动

```bash
pnpm install
# 复制 packages/server/.env.example 为 .env，并配置独立 JWT_SECRET 与数据库
pnpm db:generate
pnpm --filter @classhelper/server db:deploy
pnpm build:shared
# 只有明确需要重建演示数据时才运行 pnpm db:seed（会清空业务表）
pnpm dev
```

后端 4000、Web dev 5173、桌面 dev 5174、官网 5180、文档预览 5181。
生产服务端托管已构建的 Web 管理端；详见[安装服务端](../get-started/server.md)和[验收](testing.md)。
