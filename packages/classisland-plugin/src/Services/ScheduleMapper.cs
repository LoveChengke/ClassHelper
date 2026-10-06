using System.Collections.ObjectModel;
using ClassHelper.ClassIslandPlugin.Interop;
using ClassIsland.Core.Abstractions.Services;
using ClassIsland.Shared;
using ClassIsland.Shared.Enums;
using ClassIsland.Shared.Models.Profile;

namespace ClassHelper.ClassIslandPlugin.Services;

/// <summary>
/// 课表 / 状态 → 上报载荷 的换算层。
///
/// 这里集中全部"ClassIsland 口径 ↔ ClassHelper口径"的转换，保证只有一处需要跟着
/// ClassIsland 的模型变化而修改：
/// - 星期：ClassIsland <c>WeekDay</c> 是 0=周日、1=周一…6=周六；本系统是 1=周一…7=周日；
/// - 单双周：ClassIsland <c>WeekCountDiv</c>/<c>WeekCountDivTotal</c>；本系统 ALL/ODD/EVEN；
/// - 节次：ClassIsland <c>TimeLayoutItem.TimeType</c> 0=上课 1=课间 2=分割线 3=行动。
/// </summary>
public static class ScheduleMapper
{
    /// <summary>
    /// ClassIsland 的 WeekDay（0=周日…6=周六）→ 本系统 dayOfWeek（1=周一…7=周日）。
    /// </summary>
    public static int ToServerDayOfWeek(int weekDay)
    {
        var normalized = ((weekDay % 7) + 7) % 7;
        return normalized == 0 ? 7 : normalized;
    }

    /// <summary>
    /// ClassIsland 的 WeekCountDiv/Total → 本系统单双周。
    /// 与 <c>packages/shared/src/utils.ts</c> 的 <c>weekParityFromDiv</c> 完全一致：
    /// 3 周及以上的循环本系统无法表达，降级为「每周」。
    /// </summary>
    public static string ToWeekParity(int weekCountDiv, int weekCountDivTotal)
    {
        if (weekCountDiv <= 0 || weekCountDivTotal <= 1) return "ALL";
        var position = ((weekCountDiv - 1) % weekCountDivTotal) + 1;
        if (weekCountDivTotal == 2) return position == 1 ? "ODD" : "EVEN";
        return "ALL";
    }

    /// <summary>ClassIsland TimeType → 本系统节次类型。</summary>
    public static string ToTimeLayoutType(int timeType) => timeType switch
    {
        1 => "break",
        2 => "divider",
        3 => "action",
        _ => "class",
    };

    /// <summary>TimeSpan → "HH:mm"（跨天的时间点做钳制，避免出现 24:xx）。</summary>
    public static string ToHhMm(TimeSpan time)
    {
        var totalMinutes = (int)Math.Round(time.TotalMinutes);
        totalMinutes = Math.Clamp(totalMinutes, 0, 24 * 60 - 1);
        return $"{totalMinutes / 60:D2}:{totalMinutes % 60:D2}";
    }

