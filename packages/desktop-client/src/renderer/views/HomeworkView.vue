<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { SOCKET_EVENTS, formatDate, type HomeworkDto, type HomeworkSubmissionDto } from '@classhelper/shared';
import { homeworkApi } from '../api/index.js';
import { fetchWithCache } from '../cache/index.js';
import { useAppStore } from '../stores/app.js';
import { useAuthStore } from '../stores/auth.js';
import { useRealtimeStore } from '../stores/realtime.js';

const appStore = useAppStore();
const auth = useAuthStore();
const realtime = useRealtimeStore();

/** 看板/列表模式与看板外观（持久化到客户端配置，重启仍生效） */
const DEFAULT_BOARD = { mode: 'board' as 'board' | 'list', showTime: false, fontSize: 15 };

const loading = ref(false);
const homeworks = ref<HomeworkDto[]>([]);
const filter = ref<'all' | 'pending' | 'done'>('all');
const fromCache = ref(false);
const updatedAt = ref<number | null>(null);
const detailVisible = ref(false);
const current = ref<HomeworkDto | null>(null);
const submitting = ref(false);

const viewMode = ref<'board' | 'list'>(DEFAULT_BOARD.mode);
const boardShowTime = ref(DEFAULT_BOARD.showTime);
const boardFontSize = ref(DEFAULT_BOARD.fontSize);
const savingBoard = ref(false);

/** 全屏放大的科目（null = 未打开） */
const fullscreenCourse = ref<string | null>(null);
const fullscreenBoard = ref(false);

const filtered = computed(() => {
  if (filter.value === 'pending') return homeworks.value.filter((item) => item.completed !== true);
  if (filter.value === 'done') return homeworks.value.filter((item) => item.completed === true);
  return homeworks.value;
});

const pendingCount = computed(() => homeworks.value.filter((item) => item.completed !== true).length);
const doneCount = computed(() => homeworks.value.filter((item) => item.completed === true).length);

/**
 * 看板分组：按科目聚合成卡片（未关联课程的归到「其他」），
 * 科目内部按发布时间倒序，卡片顺序按学科常见顺序排列。
 */
const COURSE_ORDER = [
  '语文',
  '数学',
  '英语',
  '物理',
  '化学',
  '生物',
  '政治',
  '历史',
  '地理',
  '体育',
  '音乐',
  '美术',
  '信息技术',
];

interface BoardColumn {
  course: string;
  items: HomeworkDto[];
  pending: number;
}

const boardColumns = computed<BoardColumn[]>(() => {
  const groups = new Map<string, HomeworkDto[]>();
  for (const item of filtered.value) {
    const key = item.course?.name ?? '其他';
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  const columns: BoardColumn[] = [...groups.entries()].map(([course, items]) => ({
    course,
    items: [...items].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    pending: items.filter((item) => item.completed !== true).length,
  }));
  const rank = (name: string): number => {
    const index = COURSE_ORDER.findIndex((item) => name.includes(item));
    return index < 0 ? COURSE_ORDER.length : index;
  };
  return columns.sort((a, b) => rank(a.course) - rank(b.course) || a.course.localeCompare(b.course));
});

/** 看板字号：主看板用设定值，全屏放大 1.7 倍 */
const boardStyle = computed(() => ({ '--board-font': `${boardFontSize.value}px` }));
const fullscreenStyle = computed(() => ({ '--board-font': `${Math.round(boardFontSize.value * 1.7)}px` }));

const fullscreenItems = computed(() =>
  fullscreenCourse.value
    ? (boardColumns.value.find((column) => column.course === fullscreenCourse.value)?.items ?? [])
    : [],
);

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

/** 读取看板偏好（主进程配置为单一事实来源） */
async function loadBoardSettings(): Promise<void> {
  const config = await window.desktop?.getConfig?.();
  const saved = config?.homeworkBoard;
  if (!saved) return;
  if (saved.mode === 'board' || saved.mode === 'list') viewMode.value = saved.mode;
  if (typeof saved.showTime === 'boolean') boardShowTime.value = saved.showTime;
  if (typeof saved.fontSize === 'number' && Number.isFinite(saved.fontSize)) {
    boardFontSize.value = Math.min(28, Math.max(11, Math.round(saved.fontSize)));
  }
}

async function saveBoardSettings(): Promise<void> {
  if (!window.desktop?.saveConfig) return;
  savingBoard.value = true;
  try {
    await window.desktop.saveConfig({
      homeworkBoard: {
        mode: viewMode.value,
        showTime: boardShowTime.value,
        fontSize: boardFontSize.value,
      },
    });
  } finally {
    savingBoard.value = false;
  }
}

function openDetail(item: HomeworkDto): void {
  current.value = item;
  detailVisible.value = true;
}

function openCourseFullscreen(column: BoardColumn): void {
  fullscreenCourse.value = column.course;
}

/** 覆盖全屏：整块看板放大（点击标题栏「全屏」按钮） */
function openBoardFullscreen(): void {
  fullscreenCourse.value = null;
  fullscreenBoard.value = true;
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
    ElMessage.success(next ? '已标记为完成' : '已取消完成标记');
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '提交失败');
  } finally {
    submitting.value = false;
  }
}

