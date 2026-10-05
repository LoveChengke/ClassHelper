# 生产部署指南

本文档覆盖三种上线形态，按适用场景选择：

| 形态                  | 适用场景                                     | 产物                                                     | 本机验证情况                           |
| --------------------- | -------------------------------------------- | -------------------------------------------------------- | -------------------------------------- |
| **A. Windows 安装包** | 学校机房、教师办公电脑（单机即完整系统）     | `release-server/班级小助手服务端-<版本>-x64-setup.exe`   | ✅ 已完整实测（静默安装/启停/卸载/UI） |
| **B. Docker + MySQL** | 云服务器、多终端共享一套数据（推荐长期方案） | `deploy/Dockerfile` + `deploy/docker-compose.yml`        | ⚠️ 文件已提供，本机无 Docker 未实测    |
| **C. Linux 原生部署** | 已有 Linux 服务器（systemd，SQLite 或 MySQL） | [`deploy/install.sh`](../deploy/install.sh) + `classhelper` 运维命令             | ⚠️ 本机无 Linux，实机验收见 [linux-deploy.md](linux-deploy.md) §10 |
| **D. 手动部署**       | 已有 Node 环境的服务器、需要自定义           | `pnpm dist:server` 的免安装目录                          | ✅ 免安装目录已实测（163 项端到端）    |

---

## 一、Windows 安装包（形态 A）

### 1.1 生成安装包

```bash
pnpm dist:server          # 首次会执行一次 npm install（约 2 分钟）
pnpm dist:server -- --reuse-deps   # 迭代打包：复用已安装依赖，跳过 npm install
```

产物：

| 路径                                                  | 说明                                            |
| ----------------------------------------------------- | ----------------------------------------------- |
| `release-server/classhelper-server/`                  | 免安装目录，可直接拷到任意 Windows x64 机器运行 |
| `release-server/班级小助手服务端-1.1.0-x64-setup.exe` | 安装程序（约 34 MB，NSIS）                      |

打包内容：内置 **Node 运行时**（目标机无需安装 Node.js）、后端产物、Web 管理端产物、
生产依赖（真实目录，非软链）、迁移 SQL、`.env`（随机 JWT 密钥）、启停脚本。

### 1.2 安装

双击安装程序即可，**无需管理员权限**（当前用户级安装）：

- 安装目录：`%LOCALAPPDATA%\Programs\ClassHelperServer`
- 静默安装：`"班级小助手服务端-1.1.0-x64-setup.exe" /S`
- 开始菜单：启动服务 / 停止服务 / 重启服务 / 打开管理端 / 使用说明 / 卸载
- 桌面：`班级小助手服务端.lnk`（打开管理端）
- 自动加入当前用户开机自启（`HKCU\...\CurrentVersion\Run`）
- 卸载信息注册到「应用和功能」

安装完成后服务会自动启动并完成首次初始化：

1. 数据库为空 → 自动执行随包迁移（`AUTO_MIGRATE=true`）建表
2. 自动创建管理员账号（默认 `admin / admin123`，日志中会提示尽快修改）
3. 打开 http://127.0.0.1:4000/ 即为 Web 管理端

### 1.3 目录与配置

```
%LOCALAPPDATA%\Programs\ClassHelperServer\
├── node.exe              内置 Node 运行时
├── server\dist\          后端程序（入口 index.js）
├── server\prisma\        迁移 SQL（首启动自动执行）
├── web\                  Web 管理端（由后端托管）
├── data\                 classhelper.db + server.pid（备份只需复制此目录）
├── logs\server.log       UTF-8 日志（含请求耗时）
├── .env                  全部配置
├── start.cmd / stop.cmd / restart.cmd / status.cmd
└── install-service.cmd / uninstall-service.cmd
```

常用命令：

```cmd
start.cmd     :: 启动并等待就绪（已在运行则直接返回）
stop.cmd      :: 按 PID 精确停止
restart.cmd   :: 重启
status.cmd    :: 查看状态与 HTTP 探针结果
```

