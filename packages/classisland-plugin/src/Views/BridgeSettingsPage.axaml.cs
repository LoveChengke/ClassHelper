using System.ComponentModel;
using System.Runtime.CompilerServices;
using Avalonia.Threading;
using ClassHelper.ClassIslandPlugin.Models;
using ClassHelper.ClassIslandPlugin.Services;
using ClassIsland.Core.Abstractions.Controls;
using ClassIsland.Core.Attributes;
using ClassIsland.Core.Enums.SettingsWindow;
using CommunityToolkit.Mvvm.Input;

namespace ClassHelper.ClassIslandPlugin.Views;

/// <summary>
/// 「班级小助手联动」设置页。
///
/// 页面上的绑定源就是本页自己（<c>DataContext = this</c>）：<see cref="Settings"/> 暴露全部配置项，
/// <see cref="Bridge"/> 暴露运行状态。这样 XAML 里能直接写 <c>{Binding Settings.Xxx}</c>，
/// 不需要再套一层 ViewModel，改配置项时也少一处"两边同步"的机会。
/// </summary>
// 图标用 Fluent 字体的码位（与 ClassIsland 内置设置页写法一致）：未选中/选中同一枚插头图标
[SettingsPageInfo(
    "classhelper.classisland.bridge.settings",
    "班级小助手联动",
    "\uE71B",
    "\uE71B",
    SettingsPageCategory.External)]
public partial class BridgeSettingsPage : SettingsPageBase, INotifyPropertyChanged
{
    public BridgeSettingsPage(PluginSettings settings, BridgeService bridge)
    {
        Settings = settings;
        Bridge = bridge;

        ReportCommand = new AsyncRelayCommand(ReportAsync);
        TestCommand = new AsyncRelayCommand(TestAsync);
        PullCommand = new AsyncRelayCommand(PullAsync);
        MirrorCommand = new AsyncRelayCommand(MirrorAsync);

        InitializeComponent();
        DataContext = this;
        Raise(nameof(StatusText));
    }

    public PluginSettings Settings { get; }

    public BridgeService Bridge { get; }

    public IAsyncRelayCommand ReportCommand { get; }
    public IAsyncRelayCommand TestCommand { get; }
    public IAsyncRelayCommand PullCommand { get; }
    public IAsyncRelayCommand MirrorCommand { get; }

    private PropertyChangedEventHandler? _propertyChanged;

    /// <summary>
    /// 显式实现 <see cref="INotifyPropertyChanged"/>：<c>AvaloniaObject</c> 自带一个同名但类型不同的事件，
    /// 直接声明会遮蔽基类成员。显式实现既不影响 Avalonia 的绑定查找（它按接口取），也不会有歧义。
    /// </summary>
    event PropertyChangedEventHandler? INotifyPropertyChanged.PropertyChanged
    {
        add => _propertyChanged += value;
        remove => _propertyChanged -= value;
    }

    /* ---------------------------------------------------------------- 绑定用的展示文本 */

    /// <summary>一句话结论：还没配 / 已配置 / 已连接 / 连接异常。</summary>
    public string StatusText
    {
        get
        {
            if (!Settings.IsConfigured) return "尚未配置：请填写服务器地址与设备令牌";
            if (!Bridge.IsAttached) return "已填写配置，等待 ClassIsland 课程服务就绪";
            return Bridge.LastReportOk ? "已连接" : "连接异常";
        }
    }

    public string DetailText
    {
        get
        {
            var week = Bridge.LastServerWeek?.ToString() ?? "—";
            return $"最后上报：{Bridge.LastReportAtText}　教学周：{week}　" +
                   $"课表 {Bridge.LastScheduleEntryCount} 节 / 节次 {Bridge.LastTimeLayoutItemCount} 条　" +
                   $"已弹出提醒：{Bridge.NotificationCount} 条";
        }
    }

