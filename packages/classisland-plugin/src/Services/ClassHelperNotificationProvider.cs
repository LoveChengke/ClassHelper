using Avalonia.Threading;
using ClassHelper.ClassIslandPlugin.Interop;
using ClassHelper.ClassIslandPlugin.Models;
using ClassIsland.Core.Abstractions.Services;
using ClassIsland.Shared;
using ClassIsland.Shared.Enums;
using ClassIsland.Core.Abstractions.Services.NotificationProviders;
using ClassIsland.Core.Attributes;
using ClassIsland.Core.Models.Notification;
using Microsoft.Extensions.Logging;

namespace ClassHelper.ClassIslandPlugin.Services;

/// <summary>
/// 提醒提供方：把老师在班级小助手上发布的提醒显示到 ClassIsland 上。
///
/// 与 <see cref="BridgeService"/> 的分工：
/// - <see cref="BridgeService"/> 负责"拉"（上报时顺路把待提醒带回来）与"回执"（ack）；
/// - 本类只负责"显示"——提醒必须由提醒提供方发出，ClassIsland 才会走主界面的
///   全屏特效 / 语音 / 音效那一整套流程。
///
/// 为什么不给这个提供方再配一套"提醒设置"：本插件的开关全在「班级小助手联动」设置页里，
/// 再在「提醒」设置页放第二份开关只会让老师困惑（两处都能关，到底以哪个为准）。
/// 因此这里用无设置的 <see cref="NotificationProviderBase"/>，读的是同一份 <see cref="PluginSettings"/>。
/// </summary>
// 第 3 个参数是 Fluent 图标字体里的字形字符（ClassIsland 内置提醒提供方用的也是字形字符，
// 不是 "fluent(...)" 表达式）：E8BD 是喇叭字形。
[NotificationProviderInfo(
    ProviderGuidValue,
    "班级小助手提醒",
    "\uE8BD",
    "显示老师从班级小助手下发的提醒。")]
public sealed class ClassHelperNotificationProvider : NotificationProviderBase
{
    /// <summary>
    /// 提醒提供方 GUID（全局唯一，别改：改了等于换了一个提供方，用户原有的提醒设置会失联）。
    /// 名字带 Value 后缀是为了不和基类的 <see cref="NotificationProviderBase.ProviderGuid"/> 属性撞名。
    /// </summary>
    public const string ProviderGuidValue = "7C4B1F6E-2A85-4A1F-9E3C-5B7D0C1A9E42";

    private readonly BridgeService _bridge;
    private readonly PluginSettings _settings;
    private readonly ILogger<ClassHelperNotificationProvider> _logger;

    /// <summary>
    /// 正在播放（尚未回执）的提醒 id。
    ///
    /// 服务端在提醒被回执前会**一直**把它算作"待弹出"，而插件是按固定间隔轮询取回的，
    /// 因此时长超过轮询间隔的提醒会被反复取到 —— 没有这层去重就会一遍遍重复弹。
    /// 只有播完（或用户关掉）才从集合里移除，那一刻才回执。
    /// </summary>
    private readonly HashSet<string> _playing = new();

    /// <summary>
    /// 上课时段被暂存的提醒（与客户端灵动岛同一套规则）。
    ///
    /// 为什么要有它：老师在**上课时段**发通知，教室里正上着课，直接全屏弹会打断课堂。
    /// 客户端的灵动岛就是"上课先收着、下课再弹"，ClassIsland 这侧必须一致，
    /// 否则学生在客户端看不到、却在 ClassIsland 上被打断。
    ///
    /// 例外（"主动通知"）：紧急提醒与**叫人**，老师正在等学生，必须立刻弹。
    /// </summary>
    private readonly List<PushNotificationDto> _deferred = new();

    private ILessonsService? _lessons;

    public ClassHelperNotificationProvider(
        BridgeService bridge,
        PluginSettings settings,
        ILogger<ClassHelperNotificationProvider> logger)
    {
        _bridge = bridge;
        _settings = settings;
        _logger = logger;
        _bridge.NotificationReceived += OnNotificationReceived;

        // 订阅课程事件：下课后把上课时段暂存的提醒补弹出来
        try
        {
            _lessons = IAppHost.TryGetService<ILessonsService>();
            if (_lessons is not null)
            {
                _lessons.OnBreakingTime += (_, _) => Dispatcher.UIThread.Post(FlushDeferred);
                _lessons.OnAfterSchool += (_, _) => Dispatcher.UIThread.Post(FlushDeferred);
                _lessons.CurrentTimeStateChanged += (_, _) => Dispatcher.UIThread.Post(FlushDeferred);
            }
        }
        catch (Exception exception)
        {
            _logger.LogWarning(exception, "班级小助手联动：订阅课程事件失败，上课暂存将退化为「立即弹出」");
        }
    }