/* ------------------------------------------------------------ 未交名单（班级设备） */

const submissionsVisible = ref(false);
const submissionsLoading = ref(false);
const submissionsSaving = ref(false);
const submissionsTarget = ref<HomeworkDto | null>(null);
const submissions = ref<HomeworkSubmissionDto[]>([]);
/** 勾选 = 未交（保存后其余学生一律标记为已交） */
const notSubmittedIds = ref<string[]>([]);

const notSubmittedCount = computed(() => notSubmittedIds.value.length);

async function openSubmissions(item: HomeworkDto): Promise<void> {
  submissionsTarget.value = item;
  submissionsVisible.value = true;
  submissionsLoading.value = true;
  try {
    const result = await homeworkApi.submissions(item.id);
    submissions.value = result.students;
    // 默认沿用服务端已有的未交数据（老师只需改动的部分）
    notSubmittedIds.value = result.notSubmitted.map((student) => student.userId);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '读取未交名单失败');
    submissions.value = [];
    notSubmittedIds.value = [];
  } finally {
    submissionsLoading.value = false;
  }
}

function markAllSubmitted(): void {
  notSubmittedIds.value = [];
}

function markAllNotSubmitted(): void {
  notSubmittedIds.value = submissions.value.map((student) => student.userId);
}

async function saveSubmissions(): Promise<void> {
  const target = submissionsTarget.value;
  if (!target) return;
  if (appStore.offline) {
    ElMessage.warning('离线状态下无法提交，请恢复网络后重试');
    return;
  }
  submissionsSaving.value = true;
  try {
    const result = await homeworkApi.saveSubmissions(target.id, notSubmittedIds.value);
    submissions.value = result.students;
    notSubmittedIds.value = result.notSubmitted.map((student) => student.userId);
    target.completedCount = result.completedCount;
    ElMessage.success(`未交名单已保存（未交 ${result.notSubmitted.length} / ${result.total} 人）`);
    submissionsVisible.value = false;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存未交名单失败');
  } finally {
    submissionsSaving.value = false;
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
  await loadBoardSettings();
  await loadHomework();
  realtime.on(SOCKET_EVENTS.homeworkNew, onHomeworkEvent);
  realtime.on(SOCKET_EVENTS.homeworkUpdated, onHomeworkEvent);
  appStore.onServerRecovered(onRecovered);
});