    /// <summary>调试信息（设置页里打开"显示调试信息"才可见）。</summary>
    public string DebugText
    {
        get
        {
            var lines = new List<string>
            {
                $"服务器地址：{(string.IsNullOrWhiteSpace(Settings.ServerUrl) ? "(未填)" : Settings.ServerUrl)}",
                $"设备令牌：{(string.IsNullOrWhiteSpace(Settings.DeviceToken) ? "(未填)" : Mask(Settings.DeviceToken))}",
                $"设备标识：{(string.IsNullOrWhiteSpace(Settings.DeviceKey) ? "(未生成)" : Settings.DeviceKey)}",
                $"课程服务：{(Bridge.IsAttached ? "已接入" : "未接入")}",
                $"与服务端时钟差：{Bridge.ClientTimeOffsetText}",
                $"ClassIsland 版本：{SafeVersion()}",
                $"配置目录：{PluginConfigFolder}",
            };
            return string.Join(Environment.NewLine, lines);
        }
    }

    /// <summary>设置页所在的插件配置目录（从插件入口拿；拿不到时留空）。</summary>
    private string PluginConfigFolder =>
        ClassIsland.Shared.IAppHost.TryGetService<ClassIsland.Core.Abstractions.PluginBase>()?.PluginConfigFolder ?? "—";

    private static string SafeVersion()
    {
        try { return ClassIsland.Core.AppBase.AppVersion ?? "—"; }
        catch { return "—"; }
    }

    /// <summary>令牌只露头尾，避免设置页截图时把可用凭证泄露出去。</summary>
    private static string Mask(string token) =>
        token.Length <= 14 ? token : $"{token[..12]}…{token[^4..]}";

    /* ---------------------------------------------------------------- 交互 */

    private async Task ReportAsync()
    {
        await Bridge.ReportAsync("手动").ConfigureAwait(true);
    }

    /// <summary>不带课表上报一次：用来快速验证"地址 + 令牌"是否可用，不会因为课表为空而出错。</summary>
    private async Task TestAsync()
    {
        await Bridge.ReportAsync("连接检查", includeSchedule: false).ConfigureAwait(true);
    }

    private async Task PullAsync()
    {
        await Bridge.PullPendingAsync().ConfigureAwait(true);
    }

    private async Task MirrorAsync()
    {
        await Bridge.MirrorScheduleAsync().ConfigureAwait(true);
    }

    private void OnSettingsChanged(object? sender, PropertyChangedEventArgs args)
    {
        // 影响上报链路的改动需要立刻重建定时器；纯界面项（如"显示调试信息"）不用管
        if (args.PropertyName is nameof(PluginSettings.ServerUrl)
            or nameof(PluginSettings.DeviceToken)
            or nameof(PluginSettings.AutoReport)
            or nameof(PluginSettings.ReportIntervalSeconds)
            or nameof(PluginSettings.ReceiveNotifications)
            or nameof(PluginSettings.NotificationPollSeconds))
        {
            Bridge.RestartTimer();
        }

        Raise(nameof(StatusText));
        Raise(nameof(DebugText));
    }

    private void OnBridgeChanged(object? sender, PropertyChangedEventArgs args)
    {
        // Bridge 的属性变化可能来自线程池（HttpClient 回调），绑定必须在 UI 线程上更新
        if (Dispatcher.UIThread.CheckAccess())
        {
            RaiseStateProperties();
        }
        else
        {
            Dispatcher.UIThread.Post(RaiseStateProperties);
        }
    }

    private void RaiseStateProperties()
    {
        Raise(nameof(StatusText));
        Raise(nameof(DetailText));
        Raise(nameof(DebugText));
    }

    private void OnLoaded(object sender, Avalonia.Interactivity.RoutedEventArgs args)
    {
        // 改完地址/令牌/间隔要重建定时器，否则"改了设置但上报节奏还是旧的"
        Settings.PropertyChanged += OnSettingsChanged;
        // 运行状态（上一次上报结果 / 待弹出提醒数）变了要刷新状态卡片
        Bridge.PropertyChanged += OnBridgeChanged;
    }

    private void OnUnloaded(object sender, Avalonia.Interactivity.RoutedEventArgs args)
    {
        Settings.PropertyChanged -= OnSettingsChanged;
        Bridge.PropertyChanged -= OnBridgeChanged;
    }

    private void Raise([CallerMemberName] string? propertyName = null) =>
        _propertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));
}