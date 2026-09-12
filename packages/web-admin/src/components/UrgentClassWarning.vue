<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { formatClassPeriod, type ClassPeriod } from '@classhelper/shared';

/**
 * 上课时段发布紧急通知的全屏二次确认。
 *
 * 设计要点：
 * - 全屏遮罩 + 强警示配色，明确告知"会干扰上课"
 * - 确认按钮有 3 秒倒计时保护，倒计时结束前不可点击（避免误触连点）
 * - 倒计时以圆环进度可视化，并给出每秒反馈
 */
const props = defineProps<{
  visible: boolean;
  period: ClassPeriod | null;
  pendingTitle: string;
}>();

const emit = defineEmits<{
  (event: 'cancel'): void;
  (event: 'confirm'): void;
}>();

const COUNTDOWN_SECONDS = 3;

const remaining = ref(COUNTDOWN_SECONDS);
let timer: ReturnType<typeof setInterval> | null = null;

const periodText = computed(() => formatClassPeriod(props.period));
const canConfirm = computed(() => remaining.value <= 0);
const progress = computed(() => ((COUNTDOWN_SECONDS - remaining.value) / COUNTDOWN_SECONDS) * 100);

function stopTimer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function startCountdown(): void {
  stopTimer();
  remaining.value = COUNTDOWN_SECONDS;
  timer = setInterval(() => {
    remaining.value -= 1;
    if (remaining.value <= 0) {
      remaining.value = 0;
      stopTimer();
    }
  }, 1000);
}

watch(
  () => props.visible,
  (visible) => {
    if (visible) startCountdown();
    else stopTimer();
  },
);

onUnmounted(stopTimer);

function handleCancel(): void {
  stopTimer();
  emit('cancel');
}

function handleConfirm(): void {
  if (!canConfirm.value) return;
  stopTimer();
  emit('confirm');
}
</script>

<template>
  <Teleport to="body">
    <Transition name="urgent-fade">
      <div v-if="visible" class="urgent-mask" role="alertdialog" aria-modal="true">
        <div class="urgent-card">
          <div class="urgent-icon">
            <el-icon :size="34"><WarningFilled /></el-icon>
          </div>

          <h2 class="urgent-title">现在为上课时间段</h2>
          <p class="urgent-subtitle">
            如果发布
            <strong>紧急</strong>
            通知，会干扰正在进行的课堂，请再次确认。
          </p>

          <div v-if="period" class="urgent-period">
            <span class="period-label">正在上课</span>
            <span class="period-value">{{ periodText }}</span>
          </div>

          <div class="urgent-preview">
            <span class="preview-label">即将发布</span>
            <span class="preview-title">{{ pendingTitle || '（无标题）' }}</span>
          </div>

          <div class="urgent-actions">
            <el-button size="large" @click="handleCancel">取消发布</el-button>

            <el-button size="large" type="danger" :disabled="!canConfirm" @click="handleConfirm">
              <template v-if="canConfirm">确认发布紧急通知</template>
              <template v-else>请等待 {{ remaining }} 秒…</template>
            </el-button>
          </div>

          <div class="urgent-progress">
            <div v-if="!canConfirm" class="progress-ring">
              <el-progress
                type="circle"
                :percentage="progress"
                :width="46"
                :stroke-width="4"
                :show-text="false"
                color="#f56c6c"
              />
              <span class="ring-text">{{ remaining }}</span>
            </div>
            <span class="progress-hint">
              {{
                canConfirm
                  ? '倒计时结束，请谨慎确认是否真的需要立即打扰课堂'
                  : '正在为你预留 3 秒冷静时间，避免误触打扰课堂'
              }}
            </span>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.urgent-mask {
  position: fixed;
  inset: 0;
  z-index: 3000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(20, 12, 12, 0.62);
  backdrop-filter: blur(6px);
}

.urgent-card {
  width: 520px;
  max-width: calc(100vw - 48px);
  padding: 28px 30px 22px;
  border-radius: 16px;
  background: #fff;
  border-top: 4px solid #f56c6c;
  box-shadow: 0 24px 60px rgba(120, 20, 20, 0.35);
  text-align: center;
}

.urgent-icon {
  width: 64px;
  height: 64px;
  margin: 0 auto 12px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #f56c6c;
  background: #fef0f0;
  animation: urgent-pulse 1.4s ease-in-out infinite;
}

@keyframes urgent-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(245, 108, 108, 0.45);
    transform: scale(1);
  }
  50% {
    box-shadow: 0 0 0 14px rgba(245, 108, 108, 0);
    transform: scale(1.04);
  }
}

.urgent-title {
  margin: 0 0 8px;
  font-size: 22px;
  color: #303133;
}

.urgent-subtitle {
  margin: 0 0 18px;
  font-size: 14px;
  line-height: 1.7;
  color: #606266;
}

.urgent-subtitle strong {
  color: #f56c6c;
}

.urgent-period,
.urgent-preview {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-radius: 10px;
  margin-bottom: 10px;
  text-align: left;
  font-size: 13px;
}

.urgent-period {
  background: #fef0f0;
}

.urgent-preview {
  background: #f5f7fa;
}

.period-label,
.preview-label {
  flex: 0 0 64px;
  color: #909399;
}

.period-value {
  color: #f56c6c;
  font-weight: 600;
}

.preview-title {
  color: #303133;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.urgent-actions {
  display: flex;
  gap: 12px;
  justify-content: center;
  margin: 18px 0 12px;
}

.urgent-progress {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  min-height: 52px;
}

.progress-ring {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}

.ring-text {
  position: absolute;
  font-size: 15px;
  font-weight: 700;
  color: #f56c6c;
}

.progress-hint {
  font-size: 12px;
  color: #909399;
}

.urgent-fade-enter-active,
.urgent-fade-leave-active {
  transition: opacity 0.22s ease;
}

.urgent-fade-enter-active .urgent-card,
.urgent-fade-leave-active .urgent-card {
  transition: transform 0.28s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.urgent-fade-enter-from,
.urgent-fade-leave-to {
  opacity: 0;
}

.urgent-fade-enter-from .urgent-card,
.urgent-fade-leave-to .urgent-card {
  transform: scale(0.92) translateY(10px);
}
</style>
