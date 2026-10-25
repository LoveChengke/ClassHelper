<script setup lang="ts">
import type { IslandComponentKind } from '@classhelper/shared';
defineProps<{ kind: IslandComponentKind }>();
const paths: Record<IslandComponentKind, string> = {
  clock: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 7v5l3 2',
  weather:
    'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5',
  date: 'M6 5h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2ZM8 3v4m8-4v4M4 10h16M8 14h2m4 0h2m-8 3h2',
  schedule: 'M9 5h11M9 12h11M9 19h11M4 5h1m-1 7h1m-1 7h1',
  countdown: 'M6 3h12M6 21h12M8 3v4l4 5-4 5v4m8-18v4l-4 5 4 5v4',
  text: 'M6 3h12a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Zm1 5h10M7 12h7m-7 4h10',
  separator: 'M12 4v16M5 8v8m14-8v8',
  notification: 'M9 19a3 3 0 0 0 6 0M6 10a6 6 0 0 1 12 0v4l2 3H4l2-3v-4Z',
  homework: 'M9 4H6a2 2 0 0 0-2 2v14h16V6a2 2 0 0 0-2-2h-3M9 3h6v4H9V3Zm-1 9h8m-8 4h5',
  call: 'M4 10h4l6-5v14l-6-5H4v-4Zm13-2a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14',
  group: 'M3 5h18v14H3V5Zm4 4h4v6H7V9Zm8 0h2v6h-2V9Z',
  stack: 'm12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5',
  slide: 'M6 5h12v14H6V5ZM2 8v8m20-8v8m-12 7h4',
  rolling: 'M3 8h17m-4-4 4 4-4 4M21 16H4m4-4-4 4 4 4',
};
</script>
<template>
  <svg
    viewBox="0 0 24 24"
    width="24"
    height="24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="paths[kind]" />
  </svg>
</template>
