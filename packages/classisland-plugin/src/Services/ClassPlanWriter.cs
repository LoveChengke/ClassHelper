using System.Collections.ObjectModel;
using ClassHelper.ClassIslandPlugin.Interop;
using ClassIsland.Shared.Models.Profile;

namespace ClassHelper.ClassIslandPlugin.Services;

/// <summary>
/// 把班级小助手拉回来的课表写进 ClassIsland 档案。
///
/// **核心约束**：ClassIsland 的一份 <see cref="ClassPlan"/> 只带**一个** <see cref="TimeRule"/>
/// （即一个星期几 + 一个单双周相位），而班级小助手的课表同时覆盖 7 天与单双周。
/// 因此这里把服务端的条目**按（星期几 + 单双周）分组**，每一组生成一份独立的档案课表。
///
/// **时间点的构造方式**：ClassIsland 的 <c>ClassPlan.Classes[i]</c> 必须与
/// <c>TimeLayout.Layouts</c> 里第 i 个 <c>TimeType == 0</c>（上课）的点一一对应。
/// 与其去"匹配服务端时间表里的时间点"（一旦对不齐整份课表就错位），
/// 这里**按分组内的条目顺序直接重建时间点**：每条课目生成一个上课点，
/// 并在其结束后接上服务端时间表里同一起始时刻的课间点。这样索引关系天然成立。
///
/// **非破坏性**：
/// - 只创建/更新名字带 <see cref="PlanNamePrefix"/> 前缀的课表与时间表；
/// - 老师手动建的课表一律不删除、不改名（同名星期的冲突会在日志里警告）；
/// - 重复镜像时原地更新，不会越积越多。
/// </summary>
public static class ClassPlanWriter
{
    /// <summary>识别前缀：只有名字带此前缀的课表才由本插件创建与维护。</summary>
    public const string PlanNamePrefix = "班级小助手-";

    /// <summary>时间表名字后缀。</summary>
    public const string TimeLayoutNameSuffix = "（班级小助手）";

    /// <summary>一次镜像的结果（写入的课表名与冲突提示）。</summary>
    public sealed class ApplyResult
    {
        public List<string> PlanNames { get; } = new();
        public List<string> Warnings { get; } = new();
        public bool Applied { get; set; }
    }

    /// <summary>
    /// 应用服务端下发的课表。
    /// </summary>
    public static ApplyResult Apply(Profile profile, ClassPlanMirrorDto source)
    {
        var result = new ApplyResult();
        if (source.Entries.Count == 0 || source.TimeLayouts.Count == 0)
        {
            result.Warnings.Add("服务端返回的课表为空，未改动 ClassIsland 档案");
            return result;
        }

        var layout = source.TimeLayouts[0];

        // 1) 补齐科目（同名的复用，避免每次镜像堆出新的 Subject）
        EnsureSubjects(profile, source);

        // 2) 按（星期几 + 单双周）分组，每组一份课表
        var groups = source.Entries
            .GroupBy(entry => new
            {
                entry.WeekDay,
                entry.WeekCountDiv,
                entry.WeekCountDivTotal,
            })
            .Select(group => new
            {
                group.Key.WeekDay,
                group.Key.WeekCountDiv,
                group.Key.WeekCountDivTotal,
                // 时间点顺序 = 课表顺序：`Classes[i]` 靠这个顺序与上课时间点对齐，
                // 「HH:mm」是定长字符串，字典序就是时间序
                Entries = group.OrderBy(entry => entry.StartTime, StringComparer.Ordinal).ToList(),
            })
            .OrderBy(group => group.WeekDay)
            .ToList();

        foreach (var group in groups)
        {
            var planName = BuildPlanName(source.ProfileName, group.WeekDay, group.WeekCountDiv,
                group.WeekCountDivTotal, groups.Count);
            var planId = FindPlanId(profile, planName);
            var (timeLayoutId, timeLayout) = BuildTimeLayout(
                profile, planName, group.Entries);

            var plan = profile.ClassPlans.TryGetValue(planId, out var existing)
                ? existing
                : new ClassPlan();
            plan.Name = planName;
            plan.TimeLayoutId = timeLayoutId;
            plan.TimeRule = new TimeRule
            {
                WeekDay = group.WeekDay,
                WeekCountDiv = group.WeekCountDiv,
                WeekCountDivTotal = group.WeekCountDivTotal,
            };

            // Classes[i] ↔ 第 i 个上课点：按分组内条目的时间顺序直接构造，索引天然一致
            // ClassIsland 的 `ClassInfo.CurrentTimeLayoutItem` = CurrentTimeLayout 里第 Index 个上课点，
            // 因此这里必须显式把 Index 与 CurrentTimeLayout 一起写上 —— 只在构造时依赖
            // `RefreshClassesList()` 是不够的：更新已有课表时 `TimeLayouts` 引用没变，
            // 档案不会重新触发刷新，课次就会停留在旧时间点上。
            var classes = new ObservableCollection<ClassInfo>();
            var index = 0;
            foreach (var entry in group.Entries)
            {
                var subjectId = profile.Subjects
                    .FirstOrDefault(pair => pair.Value.Name == entry.Subject).Key;
                classes.Add(new ClassInfo
                {
                    Index = index++,
                    CurrentTimeLayout = timeLayout,
                    SubjectId = subjectId,
                    IsEnabled = true,
                });
            }
            plan.Classes = classes;
            plan.IsEnabled = true;
            profile.ClassPlans[planId] = plan;
            result.PlanNames.Add(planName);

            // 冲突提示：同一星期几 + 同一单双周相位下老师还开着别的课表
            var conflicts = profile.ClassPlans
                .Where(pair => pair.Key != planId
                               && pair.Value.IsEnabled
                               && !pair.Value.Name.StartsWith(PlanNamePrefix, StringComparison.Ordinal)
                               && pair.Value.TimeRule.WeekDay == group.WeekDay
                               && pair.Value.TimeRule.WeekCountDivTotal == group.WeekCountDivTotal
                               && pair.Value.TimeRule.WeekCountDiv == group.WeekCountDiv)
                .Select(pair => pair.Value.Name)
                .ToList();
            if (conflicts.Count > 0)
            {
                result.Warnings.Add(
                    $"星期 {group.WeekDay} 已有启用的课表（{string.Join("、", conflicts)}），" +
                    "两者重叠时以班级小助手同步的课表为准");
            }
        }

        // 3) 停用上一次镜像留下来的、本次不再需要的课表（只动自己创建的）
        var currentNames = new HashSet<string>(result.PlanNames);
        foreach (var pair in profile.ClassPlans)
        {
            if (!pair.Value.Name.StartsWith(PlanNamePrefix, StringComparison.Ordinal)) continue;
            if (currentNames.Contains(pair.Value.Name)) continue;
            pair.Value.IsEnabled = false;
        }

        result.Applied = true;
        return result;
    }

