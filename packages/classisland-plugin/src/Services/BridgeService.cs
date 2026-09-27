using System.ComponentModel;
using System.Runtime.CompilerServices;
using ClassHelper.ClassIslandPlugin.Interop;
using ClassHelper.ClassIslandPlugin.Models;
using ClassIsland.Core;
using ClassIsland.Core.Abstractions.Services;
using ClassIsland.Core.Models.Notification;
using ClassIsland.Shared;
using Microsoft.Extensions.Logging;

namespace ClassHelper.ClassIslandPlugin.Services;

/// <summary>
/// 联动主循环。三件事：
/// 1. <b>上报</b>：应用启动后、课程事件（上课/下课/放学/状态变化）发生时、以及每 N 秒，
///    把"当前上什么课"与（可选的）全量课表推给班级小助手；
/// 2. <b>接收</b>：每次上报的返回值里带一条"尚未确认的下发提醒"，
///    交给 <see cref="ClassHelperNotificationProvider"/> 在 ClassIsland 上弹出；
/// 3. <b>镜像</b>：开启镜像开关时，把班级小助手上排好的课表写回 ClassIsland 档案。
///
/// 为什么用"上报即拉取"而不是长连接：
/// 插件不需要额外的 Socket/WebSocket 依赖（避免程序集隔离带来的加载问题），
/// 而教室机器的上报间隔本身就是心跳 —— 顺路把待提醒带回来，依赖更少、故障面更小。
///
/// 线程约定：HttpClient 回调在线程池上，因此所有跨线程可见的状态都用 <c>lock</c> 或
/// 赋值引用（<c>string</c> / <c>int</c>）保护，属性变化通过 <see cref="PropertyChanged"/> 通知设置页。
/// </summary>
public sealed class BridgeService : INotifyPropertyChanged, IDisposable
{
    private readonly PluginSettings _settings;
    private readonly ILogger<BridgeService> _logger;
    private readonly ClassHelperClient _client = new();
    private readonly object _gate = new();

    private ILessonsService? _lessons;
    private Timer? _timer;
    private Timer? _notifyTimer;
    private bool _disposed;
    private bool _reporting;
    private bool _pulling;
    private bool _eventsHooked;

    public BridgeService(PluginSettings settings, ILogger<BridgeService> logger)
    {
        _settings = settings;
        _logger = logger;
    }

    public event PropertyChangedEventHandler? PropertyChanged;

    /// <summary>上报结果变化时触发（设置页据此刷新）。</summary>
    public event EventHandler? StateChanged;

    /// <summary>需要把提醒丢给提醒提供方去显示。</summary>
    public event EventHandler<PushNotificationDto>? NotificationReceived;

    /* ---------------------------------------------------------------- 供设置页绑定的状态 */

    private string _lastReportMessage = "尚未上报";

    /// <summary>最近一次上报的结果描述。</summary>
    public string LastReportMessage
    {
        get => _lastReportMessage;
        private set => SetField(ref _lastReportMessage, value);
    }

    private bool _lastReportOk;
    public bool LastReportOk
    {
        get => _lastReportOk;
        private set => SetField(ref _lastReportOk, value);
    }

    private DateTimeOffset? _lastReportAt;
    public DateTimeOffset? LastReportAt
    {
        get => _lastReportAt;
        private set
        {
            if (SetField(ref _lastReportAt, value)) Raise(nameof(LastReportAtText));
        }
    }

    /// <summary>供界面直接显示的"最后上报时间"。</summary>
    public string LastReportAtText => LastReportAt is null
        ? "从未"
        : LastReportAt.Value.LocalDateTime.ToString("yyyy-MM-dd HH:mm:ss");

    private int _lastScheduleEntryCount;
    /// <summary>最近一次上报里的课表条目数。</summary>
    public int LastScheduleEntryCount
    {
        get => _lastScheduleEntryCount;
        private set => SetField(ref _lastScheduleEntryCount, value);
    }

    private int _lastTimeLayoutItemCount;
    /// <summary>最近一次上报里的节次数量。</summary>
    public int LastTimeLayoutItemCount
    {
        get => _lastTimeLayoutItemCount;
        private set => SetField(ref _lastTimeLayoutItemCount, value);
    }

