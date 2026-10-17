<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch, type CSSProperties } from 'vue';
import {
  ISLAND_COMPONENTS,
  ISLAND_COMPONENT_LABELS,
  ISLAND_SHADOW_PAD,
  islandNode,
  normalizeIslandLayouts,
  type IslandLayoutSettings,
  type IslandComponentKind,
  type IslandComponentNode,
  type IslandState,
  type ScheduleDto,
} from '@classhelper/shared';
import ComponentNode from './ComponentNode.vue';
const props = defineProps<{
  settings: IslandLayoutSettings;
  state: IslandState;
  editing: boolean;
  schedules: ScheduleDto[];
}>();
const emit = defineEmits<{
  save: [settings: IslandLayoutSettings];
  done: [];
  host: [element: HTMLElement | null];
}>();
function hostRef(element: unknown) {
  emit('host', element instanceof HTMLElement ? element : null);
}
const draft = ref(normalizeIslandLayouts(props.settings));
watch(
  () => props.settings,
  (s) => {
    draft.value = normalizeIslandLayouts(s);
  },
  { deep: true },
);
const scheme = computed(() => draft.value.schemes.find((s) => s.id === draft.value.activeSchemeId)!);
const selectedId = ref(''),
  selectedKind = ref<IslandComponentKind>('clock');
const now = ref(Date.now()),
  canvasScale = ref(1),
  pan = ref({ x: 0, y: 0 });
const shell = ref<HTMLElement>(),
  inner = ref<HTMLElement>();
