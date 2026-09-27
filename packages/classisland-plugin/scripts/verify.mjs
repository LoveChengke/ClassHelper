/**
 * ClassIsland 联动插件静态校验：`pnpm verify:classisland-plugin`
 *
 * 为什么是"静态"校验：插件要跑起来必须有 ClassIsland 本体，而本机（以及 CI）都没有，
 * 所以这里校验"装不上 / 对不上"的那几类问题 —— 它们不需要运行就能发现：
 *
 *   1. 清单三件套一致性：manifest.yml ↔ csproj ↔ 代码里的版本号；
 *   2. 注册完整性：插件入口、提醒提供方、设置页是否都挂上了（挂漏了功能会"静默消失"）；
 *   3. **接口契约**：C# DTO 的 JSON 字段名 ↔ 服务端路由 / 请求字段，
 *      这类错误（比如 dayOfWeek 写成 dayofweek）在运行时只会表现为"上报成功但课表是空的"，
 *      最难排查，所以专门盯住。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(pluginDir, '..', '..');

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: Boolean(ok), detail });
const read = (relative) => fs.readFileSync(path.join(pluginDir, relative), 'utf8');
const readRepo = (relative) => fs.readFileSync(path.join(repoRoot, relative), 'utf8');

const manifest = read('manifest.yml');
const csproj = read('ClassHelper.ClassIslandPlugin.csproj');
const pluginSource = read('src/Plugin.cs');
const providerSource = read('src/Services/ClassHelperNotificationProvider.cs');
const bridgeSource = read('src/Services/BridgeService.cs');
const clientSource = read('src/Interop/ClassHelperClient.cs');
const settingsPageSource = read('src/Views/BridgeSettingsPage.axaml.cs');
const settingsPageXaml = read('src/Views/BridgeSettingsPage.axaml');
const mapperSource = read('src/Services/ScheduleMapper.cs');
const settingsSource = read('src/Models/PluginSettings.cs');
const serverModule = readRepo('packages/server/src/modules/integrations/integrations.module.ts');
const serverSchemas = readRepo('packages/server/src/modules/integrations/integrations.schemas.ts');
const serverService = readRepo('packages/server/src/modules/integrations/integrations.service.ts');
const sharedTypes = readRepo('packages/shared/src/types.ts');
const sharedConstants = readRepo('packages/shared/src/constants.ts');

/* ------------------------------------------------------------ 1. 清单一致性 */

