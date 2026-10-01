<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import {
  HOMEWORK_PHRASE_DEFAULTS,
  SOCKET_EVENTS,
  dayKeyLocal,
  formatDate,
  isDayKey,
  shiftDayKey,
  type CourseDto,
  type HomeworkDto,
  type HomeworkSubmissionDto,
} from '@classhelper/shared';
import { courseApi, homeworkApi } from '../api/index.js';
import { fetchWithCache } from '../cache/index.js';
import { markHomeworkCreatedLocally } from '../island/bridge.js';
import { useAppStore } from '../stores/app.js';
import { useAuthStore } from '../stores/auth.js';
import { useRealtimeStore } from '../stores/realtime.js';

const route = useRoute();
const router = useRouter();
const appStore = useAppStore();
const auth = useAuthStore();
const realtime = useRealtimeStore();

/** 看板/列表模式与看板外观（持久化到客户端配置，重启仍生效） */
const DEFAULT_BOARD = {
  mode: 'board' as 'board' | 'list',
  showTime: false,
  fontSize: 15,
};

const loading = ref(false);
const homeworks = ref<HomeworkDto[]>([]);
const fromCache = ref(false);
const updatedAt = ref<number | null>(null);
const detailVisible = ref(false);
const current = ref<HomeworkDto | null>(null);

const viewMode = ref<'board' | 'list'>(DEFAULT_BOARD.mode);
const boardShowTime = ref(DEFAULT_BOARD.showTime);
const boardFontSize = ref(DEFAULT_BOARD.fontSize);
const savingBoard = ref(false);

/** 全屏放大的科目（null = 未打开） */
const fullscreenCourse = ref<string | null>(null);
const fullscreenBoard = ref(false);

/* ------------------------------------------------------------ 按天查看 */

/**
 * 当前查看的日期（YYYY-MM-DD，本地）：默认今天，可用日期选择器或前后一天切换。
 * 支持 `?date=YYYY-MM-DD` 深链（冒烟测试与"直接打开某天的作业"都靠它）。
 */
const selectedDate = ref(
  typeof route.query.date === 'string' && isDayKey(route.query.date)
    ? route.query.date
    : dayKeyLocal(new Date()),
);
/** 有作业的日期（日期选择器高亮）：来自 GET /homeworks/days */
const dayMarks = ref<Map<string, number>>(new Map());
/** 录入作业的科目下拉 */
const courses = ref<CourseDto[]>([]);

/** 选中的是否就是今天（标题与按钮文案用） */
const isToday = computed(() => selectedDate.value === dayKeyLocal(now.value));

/** 日期选择器：给有作业的日期加高亮类 */
function dayCellClass(date: Date): string {
  return dayMarks.value.has(dayKeyLocal(date)) ? 'day-has-homework' : '';
}

async function selectDate(value: string | null): Promise<void> {
  if (!value || !isDayKey(value)) return;
  selectedDate.value = value;
  // 同步到地址栏：刷新/分享/冒烟测试都能落在同一天
  await router.replace({ path: '/homeworks', query: { date: value } });
  await loadHomework();
}

// 深链 ?date= 不止在首次挂载生效：已在作业页时（看板/列表之间切换、冒烟直接推 query），
// 路由 query 变了也要跟着切换日期 —— 组件被复用，没有这条监听就停在原日期。
watch(
  () => route.query.date,
  (value) => {
    if (typeof value !== 'string' || !isDayKey(value) || value === selectedDate.value) return;
    selectedDate.value = value;
    void loadHomework();
  },
);

/** 前后一天（教室电脑上不用打开日历也能翻） */
async function shiftDate(delta: number): Promise<void> {
  await selectDate(shiftDayKey(selectedDate.value, delta));
}

/** 每分钟刷新一次"现在"，用于标题栏时钟与"今天"的判定 */
const now = ref(new Date());
let clockTimer: ReturnType<typeof setInterval> | null = null;

const todayText = computed(
  () =>
    `${now.value.getFullYear()} 年 ${now.value.getMonth() + 1} 月 ${now.value.getDate()} 日 ` +
    `${['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.value.getDay()]} ` +
    `${String(now.value.getHours()).padStart(2, '0')}:${String(now.value.getMinutes()).padStart(2, '0')}`,
);

