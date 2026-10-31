<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import {
  PRIORITY_LABELS,
  PRIORITY_TAG_TYPES,
  formatDate,
  relativeTime,
  type DashboardSummary,
} from '@classhelper/shared';
import { dashboardApi, notificationApi } from '@/api';
import StatCard from '@/components/StatCard.vue';
import { useStaggerIn } from '@/composables/motion';
import { useAuthStore } from '@/stores/auth';
import { useRealtimeStore } from '@/stores/realtime';
import { SOCKET_EVENTS, type NotificationDto } from '@classhelper/shared';

const router = useRouter();
const auth = useAuthStore();
const realtime = useRealtimeStore();

const loading = ref(false);
const summary = ref<DashboardSummary | null>(null);
const unreadCount = ref(0);
const todayLabel = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  month: 'long',
  day: 'numeric',
  weekday: 'long',
}).format(new Date());
const quickEntries = computed(() =>
  [
    {
      path: '/plan-editor',
      title: '编排课表',
      hint: '时间表与教学安排',
      icon: 'Calendar',
      enabled: auth.can('schedule:read'),
    },
    {
      path: '/homeworks',
      title: '发布作业',
      hint: '布置并追踪完成情况',
      icon: 'Notebook',
      enabled: auth.can('homework:read'),
    },
    {
      path: '/notifications',
      title: '通知与叫人',
      hint: '实时送达教室',
      icon: 'Bell',
      enabled: auth.can('notification:read'),
    },
    {
      path: '/clients',
      title: '客户端',
      hint: '设备状态与维护',
      icon: 'Monitor',
      enabled: auth.can('client:read'),
    },
  ].filter((entry) => entry.enabled),
);

const statCards = computed(() => {
  const data = summary.value;
  return [
    { section: 'classes', label: '管理班级', value: data?.classCount ?? 0, hint: '按权限范围统计' },
    { section: 'students', label: '学生人数', value: data?.studentCount ?? 0, hint: '所辖班级学生' },
    { section: 'courses', label: '课程数量', value: data?.courseCount ?? 0, hint: '含全部课程' },
    { section: 'schedules', label: '课表条目', value: data?.scheduleCount ?? 0, hint: '全部周次' },
    {
      section: 'homeworks',
      label: '作业总数',
      value: data?.homeworkCount ?? 0,
      hint: `未完成/待完成 ${data?.pendingHomeworkCount ?? 0}`,
    },
    {
      section: 'notifications',
      label: '通知总数',
      value: data?.notificationCount ?? 0,
      hint: `未读 ${unreadCount.value}`,
    },
    { section: 'grades', label: '成绩记录', value: data?.gradeCount ?? 0, hint: '已发布成绩' },
  ].filter((card) => data?.sections[card.section as keyof DashboardSummary['sections']]);
});

/**
 * 统计卡片的错峰入场（beUI 的 stagger reveal）：按索引下发 `--ch-reveal-delay`，
 * 让七张卡片依次浮现而不是"啪"地一起出现。延迟在 `.ch-reveal` 里生效。
 */
const revealStyle = useStaggerIn();

async function load(): Promise<void> {
  loading.value = true;
  try {
    summary.value = await dashboardApi.summary();
    const result = auth.can('notification:read') ? await notificationApi.unreadCount() : { count: 0 };
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

    <section class="dashboard-welcome">
      <div>
        <span class="welcome-eyebrow">{{ todayLabel }}</span>
        <h3>{{ auth.displayName }}，欢迎回来</h3>
        <p>教学安排、班级动态与设备运行，在这里集中处理。</p>
      </div>
      <div class="welcome-symbol" aria-hidden="true">
        <el-icon><School /></el-icon>
      </div>
    </section>
    <div class="dashboard-shortcuts" aria-label="常用功能">
      <button v-for="entry in quickEntries" :key="entry.path" @click="router.push(entry.path)">
        <el-icon><component :is="entry.icon" /></el-icon>
        <span>
          <strong>{{ entry.title }}</strong>
          <small>{{ entry.hint }}</small>
        </span>
        <el-icon><Right /></el-icon>
      </button>
    </div>
    <div class="stat-grid">
      <StatCard
        v-for="(card, index) in statCards"
        :key="card.label"
        v-bind="card"
        class="ch-reveal"
        :style="revealStyle(index)"
      />
    </div>

    <el-row :gutter="12" class="mt-16">
      <el-col :xs="24" :md="24">
        <el-card v-if="summary?.sections.notifications" shadow="never">
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
    </el-row>

    <el-card v-if="summary?.sections.homeworks" shadow="never" class="mt-16 table-card">
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
        <el-table-column label="发布时间" width="180">
          <template #default="{ row }">{{ formatDate(row.createdAt, true) }}</template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<style scoped>
.dashboard-welcome {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 26px 30px;
  border: 1px solid var(--el-color-primary-light-8);
  border-radius: 14px;
  margin-bottom: 16px;
  background: linear-gradient(110deg, var(--el-color-primary-light-9), var(--ch-surface));
}
.welcome-eyebrow {
  color: var(--ch-text-muted);
  font-size: 12px;
}
.dashboard-welcome h3 {
  margin: 10px 0;
  color: var(--ch-text);
  font-size: 24px;
  font-weight: 600;
}
.dashboard-welcome p {
  margin: 0;
  color: var(--ch-text-secondary);
}
.welcome-symbol {
  display: grid;
  place-items: center;
  width: 84px;
  height: 84px;
  border-radius: 24px;
  background: var(--el-color-primary-light-8);
  color: var(--el-color-primary);
  font-size: 44px;
  transform: rotate(-8deg);
}
.dashboard-shortcuts {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
  margin-bottom: 20px;
}
.dashboard-shortcuts button {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 18px;
  min-width: 0;
  border: 1px solid var(--ch-border);
  border-radius: 12px;
  background: var(--ch-surface);
  color: var(--el-color-primary);
  cursor: pointer;
  text-align: left;
  font: inherit;
}
.dashboard-shortcuts button:hover {
  border-color: var(--el-color-primary-light-5);
  background: var(--el-color-primary-light-9);
}
.dashboard-shortcuts button > .el-icon:first-child {
  flex-shrink: 0;
  width: 38px;
  height: 38px;
  border-radius: 10px;
  background: var(--el-color-primary-light-9);
  font-size: 22px;
}
.dashboard-shortcuts button > .el-icon:last-child {
  margin-left: auto;
}
.dashboard-shortcuts span {
  min-width: 0;
}
.dashboard-shortcuts strong {
  display: block;
  color: var(--ch-text);
  font-weight: 500;
  white-space: nowrap;
}
.dashboard-shortcuts small {
  display: block;
  font-size: 11px;
  color: var(--ch-text-muted);
  margin-top: 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
@media (max-width: 1200px) {
  .dashboard-shortcuts {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 600px) {
  .dashboard-welcome {
    padding: 20px;
  }
  .dashboard-welcome h3 {
    font-size: 20px;
  }
  .welcome-symbol {
    display: none;
  }
  .dashboard-shortcuts button {
    padding: 12px;
  }
}
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
