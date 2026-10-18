<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from 'vue';
import {
  defaultIslandLayouts,
  DEFAULT_ISLAND_APPEARANCE,
  type IslandAppearance,
  type IslandState,
  type ScheduleDto,
} from '@classhelper/shared';
import FixedIsland from './IslandApp.vue';
import CoursewareTransfer from './CoursewareTransfer.vue';
import './custom-island.css';
import CustomIslandRuntime from './CustomIslandRuntime.vue';
const settings = ref(defaultIslandLayouts()),
  ready = ref(false);
const schedules = ref<ScheduleDto[]>([]);
const appearance = ref<IslandAppearance>({ ...DEFAULT_ISLAND_APPEARANCE });
const nativeVisible = ref(false);
const resident = () => settings.value.layout === 'custom';
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
let heartbeat: ReturnType<typeof setInterval>;
onUnmounted(() => clearInterval(heartbeat));
onMounted(async () => {
  heartbeat = setInterval(() => window.island?.alive(), 5000);
  const bridge = window.island;
  if (bridge) {
    bridge.onLayout((value) => (settings.value = value));
    bridge.onSchedules((value) => (schedules.value = value));
    bridge.onState((value) => (state.value = value));
    bridge.onAppearance((value) => (appearance.value = value));
    bridge.onVisibility((value) => (nativeVisible.value = value));
    nativeVisible.value = await bridge.getVisible();
    appearance.value = await bridge.getAppearance();
    settings.value = await bridge.getLayout();
    schedules.value = await bridge.getSchedules();
    state.value = await bridge.getState();
  }
  await nextTick();
  ready.value = true;
});
</script>
<template>
  <CustomIslandRuntime
    v-if="resident() && !state.coursewareTransfer"
    :settings="settings"
    :state="state"
    :schedules="schedules"
    :appearance="appearance"
    :native-visible="nativeVisible"
  />
  <FixedIsland v-if="ready" v-show="!resident() && !state.coursewareTransfer" :suspended="resident() || !!state.coursewareTransfer" />
  <CoursewareTransfer v-if="state.coursewareTransfer" :transfer="state.coursewareTransfer" :appearance="appearance" />
</template>
