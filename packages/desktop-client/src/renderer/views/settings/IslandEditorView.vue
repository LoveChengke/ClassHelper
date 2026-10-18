<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { onBeforeRouteLeave, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { AllowDropType } from 'element-plus/es/components/tree/src/tree.type';
import type TreeNode from 'element-plus/es/components/tree/src/model/node';
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
  type IslandState,
  type IslandAppearance,
} from '@classhelper/shared';
import ComponentNode from '../../../island/ComponentNode.vue';
import ComponentIcon from '../../../island/ComponentIcon.vue';
import IslandComponentSettings from '../../components/IslandComponentSettings.vue';
import { getIslandSchedules } from '../../island/bridge.js';
const router = useRouter();
const settings = ref(defaultIslandLayouts()),
  appearance = ref<IslandAppearance>({ ...DEFAULT_ISLAND_APPEARANCE });
const schedules = ref(getIslandSchedules()),
  now = ref(Date.now()),
  ready = ref(false),
  error = ref(''),
  pending = ref(0),
  saved = ref(false);
const surface = ref<'compact' | 'expanded'>('compact'),
  panel = ref<'scheme' | 'row' | 'component'>('scheme');
const selectedId = ref(''),
  rowId = ref(''),
  libraryOpen = ref(false),
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
const groups = [
  { label: '日常信息', kinds: ['clock', 'date', 'schedule', 'countdown', 'text', 'separator'] },
  { label: '消息提醒', kinds: ['notification', 'homework', 'call'] },
  { label: '组合容器', kinds: ['group', 'stack', 'slide', 'rolling'] },
] as const;
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
  const snapshot = normalizeIslandLayouts(JSON.parse(JSON.stringify(settings.value)));
  const current = ++revision;
  pending.value++;
  saved.value = false;
  saveQueue = saveQueue.then(async () => {
    try {
      await window.desktop?.saveConfig({ islandLayout: snapshot });
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
  selectedId.value = nodeId;
  panel.value = 'component';
  rowId.value = rows.value.find((row) => all(row.nodes).some((node) => node.id === nodeId))?.id ?? '';
}
function selectRow(value: string) {
  rowId.value = value;
  selectedId.value = '';
  panel.value = 'row';
}
function resetSelection() {
  selectedId.value = '';
  rowId.value = '';
  panel.value = 'scheme';
}
function switchScheme() {
  resetSelection();
  void save();
}
function add(kind: IslandComponentKind) {
  const node = islandNode(kind, id());
  activeRow.value.nodes.push(node);
  selectNode(node.id);
  libraryOpen.value = false;
  void save();
}
function addRow() {
  const row: IslandLayoutRow = {
    id: id(),
    name: `组件行 ${rows.value.length + 1}`,
    main: false,
    allowNotifications: true,
    gap: 8,
    nodes: [],
  };
  rows.value.push(row);
  selectRow(row.id);
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
  if (!selected.value) return;
  const list = findList(selected.value.id)!;
  const copy: IslandComponentNode = JSON.parse(JSON.stringify(selected.value));
  all([copy]).forEach((node) => (node.id = id()));
  list.splice(list.indexOf(selected.value) + 1, 0, copy);
  selectNode(copy.id);
  void save();
}
function wrap(kind: IslandComponentKind) {
  if (!selected.value || !containers.includes(kind)) return;
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
  rowId.value = '';
  void save();
}
function setMain() {
  rows.value.forEach((row) => (row.main = row.id === activeRow.value.id));
  void save();
}
function cloneScheme() {
  const copy = JSON.parse(JSON.stringify(scheme.value)) as typeof scheme.value;
  copy.id = id();
  copy.name = `${copy.name} 副本`;
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
    if (!file) return;
    if (file.size > 1000000) throw new Error('方案文件不能超过 1 MB');
    const parsed = JSON.parse(await file.text());
    if (parsed.format !== 'classhelper-island-layout' || !parsed.scheme?.rows?.length)
      throw new Error('方案格式不正确');
    const imported = normalizeIslandLayouts({ schemes: [parsed.scheme], activeSchemeId: parsed.scheme.id })
      .schemes[0]!;
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
  await load();
  clock = setInterval(() => {
    now.value = Date.now();
    schedules.value = getIslandSchedules();
  }, 1000);
});
onUnmounted(() => clearInterval(clock));
onBeforeRouteLeave(async () => {
  if (!ready.value) return true;
  await save();
  return !error.value;
});
interface TreeItem {
  id: string;
  label: string;
  type: 'row' | 'node';
  source?: IslandComponentNode;
  row?: IslandLayoutRow;
  children: TreeItem[];
}
function nodeItem(node: IslandComponentNode): TreeItem {
  return {
    id: node.id,
    label: ISLAND_COMPONENT_LABELS[node.kind],
    type: 'node',
    source: node,
    children: node.children.map(nodeItem),
  };
}
const tree = computed<TreeItem[]>(() =>
  rows.value.map((row) => ({
    id: row.id,
    label: row.name,
    type: 'row',
    row,
    children: row.nodes.map(nodeItem),
  })),
);
function treeClick(item: TreeItem) {
  if (item.type === 'row') selectRow(item.id);
  else selectNode(item.id);
}
function allowDrop(dragging: TreeNode, dropping: TreeNode, type: AllowDropType) {
  const from = dragging.data as TreeItem,
    to = dropping.data as TreeItem;
  if (from.type === 'row') return to.type === 'row' && type !== 'inner';
  if (to.type === 'row') return type === 'inner';
  return type !== 'inner' || (!!to.source && containers.includes(to.source.kind));
}
function dropped() {
  function rebuild(item: TreeItem): IslandComponentNode {
    return { ...item.source!, children: item.children.map(rebuild) };
  }
  const updated = tree.value.map((item) => ({ ...item.row!, nodes: item.children.map(rebuild) }));
  if (surface.value === 'expanded') scheme.value.expandedRows = updated;
  else scheme.value.rows = updated;
  void save();
}
let dragging: string | null = null;
function startDrag(event: PointerEvent, nodeId: string) {
  event.preventDefault();
  event.stopPropagation();
  dragging = nodeId;
  try {
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  } catch {
    /* 合成事件没有活动指针 */
  }
}
function dropPreview(event: PointerEvent) {
  if (!dragging) return;
  const moving = dragging;
  dragging = null;
  const target = document.elementFromPoint(event.clientX, event.clientY),
    targetId = target?.closest<HTMLElement>('[data-node]')?.dataset.node;
  const row = rows.value.find((row) => row.id === target?.closest<HTMLElement>('[data-row]')?.dataset.row);
  const list = findList(moving),
    node = list?.find((node) => node.id === moving);
  if (!row || !list || !node || all([node]).some((n) => n.id === targetId)) return;
  const to = all(row.nodes).find((n) => n.id === targetId);
  list.splice(list.indexOf(node), 1);
  if (to && containers.includes(to.kind)) to.children.push(node);
  else if (to) {
    const targetList = findList(to.id)!;
    targetList.splice(targetList.indexOf(to), 0, node);
  } else row.nodes.push(node);
  selectNode(node.id);
  void save();
}
</script>
<template>
  <section class="page island-editor-page" aria-label="自定义灵动岛设置">
    <header class="page-header page-heading">
      <div>
        <h2 class="page-title">自定义灵动岛</h2>
        <p>管理方案、排列内容并调整组件。更改自动保存到本机。</p>
      </div>
      <div class="heading-actions">
        <el-tag :type="error ? 'danger' : pending ? 'warning' : 'info'" effect="plain" role="status">
          {{ error ? '保存失败' : pending ? '正在保存…' : saved ? '已保存' : '本机方案' }}
        </el-tag>
        <el-button @click="router.push('/settings/island')">返回设置</el-button>
        <el-button type="primary" :loading="!!pending" :disabled="!ready" @click="apply">
          应用并返回
        </el-button>
      </div>
    </header>
    <el-alert v-if="error" type="error" :closable="false" :title="error">
      <el-button link type="primary" @click="ready ? save() : load()">重试</el-button>
    </el-alert>
    <template v-if="ready">
      <el-card shadow="never" class="scheme-card">
        <div class="scheme-toolbar">
          <el-form-item label="当前方案">
            <el-select v-model="settings.activeSchemeId" aria-label="当前方案" @change="switchScheme">
              <el-option
                v-for="item in settings.schemes"
                :key="item.id"
                :label="item.name"
                :value="item.id"
              />
            </el-select>
          </el-form-item>
          <el-button @click="cloneScheme">复制方案</el-button>
          <el-button @click="importInput?.click()">导入</el-button>
          <el-button @click="exportScheme">导出</el-button>
          <el-button type="danger" plain :disabled="settings.schemes.length < 2" @click="deleteScheme">
            删除方案
          </el-button>
          <input
            ref="importInput"
            type="file"
            accept="application/json,.json"
            hidden
            @change="importScheme"
          />
        </div>
      </el-card>
      <div class="editor-columns">
        <div class="layout-column">
          <el-card shadow="never" class="preview-card">
            <template #header>
              <div class="card-heading">
                <strong>实时预览</strong>
                <el-radio-group v-model="surface" size="small" @change="resetSelection">
                  <el-radio-button value="compact">常态内容</el-radio-button>
                  <el-radio-button value="expanded">无通知展开时</el-radio-button>
                </el-radio-group>
              </div>
            </template>
            <div class="preview-canvas" @pointerup="dropPreview" @pointercancel="dragging = null">
              <div
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
                  :class="{ selected: panel === 'row' && row.id === activeRow.id }"
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
                    editing
                    :selected-id="selectedId"
                    alert-node-id=""
                    @select="selectNode"
                    @drag="startDrag"
                  />
                  <span v-if="!row.nodes.length" class="empty-preview" @click="selectRow(row.id)">
                    此行暂无组件
                  </span>
                </section>
              </div>
            </div>
            <div class="preview-toolbar">
              <span>预览缩放</span>
              <el-slider
                v-model="zoom"
                :min="0.3"
                :max="1.5"
                :step="0.1"
                :format-tooltip="(v: number) => `${Math.round(v * 100)}%`"
              />
              <el-button size="small" @click="zoom = 1">重置</el-button>
            </div>
          </el-card>
          <el-card shadow="never" class="structure-card">
            <template #header>
              <div class="card-heading">
                <strong>内容结构</strong>
                <div>
                  <el-button size="small" @click="addRow">新增行</el-button>
                  <el-button size="small" type="primary" @click="libraryOpen = true">添加组件</el-button>
                </div>
              </div>
            </template>
            <p class="hint">拖动可调整顺序，或将组件移入分组、轮播等容器。点选后在右侧设置。</p>
            <el-tree
              :data="tree"
              node-key="id"
              default-expand-all
              highlight-current
              :expand-on-click-node="false"
              :current-node-key="selectedId || rowId"
              draggable
              :allow-drop="allowDrop"
              @node-click="treeClick"
              @node-drop="dropped"
            >
              <template #default="{ data }">
                <span class="tree-label">
                  <span>{{ data.label }}</span>
                  <el-tag v-if="data.type === 'row' && data.row.main" size="small" type="info">主要行</el-tag>
                </span>
              </template>
            </el-tree>
          </el-card>
        </div>
        <el-card shadow="never" class="properties-card">
          <template #header>
            <el-radio-group v-model="panel" size="small">
              <el-radio-button value="scheme">方案</el-radio-button>
              <el-radio-button value="row">行</el-radio-button>
              <el-radio-button value="component" :disabled="!selected">组件</el-radio-button>
            </el-radio-group>
          </template>
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
            <el-form-item label="行名称"><el-input v-model="activeRow.name" @change="save" /></el-form-item>
            <el-form-item label="组件间距">
              <el-input-number v-model="activeRow.gap" :min="0" :max="80" @change="save" />
            </el-form-item>
            <el-form-item label="允许显示提醒">
              <el-switch v-model="activeRow.allowNotifications" @change="save" />
            </el-form-item>
            <el-button :disabled="activeRow.main" @click="setMain">
              {{ activeRow.main ? '已设为主要行' : '设为主要行' }}
            </el-button>
            <p class="hint">提醒优先使用主要行；关闭提醒后使用下一条允许提醒的行。</p>
            <el-button type="danger" plain :disabled="rows.length < 2" @click="removeRow">删除此行</el-button>
          </el-form>
          <el-form v-else label-position="top">
            <h3>方案设置</h3>
            <el-form-item label="方案名称"><el-input v-model="scheme.name" @change="save" /></el-form-item>
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
            <el-button link type="primary" @click="router.push('/settings/island')">
              前往灵动岛外观设置
            </el-button>
          </el-form>
        </el-card>
      </div>
    </template>
    <el-skeleton v-else :rows="8" animated />
    <el-dialog v-model="libraryOpen" title="添加组件" width="min(540px, 94vw)">
      <el-form-item label="添加到">
        <el-select :model-value="activeRow.id" @change="selectRow">
          <el-option v-for="row in rows" :key="row.id" :value="row.id" :label="row.name" />
        </el-select>
      </el-form-item>
      <section v-for="group in groups" :key="group.label" class="component-group">
        <h3>{{ group.label }}</h3>
        <div class="component-options">
          <el-button v-for="kind in group.kinds" :key="kind" class="component-option" @click="add(kind)">
            <ComponentIcon :kind="kind" />
            <span>{{ ISLAND_COMPONENT_LABELS[kind] }}</span>
          </el-button>
        </div>
      </section>
    </el-dialog>
  </section>
</template>
<style scoped>
.island-editor-page {
  display: grid;
  gap: 16px;
  min-width: 0;
  color: var(--ch-text);
}
.page-heading,
.heading-actions,
.scheme-toolbar,
.card-heading {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.page-heading,
.card-heading {
  justify-content: space-between;
}
h2,
h3 {
  margin: 0 0 6px;
}
.page-heading p,
.hint {
  color: var(--ch-text-secondary);
  line-height: 1.6;
  margin: 6px 0;
  font-size: 12px;
}
.scheme-toolbar .el-form-item {
  margin: 0 auto 0 0;
}
.scheme-toolbar .el-select {
  width: 200px;
}
.editor-columns {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 288px;
  gap: 16px;
  align-items: start;
}
.layout-column {
  display: grid;
  gap: 16px;
  min-width: 0;
}
.preview-card :deep(.el-card__body) {
  padding: 0;
}
.preview-canvas {
  min-height: 208px;
  overflow: auto;
  display: grid;
  place-items: center;
  padding: 30px 18px;
  background-color: var(--ch-layer-alt);
  background-image: radial-gradient(var(--ch-border-strong) 1px, transparent 1px);
  background-size: 16px 16px;
}
.island-preview {
  display: flex;
  flex-direction: column;
  gap: var(--preview-gap);
  color: #ffffffeb;
  width: max-content;
  max-width: none;
  padding: 12px;
  border-radius: var(--preview-radius);
  background: #202024;
  box-shadow: var(--ch-shadow-card);
}
.preview-row {
  display: flex;
  align-items: center;
  min-height: 40px;
  border-radius: var(--preview-radius);
}
.preview-row.selected {
  outline: 2px solid var(--ch-accent);
  outline-offset: 4px;
}
.island-preview.separated {
  background: transparent;
  padding: 0;
  box-shadow: none;
}
.separated .preview-row {
  padding: 12px;
  background: #202024;
}
.empty-preview {
  color: #ffffffb8;
  padding: 8px 14px;
  cursor: pointer;
  font-size: 13px;
}
.preview-toolbar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 8px 16px;
  color: var(--ch-text-secondary);
  font-size: 12px;
  border-top: 1px solid var(--ch-border);
}
.preview-toolbar .el-slider {
  flex: 1;
  max-width: 160px;
}
.card-heading > div {
  display: flex;
  gap: 6px;
}
.tree-label {
  min-width: 0;
  display: flex;
  gap: 10px;
  align-items: center;
  font-size: 13px;
}
.properties-card .el-select {
  width: 100%;
}
.component-group + .component-group {
  margin-top: 20px;
}
.component-options {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}
.component-option {
  height: 60px;
  margin: 0;
}
.component-option :deep(span) {
  display: flex;
  align-items: center;
  gap: 8px;
}
.component-option :deep(svg) {
  width: 20px;
  height: 20px;
}
@media (max-width: 900px) {
  .editor-columns {
    grid-template-columns: minmax(0, 1fr) 250px;
  }
  .scheme-toolbar .el-form-item {
    flex-basis: 100%;
  }
}
@media (max-width: 700px) {
  .editor-columns {
    grid-template-columns: 1fr;
  }
  .heading-actions {
    width: 100%;
  }
  .component-options {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>
