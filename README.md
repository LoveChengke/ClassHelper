<!--markdownlint-disable MD033 MD041-->

<div align="center">

# <img src="build/classhelper.png" width="30" height="30" alt="" /> ClassHelper

<img src="docs/images/web-dashboard.jpg" alt="ClassHelper · Web 管理端仪表盘" />

[![正式版](https://img.shields.io/github/v/release/LoveChengke/ClassHelper?style=flat-square&color=%233fb950&label=正式版)](https://github.com/LoveChengke/ClassHelper/releases/latest)
[![下载量](https://img.shields.io/github/downloads/LoveChengke/ClassHelper/total?style=social&label=下载量&logo=github)](https://github.com/LoveChengke/ClassHelper/releases)
[![Issues](https://img.shields.io/github/issues/LoveChengke/ClassHelper?style=flat-square&logo=github&label=Issues&color=%233fb950)](https://github.com/LoveChengke/ClassHelper/issues)
<br/>
![平台](https://img.shields.io/badge/%E5%B9%B3%E5%8F%B0-Windows%20%7C%20Linux-0078d4?style=flat-square)
![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A5%2020.19-5fa04e?style=flat-square&logo=nodedotjs&logoColor=white)
![Vue](https://img.shields.io/badge/Vue-3-4fc08d?style=flat-square&logo=vuedotjs&logoColor=white)
![Electron](https://img.shields.io/badge/Electron-44-47848f?style=flat-square&logo=electron&logoColor=white)
[![仓库大小](https://img.shields.io/github/repo-size/LoveChengke/ClassHelper?style=flat-square&color=3cb371)](https://github.com/LoveChengke/ClassHelper)

ClassHelper是给中小学班级用的一套信息管理系统。<br/>
**老师发一条通知，教室客户端与灵动岛会实时提醒**；<br/>
学生打开客户端就能看到当天的课表和作业。

#### [🚀 软件下载](https://github.com/LoveChengke/ClassHelper/releases/latest) | [📚 使用文档](docs/index.md) | [🧭 功能与源码索引](docs/reference.md) | [💬 反馈问题](https://github.com/LoveChengke/ClassHelper/issues)

</div>

## 它由什么组成

一份代码，三个交付物：

| 装在哪                  | 是什么                                                               | 谁在用               |
| ----------------------- | -------------------------------------------------------------------- | -------------------- |
| 教师的电脑 / 学校服务器 | **服务端**（Express + Prisma + Socket.IO），同时托管 Web 管理端      | 管理端与客户端       |
| 浏览器（手机也行）      | **Web 管理端**（Vue 3 + Element Plus，PWA 可安装）                   | 老师、班主任、管理员 |
| 教室那台机器 / 学生电脑 | **桌面客户端**（Electron + Vue 3），含「灵动岛」浮窗、托盘、离线缓存 | 教室大屏、学生       |

老师在 Web 端发布内容 → 服务端落库并按班级房间广播 → 客户端与灵动岛实时更新。

## 功能

### Web 管理端（老师 / 管理员）

- [x] 仪表盘：本班人数、课程、课表、作业、通知、成绩一屏概览
- [x] 班级管理：建班自动生成班级码与班级密码，随时更换班主任、按科目配置各科任课老师
- [x] 学生 / 教师管理：单个录入或导入名单（xlsx / xls / csv / tsv）
- [x] 课表管理：日课表、共享作息、1–9 周轮换、群组与临时换课；支持完整 ClassIsland 档案离线导入
- [x] 作业发布：按「所属日期」归类，支持附件与未交名单
- [x] 通知发布：四档优先级；在**上课时段**发紧急通知会被拦下来并要求二次确认
- [x] 叫人：点名某位同学到办公室，分「普通」与「紧急」两级
- [x] 成绩录入：单条 / 批量 / 表格导入，带等级分布与得分率统计；单科排名自动出，可选「各科相加排总分榜」
- [x] 客户端管理：查看设备在线状态与版本，远控关机、重启、注销与锁屏；推送更新可选立即、放学后或空闲时安装
- [x] 数据库管理：连接体检、备份与恢复、SQLite ⇄ MySQL 一键切换
- [x] 权限组：按功能键建组分配账号，支持岗位与年级范围 —— 默认组可自定义，没分组的按角色默认组生效，分组后只按组的并集算
- [x] 大模型助手：一句话解析成待确认的作业 / 通知 / 叫人，点确认才落库
- [x] 通知与作业批量发布：勾多个班一次发完，个别班失败不影响其余班级
- [x] 系统设置：开发者模式、运行诊断、开机自启开关（仅安装形态）
- [x] 关怀模式：字号与控件整体放大
- [x] 手机小屏适配，可「添加到主屏幕」当应用用

### 教室里的桌面客户端

- [x] 班级码登录 —— 学生没有个人账号，一台教室机器代表一个班
- [x] 课表：「今天」时间轴（大时钟 + 正在上 / 下一节 + 距下课倒计时）与周视图
- [x] 作业看板：按科目分卡、可全屏铺满、字号可调，也能切回列表
- [x] 通知中心：未读红点、优先级标签、点击自动标为已读
- [x] 成绩总览：开启个人查询时显示本班成绩与排名；关闭后仅展示服务端集体分析，保留隐私限制
- [x] 教室机器可直接录入作业、勾选未交名单
- [x] 离线优先：断网回退 IndexedDB 缓存，恢复连接后自动同步
- [x] 断网期间错过的通知，重新上线时补弹一次；渲染进程崩了会安静地自己重建窗口
- [x] 浅色 / 深色主题，跟随系统

### 灵动岛（桌面通知浮窗）

- [x] 通知、新作业、叫人都会上岛：经典模式使用胶囊与详情卡，自定义模式使用常驻内容与铃铛
- [x] 多条消息展开为竖排列表，按重要程度排序，放不下时提示去应用内看
- [x] **经典模式上课时段不打扰**：普通通知暂存，普通叫人可点开胶囊，紧急消息立即展开；自定义模式点击铃铛查看
- [x] 尺寸、圆角、字号、主题色、停靠位置（顶部 / 底部 × 左 / 中 / 右）都可以调
- [x] 纯黑 / 毛玻璃 / 主题色渐变三种底
- [x] 触摸屏（希沃白板这类一体机）也能点开
- [x] 自定义常驻岛：分别编辑常态与无通知展开内容，收到消息显示铃铛，点击查看通知

### 部署与运维

- [x] Windows 一键安装：内置 Node 运行时，双击安装、开机自启、自动建库建号
- [x] Linux 一键安装 + `classhelper` 运维命令（systemd 托管，升级 / 回滚 / 备份）
- [x] Docker Compose（MySQL 版与 SQLite 版各一份）
- [x] SQLite 与 MySQL 一键切换，备份与跨库迁移共用同一份 JSON 快照
- [x] 客户端批量更新不依赖外网：安装包由服务端下载缓存，教室机从服务端取，校验 sha256 后空闲时自动装

## 软件截图

> 下面这些图都是脚本把程序真的跑起来截的（`node website/tools/capture-shots.mjs` 与客户端冒烟），不是示意图。

### Web 管理端

<img src="docs/images/web-schedules.jpg" alt="Web 管理端 · 课表管理" />

<details>
<summary>展开其余页面……</summary>

| 页面       | 截图                                                           |
| ---------- | -------------------------------------------------------------- |
| 仪表盘     | <img src="docs/images/web-dashboard.jpg" alt="仪表盘" />       |
| 班级管理   | <img src="docs/images/web-classes.jpg" alt="班级管理" />       |
| 学生管理   | <img src="docs/images/web-students.jpg" alt="学生管理" />      |
| 教师管理   | <img src="docs/images/web-teachers.jpg" alt="教师管理" />      |
| 课表管理   | <img src="docs/images/web-schedules.jpg" alt="课表管理" />     |
| 作业发布   | <img src="docs/images/web-homeworks.jpg" alt="作业发布" />     |
| 通知发布   | <img src="docs/images/web-notifications.jpg" alt="通知发布" /> |
| 成绩录入   | <img src="docs/images/web-grades.jpg" alt="成绩录入" />        |
| 数据库管理 | <img src="docs/images/web-database.jpg" alt="数据库管理" />    |

</details>

### 教室里的客户端

<img src="docs/images/client-schedule.png" alt="桌面客户端 · 课表「今天」时间轴" />

<details>
<summary>展开其余页面……</summary>

| 页面                    | 截图                                                                       |
| ----------------------- | -------------------------------------------------------------------------- |
| 作业看板                | <img src="docs/images/client-homeworks.png" alt="作业看板" />              |
| 通知                    | <img src="docs/images/client-notifications.png" alt="通知" />              |
| 成绩                    | <img src="docs/images/client-grades.png" alt="成绩" />                     |
| 设置 · 灵动岛           | <img src="docs/images/client-settings-island.png" alt="设置 · 灵动岛" />   |
| 设置 · 外观（深色主题） | <img src="docs/images/client-settings-appearance.png" alt="设置 · 外观" /> |

</details>

### 灵动岛

| 形态               | 截图                                                                    | 说明                                            |
| ------------------ | ----------------------------------------------------------------------- | ----------------------------------------------- |
| 新消息胶囊         | <img src="docs/images/island-4-pill.png" alt="新消息胶囊" />            | 非上课时段直接出现，点一下展开                  |
| 点开后的详情       | <img src="docs/images/island-5-clicked.png" alt="详情卡" />             | 标题、内容、时间 + 打开应用 / 标为已读 / 知道了 |
| 多条消息列表       | <img src="docs/images/island-9-list.png" alt="多条消息列表" />          | 按重要程度排序，默认显示三条                    |
| 上课期间的紧急通知 | <img src="docs/images/island-3-urgent.png" alt="紧急通知" />            | 卡片内部红色呼吸光晕，无需点击                  |
| 下课后补弹         | <img src="docs/images/island-2-after-class.png" alt="下课后自动弹出" /> | 上课期间暂存的通知，下课后自动弹出来            |
| 老师叫人           | <img src="docs/images/island-8-call.png" alt="叫人卡片" />              | 「请 XXX 同学找 XXX 老师」                      |
| 新作业             | <img src="docs/images/island-7-homework.png" alt="新作业" />            | 教室机器自己录的那条不会弹给自己                |

### 手机上

<details>
<summary>展开……</summary>

| 场景     | 截图                                                                     |
| -------- | ------------------------------------------------------------------------ |
| 仪表盘   | <img src="docs/images/mobile-dashboard.jpg" alt="手机 · 仪表盘" />       |
| 通知发布 | <img src="docs/images/mobile-notifications.jpg" alt="手机 · 通知发布" /> |

</details>

## 开始使用

| 装在哪                  | 装什么                                      | 从 Releases 里拿                                                            |
| ----------------------- | ------------------------------------------- | --------------------------------------------------------------------------- |
| 教师的电脑 / 学校服务器 | **服务端**（内含 Web 管理端与 Node 运行时） | `ClassHelper-<版本>-x64-server-setup.exe`                                   |
| 教室机器 / 学生电脑     | **学生客户端**                              | `ClassHelper-<版本>-x64-client-setup.exe`，或 `-client-portable.exe` 免安装 |

也可以在官网的[下载页](https://lovechengke.github.io/ClassHelper/download.html)上挑：
选一个版本，四个包排成四张卡，文件名、体积与 SHA256 清单都在那儿 ——
那一页的清单是**当场**读 GitHub Releases 的，显示什么就能下什么。

服务端**装上就算跑起来了**：双击安装程序，建库、建号、开机自启都由它自己办，
装完在浏览器打开 `http://<服务器地址>:4000` 就能登录。教师的电脑、学校的服务器、
一台常年开机的机器都可以装。

Linux 服务器有更省事的路子，一行命令装成 systemd 服务，并带上 `classhelper` 运维命令：

```bash
curl -fsSL -o /tmp/classhelper-install.sh https://raw.githubusercontent.com/LoveChengke/ClassHelper/master/deploy/install.sh && sudo bash /tmp/classhelper-install.sh
```

先体检、不改动系统的话，在末尾加上 `--check`。也可以走 Docker Compose，
完整步骤见[部署指南](docs/management/production.md)与 [Linux 运维手册](docs/management/linux-deploy.md)。

## 获取帮助

- **使用文档**：[docs/](docs/index.md) —— 分四块：第一次装、已经在用了、负责运维、要改代码
- **完整参考**：[docs/reference.md](docs/reference.md) —— 功能口径、REST API、权限矩阵、验收证据
- **遇到问题 / 想提需求**：[提交 Issue](https://github.com/LoveChengke/ClassHelper/issues/new/choose)

## 开发

| 层         | 选型                                                                |
| ---------- | ------------------------------------------------------------------- |
| 后端       | Node.js ≥ 20.19 + Express 5 + Prisma 7（SQLite / MySQL）+ Socket.IO |
| Web 管理端 | Vue 3 + Vite + Element Plus + Pinia                                 |
| 桌面客户端 | Electron 44 + Vue 3 + IndexedDB 离线缓存（含独立的灵动岛渲染进程）  |
| 共享契约   | `packages/shared`：类型、常量、权限矩阵、动效令牌                   |

```bash
pnpm install
cp packages/server/.env.example packages/server/.env   # 至少改 JWT_SECRET
pnpm db:generate
pnpm --filter @classhelper/server db:deploy            # 根 scripts 里没有 db:deploy
pnpm build:shared                                      # 三端与 seed 的前置产物
pnpm db:seed
pnpm dev                                               # 后端 4000 + Web 端 5173
```

`pnpm db:seed` 会写一套演示数据（1 管理员 / 2 教师 / 3 个班 / 15 名学生 / 课表 / 作业 / 通知 / 成绩）：

| 角色                       | 账号          | 密码         |
| -------------------------- | ------------- | ------------ |
| 管理员                     | `admin`       | `admin123`   |
| 教师                       | `teacher1`    | `teacher123` |
| ClassHelper 班级端（班级） | 班级码 `G101` | `123456`     |

- [AGENTS.md](AGENTS.md) —— 工程约定与开发环境注意事项，**改代码前先读它**
- [docs/reference.md](docs/reference.md) —— 功能章节与源码入口索引
- [docs/dev/architecture.md](docs/dev/architecture.md) —— 架构总览

## 致谢

灵动岛的视觉与架构参考 [WinIsland](https://github.com/WinIslandProject/WinIsland)（Windows 上的动态岛）；
动效语言取自 [beUI](https://beui.dev)；产品官网的版式参考 [ClassIsland 官网](https://www.classisland.tech/)。
三端的深色主题、图标与动效令牌都是照这些参考自己实现的，没有引入它们的运行时依赖。

<div align="center">

如果这个项目对你有帮助，欢迎点亮 Star ⭐

</div>

### 客户端维护

支持远程关机、重启、注销与锁屏（管理端确认下发，客户端执行并回执），可查看最近一次执行结果。
统一更新支持立即安装、放学后安装或空闲时安装，支持取消下发。
管理员与教师的默认权限组均可自定义；管理员保留权限管理和系统管理入口。
课件共享：教师可上传教学文件到服务端，按日期与类型归档，仅向本人授课班级开放或推送；班级客户端支持课件目录、离线补收，以及灵动岛传输进度。使用说明见 [课件上传与传输](docs/app/courseware.md)。
