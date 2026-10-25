<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { onBeforeRouteLeave, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  CLASSISLAND_ISLAND_METRICS as METRICS,
  DEFAULT_ISLAND_APPEARANCE,
  ISLAND_COMPONENT_LABELS,
  defaultIslandLayouts,
  islandNode,
  normalizeIslandLayouts,
  type IslandComponentKind,
  type IslandComponentNode,
  type IslandLayoutRow,
  type IslandLayoutScheme,
  type IslandState,
  type IslandAppearance,
} from '@classhelper/shared';
import ComponentNode from '../../../island/ComponentNode.vue';
import ComponentIcon from '../../../island/ComponentIcon.vue';
import IslandEditorNode from '../../components/IslandEditorNode.vue';
import IslandComponentSettings from '../../components/IslandComponentSettings.vue';
import { getIslandSchedules, getIslandTimePoints } from '../../island/bridge.js';
const router = useRouter();
const settings = ref(defaultIslandLayouts()),
  appearance = ref<IslandAppearance>({ ...DEFAULT_ISLAND_APPEARANCE });
const schedules = ref(getIslandSchedules()),
  timePoints = ref(getIslandTimePoints()),
  now = ref(Date.now()),
  ready = ref(false),
  error = ref(''),
  pending = ref(0),
  saved = ref(false);
const surface = ref<'compact' | 'expanded'>('compact'),
  panel = ref<'scheme' | 'row' | 'component'>('scheme');
const selectedId = ref(''),
  rowId = ref(''),
  inspectorOpen = ref(false),
  editMode = ref(false),
  showTip = ref(true),
  zoom = ref(1),
  importInput = ref<HTMLInputElement>();
const scheme = computed(() =>
  settings.value.schemes.find((item) => item.id === settings.value.activeSchemeId)!,
);
const rows = computed(() => (surface.value === 'expanded' ? scheme.value.expandedRows : scheme.value.rows));
const activeRow = computed(() => rows.value.find((row) => row.id === rowId.value) ?? rows.value[0]!);
const state: IslandState = {
  mode: 'hidden',
  active: null,
  queued: [],
  inClass: false,
  currentPeriodEnd: null,
  reason: null,
  listExpanded: false,
  maxCardHeight: 1024,
  updatedAt: 0,
};
const library: { kind: IslandComponentKind; description: string }[] = [
  { kind: 'text', description: '显示自定义文本。' },
  { kind: 'separator', description: '显示一个分割线，视觉上对组件进行分组。' },
  { kind: 'schedule', description: '显示当前的课程表信息。' },
  { kind: 'date', description: '显示今天的日期和星期。' },
  { kind: 'clock', description: '显示现在的时间，支持精确到秒。' },
  { kind: 'weather', description: '显示指定地点的天气概况和天气提示。' },
  { kind: 'countdown', description: '显示距离某一天的倒计时。' },
  { kind: 'slide', description: '轮播多个组件。' },
  { kind: 'rolling', description: '滚动显示组件内的内容。' },
  { kind: 'group', description: '将多个组件组合到一个组件中显示。' },
  { kind: 'stack', description: '将多个容器堆叠显示。' },
];
const messageLibrary: { kind: IslandComponentKind; description: string }[] = [
  { kind: 'notification', description: '显示班级收到的通知。' },
  { kind: 'homework', description: '显示班级作业提醒。' },
  { kind: 'call', description: '显示教师的叫人提醒。' },
];
const containers: readonly string[] = ['group', 'stack', 'slide', 'rolling'];
function id() {
  return crypto.randomUUID();
}
function all(nodes: IslandComponentNode[]): IslandComponentNode[] {
  return nodes.flatMap((node) => [node, ...all(node.children)]);
}
const selected = computed(() =>
  rows.value.flatMap((row) => all(row.nodes)).find((node) => node.id === selectedId.value),
);
let saveQueue = Promise.resolve(),
  revision = 0,
  clock: ReturnType<typeof setInterval>;
