<script setup lang="ts">
import { computed, reactive, watch } from 'vue';
import type { AiConversationResult } from '@classhelper/shared';
const props = defineProps<{ questions: NonNullable<AiConversationResult['questions']> }>();
const visible = defineModel<boolean>({ default: false });
const emit = defineEmits<{ answer: [text: string] }>();
const answers = reactive<Record<string, string>>({});
watch(visible, (value) => {
  if (value) for (const key of Object.keys(answers)) delete answers[key];
});
const complete = computed(
  () => props.questions.length > 0 && props.questions.every((q) => answers[q.id]?.trim()),
);
function submit() {
  if (!complete.value) return;
  const text = props.questions.map((q) => `${q.text}：${answers[q.id]!.trim()}`).join('\n');
  visible.value = false;
  emit('answer', text);
}
</script>
<template>
  <el-dialog
    v-model="visible"
    title="AI 需要你补充信息"
    width="520px"
    append-to-body
    :close-on-click-modal="false"
    class="assistant-questions-dialog"
  >
    <p>回答后会继续生成操作预览；删除等操作仍需核对预览并确认执行。</p>
    <section v-for="question in questions" :key="question.id" class="question-field">
      <h3 :id="'ai-question-' + question.id">{{ question.text }}</h3>
      <div class="question-options" :aria-labelledby="'ai-question-' + question.id">
        <el-button
          v-for="option in question.options || []"
          :key="option"
          :type="answers[question.id] === option ? 'primary' : 'default'"
          :aria-pressed="answers[question.id] === option"
          @click="answers[question.id] = option"
        >
          {{ option }}
        </el-button>
      </div>
      <el-input
        v-model="answers[question.id]"
        type="textarea"
        :autosize="{ minRows: 2, maxRows: 5 }"
        maxlength="1000"
        placeholder="选择上方答案，或输入自己的回答"
        :aria-labelledby="'ai-question-' + question.id"
      />
    </section>
    <template #footer>
      <el-button @click="visible = false">稍后回答</el-button>
      <el-button type="primary" :disabled="!complete" @click="submit">发送回答</el-button>
    </template>
  </el-dialog>
</template>
<style scoped>
.question-field {
  margin: 16px 0;
}
.question-field h3 {
  font-size: 1em;
  overflow-wrap: anywhere;
  line-height: 1.6;
}
.question-options {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 12px 0;
}
.question-options :deep(.el-button) {
  height: auto;
  white-space: normal;
  line-height: 1.5;
  text-align: left;
  max-width: 100%;
  margin: 0;
}
</style>