/**
 * 列表内容 = 服务端按天返回的结果（`?date=`），因此这里不再做二次过滤。
 *
 * 注意："已完成"是老师端/通知中心的概念，客户端作业模块只做**展示 + 录入**，
 * 因此这里没有任何完成状态相关的筛选与统计。
 */
const filtered = computed(() => homeworks.value);
const selectedDayText = computed(() => {
  if (isToday.value) return '今天';
  const [year, month, day] = selectedDate.value.split('-');
  return `${Number(year)} 年 ${Number(month)} 月 ${Number(day)} 日`;
});

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
  '通用技术',
];

interface BoardColumn {
  course: string;
  items: HomeworkDto[];
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

/* ------------------------------------------------------------ 看板自适应缩放
 *
 * 需求：作业必须**全部完整显示**（标题 + 作业要求），且**不需要上下滚动**。
 * 做法：先把卡片按视口宽度铺成网格，再按"内容高度 / 可用高度"算一个缩放系数，
 * 用 transform: scale() 整体缩到刚好铺满（字号仍由用户滑块决定，缩放只是兜底适配）。
 */

const boardHostRef = ref<HTMLElement | null>(null);
const boardInnerRef = ref<HTMLElement | null>(null);
const boardScale = ref(1);
const fullscreenHostRef = ref<HTMLElement | null>(null);
const fullscreenInnerRef = ref<HTMLElement | null>(null);
const fullscreenScale = ref(1);
/** 全屏单个科目视图（列表型）：与整块看板分开持有 ref，避免两个全屏弹窗互相覆盖 */
const courseHostRef = ref<HTMLElement | null>(null);
const courseInnerRef = ref<HTMLElement | null>(null);
const fullscreenCourseScale = ref(1);
/** 全屏看板的列数（由"铺满屏幕"算法动态算出；见 computeColumns） */
const fullscreenColumns = ref(0);

function computeScale(host: HTMLElement | null, inner: HTMLElement | null, minScale = 0.45): number {
  if (!host || !inner) return 1;
  const available = host.clientHeight;
  // 先按 1 倍量一次内容高度（transform 不影响 offsetHeight）
  const content = inner.offsetHeight;
  if (available <= 0 || content <= 0) return 1;
  const scale = Math.min(1, available / content);
  return Math.max(minScale, Math.round(scale * 1000) / 1000);
}

/**
 * 全屏看板列数：在"可用宽 × 可用高"里枚举 1..count 列，
 * 选出"单卡面积最大"的方案（面积越大越铺满屏幕），并用宽高比惩罚避免出现
 * 又扁又长的卡片。这样无论 2 个科目还是 12 个科目，全屏都是一屏铺满。
 */
function computeColumns(count: number, host: HTMLElement | null): number {
  if (count <= 1) return 1;
  if (!host) return count;
  const width = host.clientWidth || 0;
  const height = host.clientHeight || 0;
  if (width <= 0 || height <= 0) return Math.min(3, count);
  const gap = Math.max(8, boardFontSize.value * 1.53);
  const wantRatio = 1.15;
  let bestCols = 1;
  let bestScore = -Infinity;
  for (let cols = 1; cols <= count; cols += 1) {
    const rows = Math.ceil(count / cols);
    const cardWidth = (width - gap * (cols - 1)) / cols;
    const cardHeight = (height - gap * (rows - 1)) / rows;
    if (cardWidth <= 0 || cardHeight <= 0) continue;
    const ratio = cardWidth / cardHeight;
    const ratioPenalty = Math.max(ratio / wantRatio, wantRatio / ratio);
    const score = (cardWidth * cardHeight) / ratioPenalty;
    if (score > bestScore) {
      bestScore = score;
      bestCols = cols;
    }
  }
  return bestCols;
}

function fitBoards(): void {
  void nextTick(() => {
    boardScale.value = computeScale(boardHostRef.value, boardInnerRef.value);
    fullscreenScale.value = computeScale(fullscreenHostRef.value, fullscreenInnerRef.value);
    fullscreenCourseScale.value = computeScale(courseHostRef.value, courseInnerRef.value);
  });
}

/**
 * 全屏看板适配：弹窗是异步挂载的（有过渡），刚打开时容器尺寸可能是 0，
 * 因此这里轮询等待布局就绪，再算列数与缩放，保证"一屏铺满、不用滚动"。
 * 列数改变会重排，所以排完再量一次缩放系数。
 */
async function fitFullscreen(kind: 'board' | 'course' = 'board'): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const host = kind === 'board' ? fullscreenHostRef.value : courseHostRef.value;
    const inner = kind === 'board' ? fullscreenInnerRef.value : courseInnerRef.value;
    if (host && inner && host.clientHeight > 60 && host.clientWidth > 60) {
      if (kind === 'board') {
        const count = inner.children.length || boardColumns.value.length || 1;
        fullscreenColumns.value = computeColumns(count, host);
        await nextTick();
        fullscreenScale.value = computeScale(host, fullscreenInnerRef.value, 0.3);
      } else {
        fullscreenCourseScale.value = computeScale(host, inner, 0.3);
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
}

/** 视口/窗口尺寸变化：全屏看板重新自适应 */
function onResize(): void {
  fitBoards();
  if (fullscreenBoard.value) void fitFullscreen('board');
  if (fullscreenCourse.value) void fitFullscreen('course');
}

/* ------------------------------------------------------------ 数据加载 */

async function loadHomework(): Promise<void> {
  loading.value = true;
  try {
    const classId = auth.classId ?? undefined;
    const day = selectedDate.value;
    // 缓存按"班级 + 日期"分键：翻到别的天不会串数据，离线也能看回看过的那些天
    const result = await fetchWithCache<HomeworkDto[]>(
      'homeworks',
      `${classId ?? 'self'}@${day}`,
      () => homeworkApi.list(classId ? { classId, date: day } : { date: day }),
      [],
    );
    homeworks.value = result.data;
    fromCache.value = result.fromCache;
    updatedAt.value = result.updatedAt;
    if (!result.fromCache) appStore.markSynced();
    void loadDayMarks(classId);
    if (current.value) {
      current.value = homeworks.value.find((item) => item.id === current.value?.id) ?? current.value;
    }
    fitBoards();
  } finally {
    loading.value = false;
  }
}

/**
 * 拉取"哪些天有作业"（日期选择器高亮）。
 *
 * 范围取当前查看日期前后各 45 天：教室电脑上翻月份也能看到有作业的日子。
 */
async function loadDayMarks(classId: string | undefined): Promise<void> {
  try {
    const from = shiftDayKey(selectedDate.value, -45);
    const to = shiftDayKey(selectedDate.value, 45);
    const result = await homeworkApi.days({ classId, from, to });
    dayMarks.value = new Map(result.days.map((item) => [item.date, item.count]));
  } catch {
    // 离线/失败时保留上一次的高亮，不打断展示
  }
}

/** 科目下拉（录入作业时可选） */
async function loadCourses(): Promise<void> {
  if (!auth.classId) return;
  courses.value = await courseApi.list(auth.classId).catch(() => []);
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
    fitBoards();
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
  fitBoards();
}

/** 覆盖全屏：整块看板放大（点击标题栏「全屏」按钮） */
function openBoardFullscreen(): void {
  fullscreenCourse.value = null;
  fullscreenBoard.value = true;
  fitBoards();
}

/* ------------------------------------------------------------ 录入作业（教室机器） */

const createVisible = ref(false);
const createSaving = ref(false);
/** 快捷短语：来自客户端本地配置（设置 → 作业录入可增删） */
const phrases = ref<string[]>([...HOMEWORK_PHRASE_DEFAULTS]);
/** 短语插入到哪个输入框：跟着最后一次聚焦的字段走 */
const lastFocused = ref<'title' | 'content'>('content');
const createForm = ref({ courseId: '', title: '', content: '' });

async function loadPhrases(): Promise<void> {
  const config = await window.desktop?.getConfig?.();
  if (config?.homeworkPhrases) phrases.value = [...config.homeworkPhrases];
}

function openCreate(): void {
  createForm.value = { courseId: '', title: '', content: '' };
  lastFocused.value = 'content';
  createVisible.value = true;
}

/** 点快捷短语：把词追加到当前字段末尾（空格分隔，避免连成一坨） */
function insertPhrase(phrase: string): void {
  const field = lastFocused.value;
  const current = createForm.value[field];
  const next = current.trim() ? `${current.trimEnd()} ${phrase}` : phrase;
  createForm.value = { ...createForm.value, [field]: next };
}

async function submitCreate(): Promise<void> {
  const classId = auth.classId;
  if (!classId) {
    ElMessage.error('当前会话没有班级信息，无法录入作业');
    return;
  }
  if (appStore.offline) {
    ElMessage.warning('离线状态下无法录入作业，请恢复网络后重试');
    return;
  }
  const title = createForm.value.title.trim();
  const content = createForm.value.content.trim();
  if (!title) {
    ElMessage.warning('请填写作业标题');
    return;
  }
  if (!content) {
    ElMessage.warning('请填写作业要求');
    return;
  }

  createSaving.value = true;
  try {
    // 先按内容登记"This 是本机录的"：服务端是**先广播 homework:new、后回响应**的，
    // 等响应拿到 id 再登记就晚了 —— 实时事件可能已经到了，岛已经弹出来了。
    const draft = { classId, title, content, assignDate: selectedDate.value };
    markHomeworkCreatedLocally(draft);
    const created = await homeworkApi.create({
      classId,
      courseId: createForm.value.courseId || null,
      title,
      content,
      assignDate: selectedDate.value,
    });
    // 回执里带上 id 再记一次（覆盖"广播晚于响应"的另一半）
    if (created?.id) markHomeworkCreatedLocally({ ...draft, id: created.id });
    ElMessage.success(`已录入到 ${selectedDate.value}`);
    createVisible.value = false;
    await loadHomework();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '录入失败');
  } finally {
    createSaving.value = false;
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

let resizeObserver: ResizeObserver | null = null;

onMounted(async () => {
  await loadBoardSettings();
  await loadPhrases();
  await loadCourses();
  await loadHomework();
  clockTimer = setInterval(() => {
    now.value = new Date();
  }, 30_000);
  // 视口变化后重新适配（保证"全部显示在屏幕上"始终成立）
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => fitBoards());
    if (boardHostRef.value) resizeObserver.observe(boardHostRef.value);
  }
  window.addEventListener('resize', onResize);
  fitBoards();
  realtime.on(SOCKET_EVENTS.homeworkNew, onHomeworkEvent);
  realtime.on(SOCKET_EVENTS.homeworkUpdated, onHomeworkEvent);
  appStore.onServerRecovered(onRecovered);
});

onUnmounted(() => {
  if (clockTimer) clearInterval(clockTimer);
  resizeObserver?.disconnect();
  window.removeEventListener('resize', onResize);
  realtime.off(SOCKET_EVENTS.homeworkNew, onHomeworkEvent);
  realtime.off(SOCKET_EVENTS.homeworkUpdated, onHomeworkEvent);
  appStore.offServerRecovered(onRecovered);
  void saveBoardSettings();
});
</script>

<template>
  <div class="page homework-page">
    <div class="page-header">
      <div>
        <h2 class="page-title">我的作业</h2>
        <p class="page-subtitle">
          {{ selectedDayText }} · {{ filtered.length }} 份
          <el-tag v-if="fromCache" size="small" type="warning" effect="plain">离线缓存</el-tag>
        </p>
      </div>
      <div class="toolbar">
        <el-button-group>
          <el-button :icon="'ArrowLeft'" @click="shiftDate(-1)">前一天</el-button>
          <el-button :disabled="isToday" @click="selectDate(dayKeyLocal(now))">今天</el-button>
          <el-button @click="shiftDate(1)">后一天<el-icon class="ml-4"><ArrowRight /></el-icon></el-button>
        </el-button-group>
        <el-date-picker
          :model-value="selectedDate"
          type="date"
          value-format="YYYY-MM-DD"
          placeholder="选择日期"
          class="day-picker"
          :cell-class-name="dayCellClass"
          @update:model-value="(value: string | null) => selectDate(value)"
        />
        <el-radio-group v-model="viewMode" @change="saveBoardSettings">
          <el-radio-button value="board">看板</el-radio-button>
          <el-radio-button value="list">列表</el-radio-button>
        </el-radio-group>
        <el-button type="primary" :icon="'Plus'" @click="openCreate">录入作业</el-button>
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
          style="width: 180px"
          @change="saveBoardSettings"
        />
        <span class="text-muted">{{ boardFontSize }}px</span>
        <el-button :icon="'FullScreen'" @click="openBoardFullscreen">全屏看板</el-button>
        <span class="text-muted">自适应缩放 {{ Math.round(boardScale * 100) }}%</span>
        <span v-if="savingBoard" class="text-muted">保存中…</span>
      </div>
    </el-card>

