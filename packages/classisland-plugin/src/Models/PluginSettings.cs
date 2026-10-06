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
    // 同步方向（2026-10-06 起）：课表以 ClassHelper为准，**服务端 → 教室自动下发**；
    // 「把教室课表传上去」改为 Web 端的一次性人工动作（点之前会弹警告）。
    // 自动回传会悄悄盖掉老师刚手排的课，所以默认关闭。
    private bool _uploadSchedule = false;
    private bool _mirrorSchedule = true;
    private bool _receiveNotifications = true;
    private int _notificationDurationSeconds = 8;
    private int _notificationPollSeconds = 10;
    private bool _speechEnabled = false;
    private bool _showDebugInfo = false;

    /// <summary>
    /// ClassHelper后端地址，例如 <c>http://127.0.0.1:4000</c>。
    /// </summary>
    public string ServerUrl
    {
        get => _serverUrl;
        set => SetProperty(ref _serverUrl, value);
    }

    /// <summary>
    /// 设备令牌（形如 <c>chci_...</c>）：在 ClassHelper Web 端「ClassIsland 联动」页面生成。
    /// </summary>
    public string DeviceToken
    {
        get => _deviceToken;
        // 在 setter 里就去掉首尾空白：粘贴令牌时带前导空格非常常见，
        // 而 Normalize() 只在启动加载时跑一次 —— 运行期粘进来的脏值会让 IsConfigured
        // 一直为 false，用户看着明明填好了却查不出原因。
        set => SetProperty(ref _deviceToken, (value ?? "").Trim());
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
    /// 是否把 ClassIsland 的课表**自动**同步到 ClassHelper。
    ///
    /// **默认关闭**：课表以 ClassHelper为准，教室这边改完课表不会自己传上去
    /// （否则老师刚在 ClassHelper上排好的课会被教室的旧课表悄悄覆盖）。
    /// 要取教室的课表，请在 Web 端点「从教室机器获取课表」——那是一次显式的人工请求，
    /// 与本开关无关（见 <c>ReportSettingsDto.ScheduleRequested</c>）。
    /// 关闭后仍会上报"当前上什么课"的状态。
    /// </summary>
    public bool UploadSchedule
    {
        get => _uploadSchedule;
        set => SetProperty(ref _uploadSchedule, value);
    }

    /// <summary>
    /// 是否把 ClassHelper上排好的课表镜像回 ClassIsland
    /// （新建一份名为「ClassHelper-&lt;班级名&gt;」的档案课表，不覆盖老师原有的课表）。
    ///
    /// **默认开启**：这是现在课表同步的主方向。
    /// </summary>
    public bool MirrorSchedule
    {
        get => _mirrorSchedule;
        set => SetProperty(ref _mirrorSchedule, value);
    }

    /// <summary>
    /// 是否接收老师在 ClassHelper上发布的提醒，并在 ClassIsland 上弹出。
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
        TryGetServerUri(out _) && DeviceToken.StartsWith("chci_", StringComparison.Ordinal);

    /// <summary>
    /// 解析服务器地址，**只接受 http/https 绝对地址**。
    ///
    /// 不用裸的 `Uri.TryCreate(..., UriKind.Absolute)`：它会接受 `file://` / `ftp://`，
    /// 那种地址会在发请求时抛一句难以理解的 NotSupportedException，用户根本猜不到是地址填错了。
    /// </summary>
    public bool TryGetServerUri(out Uri uri)
    {
        uri = null!;
        if (!Uri.TryCreate((ServerUrl ?? "").Trim(), UriKind.Absolute, out var parsed)) return false;
        if (parsed.Scheme != Uri.UriSchemeHttp && parsed.Scheme != Uri.UriSchemeHttps) return false;
        uri = parsed;
        return true;
    }
}
