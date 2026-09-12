<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { SOCKET_EVENTS, formatDate, formatDeadline, isOverdue, type HomeworkDto } from '@classhelper/shared';
import { homeworkApi } from '../api/index.js';
import { fetchWithCache } from '../cache/index.js';
import { useAppStore } from '../stores/app.js';
import { useAuthStore } from '../stores/auth.js';
import { useRealtimeStore } from '../stores/realtime.js';

const appStore = useAppStore();
const auth = useAuthStore();
const realtime = useRealtimeStore();

const loading = ref(false);
const homeworks = ref<HomeworkDto[]>([]);
const filter = ref<'all' | 'pending' | 'done'>('all');
const fromCache = ref(false);
const updatedAt = ref<number | null>(null);
const detailVisible = ref(false);
const current = ref<HomeworkDto | null>(null);
const submitting = ref(false);

const filtered = computed(() => {
  if (filter.value === 'pending') return homeworks.value.filter((item) => item.completed !== true);
  if (filter.value === 'done') return homeworks.value.filter((item) => item.completed === true);
  return homeworks.value;
});

const pendingCount = computed(() => homeworks.value.filter((item) => item.completed !== true).length);
const doneCount = computed(() => homeworks.value.filter((item) => item.completed === true).length);

async function loadHomework(): Promise<void> {
  loading.value = true;
  try {
    const classId = auth.classId ?? undefined;
    const result = await fetchWithCache<HomeworkDto[]>(
      'homeworks',
      'self',
      () => homeworkApi.list(classId ? { classId } : undefined),
      [],
    );
    homeworks.value = result.data;
    fromCache.value = result.fromCache;
    updatedAt.value = result.updatedAt;
    if (!result.fromCache) appStore.markSynced();
    if (current.value) {
      current.value = homeworks.value.find((item) => item.id === current.value?.id) ?? current.value;
    }
  } finally {
    loading.value = false;
  }
}

function openDetail(item: HomeworkDto): void {
  current.value = item;
  detailVisible.value = true;
}

async function toggleComplete(item: HomeworkDto | null): Promise<void> {
  if (!item) return;
  if (appStore.offline) {
    ElMessage.warning('离线状态下无法提交，请恢复网络后重试');
    return;
  }
  submitting.value = true;
  try {
    const next = item.completed !== true;
    await homeworkApi.updateStatus(item.id, next);
    item.completed = next;
    if (item.homeworkStatus) item.homeworkStatus.completed = next;
    else
      item.homeworkStatus = {
        id: `local-${item.id}`,
        homeworkId: item.id,
        userId: auth.user?.id ?? '',
        completed: next,
        updatedAt: new Date().toISOString(),
      };
    ElMessage.success(
      auth.isClassSession
        ? next
          ? '已按全班标记为完成'
          : '已取消全班的完成标记'
        : next
          ? '已标记为完成'
          : '已取消完成标记',
    );
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '提交失败');
  } finally {
    submitting.value = false;
  }
}

function onHomeworkEvent(): void {
  void loadHomework();
}

/** 附件链接交给系统浏览器打开（模板里无法直接访问 window） */
function openAttachment(url: string | null | undefined): void {
  if (!url) return;
  if (window.desktop) void window.desktop.openExternal(url);
  else window.open(url, '_blank');
}

function onRecovered(): void {
  void loadHomework();
}

onMounted(async () => {
  await loadHomework();
  realtime.on(SOCKET_EVENTS.homeworkNew, onHomeworkEvent);
  realtime.on(SOCKET_EVENTS.homeworkUpdated, onHomeworkEvent);
  appStore.onServerRecovered(onRecovered);
});