    <el-card v-loading="loading" shadow="never" class="homework-body">
      <el-empty v-if="filtered.length === 0" :description="`${selectedDayText}没有作业`" />

      <!-- 看板模式：按科目分卡片，点击卡片放大全屏、点击条目看详情 -->
      <div v-else-if="viewMode === 'board'" ref="boardHostRef" class="board-host">
        <div ref="boardInnerRef" class="board" :style="{ ...boardStyle, '--board-scale': boardScale }">
          <section
            v-for="column in boardColumns"
            :key="column.course"
            class="board-card"
            @click="openCourseFullscreen(column)"
          >
            <header class="board-card-head">
              <span class="board-course">{{ column.course }}</span>
              <span class="board-badge">{{ column.items.length }}</span>
            </header>
            <ol class="board-list">
              <li
                v-for="(item, index) in column.items"
                :key="item.id"
                class="board-item"
                @click.stop="openDetail(item)"
              >
                <span class="board-index">{{ index + 1 }}.</span>
                <span class="board-text">
                  <span class="board-title">{{ item.title }}</span>
                  <!-- 需求：作业要完整显示（标题 + 作业要求），不能只显示标题 -->
                  <span v-if="item.content.trim()" class="board-content">{{ item.content }}</span>
                </span>
                <span v-if="boardShowTime" class="board-time">{{ formatDate(item.createdAt, true) }}</span>
              </li>
            </ol>
            <footer class="board-card-foot">
              <span class="text-muted">共 {{ column.items.length }} 条</span>
              <span class="board-zoom">点击放大</span>
            </footer>
          </section>
        </div>
      </div>

