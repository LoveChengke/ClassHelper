<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import type { IslandComponentNode, IslandWeather } from '@classhelper/shared';
const props = defineProps<{ settings: IslandComponentNode['settings'] }>();
const weather = ref<IslandWeather | null>(null),
  loading = ref(false),
  unavailable = ref(false);
const configured = computed(
  () => typeof props.settings.latitude === 'number' && typeof props.settings.longitude === 'number',
);
let revision = 0;
async function refresh() {
  const current = ++revision;
  if (!configured.value) {
    loading.value = false;
    return;
  }
  loading.value = true;
  try {
    const bridge = window.island ?? window.desktop;
    if (!bridge) throw new Error('仅桌面客户端可读取天气');
    const result = await bridge.getIslandWeather({
      latitude: props.settings.latitude!,
      longitude: props.settings.longitude!,
    });
    if (current === revision) {
      weather.value = result;
      unavailable.value = false;
    }
  } catch {
    if (current === revision) unavailable.value = true;
  } finally {
    if (current === revision) loading.value = false;
  }
}
watch(
  () => [props.settings.latitude, props.settings.longitude],
  () => {
    weather.value = null;
    unavailable.value = false;
    void refresh();
  },
  { immediate: true },
);
const timer = setInterval(() => void refresh(), 60_000);
onUnmounted(() => {
  clearInterval(timer);
  revision++;
});
const description = computed(() => {
  const code = weather.value?.code ?? -1;
  if (code === 0) return '晴';
  if (code <= 3 && code > 0) return ['少云', '多云', '阴'][code - 1];
  if ([45, 48].includes(code)) return '雾';
  if ([51, 53, 55, 56, 57].includes(code)) return '毛毛雨';
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return '雨';
  if ([71, 73, 75, 77, 85, 86].includes(code)) return '雪';
  if ([95, 96, 99].includes(code)) return '雷雨';
  return '天气';
});
const advice = computed(() => {
  if (!weather.value) return '';
  if (weather.value.code >= 95) return '雷雨天气，注意避雷';
  if (weather.value.windSpeed >= 40) return '风力较大，注意出行';
  return '';
});
</script>
<template>
  <span
    class="weather-brief"
    :title="weather ? `Open-Meteo · ${new Date(weather.fetchedAt).toLocaleString('zh-CN')}\n${advice}` : ''"
  >
    <template v-if="weather">
      {{ settings.locationName }} {{ description }} {{ Math.round(weather.temperature) }}°C
      <span v-if="weather.stale || unavailable">· 缓存</span>
      <small v-if="advice">{{ advice }}</small>
    </template>
    <template v-else>
      {{ !configured ? '请设置天气地点' : loading ? '天气加载中…' : '天气暂不可用' }}
    </template>
  </span>
</template>
<style scoped>
.weather-brief {
  white-space: nowrap;
}
small {
  display: block;
  font-size: var(--secondary, 12px);
}
</style>
