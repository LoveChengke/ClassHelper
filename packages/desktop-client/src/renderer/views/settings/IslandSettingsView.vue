<script setup lang="ts">
import { confirmAction } from '../../composables/confirm.js';
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import {
  DEFAULT_ISLAND_APPEARANCE,
  ISLAND_APPEARANCE_RANGES as RANGES,
  ISLAND_POSITION_LABELS,
  ISLAND_POSITIONS,
  ISLAND_STYLE_LABELS,
  ISLAND_STYLES,
  type IslandAppearance,
  type IslandPosition,
  type IslandStyle,
} from '@classhelper/shared';

/**
 * 灵动岛个性化（原设置页「灵动岛 · 个性化」卡整块迁移）。
 *
 * 注意：必须传**展开后的纯对象**。`island` 是 `ref`，它的 `.value` 在 Vue 里是响应式
 * Proxy，Proxy 过不了 IPC 的结构化克隆（`An object could not be cloned.`）——
 * 那正是"拖了滑块、数字在变、灵动岛却没反应"的原因。
 */
const island = ref<IslandAppearance>({ ...DEFAULT_ISLAND_APPEARANCE });
const savingIsland = ref(false);
function editLayout() {
  layoutMode.value = 'custom';
  void window.desktop?.islandEditLayout();
}
const layoutMode = ref<'fixed' | 'custom'>('fixed');
const residentEnabled = ref(false);
const pointerFadeEnabled = ref(true);
const pointerFadeReversed = ref(false);
async function changeLayout() {
  const config = await window.desktop?.getConfig();
  if (config)
    await window.desktop?.saveConfig({
      islandLayout: {
        ...config.islandLayout,
        layout: layoutMode.value,
        residentEnabled: residentEnabled.value,
      },
    });
}
async function chooseLayout(mode: 'fixed' | 'custom') {
  layoutMode.value = mode;
  residentEnabled.value = mode === 'custom';
  await changeLayout();
}
async function changePointerFade(
  key: 'pointerFadeEnabled' | 'pointerFadeReversed',
  value: boolean | string | number,
) {
  const config = await window.desktop?.getConfig();
  if (!config) return;
  const saved = await window.desktop?.saveConfig({
    islandLayout: { ...config.islandLayout, [key]: value === true },
  });
  if (saved) {
    pointerFadeEnabled.value = saved.islandLayout.pointerFadeEnabled;
    pointerFadeReversed.value = saved.islandLayout.pointerFadeReversed;
  }
}
async function loadLayout() {
  const settings = (await window.desktop?.getConfig())?.islandLayout;
  layoutMode.value = settings?.layout ?? 'fixed';
  residentEnabled.value = settings?.residentEnabled ?? false;
  pointerFadeEnabled.value = settings?.pointerFadeEnabled ?? true;
  pointerFadeReversed.value = settings?.pointerFadeReversed ?? false;
}
onMounted(async () => {
  await loadLayout();
  window.addEventListener('focus', loadLayout);
});
onUnmounted(() => window.removeEventListener('focus', loadLayout));

/**
 * 左右边距是否有效：只在停靠左 / 右时生效。
 *
 * 岛是"居中停靠"时（默认就是顶部居中），水平方向的锚点就是屏幕中线 ——
 * 这时调左右边距不会有任何变化。之前没把这点说清楚，用户会以为"调了不生效"。
 */
const marginXApplies = computed(() => !island.value.position.endsWith('center'));

const positionOptions = ISLAND_POSITIONS.map((value) => ({
  value,
  label: ISLAND_POSITION_LABELS[value],
}));

const styleOptions = ISLAND_STYLES.map((value) => ({
  value,
  label: ISLAND_STYLE_LABELS[value],
}));

/** 读取当前生效的外观（主进程为单一事实来源） */
async function loadIslandAppearance(): Promise<void> {
  if (!window.desktop?.islandGetAppearance) return;
  island.value = await window.desktop.islandGetAppearance();
}

