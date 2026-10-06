---
title: 安装服务端
description: 用 Windows 安装包、Linux 一键脚本、Docker 或源码把班级小助手服务端跑起来。
---

# 安装服务端

服务端是整个系统的中心：它存数据、发实时推送，**并且顺带托管 Web 管理端**（所以老师那一端不用单独装东西）。

四种装法按场景选，任选一种即可：

| 方式                              | 适合                                   | 一句话                          |
| --------------------------------- | -------------------------------------- | ------------------------------- |
| [Windows 安装包](#windows-安装包) | 学校机房、教师办公电脑、单机即完整系统 | 双击 exe，装完自动启动          |
| [Linux 一键安装](#linux-一键安装) | 学校已有 Linux 服务器                  | 一条命令，带 systemd 与运维命令 |
| [Docker](#docker)                 | 云服务器、想跟别的服务共用一台机器     | `docker compose up -d`          |
| [源码跑](#从源码跑开发模式)       | 想改代码、想先看看它长什么样           | `pnpm dev`                      |

## Windows 安装包

### 生成安装包

安装包不入库（体积大），从 [Releases](https://github.com/LoveChengke/classhelper/releases) 直接下载
`班级小助手服务端-<版本>-x64-setup.exe` 即可。要自己打：

```bash
pnpm dist:server                    # 首次会执行一次 npm install（约 2 分钟）
pnpm dist:server -- --reuse-deps    # 迭代打包：复用已装依赖，跳过 npm install
```

产物：

| 路径                                                                  | 说明                                        |
| --------------------------------------------------------------------- | ------------------------------------------- |
| `releases/server/<版本>/安装包/班级小助手服务端-<版本>-x64-setup.exe` | 安装程序（约 62 MB，NSIS）                  |
| `releases/server/<版本>/免安装/`                                      | 免安装目录，拷到任意 Windows x64 机器即可跑 |

包内自带 Node 运行时、后端产物、Web 管理端产物、生产依赖、迁移 SQL、随机 `JWT_SECRET` 的 `.env`
与启停脚本。目标机器**不需要预先安装 Node.js**。

### 安装与启动

双击安装程序即可，**不需要管理员权限**（当前用户级安装）。

- 安装目录：`%LOCALAPPDATA%\Programs\ClassHelperServer`
- 静默安装：`"班级小助手服务端-<版本>-x64-setup.exe" /S`
- 开始菜单：启动服务 / 停止服务 / 重启服务 / 打开管理端 / 使用说明 / 卸载
- 自动加入当前用户开机自启

装完服务会自动启动并完成首次初始化：数据库为空则执行随包迁移建表 → 创建管理员账号 →
`http://127.0.0.1:4000/` 就是 Web 管理端。

常用脚本（都在安装目录里）：

```cmd
start.cmd     :: 启动并等待就绪（已在运行则直接返回）
stop.cmd      :: 按 PID 精确停止
restart.cmd   :: 重启
status.cmd    :: 查看状态与 HTTP 探针结果
```

机房主机这种无人值守的机器，建议以**管理员身份**跑一次 `install-service.cmd`，
把服务注册成开机启动的计划任务（比注册表 Run 更稳）：

```cmd
install-service.cmd     :: schtasks /Create /SC ONSTART /RL HIGHEST
uninstall-service.cmd   :: 删除计划任务
```

安装目录结构与配置见[生产部署指南](../management/production.md)；
安装程序里的默认管理员口令**第一次登录后必须改掉**。

## Linux 一键安装

从 Release 下载 `classhelper-server-linux-x64-<版本>.tar.gz`（以及旁边的 `.sha256`），连同
`install.sh` 一起拷到服务器：

```bash
scp releases/server/<版本>/linux-x64/classhelper-server-linux-x64-*.tar.gz \
    install.sh verify-linux.sh root@<主机>:/tmp/

ssh root@<主机> 'bash /tmp/install.sh --check'          # 先体检，不改任何东西
ssh root@<主机> "printf '%s\n' '<管理员密码>' | bash /tmp/install.sh --yes --admin-password-stdin \
    --package /tmp/classhelper-server-linux-x64-*.tar.gz"
```

安装器会装好内置 Node、把程序放到 `/opt/classhelper`、写好 systemd 单元、
把 `classhelper` 运维命令软链到 `/usr/local/bin/`。之后：

```bash
classhelper status      # 服务状态
classhelper doctor      # 一整套自检（配置软链、权限、依赖完整性…）
classhelper backup      # 立即备份
classhelper upgrade     # 升级到最新 Release（自动校验 sha256）
```

完整的目录布局、配置项、升级回滚、反向代理与故障排查见 [Linux 部署与运维](../management/linux-deploy.md)。

## Docker

```bash
cd deploy
cp .env.example .env          # 至少改 JWT_SECRET
docker compose up -d          # 默认 SQLite 单容器，数据卷挂在本机
```

要 MySQL 就用 `docker-compose.yml`（带一个 MySQL 服务），只想要单容器 SQLite 用
`docker-compose.sqlite.yml`。细节见[生产部署指南](../management/production.md)。

## 从源码跑（开发模式）

想改代码或只想先看看，用这条路。需要 **Node ≥ 20.19** 与 **pnpm 11**。

```bash
pnpm install
cp packages/server/.env.example packages/server/.env    # 至少改 JWT_SECRET
pnpm db:generate
pnpm --filter @classhelper/server db:deploy             # 应用数据库迁移
pnpm build:shared                                       # 必须先构建 shared，否则后面会 ERR_MODULE_NOT_FOUND
pnpm db:seed                                            # 写演示数据（会清空业务表）
pnpm dev                                                # 后端 4000 + Web 端 5173 一起起
```

演示账号见 [README 的「默认账号与种子数据」](https://github.com/LoveChengke/classhelper#readme)；
**演示口令只用于本地开发，别带到真实环境**。

| 端口 | 用途                                                     |
| ---- | -------------------------------------------------------- |
| 4000 | 后端 REST + Socket.IO + （构建后）Web 管理端静态托管     |
| 5173 | Web 管理端开发服务器（`/api`、`/socket.io` 代理到 4000） |
| 5174 | 桌面客户端渲染进程开发服务器                             |

> 改动 `packages/shared` 之后必须 `pnpm build:shared`（或让它跑着 watch）——
> 三端都从它的 `dist` 导入。

## 装完之后

打开 `http://<服务器地址>:4000/`，用管理员账号登录。下一页：
[认识 Web 管理端](web-admin.md)。