    /// <summary>当前是否处于上课时段（读不到课程服务时按"不在上课"处理，宁可弹也不静默丢）</summary>
    private bool IsInClass()
    {
        try
        {
            return _lessons?.CurrentState == TimeState.OnClass;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// 这条提醒是否必须立刻弹（"主动通知"）：
    /// 紧急提醒，或叫人（老师正在等学生）。
    /// </summary>
    private static bool IsImmediate(PushNotificationDto notification) =>
        notification.Urgent || string.Equals(notification.Kind, "call", StringComparison.OrdinalIgnoreCase);

    /// <summary>下课后补弹暂存的提醒（按进入顺序）</summary>
    private void FlushDeferred()
    {
        if (IsInClass()) return; // 还在上课（例如只是状态在 OnClass 内部变化）
        if (_deferred.Count == 0) return;

        var pending = _deferred.ToList();
        _deferred.Clear();
        _logger.LogInformation("班级小助手联动：下课了，补弹 {Count} 条上课时段暂存的提醒", pending.Count);
        foreach (var item in pending) ShowOnUiThread(item);
    }

    private void OnNotificationReceived(object? sender, PushNotificationDto notification)
    {
        if (!_settings.ReceiveNotifications) return;
        if (string.IsNullOrWhiteSpace(notification.Id)) return;

        // 同一条提醒在播放期间会被后续轮询反复取回，这里按 id 去重（详见 _playing 的说明）
        lock (_playing)
        {
            if (!_playing.Add(notification.Id))
            {
                _logger.LogDebug("班级小助手联动：提醒 {Id} 正在播放，跳过重复投递", notification.Id);
                return;
            }
        }

        // 必须切回 UI 线程：提醒内容里的图标、以及提醒主机本身都是 Avalonia 的 UI 对象，
        // 而本方法是从上报回调（线程池）里被调用的 —— 在线程池上直接显示会静默失败/抛异常。
        Dispatcher.UIThread.Post(() => ShowOnUiThread(notification));
    }

    private void ShowOnUiThread(PushNotificationDto notification)
    {
        try
        {
            // 上课时段：非"主动通知"先收着（与客户端灵动岛同一套规则），下课后补弹
            if (IsInClass() && !IsImmediate(notification))
            {
                _deferred.Add(notification);
                _logger.LogInformation("班级小助手联动：上课中，「{Title}」已暂存，下课后弹出", notification.Title);
                return;
            }

            var request = BuildRequest(notification);
            // 只有真正播完（或被用户关掉）才回执：中途退出 ClassIsland 时下次上报还会补发，不会静默丢失
            AckWhenFinished(request, notification);
            ShowNotification(request);
            _logger.LogInformation("班级小助手联动：已弹出提醒「{Title}」（{Seconds} 秒）",
                notification.Title, notification.DurationSeconds);
        }
        catch (Exception exception)
        {
            // 显示失败不能让 ClassIsland 崩掉：记日志，且**不回执**，服务端下次轮询还会重发。
            // 同时要把 id 从"正在播放"里放出来，否则本次失败后再也不会重试。
            lock (_playing) _playing.Remove(notification.Id);
            _logger.LogError(exception, "班级小助手联动：显示提醒「{Title}」失败", notification.Title);
        }
    }

    /// <summary>
    /// 把服务端下发的提醒转成 ClassIsland 的提醒请求。
    ///
    /// 时长口径：老师指定的时长给**正文**（正文才是持续显示的那一段），遮罩只停留几秒 ——
    /// 遮罩占满整个时长会把正文压没，不如"遮罩几秒 + 正文 N 秒"清楚。
    /// </summary>
    private NotificationRequest BuildRequest(PushNotificationDto notification)
    {
        var seconds = Math.Clamp(
            notification.DurationSeconds > 0 ? notification.DurationSeconds : _settings.NotificationDurationSeconds,
            1,
            120);
        var duration = TimeSpan.FromSeconds(seconds);
        var maskDuration = TimeSpan.FromSeconds(Math.Min(notification.Urgent ? 5 : 3, seconds));

        var title = string.IsNullOrWhiteSpace(notification.Title) ? "班级小助手" : notification.Title;
        var content = string.IsNullOrWhiteSpace(notification.Content) ? title : notification.Content;

        // 语音：老师勾了朗读 + 本机允许朗读，两者都满足才念（本机开关是给学生机的总闸）
        var speech = _settings.SpeechEnabled ? notification.SpeechContent : null;
        var speechEnabled = !string.IsNullOrWhiteSpace(speech);

        // 遮罩用双图标模板的**默认图标**：这两个图标由模板自己创建（LucideIconSource），
        // 自己塞图标串很容易踩到"图标表达式格式不对/字形不存在"，没必要冒这个险。
        var mask = NotificationContent.CreateTwoIconsMask(title, factory: content_ =>
        {
            content_.Duration = maskDuration;
            content_.SpeechContent = speech ?? string.Empty;
            // 没勾朗读时明确关掉，否则 ClassIsland 会按默认设置把标题也念出来
            content_.IsSpeechEnabled = speechEnabled;
        });

        // 正文：普通提醒用静态文本；紧急提醒改用**滚动文本**（ClassIsland 自带的抢注意力模板），
        // 这样"紧急"在视觉上真的有区别，而不是只靠一个可能不存在的图标。
        NotificationContent overlay = notification.Urgent
            ? NotificationContent.CreateRollingTextContent(content, factory: content_ =>
            {
                content_.Duration = duration;
                content_.SpeechContent = speech ?? string.Empty;
                content_.IsSpeechEnabled = speechEnabled;
            })
            : NotificationContent.CreateSimpleTextContent(content, factory: content_ =>
            {
                content_.Duration = duration;
                content_.SpeechContent = speech ?? string.Empty;
                content_.IsSpeechEnabled = speechEnabled;
            });

        return new NotificationRequest { MaskContent = mask, OverlayContent = overlay };
    }

    /// <summary>提醒播完 / 被关掉后回执给班级小助手，服务端不再补发。</summary>
    private void AckWhenFinished(NotificationRequest request, PushNotificationDto notification)
    {
        void Handler(object? sender, EventArgs args)
        {
            request.Completed -= Handler;
            request.Canceled -= Handler;

            // 播完再放行：即使回执失败（例如断网）也移除，让后续轮询能重新投递一次，
            // 避免"回执丢了 + 不再重试"把提醒彻底吞掉
            lock (_playing) _playing.Remove(notification.Id);
            _ = _bridge.AckAsync(notification.Id);
        }

        request.Completed += Handler;
        request.Canceled += Handler;
    }
}