/** 改动即生效：属性变化时先应用（实时预览），点"保存"再落盘 */
function applyIslandAppearance(patch: Partial<IslandAppearance> = {}): void {
  island.value = { ...island.value, ...patch };
  window.desktop?.islandSetAppearance({ ...island.value });
}

async function saveIslandAppearance(): Promise<void> {
  if (!window.desktop?.saveConfig) return;
  savingIsland.value = true;
  try {
    await window.desktop.saveConfig({ island: { ...island.value } });
    ElMessage.success('个性化设置已保存');
  } finally {
    savingIsland.value = false;
  }
}

async function resetIslandAppearance(): Promise<void> {
  if (!(await confirmAction('恢复灵动岛的默认外观？', '恢复默认', { type: 'warning' }))) return;
  applyIslandAppearance({ ...DEFAULT_ISLAND_APPEARANCE });
  await saveIslandAppearance();
}

/** 本地推一条测试通知，立刻确认外观效果（预览模式：直接展开、失焦不收起、30 秒后自动消失） */
function testIsland(): void {
  window.desktop?.islandPush?.({
    notification: {
      id: `appearance-test-${Date.now()}`,
      title: '灵动岛外观预览',
      content: '拖动滑块即可实时预览：高度、宽度、圆角、透明度、字号、主题色、位置与动画。',
      priority: 'NORMAL',
      createdAt: new Date().toISOString(),
      courseName: null,
      teacherName: '本地预览',
    },
    context: { inClass: false, currentPeriodEnd: null, preview: true },
  });
}