const viewport = ref({ width: 0, height: 0 });
function allNodes(nodes: IslandComponentNode[]): IslandComponentNode[] {
  return nodes.flatMap((n) => [n, ...allNodes(n.children)]);
}
const selected = computed(() =>
  scheme.value.rows.flatMap((r) => allNodes(r.nodes)).find((n) => n.id === selectedId.value),
);
const alertRow = computed(
  () =>
    scheme.value.rows.find((r) => r.main && r.allowNotifications) ||
    scheme.value.rows.find((r) => r.allowNotifications),
);
const alertNodeId = computed(() => {
  const kind = props.state.active?.kind ?? 'notification';
  return (
    (alertRow.value &&
      allNodes(alertRow.value.nodes).find((n) => n.kind === kind || n.kind === 'notification')?.id) ||
    ''
  );
});
const hasMessage = computed(() => props.state.mode !== 'hidden' && Boolean(props.state.active));
const shellStyle = computed<CSSProperties>(() => ({
  width: viewport.value.width ? `${viewport.value.width}px` : 'max-content',
  minHeight: viewport.value.height ? `${viewport.value.height}px` : undefined,
  maxWidth: `calc(100vw - ${2 * ISLAND_SHADOW_PAD}px)`,
  maxHeight: `calc(100vh - ${2 * ISLAND_SHADOW_PAD}px)`,
  color: scheme.value.foreground,
  fontSize: '16px',
  '--custom-color':
    scheme.value.color +
    Math.round(scheme.value.opacity * 255)
      .toString(16)
      .padStart(2, '0'),
  '--custom-radius': `${scheme.value.radius}px`,
  gap: `${scheme.value.spacing}px`,
}));
function id() {
  return `node-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
function save() {
  const value = normalizeIslandLayouts(JSON.parse(JSON.stringify(draft.value)));
  draft.value = value;
  emit('save', value);
}
function addRow(after: number) {
  scheme.value.rows.splice(after + 1, 0, {
    id: id(),
    name: '新主界面行',
    main: false,
    allowNotifications: true,
    gap: 8,
    nodes: [],
  });
  save();
}
function add(kind = selectedKind.value, row = scheme.value.rows[0]) {
  if (!row) return;
  const n = islandNode(kind, id());
  row.nodes.push(n);
  selectedId.value = n.id;
  save();
}
function findList(nodeId: string, nodes?: IslandComponentNode[]): IslandComponentNode[] | null {
  for (const list of nodes ? [nodes] : scheme.value.rows.map((r) => r.nodes)) {
    if (list.some((n) => n.id === nodeId)) return list;
    for (const n of list) {
      const found = findList(nodeId, n.children);
      if (found) return found;
    }
  }
  return null;
}
function remove() {
  const list = findList(selectedId.value);
  if (list)
    list.splice(
      list.findIndex((n) => n.id === selectedId.value),
      1,
    );
  selectedId.value = '';
  save();
}
function duplicate() {
  const n = selected.value,
    list = findList(selectedId.value);
  if (!n || !list) return;
  const copy = JSON.parse(JSON.stringify(n)) as IslandComponentNode;
  for (const child of allNodes([copy])) child.id = id();
  list.splice(list.indexOf(n) + 1, 0, copy);
  selectedId.value = copy.id;
  save();
}
function wrap(kind: IslandComponentKind) {
  if (!['slide', 'rolling', 'group', 'stack'].includes(kind)) return;
  const n = selected.value,
    list = findList(selectedId.value);
  if (!n || !list) return;
  const container = islandNode(kind, id());
  container.children = [n];
  list.splice(list.indexOf(n), 1, container);
  selectedId.value = container.id;
  save();
}
function newScheme() {
  const name = `新方案 ${draft.value.schemes.length + 1}`;
  const copy = JSON.parse(JSON.stringify(scheme.value));
  copy.id = id();
  copy.name = name;
  for (const r of copy.rows) {
    r.id = id();
    for (const n of allNodes(r.nodes)) n.id = id();
  }
  draft.value.schemes.push(copy);
  draft.value.activeSchemeId = copy.id;
  save();
}
function exportScheme() {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify({ format: 'classhelper-island-layout', scheme: scheme.value }, null, 2)], {
      type: 'application/json',
    }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = `${scheme.value.name}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
const error = ref('');
async function importScheme(event: Event) {
  try {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file || file.size > 1_000_000) throw new Error('请选择小于 1MB 的 JSON');
    const parsed = JSON.parse(await file.text());
    if (parsed.format !== 'classhelper-island-layout') throw new Error('方案格式不正确');
    const value = normalizeIslandLayouts({
      layout: 'custom',
      activeSchemeId: parsed.scheme.id,
      schemes: [parsed.scheme],
    });
    const s = value.schemes[0]!;
    s.id = id();
    draft.value.schemes.push(s);
    draft.value.activeSchemeId = s.id;
    save();
  } catch (e) {
    error.value = String(e);
  }
}
let drag: {
  type: 'node' | 'library' | 'row';
  id: string;
  kind?: IslandComponentKind;
  rowId?: string;
  targetId?: string;
} | null = null;
function startDrag(
  event: PointerEvent,
  type: 'node' | 'library' | 'row',
  nodeId: string,
  kind?: IslandComponentKind,
) {
  event.preventDefault();
  event.stopPropagation();
  try {
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  } catch {
    /* 合成事件无活动指针；真实触摸使用捕获 */
  }
  drag = { type, id: nodeId, kind };
}
function move(event: PointerEvent) {
  if (!drag) return;
  const element = document.elementFromPoint(event.clientX, event.clientY);
  drag.rowId = element?.closest<HTMLElement>('[data-row]')?.dataset.row;
  drag.targetId = element?.closest<HTMLElement>('[data-node]')?.dataset.node;
}
function drop() {
  if (!drag) return;
  const moving = drag;
  drag = null;
  const row = scheme.value.rows.find((r) => r.id === moving.rowId);
  if (!row) return;
  if (moving.type === 'library') {
    add(moving.kind, row);
    return;
  }
  if (moving.type === 'row') {
    const from = scheme.value.rows.findIndex((r) => r.id === moving.id),
      to = scheme.value.rows.indexOf(row);
    if (from >= 0) scheme.value.rows.splice(to, 0, scheme.value.rows.splice(from, 1)[0]!);
    save();
    return;
  }
  const list = findList(moving.id),
    node = list?.find((n) => n.id === moving.id);
  if (!list || !node || allNodes([node]).some((n) => n.id === moving.targetId)) return;
  const target = allNodes(row.nodes).find((n) => n.id === moving.targetId);
  list.splice(list.indexOf(node), 1);
  if (target && ['group', 'stack', 'slide', 'rolling'].includes(target.kind)) target.children.push(node);
  else if (target) {
    const targetList = findList(target.id)!;
    targetList.splice(targetList.indexOf(target), 0, node);
  } else row.nodes.push(node);
  selectedId.value = node.id;
  save();
}
let panning: { x: number; y: number; originX: number; originY: number } | null = null;
function panStart(e: PointerEvent) {
  if (e.target !== e.currentTarget) return;
  panning = { x: e.clientX, y: e.clientY, originX: pan.value.x, originY: pan.value.y };
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}
function panMove(e: PointerEvent) {
  if (panning)
    pan.value = { x: panning.originX + e.clientX - panning.x, y: panning.originY + e.clientY - panning.y };
  move(e);
}
let observer: ResizeObserver | undefined,
  measureTimer: ReturnType<typeof setTimeout> | undefined,
  clock: ReturnType<typeof setInterval>;