    /// <summary>
    /// 把档案里的一张课表（ClassPlan）展开成"每个上课时间点一条"的课表条目。
    ///
    /// 与 ClassIsland 的语义严格对齐：<c>ClassPlan.Classes[i]</c> 对应
    /// <c>TimeLayout.Layouts</c> 里**第 i 个 TimeType=0（上课）的点**，课间 / 分割线 / 行动不占位。
    ///
    /// **注意不要用 `plan.ValidTimeLayoutItems`**：它的口径与 `Classes` 不同 ——
    /// `GetValidTimeLayoutItems()`（ClassIsland ClassPlan.cs）会正反两遍扫描，
    /// 把 `ClassInfo.IsEnabled == false`（老师在课表编辑里"停用"这一节）的课**连同其后的课间**
    /// 一起从结果里剔除；而 `RefreshClassesList()` 只按 `TimeType == 0` 的**总数**对齐
    /// `Classes` 的长度，`ClassInfo.CurrentTimeLayoutItem` 也是按原始列表的第 `Index` 个取的。
    /// 于是只要停用过任意一节，用 ValidTimeLayoutItems 配对就会让索引整体前移：
    /// 第 i 节配上第 i+1 节的时间点、最后一节丢失，且 `Math.Min` 会把缺口静默吃掉 ——
    /// 表现就是"课表看着有内容、每节课都对不上"，极难排查。
    /// </summary>
    public static List<ScheduleEntryDto> MapClassPlan(ClassPlan plan, Profile profile, out string? warning)
    {
        warning = null;
        var entries = new List<ScheduleEntryDto>();

        var timeLayout = ResolveTimeLayout(plan, profile);
        if (timeLayout is null)
        {
            warning = $"课表「{plan.Name}」找不到对应的时间表，已跳过";
            return entries;
        }

        // 只保留上课类型的时间点，顺序必须与 Classes 的索引一致（见上面注释）
        var classPoints = timeLayout.Layouts.Where(item => item.TimeType == 0).ToList();

        var weekDay = ToServerDayOfWeek(plan.TimeRule.WeekDay);
        var parity = ToWeekParity(plan.TimeRule.WeekCountDiv, plan.TimeRule.WeekCountDivTotal);
        if (plan.TimeRule.WeekCountDivTotal > 2)
        {
            warning = "存在 3 周以上的轮换课表，ClassHelper只支持单双周，已按「每周」处理";
        }

        var classes = plan.Classes;
        var count = Math.Min(classes.Count, classPoints.Count);
        for (var index = 0; index < count; index++)
        {
            var info = classes[index];
            // 索引必须与 Classes 对齐：这里按下标取时间点，**不能**先用 Where 过滤再取
            var point = classPoints[index];
            if (info is null) continue;
            // 老师停用的一节：本系统没有"停用"概念，不上报（否则 ClassHelper 班级端会看到一节实际上不上的课）
            if (!info.IsEnabled) continue;

            // 空课（未安排科目）不上报：服务端的科目是必填的，空课由课表里的缺席表达
            var subject = ResolveSubjectName(info.SubjectId, profile);
            if (string.IsNullOrWhiteSpace(subject)) continue;

            entries.Add(new ScheduleEntryDto
            {
                DayOfWeek = weekDay,
                StartTime = ToHhMm(point.StartTime),
                EndTime = ToHhMm(point.EndTime),
                // 服务端对这几个字段有 zod 长度上限，且是**整批**校验：一个超长名字会让整次上报
                // 400，连"现在上什么课"的状态与心跳都不更新，Web 端把教室显示成离线。
                Subject = Truncate(subject, SubjectMaxLength)!,
                TeacherName = Truncate(ResolveSubjectTeacher(info.SubjectId, profile), NameMaxLength),
                WeekParity = parity,
                WeekCountDiv = plan.TimeRule.WeekCountDiv,
                WeekCountDivTotal = plan.TimeRule.WeekCountDivTotal,
                PlanName = Truncate(plan.Name, PlanNameMaxLength),
            });
        }

        return entries;
    }

    /// <summary>服务端 zod 对各类名称的长度上限（超出会让整批上报 400，所以要截断） */
    public const int SubjectMaxLength = 40;
    public const int NameMaxLength = 40;
    public const int PlanNameMaxLength = 60;

    /// <summary>按服务端上限截断（null / 空串原样返回）</summary>
    public static string? Truncate(string? value, int max)
    {
        if (string.IsNullOrEmpty(value)) return value;
        var trimmed = value.Trim();
        return trimmed.Length <= max ? trimmed : trimmed[..max];
    }

    /// <summary>把时间表（TimeLayout）转成本系统的节次时间配置。</summary>
    public static List<TimeLayoutItemDto> MapTimeLayout(TimeLayout layout)
    {
        var items = new List<TimeLayoutItemDto>();
        // ClassIsland 的上课时间点没有独立名称，这里按"它之前有几个上课点"编出"第 N 节"
        var classPointIndex = 0;
        for (var index = 0; index < layout.Layouts.Count; index++)
        {
            var point = layout.Layouts[index];
            items.Add(new TimeLayoutItemDto
            {
                Index = index + 1,
                // 节次名同样是服务端有上限的字段（max 40），超长会让整批上报失败
                Name = Truncate(BuildTimePointName(point, ref classPointIndex), NameMaxLength)!,
                StartTime = ToHhMm(point.StartTime),
                EndTime = ToHhMm(point.EndTime),
                Type = ToTimeLayoutType(point.TimeType),
                Skipped = false,
            });
        }
        return items;
    }

