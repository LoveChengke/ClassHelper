---
title: 版本迭代与发布
description: 版本单一来源、本地与发布文件名、验证和发布同步。
---

# 版本迭代与发布

日常文档/代码维护不自动改版本。版本唯一修改入口是 scripts/version.mjs；先执行 pnpm version:check。
正式新发布执行 pnpm version:bump patch|minor|major，指定固定版本的本地重构建保持版本不变。
版本落点由脚本清单决定，不另维护“文件数/落点数”。

## 构建与验证

```bash
pnpm version:check
pnpm lint
pnpm typecheck
pnpm check:icons
pnpm docs:check
pnpm verify:e2e
pnpm verify:v14
pnpm verify:courseware
pnpm build:desktop
pnpm verify:desktop
pnpm --filter @classhelper/web-admin build
pnpm verify:web:isolated
pnpm dist:all
pnpm verify:packaged --exe "releases/client/<版本>/安装包/ClassHelper-<版本>-x64-portable.exe" --offline
```

以上按发布改动范围执行；显式 --visual 才是桌面视觉验收。测试数量和结果必须来自本次输出。
完整边界见[验收](testing.md)。同号本地重构建先保留可恢复副本，最新包核验完成后按用户要求清理旧归档。
2026-10-18 工作区清理后，1.4.0 仅保留当前 client/server 目录和当前更新日志/校验清单。

## 产物与文件名

| 本地构建产物                                                                | GitHub Release 上传名                      |
| --------------------------------------------------------------------------- | ------------------------------------------ |
| releases/client/<版本>/安装包/ClassHelper-<版本>-x64-setup.exe              | ClassHelper-<版本>-x64-client-setup.exe    |
| releases/client/<版本>/安装包/ClassHelper-<版本>-x64-portable.exe           | ClassHelper-<版本>-x64-client-portable.exe |
| releases/server/<版本>/安装包/ClassHelper 服务端-<版本>-x64-setup.exe       | ClassHelper-<版本>-x64-server-setup.exe    |
| releases/server/<版本>/linux-x64/classhelper-server-linux-x64-<版本>.tar.gz | 同名                                       |

Linux 还需同名 .tar.gz.sha256。正式 Linux 包在 Linux runner 运行 pnpm dist:server:linux；
Windows 上的交叉构建仅作验证，可能缺目标平台的 Prisma engine。
构建中间物可再生成，不将 win-unpacked、server staging 或解包副本当交付物保留。

## 更新日志与校验

releases/ReleaseNotes-<版本>.md 维护本批包的功能、升级须知、实际验证范围与文件清单。
它描述该构建批次，不能把之后的源码功能写成旧包已经包含。
SHA256SUMS-<版本>.txt 用上传名记录各文件哈希；本地查验必须先按上表映射，不能因为本地文件没带 client/server 后缀就判断丢包。
可在 PowerShell 对 client/server 安装包运行 Get-FileHash -Algorithm SHA256，将三项实际结果按上传名写入清单。
不要仅对客户端目录做重定向而漏掉服务端；Linux 行待 CI 完成后同步。

## 发布同步

完成验证和本地更新日志后，检查 diff，按用户授权提交和推送 master；不要把其他未完成改动一并提交。
将三个 Windows 包复制到独立的 .cache/release-staging/<版本>/，使用上传名，避免通配符混入别的版本。
先准备当前 Windows SHA256 清单并随 Release 上传。创建 Release 时显式 --target master 或明确提交，说明用 --notes-file。
ClassIsland 插件已退役，不再上传插件资产。

```bash
# <版本> 和提交均替换为本次实际值
gh release create v<版本> --target master --title "ClassHelper v<版本>" --notes-file releases/ReleaseNotes-<版本>.md
gh release upload v<版本> <三个已按上传名暂存的EXE> releases/SHA256SUMS-<版本>.txt
```

推送 v* tag 触发 release-linux-server.yml，按 tag 检出，在 Ubuntu 构建并上传 Linux 包、独立 .sha256，合并跨组件清单。
等待 Actions 成功，再下载 Linux 文件和最终 SHA256SUMS 同步回本地；检查清单的 Windows 行仍与本次文件一致。
如需重跑，可手动运行该 workflow，指定准确 tag 和 attach=true。master 修复不会自动改变旧 tag 指向。

官网和文档站由 pages.yml 拼装同一个站点：官网根、文档 /docs/。文档版本徽标读根 package.json，
官网和下载页兜底版本由 version 脚本维护。Linux workflow 与 Pages 是独立流水线，分别确认结果。
官网行为变化同步 README 与相应帮助章节，功能索引放[源码索引](../reference.md)。

## 已发布版本与回滚

已公开且用户安装的版本建议发补丁版本修复，避免同号不同内容使更新缓存/忽略版本与摘要失配。
用户明确要求固定版本重构建时，按要求保持版本，并清楚区分本地包和远端资产；不自动改远端 tag/Release。
仅说明或文档错误直接修改说明/文档；线上故障按对应部署形态从完整备份恢复。