onUnmounted(() => {
  realtime.off(SOCKET_EVENTS.homeworkNew, onHomeworkEvent);
  realtime.off(SOCKET_EVENTS.homeworkUpdated, onHomeworkEvent);
  appStore.offServerRecovered(onRecovered);
  void saveBoardSettings();
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
        <el-radio-group v-model="viewMode" @change="saveBoardSettings">
          <el-radio-button value="board">看板</el-radio-button>
          <el-radio-button value="list">列表</el-radio-button>
        </el-radio-group>
        <el-button :icon="'Refresh'" @click="loadHomework">刷新</el-button>
      </div>
    </div>

    <!-- 看板外观：显示时间 / 字号（即时生效并持久化） -->
    <el-card v-if="viewMode === 'board'" shadow="never" class="board-config">
      <div class="board-config-row">
        <span class="board-config-label">看板设置</span>
        <el-switch
          v-model="boardShowTime"
          active-text="显示时间"
          inactive-text="隐藏时间"
          @change="saveBoardSettings"
        />
        <span class="board-config-label">字号</span>
        <el-slider
          v-model="boardFontSize"
          :min="11"
          :max="28"
          :step="1"
          style="width: 200px"
          @change="saveBoardSettings"
        />
        <span class="text-muted">{{ boardFontSize }}px</span>
        <el-button :icon="'FullScreen'" @click="openBoardFullscreen">全屏看板</el-button>
        <span v-if="savingBoard" class="text-muted">保存中…</span>
      </div>
    </el-card>

    <el-card v-loading="loading" shadow="never">
      <el-empty v-if="filtered.length === 0" description="没有符合条件的作业" />

      <!-- 看板模式：按科目分卡片，点击卡片放大全屏、点击条目看详情 -->
      <div v-else-if="viewMode === 'board'" class="board" :style="boardStyle">
        <section
          v-for="column in boardColumns"
          :key="column.course"
          class="board-card"
          :class="{ 'has-pending': column.pending > 0 }"
          @click="openCourseFullscreen(column)"
        >
          <header class="board-card-head">
            <span class="board-course">{{ column.course }}</span>
            <span v-if="column.pending > 0" class="board-badge">{{ column.pending }}</span>
          </header>
          <ol class="board-list">
            <li
              v-for="(item, index) in column.items"
              :key="item.id"
              class="board-item"
              :class="{ done: item.completed }"
              @click.stop="openDetail(item)"
            >
              <span class="board-index">{{ index + 1 }}.</span>
              <span class="board-title">{{ item.title }}</span>
              <span v-if="boardShowTime" class="board-time">{{ formatDate(item.createdAt, true) }}</span>
              <span v-if="item.completed" class="board-done-tag">已完成</span>
            </li>
          </ol>
          <footer class="board-card-foot">
            <span class="text-muted">共 {{ column.items.length }} 条</span>
            <span class="board-zoom">点击放大</span>
          </footer>
        </section>
      </div>

      <!-- 列表模式（默认表格视图） -->
      <el-table v-else :data="filtered" @row-click="openDetail">
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="row.completed ? 'success' : 'info'" size="small" effect="light">
              {{ row.completed ? '已完成' : '待完成' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="title" label="作业标题" min-width="220" show-overflow-tooltip />
        <el-table-column label="课程" width="110">
          <template #default="{ row }">{{ row.course?.name ?? '-' }}</template>
        </el-table-column>
        <el-table-column label="发布时间" width="170">
          <template #default="{ row }">{{ formatDate(row.createdAt, true) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button v-if="auth.isClassSession" link type="primary" @click.stop="openSubmissions(row)">
              未交名单
            </el-button>
            <el-button
              v-else
              link
              :type="row.completed ? 'warning' : 'primary'"
              :loading="submitting"
              @click.stop="toggleComplete(row)"
            >
              {{ row.completed ? '取消完成' : '标记完成' }}
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 全屏：单个科目放大 -->
    <el-dialog
      v-model="fullscreenCourse"
      fullscreen
      :title="`${fullscreenCourse ?? ''} · 作业`"
      class="board-fullscreen"
    >
      <ol class="board-list board-list-lg" :style="fullscreenStyle">
        <li
          v-for="(item, index) in fullscreenItems"
          :key="item.id"
          class="board-item"
          :class="{ done: item.completed }"
          @click="openDetail(item)"
        >
          <span class="board-index">{{ index + 1 }}.</span>
          <span class="board-title">{{ item.title }}</span>
          <span v-if="boardShowTime" class="board-time">{{ formatDate(item.createdAt, true) }}</span>
          <span v-if="item.completed" class="board-done-tag">已完成</span>
        </li>
      </ol>
      <el-empty v-if="fullscreenItems.length === 0" description="该科目暂无作业" />
    </el-dialog>

    <!-- 全屏：整块看板放大 -->
    <el-dialog v-model="fullscreenBoard" fullscreen title="今日作业看板" class="board-fullscreen">
      <div class="board board-lg" :style="fullscreenStyle">
        <section v-for="column in boardColumns" :key="column.course" class="board-card">
          <header class="board-card-head">
            <span class="board-course">{{ column.course }}</span>
            <span v-if="column.pending > 0" class="board-badge">{{ column.pending }}</span>
          </header>
          <ol class="board-list">
            <li
              v-for="(item, index) in column.items"
              :key="item.id"
              class="board-item"
              :class="{ done: item.completed }"
              @click="openDetail(item)"
            >
              <span class="board-index">{{ index + 1 }}.</span>
              <span class="board-title">{{ item.title }}</span>
              <span v-if="boardShowTime" class="board-time">{{ formatDate(item.createdAt, true) }}</span>
            </li>
          </ol>
        </section>
      </div>
    </el-dialog>

    <!-- 未交名单：勾选谁没交（其余学生一律视为已交） -->
    <el-dialog v-model="submissionsVisible" title="未交名单" width="520px">
      <p class="text-muted" style="margin-top: 0">
        勾选
        <strong>没交作业</strong>
        的同学，保存后其余同学会自动标记为已完成。
      </p>
      <div class="submission-toolbar">
        <el-button size="small" @click="markAllSubmitted">全部已交</el-button>
        <el-button size="small" @click="markAllNotSubmitted">全部未交</el-button>
        <span class="text-muted">未交 {{ notSubmittedCount }} / {{ submissions.length }} 人</span>
      </div>
      <div v-loading="submissionsLoading" class="submission-list">
        <el-empty v-if="submissions.length === 0 && !submissionsLoading" description="该班还没有学生账号" />
        <el-checkbox-group v-model="notSubmittedIds">
          <el-checkbox v-for="student in submissions" :key="student.userId" :value="student.userId">
            {{ student.name }}（{{ student.username }}）
          </el-checkbox>
        </el-checkbox-group>
      </div>
      <template #footer>
        <el-button @click="submissionsVisible = false">取消</el-button>
        <el-button type="primary" :loading="submissionsSaving" @click="saveSubmissions">保存</el-button>
      </template>
    </el-dialog>

    <el-drawer v-model="detailVisible" size="46%" :title="current?.title ?? '作业详情'">
      <template v-if="current">
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="课程">{{ current.course?.name ?? '-' }}</el-descriptions-item>
          <el-descriptions-item label="发布人">{{ current.creator?.name ?? '-' }}</el-descriptions-item>
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
            v-if="auth.isClassSession"
            type="primary"
            :disabled="appStore.offline"
            @click="openSubmissions(current)"
          >
            维护未交名单
          </el-button>
          <el-button
            v-else
            type="primary"
            :loading="submitting"
            :disabled="appStore.offline"
            @click="toggleComplete(current)"
          >
            {{ current.completed ? '取消完成标记' : '标记为已完成' }}
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
  border-radius: 12px;
  padding: 12px;
  margin: 0;
}

/* ---------------------------------------------------------------- 看板 */

.board-config {
  margin-bottom: 12px;
}

.board-config-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.board-config-label {
  font-weight: 600;
}

.board {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 14px;
}

.board-lg {
  grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  gap: 20px;
}

.board-card {
  display: flex;
  flex-direction: column;
  background: #1c1c1e;
  color: #f5f5f7;
  border-radius: 18px;
  padding: calc(var(--board-font, 15px) * 0.9) calc(var(--board-font, 15px) * 1.1);
  min-height: 120px;
  cursor: zoom-in;
  transition:
    transform 0.16s ease,
    box-shadow 0.16s ease;
  box-shadow: 0 2px 10px rgba(15, 23, 42, 0.12);
}

.board-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 10px 24px rgba(15, 23, 42, 0.22);
}

.board-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: calc(var(--board-font, 15px) * 0.5);
}

.board-course {
  font-size: calc(var(--board-font, 15px) * 0.95);
  font-weight: 600;
  color: #ffffff;
}

.board-badge {
  min-width: calc(var(--board-font, 15px) * 1.4);
  height: calc(var(--board-font, 15px) * 1.4);
  border-radius: 999px;
  background: #ff9f0a;
  color: #1c1c1e;
  font-size: calc(var(--board-font, 15px) * 0.72);
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 6px;
}

.board-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: calc(var(--board-font, 15px) * 0.35);
  flex: 1;
}

