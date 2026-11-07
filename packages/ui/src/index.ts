import type { App } from 'vue';
import ChDatePicker from './ChDatePicker.vue';
export { default as FullScreenGuide } from './FullScreenGuide.vue';
export { default as PageHeader } from './PageHeader.vue';
export { ChDatePicker };
export * from './calendar';

export function registerSharedUi(app: App): void {
  app.component('ChDatePicker', ChDatePicker);
}

declare module 'vue' {
  export interface GlobalComponents {
    ChDatePicker: typeof ChDatePicker;
  }
}