    private static void EnsureSubjects(Profile profile, ClassPlanMirrorDto source)
    {
        foreach (var name in source.Entries.Select(entry => entry.Subject).Distinct())
        {
            if (string.IsNullOrWhiteSpace(name)) continue;
            if (profile.Subjects.Any(pair => pair.Value.Name == name)) continue;
            profile.Subjects[Guid.NewGuid()] = new Subject { Name = name };
        }
    }

    private static Guid FindPlanId(Profile profile, string planName)
    {
        var existing = profile.ClassPlans.FirstOrDefault(pair => pair.Value.Name == planName);
        return existing.Key != Guid.Empty ? existing.Key : Guid.NewGuid();
    }

    /// <summary>
    /// 按分组内的条目重建时间表：**每节课之间补一个课间**（最后一节之后不补）。
    ///
    /// 课间 = 「上一节下课」到「下一节上课」之间的那段空隙，直接由两条课目的时间算出来，
    /// 不依赖服务端有没有给课间点 —— 这样无论班级小助手那边是否维护节次时间表，
    /// ClassIsland 档案里的课表都会有一致的课间（需求：每节课的间隔都是课间，放学后除外）。
    /// </summary>
    private static (Guid Id, TimeLayout Layout) BuildTimeLayout(
        Profile profile,
        string planName,
        IReadOnlyList<ClassPlanEntryMirrorDto> entries)
    {
        var layoutName = planName + TimeLayoutNameSuffix;
        var existing = profile.TimeLayouts.FirstOrDefault(pair => pair.Value.Name == layoutName);
        var id = existing.Key != Guid.Empty ? existing.Key : Guid.NewGuid();

        var layout = new TimeLayout { Name = layoutName, IsActivated = true };
        for (var index = 0; index < entries.Count; index++)
        {
            var entry = entries[index];
            layout.Layouts.Add(new TimeLayoutItem
            {
                TimeType = 0, // 上课
                StartTime = ParseTime(entry.StartTime),
                EndTime = ParseTime(entry.EndTime),
            });

            // 课间：下一节开始晚于本节结束才有空隙；最后一节之后（放学）不插
            if (index + 1 >= entries.Count) continue;
            var next = entries[index + 1];
            var breakStart = ParseTime(entry.EndTime);
            var breakEnd = ParseTime(next.StartTime);
            if (breakEnd <= breakStart) continue;

            layout.Layouts.Add(new TimeLayoutItem
            {
                TimeType = 1, // 课间
                StartTime = breakStart,
                EndTime = breakEnd,
            });
        }

        profile.TimeLayouts[id] = layout;
        return (id, layout);
    }

    /// <summary>
    /// 课表名：单组时用「班级小助手-&lt;班级名&gt;」；多组时补上星期与单双周以免互相覆盖。
    /// </summary>
    private static string BuildPlanName(
        string profileName,
        int weekDay,
        int weekCountDiv,
        int weekCountDivTotal,
        int groupCount)
    {
        var baseName = string.IsNullOrWhiteSpace(profileName) ? "班级小助手课表" : profileName.Trim();
        if (!baseName.StartsWith(PlanNamePrefix, StringComparison.Ordinal))
        {
            baseName = PlanNamePrefix + baseName;
        }
        if (groupCount <= 1) return baseName;

        var weekday = weekDay switch
        {
            0 => "周日",
            1 => "周一",
            2 => "周二",
            3 => "周三",
            4 => "周四",
            5 => "周五",
            6 => "周六",
            _ => $"星期{weekDay}",
        };
        var parity = weekCountDivTotal <= 1
            ? "每周"
            : $"第{weekCountDiv}/{weekCountDivTotal}周";
        return $"{baseName} · {weekday} · {parity}";
    }

    /// <summary>"HH:mm" / "HH:mm:ss" → TimeSpan（解析失败回退到 0 点）。</summary>
    private static TimeSpan ParseTime(string value)
    {
        return TimeSpan.TryParse(value, out var parsed) ? parsed : TimeSpan.Zero;
    }
}
