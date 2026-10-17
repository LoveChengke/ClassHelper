<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import {
  defaultIslandLayouts,
  DEFAULT_ISLAND_APPEARANCE,
  type IslandState,
  type IslandAppearance,
} from '@classhelper/shared';
import CustomIsland from '../../../island/CustomIsland.vue';
import { getIslandSchedules } from '../../island/bridge.js';
const router = useRouter();
const settings = ref(defaultIslandLayouts());
const appearance = ref<IslandAppearance>({ ...DEFAULT_ISLAND_APPEARANCE });
const schedules = ref(getIslandSchedules());
const state = ref<IslandState>({
  mode: 'hidden',
  active: null,
  queued: [],
  inClass: false,
  currentPeriodEnd: null,
  reason: null,
  listExpanded: false,
  maxCardHeight: 1024,
  updatedAt: 0,
});
const ready = ref(false);
const error = ref('');
let refresh: ReturnType<typeof setInterval>;
onMounted(async () => {
  const config = await window.desktop?.getConfig();
  if (config) {
    settings.value = { ...config.islandLayout, layout: 'custom', residentEnabled: true };
    appearance.value = config.island;
    await window.desktop?.saveConfig({ islandLayout: JSON.parse(JSON.stringify(settings.value)) });
  }
  ready.value = true;
  refresh = setInterval(() => {
    schedules.value = getIslandSchedules();
  }, 1000);
});
onUnmounted(() => clearInterval(refresh));
// 保存按顺序发送；快速拖动不会让较早的响应覆盖较新的草稿。
let saving = Promise.resolve();
function save(value: typeof settings.value) {
  settings.value = value;
  const snapshot = JSON.parse(JSON.stringify(value));
  saving = saving
    .then(async () => {
      await window.desktop?.saveConfig({ islandLayout: snapshot });
      error.value = '';
    })
    .catch(() => {
      error.value = '保存失败，请重试';
    });
}
async function done() {
  await saving;
  if (!error.value) await router.push('/settings/island');
}
</script>
<template>
  <section class="island-editor-page" aria-label="自定义灵动岛编辑器">
    <p v-if="error" role="alert">{{ error }}</p>
    <CustomIsland
      v-if="ready"
      :settings="settings"
      :appearance="appearance"
      :schedules="schedules"
      :state="state"
      editing
      embedded
      @save="save"
      @done="done"
    />
  </section>
</template>
<style>
.island-editor-page {
  height: 100%;
  min-height: 430px;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.island-editor-page .layout-editor {
  position: relative;
  inset: auto;
  flex: 1;
  min-height: 430px;
  width: 100%;
  border-radius: 0;
  box-shadow: none;
  grid-template-columns: 160px minmax(200px, 1fr) 248px;
  grid-template-rows: 64px minmax(0, 1fr);
}
.island-editor-page .layout-editor .canvas {
  padding: 110px 16px 80px;
}
.island-editor-page .layout-editor .library,
.island-editor-page .layout-editor .settings {
  min-height: 0;
  padding: 14px 12px;
}
.island-editor-page .layout-editor .editor-header {
  padding: 10px 14px;
  gap: 12px;
}
.island-editor-page .layout-editor .editor-title p,
.island-editor-page .layout-editor .save-state {
  display: none;
}
.island-editor-page .layout-editor .scheme-picker {
  margin-left: auto;
}
@media (max-width: 1100px) {
  .island-editor-page .layout-editor {
    grid-template-columns: 130px minmax(140px, 1fr) 220px;
  }
  .island-editor-page .layout-editor .component-grid {
    grid-template-columns: 1fr;
  }
  .island-editor-page .layout-editor .scheme-picker > span {
    display: none;
  }
}
</style>
