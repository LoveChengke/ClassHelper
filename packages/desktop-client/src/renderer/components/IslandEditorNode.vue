<script setup lang="ts">
import { computed } from 'vue';
import { ISLAND_COMPONENT_LABELS, type IslandComponentNode } from '@classhelper/shared';
import ComponentIcon from '../../island/ComponentIcon.vue';
const props = defineProps<{
  node: IslandComponentNode;
  selectedId: string;
  dropId?: string;
  dropPosition?: string;
}>();
const emit = defineEmits<{ select: [id: string]; drag: [event: PointerEvent, id: string] }>();
const container = computed(() => ['group', 'stack', 'slide', 'rolling'].includes(props.node.kind));
</script>
<template>
  <div
    class="editor-component"
    :class="{
      container,
      selected: selectedId === node.id,
      'drop-before': dropId === node.id && dropPosition === 'before',
      'drop-after': dropId === node.id && dropPosition === 'after',
      'drop-inside': dropId === node.id && dropPosition === 'inside',
    }"
    :data-node="node.id"
  >
    <button
      class="component-chip node-handle"
      :data-kind="node.kind"
      :aria-label="`编辑${ISLAND_COMPONENT_LABELS[node.kind]}`"
      @pointerdown="emit('drag', $event, node.id)"
      @click.stop="emit('select', node.id)"
    >
      <ComponentIcon :kind="node.kind" />
      <span>{{ ISLAND_COMPONENT_LABELS[node.kind] }}</span>
    </button>
    <div v-if="container" class="container-children">
      <IslandEditorNode
        v-for="child in node.children"
        :key="child.id"
        :node="child"
        :selected-id="selectedId"
        :drop-id="dropId"
        :drop-position="dropPosition"
        @select="emit('select', $event)"
        @drag="(event, id) => emit('drag', event, id)"
      />
      <span v-if="!node.children.length" class="container-empty">拖入组件</span>
    </div>
  </div>
</template>
<style scoped>
.editor-component {
  position: relative;
  display: flex;
  align-items: center;
  flex-shrink: 0;
  border-radius: 5px;
}
.component-chip {
  display: flex;
  align-items: center;
  gap: 5px;
  min-height: 36px;
  padding: 5px 9px;
  border: 1px solid transparent;
  border-radius: 5px;
  background: transparent;
  color: inherit;
  font: inherit;
  white-space: nowrap;
  cursor: grab;
  touch-action: none;
}
.component-chip svg {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
}
.component-chip:hover {
  background: var(--ch-hover-soft);
}
.component-chip:focus-visible {
  outline: 2px solid var(--ch-accent);
  outline-offset: 2px;
}
.selected > .component-chip {
  background: var(--ch-accent-soft);
  border-color: var(--ch-accent);
}
.container {
  border: 1px dashed var(--ch-border-strong);
  padding: 3px;
  gap: 3px;
}
.container-children {
  display: flex;
  align-items: center;
  gap: 3px;
  min-width: 60px;
  min-height: 34px;
}
.container-empty {
  color: var(--ch-text-tertiary);
  font-size: 12px;
  padding: 0 10px;
}
.drop-inside {
  background: var(--ch-accent-soft);
  outline: 2px solid var(--ch-accent);
}
.drop-before::before,
.drop-after::after {
  content: '';
  position: absolute;
  inset: 3px auto 3px -4px;
  width: 3px;
  border-radius: 3px;
  background: var(--ch-accent);
}
.drop-after::after {
  left: auto;
  right: -4px;
}
</style>
