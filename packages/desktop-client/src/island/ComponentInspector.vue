<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  ISLAND_COMPONENT_LABELS,
  type IslandComponentKind,
  type IslandComponentNode,
} from '@classhelper/shared';
const props = defineProps<{ node: IslandComponentNode }>();
const node = computed(() => props.node);
const emit = defineEmits<{
  change: [];
  remove: [];
  duplicate: [];
  wrap: [kind: IslandComponentKind];
}>();
const tab = ref('content');
watch(
  () => props.node.id,
  () => (tab.value = 'content'),
);
const fonts = {
  secondaryFontSize: '辅助文字',
  bodyFontSize: '正文',
  emphasizedFontSize: '强调文字',
  largeFontSize: '大号文字',
} as const;
</script>

<template>
  <div class="inspector-heading">
    <span class="eyebrow">组件设置</span>
    <h2>{{ ISLAND_COMPONENT_LABELS[node.kind] }}</h2>
    <p>只影响当前选中的组件</p>
  </div>
  <nav class="panel-tabs" aria-label="组件设置分类">
    <button
      v-for="item in [
        ['content', '内容'],
        ['appearance', '外观'],
        ['advanced', '高级'],
      ]"
      :key="item[0]"
      :class="{ active: tab === item[0] }"
      @click="tab = item[0]!"
    >
      {{ item[1] }}
    </button>
  </nav>
  <div class="inspector-body" @change="emit('change')">
    <template v-if="tab === 'content'">
      <section class="setting-section">
        <h3>显示内容</h3>
        <template v-if="node.kind === 'clock'">
          <label class="toggle-field">
            <span>12 小时制</span>
            <input type="checkbox" v-model="node.settings.hour12" />
          </label>
          <label class="toggle-field">
            <span>显示秒</span>
            <input type="checkbox" v-model="node.settings.seconds" />
          </label>
        </template>
        <label v-else-if="node.kind === 'countdown'" class="field">
          倒计时目标
          <select v-model="node.settings.target">
            <option value="next">下一节课</option>
            <option value="school">放学</option>
          </select>
        </label>
        <template v-else-if="node.kind === 'text'">
          <label class="field">
            文字内容
            <textarea rows="4" v-model="node.settings.text" />
          </label>
          <label class="toggle-field">
            <span>使用模板</span>
            <input type="checkbox" v-model="node.settings.template" />
          </label>
          <p class="field-hint">可用变量：{date} 日期、{time} 时间、{course} 当前课程。</p>
        </template>
        <template v-else-if="node.kind === 'schedule'">
          <label class="field">
            显示方式
            <select v-model="node.settings.display">
              <option value="current">当前课程</option>
              <option value="next">下一节课</option>
              <option value="today">今日课表</option>
            </select>
          </label>
          <label v-if="node.settings.display === 'today'" class="field inline-field">
            显示节数
            <input type="number" min="1" max="30" v-model.number="node.settings.count" />
          </label>
          <label class="toggle-field">
            <span>显示课程时间</span>
            <input type="checkbox" v-model="node.settings.showPeriod" />
          </label>
        </template>
        <template v-else-if="['group', 'stack', 'slide', 'rolling'].includes(node.kind)">
          <label class="field">
            排列方向
            <select v-model="node.settings.direction">
              <option value="horizontal">横向</option>
              <option value="vertical">纵向</option>
            </select>
          </label>
          <label class="field inline-field">
            组件间距
            <input type="number" min="0" max="80" v-model.number="node.settings.gap" />
          </label>
          <label v-if="node.kind === 'slide'" class="field inline-field">
            切换间隔（秒）
            <input type="number" min="1" max="300" v-model.number="node.settings.interval" />
          </label>
          <label v-if="node.kind === 'rolling'" class="field inline-field">
            滚动速度
            <input type="number" min="1" max="200" v-model.number="node.settings.speed" />
          </label>
          <p class="field-hint">将组件拖到此容器内，即可一起排列。</p>
        </template>
        <p v-else class="field-hint">
          {{
            ['notification', 'homework', 'call'].includes(node.kind)
              ? '收到消息后在岛内显示，沿用原有的展开、已读和关闭操作。没有消息时不占空间。'
              : '此组件无需额外内容设置，可在「外观」中调整显示。'
          }}
        </p>
      </section>
      <section class="setting-section">
        <h3>组件操作</h3>
        <button class="wide-button" @click="emit('duplicate')">创建副本</button>
        <label class="field">
          包裹到新容器
          <select
            data-action="wrap"
            :value="''"
            @change="emit('wrap', ($event.target as HTMLSelectElement).value as IslandComponentKind)"
          >
            <option value="" disabled>选择容器类型</option>
            <option v-for="kind in ['slide', 'rolling', 'group', 'stack'] as const" :key="kind" :value="kind">
              {{ ISLAND_COMPONENT_LABELS[kind] }}
            </option>
          </select>
        </label>
        <button class="wide-button danger-button" @click="emit('remove')">删除组件</button>
      </section>
    </template>
    <template v-else-if="tab === 'appearance'">
      <section class="setting-section">
        <label class="toggle-field">
          <span>独立外观</span>
          <input type="checkbox" v-model="node.appearance.resourceOverridingEnabled" />
        </label>
        <p class="field-hint">关闭时使用灵动岛的整体外观。</p>
      </section>
      <fieldset :disabled="!node.appearance.resourceOverridingEnabled">
        <section class="setting-section">
          <h3>字体大小</h3>
          <label v-for="(label, key) in fonts" :key="key" class="field inline-field">
            {{ label }}
            <input type="number" min="8" max="96" v-model.number="node.appearance[key]" />
          </label>
        </section>
        <section class="setting-section">
          <h3>颜色与形状</h3>
          <label class="toggle-field">
            <span>自定义文字颜色</span>
            <input type="checkbox" v-model="node.appearance.customForegroundEnabled" />
          </label>
          <label v-if="node.appearance.customForegroundEnabled" class="field inline-field">
            文字颜色
            <input type="color" v-model="node.appearance.foreground" />
          </label>
          <label class="toggle-field">
            <span>自定义背景颜色</span>
            <input type="checkbox" v-model="node.appearance.customBackgroundEnabled" />
          </label>
          <label v-if="node.appearance.customBackgroundEnabled" class="field inline-field">
            背景颜色
            <input type="color" v-model="node.appearance.background" />
          </label>
          <label class="toggle-field">
            <span>自定义背景透明度</span>
            <input type="checkbox" v-model="node.appearance.customBackgroundOpacityEnabled" />
          </label>
          <label v-if="node.appearance.customBackgroundOpacityEnabled" class="field inline-field">
            背景透明度
            <input
              type="number"
              min="0"
              max="1"
              step="0.05"
              v-model.number="node.appearance.backgroundOpacity"
            />
          </label>
          <label class="toggle-field">
            <span>自定义圆角</span>
            <input type="checkbox" v-model="node.appearance.customCornerRadiusEnabled" />
          </label>
          <label v-if="node.appearance.customCornerRadiusEnabled" class="field inline-field">
            圆角
            <input type="number" min="0" max="100" v-model.number="node.appearance.cornerRadius" />
          </label>
        </section>
      </fieldset>
      <section class="setting-section">
        <label class="field inline-field">
          组件透明度
          <input type="number" min="0" max="1" step="0.05" v-model.number="node.appearance.opacity" />
        </label>
      </section>
    </template>
    <template v-else>
      <section class="setting-section">
        <h3>尺寸与对齐</h3>
        <label class="field">
          对齐方式
          <select v-model="node.advanced.align">
            <option value="stretch">拉伸</option>
            <option value="start">起始</option>
            <option value="center">居中</option>
            <option value="end">末端</option>
          </select>
        </label>
        <p class="field-hint">父容器设有宽度时生效。</p>
        <label class="field inline-field">
          固定宽度
          <input type="number" min="0" max="2000" v-model.number="node.advanced.width" />
        </label>
        <label class="field inline-field">
          最大宽度
          <input type="number" min="0" max="2000" v-model.number="node.advanced.maxWidth" />
        </label>
        <p class="field-hint">单位为像素，0 表示自适应；超过最大宽度的内容从右侧截断。</p>
      </section>
      <section class="setting-section">
        <h3>隐藏条件</h3>
        <p class="field-hint">任一条件满足时隐藏，且不占用空间。</p>
        <label
          v-for="(label, rule) in {
            'in-class': '上课时',
            'no-message': '没有消息时',
            'no-class': '没有当前课程时',
          }"
          :key="rule"
          class="toggle-field"
        >
          <span>{{ label }}</span>
          <input type="checkbox" v-model="node.advanced.hideRules" :value="rule" />
        </label>
      </section>
    </template>
  </div>
</template>