    private int? _lastServerWeek;
    /// <summary>服务端返回的教学周。</summary>
    public int? LastServerWeek
    {
        get => _lastServerWeek;
        private set
        {
            if (SetField(ref _lastServerWeek, value)) Raise(nameof(ClientTimeOffsetText));
        }
    }

    private int _notificationCount;
    /// <summary>已弹出并回执的提醒数量。</summary>
    public int NotificationCount
    {
        get => _notificationCount;
        private set => SetField(ref _notificationCount, value);
    }

    private bool _busy;
    /// <summary>是否正在上报（"立即上报"按钮据此禁用）。</summary>
    public bool Busy
    {
        get => _busy;
        private set => SetField(ref _busy, value);
    }

    private TimeSpan? _serverTimeOffset;
    /// <summary>服务端与本机的时钟差（诊断用：差得多说明教室机器时间不对）。</summary>
    public string ClientTimeOffsetText => _serverTimeOffset is null
        ? "—"
        : $"{_serverTimeOffset.Value.TotalSeconds:+0;-0;0} 秒";

    /// <summary>当前配置是否完整（设置页据此提示"还没填令牌"）。</summary>
    public bool IsConfigured => _settings.IsConfigured;

    /// <summary>是否已接入课程服务（拿到 ILessonsService 才算真正跑起来）。</summary>
    public bool IsAttached
    {
        get { lock (_gate) return _lessons is not null; }
    }

    /* ---------------------------------------------------------------- 生命周期 */

    /// <summary>接入课程服务并订阅课程事件（由插件入口在 AppStarted 时调用）。</summary>
    public void Attach(ILessonsService lessons)
    {
        lock (_gate)
        {
            _lessons = lessons;
        }

        if (!_eventsHooked)
        {
            // 上课 / 下课 / 放学 / 状态变化时立刻上报一次，不等到下一个定时点。
            // 这些事件在 ClassIsland 的公开约定里是在**主线程**触发的，可以直接订阅。
            lessons.OnClass += (_, _) => RequestReport("上课");
            lessons.OnBreakingTime += (_, _) => RequestReport("下课");
            lessons.OnAfterSchool += (_, _) => RequestReport("放学");
            lessons.CurrentTimeStateChanged += (_, _) => RequestReport("状态变化");
            _eventsHooked = true;
        }

        Raise(nameof(IsAttached));
        _logger.LogInformation("班级小助手联动：已订阅课程事件");
        RequestReport("应用启动");
    }

    /// <summary>按设置重建定时器（设置页改间隔后调用）。</summary>
    public void RestartTimer()
    {
        lock (_gate)
        {
            _timer?.Dispose();
            _timer = null;
            _notifyTimer?.Dispose();
            _notifyTimer = null;

            if (!_settings.IsConfigured) return;

            if (_settings.AutoReport)
            {
                var interval = TimeSpan.FromSeconds(Math.Clamp(_settings.ReportIntervalSeconds, 15, 3600));
                _timer = new Timer(_ => RequestReport("定时"), null, interval, interval);
            }

            // 提醒单独用一个轻量轮询（只查待提醒，不上传课表）：
            // 老师按下发送到教室弹出之间的延迟就是这个间隔，因此默认 10 秒，不跟随上报间隔。
            if (_settings.ReceiveNotifications)
            {
                var poll = TimeSpan.FromSeconds(Math.Clamp(_settings.NotificationPollSeconds, 5, 600));
                _notifyTimer = new Timer(_ => _ = PullPendingAsync(), null, poll, poll);
            }
        }
    }

    /// <summary>发起一次上报（事件驱动：已有上报在跑时直接丢弃本次，避免事件风暴打出并发请求）。</summary>
    public void RequestReport(string reason)
    {
        _ = ReportAsync(reason);
    }

