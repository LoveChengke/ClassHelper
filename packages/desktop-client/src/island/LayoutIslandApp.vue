<script setup lang="ts">
import { nextTick, onMounted, ref, shallowRef } from 'vue';
import {
  defaultIslandLayouts,
  type IslandLayoutSettings,
  type IslandState,
  type ScheduleDto,
} from '@classhelper/shared';
import FixedIsland from './IslandApp.vue';
import CustomIsland from './CustomIsland.vue';
const settings = ref(defaultIslandLayouts()),
  editing = ref(false),
  ready = ref(false);
const schedules = ref<ScheduleDto[]>([]);
const alertHost = shallowRef<HTMLElement | null>(null);
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
onMounted(async () => {
  const bridge = window.island;
  if (bridge) {
    bridge.onLayout((value) => (settings.value = value));
    bridge.onEditing((value) => (editing.value = value));
    bridge.onSchedules((value) => (schedules.value = value));
    bridge.onState((value) => (state.value = value));
    settings.value = await bridge.getLayout();
    state.value = await bridge.getState();
    editing.value = await bridge.getEditing();
  }
  await nextTick();
  ready.value = true;
});
</script>
<template>
  <CustomIsland
    v-if="settings.layout === 'custom'"
    :settings="settings"
    :state="state"
    :editing="editing"
    :schedules="schedules"
    @save="save"
    @done="done"
    @host="alertHost = $event"
  />
  <Teleport v-if="ready" :disabled="settings.layout === 'fixed' || !alertHost" :to="alertHost || 'body'">
    <FixedIsland
      v-show="settings.layout === 'fixed' || !!alertHost"
      :embedded="settings.layout === 'custom'"
    />
  </Teleport>
</template>
