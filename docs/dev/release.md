---
title: 版本迭代与发布
description: 改版本号、跑验收、打安装包、发 GitHub Release、发布文档站——一次完整发布的命令清单。
---

# 版本迭代与发布

## 一条总原则

> **版本号按「发布」迭代，不按「提交」迭代。**

日常的 `feat` / `fix` 提交**不动版本号**。只有当你要产出一批安装包、在 GitHub 上开一个 Release 时，
才走一次完整的版本迭代。理由很实际：安装包、`.cipx`、Docker 镜像 tag、文档站的版本徽标、
更新检查接口全都按版本号对齐；每次提交都动它，等于每天都在发版，用户那边的「检查更新」就废了。

| 算一次发布                              | 不算                         |
| --------------------------------------- | ---------------------------- |
| 攒够一批功能 / 修好一个用户能感知的 bug | 改注释、改文档、重构、加测试 |
| 要给别人一份新安装包                    | 只在自己机器上跑             |
| 插件单独发补丁（只动插件第 4 段版本号） | —                            |

## 版本号写在哪（14 处 / 12 个文件）

同一个版本号分散在 14 个落点上，**手工改必然漏一处**，而漏掉的那处不会报错：

| 文件                                                             | 内容                               |
| ---------------------------------------------------------------- | ---------------------------------- |
| `package.json`                                                   | 单一来源（服务端运行时读它）       |
| `packages/{shared,server,web-admin,desktop-client}/package.json` | 各包的版本                         |
| `deploy/package.runtime.json`                                    | 安装包 / 容器里的运行时依赖清单    |
| `deploy/docker-compose.yml`、`docker-compose.sqlite.yml`         | 镜像 tag 的默认值                  |
| `packages/classisland-plugin/manifest.yml`                       | 插件清单（四段：`x.y.z.0`）        |
| `packages/classisland-plugin/src/Services/BridgeService.cs`      | 插件上报的 `PluginVersion` 常量    |
| `website/index.html` × 3                                         | 官网顶栏徽标 / 首屏芯片 / 页脚     |
| `website/download.html`（`<meta name="ch-version">`）            | 下载页读不到版本清单时的兜底版本号 |

最后两行值得单独说：官网是**纯静态站、没有构建步骤**，没有哪段代码会去读 `package.json`，
所以那几处只能靠脚本一起改 —— 漏了的话首页会一直挂着旧版本号（而那是别人看到的第一眼），
下载页则会给离线访客一串指向**不存在版本**的直链。

所以**改版本号的唯一入口是脚本**：

```bash
pnpm version:check              # 逐处列出并比对，不一致 exit 1
pnpm version:bump patch         # 1.1.2 → 1.1.3
pnpm version:bump minor         # 1.1.2 → 1.2.0
pnpm version:bump major         # 1.1.2 → 2.0.0
pnpm version:check              # 再确认一次
```

脚本按表逐个改写，**任何一处没匹配到或匹配到多处就直接失败退出**，不做"尽力而为"的部分改写。

> 插件版本是 **四段** `x.y.z.0`：前三段跟产品版本走，第 4 段留给"只改插件、不动产品版本"的补丁发布。
> `--bump` / `--set` 会把第 4 段归零；要单独发插件补丁就手工改那两处（清单 + `BridgeService.cs`）。

## 一次完整的发布

下面这一串命令就是全部流程，逐条照抄即可。

### 1. 改版本号

```bash
pnpm version:check
pnpm version:bump patch
```

### 2. 本地体检

```bash
pnpm lint
pnpm typecheck
pnpm check:icons
pnpm docs:check                 # 文档站构建（警告即失败）
```

### 3. 跑验收

```bash
pnpm dev:server                 # 另开一个终端跑着

pnpm verify:e2e
pnpm verify:classisland
pnpm verify:classisland-plugin

pnpm build:desktop && pnpm verify:desktop
pnpm build && pnpm verify:web
```

哪一项红了先看[验收与测试](testing.md)的「失败时先别改代码」——
里面列了几个已知脆弱的用例，它们红不代表代码坏了。

### 4. 打安装包

```bash
pnpm dist:all                   # = dist:server + dist:win + dist:classisland-plugin
```

产物落在 `releases/<组件>/<版本>/`：`安装包/`、`免安装/`、`构建中间/`。
打完之后**对打包副本再验一次**（开发产物通过 ≠ 用户机器上的副本通过）：

```bash
pnpm verify:packaged --exe "releases/client/<版本>/免安装/ClassHelper.exe"
```

> Linux 包**只能在 Linux 上构建**（依赖是平台相关的），所以不在这条命令里 ——
> 它由 GitHub Actions 出，见第 7 步。

### 5. 生成跨组件哈希清单

`releases/SHA256SUMS-<版本>.txt` 是**人读的**（表头 + 体积 + 说明），由发布流程维护，
本地只写 Windows 与插件那几行：

```bash
cd releases/client/<版本>/安装包 && sha256sum *.exe > ../../../SHA256SUMS-<版本>.txt  # 按实际文件名整理
```

（Linux 那一行由 CI 在第 7 步里**合并**进去，不要手工写。）

### 6. 提交并推上去

```bash
git add -A
git commit -m "chore(release): 1.1.3"
git push origin master
```

