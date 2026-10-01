using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using ClassHelper.ClassIslandPlugin.Models;

namespace ClassHelper.ClassIslandPlugin.Interop;

/* ---------------------------------------------------------------- 服务端契约（与 packages/shared 保持一致） */

/// <summary>插件上报的课表条目。</summary>
public class ScheduleEntryDto
{
    [JsonPropertyName("dayOfWeek")] public int DayOfWeek { get; set; }
    [JsonPropertyName("startTime")] public string StartTime { get; set; } = "";
    [JsonPropertyName("endTime")] public string EndTime { get; set; } = "";
    [JsonPropertyName("subject")] public string Subject { get; set; } = "";
    [JsonPropertyName("teacherName")] public string? TeacherName { get; set; }
    /// <summary>ALL / ODD / EVEN；留空则由服务端按 weekCountDiv 推导。</summary>
    [JsonPropertyName("weekParity")] public string? WeekParity { get; set; }
    [JsonPropertyName("weekCountDiv")] public int WeekCountDiv { get; set; }
    [JsonPropertyName("weekCountDivTotal")] public int WeekCountDivTotal { get; set; }
    [JsonPropertyName("planName")] public string? PlanName { get; set; }
}

/// <summary>插件上报的节次时间。</summary>
public class TimeLayoutItemDto
{
    [JsonPropertyName("index")] public int Index { get; set; }
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("startTime")] public string StartTime { get; set; } = "";
    [JsonPropertyName("endTime")] public string EndTime { get; set; } = "";
    /// <summary>class / break / divider / action</summary>
    [JsonPropertyName("type")] public string Type { get; set; } = "class";
    [JsonPropertyName("skipped")] public bool Skipped { get; set; }
}

/// <summary>本机运行状态快照。</summary>
public class StateDto
{
    [JsonPropertyName("inClass")] public bool InClass { get; set; }
    [JsonPropertyName("subject")] public string? Subject { get; set; }
    [JsonPropertyName("nextSubject")] public string? NextSubject { get; set; }
    [JsonPropertyName("timeState")] public string? TimeState { get; set; }
    [JsonPropertyName("periodStart")] public string? PeriodStart { get; set; }
    [JsonPropertyName("periodEnd")] public string? PeriodEnd { get; set; }
    [JsonPropertyName("week")] public int? Week { get; set; }
    [JsonPropertyName("classPlanLoaded")] public bool ClassPlanLoaded { get; set; }
    [JsonPropertyName("clientTime")] public string ClientTime { get; set; } = "";
}

public class SchedulePayloadDto
{
    [JsonPropertyName("mode")] public string Mode { get; set; } = "merge";
    [JsonPropertyName("entries")] public List<ScheduleEntryDto> Entries { get; set; } = new();
}

public class TimeLayoutPayloadDto
{
    [JsonPropertyName("name")] public string Name { get; set; } = "ClassIsland 时间表";
    [JsonPropertyName("mode")] public string Mode { get; set; } = "replace";
    [JsonPropertyName("items")] public List<TimeLayoutItemDto> Items { get; set; } = new();
}

public class ReportRequestDto
{
    [JsonPropertyName("pluginVersion")] public string PluginVersion { get; set; } = "";
    [JsonPropertyName("classIslandVersion")] public string ClassIslandVersion { get; set; } = "";
    /// <summary>本机机器码：设备创建时服务端还不知道它，靠这里回填（见服务端 syncDeviceKey）。</summary>
    [JsonPropertyName("deviceKey")] public string DeviceKey { get; set; } = "";
    [JsonPropertyName("state")] public StateDto? State { get; set; }
    [JsonPropertyName("schedule")] public SchedulePayloadDto? Schedule { get; set; }
    [JsonPropertyName("timeLayout")] public TimeLayoutPayloadDto? TimeLayout { get; set; }
}

public class ReportSettingsDto
{
    [JsonPropertyName("mirrorScheduleToClassIsland")] public bool MirrorScheduleToClassIsland { get; set; }
    [JsonPropertyName("enabled")] public bool Enabled { get; set; }
}

