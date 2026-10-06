<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { useOnboardingStore } from '../stores/onboarding.js';

/**
 * 初次启动引导（六步向导）。
 *
 * - 首次启动自动弹出（App.vue 按 `onboardingDone` 判定）；完成 / 跳过（右上角按钮 / Esc）
 *   都算看过，由这里写入主进程配置，之后不再自动弹出。
 * - 登录页与设置页的「使用引导」入口可随时重看（重看关闭时再写一次也无副作用）。
 * - **用 v-if 自绘遮罩而不是 el-dialog**：关闭即从 DOM 卸载。冒烟断言"引导已关闭"时
 *   不会踩 el-dialog「DOM 残留在文档里」的坑（AGENTS §7 第 22 条）。
 * - 操作按钮用 `data-action` 标识（prev/next/finish/skip），冒烟点击不依赖按钮文案。
 */
const onboarding = useOnboardingStore();

const steps = [
  {
    icon: 'School',
    title: '欢迎使用 ClassHelper',
    lines: [
      '这台电脑将以「班级」的身份使用 ClassHelper：实时接收课表、作业、通知与成绩。',
      '第一次使用，先花半分钟看看怎么开始。',
    ],
  },
  {
    icon: 'Link',
    title: '第一步 · 连接服务器',
    lines: [
      '在登录页填写老师或管理员提供的服务器地址（通常形如 http://192.168.x.x:4000）。',
      '点「测试连接」确认可达；以后也能在「设置」里随时修改。',
    ],
  },
  {
    icon: 'Key',
    title: '第二步 · 登录班级',
    lines: [
      '使用班级码 + 班级密码登录（向老师或管理员索取）。',
      '登录后这台设备就代表全班：作业完成、通知已读都会按全班记录，不需要每个学生单独登录。',
    ],
  },
  {
    icon: 'Calendar',
    title: '登录之后',
    lines: [
      '左侧菜单切换「课表 / 作业 / 通知 / 成绩」四个页面，作业支持看板全屏展示。',
      '断网时自动显示最近同步的缓存数据，联网后自动更新。',
    ],
  },
  {
    icon: 'Bell',
    title: '灵动岛提醒',
    lines: [
      '屏幕上方会有一条「灵动岛」浮窗：新通知、叫人、作业都会在那里弹出。',
      '上课时段自动隐藏、下课自动弹出；外观与位置可在「设置 → 灵动岛」调整。',
    ],
  },
  {
    icon: 'CircleCheckFilled',
    title: '准备好了',
    lines: [
      '按上面的步骤登录就可以开始使用了。',
      '侧边栏「设置」分组里有通用、外观（深色模式）、灵动岛等页面；这份引导可以在登录页或「设置 → 通用 → 使用引导」随时重看。',
    ],
  },
];

const index = ref(0);
const current = computed(() => steps[index.value] ?? steps[0]);
const isFirst = computed(() => index.value === 0);
const isLast = computed(() => index.value === steps.length - 1);

/** 每次打开都从第一步开始（重看入口也走完整流程） */
watch(
  () => onboarding.visible,
  (visible) => {
    if (visible) index.value = 0;
  },
);

function goNext(): void {
  if (isLast.value) finish();
  else index.value += 1;
}

function goPrev(): void {
  if (!isFirst.value) index.value -= 1;
}

