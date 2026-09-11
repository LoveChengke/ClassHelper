<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import {
  NOTIFICATION_PRIORITIES,
  PRIORITY_LABELS,
  PRIORITY_TAG_TYPES,
  SOCKET_EVENTS,
  formatDate,
  relativeTime,
  truncate,
  type ClassDto,
  type NotificationDto,
  type NotificationPriority,
} from '@classhelper/shared';
import { classApi, notificationApi } from '@/api';
import { useRealtimeStore } from '@/stores/realtime';

const realtime = useRealtimeStore();

const loading = ref(false);
const classes = ref<ClassDto[]>([]);
const notifications = ref<NotificationDto[]>([]);
const studentCount = ref(0);
const filter = reactive({ classId: '', priority: '', keyword: '' });

async function loadClasses(): Promise<void> {
  classes.value = await classApi.list();
  if (!filter.classId && classes.value.length > 0) filter.classId = classes.value[0]?.id ?? '';
}

async function loadNotifications(): Promise<void> {
  loading.value = true;
  try {
    const params: { classId?: string; priority?: string; keyword?: string } = {};
    if (filter.classId) params.classId = filter.classId;
    if (filter.priority) params.priority = filter.priority;
    if (filter.keyword.trim()) params.keyword = filter.keyword.trim();
    notifications.value = await notificationApi.list(params);

    if (filter.classId) {
      const students = await classApi.students(filter.classId);
      studentCount.value = students.length;
    }
  } finally {
    loading.value = false;
  }
}

/* ------------------------------------------------------------ 发布 */

const formVisible = ref(false);
const formRef = ref<FormInstance>();
const form = reactive<{ classId: string; title: string; content: string; priority: NotificationPriority }>({
  classId: '',
  title: '',
  content: '',
  priority: 'NORMAL',
});

const rules: FormRules = {
  classId: [{ required: true, message: '请选择目标班级', trigger: 'change' }],
  title: [{ required: true, message: '请输入通知标题', trigger: 'blur' }],
  content: [{ required: true, message: '请输入通知内容', trigger: 'blur' }],
};

function openCreate(): void {
  form.classId = filter.classId || classes.value[0]?.id || '';
  form.title = '';
  form.content = '';
  form.priority = 'NORMAL';
  formVisible.value = true;
}

async function submitForm(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;

  const created = await notificationApi.create({
    classId: form.classId,
    title: form.title.trim(),
    content: form.content,
    priority: form.priority,
  });
  ElMessage.success(`通知已发布（${created.title}），已推送给学生客户端`);
  formVisible.value = false;
  await loadNotifications();
}

async function removeNotification(row: NotificationDto): Promise<void> {
  await ElMessageBox.confirm(`删除通知「${row.title}」？`, '确认', { type: 'warning' });
  await notificationApi.remove(row.id);
  ElMessage.success('已删除');
  await loadNotifications();
}

function readRate(row: NotificationDto): number {
  if (!studentCount.value) return 0;
  return Math.round(((row.readCount ?? 0) / studentCount.value) * 100);
}

function onNotificationEvent(): void {
  void loadNotifications();
}

onMounted(async () => {
  await loadClasses();
  await loadNotifications();
  realtime.on(SOCKET_EVENTS.notificationNew, onNotificationEvent);
});

onUnmounted(() => {
  realtime.off(SOCKET_EVENTS.notificationNew, onNotificationEvent);
});
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">通知发布</h2>
        <p class="page-subtitle">发布后按班级房间广播（notification:new），学生端 5 秒内到达</p>
      </div>
      <div class="toolbar">
        <el-select
          v-model="filter.classId"
          placeholder="选择班级"
          style="width: 170px"
          @change="loadNotifications"
        >
          <el-option v-for="item in classes" :key="item.id" :label="item.name" :value="item.id" />
        </el-select>
        <el-select
          v-model="filter.priority"
          placeholder="全部优先级"
          clearable
          style="width: 150px"
          @change="loadNotifications"
        >
          <el-option
            v-for="item in NOTIFICATION_PRIORITIES"
            :key="item"
            :label="PRIORITY_LABELS[item]"
            :value="item"
          />
        </el-select>
        <el-input
          v-model="filter.keyword"
          placeholder="搜索标题/内容"
          clearable
          style="width: 170px"
          @keyup.enter="loadNotifications"
          @clear="loadNotifications"
        />
        <el-button type="primary" :icon="'Plus'" @click="openCreate">发布通知</el-button>
      </div>
    </div>

    <el-card shadow="never">
      <el-table v-loading="loading" :data="notifications" empty-text="暂无通知">
        <el-table-column label="优先级" width="90">
          <template #default="{ row }">
            <el-tag
              :type="PRIORITY_TAG_TYPES[row.priority as NotificationPriority]"
              size="small"
              effect="light"
            >
              {{ PRIORITY_LABELS[row.priority as NotificationPriority] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="title" label="标题" min-width="200" show-overflow-tooltip />
        <el-table-column label="内容摘要" min-width="220">
          <template #default="{ row }">{{ truncate(row.content, 40) }}</template>
        </el-table-column>
        <el-table-column label="发布人" width="110">
          <template #default="{ row }">{{ row.creator?.name ?? '-' }}</template>
        </el-table-column>
        <el-table-column label="发布时间" width="170">
          <template #default="{ row }">
            <div>{{ formatDate(row.createdAt, true) }}</div>
            <div class="text-muted">{{ relativeTime(row.createdAt) }}</div>
          </template>
        </el-table-column>
        <el-table-column label="已读率" width="150">
          <template #default="{ row }">
            <el-progress :percentage="readRate(row)" :stroke-width="10" />
            <span class="text-muted">{{ row.readCount ?? 0 }}/{{ studentCount }} 人</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="90" fixed="right">
          <template #default="{ row }">
            <el-button link type="danger" @click="removeNotification(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="formVisible" title="发布通知" width="560px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="90px">
        <el-form-item label="目标班级" prop="classId">
          <el-select v-model="form.classId" style="width: 100%">
            <el-option v-for="item in classes" :key="item.id" :label="item.name" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="优先级">
          <el-radio-group v-model="form.priority">
            <el-radio-button v-for="item in NOTIFICATION_PRIORITIES" :key="item" :value="item">
              {{ PRIORITY_LABELS[item] }}
            </el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="标题" prop="title">
          <el-input v-model="form.title" maxlength="120" show-word-limit />
        </el-form-item>
        <el-form-item label="内容" prop="content">
          <el-input v-model="form.content" type="textarea" :rows="5" maxlength="5000" show-word-limit />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="formVisible = false">取消</el-button>
        <el-button type="primary" @click="submitForm">立即发布</el-button>
      </template>
    </el-dialog>
  </div>
</template>