public class ReportResultDto
{
    [JsonPropertyName("scheduleApplied")] public bool ScheduleApplied { get; set; }
    [JsonPropertyName("scheduleCreated")] public int ScheduleCreated { get; set; }
    [JsonPropertyName("scheduleUpdated")] public int ScheduleUpdated { get; set; }
    [JsonPropertyName("courses")] public List<string> Courses { get; set; } = new();
    [JsonPropertyName("timeLayoutApplied")] public bool TimeLayoutApplied { get; set; }
    [JsonPropertyName("week")] public int Week { get; set; }
    [JsonPropertyName("serverTime")] public string ServerTime { get; set; } = "";
    [JsonPropertyName("settings")] public ReportSettingsDto? Settings { get; set; }
    [JsonPropertyName("pendingNotification")] public PushNotificationDto? PendingNotification { get; set; }
}

/// <summary>服务端下发的提醒。</summary>
public class PushNotificationDto
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("title")] public string Title { get; set; } = "";
    [JsonPropertyName("content")] public string Content { get; set; } = "";
    [JsonPropertyName("durationSeconds")] public int DurationSeconds { get; set; } = 8;
    [JsonPropertyName("speechContent")] public string? SpeechContent { get; set; }
    [JsonPropertyName("createdAt")] public string CreatedAt { get; set; } = "";
    [JsonPropertyName("urgent")] public bool Urgent { get; set; }

    /// <summary>提醒类型：notification（默认）/ call（叫人，算"主动通知"，上课时段也立刻弹）</summary>
    [JsonPropertyName("kind")] public string? Kind { get; set; }
    [JsonPropertyName("classId")] public string ClassId { get; set; } = "";
    [JsonPropertyName("className")] public string? ClassName { get; set; }
    [JsonPropertyName("teacherName")] public string? TeacherName { get; set; }
}

public class PendingResultDto
{
    [JsonPropertyName("notifications")] public List<PushNotificationDto> Notifications { get; set; } = new();
    [JsonPropertyName("serverTime")] public string ServerTime { get; set; } = "";
    [JsonPropertyName("week")] public int Week { get; set; }
}

/* ---------------------------------------------------------------- 课表镜像（服务端 → ClassIsland） */

public class ClassPlanEntryMirrorDto
{
    [JsonPropertyName("weekDay")] public int WeekDay { get; set; }
    [JsonPropertyName("weekCountDiv")] public int WeekCountDiv { get; set; }
    [JsonPropertyName("weekCountDivTotal")] public int WeekCountDivTotal { get; set; }
    [JsonPropertyName("subject")] public string Subject { get; set; } = "";
    [JsonPropertyName("teacherName")] public string? TeacherName { get; set; }
    /// <summary>起止时间（HH:mm）。Classes[i] 必须与第 i 个上课时间点对齐，靠它重建时间表。</summary>
    [JsonPropertyName("startTime")] public string StartTime { get; set; } = "";
    [JsonPropertyName("endTime")] public string EndTime { get; set; } = "";
    [JsonPropertyName("timeLayoutId")] public string TimeLayoutId { get; set; } = "";
}

public class TimeLayoutMirrorDto
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("layouts")] public List<TimeLayoutItemMirrorDto> Layouts { get; set; } = new();
}

public class TimeLayoutItemMirrorDto
{
    [JsonPropertyName("startTime")] public string StartTime { get; set; } = "";
    [JsonPropertyName("endTime")] public string EndTime { get; set; } = "";
    [JsonPropertyName("timeType")] public int TimeType { get; set; }
}

public class ClassPlanMirrorDto
{
    [JsonPropertyName("entries")] public List<ClassPlanEntryMirrorDto> Entries { get; set; } = new();
    [JsonPropertyName("timeLayouts")] public List<TimeLayoutMirrorDto> TimeLayouts { get; set; } = new();
    [JsonPropertyName("profileName")] public string ProfileName { get; set; } = "";
    [JsonPropertyName("termStartDate")] public string TermStartDate { get; set; } = "";
}

public class PullResultDto
{
    [JsonPropertyName("classPlan")] public ClassPlanMirrorDto? ClassPlan { get; set; }
    [JsonPropertyName("week")] public int Week { get; set; }
    [JsonPropertyName("serverTime")] public string ServerTime { get; set; } = "";
}

