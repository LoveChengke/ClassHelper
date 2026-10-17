<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { classGradeQueryApi } from '../../api/index.js';
import { useAuthStore } from '../../stores/auth.js';
import { DEFAULT_LESSON_REMINDERS, type LessonReminderSettings } from '@classhelper/shared';
import { ElMessage } from 'element-plus';
const auth = useAuthStore();
const lesson = ref({ ...DEFAULT_LESSON_REMINDERS });
onMounted(async () => {
  const config = await window.desktop?.getConfig();
  if (config) lesson.value = { ...config.islandLayout.lessonReminders };
});
async function saveLesson(patch: Partial<LessonReminderSettings>) {
  lesson.value = { ...lesson.value, ...patch };
  const config = await window.desktop?.getConfig();
  if (!config) return;
  try {
    await window.desktop?.saveConfig({
      islandLayout: { ...config.islandLayout, lessonReminders: { ...lesson.value } },
    });
  } catch {
    ElMessage.error('提醒设置保存失败');
  }
}
/* ------------------------------------------------------------ 班级端成绩查询状态（只读）
 *
 * 「是否允许班级端查看成绩」是**服务端口径**：管理员在 Web 端「班级管理」里开关，
 * 这台机器只负责把状态显示出来（需求：「成绩查询由服务端控制，客户端只读」）。
 * 曾经这里有个开关 —— 教室机器能自己开成绩查询，等于把"学校说不给看"变成了一台机器说了算。
 */
const gradeQueryEnabled = ref(true);

async function loadGradeQuery(): Promise<void> {
  const classId = auth.user?.classId;
  if (!classId) return;
  try {
    const result = await classGradeQueryApi.get(classId);
    gradeQueryEnabled.value = result.studentGradeQueryEnabled;
  } catch {
    // 读不到就按默认值展示（默认开启），不阻断设置页
  }
}

onMounted(loadGradeQuery);
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">提醒</h2>
        <p class="page-subtitle">通知提醒与成绩查询状态</p>
      </div>
    </div>

    <el-card shadow="never" class="lesson-channel-settings">
      <template #header>上下课提醒</template>
      <p class="text-muted">
        沿用 ClassIsland 的遮罩、课前倒计时、上下课提示及下节课预告；课中显示课程进度，临近下课显示倒数。
      </p>
      <div
        v-for="channel in [
          { key: 'prepareEnabled', title: '准备上课提醒' },
          { key: 'onClassEnabled', title: '上课提醒' },
          { key: 'endingEnabled', title: '即将下课倒数' },
          { key: 'classProgressEnabled', title: '经典岛课中常显课程进度' },
          { key: 'breakEnabled', title: '下课提醒与下节课预告' },
        ] as const"
        :key="channel.key"
        class="lesson-setting-row"
      >
        <span>{{ channel.title }}</span>
        <el-switch
          :model-value="lesson[channel.key]"
          :aria-label="channel.title"
          @change="(v: boolean | string | number) => saveLesson({ [channel.key]: v === true })"
        />
      </div>
      <div class="lesson-setting-row">
        <span>课前提前（秒）</span>
        <el-input-number
          :model-value="lesson.prepareSeconds"
          :min="5"
          :max="1800"
          :step="5"
          @change="(v: number | undefined) => saveLesson({ prepareSeconds: v ?? 60 })"
        />
      </div>
      <div class="lesson-setting-row">
        <span>下课倒数提前（秒）</span>
        <el-input-number
          :model-value="lesson.endingSeconds"
          :min="5"
          :max="600"
          :step="5"
          @change="(v: number | undefined) => saveLesson({ endingSeconds: v ?? 60 })"
        />
      </div>
    </el-card>
    <el-card shadow="never" class="mt-16">
      <template #header>通知提醒</template>
      <p class="text-muted">
        通知与叫人通过 ClassHelper 客户端和灵动岛提醒。普通通知在上课期间暂存，下课后补弹；紧急通知立即提醒。
      </p>
    </el-card>

    <!-- 成绩查询：让教室机器能按学号代学生查本人明细。
         这里**只读**（需求：「成绩查询由服务端控制，客户端只读」）——教室机器是投放终端，
         开不开成绩查询是学校口径，不该由某台机器本地改。 -->
    <el-card shadow="never" class="mt-16">
      <template #header><span>成绩查询</span></template>
      <p class="text-muted">
        打开后，可以在「成绩」页看到本班成绩与排名。学生本身没有账号、不能登录，
        查成绩就是由这台教室机器代做。关闭后本机查成绩会被服务端拒绝，教师端不受影响。
      </p>
      <p class="text-muted">本开关由管理员在服务端「班级管理」里统一设置，教室机器不提供本地开关。</p>
      <el-tag :type="gradeQueryEnabled ? 'success' : 'info'" effect="plain">
        {{ gradeQueryEnabled ? '当前：已允许查看成绩与排名' : '当前：已由管理员关闭' }}
      </el-tag>
      <div class="toolbar mt-8">
        <el-button size="small" :icon="'Refresh'" @click="loadGradeQuery">刷新状态</el-button>
      </div>
    </el-card>
  </div>
</template>

<style scoped>
.lesson-setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 12px 0;
  border-bottom: 1px solid var(--ch-border);
}
.lesson-setting-row:last-child {
  border-bottom: 0;
}
.channel-group {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  margin-top: 10px;
}

.channel-hint {
  margin-top: 10px;
}

.mb-12 {
  margin-bottom: 12px;
}
</style>