      <!-- 列表模式（默认表格视图） -->
      <el-table v-else :data="filtered" @row-click="openDetail">
        <el-table-column prop="title" label="作业标题" min-width="200" show-overflow-tooltip />
        <el-table-column prop="content" label="作业要求" min-width="240" show-overflow-tooltip />
        <el-table-column label="课程" width="110">
          <template #default="{ row }">{{ row.course?.name ?? '-' }}</template>
        </el-table-column>
        <el-table-column label="所属日期" width="120">
          <template #default="{ row }">{{ row.assignDate }}</template>
        </el-table-column>
        <el-table-column label="录入时间" width="170">
          <template #default="{ row }">{{ formatDate(row.createdAt, true) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="130" fixed="right">
          <template #default="{ row }">
            <el-button v-if="auth.isClassSession" link type="primary" @click.stop="openSubmissions(row)">
              未交名单
            </el-button>
            <el-button v-else link type="primary" @click.stop="openDetail(row)">查看</el-button>
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
      @opened="fitFullscreen('course')"
    >
      <template #header="{ titleId, titleClass }">
        <div class="board-dialog-head">
          <span :id="titleId" :class="titleClass">{{ fullscreenCourse ?? '' }} · 作业</span>
          <!-- 需求：当天时间显示在标题栏正中间（受"显示时间"开关控制） -->
          <span v-if="boardShowTime" class="board-dialog-clock">{{ todayText }}</span>
        </div>
      </template>
      <div ref="courseHostRef" class="board-host board-host-lg">
        <ol
          ref="courseInnerRef"
          class="board-list board-list-lg"
          :style="{ ...fullscreenStyle, '--board-scale': fullscreenCourseScale }"
        >
          <li
            v-for="(item, index) in fullscreenItems"
            :key="item.id"
            class="board-item"
            @click="openDetail(item)"
          >
            <span class="board-index">{{ index + 1 }}.</span>
            <span class="board-text">
              <span class="board-title">{{ item.title }}</span>
              <span v-if="item.content.trim()" class="board-content">{{ item.content }}</span>
            </span>
            <span v-if="boardShowTime" class="board-time">{{ formatDate(item.createdAt, true) }}</span>
          </li>
        </ol>
      </div>
      <el-empty v-if="fullscreenItems.length === 0" :description="`该科目 ${selectedDayText}没有作业`" />
    </el-dialog>