    /// <summary>
    /// 节次名称：ClassIsland 只有课间有名字（BreakName），上课时间点没有独立名称，
    /// 因此按类型生成"第 N 节 / 课间 / 分割线"，保证本系统的时间轴可读。
    /// </summary>
    private static string BuildTimePointName(TimeLayoutItem point, ref int classPointIndex)
    {
        switch (point.TimeType)
        {
            case 1:
                return string.IsNullOrWhiteSpace(point.BreakName) ? "课间" : point.BreakName!;
            case 2:
                return "分割线";
            case 3:
                return "行动";
            default:
                classPointIndex++;
                return $"第 {classPointIndex} 节";
        }
    }

    /// <summary>取出课表使用的时间表：优先按 TimeLayoutId，其次用档案里第一个。</summary>
    public static TimeLayout? ResolveTimeLayout(ClassPlan plan, Profile profile)
    {
        if (profile.TimeLayouts.Count == 0) return null;
        if (plan.TimeLayoutId != Guid.Empty && profile.TimeLayouts.TryGetValue(plan.TimeLayoutId, out var byId))
        {
            return byId;
        }
        return plan.TimeLayout ?? profile.TimeLayouts.Values.FirstOrDefault();
    }

    /// <summary>科目名（找不到时返回空字符串，由调用方决定是否跳过）。</summary>
    public static string? ResolveSubjectName(Guid subjectId, Profile profile)
    {
        if (subjectId == Guid.Empty) return null;
        return profile.Subjects.TryGetValue(subjectId, out var subject) ? subject.Name : null;
    }

    /// <summary>科目任课老师（ClassIsland 在 Subject 上记录 TeacherName）。</summary>
    public static string? ResolveSubjectTeacher(Guid subjectId, Profile profile)
    {
        if (subjectId == Guid.Empty) return null;
        return profile.Subjects.TryGetValue(subjectId, out var subject) ? subject.TeacherName : null;
    }

    /// <summary>
    /// 收集档案里今天（按当前周次与星期）应该上的课表，
    /// 用于"只上报今天"这类轻量场景；当前实现为上报全部课表（服务端按周次并存）。
    /// </summary>
    public static List<ScheduleEntryDto> MapAllClassPlans(Profile profile, out List<string> warnings)
    {
        warnings = new List<string>();
        var all = new List<ScheduleEntryDto>();
        foreach (var plan in profile.ClassPlans.Values)
        {
            if (!plan.IsEnabled) continue;
            if (plan.IsOverlay) continue; // 临时层课表不下发，避免把临时调整固化到班级课表
            var entries = MapClassPlan(plan, profile, out var warning);
            if (!string.IsNullOrWhiteSpace(warning) && !warnings.Contains(warning!))
            {
                warnings.Add(warning!);
            }
            all.AddRange(entries);
        }
        return all;
    }

    /// <summary>
    /// 科目名归一化。
    ///
    /// 没有课表 / 没有当前科目时，ClassIsland 会把 <see cref="Subject.Fallback"/> 挂到
    /// `CurrentSubject` / `NextClassSubject` 上（见 LessonsService：
    /// `CurrentSubject = currentSubject ?? Subject.Fallback`），而它的名字就是占位符本身。
    /// 直接上报会让 Web 端显示成"正在上 ???"，因此这里统一折算成"没有科目"。
    /// </summary>
    private static string? NormalizeSubjectName(Subject? subject)
    {
        if (subject is null) return null;
        if (ReferenceEquals(subject, Subject.Fallback)) return null;

        var name = subject.Name?.Trim();
        if (string.IsNullOrEmpty(name)) return null;
        // 兜底：万一拿到的是另一个同名占位符实例（不是同一个引用）
        if (string.Equals(name, Subject.Fallback.Name, StringComparison.Ordinal)) return null;
        return name;
    }

    /// <summary>当前状态快照：服务端据此在 Web 端展示"现在上什么课"。</summary>
    public static StateDto BuildState(ILessonsService lessons, int? currentWeek)
    {
        var current = lessons.CurrentTimeLayoutItem;
        var state = lessons.CurrentState;
        return new StateDto
        {
            InClass = state == TimeState.OnClass,
            Subject = NormalizeSubjectName(lessons.CurrentSubject),
            NextSubject = NormalizeSubjectName(lessons.NextClassSubject),
            TimeState = state.ToString(),
            PeriodStart = current is null || current == TimeLayoutItem.Empty ? null : ToHhMm(current.StartTime),
            PeriodEnd = current is null || current == TimeLayoutItem.Empty ? null : ToHhMm(current.EndTime),
            Week = currentWeek,
            ClassPlanLoaded = lessons.IsClassPlanLoaded,
            ClientTime = DateTimeOffset.Now.ToString("o"),
        };
    }
}
