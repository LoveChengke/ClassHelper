# ClassHelper 联动插件

把 [ClassIsland](https://classisland.tech) 与 [ClassHelper](https://github.com/LoveChengke/ClassHelper) 连起来：
让 ClassHelper**读到教室真实的课表与上课状态**，也让老师的提醒**在教室的 ClassIsland 上弹出来**。

## 它能做什么

| 方向                             | 说明                                                                                                        |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| ClassIsland → ClassHelper         | 上报课表与节次时间、上报上课状态（当前科目 / 下一节 / 本节起止时间）                                        |
| ClassHelper → ClassIsland         | 老师在 Web 端下发提醒 → 教室的 ClassIsland 上**全屏弹出**（可语音朗读），播完回执、不重复弹                 |
| ClassHelper → ClassIsland（可选） | 把 ClassHelper上排好的课表**镜像**回 ClassIsland（新建 `ClassHelper-<班级名>` 档案课表，不改动老师原有的课表） |

## 安装

1. 把插件放进 ClassIsland 的插件目录，二选一：
   - 用打包好的 `ClassHelper.ClassIslandPlugin.cipx`：ClassIsland →「设置 → 插件 → 从文件安装」；
   - 或直接把 `ClassHelper.ClassIslandPlugin/` 目录（含 `manifest.yml` 与 dll）丢进插件目录
     （Windows 默认 `%APPDATA%\ClassIsland\Plugins`，便携版在安装目录下的 `Plugins`）。
2. 重启 ClassIsland，在「设置 → 插件」里确认「ClassHelper 联动」已启用。
3. 打开「设置 → ClassHelper 联动」，填入：
   - **服务器地址**：ClassHelper后端地址，例如 `http://127.0.0.1:4000`；
   - **设备令牌**：在 ClassHelper Web 端「ClassIsland 联动」页面为本班新建一台设备后复制（形如 `chci_...`，只显示一次）。
4. 点「立即上报」验证连接状态；状态卡片显示「已连接」即接入成功。

## 配置项（全部在「设置 → ClassHelper 联动」里）

| 配置项                       | 说明                                                                                               |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| 服务器地址                   | ClassHelper后端地址（含端口；末尾斜杠与多余的 `/api` 后缀都会被自动容错）                           |
| 设备令牌                     | 由 Web 端「ClassIsland 联动」页生成；服务端只存 sha256，明文只在页面上出现一次                     |
| 上报课表到 ClassHelper         | 把 ClassIsland 里**已启用**的课表同步过去（合并写入：同星期同时间更新，不产生重复行）              |
| 把班级课表镜像回 ClassIsland | 反方向同步，新建带前缀的档案课表；关闭后仍会照常上报「现在上什么课」                               |
| 自动上报                     | 启动 / 课程事件（上课、下课、放学、状态变化）/ 定时各上报一次；关闭后只能用「立即上报」手动触发    |
| 上报间隔（秒）               | 定时上报间隔，最小 15 秒，教室机器建议 60 秒                                                       |
| 接收 ClassHelper提醒           | **本机总闸**：关掉后本机忽略老师下发的提醒（提醒仍留在班级通知中心）                               |
| 语音朗读                     | 是否允许本机朗读（老师下发时也勾了「语音朗读」才会念，两个条件都满足才出声）                       |
| 默认显示时长（秒）           | 老师未指定时长时用这个值；单条提醒可以在 Web 端单独指定更长的时长                                  |
| 提醒轮询间隔（秒）           | **老师按下发送 → 教室弹出之间的最大延迟**（插件不持有长连接，是轮询取回的），默认 10 秒、最小 5 秒 |
| 显示调试信息                 | 展开设备标识、与服务端的时钟差、配置目录等，排查「为什么同步不上」时打开                           |

设置保存在 `<插件配置目录>/Settings.json`（随 ClassIsland 档案备份走，升级插件不丢）。
改动即时生效 —— 改地址 / 令牌 / 间隔会立刻重建上报定时器，不需要重启 ClassIsland。

> **上课时段策略（与 ClassHelper 客户端同一套规则）**：
> 上课时段里，通知类提醒会**先暂存、下课后自动补弹**；**紧急提醒**与**叫人**属于「主动通知」，立刻弹。
> 暂存期间不回执，服务端会保留这条待提醒。

> **课间**：镜像回 ClassIsland 的课表会自动补上课间 —— **每两节之间**一段
> （上一节下课 → 下一节上课），**最后一节之后不补**（放学）。课间由插件按课目时间算出来，
> 不依赖 ClassHelper那边是否维护节次时间表，因此 ClassIsland 档案里一定有完整作息。

> **两个方向各自需要的开关**：
>
> - 服务端 → ClassIsland（镜像课表）：插件「把班级课表镜像回 ClassIsland」**且** Web 端该设备「镜像课表」都打开；
> - ClassIsland → 服务端（上报课表）：插件「上报课表到 ClassHelper」打开；
>   关着时是正常行为（日志会写「仅状态（本机「上报课表到 ClassHelper」开关已关闭）」），不是上报失败；
> - ClassIsland 里一张课表都没有时不会上报课表（日志会写「ClassIsland 里没有**启用的课表**」）。

> **提醒到底会不会弹，取决于两个开关：**
>
> 1. 教室机器的 **ClassHelper 客户端**在「设置 → 通知显示位置」里选了「只在 ClassHelper 客户端弹」时，
>    服务端根本不会推过来（此时本插件收不到东西，属正常）；
> 2. 本插件的「接收 ClassHelper提醒」关掉时，即使推过来也不弹。
>
> 两者都开着，提醒才会在 ClassIsland 上出现。

## 工作原理（为什么这么写）

- **不用跨进程 IPC，插件内直接读课程服务**：ClassIsland 的 IPC 暴露的是缓存数据，不足以还原课表；
  插件直接读 `ILessonsService`（当前科目 / 状态 / 时间点）与 `IProfileService`（档案里的课表、时间表、科目），
  拿到的才是「教室此刻真实的状态」。
- **「上报即拉取」，不引入 Socket 依赖**：每次上报的返回值里会顺带带一条「尚未确认的提醒」，
  插件收到就交给提醒提供方显示；应用启动时额外拉一次 `pending`，
  补上「教室机器关机期间老师发的通知」。上报间隔本身就是心跳，插件因此少一个长连接故障面。
- **提醒必须由「提醒提供方」发出**：只有通过 `NotificationProviderBase` 发出的提醒，
  才会走 ClassIsland 主界面的全屏特效 / 语音 / 音效那一整套流程，因此插件注册了
  「ClassHelper提醒」提供方（可以在 ClassIsland 的「提醒」设置里整体开关它）。
- **回执时机 = 真的播完**：回执挂在提醒的 `Completed` / `Canceled` 上，
  中途退出 ClassIsland 不会回执，下次上报会重发 —— 既不静默丢提醒，也不会重复弹。
- **镜像时重建时间点**：ClassIsland 的 `ClassPlan.Classes[i]` 必须与时间表里
  **第 i 个 `TimeType == 0`（上课）的时间点**一一对应，
  因此镜像接口为每条课目带上 `startTime` / `endTime`，插件据此重建时间表
  （课间点从服务端的时间表里按起始时刻对齐）。少一个时间点，整份课表就会错位。
- **单双周口径与三端一致**：`WeekCountDiv/WeekCountDivTotal` ⇄ `ALL/ODD/EVEN`
  与 `@classhelper/shared` 的 `weekParityFromDiv` / `weekDivFromParity` 互逆；
  3 周及以上的轮换本系统无法表达，会降级为「每周」并在日志里提示。
- **非破坏性**：镜像只创建 / 更新名字以 `ClassHelper-` 开头的课表与时间表；
  老师手动建的课表不删不改名，同一星期已有启用课表时会在日志里给出重叠提示。

## 上机联调记录（ClassIsland 2.1.0.1 实测）

下面几条都是把插件装进真实 ClassIsland 跑出来的问题与结论，改动理由就写在这里，避免以后被“顺手优化”回去：

1. **提醒内容必须在 UI 线程构造并显示。** 上报回调在线程池上，而提醒模板里的图标是 Avalonia 对象
   （`LucideIconSource → IconSource → AvaloniaObject` 的构造函数会 `Dispatcher.VerifyAccess()`），
   在线程池上直接构造会抛 `Call from invalid thread`，表现就是“ClassHelper 客户端收到了、ClassIsland 毫无反应”。
   现在统一用 `Dispatcher.UIThread.Post` 切回 UI 线程。
2. **同一条提醒在播放期间要按 id 去重。** 服务端在收到回执前会一直把提醒算作“待弹出”，
   而轮询间隔（默认 10 秒）可能小于提醒时长（最长 120 秒）—— 不去重就会一遍遍重复弹。
   只有播完（`Completed`/`Canceled`）才把 id 从“正在播放”里移除并回执。
3. **不要自己拼图标串。** 双图标遮罩模板的默认图标由模板自己创建（`new LucideIconSource("\ue0ff")` 这种**字形字符**），
   自己传 `"fluent(...)"` 之类既可能格式不对、也可能字形不存在。紧急提醒改用 ClassIsland 自带的**滚动文本**正文来表达。
4. **`Subject.Fallback` 是占位符（名字就是 `???`）。** 没有课表时 ClassIsland 会把它挂到
   `CurrentSubject`/`NextClassSubject` 上，直接上报会让 Web 端显示“正在上 ???”，因此上报前归一化成“没有科目”。

实测截图（真机弹出提醒的遮罩）：[普通提醒](../../docs/screenshots/classisland/02-normal-mask.png)、
[紧急提醒](../../docs/screenshots/classisland/01-urgent-mask.png)。

## 构建与打包

```bash
pnpm build:classisland-plugin      # Release 构建（产物：packages/classisland-plugin/bin/Release）
pnpm dist:classisland-plugin       # 追加打包 .cipx 并归集到 releases/classisland-plugin/
pnpm verify:classisland-plugin     # 45 项静态契约校验（清单一致性 / 注册完整性 / DTO ↔ 服务端契约）
```

构建脚本会把 NuGet 缓存与临时目录指到仓库内的 `.cache/`（避免写满 C 盘），
并在打包后自检「清单 / 程序集名 / 版本号」三者一致。

## 开发提示

- 需要 **.NET 8 SDK**；SDK 包固定 `ClassIsland.PluginSdk 2.1.0.1`（2.1.1 起改为 net10.0，
  本插件按 net8.0 交付，因此 2.0.x / 2.1.0.x 都能加载，见 `manifest.yml` 的 `apiVersion`）。
- 设置页是 Avalonia 的 `.axaml`（继承 `SettingsPageBase`）；绑定走运行时解析
  （`AvaloniaUseCompiledBindingsByDefault=false`），因为插件与主程序各自编译，编译期绑定看不到对方类型。
- **开发机没有安装 ClassIsland 本体**，所以插件只能做到编译 + 打包 + 静态校验；
  运行期行为需要在装了 ClassIsland 的机器上按上面的「安装」步骤实测。

## 常见问题

**填好令牌后点「立即上报」，提示 `HTTP 404`（响应不是 ClassHelper的标准格式）**
这台机器上的**系统代理拦了内网请求**。Windows 的代理设置里 `127.0.0.1` 并不在默认绕过列表里，
于是浏览器/插件对「本地服务」的请求也被送到代理，拿到的是**代理自己的 404 错误页**。
插件已对本地/内网地址（localhost、回环、10/172.16-31/192.168、链路本地、无点主机名）**强制直连、绕开系统代理**；
如果仍然报 404，请依次检查：

1. 服务器地址是否写成了别的端口 / 别的机器（提示里会带上实际请求的完整 URL，照着核对最快）；
2. 该地址在浏览器里打开 `<服务器地址>/api/health` 是否返回 `{"success":true,...}`；
3. 反向代理（Nginx 等）是否把 `/api/integrations` 也转发到了后端。

**上报失败，提示「设备令牌无效」**
在 Web 端重置该设备的令牌，然后把新令牌填回插件设置（旧令牌会立即失效）。

**发布提醒后 ClassIsland 没反应，或者要等一会儿才弹**
插件不持有长连接，提醒是**轮询取回**的：默认最多 10 秒（设置页「提醒轮询间隔」可调到 5 秒）。超过这个时间还没弹，按下面逐条排查。

**ClassIsland 上完全不弹提醒**

1. 确认插件设置里打开了「接收提醒」；
2. 确认 Web 端「ClassIsland 联动」页面上该设备是「已接入」状态（停用后服务端会直接 403）；
3. 提醒会在 24 小时后过期，避免教室机器一开机弹出一堆旧通知。

**课表上报了但 ClassHelper上没变化**
确认插件设置里打开了「上报课表到服务端」，且 Web 端该设备的「回传课表」开关也是允许状态。

**镜像开关打开了，但 ClassIsland 的课表没变**
镜像需要 Web 端该设备开启「镜像课表」且班级里已有课表；插件只在**上报时**顺路拉取镜像，
所以打开开关后点一下「立即上报」或等一个上报间隔即可。镜像不会覆盖老师原有的课表。

## 许可

与 ClassHelper仓库一致。