    <!-- 全屏：整块看板放大 -->
    <el-dialog v-model="fullscreenBoard" fullscreen class="board-fullscreen" @opened="fitFullscreen('board')">
      <template #header="{ titleId, titleClass }">
        <div class="board-dialog-head">
          <span :id="titleId" :class="titleClass">今日作业看板</span>
          <span v-if="boardShowTime" class="board-dialog-clock">{{ todayText }}</span>
        </div>
      </template>
      <div ref="fullscreenHostRef" class="board-host board-host-lg">
        <div
          ref="fullscreenInnerRef"
          class="board board-lg"
          :style="{
            ...fullscreenStyle,
            '--board-scale': fullscreenScale,
            '--board-cols': String(fullscreenColumns || 1),
          }"
        >
          <section v-for="column in boardColumns" :key="column.course" class="board-card">
            <header class="board-card-head">
              <span class="board-course">{{ column.course }}</span>
              <span class="board-badge">{{ column.items.length }}</span>
            </header>
            <ol class="board-list">
              <li
                v-for="(item, index) in column.items"
                :key="item.id"
                class="board-item"
                @click="openDetail(item)"
              >
                <span class="board-index">{{ index + 1 }}.</span>
                <span class="board-text">
                  <span class="board-title">{{ item.title }}</span>
                  <span v-if="item.content.trim()" class="board-content">{{ item.content }}</span>
                </span>
                <span v-if="boardShowTime" class="board-time">{{ formatDate(item.createdAt, true) }}</span>
              </li>
            </ol>
          </section>
        </div>
      </div>
    </el-dialog>

    <!-- 录入作业（教室机器）：快捷短语点一下就追加到标题/内容 -->
    <el-dialog v-model="createVisible" title="录入作业" width="620px">
      <el-form label-width="90px">
        <el-form-item label="所属日期">
          <el-date-picker
            :model-value="selectedDate"
            type="date"
            value-format="YYYY-MM-DD"
            :cell-class-name="dayCellClass"
            @update:model-value="(value: string | null) => selectDate(value)"
          />
          <span class="text-muted ml-8">默认就是当前正在查看的这一天</span>
        </el-form-item>
        <el-form-item label="科目">
          <el-select v-model="createForm.courseId" clearable placeholder="可不选" style="width: 220px">
            <el-option v-for="item in courses" :key="item.id" :label="item.name" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="标题">
          <el-input
            v-model="createForm.title"
            maxlength="120"
            show-word-limit
            placeholder="例如：第 3 课生字"
            @focus="lastFocused = 'title'"
          />
        </el-form-item>
        <el-form-item label="作业要求">
          <el-input
            v-model="createForm.content"
            type="textarea"
            :rows="3"
            maxlength="5000"
            placeholder="例如：P 12 大本，背诵第 3 段"
            @focus="lastFocused = 'content'"
          />
        </el-form-item>
        <el-form-item v-if="phrases.length > 0" label="快捷短语">
          <div class="phrase-row">
            <el-tag
              v-for="item in phrases"
              :key="item"
              class="phrase-chip"
              type="info"
              effect="plain"
              @click="insertPhrase(item)"
            >
              {{ item }}
            </el-tag>
            <span class="text-muted">点一下追加到「{{ lastFocused === 'title' ? '标题' : '作业要求' }}」</span>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="createSaving" @click="submitCreate">保存作业</el-button>
      </template>
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
            {{ student.name }}
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
          <el-descriptions-item label="所属日期">{{ current.assignDate }}</el-descriptions-item>
          <el-descriptions-item label="录入时间">
            {{ formatDate(current.createdAt, true) }}
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

        <div v-if="auth.isClassSession" class="mt-16">
          <el-button type="primary" :disabled="appStore.offline" @click="openSubmissions(current)">
            维护未交名单
          </el-button>
          <span v-if="appStore.offline" class="text-muted" style="margin-left: 10px">离线状态下不可提交</span>
        </div>
      </template>
    </el-drawer>
  </div>
