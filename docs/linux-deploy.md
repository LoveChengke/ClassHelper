# Linux 部署与运维指南

本文覆盖服务端在 Linux 上的**一键安装**与日常运维（`classhelper` 命令）。
适用：Ubuntu 20.04+ / Debian 11+ / CentOS 7+ / Rocky Linux / AlmaLinux 8+（自动识别 apt / yum / dnf）。

不想看长文的话，最短路径是这两条命令：

```bash
sudo bash install.sh --package /path/to/classhelper-server-linux-x64-1.1.0.tar.gz
sudo classhelper status
```

---

## 1. 三种形态怎么选

| 形态 | 适合 | 命令 | 说明 |
| --- | --- | --- | --- |
| **直接安装（native）** | 有一台 Linux 服务器/Mini 主机，单机跑 | `install.sh` 选 1 | systemd 管理，自带 Node 运行时，SQLite 或 MySQL |
| **直接安装 + MySQL** | 多终端共享数据、已有 MySQL | `install.sh` 选 2 | 连接串写在配置里；库要先建好 |
| **Docker** | 机器上已有 Docker、想与其他服务隔离 | `install.sh` 选 3 | 用安装包里随带的 Dockerfile 构建镜像 + compose 起容器 |

> 只想先看看这台机器能不能装：`bash install.sh --check`（**不需要 root**，不改动任何东西）。
> Windows 机器用服务端安装包（`pnpm dist:server` 的产物），不需要本文。

---

## 2. 安装包从哪来

Linux 安装包命名固定为：

```
classhelper-server-linux-x64-<版本>.tar.gz          ← install.sh / classhelper upgrade 都认这个名字
classhelper-server-linux-x64-<版本>.tar.gz.sha256   ← 旁边那份校验值
```