/* ---------------------------------------------------------------- 统一响应体 */

internal class ApiEnvelope<T>
{
    [JsonPropertyName("success")] public bool Success { get; set; }
    [JsonPropertyName("data")] public T? Data { get; set; }
    [JsonPropertyName("message")] public string Message { get; set; } = "";
    [JsonPropertyName("code")] public string? Code { get; set; }
}

/// <summary>调用班级小助手后端的结果（不抛异常，便于设置页展示原因）。</summary>
public class ApiCallResult
{
    public bool Ok { get; init; }
    public string Message { get; init; } = "";
    public bool NetworkError { get; init; }

    public static ApiCallResult Success(string message) => new() { Ok = true, Message = message };
    public static ApiCallResult Failure(string message) => new() { Ok = false, Message = message };
    public static ApiCallResult Offline(string message) => new() { Ok = false, Message = message, NetworkError = true };
}

/// <summary>
/// 班级小助手后端客户端。
///
/// 只用 <see cref="HttpClient"/> + System.Text.Json：不引入额外依赖包，
/// 避免插件加载时因为"插件程序集隔离"缺少依赖而无法启动
/// （见 https://docs.classisland.tech/dev/plugins/basics.html 的程序集隔离说明）。
/// </summary>
public sealed class ClassHelperClient : IDisposable
{
    /// <summary>
    /// 单次请求超时。教室机器可能是内网慢链路，但也不该卡住上报线程太久。
    /// </summary>
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(12);

    /// <summary>
    /// 响应体上限（4MB）。默认是 2GB —— 服务器地址填错（指到一个会吐大页面的地址）时，
    /// 一次请求就能在 12 秒内把内存吃光。
    /// </summary>
    private const long MaxResponseBytes = 4 * 1024 * 1024;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    /// <summary>
    /// 与班级小助手通信的 HttpClient。
    ///
    /// **必须显式处理代理**：教室机器（以及开发机）常常配了系统代理，
    /// 而 Windows 的代理设置默认连 `127.0.0.1` 也会走代理 —— 于是"填写令牌后立刻 HTTP 404"，
    /// 那个 404 其实是**代理自己的错误页**，跟本服务毫无关系。
    /// 因此这里用 <see cref="LocalAwareProxy"/>：本地/内网地址直连，公网地址照旧走系统代理。
    /// </summary>
    private readonly HttpClient _http = new(new SocketsHttpHandler { Proxy = new LocalAwareProxy() })
    {
        Timeout = Timeout,
        MaxResponseContentBufferSize = MaxResponseBytes,
    };

    public string LastError { get; private set; } = "";
    public DateTimeOffset? LastSuccessAt { get; private set; }

    /// <summary>
    /// 包装系统代理：**本地/内网地址标记为"绕过"**，其余交给系统代理决定。
    ///
    /// 判定为本地/内网的情形：localhost、回环地址、IPv4/IPv6 私有段与链路本地段，
    /// 以及不含点的主机名（`server` / `classhelper` 这类校内机器名，DNS 也可能解析不出来）。
    /// 判定为公网时保持原行为，避免"云服务器 + 公司代理"这种场景被我们改坏。
    /// </summary>
    private sealed class LocalAwareProxy : IWebProxy
    {
        private readonly IWebProxy _inner = HttpClient.DefaultProxy;

        // 只读透传即可：HttpClient.DefaultProxy 是全局单例，改它的凭据会波及宿主进程里的其它请求
        public ICredentials? Credentials { get; set; }

        public Uri? GetProxy(Uri destination) => _inner.GetProxy(destination);

        public bool IsBypassed(Uri host) => IsLocalHost(host) || _inner.IsBypassed(host);