    /// <summary>
    /// 执行一次上报并返回是否真的发出去了。
    /// <paramref name="includeSchedule"/> 为 true 时带上全量课表与节次时间。
    /// </summary>
    public async Task<bool> ReportAsync(string reason, bool includeSchedule = true)
    {
        if (_disposed) return false;

        ILessonsService? lessons;
        lock (_gate) lessons = _lessons;
        if (lessons is null) return false;

        if (!_settings.IsConfigured)
        {
            SetState(false, "尚未配置服务器地址或设备令牌", 0, 0, null);
            return false;
        }

        lock (_gate)
        {
            if (_reporting) return false;
            _reporting = true;
        }
        Busy = true;

        try
        {
            var profile = ResolveProfile();
            var request = new ReportRequestDto
            {
                PluginVersion = PluginVersion,
                ClassIslandVersion = SafeAppVersion(),
                State = BuildState(lessons),
            };

            var entryCount = 0;
            var layoutCount = 0;
            // 开关关着时也要留下原因：否则日志只有"上报成功：仅状态"，
            // 用户会以为"服务端拿不到 ClassIsland 课表"是插件坏了。
            if (includeSchedule && !_settings.UploadSchedule)
            {
                _logger.LogInformation(
                    "班级小助手联动：本机设置里「上报课表到班级小助手」是关闭的，本次只上报状态；" +
                    "需要把教室课表同步到班级小助手请打开该开关");
            }

            if (includeSchedule && _settings.UploadSchedule && profile is not null)
            {
                var entries = ScheduleMapper.MapAllClassPlans(profile, out var warnings);
                foreach (var warning in warnings) _logger.LogWarning("班级小助手联动：{Warning}", warning);
                entryCount = entries.Count;
                request.Schedule = new SchedulePayloadDto { Mode = "merge", Entries = entries };
                // 课表为空时不发（否则会把服务端已有课表"合并"成空），但**必须把原因写清楚**：
                // 日志里只出现"仅状态"时，用户会以为上报失败，实际是 ClassIsland 里还没有课表。
                if (entries.Count == 0)
                {
                    request.Schedule = null;
                    _logger.LogWarning(
                        "班级小助手联动：ClassIsland 里没有**启用的课表**（0 条），本次未上报课表。" +
                        "请在 ClassIsland 里排好课表，或在 Web 端打开「镜像课表」由班级小助手下发一份");
                }

                var layout = ResolvePrimaryTimeLayout(profile);
                if (layout is not null)
                {
                    var items = ScheduleMapper.MapTimeLayout(layout);
                    layoutCount = items.Count;
                    request.TimeLayout = new TimeLayoutPayloadDto
                    {
                        Name = string.IsNullOrWhiteSpace(layout.Name) ? "ClassIsland 时间表" : layout.Name,
                        Mode = "replace",
                        Items = items,
                    };
                }
            }

            var (result, data) = await _client.ReportAsync(_settings, request, CancellationToken.None)
                .ConfigureAwait(false);
            if (!result.Ok || data is null)
            {
                _logger.LogWarning("班级小助手联动上报失败（{Reason}）：{Message}", reason, result.Message);
                SetState(false, result.Message, entryCount, layoutCount, null);
                return false;
            }

            LastServerWeek = data.Week;
            UpdateClockOffset(data.ServerTime);
            if (data.ScheduleApplied)
            {
                _logger.LogInformation(
                    "班级小助手联动：课表已同步（新增 {Created} / 更新 {Updated}）",
                    data.ScheduleCreated, data.ScheduleUpdated);
            }

            var detail = entryCount > 0
                ? $"课表 {entryCount} 节 / 节次 {layoutCount} 条"
                : _settings.UploadSchedule
                    ? "仅状态（ClassIsland 里还没有启用的课表）"
                    : "仅状态（本机「上报课表到班级小助手」开关已关闭）";
            SetState(true, $"上报成功（{reason}）：{detail}，服务端第 {data.Week} 周",
                entryCount, layoutCount, data.Week);

            // 顺路把"还没弹出过的"提醒带回来
            var pending = data.PendingNotification;
            if (pending is not null && _settings.ReceiveNotifications)
            {
                NotificationReceived?.Invoke(this, pending);
            }

            if (_settings.MirrorSchedule)
            {
                await MirrorScheduleAsync().ConfigureAwait(false);
            }

            return true;
        }
        finally
        {
            Busy = false;
            lock (_gate) _reporting = false;
        }
    }

