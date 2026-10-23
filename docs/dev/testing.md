---
title: 验收与测试
description: 隔离 API、隐藏 UI、后台客户端与显式视觉验收。
---

# 验收与测试

按改动范围选择验证；数量和结果读取本次输出，不沿用历史报告数字。
默认客户端冒烟为后台快速模式；动画、透明度、桌面截图必须显式视觉模式。

## 命令与前置条件

| 命令                                             | 覆盖/前置条件                                                                |
| ------------------------------------------------ | ---------------------------------------------------------------------------- |
| pnpm lint / pnpm typecheck / pnpm check:icons    | 静态检查；typecheck 会先构建 shared                                          |
| pnpm docs:check                                  | docfx 严格构建，需 .NET SDK 与 docfx                                         |
| pnpm verify:e2e                                  | 自动临时 SQLite、种子和带前缀账号，启动随机端口服务；无需真实服务            |
| pnpm verify:web:isolated                         | 同上隔离服务，隐藏 Electron UI 回归；先构建 Web 产物                         |
| pnpm verify:web                                  | 连接已准备测试服务，需 Web 产物和测试管理员；不应指向业务服务                |
| pnpm verify:lifecycle                            | 临时 SQLite 验证权限治理、事务故障回滚、状态机、历史、多轨道、计划哈希和快照 |
| pnpm verify:v14                                  | 临时库验证关系课表、周次、范围、隐私与升级等                                 |
| pnpm verify:courseware                           | 临时库和文件目录的课件专项，不向真实班级推送                                 |
| pnpm verify:client-agent                         | 假系统适配器验证命令、回执和更新策略                                         |
| pnpm verify:client-migrations                    | 临时旧库验证迁移、联动退役与默认组持久化                                     |
| pnpm verify:review-client                        | 无窗口逻辑回归                                                               |
| pnpm verify:review-api / pnpm verify:clients-api | 需明确准备的隔离测试服务，使用 VERIFY_BASE_URL 等脚本参数                    |
| pnpm verify:desktop                              | 先 pnpm build:desktop；隐藏快速检查，独立 userData                           |
| pnpm verify:desktop:online                       | 显式联网，需要测试管理员并创建临时教师/班级                                  |
| pnpm verify:desktop:visual                       | 显式使用桌面，完整岛几何/动画/透明度/截图检查                                |
| pnpm verify:packaged --exe <客户端EXE>           | 默认快速离线，两次启动、packaged=true；--visual 才使用桌面                   |

联网 packaged 使用 --online；调用方须预先准备隔离服务、临时教师和班级并显式注入凭据，该启动器不会自动创建它们。
开发版 verify:desktop:online 则通过 provisionSmokeClass 创建和清理临时身份。--offline 保持离线。
不得回退到真实班级、重置真实密码或向真实班级发测试通知；远控与安装器使用假执行器。
桌面进程超时和失败日志先定位，不能因为一个历史脆弱用例名称就断言当前失败必然正常。

## 常用检查顺序

```bash
pnpm lint
pnpm typecheck
pnpm check:icons
pnpm docs:check
pnpm verify:e2e
pnpm verify:v14
pnpm verify:lifecycle
pnpm verify:client-migrations
pnpm verify:courseware
pnpm build:desktop
pnpm verify:desktop
pnpm --filter @classhelper/web-admin build
pnpm verify:web:isolated
```

仅文档修改只需格式、链接与 docs:check；不因此重打包或占用桌面。
改打包/运行时裁剪还要构建实际副本并跑 packaged；Linux 交付修改需 Linux 真机/CI 验证和 bash 语法检查。

## 故障定位

- 临时服务失败查 .cache/v14-verification 下本次日志；不要改业务 .env 或密码迁就测试。
- 显式联网管理员变量：桌面 ELECTRON_SMOKE_ADMIN/ELECTRON_SMOKE_ADMIN_PASSWORD，Web UI_SMOKE_ADMIN/UI_SMOKE_ADMIN_PASS。
- 视觉用例需要真实桌面与稳定帧，先区分状态未稳定、窗口遮挡和实际回归，再针对原因重跑。
- Element Plus dialog 关闭后 DOM 仍保留，应检查 overlay 的可见状态。
- 本地 HTTP 探测绕过代理；Prisma 生成物和 shared/dist 缺失时先补前置构建。

## 截图

docs/images 为 README/文档展示图；docs/screenshots 为回归留档；website/assets/shots 为官网素材。
只把显式视觉验收采集、人工确认过的正片用作展示，不把窗口对照图或旧失败截图直接发布。
Web 采集入口 `website/tools/capture-shots.mjs`，先准备隔离测试服务和数据。
岛/客户端采集使用 smoke.mjs --visual，并按需 --online；ISLAND_SHOTS_DIR 与 ELECTRON_CLIENT_SHOTS_DIR 指向临时目录。
日常 quick 模式不会生成完整视觉截图，不能把 quick 通过表述为动画/透明度已验证。

权限与年度流程回归入口为 `scripts/verify-lifecycle.mjs`，为子进程指定临时库与测试密钥，不使用业务 .env 的登录凭据。
旧库升级脚本动态读取最新迁移，另建重构前夹具校验 ADMIN 默认组补键、历史 kind 映射、空组保留及重复启动。
事务回滚用 SQLite 触发器模拟历史写入失败，不能通过删除断言或放宽状态规则通过测试。