以管理员身份运行 `install-service.cmd` 可注册为**开机启动的计划任务**（等价于系统服务，
比注册表 Run 更稳，适合无人值守的机房主机）：

```cmd
install-service.cmd     :: schtasks /Create /SC ONSTART /RL HIGHEST
uninstall-service.cmd   :: 删除计划任务
```

### 1.4 升级

1. `stop.cmd` 停止服务
2. 备份 `data` 目录
3. 运行新版本安装程序（**覆盖安装会保留原有 `.env`，JWT 密钥与端口设置不变，用户无需重新登录**）
4. `start.cmd` 启动（数据库结构如变更，会在首启动时自动补迁移）

### 1.5 卸载

开始菜单 → 卸载（或 `uninstall.exe`，静默：`uninstall.exe /S`）。

卸载会停止服务、删除快捷方式与注册表项、删除程序文件，并把 `data` 目录重命名为
**`data.backup` 保留**，避免误删数据库；确认不需要后再手动删除。

---

## 二、Docker + MySQL（形态 B，云部署推荐）

> 本机没有 Docker，因此这套文件未在本机实测；结构经过与已验证的产物对照（依赖清单、
> 目录布局、迁移方式与服务端完全一致）。

```bash
cp deploy/.env.example deploy/.env
# 生成 JWT 密钥并填入 deploy/.env
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
```

组成：

| 服务      | 作用                                                                 |
| --------- | -------------------------------------------------------------------- |
| `db`      | MySQL 8.4（utf8mb4、数据卷 `db-data`）                               |
| `migrate` | 一次性任务：安装 mariadb 适配器并执行 `prisma migrate deploy`        |
| `server`  | 后端 + Web 管理端（多阶段构建，仅含生产依赖），暴露 `${SERVER_PORT}` |

要点：

- 服务端容器 `NODE_ENV=production` + `STARTUP_DB_CHECK=true`：**数据库不可用会拒绝启动**
  （避免带病对外服务）；健康检查打 `/readyz`。
- 数据卷：MySQL 用 `db-data`；若坚持用 SQLite，把 `/app/data` 挂成卷即可（见 Dockerfile 注释）。
- 首次启动会按 `INITIAL_ADMIN_USERNAME/PASSWORD` 创建管理员（请在部署后立即改密码）。
- 反向代理上启用 HTTPS：见 `deploy/nginx.conf`，并在服务端环境变量中设置
  `TRUST_PROXY=1`、`CORS_ORIGIN=https://你的域名`。

### 2.1 单容器变体（SQLite，推荐给内存小的机器 / 与别的服务共用一台机器）

`deploy/docker-compose.sqlite.yml` 只跑**服务端一个容器**，不额外起 MySQL：数据落在 Docker 卷
`classhelper-data` 的 `/app/data/classhelper.db`，首次启动由 `AUTO_MIGRATE=true` 自动建表并创建管理员
（`packages/server/src/lib/db-bootstrap.ts` 的"空数据卷"分支）。

```bash
cp deploy/.env.sqlite.example deploy/.env.sqlite   # 填 JWT_SECRET、管理员密码、端口
docker compose -f deploy/docker-compose.sqlite.yml --env-file deploy/.env.sqlite up -d --build
```

适用场景与注意点：

- 机器内存紧张（比如 2G 小机器上还跑着别的服务）时，比 MySQL 变体少一个数据库进程；
- 端口用 `SERVER_PORT` 指定，**别抢占 80/443**（那通常是同机反代占用的）；
- 生产自检会拒绝 `dev.db` 与过短的 `JWT_SECRET`，因此 `DATABASE_URL` 必须是绝对路径且不含 `dev.db`；
- 备份就是整个卷：`docker run --rm -v classhelper-sqlite_classhelper-data:/data -v "$PWD":/backup alpine tar czf /backup/classhelper-db.tar.gz -C /data .`

> `deploy/Dockerfile` 的构建阶段会先跑 `pnpm --filter @classhelper/server run db:generate`：
> 生成产物 `packages/server/src/generated/prisma` 是 gitignored 的，而 `--ignore-scripts` 跳过了
> postinstall，少了这一步 `tsc` 会直接编译失败。

