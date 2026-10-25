import { isDayKey } from './utils.js';

export const ISLAND_COMPONENTS = [
  'date',
  'clock',
  'weather',
  'countdown',
  'schedule',
  'text',
  'separator',
  'slide',
  'rolling',
  'group',
  'stack',
  'notification',
  'homework',
  'call',
] as const;
/** ClassIsland master：MainWindowLine 与 Models/Settings.cs（2026-10-17 核对）。 */
export const CLASSISLAND_ISLAND_METRICS = {
  rowHeight: 40,
  horizontalPadding: 12,
  radius: 8,
  opacity: 0.5,
  scale: 1,
  scaleMin: 0.75,
  scaleMax: 2.5,
  radiusMax: 20,
  rowSpacingMax: 150,
  secondaryFontSize: 14,
  bodyFontSize: 16,
  emphasizedFontSize: 18,
  largeFontSize: 20,
  rowSpacing: 5,
  fadedOpacity: 0.05,
} as const;
export type IslandComponentKind = (typeof ISLAND_COMPONENTS)[number];
export interface IslandWeather {
  temperature: number;
  code: number;
  windSpeed: number;
  fetchedAt: number;
  stale: boolean;
}
export const ISLAND_COMPONENT_LABELS: Record<IslandComponentKind, string> = {
  date: '日期',
  clock: '时钟',
  weather: '天气简报',
  countdown: '倒计时',
  schedule: '课程表',
  text: '文本',
  separator: '分割线',
  slide: '轮播容器',
  rolling: '滚动容器',
  group: '分组容器',
  stack: '堆叠容器',
  notification: '通知',
  homework: '作业',
  call: '叫人',
};
export interface ComponentAppearance {
  resourceOverridingEnabled: boolean;
  secondaryFontSize: number;
  bodyFontSize: number;
  emphasizedFontSize: number;
  largeFontSize: number;
  customForegroundEnabled: boolean;
  foreground: string;
  customBackgroundEnabled: boolean;
  background: string;
  customBackgroundOpacityEnabled: boolean;
  backgroundOpacity: number;
  customCornerRadiusEnabled: boolean;
  cornerRadius: number;
  opacity: number;
}
export interface IslandComponentNode {
  id: string;
  kind: IslandComponentKind;
  settings: {
    text: string;
    template: boolean;
    hour12: boolean;
    seconds: boolean;
    target: 'auto' | 'next' | 'end' | 'school' | 'date';
    targetDate: string;
    countdownTitle: string;
    locationName: string;
    latitude: number | null;
    longitude: number | null;
    display: 'current' | 'next' | 'today';
    count: number;
    showPeriod: boolean;
    showProgress: boolean;
    direction: 'horizontal' | 'vertical';
    gap: number;
    interval: number;
    speed: number;
  };
  appearance: ComponentAppearance;
  advanced: {
    hideRules: ('in-class' | 'no-message' | 'no-class')[];
    align: 'stretch' | 'start' | 'center' | 'end';
    width: number;
    maxWidth: number;
  };
  children: IslandComponentNode[];
}
export interface IslandLayoutRow {
  id: string;
  name: string;
  main: boolean;
  allowNotifications: boolean;
  gap: number;
  nodes: IslandComponentNode[];
}
export interface IslandLayoutScheme {
  id: string;
  name: string;
  rows: IslandLayoutRow[];
  /** 常驻岛没有待处理通知时，点击展开所显示的内容。 */
  expandedRows: IslandLayoutRow[];
  scale: number;
  color: string;
  foreground: string;
  opacity: number;
  radius: number;
  separated: boolean;
  spacing: number;
}
export interface IslandLayoutSettings {
  layout: 'fixed' | 'custom';
  residentEnabled: boolean;
  pointerFadeEnabled: boolean;
  pointerFadeReversed: boolean;
  lessonReminders: LessonReminderSettings;
  activeSchemeId: string;
  schemes: IslandLayoutScheme[];
}
/** 上下课通道独立开关；倒数阈值以秒计，配置随本机方案保存。 */
export interface LessonReminderSettings {
  prepareEnabled: boolean;
  onClassEnabled: boolean;
  breakEnabled: boolean;
  endingEnabled: boolean;
  classProgressEnabled: boolean;
  prepareSeconds: number;
  endingSeconds: number;
}
export const DEFAULT_LESSON_REMINDERS: LessonReminderSettings = {
  prepareEnabled: true,
  onClassEnabled: true,
  breakEnabled: true,
  endingEnabled: true,
  classProgressEnabled: true,
  prepareSeconds: 60,
  endingSeconds: 60,
};
function defaultExpandedRows(): IslandLayoutRow[] {
  const course = islandNode('schedule', 'expanded-schedule');
  course.settings.display = 'today';
  return [
    {
      id: 'expanded-main',
      name: '展开内容',
      main: true,
      allowNotifications: false,
      gap: 12,
      nodes: [islandNode('date', 'expanded-date'), course],
    },
  ];
}
export function islandNode(kind: IslandComponentKind, id: string): IslandComponentNode {
  return {
    id,
    kind,
    children: [],
    settings: {
      text: '班级信息',
      template: false,
      hour12: false,
      seconds: true,
      target: 'auto',
      targetDate: '',
      countdownTitle: '目标日',
      locationName: '',
      latitude: null,
      longitude: null,
      display: 'current',
      count: 5,
      showPeriod: true,
      showProgress: true,
      direction: 'horizontal',
      gap: 8,
      interval: 5,
      speed: 30,
    },
    appearance: {
      resourceOverridingEnabled: false,
      secondaryFontSize: 14,
      bodyFontSize: 16,
      emphasizedFontSize: 18,
      largeFontSize: 20,
      customForegroundEnabled: false,
      foreground: '#ffffff',
      customBackgroundEnabled: false,
      background: '#202024',
      customBackgroundOpacityEnabled: false,
      backgroundOpacity: 0.5,
      customCornerRadiusEnabled: false,
      cornerRadius: 16,
      opacity: 1,
    },
    advanced: { hideRules: [], align: 'stretch', width: 0, maxWidth: 0 },
  };
}
export function defaultIslandLayouts(): IslandLayoutSettings {
  return {
    layout: 'fixed',
    residentEnabled: false,
    pointerFadeEnabled: true,
    pointerFadeReversed: false,
    lessonReminders: { ...DEFAULT_LESSON_REMINDERS },
    activeSchemeId: 'default',
    schemes: [
      {
        id: 'default',
        name: '默认组件方案',
        expandedRows: defaultExpandedRows(),
        rows: [
          {
            id: 'main',
            name: '主要行',
            main: true,
            allowNotifications: true,
            gap: 12,
            nodes: [
              islandNode('date', 'date'),
              islandNode('clock', 'clock'),
              islandNode('schedule', 'schedule'),
              islandNode('notification', 'messages'),
            ],
          },
        ],
        scale: 1,
        color: '#000000',
        foreground: '#ffffff',
        opacity: 0.5,
        radius: 8,
        separated: false,
        spacing: 5,
      },
    ],
  };
}
/** 导入/IPC 配置有同一边界：最多 12 行/200 节点/6 层，颜色和数值全部归一化。 */
export function normalizeIslandLayouts(input: unknown): IslandLayoutSettings {
  const fallback = defaultIslandLayouts();
  if (!input || typeof input !== 'object') return fallback;
  const raw = input as IslandLayoutSettings;
  const resident = raw.layout === 'custom';
  const clamp = (n: unknown, min: number, max: number, value: number) =>
    typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : value;
  const color = (v: unknown, value: string) =>
    typeof v === 'string' && /^#[\da-f]{6}$/i.test(v) ? v : value;
  let count = 0;
  const ids = new Set<string>();
  const node = (n: IslandComponentNode, depth: number): IslandComponentNode | null => {
    if (!n || depth > 6 || ++count > 200 || !ISLAND_COMPONENTS.includes(n.kind)) return null;
    const id = typeof n.id === 'string' && n.id && !ids.has(n.id) ? n.id.slice(0, 100) : `node-${count}`;
    ids.add(id);
    const base = islandNode(n.kind, id),
      a = n.appearance || base.appearance,
      s = n.settings || base.settings,
      adv = n.advanced || base.advanced;
    return {
      ...base,
      settings: {
        ...base.settings,
        text: String(s.text || '').slice(0, 2000),
        template: s.template === true,
        hour12: s.hour12 === true,
        seconds: s.seconds !== false,
        target: ['auto', 'next', 'end', 'school', 'date'].includes(s.target) ? s.target : 'auto',
        targetDate: typeof s.targetDate === 'string' && isDayKey(s.targetDate) ? s.targetDate : '',
        countdownTitle: String(s.countdownTitle || '目标日').slice(0, 64),
        locationName: String(s.locationName || '').slice(0, 64),
        latitude:
          typeof s.latitude === 'number' && Number.isFinite(s.latitude)
            ? clamp(s.latitude, -90, 90, 0)
            : null,
        longitude:
          typeof s.longitude === 'number' && Number.isFinite(s.longitude)
            ? clamp(s.longitude, -180, 180, 0)
            : null,
        display: ['current', 'next', 'today'].includes(s.display) ? s.display : 'current',
        count: clamp(s.count, 1, 40, 5),
        showPeriod: s.showPeriod !== false,
        showProgress: s.showProgress !== false,
        direction: s.direction === 'vertical' ? 'vertical' : 'horizontal',
        gap: clamp(s.gap, 0, 64, 8),
        interval: clamp(s.interval, 1, 300, 5),
        speed: clamp(s.speed, 1, 200, 30),
      },
      appearance: {
        resourceOverridingEnabled: a.resourceOverridingEnabled === true,
        secondaryFontSize: clamp(a.secondaryFontSize, 8, 96, 14),
        bodyFontSize: clamp(a.bodyFontSize, 8, 96, 16),
        emphasizedFontSize: clamp(a.emphasizedFontSize, 8, 96, 18),
        largeFontSize: clamp(a.largeFontSize, 8, 128, 20),
        customForegroundEnabled: a.customForegroundEnabled === true,
        foreground: color(a.foreground, '#ffffff'),
        customBackgroundEnabled: a.customBackgroundEnabled === true,
        background: color(a.background, '#202024'),
        customBackgroundOpacityEnabled: a.customBackgroundOpacityEnabled === true,
        backgroundOpacity: clamp(a.backgroundOpacity, 0, 1, 0.5),
        customCornerRadiusEnabled: a.customCornerRadiusEnabled === true,
        cornerRadius: clamp(a.cornerRadius, 0, 100, 16),
        opacity: clamp(a.opacity, 0, 1, 1),
      },
      advanced: {
        hideRules: Array.isArray(adv.hideRules)
          ? adv.hideRules.filter((r) => ['in-class', 'no-message', 'no-class'].includes(r))
          : [],
        align: ['stretch', 'start', 'center', 'end'].includes(adv.align) ? adv.align : 'stretch',
        width: clamp(adv.width, 0, 2000, 0),
        maxWidth: clamp(adv.maxWidth, 0, 2000, 0),
      },
      children: Array.isArray(n.children)
        ? n.children.map((c) => node(c, depth + 1)).filter((n): n is IslandComponentNode => Boolean(n))
        : [],
    };
  };
  const normalizeRows = (input: IslandLayoutRow[]): IslandLayoutRow[] => {
    const rows = input
      .filter((r) => r && typeof r === 'object')
      .slice(0, 12)
      .map((r, i) => ({
        id: String(r.id || `row-${i}`).slice(0, 100),
        name: String(r.name || `行 ${i + 1}`).slice(0, 64),
        main: r.main === true,
        allowNotifications: r.allowNotifications !== false,
        gap: clamp(r.gap, 0, 64, 8),
        nodes: (Array.isArray(r.nodes) ? r.nodes : [])
          .map((n) => node(n, 0))
          .filter((n): n is IslandComponentNode => Boolean(n)),
      }));
    if (!rows.length) return [];
    if (!rows.some((r) => r.main)) rows[0]!.main = true;
    let main = false;
    for (const r of rows) {
      if (r.main && main) r.main = false;
      if (r.main) main = true;
    }
    return rows;
  };
  const schemes: IslandLayoutScheme[] = [];
  for (const scheme of (Array.isArray(raw.schemes) ? raw.schemes : []).slice(0, 20)) {
    if (!scheme || !Array.isArray(scheme.rows)) continue;
    const rows = normalizeRows(scheme.rows);
    if (!rows.length) continue;
    const expandedRows = normalizeRows(
      Array.isArray(scheme.expandedRows) ? scheme.expandedRows : defaultExpandedRows(),
    );
    schemes.push({
      id: String(scheme.id || `scheme-${schemes.length}`).slice(0, 100),
      name: String(scheme.name || '组件方案').slice(0, 64),
      rows,
      expandedRows: expandedRows.length ? expandedRows : normalizeRows(defaultExpandedRows()),
      scale: clamp(
        scheme.scale,
        resident ? CLASSISLAND_ISLAND_METRICS.scaleMin : 0.5,
        resident ? CLASSISLAND_ISLAND_METRICS.scaleMax : 3,
        1,
      ),
      color: color(scheme.color, '#000000'),
      foreground: color(scheme.foreground, '#ffffff'),
      opacity: clamp(scheme.opacity, resident ? 0 : 0.1, 1, 0.5),
      radius: clamp(scheme.radius, 0, resident ? CLASSISLAND_ISLAND_METRICS.radiusMax : 100, 8),
      separated: scheme.separated === true,
      spacing: clamp(scheme.spacing, 0, resident ? CLASSISLAND_ISLAND_METRICS.rowSpacingMax : 100, 5),
    });
  }
  return {
    layout: raw.layout === 'custom' ? 'custom' : 'fixed',
    // 旧常驻开关保留为兼容字段；自定义布局统一常驻，不再分成两种运行模式。
    residentEnabled: raw.layout === 'custom',
    pointerFadeEnabled: raw.pointerFadeEnabled !== false,
    pointerFadeReversed: raw.pointerFadeReversed === true,
    lessonReminders: {
      prepareEnabled: raw.lessonReminders?.prepareEnabled !== false,
      onClassEnabled: raw.lessonReminders?.onClassEnabled !== false,
      breakEnabled: raw.lessonReminders?.breakEnabled !== false,
      endingEnabled: raw.lessonReminders?.endingEnabled !== false,
      classProgressEnabled: raw.lessonReminders?.classProgressEnabled !== false,
      prepareSeconds: clamp(raw.lessonReminders?.prepareSeconds, 5, 1800, 60),
      endingSeconds: clamp(raw.lessonReminders?.endingSeconds, 5, 600, 60),
    },
    schemes: schemes.length ? schemes : fallback.schemes,
    activeSchemeId: schemes.some((s) => s.id === raw.activeSchemeId)
      ? raw.activeSchemeId
      : schemes[0]?.id || 'default',
  };
}
