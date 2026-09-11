<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import {
  PRIORITY_LABELS,
  PRIORITY_TAG_TYPES,
  formatDate,
  formatDeadline,
  relativeTime,
  type DashboardSummary,
} from '@classhelper/shared';
import { dashboardApi, notificationApi } from '@/api';
import { useAuthStore } from '@/stores/auth';
import { useRealtimeStore } from '@/stores/realtime';
import { SOCKET_EVENTS, type NotificationDto } from '@classhelper/shared';

const router = useRouter();
const auth = useAuthStore();
const realtime = useRealtimeStore();

const loading = ref(false);
const summary = ref<DashboardSummary | null>(null);
const unreadCount = ref(0);

const statCards = computed(() => {
  const data = summary.value;
  return [
    { label: '管理班级', value: data?.classCount ?? 0, hint: '按权限范围统计' },
    { label: '学生人数', value: data?.studentCount ?? 0, hint: '所辖班级学生' },
    { label: '课程数量', value: data?.courseCount ?? 0, hint: '含全部课程' },
    { label: '课表条目', value: data?.scheduleCount ?? 0, hint: '全部周次' },
    {
      label: '作业总数',
      value: data?.homeworkCount ?? 0,
      hint: `待截止/待完成 ${data?.pendingHomeworkCount ?? 0}`,
    },
    { label: '通知总数', value: data?.notificationCount ?? 0, hint: `未读 ${unreadCount.value}` },
    { label: '成绩记录', value: data?.gradeCount ?? 0, hint: '已发布成绩' },
  ];
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    summary.value = await dashboardApi.summary();
    const result = await notificationApi.unreadCount();
    unreadCount.value = result.count;
  } finally {
    loading.value = false;
  }
}

function onRealtimeEvent(): void {
  void load();
}

onMounted(async () => {
  await load();
  realtime.on(SOCKET_EVENTS.notificationNew, onRealtimeEvent);
  realtime.on(SOCKET_EVENTS.homeworkNew, onRealtimeEvent);
  realtime.on(SOCKET_EVENTS.gradeUpdated, onRealtimeEvent);
});

onUnmounted(() => {
  realtime.off(SOCKET_EVENTS.notificationNew, onRealtimeEvent);
  realtime.off(SOCKET_EVENTS.homeworkNew, onRealtimeEvent);
  realtime.off(SOCKET_EVENTS.gradeUpdated, onRealtimeEvent);
});

function go(name: string): void {
  void router.push({ name });
}

function openNotification(item: NotificationDto): void {
  void router.push({ name: 'notifications', query: { highlight: item.id } });
}
</script>

<template>
  <div v-loading="loading" class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">仪表盘</h2>
        <p class="page-subtitle">
          {{ auth.displayName }}（{{ auth.roleLabel }}）· 数据范围随账号权限自动收敛
        </p>
      </div>
      <div class="toolbar">
        <el-tag :type="realtime.connected ? 'success' : 'danger'" effect="light">
          {{ realtime.connected ? '实时推送已连接' : '实时推送未连接' }}
        </el-tag>
        <el-button :icon="'Refresh'" @click="load">刷新</el-button>
      </div>
    </div>

    <div class="stat-grid">
      <div v-for="card in statCards" :key="card.label" class="stat-card">
        <div class="stat-label">{{ card.label }}</div>
        <div class="stat-value">{{ card.value }}</div>
        <div class="stat-hint">{{ card.hint }}</div>
      </div>
    </div>

    <el-row :gutter="12" class="mt-16">
      <el-col :xs="24" :md="12">
        <el-card shadow="never">
          <template #header>
            <div class="card-header">
              <span>最新通知</span>
              <el-button link type="primary" @click="go('notifications')">去发布</el-button>
            </div>
          </template>
          <el-empty v-if="(summary?.recentNotifications ?? []).length === 0" description="暂无通知" />
          <ul v-else class="list">
            <li
              v-for="item in summary?.recentNotifications"
              :key="item.id"
              class="list-item"
              @click="openNotification(item)"
            >
              <el-tag :type="PRIORITY_TAG_TYPES[item.priority]" size="small" effect="light">
                {{ PRIORITY_LABELS[item.priority] }}
              </el-tag>
              <span class="list-title">{{ item.title }}</span>
              <span class="text-muted">{{ relativeTime(item.createdAt) }}</span>
            </li>
          </ul>
        </el-card>
      </el-col>

      <el-col :xs="24" :md="12">
        <el-card shadow="never">
          <template #header>
            <div class="card-header">
              <span>即将截止的作业</span>
              <el-button link type="primary" @click="go('homeworks')">去发布</el-button>
            </div>
          </template>
          <el-empty v-if="(summary?.upcomingDeadlines ?? []).length === 0" description="暂无待截止作业" />
          <ul v-else class="list">
            <li v-for="item in summary?.upcomingDeadlines" :key="item.id" class="list-item">
              <el-tag size="small" effect="plain">{{ item.course?.name ?? '未关联课程' }}</el-tag>
              <span class="list-title">{{ item.title }}</span>
              <span class="text-muted">{{ formatDeadline(item.dueAt) }}</span>
            </li>
          </ul>
        </el-card>
      </el-col>
    </el-row>

    <el-card shadow="never" class="mt-16">
      <template #header>
        <div class="card-header">
          <span>最近作业</span>
          <el-button link type="primary" @click="go('homeworks')">查看全部</el-button>
        </div>
      </template>
      <el-table :data="summary?.recentHomeworks ?? []" size="small" empty-text="暂无作业">
        <el-table-column prop="title" label="标题" min-width="200" />
        <el-table-column label="课程" width="120">
          <template #default="{ row }">{{ row.course?.name ?? '-' }}</template>
        </el-table-column>
        <el-table-column label="完成情况" width="120">
          <template #default="{ row }">
            <span>{{ row.completedCount ?? 0 }} 人已完成</span>
          </template>
        </el-table-column>
        <el-table-column label="截止时间" width="180">
          <template #default="{ row }">{{ formatDate(row.dueAt, true) || '不限' }}</template>
        </el-table-column>
        <el-table-column label="发布时间" width="180">
          <template #default="{ row }">{{ formatDate(row.createdAt, true) }}</template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<style scoped>
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.list {
  list-style: none;
  padding: 0;
  margin: 0;
}

.list-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 4px;
  border-bottom: 1px dashed var(--ch-border);
  cursor: pointer;
}

.list-item:last-child {
  border-bottom: none;
}

.list-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