提交信息用 Conventional Commits + 模块 scope，描述写中文，可多 scope，例如
`fix(island): 胶囊"点不动"的根因——窗口必须始终可激活`。

### 7. 开 Release

上传前先把产物改成 ASCII 名 —— 构建产物是中文名，Release 上的名字是给别人看、要贴进脚本的：

```bash
V=1.1.3
mkdir -p .cache/release-staging
cp "releases/client/$V/安装包/"*-x64-setup.exe    ".cache/release-staging/ClassHelper-$V-x64-client-setup.exe"
cp "releases/client/$V/安装包/"*-x64-portable.exe ".cache/release-staging/ClassHelper-$V-x64-client-portable.exe"
cp "releases/server/$V/安装包/"*-x64-setup.exe    ".cache/release-staging/ClassHelper-$V-x64-server-setup.exe"
cp "releases/classisland-plugin/$V/安装包/ClassHelper.ClassIslandPlugin.cipx" .cache/release-staging/

gh release create v$V --title "v$V" --generate-notes
gh release upload v$V .cache/release-staging/* "releases/SHA256SUMS-$V.txt" --clobber
```

| 构建产物                    | Release 上的名字                             |
| --------------------------- | -------------------------------------------- |
| `<客户端>-x64-setup.exe`    | `ClassHelper-<版本>-x64-client-setup.exe`    |
| `<客户端>-x64-portable.exe` | `ClassHelper-<版本>-x64-client-portable.exe` |
| `<服务端>-x64-setup.exe`    | `ClassHelper-<版本>-x64-server-setup.exe`    |

这三个名字是**外部契约**：README 的「开始使用」表、官网下载页读不到版本清单时拼的兜底直链，
都按它们写；改名要三处一起改。

`gh release create` 会**创建 tag 并推送**，这一步会自动触发
[`release-linux-server.yml`](https://github.com/LoveChengke/classhelper/blob/master/.github/workflows/release-linux-server.yml)
构建 Linux 包（ubuntu runner）。它跑完之后会：

1. 把 `classhelper-server-linux-x64-<版本>.tar.gz` 与 `.sha256` 挂到 Release 上；
2. **把 Linux 那一行合并进** `SHA256SUMS-<版本>.txt`（保留 Windows / 插件那几行）。

> **顺序很重要**：Linux workflow 是在最后一步才去合并 SHA256SUMS 的，
> 所以第 5 步那份清单必须**先上传**。万一手速反了（workflow 先跑完、你后上传），
> 重新跑一次 `gh workflow run release-linux-server.yml -f tag=v1.1.3 -f attach=true` 就能把那一行补回来。

想手动触发（比如只需要重出 Linux 包）：

```bash
gh workflow run release-linux-server.yml -f tag=v1.1.3 -f attach=true
```

### 8. 官网与文档站

**不用做任何事。** 推送 master 时只要 `website/**`、`docs/**`、`scripts/build-pages.mjs` 或
`package.json` 变过，
[`pages.yml`](https://github.com/LoveChengke/classhelper/blob/master/.github/workflows/pages.yml)
就会把两者构建成**同一个** GitHub Pages 站点发出去：

```
https://lovechengke.github.io/ClassHelper/          ← 官网
https://lovechengke.github.io/ClassHelper/docs/     ← 文档站
```

（一个仓库在 Pages 上只有一个站点，所以是拼在一起发的 —— 官网在根、文档站在 `/docs/` 下。）

文档站顶栏的版本徽标取自根 `package.json`，所以第 1 步改完就跟着变了；
官网首屏那排芯片、顶栏徽标与页脚里的版本号，以及下载页那个兜底版本号，
也都是**由 `pnpm version:bump` 一起改的**（它们是那 14 个落点里的四个）。

> 官网的「立即下载」会跳到 `/download.html`，那一页的版本清单是**当场**从 GitHub Releases 读的
> （读不到才退回上面那个兜底版本号），所以发完 Release 不用重新部署那一页 —— 但**兜底值要跟着发版一起改**，
> 不然离线访客点到的就是旧版本的直链。

### 9. 检查

- [ ] Release 页面上四个组件都在，`SHA256SUMS-<版本>.txt` 里 Windows / 插件 / Linux 三种行齐全；
- [ ] 文档站能打开，顶栏版本号是新版；
- [ ] 装一台机器试一遍（或至少跑 `pnpm verify:packaged`）。

## 回滚

发布出去之后发现严重问题：

| 情形                        | 做法                                                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 只是文档 / Release 说明写错 | 直接改 Release 说明或重发文档站（`gh workflow run docs.yml`）                                                           |
| 二进制有问题                | 删掉 Release 与 tag（`gh release delete v1.1.3 --cleanup-tag`），修完重新发；**不要**拿同一个版本号发第二次内容不同的包 |
| 用户已经装了                | 发一个**新版本号**（`pnpm version:bump patch`）修复，不要原地改                                                         |

> 已经发出去的版本号**不要复用**：客户端把它记进「忽略此版本」，服务端与 Web 端各有 30 分钟缓存，
> 同号换内容会让"检查更新"永久失灵。

## 相关

- 文档站本身怎么写的 → [架构总览的目录结构](architecture.md)
- 验收脚本与脆弱用例 → [验收与测试](testing.md)
- 各形态升级的**用户侧**步骤 → [更新与升级](../management/upgrade.md)
