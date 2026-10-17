<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import type { MenuInstance } from 'element-plus';
import type { ManagementMenuGroup } from '@/config/navigation';
const props = defineProps<{ groups: ManagementMenuGroup[]; active: string; collapsed?: boolean }>();
const emit = defineEmits<{ select: [path: string]; expand: [] }>();
const menu = ref<MenuInstance>();
watch(
  () => [props.active, props.groups],
  async () => {
    await nextTick();
    const group = props.groups.find((g) => g.items.some((i) => i.path === props.active));
    if (group) menu.value?.open(group.id);
  },
  { immediate: true },
);
</script>
<template>
  <el-menu
    ref="menu"
    :default-active="active"
    :default-openeds="groups.filter((g) => g.items.some((i) => i.path === active)).map((g) => g.id)"
    class="layout-menu management-menu"
    :class="{ 'menu-rail': collapsed }"
    unique-opened
    @select="emit('select', $event)"
  >
    <el-sub-menu v-for="group in groups" :key="group.id" :index="group.id">
      <template #title>
        <div
          class="management-group-title"
          :title="collapsed ? group.title : undefined"
          @click="collapsed && emit('expand')"
        >
          <el-icon><component :is="group.icon" /></el-icon>
          <span>{{ group.title }}</span>
        </div>
      </template>
      <el-menu-item v-for="item in group.items" :key="item.path" :index="item.path" :data-path="item.path">
        <el-icon><component :is="item.icon" /></el-icon>
        <span>{{ item.title }}</span>
      </el-menu-item>
    </el-sub-menu>
  </el-menu>
</template>
<style scoped>
.management-menu.layout-menu {
  --el-menu-text-color: var(--ch-text-secondary);
  --el-menu-active-color: var(--el-color-primary);
  --el-menu-hover-bg-color: var(--ch-surface-alt);
  background: transparent;
  border: 0;
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 12px 8px;
}
.management-group-title {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 100%;
  overflow: hidden;
}
.management-group-title .el-icon {
  flex: 0 0 20px;
  margin: 0;
}
.management-menu :deep(.el-sub-menu__title) {
  padding: 0 14px;
  height: 46px;
  margin-bottom: 4px;
  border-radius: 10px;
  color: var(--ch-text-secondary);
  font-weight: 600;
}
.management-menu :deep(.el-sub-menu.is-active > .el-sub-menu__title) {
  color: var(--el-color-primary);
}
.management-menu :deep(.el-menu) {
  background: transparent;
}
.management-menu :deep(.el-menu-item) {
  height: 42px;
  padding-left: 26px;
  margin: 3px 0 3px 10px;
  border-radius: 8px;
  min-width: 0;
  color: var(--ch-text-secondary);
}
.management-menu.layout-menu :deep(.el-menu-item.is-active) {
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
  font-weight: 600;
}
.management-menu.menu-rail :deep(.el-sub-menu > .el-menu) {
  display: none;
}
.management-menu.menu-rail :deep(.el-sub-menu__icon-arrow),
.management-menu.menu-rail .management-group-title span {
  opacity: 0;
  width: 0;
}
.management-menu.menu-rail :deep(.el-sub-menu__title) {
  padding: 0 14px !important;
}
.management-menu.menu-rail {
  overflow-x: hidden;
}
</style>