它发布在 [GitHub Releases](https://github.com/LoveChengke/ClassHelper/releases) 上。

**为什么 Linux 包要单独出一个**：`@libsql/linux-x64-gnu`、`@prisma/adapter-libsql` 这些依赖是平台相关的，
Windows 开发机上 `npm install` 出来的 `node_modules` 拷到 Linux 跑不起来，因此 Linux 包必须在 Linux 上构建。
仓库里的 [`.github/workflows/release-linux-server.yml`](../.github/workflows/release-linux-server.yml)
就是干这个的（拿 ubuntu runner 跑 `pnpm dist:server:linux`，再把产物挂到对应 Release 上）：

1. 本地照惯例发 Windows 包的 Release（tag 形如 `v1.1.0`）；
2. GitHub → Actions → 「发布 Linux 服务端安装包」→ Run workflow → 填 tag → 运行；
3. 跑完 Release 里会多出 Linux 包与更新后的 `SHA256SUMS-<版本>.txt`。

内网离线分发也可以：在能上网的机器上 `pnpm dist:server:linux`，把 tar.gz 拷进去，
用 `install.sh --package /path/to/xxx.tar.gz --sha256 <哈希>` 安装。

### 没有 Linux 机器时（交叉构建）

`pnpm dist:server:linux` 在非 Linux 上也**能跑**：脚本会用 npm 的 `--os=linux --cpu=x64`
按目标平台解析可选依赖，所以 `@libsql/linux-x64-gnu` 这些"按平台分发"的包会被正确装进来。
适合本地快速打一个包去验证安装与运维流程。已核对过的结论：

| 项 | 结论 |
| --- | --- |
| SQLite 驱动 | ✅ 包内是 `@libsql/linux-x64-gnu` + `linux-x64-musl`，**没有任何 win32 残留** |
| 服务端本体 | ✅ Node + libsql + express + socket.io 都是纯 JS 或已就位的 Linux 原生包 |
| 运维命令 | ✅ `status` / `doctor` / `password` / `backup` / `upgrade` / `rollback` 都不依赖平台差异 |
| Web 端「一键切换数据库」 | ⚠ **可能失败**：这条链路要调 prisma CLI 的 schema engine，CLI 在运行期按平台扫 `@prisma/engines/schema-engine-debian-openssl-3.0.x` 这类路径，而交叉包里只有宿主平台的 `schema-engine-windows.exe` |

所以交叉包**能装、能跑、能验收**，只是那一个 Web 端功能存疑 —— 它会在包内写入 `.cross-built` 标记，
`classhelper doctor` 会据此提示你（不会静默）。**正式发布一律用 GitHub Actions 那条路。**

```bash
# 开发机（Windows 也可以）
pnpm dist:server:linux
# → release-server/classhelper-server-linux-x64-<版本>.tar.gz（+ .sha256）
#   重跑很快：node scripts/dist-server.mjs --platform linux --reuse-deps（复用已装的 node_modules）
```

---

## 3. 一键安装

### 3.1 交互式（推荐第一次用）

```bash
sudo bash install.sh
```

TUI 会依次问：形态 → 安装目录 → 端口 → 数据库 → 初始管理员密码 → 是否要 Nginx 配置 / 放行防火墙。
每一问都有默认值，直接回车即可。

### 3.2 非交互（自动化 / 批量部署）

```bash
# 全部默认：/opt/classhelper、4000 端口、SQLite、内置 Node
sudo bash install.sh --yes --package ./classhelper-server-linux-x64-1.1.0.tar.gz

# 指定目录与端口，从 stdin 传初始管理员密码（不进 argv / shell history）
printf '%s\n' 'MyStrongPass!2026' | sudo bash install.sh --yes \
  --dir /srv/classhelper --port 8080 --admin-password-stdin \
  --package ./classhelper-server-linux-x64-1.1.0.tar.gz

# MySQL 形态
sudo bash install.sh --yes --database mysql --mysql-host 10.0.0.5 --mysql-db classhelper \
  --mysql-user classhelper --mysql-password-stdin \
  --package ./classhelper-server-linux-x64-1.1.0.tar.gz <<< 'MySQL密码'
```

完整参数见 `bash install.sh --help`。要点：

| 参数 | 作用 |
| --- | --- |
| `--package <url｜file://路径>` | 安装包地址（默认从 GitHub Release 取最新版） |
| `--sha256 <哈希>` | 强制校验安装包哈希 |
| `--admin-password-stdin` | 从 stdin 读一行作为初始管理员密码 |
| `--node-source bundled｜system｜tarball` | 内置 Node / 系统 Node / 指定压缩包 |
| `--node-mirror <url>` | Node 下载镜像（默认 `https://npmmirror.com/mirrors/node`） |
| `--node-tarball <url｜路径>` | 内网离线时直接用本地 Node 包 |
| `--with-nginx` / `--open-firewall` | 顺带生成反代配置 / 放行端口 |
| `--yes` | 全默认、不再交互 |
| `--check` | 只体检（无需 root） |
| `--force` | 覆盖已有配置；在无 systemd 的机器上只铺文件不装服务 |

**幂等性**：重复执行就是覆盖安装。已有的 `config.env`（含 `JWT_SECRET`）与 `data/` 一律保留，
用户不会被踢下线；端口与数据库形态也沿用旧配置，不会被改回默认值。

### 3.3 安装器做了什么

1. 识别发行版与包管理器，补齐 `curl / tar / gzip / ca-certificates`（只装缺的）；
2. 创建系统用户与组 `classhelper`（`--system`，nologin）；
3. 建目录、收权限（见下一节）；
4. 下载安装包 → 校验 sha256 → 解压铺文件；
5. 下载 Node（默认走 npmmirror 镜像，从 `SHASUMS256.txt` 同时取版本号与哈希）；
6. 生成 `/etc/classhelper/config.env`（随机 `JWT_SECRET`，权限 600）；
7. 装 systemd 单元、`/usr/local/bin/classhelper`、`/etc/profile.d/classhelper.sh`、logrotate；
8. 启动服务并轮询 `/healthz`，通过后才算安装成功；
9. 全过程写 `/var/log/classhelper/install.log`。

### 3.4 Docker 形态

`install.sh` 选 3（或 `--mode docker`）：用安装包里随带的 `Dockerfile` 直接构建镜像
（包的 `node_modules` 已经是 linux 的真实目录，**构建时不需要联网装依赖**，几十秒出镜像），
然后写一份 `/etc/classhelper/compose.yml` 拉起容器。

```bash
classhelper status          # 走 docker compose ps / logs
classhelper restart         # 重建容器
classhelper password admin  # 通过 docker exec 在容器里执行同一份 admin-cli
classhelper backup          # 容器内做一致性快照再取出来
```

Docker 形态与直接安装的差异：

| | 直接安装 | Docker |
| --- | --- | --- |
| 数据位置 | `<安装目录>/data` | Docker 卷 `classhelper-data` |
| 配置 | `/etc/classhelper/config.env`（systemd 注入） | 同一份文件（compose `env_file`） |
| 升级 / 回滚 | 替换程序文件后重启服务 | 同一套流程：替换构建上下文 → 重建镜像（`classhelper-server:local`）→ `compose up -d --force-recreate` |
| 恢复数据 | `classhelper backup restore <目录>` | 需手工 `docker cp` 回容器（命令里有提示） |
| `backup schedule` | 支持（systemd timer） | 用宿主机 cron 调 `classhelper backup --quiet` |

> Docker 形态的镜像用**稳定标签** `classhelper-server:local`（另打一个 `classhelper-server:<版本>` 便于追溯）。
> 版本号写在 compose 里的话，升级替换完程序文件后那个标签就过期了，`compose up` 会一直沿用旧镜像 ——
> 表现为"升级成功但行为没变"。`classhelper` 自己按 `VERSION` 决定要不要重建镜像。

---

## 4. 目录、权限与配置

```
/opt/classhelper/                 安装目录（--dir 可改）
├── server/                       后端程序（入口 server/dist/index.js）
│   ├── dist/  prisma/            产物 + 迁移 SQL（首启动 AUTO_MIGRATE 自动执行）
│   ├── prisma.config.ts  tsconfig.generate.json    数据库「一键切换」用
├── web/                          Web 管理端（由后端托管）
├── node_modules/                 生产依赖（真实目录，非软链）
├── tools/admin-cli.mjs           离线改密 / 数据库快照工具
├── bin/classhelper               运维命令本体（/usr/local/bin/classhelper 软链到它）
├── runtime/node/                 内置 Node 运行时
├── systemd/ logrotate.d/ profile.d/   模板（安装时拷到 /etc 下）
├── Dockerfile                    Docker 形态构建用
├── data/                         数据库 + Web 端自建快照（备份就是拷这里）
├── logs/                         预留
├── VERSION                       当前版本
├── .installed.json               安装元数据（形态/版本/端口，classhelper 靠它决策）
└── .env  →  /etc/classhelper/config.env    （软链，见下）

/etc/classhelper/                 目录 700，属主 classhelper
└── config.env                    配置文件，**权限 600**，唯一真身
/var/log/classhelper/             安装日志 install.log + 审计日志 audit.log
/var/backups/classhelper/         备份 + 程序快照（回滚用）
```

### 4.1 为什么安装目录里的 `.env` 是软链

Web 端「数据库管理 → 一键切换数据库」在运行中改写的是 **`<安装目录>/.env`**
（`packages/server/src/modules/database/database.service.ts`），而 systemd 是通过
`EnvironmentFile=/etc/classhelper/config.env` 注入环境变量的。dotenv 不覆盖已存在的环境变量 →
如果这两处不是同一份文件，**切换看起来成功、重启后又连回旧库**。

所以安装器把 `<安装目录>/.env` 做成指向 `config.env` 的软链：两种读法落到同一个真身。
`classhelper doctor` 会专门检查这条软链，别手工删掉。

### 4.2 配置项

配置就是一份 `KEY=VALUE` 的 env 文件，systemd / dotenv / `source` 三种读法都兼容
（含空白或 `#` 的值请加双引号）。最常见的几项：

| KEY | 默认 | 说明 |
| --- | --- | --- |
| `PORT` / `HOST` | `4000` / `0.0.0.0` | 监听端口与地址 |
| `DATABASE_PROVIDER` | `sqlite` | `sqlite` 或 `mysql` |
| `DATABASE_URL` | `file:../data/classhelper.db` | SQLite 相对 `<安装目录>/server` 解析；MySQL 是连接串 |
| `JWT_SECRET` | 随机 | 登录令牌签名密钥。**换掉＝所有用户重新登录**（`classhelper key rotate`） |
| `JWT_EXPIRES_IN` | `7d` | 令牌有效期 |
| `CORS_ORIGIN` | `*` | 走域名/反代时建议收敛成 `https://你的域名` |
| `TRUST_PROXY` | `1` | 前面有 Nginx 时保持 1，限流才按真实 IP 统计 |
| `AUTO_MIGRATE` | `true` | 空库首启动自动建表 + 建管理员 |
| `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD` | `admin` / `admin123` | **只在空库首次初始化时生效**，之后改密码用 `classhelper password` |
| `DEFAULT_CLASS_PASSWORD` / `DEFAULT_TEACHER_PASSWORD` | `123456` | 新建班级 / 重置教师时的初始密码 |
| `TERM_START_DATE` | 空 | 第 1 教学周的周一（`YYYY-MM-DD`），影响"当前周次" |

改配置的三种方式（都会先自动备份、改完问你是否重启）：

```bash
sudo classhelper config show                 # 敏感值打码查看
sudo classhelper config get PORT
sudo classhelper config set CORS_ORIGIN https://class.example.com   # 敏感项会改成交互输入
sudo classhelper config edit                 # 用 $EDITOR 直接编辑
sudo classhelper port 8080                   # 改端口的快捷方式
```

> 手工改也可以（`vim /etc/classhelper/config.env`），但记得改完 `classhelper restart`，
> 并确认权限仍是 600。

---

## 5. `classhelper` 运维命令

安装后可直接使用（`/usr/local/bin/classhelper`）。除 `help` / `version` / `completion` 外都需要 root。

### 5.1 查看与诊断

```bash
classhelper status              # 服务状态、版本、端口、数据库、各类路径
classhelper status --json       # 同上，机器可读（接监控用）
classhelper doctor              # 完整体检：权限 / Node / 服务单元 / 探针 / 数据库 / 磁盘 / 备份
classhelper logs -f             # 实时日志（= journalctl -u classhelper -f）
classhelper logs -n 200 --since "1 hour ago"
classhelper logs --unit classhelper-backup     # 看定时备份的日志
```

`doctor` 会把每一项标成 `✔` / `✘`，失败项后面直接跟修复建议，例如：

```
  ✘ 安装目录 .env 是指向配置真身的软链
  ✔ Node 运行时可用且 ≥20.19（v22.20.0）
  ✘ 最近 7 天内有备份（无）
建议依次处理：
  · ln -sfn /etc/classhelper/config.env /opt/classhelper/.env（Web 端「一键切换数据库」依赖它）
  · classhelper backup；长期可用 classhelper backup schedule daily
```

### 5.2 改密码

```bash
sudo classhelper password                 # 改 admin
sudo classhelper password teacher1        # 改指定教师
sudo classhelper password --list          # 列出可登录账号与班级账号（含是否已设密码）
sudo classhelper password --class G101    # 改某个班的班级密码（学生端登录用）
```

安全约定（照要求逐条落实）：

- 密码**交互输入、不回显**；不接受命令行传参，因此不会进 shell history、也不出现在 `ps` 里；
- 强度校验：≥8 位，小写/大写/数字/符号至少 3 类，不得与用户名相同，常见弱口令直接拒绝；
  需二次确认，连续 3 次不合规即退出（密码不变）；
- 改前把**原密码哈希**备份到 `/var/backups/classhelper/password-<时间戳>.json`（权限 600），
  写入失败或写入后复核不通过会**自动回滚**原哈希；
- 全过程写审计日志，**审计里只有"谁对谁做了什么、结果如何"，没有密码**；
- 自动化可以用管道传入（仍不进 history）：

```bash
printf '%s\n%s\n' "$NEW_PW" "$NEW_PW" | sudo classhelper password admin
```

> 顺带说明：改密码不需要重启服务（登录时读库校验）；已登录的会话仍有效，
> 要让所有会话立刻失效用 `classhelper key rotate`。

### 5.3 备份与恢复

```bash
sudo classhelper backup                       # 备份配置 + 数据库
sudo classhelper backup --note "升级前" --keep 7
sudo classhelper backup list
sudo classhelper backup restore 20261005-033000       # 用某个备份覆盖当前配置与数据（会先停服务）
sudo classhelper backup schedule daily        # 每天 03:30 自动备份（systemd timer，保留 7 份）
sudo classhelper backup schedule off
```

- 备份落在 `/var/backups/classhelper/<时间戳>[-说明]/`：`config.env` + `classhelper.db` + `meta.json`，
  目录 700、文件 600；
- SQLite 用 `VACUUM INTO` 做**一致性快照**（服务在跑也安全，比直接 `cp` 可靠）；
- MySQL 用 `mysqldump --single-transaction`（密码经 `MYSQL_PWD` 传给子进程，不进 argv）；
- `restore` 前会先自动备份现状，恢复对象是配置与数据（不是程序）；
- 程序文件快照（回滚用）在 `/var/backups/classhelper/rollback/`，是另一类东西，`backup list` 会分开列。

### 5.4 升级与回滚

```bash
sudo classhelper upgrade --check          # 只检查有没有新版本（查 GitHub Release）
sudo classhelper upgrade                  # 升到最新版
sudo classhelper upgrade --version 1.2.0  # 升到指定版本
sudo classhelper upgrade --url ./classhelper-server-linux-x64-1.0.1.tar.gz --sha256 <哈希>   # 内网离线
sudo classhelper upgrade --url <包> --force        # 强制重装同一版本

sudo classhelper rollback --list          # 看有哪些程序快照
sudo classhelper rollback                 # 回滚到最近一份（会问一次确认）
```

`upgrade` 的完整链路（任一步失败都不改动程序文件）：

```
解析目标版本 → 下载 → 校验 sha256 → 备份数据与配置 → 快照当前程序文件 →
停服 → 替换程序文件（mv 原子替换，data/ 配置/ 运行时原地不动）→ 起服 → 轮询 /healthz
   ↘ 失败：自动用刚才的快照回滚并重新起服，再告诉你失败原因
```

两点必须知道：

1. **升级不会回滚数据库结构**。如果新版执行过迁移，回滚程序前要确认旧版还能读新库，
   必要时用 `classhelper backup restore` 连数据一起回退；
2. 替换程序文件用的是"改名 + 就位"而不是删除重写 —— 升级时正在运行的就是 `bin/classhelper` 自己，
   必须先改名再放新文件，运行中的进程继续读旧 inode，否则会读到半个脚本。

### 5.5 服务与配置

```bash
sudo classhelper start | stop | restart | reload    # reload 与 restart 同义（服务端不支持热重载）
sudo classhelper port                               # 看当前端口
sudo classhelper port 8080                          # 改端口（顺带提示放行防火墙）
sudo classhelper config show [--reveal]
sudo classhelper config set KEY VALUE
sudo classhelper key rotate                         # 轮换 JWT_SECRET（所有用户需重新登录）
```

### 5.6 其它

```bash
classhelper version
classhelper help
source <(classhelper completion bash)     # 补全（安装时已装到 /usr/share/bash-completion）
```

### 5.7 卸载

```bash
sudo classhelper uninstall
```

会依次问：保留配置？保留数据？保留备份？默认全部保留 —— 数据与配置会被**搬到**
`/var/backups/classhelper/uninstall-<时间戳>/`，然后才删除程序目录，不会悄悄丢数据。

```bash
sudo classhelper uninstall --yes      # 不问，用默认（保留配置/数据/备份）
sudo classhelper uninstall --purge    # 全删（含备份与数据），不可恢复
```

---

## 6. 环境变量文件

安装器会写 `/etc/profile.d/classhelper.sh`（内容见
[`deploy/profile.d/classhelper.sh`](../deploy/profile.d/classhelper.sh)）：

```sh
export CLASSHELPER_HOME=/opt/classhelper
export CLASSHELPER_CONFIG=/etc/classhelper/config.env
export CLASSHELPER_LOG_DIR=/var/log/classhelper
export CLASSHELPER_BACKUP_DIR=/var/backups/classhelper
export PATH=$PATH:$CLASSHELPER_HOME/bin
```

新登录的 shell 自动生效；当前会话要手工 `source /etc/profile.d/classhelper.sh`。
`classhelper` 命令本身装在 `/usr/local/bin`（软链），所以**不登录也照样能用**。

---

## 7. 反向代理与 HTTPS（公网部署必做）

```bash
sudo bash install.sh --with-nginx     # 或者安装后手工：
sudo cp deploy/nginx.conf /etc/nginx/conf.d/classhelper.conf
```

要点：

- `client_max_body_size 12m`（表格导入最大 8MB，base64 后约 11MB）；
- Socket.IO 需要 `Upgrade` / `Connection` 头与较长的 `proxy_read_timeout`（模板里已配）；
- 配置里保持 `TRUST_PROXY=1`，并把 `CORS_ORIGIN` 收敛成你的域名；
- 证书用 certbot 或你自己的证书，装好后 `nginx -t && nginx -s reload`。

---

## 8. 故障排查

| 现象 | 先查什么 |
| --- | --- |
| 服务起不来 | `classhelper doctor` → `classhelper logs -n 100`。常见：端口被占用、MySQL 连接串错、`data/` 权限 |
| 装完打不开页面 | `classhelper status` 看探针与监听地址；云服务器还要在**安全组**放行端口 |
| 改了配置没生效 | 是否重启过（`classhelper config set` 会问）；`EnvironmentFile` 的值优先于文件里的同项 |
| Web 端切库后还是连旧库 | `classhelper doctor` 看 `.env` 软链是否被破坏（`ln -sfn /etc/classhelper/config.env <安装目录>/.env`） |
| 升级卡住/失败 | 失败会自动回滚；看 `classhelper logs -n 100`，确认磁盘余量 ≥1GB |
| `classhelper` 命令找不到 | `ls -l /usr/local/bin/classhelper`；被删了就重装或 `ln -sfn <安装目录>/bin/classhelper /usr/local/bin/classhelper` |
| 忘记管理员密码 | `sudo classhelper password admin`（直连数据库，不需要登录） |
| 学生端连不上 | 客户端「服务器地址」填 `http://IP:端口` 或域名；确认没有多余路径与斜杠 |
| CentOS 7 装完立刻退出 | glibc < 2.28，见下面的"已知限制" |

---

## 9. 已知限制

### CentOS 7 / glibc < 2.28

Node 官方的 linux-x64 二进制要求 **glibc ≥ 2.28**，而 CentOS 7 是 2.17 —— 直接装官方包会表现成
"装完服务立刻退出、日志里什么也没有"。安装器会自动检测 glibc，低于 2.28 时改用
[unofficial-builds](https://unofficial-builds.nodejs.org/) 的 **glibc-217** 构建（功能一致，只是编译基线更低）。

但即便这样，个别原生依赖仍可能不兼容，CentOS 7 支持属于**尽力而为**：

- CentOS 7 已于 2024-06 EOL，**新部署请用 Rocky Linux 9 / AlmaLinux 9 / Ubuntu 22.04+**；
- 若坚持用 CentOS 7，建议装完立刻跑一遍 `classhelper doctor` 与本文第 10 节的验收清单。

### 其它

- 直接安装形态要求 **systemd**（容器里没有 `/run/systemd/system` 时会明确拒绝；
  容器场景请用 Docker 形态）。
- Docker 形态的数据恢复需要手工 `docker cp`（数据在容器卷里，宿主机上看不到那个文件）；
  `classhelper backup restore` 会给出具体命令。
- `classhelper reload` 等价于 restart（服务端没有 SIGHUP 处理）。
- 升级包只发 x64；arm64 需要自行构建（`node scripts/dist-server.mjs --platform linux` 跑在 arm64 机器上）。

---

## 10. 验收清单

下面这套在干净的 **Ubuntu 22.04** 与 **Rocky Linux 9** 上各跑一遍。
`deploy/verify-linux.sh` 会把第 3~8 步自动跑完并打印 `=== 结果：N/N 项通过 ===`。

### 10.0 准备

```bash
# 在开发机：做出 Linux 包（或在 Actions 里下载）
pnpm dist:server:linux
scp release-server/classhelper-server-linux-x64-*.tar.gz root@<服务器>:/tmp/
scp deploy/install.sh deploy/verify-linux.sh root@<服务器>:/tmp/
```

### 10.1 体检（不需要 root）

```bash
bash /tmp/install.sh --check
```

期望：系统/包管理器/glibc/docker/端口/磁盘逐项列出，末尾「体检通过」。
端口被占用、缺 curl、没有 systemd 都会在这里被点出来。

### 10.2 安装

```bash
sudo bash /tmp/install.sh --yes \
  --package /tmp/classhelper-server-linux-x64-1.1.0.tar.gz \
  --admin-password-stdin <<< 'Verify-Pass-2026!'
```

期望：末尾出现「安装完成」与「服务已就绪 ✅」，并打印管理端地址。

### 10.3 自动验收

```bash
sudo bash /tmp/verify-linux.sh --admin-password-stdin <<< 'Verify-Pass-2026!'
```

覆盖项：

| 分组 | 检查内容 |
| --- | --- |
| 安装结果 | 程序文件、`VERSION`、`.installed.json`、`config.env` 600、配置目录 700、`.env` 软链、内置 Node、`/usr/local/bin/classhelper`、安装/审计日志、profile.d 生效 |
| 服务 | systemd 单元、active、enabled、`/healthz` 200、`status --json` 合法且 healthy |
| 体检 | `classhelper doctor` 无待处理项、`help` / `completion` 可用 |
| API | 用初始密码登录拿 token、带 token 读 `/api/classes` 与 `/api/auth/me` |
| 改密 | 改密成功 → 新密码可登录 → **旧密码被拒** → 原哈希已备份且 600 → 审计有记录且**不含密码明文** → 弱密码被拒 → stdin 结束不卡死 → `restore-hash` 把原密码回滚回来 |
| 备份 | 备份目录/文件/权限、SQLite 快照是合法库文件、`backup list` |
| 配置 | `config get/show`、敏感值打码、读写往返 |
| key rotate | 密钥确实变了且 ≥32 位、服务仍可用、**旧 token 变 401**、重新登录成功 |

追加升级/回滚链路（会真的替换一次程序文件）：

```bash
sudo bash /tmp/verify-linux.sh --full --package /tmp/classhelper-server-linux-x64-1.0.1.tar.gz \
  --admin-password-stdin <<< 'Verify-Pass-2026!'
```

覆盖：升级成功 → 服务恢复 → 配置未被改动 → 产生程序快照 → **坏哈希被拒绝且服务不受影响** →
`rollback` 回到旧版且服务可用。

### 10.4 手工补验（自动化覆盖不到的）

```bash
# ① 浏览器打开 http://<IP>:4000/ ，用 admin 登录，改一次密码再登录
# ② 学生端客户端填 http://<IP>:4000 用班级码 G101/123456 登录，收到一条老师发的通知
# ③ 重跑安装器（幂等性）：sudo bash /tmp/install.sh --yes --package <同一个包>
#    期望：配置与数据保留、JWT_SECRET 不变（已登录用户不被踢下线）
# ④ 卸载：sudo classhelper uninstall --yes
#    期望：服务停止、单元删除、/usr/local/bin/classhelper 消失、
#         数据与配置被搬到 /var/backups/classhelper/uninstall-*/
# ⑤ 重启机器后服务自动起来（systemctl is-enabled classhelper）
```

### 10.5 Rocky 9 的差异点

- 包管理器走 `dnf`，依赖包名与 apt 不同（`install.sh` 已按 `PKG` 分支处理）；
- 默认没有 `curl` 之外的工具时会被补装，注意首次安装需要能访问 dnf 源；
- 防火墙默认是 `firewalld`：用 `--open-firewall` 或手工
  `firewall-cmd --add-port=4000/tcp --permanent && firewall-cmd --reload`；
- SELinux（Enforcing）：服务读写 `/opt/classhelper` 与 `/etc/classhelper` 一般不受影响，
  若日志里出现 `Permission denied` 且路径正常，先 `ausearch -m avc -ts recent` 看是不是 SELinux，
  可以用 `semanage fcontext` 加规则，或临时 `setenforce 0` 验证判断。

---

## 11. 安全清单

- [ ] 改掉默认管理员密码：`classhelper password admin`（**公网部署第一件事**）
- [ ] 公网服务前面加 Nginx + HTTPS，`CORS_ORIGIN` 收敛到具体域名
- [ ] 定期备份：`classhelper backup schedule daily`，并确认备份能恢复（`backup restore` 演练一次）
- [ ] 配置与备份权限：`config.env` 600、`/etc/classhelper` 700、备份目录 700
- [ ] `classhelper doctor` 无待处理项；关注"最近 7 天内有备份"
- [ ] 审计日志（`/var/log/classhelper/audit.log`）随日志轮转保留，必要时接集中日志
- [ ] 只在需要时使用 `--purge`；卸载默认保留数据与备份
- [ ] 升级包一律校验 sha256（`upgrade` 内网分发时也要带 `--sha256`）