    /// <summary>
    /// 拉取本班尚未弹出过的提醒并逐条交给提醒提供方（用于"应用刚起来还没到第一个上报点"的场景）。
    /// </summary>
    public async Task PullPendingAsync()
    {
        if (_disposed) return;
        if (!_settings.IsConfigured || !_settings.ReceiveNotifications) return;

        // 轮询与"上报顺路拉取"可能同时到达：同一时刻只放一个请求过去
        lock (_gate)
        {
            if (_pulling) return;
            _pulling = true;
        }

        try
        {
            var (result, items) = await _client.PendingAsync(_settings, CancellationToken.None).ConfigureAwait(false);
            if (!result.Ok)
            {
                _logger.LogInformation("班级小助手联动：拉取待提醒失败（{Message}）", result.Message);
                return;
            }

            foreach (var item in items)
            {
                _logger.LogInformation("班级小助手联动：取到待弹出提醒「{Title}」（id={Id}）", item.Title, item.Id);
                NotificationReceived?.Invoke(this, item);
            }
        }
        finally
        {
            lock (_gate) _pulling = false;
        }
    }

    /// <summary>把服务端的一条提醒标记为已弹出。</summary>
    public async Task AckAsync(string id)
    {
        var result = await _client.AckAsync(_settings, id, CancellationToken.None).ConfigureAwait(false);
        if (result.Ok)
        {
            NotificationCount += 1;
            _logger.LogInformation("班级小助手联动：已确认提醒 {Id}", id);
        }
        else
        {
            // 回执失败无妨：服务端会按 24 小时有效期补发，最坏是重复弹一次
            _logger.LogWarning("班级小助手联动：确认提醒失败 {Message}", result.Message);
        }
    }

    /// <summary>把班级小助手上排好的课表写回 ClassIsland（新建带前缀的档案课表，不动老师原有的课表）。</summary>
    public async Task MirrorScheduleAsync()
    {
        var profile = ResolveProfile();
        if (profile is null) return;

        var (result, plan) = await _client.PullClassPlanAsync(_settings, CancellationToken.None).ConfigureAwait(false);
        if (!result.Ok || plan is null)
        {
            // 服务端在"镜像开关没开"时会返回 data=null —— 这不是错误，但要告诉用户去哪儿开
            _logger.LogInformation(
                "班级小助手联动：跳过课表镜像（{Message}）。" +
                "需要在 Web 端「ClassIsland 联动」页给这台设备打开「镜像课表」，然后点一次「立即上报」或等下一个上报周期",
                result.Message);
            return;
        }

        try
        {
            var applied = ClassPlanWriter.Apply(profile, plan);
            if (!applied.Applied)
            {
                _logger.LogInformation("班级小助手联动：课表镜像未生效（{Reason}）",
                    applied.Warnings.FirstOrDefault() ?? "服务端课表为空");
                return;
            }

            // 改写的是 Profile 里的集合，ClassIsland 会靠 INotifyCollectionChanged 落盘；
            // 这里显式 SaveProfile() 是为了"打开开关马上就能在课表里看到"，不用等下一次自动保存。
            IAppHost.TryGetService<IProfileService>()?.SaveProfile();

            _logger.LogInformation("班级小助手联动：已把班级课表写入 ClassIsland（{Plans}）",
                string.Join("、", applied.PlanNames.Select(name => $"「{name}」")));
            foreach (var warning in applied.Warnings)
            {
                _logger.LogWarning("班级小助手联动镜像提示：{Warning}", warning);
            }
        }
        catch (Exception exception)
        {
            _logger.LogError(exception, "班级小助手联动：课表镜像失败");
        }
    }

    /* ---------------------------------------------------------------- 内部实现 */

    /// <summary>插件版本（与 manifest.yml / csproj 保持一致）。</summary>
    private const string PluginVersion = "0.1.0.0";

    /// <summary>ClassIsland 版本读不到时不该让上报失败（开发版可能为 null）。</summary>
    private static string SafeAppVersion()
    {
        try
        {
            return AppBase.AppVersion ?? "";
        }
        catch
        {
            return "";
        }
    }