function measure() {
  clearTimeout(measureTimer);
  measureTimer = setTimeout(() => {
    if (inner.value) {
      const rect = inner.value.getBoundingClientRect(),
        scale = props.editing ? canvasScale.value : 1;
      window.island?.reportSize({
        width: Math.ceil(rect.width / scale + 24),
        height: Math.ceil(rect.height / scale + 24),
      });
    }
  }, 120);
}
watch([() => props.editing, scheme, () => props.state], () => void nextTick(measure), { deep: true });
onMounted(() => {
  clock = setInterval(() => (now.value = Date.now()), 1000);
  observer = new ResizeObserver(measure);
  if (inner.value) observer.observe(inner.value);
  window.island?.onViewport((v) => (viewport.value = v));
  measure();
});
onUnmounted(() => {
  clearInterval(clock);
  clearTimeout(measureTimer);
  observer?.disconnect();
});
</script>
<template>
  <div
    :class="editing ? 'layout-editor' : 'custom-window'"
    @pointermove="panMove"
    @pointerup="
      drop();
      panning = null;
    "
    @pointercancel="
      drag = null;
      panning = null;
    "
  >
    <header v-if="editing">
      <strong>编辑灵动岛</strong>
      <select
        v-model="draft.activeSchemeId"
        @change="
          selectedId = '';
          save();
        "
      >
        <option v-for="s in draft.schemes" :key="s.id" :value="s.id">{{ s.name }}</option>
      </select>
      <button @click="newScheme">新方案</button>
      <button @click="exportScheme">导出</button>
      <label>
        导入
        <input type="file" accept="application/json" @change="importScheme" />
      </label>
      <button
        @click="
          pan = { x: 0, y: 0 };
          canvasScale = 1;
        "
      >
        重置视图
      </button>
      <label>
        画布缩放
        <input type="range" v-model.number="canvasScale" min="0.3" max="2" step="0.1" />
      </label>
      <button
        @click="
          save();
          emit('done');
        "
      >
        完成
      </button>
    </header>
    <aside v-if="editing" class="library">
      <h3>组件库</h3>
      <button
        v-for="kind in ISLAND_COMPONENTS"
        :key="kind"
        @pointerdown="startDrag($event, 'library', '', kind)"
        @click="selectedKind = kind"
      >
        {{ ISLAND_COMPONENT_LABELS[kind as IslandComponentKind] }}
      </button>
      <select v-model="selectedKind">
        <option v-for="kind in ISLAND_COMPONENTS" :key="kind" :value="kind">
          {{ ISLAND_COMPONENT_LABELS[kind as IslandComponentKind] }}
        </option>
      </select>
      <button @click="add()">点选并添加</button>
      <p>拖到组件栏；拖到容器可嵌套。支持触摸。</p>
      <h3>外观</h3>
      <label>
        方案名称
        <input v-model="scheme.name" @change="save" />
      </label>
      <label>
        缩放
        <input type="number" v-model.number="scheme.scale" min="0.5" max="3" step="0.1" @change="save" />
      </label>
      <label>
        背景
        <input type="color" v-model="scheme.color" @change="save" />
      </label>
      <label>
        前景
        <input type="color" v-model="scheme.foreground" @change="save" />
      </label>
      <label>
        透明度
        <input type="number" v-model.number="scheme.opacity" min="0.1" max="1" step="0.05" @change="save" />
      </label>
      <label>
        圆角
        <input type="number" v-model.number="scheme.radius" min="0" max="100" @change="save" />
      </label>
      <label>
        <input type="checkbox" v-model="scheme.separated" @change="save" />
        分离成多块
      </label>
      <label>
        行间距
        <input type="number" v-model.number="scheme.spacing" @change="save" />
      </label>
    </aside>
    <main :class="{ canvas: editing }" @pointerdown="panStart">
      <div
        ref="shell"
        class="custom-card"
        :class="{ separated: scheme.separated }"
        :style="[
          shellStyle,
          editing
            ? {
                transform: `translate(${pan.x}px,${pan.y}px) scale(${canvasScale})`,
                width: 'max-content',
                maxWidth: 'none',
                maxHeight: 'none',
              }
            : {},
        ]"
      >
        <div ref="inner" class="custom-inner" :style="{ zoom: scheme.scale }">
          <section
            v-for="(row, i) in scheme.rows"
            :key="row.id"
            :data-row="row.id"
            class="layout-row"
            :style="{ gap: `${row.gap}px` }"
          >
            <div v-if="editing" class="row-tools">
              <button @pointerdown="startDrag($event, 'row', row.id)">⠿ 拖动行</button>
              <input v-model="row.name" @change="save" />
              <label>
                间距
                <input type="number" v-model.number="row.gap" @change="save" />
              </label>
              <button
                @click="
                  scheme.rows.forEach((r) => (r.main = r === row));
                  save();
                "
              >
                {{ row.main ? '主要行' : '设为主要行' }}
              </button>
              <label>
                <input type="checkbox" v-model="row.allowNotifications" @change="save" />
                允许通知
              </label>
              <button
                :disabled="scheme.rows.length < 2"
                @click="
                  scheme.rows.splice(i, 1);
                  save();
                "
              >
                删除行
              </button>
            </div>
            <div class="row-content">
              <ComponentNode
                v-for="n in row.nodes"
                :key="n.id"
                :node="n"
                :state="state"
                :now="now"
                :schedules="schedules"
                :editing="editing"
                :selected-id="selectedId"
                :alert-node-id="alertNodeId"
                @select="selectedId = $event"
                @drag="(e, id) => startDrag(e, 'node', id)"
              >
                <template #alerts><div id="custom-alert-host" :ref="hostRef" v-show="hasMessage" /></template>
              </ComponentNode>
              <div
                v-if="row.id === alertRow?.id && !alertNodeId"
                id="custom-alert-host"
                :ref="hostRef"
                v-show="hasMessage"
              />
            </div>
            <button v-if="editing" @click="addRow(i)">在下方新建主界面行</button>
          </section>
        </div>
      </div>
    </main>
    <div v-if="!alertRow" id="custom-alert-host" :ref="hostRef" style="display: none" />
    <aside v-if="editing" class="settings">
      <template v-if="selected">
        <h3>{{ ISLAND_COMPONENT_LABELS[selected.kind] }} 组件设置</h3>
        <button @click="remove">删除组件</button>
        <button @click="duplicate">创建副本</button>
        <label>
          包裹到新容器
          <select @change="wrap(($event.target as HTMLSelectElement).value as IslandComponentKind)">
            <option value="">选择容器</option>
            <option v-for="kind in ['slide', 'rolling', 'group', 'stack']" :key="kind" :value="kind">
              {{ ISLAND_COMPONENT_LABELS[kind as IslandComponentKind] }}
            </option>
          </select>
        </label>
        <template v-if="selected.kind === 'clock'">
          <label>
            <input type="checkbox" v-model="selected.settings.hour12" @change="save" />
            12 小时制
          </label>
          <label>
            <input type="checkbox" v-model="selected.settings.seconds" @change="save" />
            显示秒
          </label>
        </template>
        <label v-if="selected.kind === 'countdown'">
          倒计时目标
          <select v-model="selected.settings.target" @change="save">
            <option value="next">下一节课</option>
            <option value="school">放学</option>
          </select>
        </label>
        <template v-if="selected.kind === 'text'">
          <textarea v-model="selected.settings.text" @change="save" />
          <label>
            <input type="checkbox" v-model="selected.settings.template" @change="save" />
            模板文本（{date} {time} {course}）
          </label>
        </template>
        <template v-if="selected.kind === 'schedule'">
          <select v-model="selected.settings.display" @change="save">
            <option value="current">当前课程</option>
            <option value="next">下一节</option>
            <option value="today">今日课表</option>
          </select>
          <label>
            显示节数
            <input type="number" v-model.number="selected.settings.count" @change="save" />
          </label>
          <label>
            <input type="checkbox" v-model="selected.settings.showPeriod" @change="save" />
            显示节次
          </label>
        </template>
        <template v-if="['group', 'stack', 'slide', 'rolling'].includes(selected.kind)">
          <select v-model="selected.settings.direction" @change="save">
            <option value="horizontal">横向</option>
            <option value="vertical">纵向</option>
          </select>
          <label>
            间距
            <input type="number" v-model.number="selected.settings.gap" @change="save" />
          </label>
          <label>
            轮播间隔（秒）
            <input type="number" v-model.number="selected.settings.interval" @change="save" />
          </label>
          <label>
            滚动速度
            <input type="number" v-model.number="selected.settings.speed" @change="save" />
          </label>
        </template>
        <h4>通用外观</h4>
        <label>
          <input type="checkbox" v-model="selected.appearance.resourceOverridingEnabled" @change="save" />
          启用资源覆盖
        </label>
        <label
          v-for="font in [
            'secondaryFontSize',
            'bodyFontSize',
            'emphasizedFontSize',
            'largeFontSize',
          ] as const"
          :key="font"
        >
          {{
            {
              secondaryFontSize: '次级字号',
              bodyFontSize: '正文字号',
              emphasizedFontSize: '强调字号',
              largeFontSize: '大号字号',
            }[font]
          }}
          <input type="number" v-model.number="selected.appearance[font]" @change="save" />
        </label>
        <label>
          <input type="checkbox" v-model="selected.appearance.customForegroundEnabled" @change="save" />
          自定义前景色
          <input type="color" v-model="selected.appearance.foreground" @change="save" />
        </label>
        <label>
          <input type="checkbox" v-model="selected.appearance.customBackgroundEnabled" @change="save" />
          自定义背景色
          <input type="color" v-model="selected.appearance.background" @change="save" />
        </label>
        <label>
          <input
            type="checkbox"
            v-model="selected.appearance.customBackgroundOpacityEnabled"
            @change="save"
          />
          背景透明度
          <input
            type="number"
            v-model.number="selected.appearance.backgroundOpacity"
            min="0"
            max="1"
            step="0.05"
            @change="save"
          />
        </label>
        <label>
          <input type="checkbox" v-model="selected.appearance.customCornerRadiusEnabled" @change="save" />
          自定义圆角
          <input type="number" v-model.number="selected.appearance.cornerRadius" @change="save" />
        </label>
        <label>
          元素透明度
          <input
            type="number"
            v-model.number="selected.appearance.opacity"
            min="0"
            max="1"
            step="0.05"
            @change="save"
          />
        </label>
        <h4>高级设置</h4>
        <label v-for="rule in ['in-class', 'no-message', 'no-class'] as const" :key="rule">
          <input type="checkbox" v-model="selected.advanced.hideRules" :value="rule" @change="save" />
          {{
            { 'in-class': '上课时隐藏', 'no-message': '无消息时隐藏', 'no-class': '无当前课程时隐藏' }[rule]
          }}
        </label>
        <label>
          对齐（有宽度时生效）
          <select v-model="selected.advanced.align" @change="save">
            <option value="stretch">拉伸</option>
            <option value="start">起始</option>
            <option value="center">居中</option>
            <option value="end">末端</option>
          </select>
        </label>
        <label>
          固定宽度（0 自适应）
          <input type="number" v-model.number="selected.advanced.width" @change="save" />
        </label>
        <label>
          宽度上限（超出右侧截断）
          <input type="number" v-model.number="selected.advanced.maxWidth" @change="save" />
        </label>
      </template>
      <p v-else>点选组件后显示它独立的设置。</p>
      <p role="alert">{{ error }}</p>
    </aside>
  </div>
