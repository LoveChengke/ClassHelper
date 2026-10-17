export const ISLAND_COMPONENTS = [
  'date',
  'clock',
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
export type IslandComponentKind = (typeof ISLAND_COMPONENTS)[number];
export const ISLAND_COMPONENT_LABELS: Record<IslandComponentKind, string> = {
  date: '日期',
  clock: '时钟',
  countdown: '倒计时',
  schedule: '课程表',
  text: '文本',
  separator: '分隔符',
  slide: '轮播',
  rolling: '滚动',
  group: '分组',
  stack: '堆叠',
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
    target: 'next' | 'school';
    display: 'current' | 'next' | 'today';
    count: number;
    showPeriod: boolean;
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
  activeSchemeId: string;
  schemes: IslandLayoutScheme[];
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
      target: 'next',
      display: 'current',
      count: 5,
      showPeriod: true,
      direction: 'horizontal',
      gap: 8,
      interval: 5,
      speed: 30,
    },
    appearance: {
      resourceOverridingEnabled: false,
      secondaryFontSize: 12,
      bodyFontSize: 16,
      emphasizedFontSize: 20,
      largeFontSize: 28,
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
    activeSchemeId: 'default',
    schemes: [
      {
        id: 'default',
        name: '默认组件方案',
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
        color: '#202024',
        foreground: '#ffffff',
        opacity: 0.85,
        radius: 24,
        separated: false,
        spacing: 8,
      },
    ],
  };
}
/** 导入/IPC 配置有同一边界：最多 12 行/200 节点/6 层，颜色和数值全部归一化。 */
export function normalizeIslandLayouts(input: unknown): IslandLayoutSettings {
  const fallback = defaultIslandLayouts();
  if (!input || typeof input !== 'object') return fallback;
  const raw = input as IslandLayoutSettings;
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
        target: s.target === 'school' ? 'school' : 'next',
        display: ['current', 'next', 'today'].includes(s.display) ? s.display : 'current',
        count: clamp(s.count, 1, 40, 5),
        showPeriod: s.showPeriod !== false,
        direction: s.direction === 'vertical' ? 'vertical' : 'horizontal',
        gap: clamp(s.gap, 0, 64, 8),
        interval: clamp(s.interval, 1, 300, 5),
        speed: clamp(s.speed, 1, 200, 30),
      },
      appearance: {
        resourceOverridingEnabled: a.resourceOverridingEnabled === true,
        secondaryFontSize: clamp(a.secondaryFontSize, 8, 96, 12),
        bodyFontSize: clamp(a.bodyFontSize, 8, 96, 16),
        emphasizedFontSize: clamp(a.emphasizedFontSize, 8, 96, 20),
        largeFontSize: clamp(a.largeFontSize, 8, 128, 28),
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
  const schemes: IslandLayoutScheme[] = [];
  for (const scheme of (Array.isArray(raw.schemes) ? raw.schemes : []).slice(0, 20)) {
    if (!scheme || !Array.isArray(scheme.rows)) continue;
    const rows = scheme.rows
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
    if (!rows.length) continue;
    if (!rows.some((r) => r.main)) rows[0]!.main = true;
    let main = false;
    for (const r of rows) {
      if (r.main && main) r.main = false;
      if (r.main) main = true;
    }
    schemes.push({
      id: String(scheme.id || `scheme-${schemes.length}`).slice(0, 100),
      name: String(scheme.name || '组件方案').slice(0, 64),
      rows,
      scale: clamp(scheme.scale, 0.5, 3, 1),
      color: color(scheme.color, '#202024'),
      foreground: color(scheme.foreground, '#ffffff'),
      opacity: clamp(scheme.opacity, 0.1, 1, 0.85),
      radius: clamp(scheme.radius, 0, 100, 24),
      separated: scheme.separated === true,
      spacing: clamp(scheme.spacing, 0, 100, 8),
    });
  }
  return {
    layout: raw.layout === 'custom' ? 'custom' : 'fixed',
    schemes: schemes.length ? schemes : fallback.schemes,
    activeSchemeId: schemes.some((s) => s.id === raw.activeSchemeId)
      ? raw.activeSchemeId
      : schemes[0]?.id || 'default',
  };
}
