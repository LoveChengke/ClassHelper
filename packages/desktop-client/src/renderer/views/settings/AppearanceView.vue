<script setup lang="ts">
import { ElMessage } from 'element-plus';
import { useUiStore } from '../../stores/ui.js';

/**
 * 外观：黑夜 / 白天模式。
 * 状态与持久化都在 stores/ui.ts（主进程配置 theme 字段），顶栏右上角的
 * 日月按钮与本页写同一份配置，切换立即生效（html.dark + Element Plus dark css-vars）。
 */
const ui = useUiStore();

const options = [
  { value: 'light', label: '浅色', desc: '明亮界面，适合白天与投影环境' },
  { value: 'dark', label: '深色', desc: '黑夜模式，适合晚自习与暗教室' },
] as const;

async function selectTheme(value: 'light' | 'dark'): Promise<void> {
  if (value === ui.theme) return;
  await ui.setTheme(value);
  ElMessage.success(value === 'dark' ? '已切换到深色模式' : '已切换到浅色模式');
}
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">外观</h2>
        <p class="page-subtitle">黑夜与白天模式，切换立即生效并自动保存</p>
      </div>
    </div>

    <el-card shadow="never">
      <template #header><span>界面主题</span></template>
      <div class="theme-options">
        <button
          v-for="option in options"
          :key="option.value"
          type="button"
          class="theme-option"
          :class="[`theme-${option.value}`, { active: ui.theme === option.value }]"
          :data-theme-option="option.value"
          @click="selectTheme(option.value)"
        >
          <span class="theme-preview">
            <span class="preview-side" />
            <span class="preview-body">
              <span class="preview-line" />
              <span class="preview-line short" />
            </span>
          </span>
          <span class="theme-name">
            <el-icon><Sunny v-if="option.value === 'light'" /><Moon v-else /></el-icon>
            {{ option.label }}
          </span>
          <span class="theme-desc">{{ option.desc }}</span>
        </button>
      </div>
      <el-alert
        class="mt-12"
        type="info"
        :closable="false"
        title="顶栏右上角也有主题快捷切换按钮"
        description="灵动岛始终为深色浮窗，不随主题变化；登录页与全屏作业看板为固定配色，亦不受影响。"
      />
    </el-card>
  </div>
</template>

<style scoped>
.theme-options {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.theme-option {
  width: 200px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  padding: 12px;
  border: 1px solid var(--ch-border-strong);
  border-radius: var(--ch-radius-card);
  background: var(--ch-layer);
  cursor: pointer;
  color: var(--ch-text);
  text-align: left;
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}

.theme-option:hover {
  border-color: var(--ch-accent);
}

.theme-option.active {
  border-color: var(--ch-accent);
  box-shadow: 0 0 0 1px var(--ch-accent) inset;
}

/* 主题缩略预览：两块小色板直接表现各自配色 */
.theme-preview {
  display: flex;
  width: 100%;
  height: 64px;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid var(--ch-border-strong);
}

.theme-light .theme-preview {
  background: #f3f3f3;
}

.theme-dark .theme-preview {
  background: #161719;
}

.preview-side {
  width: 28px;
  background: rgba(255, 255, 255, 0.65);
}

.theme-dark .preview-side {
  background: rgba(32, 33, 36, 0.9);
}

.preview-body {
  flex: 1;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.preview-line {
  height: 8px;
  border-radius: 4px;
  width: 80%;
  background: rgba(15, 108, 189, 0.55);
}

.preview-line.short {
  width: 50%;
  background: rgba(128, 128, 128, 0.35);
}

.theme-name {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
}

.theme-desc {
  font-size: 12px;
  color: var(--ch-text-tertiary);
}
</style>
