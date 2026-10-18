<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import {
  COURSEWARE_CATEGORIES,
  SOCKET_EVENTS,
  type CoursewareDto,
  type CoursewareTransfer,
} from '@classhelper/shared';
import { api } from '../api/http.js';
import { fetchWithCache } from '../cache/index.js';
import { getCacheScope } from '../cache/scope.js';
import { useRealtimeStore } from '../stores/realtime.js';
const realtime = useRealtimeStore();
const localItems = ref<CoursewareDto[]>([]),
  library = ref<'shared' | 'local'>('shared'),
  teacher = ref(''),
  archive = ref('');
const source = computed(() => (library.value === 'local' ? localItems.value : items.value));
const teachers = computed(() => [...new Set(source.value.map((item) => item.teacher.name))]);
const archiveFolders = computed(() => [
  ...new Set(
    source.value
      .filter((item) => !teacher.value || item.teacher.name === teacher.value)
      .map((item) => item.archivePath?.split('/').slice(0, -1).join('/') || item.archiveDate),
  ),
]);
async function refreshLocal() {
  localItems.value = (await window.desktop?.listLocalCourseware()) || [];
}
// 两个来源的教师与目录不通用，切换时清空，避免看到空列表却找不到原因。
watch(library, () => {
  teacher.value = '';
  archive.value = '';
});
const items = ref<CoursewareDto[]>([]),
  loading = ref(false),
  offline = ref(false),
  error = ref('');
const query = ref(''),
  category = ref(''),
  date = ref(''),
  busy = ref<string[]>([]),
  transfer = ref<CoursewareTransfer | null>(null);
