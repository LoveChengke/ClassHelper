export interface DateMark {
  date: string;
  count: number;
}
export interface CalendarRange {
  from: string;
  to: string;
}
export const ONBOARDING_VERSION = 2;

export function localDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function visibleCalendarRange(value: unknown): CalendarRange {
  const values = Array.isArray(value) ? value : [value];
  const dates = values
    .map((item) => {
      if (item instanceof Date) return item;
      if (typeof item === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item)) return new Date(`${item}T12:00:00`);
      return typeof item === 'string' || typeof item === 'number' ? new Date(item) : new Date();
    })
    .filter((date) => Number.isFinite(date.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());
  const first = dates[0] ?? new Date(),
    last = dates.at(-1) ?? first;
  return {
    from: localDay(new Date(first.getFullYear(), first.getMonth(), -6)),
    to: localDay(new Date(last.getFullYear(), last.getMonth() + 1, 14)),
  };
}

export function countDates<T>(items: readonly T[], getDate: (item: T) => string): DateMark[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const date = getDate(item);
    counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  return [...counts].map(([date, count]) => ({ date, count }));
}