---

## 三、Linux 部署（形态 C，推荐一键安装器）

适用：Ubuntu 20.04+ / Debian 11+ / CentOS 7+ / Rocky / AlmaLinux，任何有 systemd 的服务器
（容器环境用下面的 Docker 形态）。**完整指南见 [linux-deploy.md](linux-deploy.md)**，这里是速查。

### 3.1 一键安装（推荐）

Linux 包由 GitHub Actions 在 ubuntu runner 上构建（平台相关的依赖只能在 Linux 上装），
产物挂在 Release 上；也可以本地 `pnpm dist:server:linux` 后把 tar.gz 拷到服务器。
安装器脚本两个文件都在仓库的 `deploy/` 下：

```bash
# 开发机：做出 Linux 包并连同脚本一起拷到服务器
pnpm dist:server:linux
scp release-server/classhelper-server-linux-x64-*.tar.gz deploy/install.sh deploy/verify-linux.sh \
    root@<服务器>:/tmp/

# 服务器上
bash /tmp/install.sh --check            # 只体检（不需要 root，不改动系统）
sudo bash /tmp/install.sh               # 交互式：选形态 → 选目录 → 选库 → 设初始管理员密码
```

非交互（批量部署 / 验收用）：

```bash
printf '%s\n' 'StrongPass!2026' | sudo bash /tmp/install.sh --yes \
  --dir /srv/classhelper --port 8080 --admin-password-stdin \
  --package /tmp/classhelper-server-linux-x64-1.1.0.tar.gz
```

安装器做的事：识别发行版与包管理器补依赖 → 建系统用户 `classhelper` → 下载包并校验 sha256 →
铺文件（`server/` `web/` `node_modules/` `tools/` `bin/`）→ 下载内置 Node 运行时 →
写 `/etc/classhelper/config.env`（随机 `JWT_SECRET`，权限 600）→ 装 systemd 单元与
`/usr/local/bin/classhelper` → 启动并轮询 `/healthz` 通过为止。全过程写
`/var/log/classhelper/install.log`。

重跑就是**覆盖安装**：`config.env`（含密钥）与 `data/` 保留，已登录用户不会被踢下线。

### 3.2 安装后的布局与运维

```
/opt/classhelper/              程序、node_modules、内置 Node、data/、tools/、bin/
/etc/classhelper/config.env    唯一配置真身（600）；安装目录里的 .env 是指向它的软链
/var/log/classhelper/          install.log + audit.log
/var/backups/classhelper/      备份与程序快照（回滚用）
```

> 为什么安装目录的 `.env` 是软链：Web 端「数据库管理 → 一键切换」改写的是 `<安装目录>/.env`，
> 而 systemd 用 `EnvironmentFile=` 注入同一份配置；两处不是同一个文件时，切换会"看起来成功、
> 重启后又连回旧库"。软链把两者收成一份真身（`classhelper doctor` 会检查它）。

日常运维全部走 `classhelper`（`classhelper help` 看全部）：

| 事项   | 命令                                                                                    |
| ------ | --------------------------------------------------------------------------------------- |
| 状态   | `classhelper status [--json]`                                                           |
| 体检   | `classhelper doctor`（权限 / Node / 服务单元 / 探针 / 数据库 / 磁盘 / 备份）            |
| 改密码 | `classhelper password [用户名]`（交互输入、不回显、不进 shell history）                 |
| 备份   | `classhelper backup`；每日自动：`classhelper backup schedule daily`                     |
| 升级   | `classhelper upgrade [--check]`（下载 + 校验 sha256 + 备份 + 替换 + 探针，失败自动回滚） |
| 回滚   | `classhelper rollback [--list]`                                                         |
| 日志   | `classhelper logs -f`                                                                   |
| 改配置 | `classhelper config set KEY VALUE` / `config show` / `port 8080`                        |
| 换密钥 | `classhelper key rotate`（所有用户需重新登录）                                          |
| 卸载   | `classhelper uninstall`（默认保留配置、数据与备份）                                     |
| 服务   | `classhelper start｜stop｜restart｜reload`                                              |

