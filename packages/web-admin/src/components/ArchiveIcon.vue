<script setup lang="ts">
// 档案编辑器采用与参考一致的细线图标，不依赖系统字体图标。
defineProps<{ name: string }>();
const paths: Record<string, string> = {
  archive: 'M3 4h12v7H3z M6 11v8h15v-8H6 M10 14h4 M15 4h6v7',
  file: 'M6 3h8l4 4v14H6z M14 3v5h4 M9 12h6 M9 15h6 M9 18h4',
  chart: 'M6 3h8l4 4v14H6z M14 3v5h4 M9 17v-4 M12 17v-7 M15 17v-5',
  group: 'M8 7H5V4 M16 7h3V4 M8 17H5v3 M16 17h3v3 M9 8h6v8H9z M3 11v2 M21 11v2',
  save: 'M4 3h13l3 3v15H4z M8 3v6h8V3 M8 21v-8h9v8',
  transfer: 'M13 3h5l3 3v12h-7 M18 3v5h3 M4 16h8 M8 12l4 4-4 4 M4 5h5v5H4z',
  help: 'M9 7a3 3 0 1 1 5 2c-2 1-2 2-2 4 M12 17v.2',
  refresh: 'M20 7v5h-5 M20 12a8 8 0 1 0-2 5 M20 7l-3-3',
  left: 'M20 12H4 M10 6l-6 6 6 6',
  right: 'M4 12h16 M14 6l6 6-6 6',
  plus: 'M12 4v16 M4 12h16',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 7v5l4 2',
  grid: 'M4 4h16v16H4z M4 9h16 M4 14h16 M9 4v16 M15 4v16',
  calendar: 'M4 5h16v16H4z M4 10h16 M8 3v4 M16 3v4 M8 14h1 M12 14h1 M16 14h1 M8 17h1 M12 17h1',
  list: 'M8 5h13 M8 12h13 M8 19h13 M3 4h1v2H3z M3 11h1v2H3z M3 18h1v2H3z',
  settings:
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M10 3h4l1 3 3 1 3 3v4l-3 1-1 3-3 3h-4l-1-3-3-1-3-3v-4l3-1 1-3z',
  close: 'M5 5l14 14 M19 5L5 19',
  shield: 'M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6z M8 12l3 3 5-6',
  back: 'M11 5l-7 7 7 7 M4 12h13a3 3 0 0 1 3 3v3',
  chevron: 'M6 9l6 6 6-6',
};
</script>

<template>
  <svg
    class="archive-icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="paths[name] || paths.file" />
  </svg>
</template>

<style scoped>
.archive-icon {
  display: inline-block;
  flex: 0 0 auto;
  width: 22px;
  height: 22px;
  vertical-align: middle;
}
</style>