        /// <summary>该地址是否属于"不该走代理"的本地/内网范围。</summary>
        internal static bool IsLocalHost(Uri uri)
        {
            var host = uri.Host;
            if (host.Equals("localhost", StringComparison.OrdinalIgnoreCase)) return true;
            // 不含点的主机名（校内机器名）走直连：解析成内网 IP 的可能性远大于公网
            if (!host.Contains('.')) return true;

            if (!IPAddress.TryParse(host, out var address)) return false;
            if (IPAddress.IsLoopback(address)) return true;

            if (address.AddressFamily == AddressFamily.InterNetwork)
            {
                var bytes = address.GetAddressBytes();
                return bytes[0] == 10                                            // 10.0.0.0/8
                       || (bytes[0] == 172 && bytes[1] >= 16 && bytes[1] <= 31)  // 172.16.0.0/12
                       || (bytes[0] == 192 && bytes[1] == 168)                   // 192.168.0.0/16
                       || (bytes[0] == 169 && bytes[1] == 254);                  // 169.254.0.0/16（链路本地）
            }

            // IPv6：fc00::/7（唯一本地地址）与 fe80::/10（链路本地）
            var first = address.GetAddressBytes()[0];
            return (first & 0xFE) == 0xFC || (first & 0xC0) == 0x80;
        }
    }

    /// <summary>拼接 API 地址，容忍用户填了带/不带末尾斜杠、甚至带 /api 后缀的地址。</summary>
    private static string BuildUrl(string serverUrl, string path)
    {
        var baseUrl = (serverUrl ?? "").Trim().TrimEnd('/');
        if (baseUrl.EndsWith("/api", StringComparison.OrdinalIgnoreCase))
        {
            baseUrl = baseUrl[..^4];
        }
        return $"{baseUrl}/api/integrations{path}";
    }

    private HttpRequestMessage BuildRequest(HttpMethod method, string serverUrl, string path, string token)
    {
        var request = new HttpRequestMessage(method, BuildUrl(serverUrl, path));
        if (!string.IsNullOrWhiteSpace(token))
        {
            request.Headers.TryAddWithoutValidation("X-ClassIsland-Token", token);
        }
        return request;
    }

