<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  ISLAND_COMPONENT_LABELS,
  type IslandComponentNode,
  type IslandComponentKind,
} from '@classhelper/shared';
const props = defineProps<{ node: IslandComponentNode }>();
const emit = defineEmits<{ change: []; remove: []; duplicate: []; wrap: [kind: IslandComponentKind] }>();
const node = computed(() => props.node),
  tab = ref('content');
watch(
  () => props.node.id,
  () => {
    tab.value = 'content';
  },
);
const fonts = {
  secondaryFontSize: '辅助文字',
  bodyFontSize: '正文',
  emphasizedFontSize: '强调文字',
  largeFontSize: '大号文字',
} as const;
const containers = ['group', 'stack', 'slide', 'rolling'] as const;
</script>
<template>
  <div class="component-settings">
    <h3>{{ ISLAND_COMPONENT_LABELS[node.kind] }}</h3>
    <el-tabs v-model="tab" stretch>
      <el-tab-pane label="内容" name="content">
        <el-form label-position="top">
          <template v-if="node.kind === 'clock'">
            <el-form-item label="12 小时制">
              <el-switch v-model="node.settings.hour12" @change="emit('change')" />
            </el-form-item>
            <el-form-item label="显示秒">
              <el-switch v-model="node.settings.seconds" @change="emit('change')" />
            </el-form-item>
          </template>
          <template v-else-if="node.kind === 'countdown'">
            <el-form-item label="倒计时目标">
              <el-select v-model="node.settings.target" @change="emit('change')">
                <el-option label="自动：距上课 / 下课" value="auto" />
                <el-option label="下一节课" value="next" />
                <el-option label="本节下课" value="end" />
                <el-option label="放学" value="school" />
                <el-option label="指定日期" value="date" />
              </el-select>
            </el-form-item>
            <template v-if="node.settings.target === 'date'">
              <el-form-item label="目标名称">
                <el-input v-model="node.settings.countdownTitle" :maxlength="64" @change="emit('change')" />
              </el-form-item>
              <el-form-item label="目标日期">
                <el-date-picker
                  v-model="node.settings.targetDate"
                  type="date"
                  value-format="YYYY-MM-DD"
                  placeholder="选择日期"
                  @change="emit('change')"
                />
              </el-form-item>
            </template>
          </template>
          <template v-else-if="node.kind === 'weather'">
            <el-form-item label="地点名称">
              <el-input
                v-model="node.settings.locationName"
                placeholder="例如：学校"
                :maxlength="64"
                @change="emit('change')"
              />
            </el-form-item>
            <el-form-item label="纬度">
              <el-input-number
                v-model="node.settings.latitude"
                :min="-90"
                :max="90"
                :precision="4"
                @change="emit('change')"
              />
            </el-form-item>
            <el-form-item label="经度">
              <el-input-number
                v-model="node.settings.longitude"
                :min="-180"
                :max="180"
                :precision="4"
                @change="emit('change')"
              />
            </el-form-item>
            <p class="hint">
              填写地点坐标后每 15 分钟更新天气。数据来自
              Open-Meteo，断网时显示本次运行的缓存；天气提示不作为官方预警。
            </p>
          </template>
          <template v-else-if="node.kind === 'text'">
            <el-form-item label="文字内容">
              <el-input v-model="node.settings.text" type="textarea" :rows="3" @change="emit('change')" />
            </el-form-item>
            <el-form-item label="启用模板变量">
              <el-switch v-model="node.settings.template" @change="emit('change')" />
            </el-form-item>
            <p class="hint">支持 {date} 日期、{time} 时间、{course} 当前课程。</p>
          </template>
          <template v-else-if="node.kind === 'schedule'">
            <el-form-item label="显示课程">
              <el-select v-model="node.settings.display" @change="emit('change')">
                <el-option label="当前时间点" value="current" />
                <el-option label="下一节课" value="next" />
                <el-option label="今日时间点" value="today" />
              </el-select>
            </el-form-item>
            <el-form-item v-if="node.settings.display === 'today'" label="显示时间点数">
              <el-input-number v-model="node.settings.count" :min="1" :max="30" @change="emit('change')" />
            </el-form-item>
            <el-form-item label="当前时间点显示起止时间">
              <el-switch v-model="node.settings.showPeriod" @change="emit('change')" />
            </el-form-item>
            <el-form-item label="当前课程显示进度">
              <el-switch v-model="node.settings.showProgress" @change="emit('change')" />
            </el-form-item>
            <p class="hint">
              今日时间点只展开当前项并显示时间段；课间休息与默认隐藏的时间点折叠时完全隐藏，轮到时才展开。
              下课前一分钟的倒计时由「提醒」设置里的下课提醒负责。
            </p>
          </template>
          <template v-else-if="containers.includes(node.kind as (typeof containers)[number])">
            <el-form-item label="排列方向">
              <el-select v-model="node.settings.direction" @change="emit('change')">
                <el-option label="横向" value="horizontal" />
                <el-option label="纵向" value="vertical" />
              </el-select>
            </el-form-item>
            <el-form-item label="组件间距">
              <el-input-number v-model="node.settings.gap" :min="0" :max="64" @change="emit('change')" />
            </el-form-item>
            <el-form-item v-if="node.kind === 'slide'" label="切换间隔（秒）">
              <el-input-number
                v-model="node.settings.interval"
                :min="1"
                :max="300"
                @change="emit('change')"
              />
            </el-form-item>
            <el-form-item v-if="node.kind === 'rolling'" label="滚动速度">
              <el-input-number v-model="node.settings.speed" :min="1" :max="200" @change="emit('change')" />
            </el-form-item>
          </template>
          <p v-else class="hint">此组件使用实时数据。可在外观和高级设置中调整显示。</p>
          <el-divider />
          <el-form-item label="包裹到容器">
            <el-select
              data-action="wrap"
              model-value=""
              placeholder="选择容器类型"
              @change="(kind: IslandComponentKind) => emit('wrap', kind)"
            >
              <el-option
                v-for="kind in containers"
                :key="kind"
                :label="ISLAND_COMPONENT_LABELS[kind]"
                :value="kind"
              />
            </el-select>
          </el-form-item>
          <div class="actions">
            <el-button @click="emit('duplicate')">复制组件</el-button>
            <el-button type="danger" plain @click="emit('remove')">删除</el-button>
          </div>
        </el-form>
      </el-tab-pane>
      <el-tab-pane label="外观" name="appearance">
        <el-form label-position="top">
          <el-form-item label="独立外观">
            <el-switch v-model="node.appearance.resourceOverridingEnabled" @change="emit('change')" />
          </el-form-item>
          <p class="hint">关闭时沿用灵动岛的整体外观。</p>
          <el-form-item v-for="(label, key) in fonts" :key="key" :label="`${label}字号`">
            <el-input-number
              v-model="node.appearance[key]"
              :disabled="!node.appearance.resourceOverridingEnabled"
              :min="8"
              :max="96"
              @change="emit('change')"
            />
          </el-form-item>
          <el-form-item label="自定义文字颜色">
            <el-switch
              v-model="node.appearance.customForegroundEnabled"
              :disabled="!node.appearance.resourceOverridingEnabled"
              @change="emit('change')"
            />
            <el-color-picker
              v-if="node.appearance.customForegroundEnabled"
              v-model="node.appearance.foreground"
              @change="emit('change')"
            />
          </el-form-item>
          <el-form-item label="自定义背景颜色">
            <el-switch
              v-model="node.appearance.customBackgroundEnabled"
              :disabled="!node.appearance.resourceOverridingEnabled"
              @change="emit('change')"
            />
            <el-color-picker
              v-if="node.appearance.customBackgroundEnabled"
              v-model="node.appearance.background"
              @change="emit('change')"
            />
          </el-form-item>
          <el-form-item label="自定义背景透明度">
            <el-switch
              v-model="node.appearance.customBackgroundOpacityEnabled"
              :disabled="!node.appearance.resourceOverridingEnabled"
              @change="emit('change')"
            />
            <el-input-number
              v-if="node.appearance.customBackgroundOpacityEnabled"
              v-model="node.appearance.backgroundOpacity"
              :min="0"
              :max="1"
              :step="0.05"
              @change="emit('change')"
            />
          </el-form-item>
          <el-form-item label="自定义圆角">
            <el-switch
              v-model="node.appearance.customCornerRadiusEnabled"
              :disabled="!node.appearance.resourceOverridingEnabled"
              @change="emit('change')"
            />
            <el-input-number
              v-if="node.appearance.customCornerRadiusEnabled"
              v-model="node.appearance.cornerRadius"
              :min="0"
              :max="100"
              @change="emit('change')"
            />
          </el-form-item>
          <el-form-item label="组件透明度">
            <el-slider
              v-model="node.appearance.opacity"
              :min="0"
              :max="1"
              :step="0.05"
              @change="emit('change')"
            />
          </el-form-item>
        </el-form>
      </el-tab-pane>
      <el-tab-pane label="高级" name="advanced">
        <el-form label-position="top">
          <el-form-item label="对齐方式">
            <el-select v-model="node.advanced.align" @change="emit('change')">
              <el-option
                v-for="(label, key) in { stretch: '拉伸', start: '起始', center: '居中', end: '末端' }"
                :key="key"
                :label="label"
                :value="key"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="固定宽度（px）">
            <el-input-number v-model="node.advanced.width" :min="0" :max="2000" @change="emit('change')" />
          </el-form-item>
          <el-form-item label="最大宽度（px）">
            <el-input-number v-model="node.advanced.maxWidth" :min="0" :max="2000" @change="emit('change')" />
          </el-form-item>
          <p class="hint">宽度为 0 时自适应；对齐在父容器设定宽度时生效。</p>
          <el-form-item label="隐藏条件">
            <el-checkbox-group v-model="node.advanced.hideRules" @change="emit('change')">
              <el-checkbox label="上课时" value="in-class" />
              <el-checkbox label="没有消息时" value="no-message" />
              <el-checkbox label="没有当前课程时" value="no-class" />
            </el-checkbox-group>
          </el-form-item>
        </el-form>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>
<style scoped>
h3 {
  margin: 0 0 6px;
}
.hint {
  color: var(--ch-text-secondary);
  line-height: 1.6;
  font-size: 12px;
}
.actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.el-select {
  width: 100%;
}
.el-form-item :deep(.el-form-item__content) {
  gap: 10px;
}
.el-checkbox-group {
  display: flex;
  flex-direction: column;
}
</style>