.board-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: var(--board-font, 15px);
  line-height: 1.5;
  border-radius: 10px;
  padding: 2px 4px;
  cursor: pointer;
}

.board-item:hover {
  background: rgba(255, 255, 255, 0.08);
}

.board-index {
  color: #8e8e93;
  flex: 0 0 auto;
}

.board-title {
  flex: 1 1 auto;
  word-break: break-word;
}

.board-item.done .board-title {
  text-decoration: line-through;
  color: #8e8e93;
}

.board-time {
  flex: 0 0 auto;
  font-size: calc(var(--board-font, 15px) * 0.72);
  color: #8e8e93;
}

.board-done-tag {
  flex: 0 0 auto;
  font-size: calc(var(--board-font, 15px) * 0.66);
  color: #32d74b;
}

.board-card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: calc(var(--board-font, 15px) * 0.5);
  font-size: calc(var(--board-font, 15px) * 0.7);
}

.board-card-foot .text-muted {
  color: #8e8e93;
}

.board-zoom {
  color: #0a84ff;
}

.board-list-lg .board-item {
  padding: 6px 8px;
}

.submission-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.submission-list {
  max-height: 46vh;
  overflow-y: auto;
  border: 1px solid #ebeef5;
  border-radius: 12px;
  padding: 12px;
}

.submission-list :deep(.el-checkbox-group) {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
</style>
