<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch, type CSSProperties } from 'vue';
import {
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
import ComponentInspector from './ComponentInspector.vue';
import ComponentIcon from './ComponentIcon.vue';
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
const panel = ref<'component' | 'row' | 'appearance'>('appearance');
const selectedRowId = ref('');
const activeRow = computed(
  () => scheme.value.rows.find((r) => r.id === selectedRowId.value) || scheme.value.rows[0]!,
);
const componentGroups = [
  { name: '日常信息', kinds: ['clock', 'date', 'schedule', 'countdown', 'text', 'separator'] },
  { name: '消息提醒', kinds: ['notification', 'homework', 'call'] },
  { name: '组合容器', kinds: ['group', 'stack', 'slide', 'rolling'] },
] as const;
const savedAt = ref('');
function selectNode(nodeId: string) {
  selectedId.value = nodeId;
  panel.value = 'component';
}
function selectRow(rowId: string) {
  selectedRowId.value = rowId;
  selectedId.value = '';
  panel.value = 'row';
}
function switchScheme() {
  selectedId.value = '';
  selectedRowId.value = '';
  panel.value = 'appearance';
  save();
}
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
  minHeight: !props.editing && viewport.value.height ? `${viewport.value.height}px` : undefined,
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
  '--custom-row-gap': `${scheme.value.spacing}px`,
  gap: `${scheme.value.spacing}px`,
}));
function id() {
  return `node-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
function save() {
  const value = normalizeIslandLayouts(JSON.parse(JSON.stringify(draft.value)));
  draft.value = value;
  emit('save', value);
  savedAt.value = '已自动保存';
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
  selectRow(scheme.value.rows[after + 1]!.id);
  save();
}
function add(kind = selectedKind.value, row = activeRow.value) {
  if (!row) return;
  const n = islandNode(kind, id());
  row.nodes.push(n);
  selectNode(n.id);
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
  panel.value = 'row';
  save();
}
function duplicate() {
  const n = selected.value,
    list = findList(selectedId.value);
  if (!n || !list) return;
  const copy = JSON.parse(JSON.stringify(n)) as IslandComponentNode;
  for (const child of allNodes([copy])) child.id = id();
  list.splice(list.indexOf(n) + 1, 0, copy);
  selectNode(copy.id);
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
  selectNode(container.id);
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
  switchScheme();
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
    switchScheme();
    error.value = '';
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
  selectNode(node.id);
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
      // 内部组件的自然尺寸决定整个岛体；提醒不再拥有另一层岛壳。
      const rect = inner.value.getBoundingClientRect(),
        padding = shell.value ? getComputedStyle(shell.value) : null,
        scale = props.editing ? canvasScale.value : 1;
      window.island?.reportSize({
        width: Math.ceil(
          rect.width / scale +
            parseFloat(padding?.paddingLeft || '0') +
            parseFloat(padding?.paddingRight || '0'),
        ),
        height: Math.ceil(
          rect.height / scale +
            parseFloat(padding?.paddingTop || '0') +
            parseFloat(padding?.paddingBottom || '0'),
        ),
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
    <header v-if="editing" class="editor-header">
      <div class="editor-title">
        <span class="editor-mark" aria-hidden="true">◒</span>
        <div>
          <h1>自定义灵动岛</h1>
          <p>把需要的信息，放进岛里</p>
        </div>
      </div>
      <div class="scheme-picker">
        <span>当前方案</span>
        <select aria-label="当前方案" v-model="draft.activeSchemeId" @change="switchScheme">
          <option v-for="s in draft.schemes" :key="s.id" :value="s.id">{{ s.name }}</option>
        </select>
        <details class="scheme-menu">
          <summary aria-label="方案操作">•••</summary>
          <div class="scheme-menu-body">
            <button @click="newScheme">复制为新方案</button>
            <button @click="exportScheme">导出方案</button>
            <label class="import-button">
              导入方案
              <input type="file" accept="application/json" @change="importScheme" />
            </label>
          </div>
        </details>
      </div>
      <span class="save-state" role="status">{{ savedAt || '更改会自动保存' }}</span>
      <button
        class="primary-button done-button"
        @click="
          save();
          emit('done');
        "
      >
        完成
      </button>
    </header>
    <aside v-if="editing" class="library">
      <div class="panel-heading">
        <h2>添加组件</h2>
        <p>拖入岛内，或选中后添加</p>
      </div>
      <section v-for="group in componentGroups" :key="group.name" class="library-group">
        <h3>{{ group.name }}</h3>
        <div class="component-grid">
          <button
            v-for="kind in group.kinds"
            :key="kind"
            class="library-item"
            :class="{ active: selectedKind === kind }"
            :aria-pressed="selectedKind === kind"
            @pointerdown="startDrag($event, 'library', '', kind)"
            @click="selectedKind = kind"
            @dblclick="add(kind)"
          >
            <span class="component-symbol"><ComponentIcon :kind="kind" /></span>
            <span>{{ ISLAND_COMPONENT_LABELS[kind] }}</span>
          </button>
        </div>
      </section>
      <div class="library-add">
        <label class="field">
          添加到
          <select :value="activeRow.id" @change="selectedRowId = ($event.target as HTMLSelectElement).value">
            <option v-for="row in scheme.rows" :key="row.id" :value="row.id">{{ row.name }}</option>
          </select>
        </label>
        <button class="primary-button wide-button" @click="add()">
          添加{{ ISLAND_COMPONENT_LABELS[selectedKind] }}
        </button>
      </div>
    </aside>
    <main :class="{ canvas: editing }" @pointerdown="panStart">
      <div v-if="editing" class="canvas-toolbar">
        <span>岛内预览</span>
        <div>
          <button
            :class="{ active: panel === 'appearance' }"
            @click="
              panel = 'appearance';
              selectedId = '';
            "
          >
            整体外观
          </button>
          <button
            @click="
              pan = { x: 0, y: 0 };
              canvasScale = 1;
            "
          >
            重置视图
          </button>
        </div>
      </div>
      <div
        class="preview-stage"
        :style="editing ? { transform: `translate(${pan.x}px,${pan.y}px) scale(${canvasScale})` } : {}"
      >
        <div
          ref="shell"
          class="custom-card"
          :class="{ separated: scheme.separated, 'has-alert': hasMessage }"
          :data-priority="hasMessage ? state.active?.priority : undefined"
          :style="[shellStyle, editing ? { width: 'max-content', maxWidth: 'none', maxHeight: 'none' } : {}]"
        >
          <div ref="inner" class="custom-inner" :style="{ zoom: scheme.scale }">
            <section
              v-for="row in scheme.rows"
              :key="row.id"
              :data-row="row.id"
              class="layout-row"
              :class="{ 'row-selected': editing && selectedRowId === row.id, 'row-editing': editing }"
              :style="{ '--row-gap': `${row.gap}px` }"
            >
              <div v-if="editing" class="row-tools">
                <button class="row-drag" aria-label="拖动行" @pointerdown="startDrag($event, 'row', row.id)">
                  ⠿
                </button>
                <button class="row-name" @click="selectRow(row.id)">
                  {{ row.name }}
                  <span v-if="row.main">主要行</span>
                </button>
                <button class="row-settings" :aria-label="`${row.name}设置`" @click="selectRow(row.id)">
                  行设置
                </button>
              </div>
              <div class="row-content" @click.self="editing && selectRow(row.id)">
                <div class="row-components">
                  <ComponentNode
                    v-for="n in row.nodes.filter(
                      (n) => !['notification', 'homework', 'call'].includes(n.kind),
                    )"
                    :key="n.id"
                    :node="n"
                    :state="state"
                    :now="now"
                    :schedules="schedules"
                    :editing="editing"
                    :selected-id="selectedId"
                    :alert-node-id="alertNodeId"
                    @select="selectNode"
                    @drag="(e, id) => startDrag(e, 'node', id)"
                  >
                    <template #alerts>
                      <div id="custom-alert-host" :ref="hostRef" v-show="hasMessage" />
                    </template>
                  </ComponentNode>
                </div>
                <ComponentNode
                  v-for="n in row.nodes.filter((n) => ['notification', 'homework', 'call'].includes(n.kind))"
                  :key="n.id"
                  :node="n"
                  :state="state"
                  :now="now"
                  :schedules="schedules"
                  :editing="editing"
                  :selected-id="selectedId"
                  :alert-node-id="alertNodeId"
                  @select="selectNode"
                  @drag="(e, id) => startDrag(e, 'node', id)"
                >
                  <template #alerts>
                    <div id="custom-alert-host" :ref="hostRef" v-show="hasMessage" />
                  </template>
                </ComponentNode>
                <div
                  v-if="row.id === alertRow?.id && !alertNodeId"
                  id="custom-alert-host"
                  :ref="hostRef"
                  v-show="hasMessage"
                />
                <span v-if="editing && !row.nodes.length" class="empty-row">拖入组件，或从左侧添加</span>
              </div>
            </section>
          </div>
        </div>
        <button
          v-if="editing"
          class="add-row-button"
          @click="addRow(scheme.rows.findIndex((r) => r.id === activeRow.id))"
        >
          ＋ 在下方新建主界面行
        </button>
      </div>
      <div v-if="editing" class="canvas-footer">
        <span>点选组件以设置 · 拖动句柄以排序 · 空白处可平移</span>
        <label>
          缩放
          <input
            aria-label="画布缩放"
            type="range"
            v-model.number="canvasScale"
            min="0.3"
            max="2"
            step="0.1"
          />
          <output>{{ Math.round(canvasScale * 100) }}%</output>
        </label>
      </div>
    </main>
    <div v-if="!alertRow" id="custom-alert-host" :ref="hostRef" style="display: none" />
    <aside v-if="editing" class="settings">
      <ComponentInspector
        v-if="panel === 'component' && selected"
        :node="selected"
        @change="save"
        @remove="remove"
        @duplicate="duplicate"
        @wrap="wrap"
      />
      <template v-else-if="panel === 'row'">
        <div class="inspector-heading">
          <span class="eyebrow">布局设置</span>
          <h2>组件行</h2>
          <p>管理这一行的排列与提醒</p>
        </div>
        <div class="inspector-body" @change="save">
          <section class="setting-section">
            <h3>基本设置</h3>
            <label class="field">
              行名称
              <input v-model="activeRow.name" />
            </label>
            <label class="field inline-field">
              组件间距
              <input type="number" min="0" max="80" v-model.number="activeRow.gap" />
            </label>
          </section>
          <section class="setting-section">
            <h3>消息提醒</h3>
            <label class="toggle-field">
              <span>允许显示提醒</span>
              <input type="checkbox" v-model="activeRow.allowNotifications" />
            </label>
            <button
              class="wide-button"
              :disabled="activeRow.main"
              @click="
                scheme.rows.forEach((r) => (r.main = r.id === activeRow.id));
                save();
              "
            >
              {{ activeRow.main ? '已设为主要行' : '设为主要行' }}
            </button>
            <p class="field-hint">提醒优先显示在主要行内；若该行禁用提醒，则显示在下一条允许提醒的行内。</p>
          </section>
          <section class="setting-section">
            <button class="wide-button" @click="addRow(scheme.rows.indexOf(activeRow))">
              在此行下方新增行
            </button>
            <button
              class="wide-button danger-button"
              :disabled="scheme.rows.length < 2"
              @click="
                scheme.rows.splice(scheme.rows.indexOf(activeRow), 1);
                selectedRowId = '';
                save();
              "
            >
              删除这一行
            </button>
          </section>
        </div>
      </template>
      <template v-else>
        <div class="inspector-heading">
          <span class="eyebrow">方案设置</span>
          <h2>整体外观</h2>
          <p>所有组件共用一个灵动岛</p>
        </div>
        <div class="inspector-body" @change="save">
          <section class="setting-section">
            <h3>当前方案</h3>
            <label class="field">
              方案名称
              <input v-model="scheme.name" />
            </label>
            <label class="field inline-field">
              内容缩放
              <input type="number" v-model.number="scheme.scale" min="0.5" max="3" step="0.1" />
            </label>
          </section>
          <section class="setting-section">
            <h3>岛体</h3>
            <label class="field inline-field">
              背景颜色
              <input type="color" v-model="scheme.color" />
            </label>
            <label class="field inline-field">
              文字颜色
              <input type="color" v-model="scheme.foreground" />
            </label>
            <label class="field">
              背景透明度
              <div class="range-field">
                <input type="range" v-model.number="scheme.opacity" min="0.1" max="1" step="0.05" />
                <output>{{ Math.round(scheme.opacity * 100) }}%</output>
              </div>
            </label>
            <label class="field inline-field">
              圆角
              <input type="number" v-model.number="scheme.radius" min="0" max="100" />
            </label>
          </section>
          <section class="setting-section">
            <h3>多行布局</h3>
            <label class="field inline-field">
              行间距
              <input type="number" v-model.number="scheme.spacing" min="0" max="80" />
            </label>
            <label class="toggle-field">
              <span>各行分离显示</span>
              <input type="checkbox" v-model="scheme.separated" />
            </label>
            <p class="field-hint">默认将所有行放在同一个岛体内；开启后各行拥有独立背景。</p>
          </section>
        </div>
      </template>
      <p v-if="error" class="editor-error" role="alert">{{ error }}</p>
    </aside>
  </div>
</template>
<style src="./custom-island.css"></style>