const filtered = computed(() =>
  source.value.filter(
    (item) =>
      (!query.value || `${item.name} ${item.teacher.name}`.includes(query.value)) &&
      (!category.value || item.category === category.value) &&
      (!teacher.value || item.teacher.name === teacher.value) &&
      (!archive.value ||
        (item.archivePath?.startsWith(archive.value + '/') ?? item.archiveDate === archive.value)) &&
      (!date.value || item.archiveDate === date.value),
  ),
);
let disposed = false;
async function refresh() {
  await refreshLocal();
  const scope = getCacheScope();
  loading.value = true;
  try {
    const result = await fetchWithCache<CoursewareDto[]>(
      'courseware',
      'list',
      () => api.get('/courseware'),
      [],
    );
    if (disposed || scope !== getCacheScope()) return;
    items.value = result.data;
    offline.value = result.fromCache;
    error.value = result.error ?? '';
  } finally {
    loading.value = false;
  }
}
async function download(item: CoursewareDto) {
  if (!window.desktop) return;
  busy.value.push(item.id);
  try {
    await window.desktop.downloadCourseware(item.id);
    await refreshLocal();
    ElMessage.success('课件已下载，可打开所在文件夹');
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    busy.value = busy.value.filter((id) => id !== item.id);
  }
}
async function reveal(id: string) {
  try {
    await window.desktop?.revealCourseware(id);
  } catch (e) {
    ElMessage.warning(e instanceof Error ? e.message : '请先下载课件');
  }
}
let offProgress: (() => void) | undefined;
const onRefresh = () => void refresh();
realtime.on(SOCKET_EVENTS.coursewareChanged, onRefresh);
realtime.on('__connected__', onRefresh);
let timer: ReturnType<typeof setInterval>;
onMounted(() => {
  void refresh();
  timer = setInterval(() => void refresh(), 30000);
  offProgress = window.desktop?.onCoursewareTransfer((value) => {
    transfer.value = value;
    if (value?.stage === 'completed') void refreshLocal();
  });
  void window.desktop?.getCoursewareTransfer().then((value) => {
    if (!disposed) transfer.value = value;
  });
});
onUnmounted(() => {
  disposed = true;
  clearInterval(timer);
  offProgress?.();
  realtime.off(SOCKET_EVENTS.coursewareChanged, onRefresh);
  realtime.off('__connected__', onRefresh);
});
</script>
<template>
  <div class="page courseware-page">
    <header class="page-header">
      <div>
        <h2 class="page-title">课件</h2>
        <p>查看本班可见的教学文件。老师推送的课件会自动接收并保存在本机。</p>
      </div>
      <el-button :loading="loading" @click="refresh">刷新</el-button>
    </header>
    <el-alert
      v-if="offline || error"
      :title="offline ? '当前显示离线缓存；联网后会重新校验可见范围。已下载文件可在本机文件夹查看。' : error"
      type="warning"
      :closable="false"
    />
    <el-card v-if="transfer" shadow="never">
      <strong>{{ transfer.name }}</strong>
      <p>
        {{ COURSEWARE_CATEGORIES[transfer.category] }} · {{ transfer.teacherName }} ·
        {{
          transfer.stage === 'completed' ? '接收完成' : transfer.stage === 'failed' ? '接收失败' : '正在接收'
        }}
      </p>
      <el-progress
        :percentage="transfer.progress"
        :status="
          transfer.stage === 'failed' ? 'exception' : transfer.stage === 'completed' ? 'success' : undefined
        "
      />
      <p v-if="transfer.error">{{ transfer.error }}</p>
    </el-card>
    <div class="filters">
      <el-radio-group v-model="library">
        <el-radio-button value="shared">班级共享</el-radio-button>
        <el-radio-button value="local">本机归档</el-radio-button>
      </el-radio-group>
      <el-select v-model="teacher" clearable placeholder="全部教师" @change="archive = ''">
        <el-option v-for="name in teachers" :key="name" :label="name" :value="name" />
      </el-select>
      <el-select v-model="archive" clearable filterable placeholder="年 / 月 / 日 / 时间">
        <el-option v-for="folder in archiveFolders" :key="folder" :label="folder" :value="folder" />
      </el-select>
      <el-input v-model="query" clearable placeholder="搜索课件或教师" />
      <el-select v-model="category" clearable placeholder="全部类型">
        <el-option v-for="(label, key) in COURSEWARE_CATEGORIES" :key="key" :label="label" :value="key" />
      </el-select>
      <el-date-picker v-model="date" value-format="YYYY-MM-DD" placeholder="归档日期" />
    </div>
    <el-card shadow="never" class="table-card" v-loading="loading">
      <el-table
        :data="filtered"
        :empty-text="library === 'local' ? '本机还没有已归档的课件' : '老师还没有向本班共享课件'"
      >
        <el-table-column prop="name" label="课件名称" min-width="200" show-overflow-tooltip />
        <el-table-column prop="archivePath" label="归档路径" min-width="250" show-overflow-tooltip />
        <el-table-column label="类型" min-width="110">
          <template #default="{ row }">
            {{ COURSEWARE_CATEGORIES[(row as CoursewareDto).category] }} · {{ row.extension || '无扩展名' }}
          </template>
        </el-table-column>
        <el-table-column prop="teacher.name" label="上传教师" width="110" />
        <el-table-column prop="archiveDate" label="归档日期" width="120" />
        <el-table-column label="大小" width="100">
          <template #default="{ row }">{{ (row.size / 1048576).toFixed(2) }} MB</template>
        </el-table-column>
        <el-table-column label="操作" min-width="200">
          <template #default="{ row }">
            <el-button
              v-if="library === 'shared'"
              link
              type="primary"
              :loading="busy.includes(row.id)"
              @click="download(row)"
            >
              下载
            </el-button>
            <el-button link @click="reveal(row.id)">打开文件夹</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>
<style scoped>
.courseware-page {
  display: grid;
  gap: 16px;
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
h2 {
  margin: 0;
}
p {
  color: var(--ch-text-secondary);
  line-height: 1.6;
}
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.filters > * {
  flex: 1;
  min-width: 160px;
}
</style>