/** 取 YAML 里某个顶层字段的值（prettier 会把字符串统一成单引号，两种引号都要能剥掉） */
function field(name) {
  const raw = new RegExp('^' + name + ':\\s*(.+?)\\s*$', 'm').exec(manifest)?.[1];
  return raw?.replace(/^['"]|['"]$/g, '');
}

check('manifest.yml 有插件 id', Boolean(field('id')));
check('manifest.yml 声明了入口程序集', Boolean(field('entranceAssembly')));
check('manifest.yml 声明了 apiVersion', /\d+\.\d+\.\d+\.\d+/.test(field('apiVersion') ?? ''));

const assemblyName = /<AssemblyName>([^<]+)<\/AssemblyName>/.exec(csproj)?.[1];
check(
  'entranceAssembly 与 csproj 的 AssemblyName 一致',
  field('entranceAssembly') === assemblyName + '.dll',
  'entranceAssembly=' + field('entranceAssembly') + ' AssemblyName=' + assemblyName,
);

const manifestVersion = field('version');
const codeVersion = /PluginVersion = "([\d.]+)"/.exec(bridgeSource)?.[1];
check(
  '插件版本号在清单与代码里一致',
  Boolean(manifestVersion) && manifestVersion === codeVersion,
  'manifest=' + manifestVersion + ' code=' + codeVersion,
);

check(
  '图标与自述文件按清单约定命名（icon.png / README.md）',
  fs.existsSync(path.join(pluginDir, 'icon.png')) && fs.existsSync(path.join(pluginDir, 'README.md')),
);

/* ------------------------------------------------------------ 2. 注册完整性 */

check(
  '插件入口带 [PluginEntrance] 且继承 PluginBase',
  /\[PluginEntrance\]/.test(pluginSource) && /:\s*PluginBase/.test(pluginSource),
);
check(
  '初始化时注册了提醒提供方',
  /AddNotificationProvider<\s*ClassHelperNotificationProvider\s*>/.test(pluginSource),
);
check('初始化时注册了设置页', /AddSettingsPage<\s*BridgeSettingsPage\s*>/.test(pluginSource));
check('初始化时把联动服务注册为单例', /AddSingleton<\s*BridgeService\s*>/.test(pluginSource));
check('应用启动后才接课程服务（不能更早）', /AppStarted/.test(pluginSource));
check(
  '设置以 JSON 持久化到插件配置目录',
  /PluginConfigFolder/.test(pluginSource) && /Settings\.json/.test(pluginSource),
);

const providerGuid = /ProviderGuidValue = "([0-9A-Fa-f-]{36})"/.exec(providerSource)?.[1];
check('提醒提供方声明了合法 GUID', Boolean(providerGuid));
check(
  '提醒提供方属性引用同一个 GUID 常量',
  /NotificationProviderInfo\(\s*ProviderGuidValue/.test(providerSource),
);
check(
  '提醒提供方会在播完后回执给服务端',
  /Completed/.test(providerSource) && /AckAsync/.test(providerSource),
);

check(
  '设置页带 [SettingsPageInfo] 且声明了页面 id',
  /\[SettingsPageInfo\(/.test(settingsPageSource) && /"班级小助手联动"/.test(settingsPageSource),
);
check(
  '设置页 XAML 的 x:Class 与代码后置类一致',
  settingsPageXaml.includes('x:Class="ClassHelper.ClassIslandPlugin.Views.BridgeSettingsPage"') &&
    /namespace ClassHelper\.ClassIslandPlugin\.Views;/.test(settingsPageSource),
);
check('设置页 XAML 继承 ClassIsland 的设置页基类', /SettingsPageBase/.test(settingsPageXaml));

/* ------------------------------------------------------------ 3. 接口契约 */

// 3.1 路由：插件调用的路径必须都在服务端注册过
const clientPaths = [...clientSource.matchAll(/"(\/classisland\/[a-z-]+)"/g)].map((item) => item[1]);
const registeredPaths = new Set(
  [...serverModule.matchAll(/router\.(?:get|post|patch|delete)\(\s*'(\/classisland\/[a-z-]+)'/g)].map(
    (item) => item[1],
  ),
);
for (const route of [
  '/classisland/report',
  '/classisland/pending',
  '/classisland/ack',
  '/classisland/class-plan',
]) {
  check('服务端注册了 ' + route, registeredPaths.has(route));
}
check(
  '插件调用的路由都存在于服务端',
  clientPaths.length > 0 && clientPaths.every((item) => registeredPaths.has(item)),
  '插件调用=[' + clientPaths.join(',') + ']',
);
check('插件把接口前缀拼成 /api/integrations', clientSource.includes('/api/integrations'));
check('插件用设备令牌头鉴权', clientSource.includes('X-ClassIsland-Token'));

// 3.2 上报请求字段：服务端 zod schema 里出现的字段名，插件必须真的会发
const reportBlock = /export const classIslandReportSchema[\s\S]*?\n\}\);/.exec(serverSchemas)?.[0] ?? '';
const requestFields = [
  'pluginVersion',
  'classIslandVersion',
  'state',
  'schedule',
  'timeLayout',
  'inClass',
  'subject',
  'nextSubject',
  'timeState',
  'periodStart',
  'periodEnd',
  'classPlanLoaded',
  'clientTime',
  'mode',
  'entries',
  'items',
];
const missingRequestFields = requestFields.filter(
  (name) => reportBlock.includes(name) && !new RegExp('\\b' + name + '\\b').test(clientSource),
);
check(
  '上报请求字段都出现在插件 DTO 里',
  missingRequestFields.length === 0,
  missingRequestFields.length > 0 ? '缺少=' + missingRequestFields.join(',') : '',
);

// 3.3 课表条目字段：这些是"上报成功但课表为空"的典型来源
const entrySchema = /export const reportScheduleEntrySchema[\s\S]*?\n\}\);/.exec(serverSchemas)?.[0] ?? '';
const entryFields = [
  'dayOfWeek',
  'startTime',
  'endTime',
  'subject',
  'teacherName',
  'weekParity',
  'weekCountDiv',
  'weekCountDivTotal',
  'planName',
];
const csharpJsonNames = new Set(
  [...clientSource.matchAll(/\[JsonPropertyName\("([^"]+)"\)\]/g)].map((item) => item[1]),
);
const missingEntryFields = entryFields.filter(
  (name) => entrySchema.includes(name) && !csharpJsonNames.has(name),
);
check(
  '课表条目字段服务端 zod 与插件 DTO 对齐',
  missingEntryFields.length === 0,
  missingEntryFields.length > 0 ? '插件缺少=' + missingEntryFields.join(',') : '',
);

// 3.4 插件 DTO 里的 JSON 字段名必须能在共享契约里找到（防错拼）
const knownLocalOnly = new Set(['data', 'success', 'message', 'code']);
const unknownJsonNames = [...csharpJsonNames].filter((name) => {
  if (knownLocalOnly.has(name)) return false;
  return !new RegExp('\\b' + name + '\\b').test(sharedTypes);
});
check(
  '插件 DTO 的 JSON 字段名都能在 @classhelper/shared 里找到',
  unknownJsonNames.length === 0,
  unknownJsonNames.length > 0 ? '疑似拼写错误=' + unknownJsonNames.join(',') : '',
);

// 3.5 课表镜像：服务端给了 Classes[i] 对齐所需的时间，插件必须读
for (const name of ['startTime', 'endTime', 'timeLayouts', 'profileName', 'weekDay', 'weekCountDivTotal']) {
  check('镜像契约字段 ' + name + ' 在插件侧存在', csharpJsonNames.has(name));
}

// 3.6 提醒下发字段（Web 端 → 服务端 → 插件）
const notifySchema = /export const sendNotificationSchema[\s\S]*?\n\}\);/.exec(serverSchemas)?.[0] ?? '';
for (const name of [
  'classId',
  'title',
  'content',
  'durationSeconds',
  'speech',
  'speechContent',
  'saveToNotifications',
  'priority',
]) {
  check('下发提醒字段 ' + name + ' 在服务端 schema 里', notifySchema.includes(name));
}
check(
  '提醒时长有上界（避免老师发出永不消失的提醒）',
  /CLASSISLAND_NOTIFICATION_MAX_DURATION/.test(serverSchemas) &&
    /CLASSISLAND_NOTIFICATION_MAX_DURATION/.test(sharedConstants),
);

// 3.7 实时事件：Web 端订阅的事件名必须在共享契约里声明过
check(
  '共享契约声明了 classisland 实时事件',
  sharedTypes.includes("'classisland:state'") && sharedTypes.includes("'classisland:notification'"),
);
check(
  '服务端广播事件名取自共享常量（不是手写字符串）',
  /SOCKET_EVENTS\.classislandState/.test(serverService),
);

// 3.8 网络层：教室机器（以及开发机）常配了系统代理，而 Windows 的代理设置默认连 127.0.0.1
//     也会走代理，表现为"填了令牌立刻 HTTP 404"（其实是代理自己的错误页，跟本服务无关）。
//     插件必须对本地/内网地址绕开系统代理，否则内网部署必然失败。
check(
  'HttpClient 显式配置代理（不裸用默认行为）',
  /SocketsHttpHandler\s*\{[^}]*Proxy\s*=/.test(clientSource),
);
check(
  '本地/内网地址绕开系统代理',
  /class LocalAwareProxy/.test(clientSource) && /IsBypassed\(Uri host\)/.test(clientSource),
);
check(
  '代理判定覆盖回环与内网网段',
  /IsLoopback/.test(clientSource) &&
    /10\.0\.0\.0\/8/.test(clientSource) &&
    /192\.168\.0\.0\/16/.test(clientSource),
);
check('失败信息带上请求 URL（便于定位代理/网关拦截）', /request\.RequestUri/.test(clientSource));

// 3.9 提醒显示链路：下面几条全是"在真机上跑出来的"，回归时别删
check(
  '提醒在 UI 线程构造并显示（否则 Avalonia 直接抛 Call from invalid thread）',
  providerSource.includes('Dispatcher.UIThread.Post'),
);
check(
  '同一条提醒在播放期间按 id 去重（否则轮询会让它反复弹）',
  providerSource.includes('_playing') && providerSource.includes('HashSet<string>'),
);
check(
  '不再自造图标串（用模板默认图标，紧急用滚动文本表达）',
  // 不再给 CreateTwoIconsMask 传 leftIcon（自造图标串会踩格式/字形坑）
  !providerSource.includes('leftIcon') && providerSource.includes('CreateRollingTextContent'),
);
check(
  'ClassIsland 的占位科目（Subject.Fallback）折算成"没有科目"',
  mapperSource.includes('Subject.Fallback'),
);
check(
  '上课时段暂存非主动通知（与客户端灵动岛同一套规则）',
  providerSource.includes('_deferred') &&
    providerSource.includes('IsImmediate') &&
    providerSource.includes('FlushDeferred') &&
    providerSource.includes('OnBreakingTime'),
);
check(
  '主动通知（紧急 / 叫人）上课时段也立即弹',
  providerSource.includes("\"call\"") && providerSource.includes('notification.Urgent'),
);
check(
  '「上报课表」开关关闭时会在日志里说明（避免被当成"上报失败"）',
  bridgeSource.includes('上报课表到班级小助手') && bridgeSource.includes('开关已关闭'),
);
check(
  '提醒轮询独立于上报间隔（老师发完通知不必等一个上报周期）',
  settingsSource.includes('NotificationPollSeconds') &&
    bridgeSource.includes('_notifyTimer') &&
    bridgeSource.includes('NotificationPollSeconds'),
);

/* ------------------------------------------------------------ 结果 */

const failed = results.filter((item) => !item.ok);
for (const item of results) {
  console.log((item.ok ? '√ ' : '× ') + item.name + (item.detail ? '　（' + item.detail + '）' : ''));
}
console.log('');
console.log(
  'ClassIsland 联动插件静态校验：' + (results.length - failed.length) + '/' + results.length + ' 项通过',
);
if (failed.length > 0) {
  console.log('未通过：\n  - ' + failed.map((item) => item.name).join('\n  - '));
  process.exit(1);
}