</template>

<style scoped>
/* 日期选择器：有作业的日子加一个圆点，翻月份时一眼看出哪天有作业 */
:deep(.day-has-homework .el-date-table-cell__text)::after {
  content: '';
  position: absolute;
  left: 50%;
  bottom: 2px;
  width: 4px;
  height: 4px;
  margin-left: -2px;
  border-radius: 50%;
  background: currentColor;
}

.day-picker {
  width: 168px;
}

.phrase-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.phrase-chip {
  cursor: pointer;
  user-select: none;
}

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

/* 作业页整体不滚动：看板靠自适应缩放铺满，避免"要上下翻页才能看全" */
.homework-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  box-sizing: border-box;
}

.homework-body {
  flex: 1 1 auto;
  min-height: 0;
}

.homework-body :deep(.el-card__body) {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
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

/* 承载区：高度固定，里面靠 scale 适配，绝不出现滚动条 */
.board-host {
  flex: 1 1 auto;
  min-height: 240px;
  overflow: hidden;
  display: flex;
  align-items: flex-start;
  justify-content: center;
}

.board-host-lg {
  height: calc(100vh - 150px);
}

.board {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(calc(var(--board-font, 15px) * 15), 1fr));
  gap: calc(var(--board-font, 15px) * 0.8);
  width: 100%;
  transform: scale(var(--board-scale, 1));
  transform-origin: top center;
}

