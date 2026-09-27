using System.Text.Json;
using ClassHelper.ClassIslandPlugin.Models;
using ClassHelper.ClassIslandPlugin.Services;
using ClassHelper.ClassIslandPlugin.Views;
using ClassIsland.Core;
using ClassIsland.Core.Abstractions;
using ClassIsland.Core.Abstractions.Services;
using ClassIsland.Core.Attributes;
using ClassIsland.Core.Extensions.Registry;
using ClassIsland.Shared;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace ClassHelper.ClassIslandPlugin;

/// <summary>
/// 插件入口。
///
/// 职责只有三件：读配置 → 注册扩展（提醒提供方 / 设置页 / 联动服务）→ 在应用启动后接上课程服务。
/// 真正的联动逻辑都在 <see cref="BridgeService"/> 里，入口保持"看一眼就知道装了哪些东西"。
/// </summary>
[PluginEntrance]
public class Plugin : PluginBase
{
    /// <summary>插件设置文件名。存在 <see cref="PluginBase.PluginConfigFolder"/> 下：随档案备份走，升级插件不丢。</summary>
    private const string SettingsFileName = "Settings.json";

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    /// <summary>插件设置。注册成单例后，设置页与 <see cref="BridgeService"/> 拿到的是同一个对象。</summary>
    public PluginSettings Settings { get; private set; } = new();

    /// <summary>联动只接一次（AppStarted 与"运行中启用"两条路都会走到这里）</summary>
    private bool _bridgeStarted;

    public override void Initialize(HostBuilderContext context, IServiceCollection services)
    {
        Settings = LoadSettings();

        // 设置页与联动服务共用一个实例：设置页改了值，服务立刻能看到（不需要重启 ClassIsland）
        services.AddSingleton(Settings);
        services.AddSingleton<BridgeService>();

        services.AddSettingsPage<BridgeSettingsPage>();
        services.AddNotificationProvider<ClassHelperNotificationProvider>();

        // 初始化阶段课程服务还没准备好（它在主机启动流程里才被创建），
        // 因此这里先挂一个"应用已启动"的回调，等到那时再取 ILessonsService 并开始上报。
        var application = AppBase.Current;
        if (application is null)
        {
            Logger?.LogError("班级小助手联动：拿不到 ClassIsland 应用实例，联动未启动");
            return;
        }

        application.AppStarted += (_, _) => StartBridge();

        // 插件是"运行中才被启用"时，AppStarted 早就过去了 —— 主窗口已经存在就直接接一次
        if (application.MainWindow is not null) StartBridge();
    }

    private void StartBridge()
    {
        if (_bridgeStarted) return;
        try
        {
            var lessons = IAppHost.TryGetService<ILessonsService>();
            if (lessons is null)
            {
                Logger?.LogError("班级小助手联动：拿不到课程服务，联动已停用");
                return;
            }

            var bridge = IAppHost.TryGetService<BridgeService>();
            if (bridge is null)
            {
                Logger?.LogError("班级小助手联动：拿不到联动服务，联动已停用");
                return;
            }

            _bridgeStarted = true;
            bridge.Attach(lessons);
            bridge.RestartTimer();
            // 应用刚起来时还没有第一个上报点，先主动拉一次未弹出的提醒（离线期间老师发的通知）：
            // 不这么做的话，最长要等一个上报间隔才会弹出来
            _ = bridge.PullPendingAsync();
            Logger?.LogInformation("班级小助手联动：已接入课程服务（服务器 {Server}）", Settings.ServerUrl);
        }
        catch (Exception exception)
        {
            // 联动失败绝不能把 ClassIsland 本体拖下水
            Logger?.LogError(exception, "班级小助手联动：初始化联动服务失败");
        }
    }

    private ILogger<Plugin>? Logger => IAppHost.TryGetService<ILogger<Plugin>>();

    /// <summary>
    /// 读取设置。首次运行时 <c>DeviceKey</c> 为空，这里补一个随机值并立即落盘 ——
    /// 服务端用它把同一台机器识别为同一设备，重装插件不会堆出重复设备。
    /// </summary>
    private PluginSettings LoadSettings()
    {
        var path = Path.Combine(PluginConfigFolder, SettingsFileName);
        var settings = new PluginSettings();
        try
        {
            if (File.Exists(path))
            {
                var loaded = JsonSerializer.Deserialize<PluginSettings>(File.ReadAllText(path), JsonOptions);
                if (loaded is not null) settings = loaded;
            }
        }
        catch (Exception exception)
        {
            // 配置损坏不该拦住插件加载：用默认值继续，原文件保留供排查
            IAppHost.TryGetService<ILogger<Plugin>>()?.LogWarning(exception,
                "班级小助手联动：读取设置失败，已回退到默认设置（{Path}）", path);
        }

        var needGenerateKey = string.IsNullOrWhiteSpace(settings.DeviceKey);
        settings.Normalize();
        if (needGenerateKey)
        {
            // 机器名 + 随机短码：既是人眼可读的"这台机器"，又不会两台同名机器撞车
            var machine = Environment.MachineName.ToLowerInvariant();
            settings.DeviceKey = $"{machine}-{Guid.NewGuid():N}"[..Math.Min(24, machine.Length + 33)];
        }

        Settings = settings;
        // 落盘：一是固定首次生成的 DeviceKey，二是把缺字段的旧配置补齐成完整文件
        SaveSettings(settings, path);
        // 设置变化时即时保存
        settings.PropertyChanged += (_, _) => SaveSettings(settings, path);
        return settings;
    }

    private static void SaveSettings(PluginSettings settings, string path)
    {
        try
        {
            var folder = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(folder)) Directory.CreateDirectory(folder);
            File.WriteAllText(path, JsonSerializer.Serialize(settings, JsonOptions));
        }
        catch (Exception exception)
        {
            IAppHost.TryGetService<ILogger<Plugin>>()?.LogWarning(exception,
                "班级小助手联动：保存设置失败（{Path}）", path);
        }
    }
}