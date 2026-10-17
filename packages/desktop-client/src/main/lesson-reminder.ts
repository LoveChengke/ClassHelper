import {
  dayKeyLocal,
  resolveClassStatus,
  DEFAULT_LESSON_REMINDERS,
  type LessonReminderSettings,
  type IslandLessonReminder,
  type ScheduleDto,
} from '@classhelper/shared';

/**
 * 来源：ClassIsland/Services/NotificationProviders/ClassNotificationProvider.cs。
 * 室内课提前 60 秒，准备遮罩 3 秒，上课 5 秒，下课遮罩 2 秒后预告下节课 10 秒。
 * 只消费服务端已经解析的日课表投影；不在这里重写 ClassPlan 启用或轮换规则。
 */
export class LessonReminderTracker {
  private current: IslandLessonReminder | null = null;

  update(
    schedules: ScheduleDto[],
    now: Date,
    settings: LessonReminderSettings = DEFAULT_LESSON_REMINDERS,
  ): IslandLessonReminder | null {
    const at = now.getTime();
    const keyOf = (s: ScheduleDto, kind: IslandLessonReminder['kind']) =>
      `${dayKeyLocal(now)}:${s.id}:${s.startTime}:${s.endTime}:${kind}`;
    const status = resolveClassStatus(schedules, now);
    const timeAt = (time: string) => {
      const d = new Date(now);
      const [h, m] = time.split(':').map(Number);
      d.setHours(h!, m!, 0, 0);
      return d.getTime();
    };
    const today = schedules.filter((s) => s.dayOfWeek === (now.getDay() || 7));
    const current = today.find((s) => s.id === status.current?.scheduleId);
    const next = today.find((s) => s.id === status.next?.scheduleId);
    const ended = today
      .filter((s) => at >= timeAt(s.endTime) && at - timeAt(s.endTime) < 12_000)
      .sort((a, b) => b.endTime.localeCompare(a.endTime))[0];
    let kind: IslandLessonReminder['kind'] | null = null;
    let lesson: ScheduleDto | undefined;
    if (current && at - timeAt(current.startTime) < 5_000 && settings.onClassEnabled) {
      kind = 'on-class';
      lesson = current;
    } else if (
      settings.breakEnabled &&
      !current &&
      ended &&
      at - timeAt(ended.endTime) < (next ? 12_000 : 5_000) &&
      (at - timeAt(ended.endTime) < 5_000 || this.current?.id === keyOf(ended, 'break'))
    ) {
      kind = 'break';
      lesson = ended;
    } else if (
      current &&
      settings.endingEnabled &&
      timeAt(current.endTime) - at <= settings.endingSeconds * 1000
    ) {
      kind = 'ending';
      lesson = current;
    } else if (
      !current &&
      next &&
      settings.prepareEnabled &&
      timeAt(next.startTime) - at <= settings.prepareSeconds * 1000
    ) {
      kind = 'prepare';
      lesson = next;
    } else if (current && settings.classProgressEnabled) {
      kind = 'in-class';
      lesson = current;
    }
    if (!lesson || !kind) return (this.current = null);
    const id = keyOf(lesson, kind);
    const entered = this.current?.id === id && at >= this.current.startedAt ? this.current.startedAt : at;
    const start = timeAt(lesson.startTime);
    const end = timeAt(lesson.endTime);
    return (this.current = {
      id,
      kind,
      courseName: lesson.course?.name || '课程',
      startTime: lesson.startTime,
      endTime: lesson.endTime,
      startedAt: entered,
      maskUntil:
        kind === 'ending' || kind === 'in-class'
          ? entered
          : kind === 'prepare'
            ? Math.min(start, entered + 3000)
            : kind === 'break' && next
              ? entered + 2000
              : entered + 5000,
      endsAt:
        kind === 'ending' || kind === 'in-class'
          ? end
          : kind === 'prepare'
            ? start
            : kind === 'on-class'
              ? start + 5000
              : end + (next ? 12_000 : 5000),
      lessonStartsAt: start,
      lessonEndsAt: end,
      nextCourseName: kind === 'break' ? next?.course?.name : undefined,
      nextStartTime: kind === 'break' ? next?.startTime : undefined,
      nextEndTime: kind === 'break' ? next?.endTime : undefined,
    });
  }
}
