<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, shallowRef } from 'vue';
import {
  defaultIslandLayouts,
  DEFAULT_ISLAND_APPEARANCE,
  type IslandAppearance,
  type IslandLayoutSettings,
  type IslandState,
  type ScheduleDto,
} from '@classhelper/shared';
import FixedIsland from './IslandApp.vue';
import CustomIsland from './CustomIsland.vue';
import CustomIslandRuntime from './CustomIslandRuntime.vue';
const settings = ref(defaultIslandLayouts()),
  editing = ref(false),
  ready = ref(false);
const schedules = ref<ScheduleDto[]>([]);
const appearance = ref<IslandAppearance>({ ...DEFAULT_ISLAND_APPEARANCE });
const nativeVisible = ref(false);
const alertHost = shallowRef<HTMLElement | null>(null);
const resident = () => settings.value.layout === 'custom' && !editing.value;
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
async function save(value: IslandLayoutSettings) {
  settings.value = await window.island!.saveLayout(JSON.parse(JSON.stringify(value)));
}
async function done() {
  editing.value = false;
  await window.island?.setEditing(false);
}
let heartbeat: ReturnType<typeof setInterval>;
onUnmounted(() => clearInterval(heartbeat));
onMounted(async () => {
  heartbeat = setInterval(() => window.island?.alive(), 5000);
  const bridge = window.island;
  if (bridge) {
    bridge.onLayout((value) => (settings.value = value));
    bridge.onEditing((value) => (editing.value = value));
    bridge.onSchedules((value) => (schedules.value = value));
    bridge.onState((value) => (state.value = value));
    bridge.onAppearance((value) => (appearance.value = value));
    bridge.onVisibility((value) => (nativeVisible.value = value));
    nativeVisible.value = await bridge.getVisible();
    appearance.value = await bridge.getAppearance();
    settings.value = await bridge.getLayout();
    schedules.value = await bridge.getSchedules();
    state.value = await bridge.getState();
    editing.value = await bridge.getEditing();
  }
  await nextTick();
  ready.value = true;
});
</script>
<template>
  <CustomIslandRuntime
    v-if="resident()"
    :settings="settings"
    :state="state"
    :schedules="schedules"
    :appearance="appearance"
    :native-visible="nativeVisible"
  />
  <CustomIsland
    v-else-if="settings.layout === 'custom'"
    :settings="settings"
    :state="state"
    :editing="editing"
    :appearance="appearance"
    :schedules="schedules"
    @save="save"
    @done="done"
    @host="alertHost = $event"
  />
  <Teleport
    v-if="ready"
    :disabled="resident() || settings.layout === 'fixed' || !alertHost"
    :to="alertHost || 'body'"
  >
    <FixedIsland
      v-show="!resident() && (settings.layout === 'fixed' || !!alertHost)"
      :embedded="settings.layout === 'custom'"
      :suspended="resident()"
    />
  </Teleport>
</template>