/* 全屏看板：列数由脚本按"铺满屏幕"算好后注入（--board-cols），不再靠 auto-fit 猜；
   行高保持内容自然高度，交给 transform: scale() 适配，避免卡片被压扁截断内容。 */
.board-lg {
  grid-template-columns: repeat(var(--board-cols, 2), minmax(0, 1fr));
  gap: calc(var(--board-font, 15px) * 0.9);
  align-content: start;
}

.board-card {
  display: flex;
  flex-direction: column;
  background: #1c1c1e;
  color: #f5f5f7;
  border-radius: 18px;
  padding: calc(var(--board-font, 15px) * 0.8) calc(var(--board-font, 15px) * 0.95);
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
  margin-bottom: calc(var(--board-font, 15px) * 0.45);
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
  gap: calc(var(--board-font, 15px) * 0.4);
  flex: 1;
}

.board-item {
  display: flex;
  align-items: flex-start;
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

.board-text {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.board-title {
  font-weight: 600;
  word-break: break-word;
}

/* 作业要求：完整展示（不截断），字号略小以保持层级 */
.board-content {
  font-size: calc(var(--board-font, 15px) * 0.82);
  color: #c7c7cc;
  white-space: pre-wrap;
  word-break: break-word;
}

.board-item.done .board-title,
.board-item.done .board-content {
  text-decoration: line-through;
  color: #8e8e93;
}

.board-time {
  flex: 0 0 auto;
  font-size: calc(var(--board-font, 15px) * 0.72);
  color: #8e8e93;
}

.board-done-tag-unused {
  flex: 0 0 auto;
  font-size: calc(var(--board-font, 15px) * 0.66);
  color: #32d74b;
}

.board-card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: calc(var(--board-font, 15px) * 0.45);
  font-size: calc(var(--board-font, 15px) * 0.7);
}

.board-card-foot .text-muted {
  color: #8e8e93;
}

.board-zoom {
  color: #0a84ff;
}

.board-list-lg {
  width: 100%;
  transform: scale(var(--board-scale, 1));
  transform-origin: top center;
}

.board-list-lg .board-item {
  padding: 6px 8px;
}

/* 全屏弹窗标题栏：标题 + 当天时间（时间绝对居中对齐） */
.board-dialog-head {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  padding-right: 48px;
}

.board-dialog-clock {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  font-size: 14px;
  font-weight: 500;
  color: #6b7280;
  white-space: nowrap;
}

.board-fullscreen :deep(.el-dialog__body) {
  padding-top: 6px;
  height: calc(100vh - 84px);
  overflow: hidden;
}

/* 兜底：`class` 由 el-dialog 透传时可能不携带 scoped 属性，这里用全局选择器保证
   全屏弹窗内容区一定铺满整屏（否则看板会缩在左上角）。 */
:global(.board-fullscreen .el-dialog__body) {
  padding-top: 6px;
  height: calc(100vh - 84px);
  overflow: hidden;
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