/** 完成 / 跳过统一走这里：记「已看过」并关闭（重看时重复写一次无副作用） */
function finish(): void {
  const bridge = window.desktop;
  // 桥接不可用（浏览器调试）也要能正常关掉引导
  if (!bridge) {
    onboarding.close();
    return;
  }
  void bridge
    .saveConfig({ onboardingDone: true })
    .then(() => onboarding.close())
    .catch(() => onboarding.close());
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') finish();
}
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', onKeydown);
}
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <Transition name="onboarding-fade">
    <div
      v-if="onboarding.visible"
      class="onboarding-mask"
      role="dialog"
      aria-modal="true"
      aria-label="初次启动引导"
    >
      <div class="onboarding-card onboarding-welcome">
        <div class="onboarding-head">
          <span class="onboarding-logo">
            <el-icon :size="18"><School /></el-icon>
          </span>
          <div class="onboarding-heading">
            <h2 class="onboarding-title">ClassHelper</h2>
            <p class="onboarding-sub">初次启动引导 · 第 {{ index + 1 }} / {{ steps.length }} 步</p>
          </div>
          <el-button link class="onboarding-skip" data-action="skip" @click="finish">跳过引导</el-button>
        </div>

        <div class="onboarding-body">
          <span class="onboarding-icon">
            <el-icon :size="30"><component :is="current.icon" /></el-icon>
          </span>
          <h3 class="onboarding-step-title">{{ current.title }}</h3>
          <p v-for="(line, lineIndex) in current.lines" :key="lineIndex" class="onboarding-line">
            {{ line }}
          </p>
        </div>

        <div class="onboarding-foot">
          <div class="onboarding-dots">
            <span
              v-for="(step, dotIndex) in steps"
              :key="dotIndex"
              class="dot"
              :class="{ active: dotIndex === index }"
            />
          </div>
          <div class="onboarding-actions">
            <el-button v-if="!isFirst" data-action="prev" @click="goPrev">上一步</el-button>
            <el-button v-if="!isLast" type="primary" data-action="next" @click="goNext">
              下一步
            </el-button>
            <el-button v-else type="primary" data-action="finish" @click="finish">开始使用</el-button>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.onboarding-mask {
  position: fixed;
  inset: 0;
  z-index: 3000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(15, 30, 50, 0.55);
}

.onboarding-card {
  width: 520px;
  max-width: 92vw;
  max-height: 86vh;
  overflow-y: auto;
  background: var(--ch-layer-solid);
  border-radius: 16px;
  padding: 22px 24px 18px;
  box-shadow: 0 24px 64px rgba(15, 30, 50, 0.35);
}

.onboarding-head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.onboarding-logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 9px;
  color: #fff;
  background: linear-gradient(135deg, var(--ch-accent) 0%, #4d94d1 100%);
}

.onboarding-heading {
  flex: 1;
  min-width: 0;
}

.onboarding-title {
  margin: 0;
  font-size: 15px;
  line-height: 1.3;
}

.onboarding-sub {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--ch-text-tertiary);
}

.onboarding-body {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  padding: 18px 4px 6px;
}

.onboarding-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 58px;
  height: 58px;
  border-radius: 16px;
  margin-bottom: 14px;
  color: var(--ch-accent);
  background: var(--ch-accent-soft);
}

.onboarding-step-title {
  margin: 0 0 10px;
  font-size: 18px;
}

.onboarding-line {
  margin: 0 0 8px;
  font-size: 13px;
  line-height: 1.8;
  color: var(--ch-text-regular, #606266);
}

.onboarding-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--ch-divider);
}

.onboarding-dots {
  display: flex;
  align-items: center;
  gap: 6px;
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--ch-border-strong);
  transition: all 0.2s ease;
}

.dot.active {
  width: 20px;
  background: var(--ch-accent);
}

.onboarding-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 进出场：淡入 + 轻微上浮，跟随系统"动画"开关无强依赖 */
.onboarding-fade-enter-active,
.onboarding-fade-leave-active {
  transition: opacity 0.22s ease;
}

.onboarding-fade-enter-active .onboarding-card,
.onboarding-fade-leave-active .onboarding-card {
  transition: transform 0.22s ease;
}

.onboarding-fade-enter-from,
.onboarding-fade-leave-to {
  opacity: 0;
}

.onboarding-fade-enter-from .onboarding-card,
.onboarding-fade-leave-to .onboarding-card {
  transform: translateY(10px) scale(0.98);
}
</style>
