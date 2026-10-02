<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
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
  await ElMessageBox.confirm('恢复灵动岛的默认外观？', '恢复默认', { type: 'warning' });
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
        <p class="page-subtitle">屏幕上方的消息浮窗：外观、停靠位置与动画</p>
      </div>
    </div>

    <el-card shadow="never">
      <template #header><span>灵动岛 · 个性化</span></template>
      <el-form label-width="96px" label-position="left">
        <el-form-item :label="`高度 ${island.height}px`">
          <el-slider
            :model-value="island.height"
            :min="RANGES.height.min"
            :max="RANGES.height.max"
            :step="1"
            @input="(value: number) => applyIslandAppearance({ height: value })"
          />
        </el-form-item>
        <el-form-item :label="`宽度 ${island.width}px`">
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
          <el-select
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
          <span class="text-muted ml-8">纯黑 / 毛玻璃（半透明）/ 主题色渐变</span>
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
        <el-form-item label="空闲细缝">
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
.ml-8 {
  margin-left: 8px;
}
</style>