    private async Task<ApiEnvelope<T>?> SendAsync<T>(
        HttpMethod method,
        string serverUrl,
        string path,
        string token,
        object? body,
        CancellationToken cancellationToken)
    {
        try
        {
            using var request = BuildRequest(method, serverUrl, path, token);
            if (body is not null)
            {
                var json = JsonSerializer.Serialize(body, JsonOptions);
                request.Content = new StringContent(json, System.Text.Encoding.UTF8, "application/json");
            }

            using var response = await _http.SendAsync(request, cancellationToken).ConfigureAwait(false);
            var text = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);

            ApiEnvelope<T>? envelope = null;
            try
            {
                envelope = JsonSerializer.Deserialize<ApiEnvelope<T>>(text, JsonOptions);
            }
            catch (JsonException)
            {
                // 非 JSON 响应（例如被网关拦截）——交给下面的兜底分支
            }

            if (!response.IsSuccessStatusCode)
            {
                var message = envelope?.Message;
                if (string.IsNullOrWhiteSpace(message))
                {
                    // 响应不是本服务的统一响应体：最常见的原因就是被系统代理 / 网关拦下来
                    // （典型表现：HTTP 404 且 body 是一张 HTML 错误页）。把 URL 一起报出来，
                    // 老师截图给我们就能一眼定位。
                    message = envelope is null
                        ? $"HTTP {(int)response.StatusCode}（{method.Method} {request.RequestUri}）——" +
                          "响应不是班级小助手的标准格式，请检查服务器地址是否正确、" +
                          "或该系统代理是否拦截了内网请求"
                        : $"HTTP {(int)response.StatusCode}（{method.Method} {request.RequestUri}）";
                }
                LastError = message!;
                return envelope ?? new ApiEnvelope<T> { Success = false, Message = message! };
            }

            if (envelope is null)
            {
                // 2xx 但响应不是本服务的统一响应体（网关/反代的 HTML 错误页、地址指到了别的服务等）。
                // 必须留下原因：否则调用方拿到的是"成功但无数据 + 空错误消息"，
                // 设置页显示"连接异常"却没有原因，与上面专门为代理错误页写的诊断自相矛盾。
                LastError =
                    $"HTTP {(int)response.StatusCode}（{method.Method} {request.RequestUri}）——" +
                    "响应不是班级小助手的标准格式，请检查服务器地址是否正确，或该系统代理是否拦截了内网请求";
                return new ApiEnvelope<T> { Success = false, Message = LastError };
            }

            LastError = "";
            LastSuccessAt = DateTimeOffset.Now;
            return envelope;
        }
        catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            LastError = "请求超时（请检查服务器地址与网络）";
            return null;
        }
        catch (HttpRequestException exception)
        {
            LastError = $"无法连接班级小助手服务：{exception.Message}";
            return null;
        }
        catch (Exception exception)
        {
            LastError = exception.Message;
            return null;
        }
    }

    /// <summary>上报状态 +（可选）课表。</summary>
    public async Task<(ApiCallResult Result, ReportResultDto? Data)> ReportAsync(
        PluginSettings settings,
        ReportRequestDto payload,
        CancellationToken cancellationToken)
    {
        var envelope = await SendAsync<ReportResultDto>(
            HttpMethod.Post, settings.ServerUrl, "/classisland/report", settings.DeviceToken, payload, cancellationToken);
        if (envelope is null)
        {
            return (ApiCallResult.Offline(LastError), null);
        }
        if (!envelope.Success || envelope.Data is null)
        {
            return (ApiCallResult.Failure(envelope.Message.Length > 0 ? envelope.Message : LastError), null);
        }
        return (ApiCallResult.Success(envelope.Message), envelope.Data);
    }

    /// <summary>拉取尚未确认的下发提醒（插件启动/重连时补齐）。</summary>
    public async Task<(ApiCallResult Result, List<PushNotificationDto> Items)> PendingAsync(
        PluginSettings settings,
        CancellationToken cancellationToken)
    {
        var envelope = await SendAsync<PendingResultDto>(
            HttpMethod.Get, settings.ServerUrl, "/classisland/pending", settings.DeviceToken, null, cancellationToken);
        if (envelope is null) return (ApiCallResult.Offline(LastError), new List<PushNotificationDto>());
        if (!envelope.Success || envelope.Data is null)
        {
            return (ApiCallResult.Failure(envelope.Message.Length > 0 ? envelope.Message : LastError),
                new List<PushNotificationDto>());
        }
        return (ApiCallResult.Success(envelope.Message), envelope.Data.Notifications);
    }

    /// <summary>确认提醒已弹出（之后服务端不再补发）。</summary>
    public async Task<ApiCallResult> AckAsync(PluginSettings settings, string id, CancellationToken cancellationToken)
    {
        var envelope = await SendAsync<JsonElement>(
            HttpMethod.Post, settings.ServerUrl, "/classisland/ack", settings.DeviceToken, new { id }, cancellationToken);
        if (envelope is null) return ApiCallResult.Offline(LastError);
        return envelope.Success
            ? ApiCallResult.Success("已确认")
            : ApiCallResult.Failure(envelope.Message.Length > 0 ? envelope.Message : LastError);
    }

    /// <summary>拉取班级课表（用于镜像回 ClassIsland）。未开启镜像时服务端返回 data=null。</summary>
    public async Task<(ApiCallResult Result, ClassPlanMirrorDto? Plan)> PullClassPlanAsync(
        PluginSettings settings,
        CancellationToken cancellationToken)
    {
        var envelope = await SendAsync<PullResultDto>(
            HttpMethod.Get, settings.ServerUrl, "/classisland/class-plan", settings.DeviceToken, null, cancellationToken);
        if (envelope is null) return (ApiCallResult.Offline(LastError), null);
        if (!envelope.Success)
        {
            return (ApiCallResult.Failure(envelope.Message.Length > 0 ? envelope.Message : LastError), null);
        }
        if (envelope.Data?.ClassPlan is null)
        {
            return (ApiCallResult.Failure(envelope.Message.Length > 0
                ? envelope.Message
                : "该设备未开启「把班级课表镜像到 ClassIsland」"), null);
        }
        return (ApiCallResult.Success(envelope.Message), envelope.Data.ClassPlan);
    }

    public void Dispose() => _http.Dispose();
}