onUnmounted(() => {
  realtime.off(SOCKET_EVENTS.homeworkNew, onHomeworkEvent);
  realtime.off(SOCKET_EVENTS.homeworkUpdated, onHomeworkEvent);
  appStore.offServerRecovered(onRecovered);
});
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">我的作业</h2>
        <p class="page-subtitle">
          共 {{ homeworks.length }} 份 · 待完成 {{ pendingCount }} · 已完成 {{ doneCount }}
          <el-tag v-if="fromCache" size="small" type="warning" effect="plain">离线缓存</el-tag>
        </p>
      </div>
      <div class="toolbar">
        <el-radio-group v-model="filter">
          <el-radio-button value="all">全部</el-radio-button>
          <el-radio-button value="pending">未完成</el-radio-button>
          <el-radio-button value="done">已完成</el-radio-button>
        </el-radio-group>
        <el-button :icon="'Refresh'" @click="loadHomework">刷新</el-button>
      </div>
    </div>

    <el-card v-loading="loading" shadow="never">
      <el-empty v-if="filtered.length === 0" description="没有符合条件的作业" />
      <el-table v-else :data="filtered" @row-click="openDetail">
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag
              :type="row.completed ? 'success' : isOverdue(row.dueAt) ? 'danger' : 'info'"
              size="small"
              effect="light"
            >
              {{ row.completed ? '已完成' : isOverdue(row.dueAt) ? '已逾期' : '待完成' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="title" label="作业标题" min-width="220" show-overflow-tooltip />
        <el-table-column label="课程" width="110">
          <template #default="{ row }">{{ row.course?.name ?? '-' }}</template>
        </el-table-column>
        <el-table-column label="截止时间" width="180">
          <template #default="{ row }">{{ formatDate(row.dueAt, true) || '不限' }}</template>
        </el-table-column>
        <el-table-column label="剩余" width="120">
          <template #default="{ row }">
            <span :class="{ 'text-danger': isOverdue(row.dueAt) && !row.completed }">
              {{ row.completed ? '—' : formatDeadline(row.dueAt) }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="130" fixed="right">
          <template #default="{ row }">
            <el-button
              link
              :type="row.completed ? 'warning' : 'primary'"
              :loading="submitting"
              @click.stop="toggleComplete(row)"
            >
              {{
                row.completed
                  ? auth.isClassSession
                    ? '取消全班完成'
                    : '取消完成'
                  : auth.isClassSession
                    ? '全班标记完成'
                    : '标记完成'
              }}
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-drawer v-model="detailVisible" size="46%" :title="current?.title ?? '作业详情'">
      <template v-if="current">
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="课程">{{ current.course?.name ?? '-' }}</el-descriptions-item>
          <el-descriptions-item label="发布人">{{ current.creator?.name ?? '-' }}</el-descriptions-item>
          <el-descriptions-item label="截止时间">
            {{ formatDate(current.dueAt, true) || '不限' }}
          </el-descriptions-item>
          <el-descriptions-item label="发布时间">
            {{ formatDate(current.createdAt, true) }}
          </el-descriptions-item>
          <el-descriptions-item label="我的状态" :span="2">
            <el-tag :type="current.completed ? 'success' : 'info'" size="small">
              {{ current.completed ? '已完成' : '未完成' }}
            </el-tag>
          </el-descriptions-item>
        </el-descriptions>

        <div class="mt-16">
          <h4>作业要求</h4>
          <p class="content-block">{{ current.content }}</p>
        </div>

        <div v-if="current.attachmentUrl" class="mt-12">
          <el-button link type="primary" @click="openAttachment(current.attachmentUrl)">
            打开附件链接
          </el-button>
        </div>

        <div class="mt-16">
          <el-button
            type="primary"
            :loading="submitting"
            :disabled="appStore.offline"
            @click="toggleComplete(current)"
          >
            {{
              current.completed ? '取消完成标记' : auth.isClassSession ? '全班标记为已完成' : '标记为已完成'
            }}
          </el-button>
          <span v-if="appStore.offline" class="text-muted" style="margin-left: 10px">离线状态下不可提交</span>
        </div>
      </template>
    </el-drawer>
  </div>
</template>

<style scoped>
.text-danger {
  color: #f56c6c;
}

.content-block {
  white-space: pre-wrap;
  line-height: 1.75;
  background: #fafafa;
  border-radius: 8px;
  padding: 12px;
  margin: 0;
}
</style>