### 3.3 手动部署（不想用安装器 / 没有 systemd）

没有 systemd 的容器里可以用安装器的"只铺文件"模式，再自己托管进程：

```bash
sudo bash /tmp/install.sh --yes --force --package /tmp/classhelper-server-linux-x64-1.1.0.tar.gz
sudo -u classhelper /opt/classhelper/runtime/node/bin/node /opt/classhelper/server/dist/index.js
```

完全手工也可以（等价步骤，便于排查）：解包后把 `server/` `web/` `node_modules/` `tools/` 铺到安装目录，
配置写到 `/etc/classhelper/config.env`（`JWT_SECRET` 用 `openssl rand -hex 48`），再用
`deploy/classhelper.service` 模板生成单元 —— 注意模板有 5 个占位符
（`__NODE__` `__DIR__` `__USER__` `__CONFIG__` `__CONFIGDIR__`）：

```bash
sudo sed -e "s#__NODE__#/opt/classhelper/runtime/node/bin/node#" \
         -e "s#__DIR__#/opt/classhelper#" -e "s#__USER__#classhelper#" \
         -e "s#__CONFIG__#/etc/classhelper/config.env#" -e "s#__CONFIGDIR__#/etc/classhelper#" \
  deploy/classhelper.service > /tmp/classhelper.service
sudo install -m 644 /tmp/classhelper.service /etc/systemd/system/classhelper.service
sudo systemctl daemon-reload && sudo systemctl enable --now classhelper
```

### 3.4 Nginx + HTTPS

```bash
sudo cp deploy/nginx.conf /etc/nginx/conf.d/classhelper.conf
sudo nano /etc/nginx/conf.d/classhelper.conf     # 改 server_name 与证书路径
sudo nginx -t && sudo systemctl reload nginx
```

`deploy/nginx.conf` 已经处理了最容易踩的两点：`/socket.io/` 的 WebSocket 升级头，
以及 `X-Forwarded-For/X-Forwarded-Proto` 透传（配合配置里的 `TRUST_PROXY=1`，限流才会按真实 IP 统计）。
用 certbot 签证书：

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d class.example.com
```

### 3.5 验收

```bash
sudo bash /tmp/verify-linux.sh --admin-password-stdin <<< 'StrongPass!2026'
# 追加升级 / 回滚链路（会真的替换一次程序文件）：
sudo bash /tmp/verify-linux.sh --full --package /tmp/classhelper-server-linux-x64-1.0.1.tar.gz \
  --admin-password-stdin <<< 'StrongPass!2026'
