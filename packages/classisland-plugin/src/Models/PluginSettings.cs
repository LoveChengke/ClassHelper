using CommunityToolkit.Mvvm.ComponentModel;

namespace ClassHelper.ClassIslandPlugin.Models;

/// <summary>
/// 插件设置。
///
/// 存储由 ClassIsland 负责：插件入口把它保存在 <c>PluginConfigFolder/Settings.json</c>
/// （**不要**放在插件安装目录，那里不会随档案备份、升级时还会被清掉）。
/// 因此这里必须继承 <see cref="ObservableObject"/> 并让每个属性都走 <c>SetProperty</c>：
/// ClassIsland 通过监听 <c>PropertyChanged</c> 来即时保存。
/// </summary>
public class PluginSettings : ObservableObject
{
    private string _serverUrl = "http://127.0.0.1:4000";
    private string _deviceToken = "";
    private string _deviceKey = "";
    private bool _autoReport = true;
    private int _reportIntervalSeconds = 60;
    private bool _uploadSchedule = true;
    private bool _mirrorSchedule = false;
    private bool _receiveNotifications = true;
    private int _notificationDurationSeconds = 8;
    private int _notificationPollSeconds = 10;
    private bool _speechEnabled = false;
    private bool _showDebugInfo = false;

    /// <summary>
    /// 班级小助手后端地址，例如 <c>http://127.0.0.1:4000</c>。
    /// </summary>
    public string ServerUrl
    {
        get => _serverUrl;
        set => SetProperty(ref _serverUrl, value);
    }

    /// <summary>
    /// 设备令牌（形如 <c>chci_...</c>）：在班级小助手 Web 端「ClassIsland 联动」页面生成。
    /// </summary>
    public string DeviceToken
    {
        get => _deviceToken;
        set => SetProperty(ref _deviceToken, value);
    }

    /// <summary>
    /// 本机标识（首次生成后固定）：服务端据此把同一台机器识别为同一设备，重装插件不会产生重复设备。
    /// </summary>
    public string DeviceKey
    {
        get => _deviceKey;
        set => SetProperty(ref _deviceKey, value);
    }

    /// <summary>
    /// 是否自动上报：启动后、课表变化时、以及每隔 <see cref="ReportIntervalSeconds"/> 秒各上报一次。
    /// </summary>
    public bool AutoReport
    {
        get => _autoReport;
        set => SetProperty(ref _autoReport, value);
    }

    /// <summary>
    /// 定时上报间隔（秒），最小 15 秒。
    /// </summary>
    public int ReportIntervalSeconds
    {
        get => _reportIntervalSeconds;
        set => SetProperty(ref _reportIntervalSeconds, Math.Clamp(value, 15, 3600));
    }

    /// <summary>
    /// 是否把 ClassIsland 的课表同步到班级小助手。
    /// 关闭后仍会上报"当前上什么课"的状态，只是不再写课表。
    /// </summary>
    public bool UploadSchedule
    {
        get => _uploadSchedule;
        set => SetProperty(ref _uploadSchedule, value);
    }

    /// <summary>
    /// 是否把班级小助手上排好的课表镜像回 ClassIsland
    /// （新建一份名为「班级小助手-&lt;班级名&gt;」的档案课表，不覆盖老师原有的课表）。
    /// </summary>
    public bool MirrorSchedule
    {
        get => _mirrorSchedule;
        set => SetProperty(ref _mirrorSchedule, value);
    }

    /// <summary>
    /// 是否接收老师在班级小助手上发布的提醒，并在 ClassIsland 上弹出。
    /// </summary>
    public bool ReceiveNotifications
    {
        get => _receiveNotifications;
        set => SetProperty(ref _receiveNotifications, value);
    }

    /// <summary>
    /// 提醒轮询间隔（秒），最小 5 秒。
    ///
    /// 插件与后端之间没有长连接（刻意不引入 Socket 依赖），提醒是"轮询取回"的，
    /// 因此这个值就是**老师按下发送到教室弹出之间的最大延迟**。
    /// 单独一个轻量轮询（只查待提醒，不上传课表）比把上报间隔改小划算得多。
    /// </summary>
    public int NotificationPollSeconds
    {
        get => _notificationPollSeconds;
        set => SetProperty(ref _notificationPollSeconds, Math.Clamp(value, 5, 600));
    }

    /// <summary>
    /// 默认提醒显示时长（秒）；老师在下发时可以单独指定更长的时长。
    /// </summary>
    public int NotificationDurationSeconds
    {
        get => _notificationDurationSeconds;
        set => SetProperty(ref _notificationDurationSeconds, Math.Clamp(value, 1, 120));
    }

    /// <summary>
    /// 提醒弹出时是否语音朗读（沿用 ClassIsland 的语音设置与语音提供方）。
    /// </summary>
    public bool SpeechEnabled
    {
        get => _speechEnabled;
        set => SetProperty(ref _speechEnabled, value);
    }

    /// <summary>
    /// 是否在设置页显示调试信息（最后一次上报结果、课表条目数等），排查问题时打开。
    /// </summary>
    public bool ShowDebugInfo
    {
        get => _showDebugInfo;
        set => SetProperty(ref _showDebugInfo, value);
    }

    /// <summary>
    /// 兼容旧配置：反序列化后把 DeviceKey 补齐（首次运行时由服务生成）。
    /// </summary>
    public void Normalize()
    {
        ServerUrl = (ServerUrl ?? "").Trim().TrimEnd('/');
        DeviceToken = (DeviceToken ?? "").Trim();
        DeviceKey = (DeviceKey ?? "").Trim();
        ReportIntervalSeconds = Math.Clamp(ReportIntervalSeconds, 15, 3600);
        NotificationDurationSeconds = Math.Clamp(NotificationDurationSeconds, 1, 120);
        NotificationPollSeconds = Math.Clamp(NotificationPollSeconds, 5, 600);
    }

    /// <summary>是否已经配置好（地址 + 令牌都填了）。</summary>
    public bool IsConfigured =>
        Uri.TryCreate(ServerUrl, UriKind.Absolute, out _) && DeviceToken.StartsWith("chci_", StringComparison.Ordinal);
}