onMounted(async () => {
  await loadIslandAppearance();
});
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">灵动岛</h2>
        <p class="page-subtitle">自定义组件与 ClassIsland 提醒，共用停靠位置、动画开关与通知规则</p>
      </div>
    </div>

    <el-card shadow="never" class="layout-mode-card">
      <template #header><span>岛内布局</span></template>
      <div class="layout-choices">
        <button
          class="layout-choice"
          :class="{ active: layoutMode === 'fixed' }"
          :aria-pressed="layoutMode === 'fixed'"
          @click="chooseLayout('fixed')"
        >
          <strong>经典灵动岛</strong>
          <span>有消息时展开，保持熟悉的提醒样式</span>
        </button>
        <button
          class="layout-choice"
          :class="{ active: layoutMode === 'custom' }"
          :aria-pressed="layoutMode === 'custom'"
          @click="chooseLayout('custom')"
        >
          <strong>自定义灵动岛</strong>
          <span>ClassIsland 风格，常驻显示时钟、课程等组件</span>
        </button>
      </div>
      <div v-if="layoutMode === 'custom'" class="layout-edit-entry">
        <div>
          <strong>按你的习惯布置岛内内容</strong>
          <p>编辑常态内容与无通知展开内容；课前自动提示，通知操作与经典岛共用。</p>
        </div>
        <el-button type="primary" @click="editLayout">编辑岛内组件</el-button>
      </div>
      <div v-if="layoutMode === 'custom'" class="resident-window-options">
        <div>
          <strong>指针避让</strong>
          <p>指针移入后淡化并穿透，右侧展开入口保持可用；展开和触摸交互期间暂停避让。</p>
        </div>
        <label>
          <span>指针移入淡化</span>
          <el-switch
            :model-value="pointerFadeEnabled"
            @change="(value: boolean | string | number) => changePointerFade('pointerFadeEnabled', value)"
          />
        </label>
        <label v-if="pointerFadeEnabled">
          <span>反转指针移入淡化</span>
          <el-switch
            :model-value="pointerFadeReversed"
            @change="(value: boolean | string | number) => changePointerFade('pointerFadeReversed', value)"
          />
        </label>
      </div>
    </el-card>

    <el-card shadow="never">
      <template #header>
        <span>外观、位置与弹出</span>
      </template>
      <p class="text-muted">紧急消息立即展开；课中普通通知暂存，下课后展开。自定义岛可点击铃铛主动查看。</p>
      <p class="text-muted">
        上课前 60 秒显示准备提醒和倒计时，上下课时提示课程状态；课程时间显示在名称右侧。
      </p>
      <el-form label-width="110px" label-position="left">
        <el-form-item :label="`${layoutMode === 'custom' ? '通知高度' : '高度'} ${island.height}px`">
          <el-slider
            :model-value="island.height"
            :min="RANGES.height.min"
            :max="RANGES.height.max"
            :step="1"
            @input="(value: number) => applyIslandAppearance({ height: value })"
          />
        </el-form-item>
        <el-form-item :label="`${layoutMode === 'custom' ? '通知宽度' : '宽度'} ${island.width}px`">
          <el-slider
            :model-value="island.width"
            :min="RANGES.width.min"
            :max="RANGES.width.max"
            :step="2"
            @input="(value: number) => applyIslandAppearance({ width: value })"
          />
        </el-form-item>
        <el-form-item :label="`圆角 ${island.radius}px`">
          <el-slider
            :model-value="island.radius"
            :min="RANGES.radius.min"
            :max="RANGES.radius.max"
            :step="1"
            @input="(value: number) => applyIslandAppearance({ radius: value })"
          />
        </el-form-item>
        <el-form-item :label="`不透明度 ${Math.round(island.opacity * 100)}%`">
          <el-slider
            :model-value="island.opacity"
            :min="RANGES.opacity.min"
            :max="RANGES.opacity.max"
            :step="0.05"
            @input="(value: number) => applyIslandAppearance({ opacity: value })"
          />
        </el-form-item>
        <el-form-item :label="`字号 ${island.fontSize}px`">
          <el-slider
            :model-value="island.fontSize"
            :min="RANGES.fontSize.min"
            :max="RANGES.fontSize.max"
            :step="1"
            @input="(value: number) => applyIslandAppearance({ fontSize: value })"
          />
        </el-form-item>
        <el-form-item :label="`动画速度 ${island.speed.toFixed(1)}x`">
          <el-slider
            :model-value="island.speed"
            :min="RANGES.speed.min"
            :max="RANGES.speed.max"
            :step="0.1"
            @input="(value: number) => applyIslandAppearance({ speed: value })"
          />
        </el-form-item>
        <el-form-item label="主题色">
          <el-color-picker
            :model-value="island.accent"
            @change="(value: string | null) => applyIslandAppearance({ accent: value ?? '#0a84ff' })"
          />
          <span class="text-muted ml-8">用于高亮、按钮与进度条</span>
        </el-form-item>
        <el-form-item label="视觉风格">
          <span v-if="layoutMode === 'custom'">ClassIsland · 半透明横条</span>
          <el-select
            v-else
            :model-value="island.style"
            style="width: 180px"
            @change="(value: IslandStyle) => applyIslandAppearance({ style: value })"
          >
            <el-option
              v-for="item in styleOptions"
              :key="item.value"
              :label="item.label"
              :value="item.value"
            />
          </el-select>
          <span v-if="layoutMode === 'fixed'" class="text-muted ml-8">
            纯黑 / 毛玻璃（半透明）/ 主题色渐变
          </span>
        </el-form-item>
        <el-form-item label="显示位置">
          <el-select
            :model-value="island.position"
            style="width: 180px"
            @change="(value: IslandPosition) => applyIslandAppearance({ position: value })"
          >
            <el-option
              v-for="item in positionOptions"
              :key="item.value"
              :label="item.label"
              :value="item.value"
            />
          </el-select>
        </el-form-item>
        <el-form-item :label="`左右边距 ${island.marginX}px`">
          <el-slider
            :model-value="island.marginX"
            :min="RANGES.marginX.min"
            :max="RANGES.marginX.max"
            :step="2"
            :disabled="!marginXApplies"
            @input="(value: number) => applyIslandAppearance({ marginX: value })"
          />
          <span v-if="marginXApplies" class="text-muted ml-8">停靠左/右时距屏幕边缘的距离</span>
          <span v-else class="text-muted ml-8">
            当前是「居中」停靠，左右边距不生效 —— 把上面的「显示位置」改成左 / 右停靠即可看到效果
          </span>
        </el-form-item>
        <el-form-item :label="`上下边距 ${island.marginY}px`">
          <el-slider
            :model-value="island.marginY"
            :min="RANGES.marginY.min"
            :max="RANGES.marginY.max"
            :step="2"
            @input="(value: number) => applyIslandAppearance({ marginY: value })"
          />
          <span class="text-muted ml-8">停靠顶/底时距屏幕边缘的距离（任务栏在侧面时调大）</span>
        </el-form-item>
        <el-form-item label="跟随鼠标屏幕">
          <el-switch
            :model-value="island.followCursorDisplay"
            @change="
              (value: boolean | string | number) =>
                applyIslandAppearance({ followCursorDisplay: Boolean(value) })
            "
          />
          <span class="text-muted ml-8">多显示器教室电脑：岛出现在鼠标所在的那块屏幕</span>
        </el-form-item>
        <el-form-item label="动画">
          <el-switch
            :model-value="island.animations"
            @change="
              (value: boolean | string | number) => applyIslandAppearance({ animations: Boolean(value) })
            "
          />
          <span class="text-muted ml-8">关闭后展开/收起为瞬时生效</span>
        </el-form-item>
        <el-form-item label="始终置顶">
          <el-switch
            :model-value="island.alwaysOnTop"
            @change="
              (value: boolean | string | number) => applyIslandAppearance({ alwaysOnTop: Boolean(value) })
            "
          />
        </el-form-item>
        <el-form-item v-if="layoutMode === 'fixed'" label="空闲细缝">
          <el-switch
            :model-value="island.idleSliver"
            @change="
              (value: boolean | string | number) => applyIslandAppearance({ idleSliver: Boolean(value) })
            "
          />
          <span class="text-muted ml-8">参考 WinIsland：没有消息时保留一条细缝（关闭则完全隐藏）</span>
        </el-form-item>
      </el-form>
      <div class="toolbar">
        <el-button type="primary" :loading="savingIsland" @click="saveIslandAppearance">保存设置</el-button>
        <el-button @click="testIsland">预览效果</el-button>
        <el-button @click="resetIslandAppearance">恢复默认</el-button>
      </div>
      <el-alert
        class="mt-12"
        type="info"
        :closable="false"
        title="拖动滑块即为实时预览；保存后写入本地配置，重启客户端仍然生效"
      />
    </el-card>
  </div>