```

覆盖安装结果、服务探针、API 登录、改密（含审计与回滚）、备份、配置读写、key rotate、
升级与回滚整条链路，末尾打印 `=== 结果：N/N 项通过 ===`。逐条清单见
[linux-deploy.md](linux-deploy.md) 第 10 节。


---

## 四、手动部署（形态 D）

```bash
pnpm install
pnpm build:shared
pnpm --filter @classhelper/server build
pnpm --filter @classhelper/web-admin build
pnpm dist:server -- --reuse-deps      # 得到 release-server/classhelper-server 免安装目录
```

把该目录拷贝到目标机，编辑 `.env`（端口、数据库、密钥、跨域），然后：

```cmd
start.cmd      :: Windows
# 或直接：node server/dist/index.js   （Linux/macOS 用系统 node，见上面的形态 C）
```

数据库初始化二选一：

- 让服务自愈：`.env` 中 `AUTO_MIGRATE=true`（SQLite 首次启动自动建表 + 建管理员）
- 显式迁移：`pnpm db:migrate` / `npx prisma migrate deploy`（MySQL 必须走这条）

---

## 五、环境变量清单

| 变量                                                | 默认                   | 说明                                                      |
| --------------------------------------------------- | ---------------------- | --------------------------------------------------------- |
| `NODE_ENV`                                          | `development`          | `production` 会启用生产校验、HSTS、更严的限流             |
| `HOST` / `PORT`                                     | `0.0.0.0` / `4000`     | 监听地址与端口                                            |
| `DATABASE_PROVIDER`                                 | `sqlite`               | `sqlite` 或 `mysql`                                       |
| `DATABASE_URL`                                      | `file:./prisma/dev.db` | SQLite 相对路径以 `server` 根为基准；MySQL 用连接串       |
| `AUTO_MIGRATE`                                      | `false`                | SQLite 空库时自动执行随包迁移并创建管理员                 |
| `JWT_SECRET`                                        | —                      | **必填**，≥32 位；生产环境仍为示例值会拒绝启动            |
| `JWT_EXPIRES_IN`                                    | `7d`                   | 令牌有效期                                                |
| `CORS_ORIGIN`                                       | `*`                    | 允许来源，多个用逗号分隔；生产建议写具体域名              |
| `TRUST_PROXY`                                       | `false`                | 反向代理层数（Nginx 填 `1`），影响限流与日志中的真实 IP   |
| `RATE_LIMIT_ENABLED`                                | `true`                 | 通用限流（生产 600 次/5 分钟）+ 登录限流（20 次/10 分钟） |
| `STARTUP_DB_CHECK`                                  | `true`                 | 启动校验数据库；生产不可用时直接退出                      |
| `PID_FILE`                                          | —                      | PID 文件路径（安装包启停脚本依赖），相对 `server` 根      |
| `WEB_DIST_DIR`                                      | 自动探测               | Web 管理端产物目录（`../web-admin/dist` 或 `./web`）      |
| `LOG_LEVEL`                                         | `info`                 | `debug` / `info` / `warn` / `error`                       |
| `DEFAULT_CLASS_PASSWORD`                            | `123456`               | 新建班级时班级账号（学生端登录）的默认密码                |
| `DEFAULT_TEACHER_PASSWORD`                          | `123456`               | 新增/重置教师账号的默认密码（管理员录入教师用）           |
| `TERM_START_DATE`                                   | —                      | 第 1 教学周的周一，用于"当前周次"与课表默认视图           |
| `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD` | `admin` / `admin123`   | 空库首启动创建的管理员                                    |

---

## 六、运维

### 6.1 探针与监控

| 端点          | 用途                                                 |
| ------------- | ---------------------------------------------------- |
| `/healthz`    | 存活探针：进程活着即 200（容器 liveness / 守护进程） |
| `/readyz`     | 就绪探针：数据库可连才 200，否则 503（负载均衡摘流） |
| `/api/health` | 详情：环境、数据库、已挂载模块、运行时长             |

### 6.2 日志

- 输出到 stdout/stderr，安装包形态由启停脚本重定向到 `logs\server.log`（UTF-8）。
- 访问日志含方法、路径、状态码与耗时；5xx 记 error、4xx 记 warn。
- 容器形态建议交给 Docker 日志驱动或采集到 ELK/Loki。

### 6.3 备份与恢复

| 形态   | 备份                                                                   | 恢复                     |
| ------ | ---------------------------------------------------------------------- | ------------------------ |
| SQLite | 停止服务后复制 `data/classhelper.db`（Linux：`/opt/classhelper/data`） | 替换该文件后启动         |
| MySQL  | `mysqldump -u classhelper -p classhelper > backup.sql`                 | `mysql ... < backup.sql` |

建议：每日自动备份 + 保留 7 份；变更 `JWT_SECRET` 会导致所有用户重新登录，请勿在无必要时更换。

### 6.4 安全清单（上线前逐项确认）

- [ ] 修改 `admin` 与教师账号的默认密码
- [ ] `JWT_SECRET` 使用随机值（≥48 字节），且妥善保管
- [ ] 公网访问必须经 HTTPS 反向代理（`deploy/nginx.conf` 可直接用）
- [ ] `CORS_ORIGIN` 收敛到具体域名，不要留 `*`
- [ ] `TRUST_PROXY=1` 并确认限流按真实 IP 生效（`/api` 响应头有 `RateLimit`）
- [ ] 数据库账号使用最小权限，仅授权业务库
- [ ] 定期备份并验证可恢复
- [ ] 关注 `/readyz` 与 `logs/server.log` 的 5xx

---

## 七、故障排查

| 现象                                        | 排查方向                                                                                                                                                                                                       |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 浏览器打不开管理端                          | `status.cmd`；`logs\server.log` 是否有启动报错；端口是否被占用                                                                                                                                                 |
| 启动即退出（生产）                          | 数据库不可用（`DATABASE_URL`/MySQL 未就绪）或 `JWT_SECRET` 未按生产要求配置                                                                                                                                    |
| 页面能开但接口 401                          | 令牌过期或更换过 `JWT_SECRET`，重新登录                                                                                                                                                                        |
| 限流误伤（自己人）                          | 反向代理未设 `TRUST_PROXY=1`，导致所有请求都算作代理 IP                                                                                                                                                        |
| 实时推送不生效                              | 反向代理未放行 `/socket.io/` 的 WebSocket 升级（见 nginx 样例）                                                                                                                                                |
| 安装后服务没起来                            | 查看 `logs\server.error.log`；`start.cmd` 会输出就绪等待结果                                                                                                                                                   |
| 数据库文件损坏                              | 从备份恢复 `data/classhelper.db`；SQLite 场景请确保同一时间只有一个服务实例                                                                                                                                    |
| 升级后需要重新登录                          | 说明 `.env` 被覆盖（JWT 密钥变化）；覆盖安装应保留 `.env`，请检查安装目录权限                                                                                                                                  |
| 报 `does not provide an export named ...`   | 安装包内的 `node_modules/@classhelper/shared/dist` 是旧构建（打包机没有先构建 shared）。重新执行 `pnpm dist:server`，该脚本会先构建 shared/server/web 并校验产物新鲜度                                         |
| 报 `node.exe` 不是有效应用 / 服务启动即退出 | 安装包内置的 `node.exe` 被误打成 Electron 可执行文件（打包机在 Electron 宿主里跑 pnpm 时会取到 `process.execPath`）。已由 `scripts/lib/node-runtime.mjs` 修正；可用 `install\node.exe -v` 确认能打印 Node 版本 |
| **Linux**：`systemctl start` 后立刻退出     | `journalctl -u classhelper -n 50`；常见原因：`.env` 里 `JWT_SECRET` 为空/太短、`node` 路径在 unit 里不对（脚本用 `command -v node` 的结果）、`data/` 不可写（`chown classhelper:classhelper`）                 |
| **Linux**：403/500 且日志提示 `EACCES`      | `ProtectSystem=full` 下服务只能写 `ReadWritePaths`；若自定义了数据目录，记得同步改 unit 里的这两项                                                                                                             |
| **Linux**：`npm install` 报网络/代理错误    | 目标机需要能访问 npm registry；离线环境可在别的机器 `npm install --omit=dev` 后把整个 `node_modules` 一起拷过去                                                                                                |
| **Linux**：SQLite 提示 `database is locked` | 同一数据库文件只允许一个服务实例；确认没有重复启动（`systemctl status` + `pgrep -af 'server/dist/index.js'`），需要并发就换 MySQL                                                                              |

---

## 八、性能与容量参考

- 单机 SQLite 形态适合**单校规模**（数千用户、每天数百次写操作），实测 62 项接口与实时推送全部达标。
- 多校区 / 高并发建议切 MySQL，并横向扩容服务端（Socket.IO 需要配置 Redis adapter 才能多实例广播，
  当前为单实例广播；如需多实例请参考 `packages/server/src/realtime/socket.ts` 引入 `@socket.io/redis-adapter`）。
- 静态资源已设置 immutable 长缓存 + gzip；Web 管理端为 SPA，首屏包体约 900 KB（gzip 约 290 KB），
  成绩页含 ECharts 独立分包，按需加载。