</template>
<style scoped>
.custom-window {
  padding: 10px;
  width: 100vw;
  height: 100vh;
  box-sizing: border-box;
}
.custom-card {
  box-sizing: border-box;
  padding: 12px;
  overflow: auto;
  background: var(--custom-color);
  border-radius: var(--custom-radius);
  filter: drop-shadow(0 2px 3px #0003);
}
.custom-inner {
  width: max-content;
  min-width: 100%;
  display: flex;
  flex-direction: column;
  gap: inherit;
}
.layout-row {
  display: flex;
  flex-direction: column;
}
.row-content {
  display: flex;
  align-items: center;
  min-height: 24px;
}
.separated {
  background: transparent;
}
.separated .layout-row {
  background: var(--custom-color);
  border-radius: var(--custom-radius);
  padding: 8px;
}
.layout-editor {
  position: fixed;
  inset: 10px;
  display: grid;
  grid-template-columns: 200px minmax(0, 1fr) 280px;
  grid-template-rows: auto 1fr;
  color: var(--ch-text, #17202c);
  background: var(--ch-surface, #f4f5f8);
  border-radius: var(--ch-radius-lg, 16px);
  overflow: hidden;
  font:
    14px 'Microsoft YaHei',
    sans-serif;
}
.layout-editor header {
  grid-column: 1/-1;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 12px;
}
.library,
.settings {
  overflow: auto;
  padding: 12px;
}
.settings label,
.library label {
  display: block;
  margin-block: 8px;
}
.canvas {
  overflow: hidden;
  touch-action: none;
  padding: 80px 30px;
  background: var(--ch-bg, #e3e5eb);
}
.canvas .custom-card {
  transform-origin: top left;
}
.row-tools {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  padding-bottom: 8px;
}
.layout-editor button,
.layout-editor select,
.layout-editor input:not([type='checkbox']),
.layout-editor textarea {
  max-width: 100%;
  min-height: 36px;
  font: inherit;
  border: 1px solid var(--ch-border, #9ca6b4);
  border-radius: var(--ch-radius-sm, 6px);
  padding: 4px;
}
.layout-editor button {
  touch-action: none;
  cursor: pointer;
}
.library button {
  margin: 3px;
}
.layout-editor input[type='number'] {
  width: 70px;
}
.layout-editor input[type='file'] {
  width: 110px;
}
</style>