function save() {
  if (!ready.value) return saveQueue;
  const snapshot = normalizeIslandLayouts(JSON.parse(JSON.stringify(settings.value)));
  const current = ++revision;
  pending.value++;
  saved.value = false;
  saveQueue = saveQueue.then(async () => {
    try {
      if (!window.desktop) throw new Error('请在桌面客户端中保存方案');
      await window.desktop.saveConfig({ islandLayout: snapshot });
      if (current === revision) {
        error.value = '';
        saved.value = true;
      }
    } catch (e) {
      error.value = e instanceof Error ? e.message : '保存失败，请重试';
    } finally {
      pending.value--;
    }
  });
  return saveQueue;
}
function selectNode(nodeId: string) {
  if (suppressClick) return;
  selectedId.value = nodeId;
  panel.value = 'component';
  rowId.value = rows.value.find((row) => all(row.nodes).some((node) => node.id === nodeId))?.id ?? '';
  inspectorOpen.value = true;
}
function selectRow(value: string) {
  rowId.value = value;
  selectedId.value = '';
  panel.value = 'row';
  inspectorOpen.value = true;
}
function resetSelection() {
  cancelDrag();
  selectedId.value = '';
  rowId.value = '';
  panel.value = 'scheme';
  inspectorOpen.value = false;
}
function switchScheme() {
  resetSelection();
  void save();
}
function add(kind: IslandComponentKind) {
  if (suppressClick || !capacity()) return;
  const target = selected.value && containers.includes(selected.value.kind) ? selected.value : undefined;
  if (target && depthOf(target.id) >= 6) {
    ElMessage.warning('最多嵌套 6 层容器');
    return;
  }
  const node = makeNode(kind);
  (target ? target.children : activeRow.value.nodes).push(node);
  selectNode(node.id);
  void save();
}
function addRow() {
  if (rows.value.length >= 12) {
    ElMessage.warning('每种内容最多添加 12 行');
    return;
  }
  const row: IslandLayoutRow = {
    id: id(),
    name: `组件行 ${rows.value.length + 1}`,
    main: false,
    allowNotifications: true,
    gap: 8,
    nodes: [],
  };
  rows.value.push(row);
  rowId.value = row.id;
  selectedId.value = '';
  void save();
}
function findList(nodeId: string, nodes?: IslandComponentNode[]): IslandComponentNode[] | undefined {
  for (const list of nodes ? [nodes] : rows.value.map((row) => row.nodes)) {
    if (list.some((node) => node.id === nodeId)) return list;
    for (const node of list) {
      const found = findList(nodeId, node.children);
      if (found) return found;
    }
  }
}
function removeNode() {
  const list = findList(selectedId.value);
  if (list)
    list.splice(
      list.findIndex((node) => node.id === selectedId.value),
      1,
    );
  selectedId.value = '';
  panel.value = 'row';
  void save();
}
function copyNode() {
  if (!selected.value || !capacity(all([selected.value]).length)) return;
  const list = findList(selected.value.id)!;
  const copy: IslandComponentNode = JSON.parse(JSON.stringify(selected.value));
  all([copy]).forEach((node) => (node.id = id()));
  list.splice(list.indexOf(selected.value) + 1, 0, copy);
  selectNode(copy.id);
  void save();
}
function wrap(kind: IslandComponentKind) {
  if (!selected.value || !containers.includes(kind) || !capacity()) return;
  if (depthOf(selected.value.id) + height(selected.value) + 1 > 6) {
    ElMessage.warning('最多嵌套 6 层容器');
    return;
  }
  const list = findList(selected.value.id)!,
    container = islandNode(kind, id());
  container.children = [selected.value];
  list.splice(list.indexOf(selected.value), 1, container);
  selectNode(container.id);
  void save();
}
function removeRow() {
  if (rows.value.length < 2) return;
  const index = rows.value.indexOf(activeRow.value);
  rows.value.splice(index, 1);
  if (!rows.value.some((row) => row.main)) rows.value[0]!.main = true;
  resetSelection();
  void save();
}
function setMain() {
  rows.value.forEach((row) => (row.main = row.id === activeRow.value.id));
  void save();
}
function cloneScheme() {
  if (
    !schemeCapacity() ||
    !capacity([...scheme.value.rows, ...scheme.value.expandedRows].flatMap((row) => all(row.nodes)).length)
  )
    return;
  const copy = JSON.parse(JSON.stringify(scheme.value)) as typeof scheme.value;
  copy.id = id();
  copy.name = `${copy.name.slice(0, 61)} 副本`;
  [...copy.rows, ...copy.expandedRows].forEach((row) => {
    row.id = id();
    all(row.nodes).forEach((node) => (node.id = id()));
  });
  settings.value.schemes.push(copy);
  settings.value.activeSchemeId = copy.id;
  switchScheme();
}
async function deleteScheme() {
  if (settings.value.schemes.length < 2) return;
  try {
    await ElMessageBox.confirm(`删除方案「${scheme.value.name}」？`, '删除方案', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
    });
  } catch {
    return;
  }
  settings.value.schemes = settings.value.schemes.filter((item) => item.id !== scheme.value.id);
  settings.value.activeSchemeId = settings.value.schemes[0]!.id;
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
  a.download = `${scheme.value.name.replace(/[<>:"/\\|?*]/g, '_')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function importScheme(event: Event) {
  const input = event.target as HTMLInputElement;
  try {
    const file = input.files?.[0];
    if (!file || !schemeCapacity()) return;
    if (file.size > 1000000) throw new Error('方案文件不能超过 1 MB');
    const parsed = JSON.parse(await file.text());
    if (
      parsed?.format !== 'classhelper-island-layout' ||
      !Array.isArray(parsed.scheme?.rows) ||
      !parsed.scheme.rows.length
    )
      throw new Error('方案格式不正确');
    const imported = normalizeIslandLayouts({ schemes: [parsed.scheme], activeSchemeId: parsed.scheme.id })
      .schemes[0]!;
    if (!capacity([...imported.rows, ...imported.expandedRows].flatMap((row) => all(row.nodes)).length))
      return;
    imported.id = id();
    [...imported.rows, ...imported.expandedRows].forEach((row) => {
      row.id = id();
      all(row.nodes).forEach((node) => (node.id = id()));
    });
    settings.value.schemes.push(imported);
    settings.value.activeSchemeId = imported.id;
    switchScheme();
    ElMessage.success('方案已导入');
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '导入失败');
  } finally {
    input.value = '';
  }
}
async function apply() {
  if (!ready.value) return;
  settings.value.layout = 'custom';
  settings.value.residentEnabled = true;
  await save();
  if (!error.value) {
    ElMessage.success('自定义灵动岛已应用');
    await router.push('/settings/island');
  }
}
async function load() {
  try {
    const config = await window.desktop?.getConfig();
    if (!config) throw new Error('请在桌面客户端中打开组件编辑器');
    if (config) {
      settings.value = normalizeIslandLayouts(config.islandLayout);
      appearance.value = config.island;
    }
    ready.value = true;
    error.value = '';
  } catch (e) {
    error.value = String(e);
  }
}
onMounted(async () => {
  window.addEventListener('pointermove', moveDrag, { passive: false });
  window.addEventListener('pointerup', dropPreview);
  window.addEventListener('pointercancel', cancelDrag);
  window.addEventListener('blur', cancelDrag);
  await load();
  clock = setInterval(() => {
    now.value = Date.now();
    schedules.value = getIslandSchedules();
    timePoints.value = getIslandTimePoints();
  }, 1000);
});
onUnmounted(() => {
  clearInterval(clock);
  window.removeEventListener('pointermove', moveDrag);
  window.removeEventListener('pointerup', dropPreview);
  window.removeEventListener('pointercancel', cancelDrag);
  window.removeEventListener('blur', cancelDrag);
});
onBeforeRouteLeave(async () => {
  if (!ready.value) return true;
  await save();
  return !error.value;
});
function capacity(count = 1) {
  const total = settings.value.schemes.reduce(
    (sum, item) =>
      sum + [...item.rows, ...item.expandedRows].reduce((n, row) => n + all(row.nodes).length, 0),
    0,
  );
  if (total + count <= 200) return true;
  ElMessage.warning('组件总数已达上限，请先删除不用的组件或方案');
  return false;
}
function depthOf(nodeId: string, nodes = rows.value.flatMap((row) => row.nodes), level = 0): number {
  for (const node of nodes) {
    if (node.id === nodeId) return level;
    const found = depthOf(nodeId, node.children, level + 1);
    if (found >= 0) return found;
  }
  return -1;
}
function height(node: IslandComponentNode): number {
  return node.children.length ? 1 + Math.max(...node.children.map(height)) : 0;
}
function makeNode(kind: IslandComponentKind) {
  const node = islandNode(kind, id());
  if (kind === 'countdown') node.settings.target = 'date';
  return node;
}
function moveRow(direction: number) {
  const index = rows.value.indexOf(activeRow.value),
    next = index + direction;
  if (next < 0 || next >= rows.value.length) return;
  rows.value.splice(next, 0, rows.value.splice(index, 1)[0]!);
  void save();
}
function renewScheme(copy: IslandLayoutScheme) {
  copy.id = id();
  [...copy.rows, ...copy.expandedRows].forEach((row) => {
    row.id = id();
    all(row.nodes).forEach((node) => (node.id = id()));
  });
  return copy;
}
function schemeCapacity() {
  if (settings.value.schemes.length < 20) return true;
  ElMessage.warning('最多保存 20 个方案');
  return false;
}
async function newScheme() {
  if (!schemeCapacity()) return;
  try {
    const { value } = await ElMessageBox.prompt('为新的组件方案命名', '新建方案', {
      inputValue: '新方案',
      inputValidator: (value) => (!!value?.trim() && value.trim().length <= 64) || '请输入 1–64 个字符',
      confirmButtonText: '创建',
      cancelButtonText: '取消',
    });
    const copy = renewScheme(JSON.parse(JSON.stringify(defaultIslandLayouts().schemes[0]!)));
    if (!capacity([...copy.rows, ...copy.expandedRows].flatMap((row) => all(row.nodes)).length)) return;
    copy.name = value.trim();
    settings.value.schemes.push(copy);
    settings.value.activeSchemeId = copy.id;
    switchScheme();
  } catch {
    /* 取消输入 */
  }
}
async function resetScheme() {
  try {
    await ElMessageBox.confirm(`将「${scheme.value.name}」的组件和外观恢复为默认配置？`, '重置方案', {
      confirmButtonText: '重置',
      cancelButtonText: '取消',
      type: 'warning',
    });
  } catch {
    return;
  }
  const copy = renewScheme(JSON.parse(JSON.stringify(defaultIslandLayouts().schemes[0]!)));
  const count =
    [...copy.rows, ...copy.expandedRows].flatMap((row) => all(row.nodes)).length -
    [...scheme.value.rows, ...scheme.value.expandedRows].flatMap((row) => all(row.nodes)).length;
  if (!capacity(count)) return;
  copy.id = scheme.value.id;
  copy.name = scheme.value.name;
  settings.value.schemes.splice(settings.value.schemes.indexOf(scheme.value), 1, copy);
  switchScheme();
}
function schemeCommand(command: string) {
  if (command === 'import') importInput.value?.click();
  if (command === 'export') exportScheme();
  if (command === 'clone') cloneScheme();
  if (command === 'delete') void deleteScheme();
  if (command === 'settings') {
    panel.value = 'scheme';
    inspectorOpen.value = true;
  }
}
// 原生 Pointer Events 同时覆盖鼠标、触摸和笔；释放到画布外会取消。
type Drag = {
  nodeId?: string;
  kind?: IslandComponentKind;
  rowId?: string;
  x: number;
  y: number;
  moved: boolean;
  label: string;
};
const dragging = ref<Drag | null>(null);
const pointer = ref({ x: 0, y: 0 });
type Drop = { row: IslandLayoutRow; node?: IslandComponentNode; position: 'before' | 'after' | 'inside' };
const drop = ref<Drop | null>(null);
let suppressClick = false;
function beginDrag(event: PointerEvent, source: Omit<Drag, 'x' | 'y' | 'moved'>) {
  if (event.button !== 0 || !ready.value) return;
  dragging.value = { ...source, x: event.clientX, y: event.clientY, moved: false };
  pointer.value = { x: event.clientX, y: event.clientY };
  try {
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  } catch {
    /* 合成事件没有活动指针 */
  }
}
function startDrag(event: PointerEvent, nodeId: string) {
  const node = rows.value.flatMap((row) => all(row.nodes)).find((node) => node.id === nodeId);
  if (node) beginDrag(event, { nodeId, label: ISLAND_COMPONENT_LABELS[node.kind] });
}
function dragTarget(event: PointerEvent): Drop | null {
  const element = document.elementFromPoint(event.clientX, event.clientY);
  const row = rows.value.find((row) => row.id === element?.closest<HTMLElement>('[data-row]')?.dataset.row);
  if (!row) return null;
  const target = element?.closest<HTMLElement>('[data-node]');
  const node = all(row.nodes).find((node) => node.id === target?.dataset.node);
  if (!node || !target) return { row, position: 'inside' };
  const rect = target.getBoundingClientRect(),
    ratio = (event.clientX - rect.left) / Math.max(1, rect.width);
  return {
    row,
    node,
    position:
      containers.includes(node.kind) && ratio > 0.2 && ratio < 0.8
        ? 'inside'
        : ratio > 0.5
          ? 'after'
          : 'before',
  };
}
function moveDrag(event: PointerEvent) {
  const current = dragging.value;
  if (!current) return;
  if (Math.hypot(event.clientX - current.x, event.clientY - current.y) >= 6) current.moved = true;
  if (!current.moved) return;
  event.preventDefault();
  pointer.value = { x: event.clientX, y: event.clientY };
  drop.value = dragTarget(event);
}
function cancelDrag() {
  dragging.value = null;
  drop.value = null;
}
function dropPreview(event: PointerEvent) {
  const current = dragging.value;
  if (!current) return;
  const moved = current.moved || Math.hypot(event.clientX - current.x, event.clientY - current.y) >= 6;
  const target = moved ? dragTarget(event) : null;
  cancelDrag();
  if (!moved) return;
  suppressClick = true;
  setTimeout(() => (suppressClick = false), 0);
  if (!target) return;
  if (current.rowId) {
    const index = rows.value.findIndex((row) => row.id === current.rowId);
    if (index < 0 || target.row.id === current.rowId) return;
    const next = rows.value.indexOf(target.row);
    rows.value.splice(next, 0, rows.value.splice(index, 1)[0]!);
    void save();
    return;
  }
  const list = current.nodeId ? findList(current.nodeId) : undefined;
  const node =
    list?.find((node) => node.id === current.nodeId) ?? (current.kind ? makeNode(current.kind) : undefined);
  if (!node || (current.kind && !capacity())) return;
  if (all([node]).some((child) => child.id === target.node?.id)) return;
  const level = target.node ? depthOf(target.node.id) + (target.position === 'inside' ? 1 : 0) : 0;
  if (level + height(node) > 6) {
    ElMessage.warning('最多嵌套 6 层容器');
    return;
  }
  const destination = target.node
    ? target.position === 'inside'
      ? target.node.children
      : findList(target.node.id)!
    : target.row.nodes;
  list?.splice(list.indexOf(node), 1);
  const index =
    target.node && target.position !== 'inside'
      ? destination.indexOf(target.node) + (target.position === 'after' ? 1 : 0)
      : destination.length;
  destination.splice(index, 0, node);
  selectedId.value = node.id;
  rowId.value = target.row.id;
  panel.value = 'component';
  void save();
}
</script>

<template>
  <section class="page island-editor-page" aria-label="自定义灵动岛设置">
    <div class="editor-actions">
      <span class="save-status" :class="{ failed: error }" role="status">
        {{ error ? '保存失败' : pending ? '正在保存…' : saved ? '已自动保存' : '更改自动保存到本机' }}
      </span>
      <el-button text size="small" @click="router.push('/settings/island')">返回设置</el-button>
      <el-button type="primary" size="small" :loading="!!pending" :disabled="!ready" @click="apply">
        应用并返回
      </el-button>
    </div>
    <header class="page-header component-heading">
      <div class="heading-copy">
        <h2 class="page-title">组件</h2>
        <p>以下组件将显示在主界面上，从组件库拖动组件以添加组件。</p>
      </div>
      <div class="scheme-tools" :aria-busy="!ready">
        <label id="scheme-label">配置方案</label>
        <div class="scheme-controls">
          <el-select
            v-model="settings.activeSchemeId"
            aria-labelledby="scheme-label"
            aria-label="当前方案"
            :disabled="!ready"
            @change="switchScheme"
          >
            <el-option v-for="item in settings.schemes" :key="item.id" :label="item.name" :value="item.id" />
          </el-select>
          <el-button
            text
            class="icon-button"
            title="重置当前方案"
            aria-label="重置当前方案"
            :disabled="!ready"
            @click="resetScheme"
          >
            <el-icon><Refresh /></el-icon>
          </el-button>
          <el-button
            text
            class="icon-button"
            title="新建方案"
            aria-label="新建方案"
            :disabled="!ready"
            @click="newScheme"
          >
            <el-icon><Plus /></el-icon>
          </el-button>
          <el-dropdown trigger="click" :disabled="!ready" @command="schemeCommand">
            <el-button text class="icon-button" title="管理方案" aria-label="管理方案" :disabled="!ready">
              <el-icon><FolderOpened /></el-icon>
            </el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="settings">方案设置</el-dropdown-item>
                <el-dropdown-item command="clone">复制方案</el-dropdown-item>
                <el-dropdown-item command="import" divided>导入方案</el-dropdown-item>
                <el-dropdown-item command="export">导出方案</el-dropdown-item>
                <el-dropdown-item command="delete" divided :disabled="settings.schemes.length < 2">
                  删除方案
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </div>
    </header>
    <el-alert v-if="error" type="error" :closable="false" :title="error">
      <el-button link type="primary" @click="ready ? save() : load()">重试</el-button>
    </el-alert>
    <template v-if="ready">
      <div class="surface-toolbar">
        <div class="surface-tabs" role="tablist" aria-label="编辑内容">
          <button
            role="tab"
            :aria-selected="surface === 'compact'"
            :class="{ active: surface === 'compact' }"
            @click="
              surface = 'compact';
              resetSelection();
            "
          >
            常态内容
          </button>
          <button
            role="tab"
            :aria-selected="surface === 'expanded'"
            :class="{ active: surface === 'expanded' }"
            @click="
              surface = 'expanded';
              resetSelection();
            "
          >
            无通知展开内容
          </button>
        </div>
        <div class="surface-actions">
          <el-button text size="small" @click="addRow">新增行</el-button>
          <el-button
            text
            size="small"
            @click="
              panel = 'row';
              inspectorOpen = true;
            "
          >
            行设置
          </el-button>
          <el-button text size="small" :type="editMode ? 'primary' : 'default'" @click="editMode = !editMode">
            {{ editMode ? '退出编辑模式' : '进入编辑模式' }}
          </el-button>
        </div>
      </div>
      <div
        class="preview-canvas"
        :class="{ 'live-preview': editMode, 'is-dragging': dragging?.moved }"
        aria-label="组件排列画布"
      >
        <div v-if="!editMode" class="component-lines">
          <section
            v-for="row in rows"
            :key="row.id"
            class="component-line"
            :class="{
              'drop-row': drop?.row.id === row.id && !drop.node,
              'active-row': rows.length > 1 && activeRow.id === row.id,
            }"
            :data-row="row.id"
          >
            <button
              class="row-handle"
              :aria-label="`编辑${row.name}`"
              :title="`${row.name}，拖动排序，点击设置`"
              @pointerdown="beginDrag($event, { rowId: row.id, label: row.name })"
              @click="!suppressClick && selectRow(row.id)"
            >
              <span aria-hidden="true">Ⅱ</span>
            </button>
            <div class="line-components" :style="{ gap: `${row.gap}px` }">
              <IslandEditorNode
                v-for="node in row.nodes"
                :key="node.id"
                :node="node"
                :selected-id="selectedId"
                :drop-id="drop?.node?.id"
                :drop-position="drop?.position"
                @select="selectNode"
                @drag="startDrag"
              />
              <button v-if="!row.nodes.length" class="empty-line" @click="selectRow(row.id)">
                将组件拖到这里，或点击下方组件添加
              </button>
            </div>
          </section>
        </div>
        <div
          v-else
          class="island-preview"
          :class="{ separated: scheme.separated }"
          :style="{
            zoom: scheme.scale * zoom,
            '--preview-gap': `${scheme.spacing}px`,
            '--preview-radius': `${scheme.radius}px`,
            '--secondary': `${(appearance.fontSize / 13) * 14}px`,
            '--emphasized': `${(appearance.fontSize / 13) * 18}px`,
            '--large': `${(appearance.fontSize / 13) * 20}px`,
            fontSize: `${(appearance.fontSize / 13) * 16}px`,
          }"
        >
          <section
            v-for="row in rows"
            :key="row.id"
            class="preview-row"
            :class="{ 'drop-row': drop?.row.id === row.id && !drop.node }"
            :data-row="row.id"
            :style="{ gap: `${row.gap}px` }"
            @click.self="selectRow(row.id)"
          >
            <ComponentNode
              v-for="node in row.nodes"
              :key="node.id"
              :node="node"
              :state="state"
              :now="now"
              :schedules="schedules"
              :time-points="timePoints"
              editing
              :selected-id="selectedId"
              alert-node-id=""
              @select="selectNode"
              @drag="startDrag"
            />
            <button v-if="!row.nodes.length" class="empty-preview" @click="selectRow(row.id)">
              将组件拖到这里
            </button>
          </section>
        </div>
      </div>
      <div v-if="editMode" class="preview-toolbar">
        <span>预览缩放</span>
        <el-slider
          v-model="zoom"
          :min="0.3"
          :max="1.5"
          :step="0.1"
          :format-tooltip="(v: number) => `${Math.round(v * 100)}%`"
        />
        <el-button text size="small" @click="zoom = 1">重置缩放</el-button>
        <span class="hint">点选组件调整内容、外观和隐藏条件</span>
      </div>
      <section class="component-library" aria-labelledby="library-heading">
        <h3 id="library-heading" class="library-title">组件库</h3>
        <div class="component-options">
          <button
            v-for="item in library"
            :key="item.kind"
            class="library-item"
            :data-library-kind="item.kind"
            :aria-label="`添加${ISLAND_COMPONENT_LABELS[item.kind]}`"
            @pointerdown="beginDrag($event, { kind: item.kind, label: ISLAND_COMPONENT_LABELS[item.kind] })"
            @click="add(item.kind)"
          >
            <ComponentIcon :kind="item.kind" />
            <span>
              <strong>{{ ISLAND_COMPONENT_LABELS[item.kind] }}</strong>
              <span class="component-description">{{ item.description }}</span>
            </span>
          </button>
        </div>
        <h4 class="message-library-title">班级消息</h4>
        <div class="component-options message-options">
          <button
            v-for="item in messageLibrary"
            :key="item.kind"
            class="library-item"
            :data-library-kind="item.kind"
            :aria-label="`添加${ISLAND_COMPONENT_LABELS[item.kind]}`"
            @pointerdown="beginDrag($event, { kind: item.kind, label: ISLAND_COMPONENT_LABELS[item.kind] })"
            @click="add(item.kind)"
          >
            <ComponentIcon :kind="item.kind" />
            <span>
              <strong>{{ ISLAND_COMPONENT_LABELS[item.kind] }}</strong>
              <span class="component-description">{{ item.description }}</span>
            </span>
          </button>
        </div>
      </section>
      <div v-if="showTip" class="editor-tip" role="note">
        <el-icon class="tip-icon"><InfoFilled /></el-icon>
        <span>
          <strong>编辑提示：</strong>
          现在可以使用「编辑模式」更加直观地编辑主界面上的组件！
        </span>
        <el-button @click="editMode = !editMode">{{ editMode ? '退出编辑模式' : '进入编辑模式' }}</el-button>
        <button class="dismiss-tip" aria-label="关闭编辑提示" @click="showTip = false">×</button>
      </div>
    </template>
    <el-skeleton v-else :rows="8" animated />
    <input ref="importInput" type="file" accept="application/json,.json" hidden @change="importScheme" />
    <div
      v-if="dragging?.moved"
      class="drag-ghost"
      :style="{ left: `${pointer.x + 16}px`, top: `${pointer.y + 16}px` }"
    >
      {{ dragging.label }}
    </div>
    <el-drawer
      v-model="inspectorOpen"
      class="island-inspector"
      title="组件设置"
      :size="'min(360px, 94vw)'"
      :modal="false"
      modal-penetrable
      :lock-scroll="false"
      append-to-body
    >
      <el-radio-group v-model="panel" size="small" class="inspector-tabs">
        <el-radio-button value="scheme">方案</el-radio-button>
        <el-radio-button value="row">行</el-radio-button>
        <el-radio-button value="component" :disabled="!selected">组件</el-radio-button>
      </el-radio-group>
      <IslandComponentSettings
        v-if="panel === 'component' && selected"
        :node="selected"
        @change="save"
        @remove="removeNode"
        @duplicate="copyNode"
        @wrap="wrap"
      />
      <el-form v-else-if="panel === 'row'" label-position="top">
        <h3>组件行</h3>
        <el-form-item label="当前行">
          <el-select :model-value="activeRow.id" @change="selectRow">
            <el-option v-for="row in rows" :key="row.id" :value="row.id" :label="row.name" />
          </el-select>
        </el-form-item>
        <el-form-item label="行名称">
          <el-input v-model="activeRow.name" :maxlength="64" @change="save" />
        </el-form-item>
        <el-form-item label="组件间距">
          <el-input-number v-model="activeRow.gap" :min="0" :max="64" @change="save" />
        </el-form-item>
        <el-form-item label="允许显示提醒">
          <el-switch v-model="activeRow.allowNotifications" @change="save" />
        </el-form-item>
        <el-button :disabled="activeRow.main" @click="setMain">
          {{ activeRow.main ? '已设为主要行' : '设为主要行' }}
        </el-button>
        <p class="hint">提醒优先使用主要行；关闭提醒后使用下一条允许提醒的行。</p>
        <div class="row-actions">
          <el-button :disabled="rows.indexOf(activeRow) === 0" @click="moveRow(-1)">上移</el-button>
          <el-button :disabled="rows.indexOf(activeRow) === rows.length - 1" @click="moveRow(1)">
            下移
          </el-button>
          <el-button type="danger" plain :disabled="rows.length < 2" @click="removeRow">删除此行</el-button>
        </div>
      </el-form>
      <el-form v-else label-position="top">
        <h3>方案设置</h3>
        <el-form-item label="方案名称">
          <el-input v-model="scheme.name" :maxlength="64" @change="save" />
        </el-form-item>
        <el-form-item label="界面缩放">
          <el-input-number
            v-model="scheme.scale"
            :min="METRICS.scaleMin"
            :max="METRICS.scaleMax"
            :step="0.05"
            @change="save"
          />
        </el-form-item>
        <el-form-item label="行间距">
          <el-slider v-model="scheme.spacing" :min="0" :max="METRICS.rowSpacingMax" @change="save" />
        </el-form-item>
        <el-form-item label="常态圆角">
          <el-slider v-model="scheme.radius" :min="0" :max="METRICS.radiusMax" @change="save" />
        </el-form-item>
        <el-form-item label="各行分离显示">
          <el-switch v-model="scheme.separated" @change="save" />
        </el-form-item>
        <p class="hint">字体、透明度、位置和动画与灵动岛共用设置。</p>
        <el-button link type="primary" @click="router.push('/settings/island')">前往灵动岛外观设置</el-button>
      </el-form>
    </el-drawer>
  </section>
</template>
<style scoped src="../../styles/island-editor.css"></style>