    /// <summary>
    /// 取得当前状态快照。
    /// <c>CurrentTimeLayoutItem</c> 在"没有课表"时是 <see cref="ClassIsland.Shared.Models.Profile.TimeLayoutItem.Empty"/>，
    /// 语义上等价于"没有节次"，因此要转成 null 而不是 00:00。
    /// </summary>
    private StateDto BuildState(ILessonsService lessons)
    {
        try
        {
            return ScheduleMapper.BuildState(lessons, LastServerWeek);
        }
        catch (Exception exception)
        {
            // 课程服务在"应用启动中/课表未加载"时可能抛异常，这里降级为只有心跳的上报
            _logger.LogWarning(exception, "班级小助手联动：读取课程状态失败，本次只上报心跳");
            return new StateDto { ClientTime = DateTimeOffset.Now.ToString("o") };
        }
    }

    /// <summary>
    /// 选一份"最有代表性"的时间表上报给班级小助手：**上课点最多的那一份**。
    ///
    /// 为什么不按"当前课表"选：镜像会给每个（星期 + 单双周）建一份时间表，
    /// 于是"今天"那一份可能只有一两节课 —— 按当前课表选就会把只有一节的时间表报上去，
    /// 服务端那边的节次时间表就退化了。取上课点最多的那份，得到的是完整作息。
    /// 并列时优先"每周"型（单双周的两份内容一致，每周型更通用）。
    /// </summary>
    private static ClassIsland.Shared.Models.Profile.TimeLayout? ResolvePrimaryTimeLayout(
        ClassIsland.Shared.Models.Profile.Profile profile)
    {
        if (profile.TimeLayouts.Count == 0) return null;

        var best = profile.TimeLayouts
            .Select(pair => (pair.Value, ClassPoints: pair.Value.Layouts.Count(item => item.TimeType == 0)))
            .Where(item => item.ClassPoints > 0)
            .OrderByDescending(item => item.ClassPoints)
            .ToList();
        if (best.Count > 0) return best[0].Value;

        // 兜底：档案里被激活的时间表，最后才是任意一个
        return profile.TimeLayouts.Values.FirstOrDefault(item => item.IsActivated)
               ?? profile.TimeLayouts.Values.First();
    }

    private static ClassIsland.Shared.Models.Profile.ClassPlan? CurrentClassPlan(
        ClassIsland.Shared.Models.Profile.Profile profile)
    {
        // 用课程服务拿"今天该上哪张课表"最准
        try
        {
            var lessons = IAppHost.TryGetService<ILessonsService>();
            return lessons?.CurrentClassPlan;
        }
        catch
        {
            return null;
        }
    }

    private ClassIsland.Shared.Models.Profile.Profile? ResolveProfile()
    {
        try
        {
            // 档案由 ProfileService 持有；这里用 TryGetService 避免服务未注册时抛异常
            return IAppHost.TryGetService<IProfileService>()?.Profile;
        }
        catch (Exception exception)
        {
            _logger.LogWarning(exception, "班级小助手联动：读取档案失败");
            return null;
        }
    }

    /// <summary>用服务端时间校准本机时钟差（只影响设置页展示，不改系统时间）。</summary>
    private void UpdateClockOffset(string serverTime)
    {
        if (!DateTimeOffset.TryParse(serverTime, out var parsed)) return;
        _serverTimeOffset = parsed - DateTimeOffset.Now;
        Raise(nameof(ClientTimeOffsetText));
    }

    private void SetState(bool ok, string message, int entryCount, int layoutCount, int? week)
    {
        LastReportOk = ok;
        LastReportMessage = message;
        LastReportAt = DateTimeOffset.Now;
        LastScheduleEntryCount = entryCount;
        LastTimeLayoutItemCount = layoutCount;
        if (week.HasValue) LastServerWeek = week;
        StateChanged?.Invoke(this, EventArgs.Empty);
    }

    private void Raise(string propertyName) =>
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));

    private bool SetField<T>(ref T field, T value, [CallerMemberName] string? propertyName = null)
    {
        if (EqualityComparer<T>.Default.Equals(field, value)) return false;
        field = value;
        Raise(propertyName!);
        return true;
    }

    public void Dispose()
    {
        _disposed = true;
        lock (_gate)
        {
            _timer?.Dispose();
            _timer = null;
            _notifyTimer?.Dispose();
            _notifyTimer = null;
        }
        _client.Dispose();
    }
}