</template>

<style scoped>
.layout-mode-card {
  margin-bottom: 20px;
}
.resident-setting {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  margin-top: 20px;
  padding-top: 20px;
  border-top: 1px solid var(--el-border-color-lighter);
}
.resident-setting strong {
  font-size: 14px;
}
.resident-setting p {
  max-width: 620px;
  margin: 8px 0 0;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 1.8;
}
.resident-window-options {
  margin-top: 20px;
  padding-top: 20px;
  border-top: 1px solid var(--el-border-color-lighter);
}
.resident-window-options strong {
  font-size: 14px;
}
.resident-window-options p {
  margin: 8px 0 14px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 1.8;
}
.resident-window-options label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  min-height: 40px;
  font-size: 13px;
}
.layout-choices {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}
.layout-choice {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 20px;
  background: var(--el-fill-color-blank);
  border: 1px solid var(--el-border-color);
  border-radius: 12px;
  color: var(--el-text-color-primary);
  text-align: left;
  cursor: pointer;
  font: inherit;
}
.layout-choice strong {
  font-size: 15px;
}
.layout-choice span {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 1.7;
}
.layout-choice.active {
  border-color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
}
.layout-choice:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 3px;
}
.layout-edit-entry {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  margin-top: 20px;
  padding-top: 20px;
  border-top: 1px solid var(--el-border-color-lighter);
}
.layout-edit-entry strong {
  font-size: 14px;
}
.layout-edit-entry p {
  margin: 8px 0 0;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 1.8;
}
@media (max-width: 680px) {
  .layout-choices {
    grid-template-columns: 1fr;
  }
  .layout-edit-entry {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>

<style scoped>
.ml-8 {
  margin-left: 8px;
}
</style>
