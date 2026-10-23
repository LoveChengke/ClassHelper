<script setup lang="ts">
import type { ActiveClassPlanWeekDto as ContractActiveClassPlanWeekDto } from '@classhelper/shared';

import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { onBeforeRouteLeave, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  TIME_POINT_TYPES,
  SOCKET_EVENTS,
  dayKeyLocal,
  shiftDayKey,
  SUBJECT_CATALOG,
  type ClassPlanDto,
  type TimeLayoutDetailDto,
  type TimePointDto,
  type ClassDto,
  type CourseDto,
} from '@classhelper/shared';
import { api } from '@/api/http';
import { classApi, courseApi, courseIdFromExistsError, dashboardApi } from '@/api';
import { useRealtimeStore } from '@/stores/realtime';
import ArchiveIcon from '@/components/ArchiveIcon.vue';
import { useAuthStore } from '@/stores/auth';
import ClassPlanImportDialog from '@/components/ClassPlanImportDialog.vue';
const auth = useAuthStore();
const router = useRouter();
const realtime = useRealtimeStore();
const importVisible = ref(false),
  search = ref(''),
  activePoint = ref('');
const fileInput = ref<HTMLInputElement>();
const canTime = computed(() => auth.permissions.includes('timetable:manage'));
const canWrite = computed(
  () =>
    auth.can('schedule:write') &&
    (auth.role === 'ADMIN' || classes.value.find((c) => c.id === classId.value)?.teacherId === auth.user?.id),
);
const classes = ref<ClassDto[]>([]),
  courses = ref<CourseDto[]>([]);
const classId = ref(''),
  layouts = ref<TimeLayoutDetailDto[]>([]),
  plans = ref<ClassPlanDto[]>([]);
const selectedLayout = ref(''),
  selectedPlan = ref(''),
  week = ref(1),
  tab = ref('plans');
const groups = ref<{ id: string; name: string; isGlobal: boolean; isDefault: boolean }[]>([]);
const layout = computed(() => layouts.value.find((p) => p.id === selectedLayout.value));
const plan = computed(() => plans.value.find((p) => p.id === selectedPlan.value));
const selected = ref<string[]>([]),
  copied = ref<ClassPlanDto['entries']>([]);
const copiedPoints = ref<TimePointDto[]>([]);
const types = { LESSON: '上课', BREAK: '课间', DIVIDER: '分割线', ACTION: '行动（只保存）' };
const selectedGroup = ref(''),
  temporaryGroup = ref(''),
  expireTime = ref('');
const scheduled = ref<{ id: string; date: string; plan: { name: string; isOverlay: boolean } }[]>([]);
const activeWeek = ref<ContractActiveClassPlanWeekDto>();
function dayPlan(day: number) {
  const active = activeWeek.value?.days.find((d) => d.weekday === day)?.classPlan;
  return active ? (plans.value.find((p) => p.id === active.id) ?? active) : undefined;
}
async function selectGroup(temporary = false) {
  await api.post('/class-plan-groups/select', {
    classId: classId.value,
    selected: selectedGroup.value || undefined,
    ...(temporary
      ? { temporary: temporaryGroup.value, expireTime: new Date(expireTime.value).toISOString() }
      : {}),
  });
  await load();
}
async function cancelScheduled(id: string) {
  await api.delete(`/schedules/scheduled/${id}`);
  await load();
}
let loadRequest = 0;
async function load() {
  const request = ++loadRequest;
  if (!classId.value) return;
  const scope = { classId: classId.value, week: week.value };
  loading.value = true;
  loadError.value = false;
  try {
    const [ls, ps, cs, gs, ss, active, selection] = await Promise.all([
      api.get<TimeLayoutDetailDto[]>('/time-layouts', { classId: scope.classId }),
      api.get<ClassPlanDto[]>('/class-plans', { classId: scope.classId }),
      courseApi.list(scope.classId),
      api.get<typeof groups.value>('/class-plan-groups', { classId: scope.classId }),
      api.get<typeof scheduled.value>('/schedules/scheduled', { classId: scope.classId }),
      api.get<ContractActiveClassPlanWeekDto>('/schedules/active-week', scope),
      api.get<{ selected?: string; temporary?: string; expireTime?: string }>(
        '/class-plan-groups/selection',
        {
          classId: scope.classId,
        },
      ),
    ]);
    const monday = active.days.find((day) => day.weekday === 1);
    if (monday) {
      // 周日列展示周一之前的日期，启用结果仍完全交给服务端解析。
      const date = shiftDayKey(monday.date, -1);
      const sunday = await api.get<ContractActiveClassPlanWeekDto['days'][number]>('/schedules/current', {
        classId: scope.classId,
        at: new Date(`${date}T12:00:00`).toISOString(),
      });
      active.days = [...active.days.filter((day) => day.weekday !== 7), { ...sunday, weekday: 7, date }];
    }
    if (request !== loadRequest) return;
    for (const day of active.days)
      if (day.classPlan && !ps.some((p) => p.id === day.classPlan!.id)) ps.push(day.classPlan);
    // 周次切换和实时刷新保留当前班级尚未保存的编辑。
    const pendingPlans = new Map(dirtyPlans.value.map((p) => [p.id, p]));
    const pendingLayouts = new Map(dirtyLayouts.value.map((p) => [p.id, p]));
    planBaseline.value = Object.fromEntries(ps.map((p) => [p.id, JSON.stringify(p)]));
    layoutBaseline.value = Object.fromEntries(ls.map((p) => [p.id, JSON.stringify(p)]));
    layouts.value = ls.map((p) => pendingLayouts.get(p.id) || p);
    plans.value = ps.map((p) => pendingPlans.get(p.id) || p);
    courses.value = cs;
    groups.value = gs;
    scheduled.value = ss;
    activeWeek.value = active;
    selectedGroup.value = selection.selected || '';
    temporaryGroup.value = selection.temporary || '';
    if (!plans.value.some((p) => p.id === selectedPlan.value)) selectedPlan.value = '';
    if (!layouts.value.some((p) => p.id === selectedLayout.value))
      selectedLayout.value = plan.value?.timeLayoutId || layouts.value[0]?.id || '';
  } catch {
    if (request === loadRequest) loadError.value = true;
  } finally {
    if (request === loadRequest) loading.value = false;
  }
}
watch(week, () => void load());
watch(
  selectedPlan,
  () => {
    selected.value = [];
    activePoint.value = '';
    if (plan.value) selectedLayout.value = plan.value.timeLayoutId;
  },
  { flush: 'sync' },
);
const quickLessonMinutes = ref(45),
  quickBreakMinutes = ref(10);
function addMinutes(time: string, minutes: number): string {
  const [hour, minute] = time.split(':').map(Number);
  const total = ((hour ?? 0) * 60 + (minute ?? 0) + minutes) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
function addPoint(type: TimePointDto['timeType'] = 'LESSON') {
  if (!layout.value) return;
  const points = layout.value.points;
  const previous = points[points.length - 1];
  // 从上一时段结束处继续排，课程和课间共用快速时长。
  const minutes =
    type === 'BREAK' ? quickBreakMinutes.value : type === 'DIVIDER' ? 0 : quickLessonMinutes.value;
  let startTime = previous?.endTime || '08:00';
  let endTime = addMinutes(startTime, minutes);
  // 上一时段已经排到午夜：跨天的结束时间不合法，新时段从当天零点开始。
  if (type !== 'DIVIDER' && endTime <= startTime) {
    startTime = '00:00';
    endTime = addMinutes(startTime, minutes);
  }
  const lessonCount = points.filter((point) => point.timeType === 'LESSON').length;
  points.push({
    id: `draft-${crypto.randomUUID()}`,
    name: type === 'LESSON' ? `第 ${lessonCount + 1} 节` : types[type],
    startTime,
    endTime,
    timeType: type,
    position: points.length,
    isHideDefault: false,
    defaultClassId: null,
    breakName: '',
    actionSet: '{}',
  });
}
async function newLayout() {
  if (!canTime.value || saving.value) return;
  const { value } = await ElMessageBox.prompt('输入时间表名称', '新时间表');
  const result = await api.post<TimeLayoutDetailDto>('/time-layouts', {
    name: value,
    classId: classId.value,
    points: [],
  });
  selectedLayout.value = result.id;
  await load();
}
async function persistLayout(item: TimeLayoutDetailDto) {
  if (!item.name.trim()) throw new Error('请填写时间表名称');
  if (item.points.some((p) => p.timeType !== 'DIVIDER' && p.startTime >= p.endTime))
    throw new Error('时间点的结束时间必须晚于开始时间');
  const result = await api.put<TimeLayoutDetailDto>(`/time-layouts/${item.id}`, {
    ...item,
    points: item.points.map((p) => ({ ...p, id: p.id.startsWith('draft-') ? undefined : p.id || undefined })),
  });
  layouts.value = layouts.value.map((p) => (p.id === result.id ? result : p));
  layoutBaseline.value[result.id] = JSON.stringify(result);
}
async function saveLayout() {
  if (!canTime.value || !layout.value || saving.value) return;
  saving.value = true;
  try {
    await persistLayout(layout.value);
    await load();
    ElMessage.success('时间表已保存，所有引用课表同步生效');
  } catch (error) {
    if (error instanceof Error) ElMessage.error(error.message);
  } finally {
    saving.value = false;
  }
}
async function cloneLayout() {
  if (layout.value) {
    await api.post(`/time-layouts/${layout.value.id}/clone`, {});
    await load();
  }
}
async function importLayout() {
  const value = sourceLayout.value;
  if (!value) return;
  if (layout.value) {
    await api.post(`/time-layouts/${layout.value.id}/import`, { sourceId: value });
    await load();
  }
}
const createVisible = ref(false);
const createDay = ref(1);
const createName = ref('');
const createLayout = ref('');
function newPlan(day = 1) {
  if (!canWrite.value || !classId.value) return;
  createDay.value = day;
  createName.value = `星期${'一二三四五六日'[day - 1]}课表`;
  createLayout.value = selectedLayout.value || layouts.value[0]?.id || '';
  createVisible.value = true;
}
async function confirmCreate() {
  if (!canWrite.value || saving.value || !createName.value.trim() || !createLayout.value) return;
  saving.value = true;
  try {
    const p = await api.post<ClassPlanDto>('/class-plans', {
      name: createName.value.trim(),
      classId: classId.value,
      timeLayoutId: createLayout.value,
      weekday: createDay.value,
      weekCountDiv: 0,
      weekCountDivTotal: 2,
      weekStart: 1,
      weekEnd: maxWeek.value,
    });
    await load();
    selectedPlan.value = p.id;
    selectedDay.value = createDay.value;
    createVisible.value = false;
  } finally {
    saving.value = false;
  }
}
async function persistPlan(item: ClassPlanDto) {
  if (!item.name.trim()) throw new Error('请填写课表名称');
  if (item.weekStart > item.weekEnd || item.weekCountDiv > item.weekCountDivTotal)
    throw new Error('请检查生效周次和轮换设置');
  const snapshot = JSON.parse(JSON.stringify(item)) as ClassPlanDto;
  await api.put(`/class-plans/${item.id}`, snapshot);
  await api.put(`/class-plans/${item.id}/entries`, { entries: snapshot.entries });
  planBaseline.value[item.id] = JSON.stringify(snapshot);
}
async function savePlan() {
  if (!canWrite.value || !plan.value || saving.value) return;
  saving.value = true;
  try {
    await persistPlan(plan.value);
    await load();
    ElMessage.success('课表已保存');
  } catch (error) {
    if (error instanceof Error) ElMessage.error(error.message);
  } finally {
    saving.value = false;
  }
}
function planEntry(p: ClassPlanDto | undefined, pointId: string, create = false) {
  if (!p) return;
  let e = p.entries.find((e) => e.timeLayoutItemId === pointId);
  if (!e && create) {
    e = {
      id: '',
      timeLayoutItemId: pointId,
      courseId: null,
      isEnabled: true,
      isChangedClass: false,
      location: null,
    };
    p.entries.push(e);
  }
  return e;
}
function entry(point: TimePointDto) {
  return planEntry(plan.value, point.id);
}
function editEntry(point: TimePointDto) {
  return planEntry(plan.value, point.id, true);
}
function assign(point: TimePointDto, value: string | null) {
  if (!canWrite.value) return;
  const e = editEntry(point);
  if (e) e.courseId = value;
}
function toggleSelected(id: string, checked: unknown) {
  selected.value = checked
    ? [...new Set([...selected.value, id])]
    : selected.value.filter((value) => value !== id);
}
async function batch() {
  const { value } = await ElMessageBox.prompt('输入科目名称（留空清空）', '批量排课');
  const c = courses.value.find((c) => c.name === value);
  if (value && !c) return ElMessage.warning('科目不在本班目录');
  for (const p of layout.value?.points ?? []) if (selected.value.includes(p.id)) assign(p, c?.id || null);
}
function paste() {
  if (!plan.value || !layout.value) return;
  const points = layout.value.points.filter((p) => p.timeType === 'LESSON');
  for (const e of copied.value) {
    const source = copiedPoints.value.find((p) => p.id === e.timeLayoutItemId);
    const point = points.find(
      (p) =>
        p.id === e.timeLayoutItemId ||
        (source && p.startTime === source.startTime && p.endTime === source.endTime),
    );
    if (point) Object.assign(editEntry(point)!, { ...e, id: '', timeLayoutItemId: point.id });
  }
}
function copyPlan() {
  copied.value = JSON.parse(JSON.stringify(plan.value?.entries || []));
  copiedPoints.value = JSON.parse(JSON.stringify(layout.value?.points || []));
}
async function previousWeek() {
  if (!plan.value) return;
  const previous = await api.get<ContractActiveClassPlanWeekDto>('/schedules/active-week', {
    classId: classId.value,
    week: Math.max(1, week.value - 1),
  });
  const day = previous.days.find((day) => day.weekday === plan.value!.weekday);
  const p = day?.classPlan;
  if (p) {
    copied.value = p.entries;
    copiedPoints.value = day?.timeLayout?.points || [];
    paste();
  }
}
async function clonePlan() {
  if (plan.value) {
    const p = await api.post<ClassPlanDto>(`/class-plans/${plan.value.id}/clone`, {});
    await load();
    selectedPlan.value = p.id;
  }
}
async function schedule(overlay = false) {
  if (!plan.value) return;
  const { value } = await ElMessageBox.prompt('日期 YYYY-MM-DD', overlay ? '创建临时层' : '预定课表');
  await api.post(`/schedules/${overlay ? 'overlay' : 'scheduled'}`, {
    classId: classId.value,
    classPlanId: plan.value.id,
    date: value,
  });
  await load();
}
async function swap() {
  if (!plan.value || selected.value.length !== 2) return ElMessage.warning('请勾选两节课');
  const { value } = await ElMessageBox.prompt('换课日期 YYYY-MM-DD', '临时换课（原表保持）');
  await api.post('/schedules/swap', {
    classId: classId.value,
    classPlanId: plan.value.id,
    date: value,
    first: selected.value[0],
    second: selected.value[1],
  });
  await load();
}
async function exportPlan() {
  if (!plan.value) return;
  const value = await api.get(`/class-plans/${plan.value.id}/export`);
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${plan.value.name}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
async function importPlan(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file || !canWrite.value) return;
  (event.target as HTMLInputElement).value = '';
  if (!(await confirmDiscard())) return;
  clearDrafts();
  if (file.size > 8 * 1024 * 1024) return void ElMessage.warning('档案文件不能超过 8 MB');
  let value;
  try {
    value = JSON.parse(await file.text());
  } catch {
    return void ElMessage.error('JSON 格式不正确');
  }
  if (value.format === 'classhelper-class-plan') {
    await api.post('/class-plans/import', {
      plan: { ...value.plan, classId: classId.value },
      entries: value.plan.entries,
    });
  } else {
    await api.post('/class-plans/import/profile', { classId: classId.value, payload: value, mode: 'merge' });
  }
  await load();
}
async function newGroup() {
  const { value } = await ElMessageBox.prompt('群组名称', '新课表群组');
  await api.post('/class-plan-groups', { classId: classId.value, name: value });
  await load();
}
async function saveGroup(g: (typeof groups.value)[number]) {
  await api.put(`/class-plan-groups/${g.id}`, { ...g, classId: classId.value });
}
async function deleteGroup(id: string) {
  await api.delete(`/class-plan-groups/${id}`);
  await load();
}
let moving = '',
  target = '';
function dragStart(event: PointerEvent, id: string) {
  if (tab.value === 'layouts' ? !canTime.value : !canWrite.value) return;
  moving = id;
  target = id;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}
function dragMove(event: PointerEvent) {
  const row = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-point]');
  if (row) target = row.dataset.point || target;
}
function dragEnd() {
  if (moving && moving !== target && layout.value) {
    if (tab.value === 'layouts' && canTime.value) {
      const points = layout.value.points;
      const from = points.findIndex((p) => p.id === moving),
        to = points.findIndex((p) => p.id === target);
      if (from >= 0 && to >= 0) points.splice(to, 0, points.splice(from, 1)[0]!);
    } else {
      const a = layout.value.points.find((p) => p.id === moving),
        b = layout.value.points.find((p) => p.id === target);
      if (a && b) {
        const ea = editEntry(a),
          eb = editEntry(b);
        if (ea && eb) {
          const first = { ...ea },
            second = { ...eb };
          Object.assign(ea, second, { id: first.id, timeLayoutItemId: first.timeLayoutItemId });
          Object.assign(eb, first, { id: second.id, timeLayoutItemId: second.timeLayoutItemId });
        }
        // 保存按钮统一提交排序后的课程。
      }
    }
  }
  moving = '';
  target = '';
}
onMounted(async () => {
  document.documentElement.classList.add('archive-editor-open');
  window.addEventListener('beforeunload', beforeUnload);
  window.addEventListener('keydown', onShortcut);
  realtime.on(SOCKET_EVENTS.scheduleUpdated, onScheduleUpdated);
  try {
    classes.value = await classApi.list();
    classId.value = classes.value[0]?.id || '';
    if (classId.value) {
      const term = await dashboardApi.term(classId.value);
      maxWeek.value = term.maxWeek;
      week.value = Math.min(Math.max(term.currentWeek, 1), maxWeek.value);
      await load();
    }
  } catch {
    loadError.value = true;
  }
});
onUnmounted(() => {
  document.documentElement.classList.remove('archive-editor-open');
  loadRequest++;
  window.removeEventListener('beforeunload', beforeUnload);
  window.removeEventListener('keydown', onShortcut);
  realtime.off(SOCKET_EVENTS.scheduleUpdated, onScheduleUpdated);
});
onBeforeRouteLeave(() => confirmDiscard());
const sourceLayout = ref('');
watch(tab, () => {
  search.value = '';
  if (tab.value === 'plans' && plan.value) selectedLayout.value = plan.value.timeLayoutId;
});
const missingSubjects = computed(() =>
  SUBJECT_CATALOG.filter((name) => !courses.value.some((c) => c.name === name)),
);
async function addSubject(name: string) {
  if (!canWrite.value) return;
  try {
    const created = await courseApi.create({ classId: classId.value, name });
    courses.value.push(created);
  } catch (error) {
    if (!courseIdFromExistsError(error)) throw error;
    courses.value = await courseApi.list(classId.value);
  }
  ElMessage.success('科目已添加');
}
const lessonPoints = computed(() => layout.value?.points.filter((p) => p.timeType === 'LESSON') || []);
const currentPoint = computed(() => lessonPoints.value.find((p) => p.id === activePoint.value));
const visiblePlans = computed(() => plans.value.filter((p) => p.name.includes(search.value)));
const visibleLayouts = computed(() => layouts.value.filter((p) => p.name.includes(search.value)));
const tabs = [
  { id: 'plans', name: '课表' },
  { id: 'layouts', name: '时间表' },
  { id: 'subjects', name: '科目' },
  { id: 'groups', name: '调课' },
];
async function quickAssign(courseId: string) {
  if (!canWrite.value || !plan.value) return;
  const points = activeLessonPoints.value;
  const point = points.find((p) => p.id === activePoint.value) || points.find((p) => !entry(p)?.courseId);
  if (!point) return void ElMessage.info('请先选择课程，或在时间表中添加上课时间点');
  assign(point, courseId);
  if (autoAdvance.value) activePoint.value = points[points.indexOf(point) + 1]?.id || point.id;
  else activePoint.value = point.id;
}
async function deleteSelected() {
  const item = tab.value === 'layouts' ? layout.value : plan.value;
  if (!item) return;
  await ElMessageBox.confirm(`删除「${item.name}」？被课表引用的时间表不能删除。`, '删除', {
    type: 'warning',
  });
  await api.delete(`/${tab.value === 'layouts' ? 'time-layouts' : 'class-plans'}/${item.id}`);
  delete planBaseline.value[item.id];
  delete layoutBaseline.value[item.id];
  await load();
}
function changeLayout(value: string) {
  if (!plan.value) return;
  const old = layouts.value.find((l) => l.id === plan.value!.timeLayoutId);
  const next = layouts.value.find((l) => l.id === value);
  // 时间点通过时间与类型匹配，不能把原外键带进另一张时间表。
  plan.value.entries = plan.value.entries.flatMap((e) => {
    const oldPoint = old?.points.find((p) => p.id === e.timeLayoutItemId);
    const target = next?.points.find(
      (p) =>
        p.timeType === 'LESSON' && p.startTime === oldPoint?.startTime && p.endTime === oldPoint?.endTime,
    );
    return target ? [{ ...e, id: '', timeLayoutItemId: target.id }] : [];
  });
  plan.value.timeLayoutId = value;
  selectedLayout.value = value;
}
const sourceText = computed(() =>
  JSON.stringify(
    {
      className: classes.value.find((c) => c.id === classId.value)?.name,
      timeLayouts: layouts.value,
      classPlans: plans.value,
      courses: courses.value,
      groups: groups.value,
    },
    null,
    2,
  ),
);
async function exportArchive() {
  const profile = await api.get('/class-plans/profile', { classId: classId.value });
  const url = URL.createObjectURL(new Blob([JSON.stringify(profile, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${classes.value.find((c) => c.id === classId.value)?.name || '课表'}-档案.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// 工作区的编辑状态与服务端快照分开保存，避免切周或实时事件覆盖草稿。
const loading = ref(false),
  saving = ref(false),
  loadError = ref(false);
const viewMode = ref<'list' | 'week' | 'month'>('week');
const detailsVisible = ref(false),
  helpVisible = ref(false);
const autoAdvance = ref(true);
const selectedDay = ref(1);
const selectedDate = ref(dayKeyLocal(new Date()));
const maxWeek = ref(30);
const planBaseline = ref<Record<string, string>>({});
const layoutBaseline = ref<Record<string, string>>({});
const dirtyPlans = computed(() =>
  plans.value.filter((p) => planBaseline.value[p.id] && JSON.stringify(p) !== planBaseline.value[p.id]),
);
const dirtyLayouts = computed(() =>
  layouts.value.filter((p) => layoutBaseline.value[p.id] && JSON.stringify(p) !== layoutBaseline.value[p.id]),
);
const dirty = computed(() => dirtyPlans.value.length > 0 || dirtyLayouts.value.length > 0);
const activeLessonPoints = computed(
  () =>
    layouts.value
      .find((l) => l.id === plan.value?.timeLayoutId)
      ?.points.filter((p) => p.timeType === 'LESSON') || [],
);
const className = computed(() => classes.value.find((c) => c.id === classId.value)?.name || '未选择班级');
const subjectOrder = [
  '语文',
  '数学',
  '英语',
  '历史',
  '政治',
  '物理',
  '化学',
  '生物',
  '地理',
  '信息技术',
  '体育',
  '自习',
  '通用技术',
  '音乐',
  '美术',
  '选修',
  '社团',
  '心理',
  '早读',
  '班会',
  '测试',
];
const palette = computed(() =>
  [
    ...new Set([
      ...subjectOrder.filter(
        (name) => SUBJECT_CATALOG.includes(name) || courses.value.some((c) => c.name === name),
      ),
      ...courses.value.map((c) => c.name),
      ...SUBJECT_CATALOG,
    ]),
  ].map((name) => ({ name, course: courses.value.find((c) => c.name === name) })),
);
const initials: Record<string, string> = {
  信息技术: '信',
  通用技术: '技',
  自习: '自',
  心理: '心',
  早读: '早',
  晚读: '晚',
  听力: '听',
};
function subjectInitial(name: string) {
  return initials[name] || name.slice(0, 1);
}
const selectedCourseId = computed(() => planEntry(plan.value, activePoint.value)?.courseId);
async function pickSubject(name: string) {
  if (!canWrite.value || !plan.value || saving.value) return;
  let course = courses.value.find((c) => c.name === name);
  if (!course) {
    await addSubject(name);
    course = courses.value.find((c) => c.name === name);
  }
  if (course) await quickAssign(course.id);
}
const weekDays = computed(() => {
  const days = activeWeek.value?.days || [];
  return [7, 1, 2, 3, 4, 5, 6].map((day) => {
    const item = days.find((d) => d.weekday === day);
    // 服务端的周以周一开始；界面按 ClassIsland 的周日到周六排列。
    const date = item?.date || '';
    return {
      day,
      label: `周${'日一二三四五六'[day % 7]}`,
      date,
      shortDate: date ? `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}` : '',
    };
  });
});
type GridRow = {
  key: string;
  startTime: string;
  endTime: string;
  timeType: TimePointDto['timeType'];
  name: string;
};
function pointKey(p: Pick<TimePointDto, 'startTime' | 'endTime' | 'timeType'>) {
  return `${p.startTime}|${p.endTime}|${p.timeType}`;
}
const gridRows = computed(() => {
  const rows = new Map<string, GridRow>();
  for (const day of weekDays.value) {
    const l = layouts.value.find((l) => l.id === dayPlan(day.day)?.timeLayoutId);
    for (const p of l?.points || []) rows.set(pointKey(p), { ...p, key: pointKey(p) });
  }
  return [...rows.values()].sort(
    (a, b) => a.startTime.localeCompare(b.startTime) || a.endTime.localeCompare(b.endTime),
  );
});
function gridPoint(day: number, row: GridRow) {
  return layouts.value
    .find((l) => l.id === dayPlan(day)?.timeLayoutId)
    ?.points.find((p) => pointKey(p) === row.key);
}
function gridEntry(day: number, row: GridRow) {
  const point = gridPoint(day, row);
  return point ? planEntry(dayPlan(day), point.id) : undefined;
}
function courseName(id: string | null | undefined) {
  return courses.value.find((c) => c.id === id)?.name || '';
}
function selectCell(day: number, row?: GridRow) {
  const p = dayPlan(day);
  if (!p) return;
  selectedPlan.value = p.id;
  selectedDay.value = day;
  if (row) activePoint.value = gridPoint(day, row)?.id || '';
}
function isSelectedCell(day: number, row: GridRow) {
  return selectedDay.value === day && activePoint.value === gridPoint(day, row)?.id;
}
function clearCell() {
  if (!canWrite.value || !plan.value || !activePoint.value) return;
  const e = planEntry(plan.value, activePoint.value, true);
  if (e) e.courseId = null;
}
function moveCell(day: number, row: GridRow, event: KeyboardEvent) {
  if (event.key.toLowerCase() === 'delete' || event.key === 'Backspace') {
    event.preventDefault();
    selectCell(day, row);
    clearCell();
    return;
  }
  const offset = (
    { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] } as Record<
      string,
      number[]
    >
  )[event.key];
  if (!offset) return;
  event.preventDefault();
  const r = gridRows.value.indexOf(row) + offset[0]!;
  const d = weekDays.value.findIndex((d) => d.day === day) + offset[1]!;
  const nextRow = gridRows.value[r],
    nextDay = weekDays.value[d];
  if (nextRow && nextDay) {
    selectCell(nextDay.day, nextRow);
    document.querySelector<HTMLButtonElement>(`[data-cell="${nextDay.day}-${r}"]`)?.focus();
  }
}
async function changeDate(value: string | null) {
  if (!value || !classId.value) return;
  const scope = classId.value;
  const result = await api.get<{ week: number }>('/schedules/current', {
    classId: scope,
    at: new Date(`${value}T12:00:00`).toISOString(),
  });
  if (scope !== classId.value) return;
  week.value = Math.max(1, Math.min(result.week, maxWeek.value));
}
function shiftWeek(delta: number) {
  week.value = Math.max(1, Math.min(week.value + delta, maxWeek.value));
}
watch(activeWeek, (value) => {
  if (!value?.days.some((d) => d.date === selectedDate.value))
    selectedDate.value = value?.days.find((d) => d.weekday === 1)?.date || selectedDate.value;
});
const monthCells = computed(() => {
  const date = selectedDate.value;
  const first = `${date.slice(0, 7)}-01`;
  const weekday = new Date(`${first}T12:00:00`).getDay();
  return Array.from({ length: 42 }, (_, index) => {
    const key = shiftDayKey(first, index - weekday);
    const active = activeWeek.value?.days.find((d) => d.date === key);
    return {
      date: key,
      label: Number(key.slice(8)),
      muted: key.slice(0, 7) !== date.slice(0, 7),
      plan: active?.classPlan,
    };
  });
});
async function openCalendarDay(date: string) {
  selectedDate.value = date;
  await changeDate(date);
  viewMode.value = 'week';
}
function clearDrafts() {
  plans.value = [];
  layouts.value = [];
  activeWeek.value = undefined;
  planBaseline.value = {};
  layoutBaseline.value = {};
  selectedPlan.value = '';
  activePoint.value = '';
}
async function confirmDiscard() {
  if (saving.value) return false;
  if (!dirty.value) return true;
  try {
    await ElMessageBox.confirm('还有未保存的课表编辑，离开将放弃这些修改。', '未保存的修改', {
      confirmButtonText: '放弃修改',
      cancelButtonText: '继续编辑',
      type: 'warning',
    });
    return true;
  } catch {
    return false;
  }
}
async function changeClass(value: string) {
  if (value === classId.value || !(await confirmDiscard())) return;
  const request = ++loadRequest;
  clearDrafts();
  classId.value = value;
  loading.value = true;
  try {
    const term = await dashboardApi.term(value);
    if (request !== loadRequest || classId.value !== value) return;
    maxWeek.value = term.maxWeek;
    week.value = Math.min(Math.max(term.currentWeek, 1), maxWeek.value);
    await load();
  } catch {
    loadError.value = true;
    loading.value = false;
  }
}
async function onClassSelection(event: Event) {
  const input = event.target as HTMLSelectElement;
  const next = input.value;
  input.value = classId.value;
  await changeClass(next);
}
async function refresh() {
  if (!(await confirmDiscard())) return;
  clearDrafts();
  await load();
}
async function saveAll() {
  if (saving.value || loading.value) return;
  saving.value = true;
  try {
    if (canTime.value) for (const item of [...dirtyLayouts.value]) await persistLayout(item);
    if (canWrite.value) for (const item of [...dirtyPlans.value]) await persistPlan(item);
    await load();
    ElMessage.success('档案已保存');
  } catch (error) {
    if (error instanceof Error) ElMessage.error(error.message);
  } finally {
    saving.value = false;
  }
}
async function openImport() {
  if (!canWrite.value || !(await confirmDiscard())) return;
  // 导入取消时保留草稿；成功后再用服务端结果替换。
  importVisible.value = true;
}
async function imported() {
  clearDrafts();
  await load();
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (dirty.value) {
    event.preventDefault();
    event.returnValue = '';
  }
}
function onShortcut(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    void saveAll();
  }
}
function onScheduleUpdated() {
  if (!saving.value) void load();
}
async function leaveEditor() {
  await router.push('/dashboard');
}
function openDetails() {
  if (plan.value) detailsVisible.value = true;
}
function selectPlanItem(id: string) {
  selectedPlan.value = id;
  activePoint.value = '';
}
</script>
<template>
  <div class="archive-editor" aria-label="课表档案编辑器">
    <div class="archive-titlebar">
      <span>
        <ArchiveIcon name="archive" />
        档案编辑
      </span>
      <button class="command return-button" @click="leaveEditor">
        <ArchiveIcon name="back" />
        返回管理
      </button>
    </div>
    <header class="archive-header">
      <nav class="archive-tabs" aria-label="档案编辑导航">
        <button
          v-for="item in tabs"
          :key="item.id"
          :class="{ active: tab === item.id }"
          :aria-current="tab === item.id ? 'page' : undefined"
          :disabled="saving"
          @click="tab = item.id"
        >
          {{ item.name }}
        </button>
      </nav>
      <div class="archive-commands">
        <label class="class-picker">
          <ArchiveIcon name="file" />
          <select
            :value="classId"
            aria-label="选择班级"
            :disabled="loading || saving"
            @change="onClassSelection"
          >
            <option v-if="!classes.length" value="">未选择班级</option>
            <option v-for="c in classes" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
        </label>
        <button class="command archive-summary" title="查看档案内容" @click="tab = 'source'">
          <ArchiveIcon name="chart" />
          {{ dirty ? '未保存' : '已保存' }}
          <span v-if="dirty" class="unsaved-dot" />
        </button>
        <button class="command archive-group" @click="tab = 'groups'">
          <ArchiveIcon name="group" />
          {{ groups.find((g) => g.id === selectedGroup)?.name || '默认' }}
        </button>
        <span
          class="command archive-access"
          :title="canWrite ? '可以编辑所选班级的课表' : '当前班级课表仅可查看'"
        >
          <ArchiveIcon name="shield" />
          {{ canWrite ? '可编辑' : '只读' }}
        </span>
        <span class="command-separator" />
        <button
          class="command"
          :disabled="saving || loading || !dirty || (!canWrite && !canTime)"
          @click="saveAll"
        >
          <ArchiveIcon name="save" />
          {{ saving ? '保存中…' : '保存' }}
        </button>
        <el-popover placement="bottom-end" trigger="click" :width="240" popper-class="archive-menu">
          <template #reference>
            <button class="command">
              <ArchiveIcon name="transfer" />
              导入/导出
            </button>
          </template>
          <div class="transfer-menu">
            <el-button text :disabled="!canWrite || !classId" @click="openImport">
              导入 ClassIsland 档案
            </el-button>
            <el-button text :disabled="!canWrite || !classId" @click="fileInput?.click()">
              导入 JSON
            </el-button>
            <el-button text :disabled="!classId" @click="exportArchive">导出完整档案</el-button>
            <el-button text :disabled="!plan" @click="exportPlan">导出选中课表</el-button>
            <el-button text @click="tab = 'source'">文件预览</el-button>
          </div>
        </el-popover>
        <button class="command help-command" @click="helpVisible = true">
          <ArchiveIcon name="help" />
          帮助
        </button>
      </div>
    </header>

    <div class="archive-toolbar">
      <button class="command" :disabled="loading || saving || !classId" @click="refresh">
        <ArchiveIcon name="refresh" :class="{ spinning: loading }" />
        刷新
      </button>
      <span class="command-separator" />
      <span class="selection-label">
        {{ tab === 'layouts' ? layout?.name || '未选择时间表' : plan?.name || '未选择课表' }}
      </span>
      <template v-if="tab === 'plans' && plan">
        <button class="command" @click="openDetails">
          <ArchiveIcon name="settings" />
          详细信息
        </button>
        <button class="command optional-command" :disabled="!canWrite" @click="schedule(true)">
          创建临时层
        </button>
        <button class="command optional-command" :disabled="!canWrite" @click="deleteSelected">删除</button>
      </template>
      <span v-if="!canWrite && tab === 'plans'" class="readonly-label">只读</span>
      <span v-if="dirty" class="draft-label" role="status">有未保存的修改</span>
    </div>
    <div v-if="loadError" class="load-error" role="alert">
      档案加载失败，请检查连接。
      <button class="command" @click="load">重试</button>
    </div>
    <div v-if="!classId && !loading" class="workspace-empty">
      <ArchiveIcon name="archive" />
      <p>暂无可管理的班级</p>
      <button class="command" @click="leaveEditor">返回管理</button>
    </div>

    <div v-else-if="tab === 'plans'" class="schedule-workspace" :inert="saving">
      <main class="schedule-main" :aria-busy="loading">
        <div class="week-navigation">
          <el-date-picker
            :model-value="selectedDate"
            type="date"
            value-format="YYYY-MM-DD"
            format="YYYY/M/D"
            :clearable="false"
            :editable="false"
            aria-label="课表日期"
            @update:model-value="
              selectedDate = $event;
              changeDate($event);
            "
          />
          <button
            class="icon-command"
            aria-label="上一周"
            :disabled="week <= 1 || loading"
            @click="shiftWeek(-1)"
          >
            <ArchiveIcon name="left" />
          </button>
          <button
            class="icon-command"
            aria-label="下一周"
            :disabled="week >= maxWeek || loading"
            @click="shiftWeek(1)"
          >
            <ArchiveIcon name="right" />
          </button>
          <label class="week-picker">
            <select v-model="week" aria-label="选择教学周" :disabled="loading">
              <option v-for="w in maxWeek" :key="w" :value="w">第{{ w }}周</option>
            </select>
          </label>
          <template v-if="viewMode === 'list'">
            <el-select
              v-model="selectedPlan"
              placeholder="选择课表"
              aria-label="选择课表"
              filterable
              class="plan-picker"
            >
              <el-option v-for="p in visiblePlans" :key="p.id" :label="p.name" :value="p.id" />
            </el-select>
            <button class="command" :disabled="!canWrite" @click="newPlan()">
              <ArchiveIcon name="plus" />
              新课表
            </button>
          </template>
        </div>

        <div v-if="viewMode === 'week'" class="week-view">
          <div class="week-scroll">
            <table class="schedule-grid" aria-label="周课表">
              <colgroup>
                <col class="time-column" />
                <col v-for="day in weekDays" :key="day.day" />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col" class="time-heading">时间</th>
                  <th
                    v-for="day in weekDays"
                    :key="day.day"
                    scope="col"
                    :class="{ 'today-column': day.date === dayKeyLocal(new Date()) }"
                  >
                    <div class="day-heading">
                      <span>{{ day.label }}</span>
                      <span>{{ day.shortDate }}</span>
                    </div>
                    <button
                      v-if="dayPlan(day.day)"
                      class="day-plan"
                      :class="{ selected: selectedPlan === dayPlan(day.day)?.id && selectedDay === day.day }"
                      @click="selectCell(day.day)"
                    >
                      {{ dayPlan(day.day)?.name }}
                      <ArchiveIcon name="chevron" />
                    </button>
                    <button
                      v-else
                      class="new-day-plan"
                      :disabled="!canWrite || loading"
                      @click="newPlan(day.day)"
                    >
                      <ArchiveIcon name="plus" />
                      新课表
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="(row, index) in gridRows"
                  :key="row.key"
                  :class="{ 'non-lesson-row': row.timeType !== 'LESSON' }"
                >
                  <th scope="row" class="time-cell">
                    <span>{{ row.startTime }}</span>
                    <small v-if="row.timeType !== 'DIVIDER'">{{ row.endTime }}</small>
                  </th>
                  <td
                    v-for="day in weekDays"
                    :key="day.day"
                    :class="{
                      'selected-cell': isSelectedCell(day.day, row),
                      'disabled-cell': gridEntry(day.day, row)?.isEnabled === false,
                    }"
                  >
                    <button
                      v-if="gridPoint(day.day, row) && row.timeType === 'LESSON'"
                      class="lesson-cell"
                      :data-cell="`${day.day}-${index}`"
                      :aria-label="`${day.label} ${row.startTime} ${courseName(gridEntry(day.day, row)?.courseId) || '空课'}，点击编辑科目`"
                      :aria-pressed="isSelectedCell(day.day, row)"
                      @click="selectCell(day.day, row)"
                      @keydown="moveCell(day.day, row, $event)"
                    >
                      <strong>{{ courseName(gridEntry(day.day, row)?.courseId) || '—' }}</strong>
                      <small v-if="gridEntry(day.day, row)?.location">
                        {{ gridEntry(day.day, row)?.location }}
                      </small>
                      <small v-if="gridEntry(day.day, row)?.isEnabled === false">已停用</small>
                    </button>
                    <span v-else-if="gridPoint(day.day, row)" class="break-label">
                      {{
                        gridPoint(day.day, row)?.breakName ||
                        gridPoint(day.day, row)?.name ||
                        types[row.timeType]
                      }}
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
            <div v-if="!gridRows.length" class="grid-empty">
              <svg viewBox="0 0 64 64" fill="none" aria-hidden="true">
                <rect
                  x="7"
                  y="7"
                  width="50"
                  height="50"
                  rx="11"
                  stroke="currentColor"
                  stroke-width="3.5"
                  stroke-dasharray="11 10"
                  stroke-linecap="round"
                />
              </svg>
              <p v-if="!plans.length">这里还没有课表，不妨先点击上方的【新课表】按钮创建课表吧</p>
              <template v-else>
                <p>
                  {{
                    weekDays.some((d) => dayPlan(d.day)) ? '时间表还没有上课时间点' : '本周还没有启用的课表'
                  }}
                </p>
                <button class="command" @click="tab = 'layouts'">编辑时间表</button>
                <button class="command" @click="viewMode = 'list'">查看全部课表</button>
              </template>
            </div>
          </div>
        </div>
        <div v-else-if="viewMode === 'list'" class="list-view">
          <aside class="plan-explorer">
            <el-input v-model="search" placeholder="搜索课表" clearable />
            <button
              v-for="p in visiblePlans"
              :key="p.id"
              class="plan-item"
              :class="{ active: selectedPlan === p.id }"
              @click="selectPlanItem(p.id)"
            >
              <strong>{{ p.name }}</strong>
              <small>
                {{ p.weekday ? `星期${'一二三四五六日'[p.weekday - 1]}` : '任意星期' }} ·
                {{ p.weekCountDiv ? `${p.weekCountDivTotal} 周轮换 / 第 ${p.weekCountDiv} 周` : '每周'
                }}{{ p.isOverlay ? ' · 临时层' : '' }}{{ p.isEnabled ? '' : ' · 已停用' }}
              </small>
            </button>
            <button class="command" :disabled="!canWrite" @click="newPlan()">
              <ArchiveIcon name="plus" />
              新课表
            </button>
          </aside>
          <div class="daily-editor">
            <div v-if="!plan" class="panel-empty">
              <ArchiveIcon name="list" />
              <p>选择或新建一张课表开始编辑</p>
            </div>
            <template v-else>
              <header class="section-header">
                <h3>{{ plan.name }}</h3>
                <button class="command" @click="openDetails">详细信息</button>
              </header>
              <section class="course-list" aria-label="课程时段">
                <div
                  v-for="p in lessonPoints"
                  :key="p.id"
                  :data-point="p.id"
                  class="course-row"
                  tabindex="0"
                  @keydown.enter="activePoint = p.id"
                  :class="{ selected: activePoint === p.id }"
                  @click="activePoint = p.id"
                >
                  <el-checkbox
                    :model-value="selected.includes(p.id)"
                    :disabled="!canWrite"
                    :aria-label="`选择 ${p.startTime} 课程`"
                    @change="toggleSelected(p.id, $event)"
                  />
                  <button
                    class="drag"
                    :disabled="!canWrite"
                    aria-label="拖动交换课程"
                    @pointerdown="dragStart($event, p.id)"
                    @pointermove="dragMove"
                    @pointerup="dragEnd"
                    @pointercancel="
                      moving = '';
                      target = '';
                    "
                  >
                    ⠿
                  </button>
                  <div class="course-time">
                    <strong>{{ p.name || '课时' }}</strong>
                    <small>{{ p.startTime }}–{{ p.endTime }}</small>
                  </div>
                  <el-select
                    :model-value="entry(p)?.courseId"
                    :disabled="!canWrite"
                    clearable
                    placeholder="选择科目"
                    @change="assign(p, $event || null)"
                  >
                    <el-option v-for="c in courses" :key="c.id" :value="c.id" :label="c.name" />
                  </el-select>
                  <el-switch
                    :model-value="entry(p)?.isEnabled ?? true"
                    :disabled="!canWrite"
                    aria-label="启用课程"
                    @change="editEntry(p)!.isEnabled = Boolean($event)"
                  />
                  <el-input
                    :model-value="entry(p)?.location || ''"
                    :disabled="!canWrite"
                    placeholder="教室"
                    class="location-input"
                    @update:model-value="editEntry(p)!.location = $event"
                  />
                </div>
                <el-empty v-if="!lessonPoints.length" description="时间表还没有上课时间点" />
              </section>
              <div class="toolbar">
                <el-button :disabled="!canWrite" @click="batch">批量排课</el-button>
                <el-button @click="copyPlan">复制课程</el-button>
                <el-button :disabled="!canWrite || !copied.length" @click="paste">粘贴课程</el-button>
                <el-button :disabled="!canWrite" @click="previousWeek">复制上一周</el-button>
                <el-button :disabled="!canWrite" @click="clonePlan">克隆课表</el-button>
                <el-button @click="exportPlan">导出课表</el-button>
                <el-button :disabled="!canWrite" @click="fileInput?.click()">导入 JSON</el-button>
              </div>
              <div class="toolbar">
                <el-button :disabled="!canWrite" @click="swap">临时换课</el-button>
                <el-button :disabled="!canWrite" @click="schedule(false)">预定课表</el-button>
                <el-button :disabled="!canWrite" @click="schedule(true)">创建临时层</el-button>
                <el-button type="danger" plain :disabled="!canWrite" @click="deleteSelected">
                  删除课表
                </el-button>
              </div>
            </template>
          </div>
        </div>
        <div v-else class="month-view">
          <h3>{{ selectedDate.slice(0, 4) }} 年 {{ Number(selectedDate.slice(5, 7)) }} 月</h3>
          <div class="calendar-grid">
            <span
              v-for="day in ['日', '一', '二', '三', '四', '五', '六']"
              :key="day"
              class="calendar-heading"
            >
              周{{ day }}
            </span>
            <button
              v-for="cell in monthCells"
              :key="cell.date"
              :class="{ muted: cell.muted, active: cell.date === selectedDate }"
              @click="openCalendarDay(cell.date)"
            >
              <span>{{ cell.label }}</span>
              <small v-if="cell.plan">{{ cell.plan.name }}</small>
            </button>
          </div>
          <p class="month-hint">点击日期查看该周的生效课表</p>
        </div>
      </main>
      <aside class="subject-panel" aria-label="编辑科目">
        <h3>编辑科目</h3>
        <div class="subject-palette">
          <button
            v-for="s in palette"
            :key="s.name"
            :title="s.name"
            :aria-label="`填入${s.name}`"
            :aria-pressed="Boolean(s.course && selectedCourseId === s.course.id)"
            :class="{ active: s.course && selectedCourseId === s.course.id }"
            :disabled="!canWrite || !plan || saving"
            @click="pickSubject(s.name)"
          >
            {{ s.course?.initial || subjectInitial(s.name) }}
          </button>
        </div>
        <div v-if="currentPoint" class="selection-details">
          <span>{{ currentPoint.name }} {{ currentPoint.startTime }}–{{ currentPoint.endTime }}</span>
          <button class="command" :disabled="!canWrite" @click="clearCell">清空科目</button>
        </div>
        <label class="auto-advance">
          <input v-model="autoAdvance" type="checkbox" />
          <span>选完科目自动移动到下一个课程</span>
        </label>
      </aside>
    </div>

    <div v-else class="detail-workspace" :inert="saving">
      <aside v-if="tab === 'layouts'" class="resource-explorer">
        <el-input v-model="search" placeholder="搜索时间表" clearable />
        <button
          v-for="l in visibleLayouts"
          :key="l.id"
          class="plan-item"
          :class="{ active: selectedLayout === l.id }"
          @click="selectedLayout = l.id"
        >
          <strong>{{ l.name }}</strong>
          <small>{{ l.classId ? '班级时间表' : '全校时间表' }}</small>
        </button>
        <button class="command" :disabled="!canTime" @click="newLayout">
          <ArchiveIcon name="plus" />
          新时间表
        </button>
      </aside>
      <main class="detail-content">
        <template v-if="tab === 'layouts'">
          <header class="section-header">
            <h3>时间表编辑</h3>
            <el-button type="primary" :loading="saving" :disabled="!canTime || !layout" @click="saveLayout">
              保存时间表
            </el-button>
          </header>
          <div v-if="!layout" class="panel-empty">
            <ArchiveIcon name="clock" />
            <p>新建一份时间表开始编辑</p>
            <el-button :disabled="!canTime" @click="newLayout">＋ 新时间表</el-button>
          </div>
          <template v-else>
            <div class="settings-card">
              <div class="left-section">
                <strong>
                  <el-icon><Document /></el-icon>
                  时间表名称
                </strong>
                <small>保存后会同步到所有引用此表的课表</small>
              </div>
              <el-input v-model="layout.name" :disabled="!canTime" class="setting-control" />
            </div>
            <div class="settings-card">
              <div class="left-section">
                <strong>
                  <el-icon><Odometer /></el-icon>
                  快速时长
                </strong>
                <small>新建课时和课间时自动填充分钟数</small>
              </div>
              <div class="control-row">
                <span>课程</span>
                <el-input-number v-model="quickLessonMinutes" :min="1" :max="180" />
                <span>分钟</span>
                <span>课间</span>
                <el-input-number v-model="quickBreakMinutes" :min="1" :max="120" />
                <span>分钟</span>
              </div>
            </div>
            <div class="time-rows">
              <div
                v-for="(p, i) in layout.points"
                :key="p.id"
                :data-point="p.id"
                :data-type="p.timeType"
                class="time-row"
              >
                <button
                  class="drag"
                  :disabled="!canTime"
                  aria-label="拖动时间点"
                  @pointerdown="dragStart($event, p.id)"
                  @pointermove="dragMove"
                  @pointerup="dragEnd"
                  @pointercancel="
                    moving = '';
                    target = '';
                  "
                >
                  ⠿
                </button>
                <el-input v-model="p.name" :disabled="!canTime" placeholder="时间点名称" />
                <el-select v-model="p.timeType" :disabled="!canTime">
                  <el-option v-for="t in TIME_POINT_TYPES" :key="t" :value="t" :label="types[t]" />
                </el-select>
                <el-time-picker
                  v-model="p.startTime"
                  :disabled="!canTime"
                  value-format="HH:mm"
                  format="HH:mm"
                  placeholder="开始时间"
                  :clearable="false"
                />
                <el-time-picker
                  v-model="p.endTime"
                  :disabled="!canTime"
                  value-format="HH:mm"
                  format="HH:mm"
                  placeholder="结束时间"
                  :clearable="false"
                />
                <el-button :disabled="!canTime" type="danger" plain @click="layout.points.splice(i, 1)">
                  删除
                </el-button>
                <div class="time-extra">
                  <el-select
                    v-if="p.timeType === 'LESSON'"
                    v-model="p.defaultClassId"
                    :disabled="!canTime"
                    clearable
                    placeholder="默认科目"
                  >
                    <el-option v-for="c in courses" :key="c.id" :value="c.id" :label="c.name" />
                  </el-select>
                  <el-checkbox v-model="p.isHideDefault" :disabled="!canTime">默认隐藏</el-checkbox>
                  <el-input
                    v-if="p.timeType === 'BREAK'"
                    v-model="p.breakName"
                    :disabled="!canTime"
                    placeholder="课间名称"
                  />
                  <el-input
                    v-if="p.timeType === 'ACTION'"
                    v-model="p.actionSet"
                    :disabled="!canTime"
                    placeholder="行动 JSON（仅保存）"
                  />
                </div>
              </div>
            </div>
            <div class="toolbar">
              <el-button type="primary" plain :disabled="!canTime" @click="addPoint()">＋ 新建课时</el-button>
              <el-button :disabled="!canTime" @click="addPoint('BREAK')">＋ 新建课间</el-button>
              <el-button :disabled="!canTime" @click="addPoint('DIVIDER')">＋ 分割线</el-button>
              <el-button :disabled="!canTime" @click="addPoint('ACTION')">＋ 行动</el-button>
              <el-button :disabled="!canTime" @click="cloneLayout">克隆时间表</el-button>
              <el-button :disabled="!canTime" type="danger" plain @click="deleteSelected">
                删除时间表
              </el-button>
            </div>
            <div class="settings-card">
              <div class="left-section">
                <strong>
                  <el-icon><Upload /></el-icon>
                  从已有时间表导入
                </strong>
                <small>使用来源时间表的时间点替换当前内容</small>
              </div>
              <el-select v-model="sourceLayout" class="setting-control" placeholder="来源时间表">
                <el-option
                  v-for="l in layouts.filter((l) => l.id !== selectedLayout)"
                  :key="l.id"
                  :label="l.name"
                  :value="l.id"
                />
              </el-select>
              <el-button :disabled="!canTime || !sourceLayout" @click="importLayout">导入</el-button>
            </div>
          </template>
        </template>
        <template v-else-if="tab === 'subjects'">
          <h3>科目管理</h3>
          <p>任课关系在班级管理中设置，此处编辑科目的显示信息。</p>
          <el-select v-if="canWrite" placeholder="添加统一科目" class="setting-control" @change="addSubject">
            <el-option v-for="name in missingSubjects" :key="name" :label="name" :value="name" />
          </el-select>
          <div v-for="c in courses" :key="c.id" class="settings-card">
            <div class="left-section">
              <strong>{{ c.name }}</strong>
              <small>{{ c.teacher?.name || '尚未指定教师' }}</small>
            </div>
            <el-input
              v-model="c.initial"
              :disabled="!canWrite"
              class="setting-control"
              placeholder="科目简称"
              @change="api.patch(`/courses/${c.id}`, { initial: c.initial })"
            />
            <el-switch
              v-model="c.isOutDoor"
              :disabled="!canWrite"
              active-text="户外课程"
              @change="api.patch(`/courses/${c.id}`, { isOutDoor: c.isOutDoor })"
            />
          </div>
        </template>
        <template v-else-if="tab === 'groups'">
          <header class="section-header"><h3>调课与预定</h3></header>
          <div class="settings-card">
            <div class="left-section">
              <strong>选择课表</strong>
              <small>临时换课保留原课表，预定可指定某日使用的课表。</small>
            </div>
            <el-select v-model="selectedPlan" class="setting-control" placeholder="选择课表">
              <el-option v-for="p in plans" :key="p.id" :label="p.name" :value="p.id" />
            </el-select>
            <el-button
              :disabled="!canWrite || !plan"
              @click="
                tab = 'plans';
                viewMode = 'list';
              "
            >
              选择换课课程
            </el-button>
            <el-button :disabled="!canWrite || !plan" @click="schedule(false)">预定课表</el-button>
            <el-button :disabled="!canWrite || !plan" @click="schedule(true)">创建临时层</el-button>
          </div>
          <header class="section-header">
            <h3>群组与预定</h3>
            <el-button :disabled="!canWrite" @click="newGroup">新建群组</el-button>
          </header>
          <div v-for="g in groups" :key="g.id" class="settings-card">
            <el-input v-model="g.name" :disabled="!canWrite" />
            <el-checkbox v-model="g.isGlobal" :disabled="!canWrite">全局组</el-checkbox>
            <el-checkbox v-model="g.isDefault" :disabled="!canWrite">默认组</el-checkbox>
            <el-button :disabled="!canWrite" @click="saveGroup(g)">保存</el-button>
            <el-button :disabled="!canWrite" @click="deleteGroup(g.id)">删除</el-button>
          </div>
          <div class="settings-card">
            <div class="left-section"><strong>选定群组</strong></div>
            <el-select v-model="selectedGroup" clearable class="setting-control">
              <el-option v-for="g in groups" :key="g.id" :label="g.name" :value="g.id" />
            </el-select>
            <el-button :disabled="!canWrite" @click="selectGroup()">设为选定群组</el-button>
          </div>
          <div class="settings-card">
            <div class="left-section"><strong>临时群组</strong></div>
            <el-select v-model="temporaryGroup" class="setting-control">
              <el-option v-for="g in groups" :key="g.id" :label="g.name" :value="g.id" />
            </el-select>
            <el-date-picker
              v-model="expireTime"
              type="datetime"
              value-format="YYYY-MM-DDTHH:mm:ss"
              placeholder="过期时间"
            />
            <el-button :disabled="!canWrite || !temporaryGroup || !expireTime" @click="selectGroup(true)">
              临时切换
            </el-button>
          </div>
          <el-table :data="scheduled" empty-text="暂无预定课表">
            <el-table-column prop="date" label="日期" />
            <el-table-column prop="plan.name" label="课表" />
            <el-table-column label="操作">
              <template #default="{ row }">
                <el-button :disabled="!canWrite" link type="danger" @click="cancelScheduled(row.id)">
                  取消预定
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </template>
        <template v-if="tab === 'source'">
          <h3>文件预览</h3>
          <p>当前班级的课表档案。导出完整档案可保留轮换、群组和预定。</p>
          <el-input :model-value="sourceText" type="textarea" :rows="24" readonly />
        </template>
      </main>
    </div>
    <footer class="archive-footer">
      <nav v-if="tab === 'plans'" aria-label="课表视图">
        <button
          v-for="mode in [
            { id: 'list', name: '列表视图', icon: 'list' },
            { id: 'week', name: '周视图', icon: 'grid' },
            { id: 'month', name: '月视图', icon: 'calendar' },
          ] as const"
          :key="mode.id"
          class="icon-command"
          :title="mode.name"
          :aria-label="mode.name"
          :aria-pressed="viewMode === mode.id"
          :class="{ active: viewMode === mode.id }"
          @click="viewMode = mode.id"
        >
          <ArchiveIcon :name="mode.icon" />
        </button>
      </nav>
      <span v-if="loading" role="status">正在加载档案…</span>
      <span v-else-if="dirty" class="footer-draft">修改后点击保存 · Ctrl+S</span>
      <span v-else class="footer-class">{{ className }}</span>
    </footer>

    <input ref="fileInput" hidden type="file" accept=".json,application/json" @change="importPlan" />
    <el-dialog
      v-model="createVisible"
      title="新课表"
      width="460px"
      class="archive-dialog"
      :close-on-click-modal="false"
    >
      <el-form label-position="top" @submit.prevent="confirmCreate">
        <el-form-item label="课表名称"><el-input v-model="createName" maxlength="64" /></el-form-item>
        <el-form-item label="星期">
          <el-select v-model="createDay">
            <el-option v-for="day in 7" :key="day" :label="`星期${'一二三四五六日'[day - 1]}`" :value="day" />
          </el-select>
        </el-form-item>
        <el-form-item label="时间表">
          <el-select v-model="createLayout" placeholder="选择时间表">
            <el-option v-for="l in layouts" :key="l.id" :label="l.name" :value="l.id" />
          </el-select>
        </el-form-item>
        <div v-if="!layouts.length" class="create-hint">
          还没有时间表，请先添加上课时间点。
          <el-button
            :disabled="!canTime"
            @click="
              createVisible = false;
              tab = 'layouts';
              newLayout();
            "
          >
            新时间表
          </el-button>
        </div>
      </el-form>
      <template #footer>
        <el-button :disabled="saving" @click="createVisible = false">取消</el-button>
        <el-button
          type="primary"
          :disabled="!canWrite || !createName.trim() || !createLayout"
          :loading="saving"
          @click="confirmCreate"
        >
          创建课表
        </el-button>
      </template>
    </el-dialog>
    <el-drawer v-model="detailsVisible" title="课表详细信息" size="460px" class="archive-details">
      <template v-if="plan">
        <el-form :disabled="!canWrite || saving" label-position="top">
          <div class="settings-card">
            <div class="left-section">
              <strong>
                <el-icon><Document /></el-icon>
                课表名称
              </strong>
              <small>便于区分每天和不同轮换周的课程计划</small>
            </div>
            <el-input v-model="plan.name" class="setting-control" />
          </div>
          <div class="settings-card">
            <div class="left-section">
              <strong>
                <el-icon><Calendar /></el-icon>
                启用星期
              </strong>
              <small>选择此张课表的作用星期</small>
            </div>
            <el-select v-model="plan.weekday" class="setting-control">
              <el-option label="任意星期" :value="0" />
              <el-option
                v-for="day in 7"
                :key="day"
                :value="day"
                :label="`星期${'一二三四五六日'[day - 1]}`"
              />
            </el-select>
          </div>
          <div class="settings-card">
            <div class="left-section">
              <strong>
                <el-icon><Refresh /></el-icon>
                轮周设定
              </strong>
              <small>第 0 周表示每周使用，支持 1–9 周轮换</small>
            </div>
            <div class="control-row">
              <span>轮换周期</span>
              <el-input-number v-model="plan.weekCountDivTotal" :min="1" :max="9" />
              <span>使用第</span>
              <el-input-number v-model="plan.weekCountDiv" :min="0" :max="plan.weekCountDivTotal" />
              <span>周</span>
            </div>
          </div>
          <div class="settings-card">
            <div class="left-section">
              <strong>
                <el-icon><Calendar /></el-icon>
                生效周次
              </strong>
              <small>只在指定教学周区间使用</small>
            </div>
            <div class="control-row">
              <el-input-number v-model="plan.weekStart" :min="1" :max="plan.weekEnd" />
              <span>至</span>
              <el-input-number v-model="plan.weekEnd" :min="plan.weekStart" :max="maxWeek" />
            </div>
          </div>
          <div class="settings-card">
            <div class="left-section">
              <strong>
                <el-icon><Notebook /></el-icon>
                时间表模板
              </strong>
              <small>课程使用所选时间表的上课时间点</small>
            </div>
            <el-select :model-value="plan.timeLayoutId" class="setting-control" @change="changeLayout">
              <el-option v-for="l in layouts" :key="l.id" :label="l.name" :value="l.id" />
            </el-select>
            <el-button
              @click="
                selectedLayout = plan.timeLayoutId;
                tab = 'layouts';
              "
            >
              编辑时间表
            </el-button>
          </div>
          <div class="settings-card">
            <div class="left-section">
              <strong>
                <el-icon><Setting /></el-icon>
                启用与群组
              </strong>
              <small>预定和临时课表可覆盖默认计划</small>
            </div>
            <el-select
              v-model="plan.associatedGroup"
              clearable
              class="setting-control"
              placeholder="默认群组"
            >
              <el-option v-for="g in groups" :key="g.id" :value="g.id" :label="g.name" />
            </el-select>
            <el-switch v-model="plan.isEnabled" active-text="启用" />
          </div>
        </el-form>
        <el-button type="primary" :disabled="!canWrite" :loading="saving" @click="savePlan">
          保存课表
        </el-button>
      </template>
    </el-drawer>
    <el-dialog v-model="helpVisible" title="档案编辑帮助" width="520px">
      <div class="editor-help">
        <p>在每天上方点击「新课表」，选择时间表并创建日课表。</p>
        <p>点击网格里的课程，再点击右侧科目简称填入课程。勾选自动移动后，可连续录入。</p>
        <p>在「时间表」维护上课、课间、分割线和行动；在「详细信息」设置星期、轮换、周次和群组。</p>
        <p>「调课」提供临时换课、预定和群组切换。底部可切换列表、周、月视图。</p>
        <p>编辑完成点击「保存」或按 Ctrl+S。切换班级或离开前会提醒保存。</p>
      </div>
    </el-dialog>
    <ClassPlanImportDialog
      v-model="importVisible"
      :class-id="classId"
      :class-name="className"
      @imported="imported"
    />
  </div>
</template>

<style scoped>
/* 参照 ClassIsland 档案编辑：暖灰工作区、透明命令栏、青蓝选中线。 */
.archive-editor {
  --archive-bg: #302827;
  --archive-header: #241e1e;
  --archive-toolbar: #2e2828;
  --archive-control: #403a39;
  --archive-hover: #4a4342;
  --archive-border: #4a4241;
  --archive-text: #faf8f8;
  --archive-muted: #c7c0bf;
  --archive-accent: #48c3f6;
  --archive-selected: #344b57;
  --el-color-primary: var(--archive-accent);
  --el-bg-color: var(--archive-bg);
  --el-bg-color-overlay: var(--archive-control);
  --el-fill-color-blank: var(--archive-control);
  --el-fill-color-light: var(--archive-hover);
  --el-fill-color: var(--archive-control);
  --el-text-color-primary: var(--archive-text);
  --el-text-color-regular: var(--archive-text);
  --el-text-color-secondary: var(--archive-muted);
  --el-text-color-placeholder: var(--archive-muted);
  --el-border-color: var(--archive-border);
  --el-border-color-light: var(--archive-border);
  --el-border-color-lighter: var(--archive-border);
  --el-border-radius-base: 5px;
  position: fixed;
  inset: 0;
  z-index: 1800;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--archive-bg);
  color: var(--archive-text);
  font-family: 'Segoe UI', 'Microsoft YaHei UI', 'Microsoft YaHei', sans-serif;
  font-size: calc(15px * var(--ch-font-scale, 1));
  line-height: 1.5;
  color-scheme: dark;
}
.archive-editor * {
  box-sizing: border-box;
}
.archive-editor button,
.archive-editor select {
  font: inherit;
}
.archive-editor button {
  cursor: pointer;
}
.archive-editor button:disabled {
  cursor: default;
  opacity: 0.45;
}
.archive-editor button:focus-visible,
.archive-editor select:focus-visible,
.archive-editor input:focus-visible {
  outline: 2px solid var(--archive-accent);
  outline-offset: -2px;
}
.archive-titlebar {
  height: 36px;
  flex: 0 0 36px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  background: var(--archive-header);
  font-size: 13px;
}
.archive-titlebar > span {
  display: flex;
  align-items: center;
  gap: 9px;
  font-weight: 600;
}
.archive-titlebar .archive-icon {
  width: 18px;
  height: 18px;
}
.archive-titlebar .return-button {
  font-size: 12px;
  min-height: 30px;
  padding: 3px 8px;
}
.archive-header {
  display: flex;
  justify-content: space-between;
  align-items: stretch;
  gap: 14px;
  flex-shrink: 0;
  min-height: 68px;
  padding: 0 12px;
  background: var(--archive-header);
}
.archive-tabs {
  display: flex;
  gap: 24px;
  flex-shrink: 0;
}
.archive-tabs button {
  position: relative;
  border: 0;
  padding: 8px 0 14px;
  background: transparent;
  color: var(--archive-muted);
  font-size: clamp(22px, 1.8vw, 34px);
  white-space: nowrap;
}
.archive-tabs button.active {
  color: var(--archive-text);
}
.archive-tabs button.active::after {
  position: absolute;
  content: '';
  height: 3px;
  background: var(--archive-accent);
  bottom: 2px;
  left: 0;
  right: 0;
  border-radius: 2px;
}
.archive-commands {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}
.command,
.icon-command {
  display: inline-flex;
  justify-content: center;
  align-items: center;
  gap: 10px;
  border: 0;
  background: transparent;
  color: inherit;
  padding: 8px 12px;
  min-height: 40px;
  border-radius: 4px;
  white-space: nowrap;
  text-decoration: none;
}
.command:hover:not(:disabled),
.icon-command:hover:not(:disabled) {
  background: var(--archive-hover);
}
.icon-command {
  width: 44px;
  padding: 8px;
}
.command-separator {
  height: 35px;
  width: 1px;
  flex-shrink: 0;
  margin: 0 2px;
  background: var(--archive-border);
}
.class-picker {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 8px;
  min-width: 0;
}
.class-picker select,
.week-picker select {
  border: 0;
  background: transparent;
  color: inherit;
  padding: 8px 3px;
  cursor: pointer;
  max-width: 190px;
}
.class-picker option,
.week-picker option {
  background: var(--archive-control);
}
.unsaved-dot {
  width: 6px;
  height: 6px;
  background: var(--archive-accent);
  border-radius: 50%;
}
.archive-toolbar {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  gap: 7px;
  min-height: 52px;
  padding: 3px 8px;
  background: var(--archive-toolbar);
}
.selection-label {
  color: var(--archive-muted);
  padding: 0 7px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.draft-label,
.readonly-label {
  color: var(--archive-muted);
  font-size: 12px;
  margin-left: auto;
  margin-right: 14px;
  white-space: nowrap;
}
.load-error {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 14px;
  background: var(--archive-selected);
  color: var(--archive-text);
}
.schedule-workspace {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(290px, 27.5%);
  flex: 1;
  min-height: 0;
}
.schedule-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.week-navigation {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-shrink: 0;
  min-height: 44px;
  padding: 0 9px 4px 0;
}
.week-navigation :deep(.el-date-editor) {
  width: 185px;
  height: 40px;
  flex-shrink: 0;
}
.week-navigation :deep(.el-input__wrapper) {
  flex-direction: row-reverse;
  border-radius: 0 5px 5px 0;
  background: var(--archive-control);
  box-shadow: 0 0 0 1px var(--archive-border) inset;
  padding: 0 10px;
}
.week-navigation :deep(.el-input__inner) {
  font-size: 17px;
}
.week-navigation :deep(.el-input__prefix) {
  margin-left: 8px;
}
.week-picker select {
  font-size: 17px;
  font-weight: 600;
}
.plan-picker {
  width: 170px;
  margin-left: auto;
}
.week-view {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.week-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  position: relative;
  display: flex;
  flex-direction: column;
}
.schedule-grid {
  width: 100%;
  table-layout: fixed;
  border-collapse: separate;
  border-spacing: 0;
  text-align: center;
}
.schedule-grid .time-column {
  width: 10.7%;
}
.schedule-grid th,
.schedule-grid td {
  border-right: 1px solid var(--archive-border);
  border-bottom: 1px solid var(--archive-border);
  font-weight: 400;
}
.schedule-grid thead {
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--archive-control);
}
.schedule-grid thead th {
  padding: 2px 9px 7px;
  height: 72px;
}
.schedule-grid thead .time-heading {
  text-align: left;
  padding: 12px;
  color: var(--archive-muted);
}
.day-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  color: var(--archive-muted);
  font-size: 14px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.new-day-plan,
.day-plan {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  margin-top: 3px;
  padding: 5px;
  width: 100%;
  min-height: 37px;
  border: 1px solid var(--archive-border);
  background: var(--archive-hover);
  color: var(--archive-text);
  border-radius: 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.new-day-plan:hover:not(:disabled),
.day-plan:hover {
  background: var(--archive-control);
}
.day-plan {
  font-size: 13px;
  justify-content: space-between;
}
.day-plan .archive-icon {
  width: 14px;
  height: 14px;
}
.day-plan.selected {
  box-shadow: 0 -2px 0 var(--archive-accent) inset;
}
.today-column .day-heading {
  color: var(--archive-accent);
}
.time-cell {
  padding: 7px 10px;
  font-size: 14px;
  font-variant-numeric: tabular-nums;
  text-align: left;
  background: var(--archive-toolbar);
}
.time-cell span,
.time-cell small {
  display: block;
}
.time-cell small {
  font-size: 12px;
  color: var(--archive-muted);
}
.lesson-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-height: 69px;
  padding: 8px 5px;
  border: 0;
  background: transparent;
  color: var(--archive-text);
}
.lesson-cell strong {
  font-weight: 400;
  font-size: 17px;
}
.lesson-cell small {
  font-size: 12px;
  color: var(--archive-muted);
}
.lesson-cell:hover {
  background: var(--archive-hover);
}
.selected-cell {
  background: var(--archive-selected);
  box-shadow: 0 0 0 2px var(--archive-accent) inset;
}
.disabled-cell .lesson-cell strong {
  text-decoration: line-through;
  color: var(--archive-muted);
}
.non-lesson-row {
  background: var(--archive-toolbar);
}
.non-lesson-row td {
  height: 29px;
}
.non-lesson-row .time-cell {
  padding: 3px 10px;
}
.break-label {
  display: block;
  font-size: 12px;
  color: var(--archive-muted);
  padding: 4px;
}
.grid-empty {
  display: flex;
  flex: 1;
  min-height: 260px;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  padding: 30px 20px 65px;
  text-align: center;
}
.grid-empty svg {
  width: 66px;
  height: 66px;
  margin: 0 0 16px;
}
.grid-empty p {
  margin: 0;
  font-size: 16px;
}
.grid-empty .command {
  margin-top: 12px;
}
.subject-panel {
  display: flex;
  flex-direction: column;
  padding: 0 16px 12px;
  border-left: 7px solid var(--archive-border);
  min-width: 0;
  overflow: auto;
}
.subject-panel h3 {
  position: relative;
  align-self: flex-start;
  font-weight: 400;
  font-size: 18px;
  margin: 3px 0 8px;
  padding-bottom: 5px;
}
.subject-panel h3::after {
  content: '';
  position: absolute;
  left: 0;
  bottom: 0;
  right: 0;
  height: 3px;
  border-radius: 2px;
  background: var(--archive-accent);
}
.subject-palette {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 1px;
}
.subject-palette button {
  height: 53px;
  min-width: 0;
  border: 0;
  border-radius: 4px;
  font-size: calc(22px * var(--ch-font-scale, 1));
  color: var(--archive-text);
  background: transparent;
}
.subject-palette button:disabled {
  opacity: 1;
}
.subject-palette button:hover:not(:disabled) {
  background: var(--archive-hover);
}
.subject-palette button.active {
  background: var(--archive-selected);
  box-shadow: 0 -2px 0 var(--archive-accent) inset;
}
.selection-details {
  margin-top: 20px;
  font-size: 12px;
  color: var(--archive-muted);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
}
.auto-advance {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: auto;
  padding: 20px 0 8px;
  cursor: pointer;
  font-size: 15px;
}
.auto-advance input {
  appearance: none;
  width: 25px;
  height: 25px;
  flex-shrink: 0;
  background: var(--archive-control);
  border: 1px solid var(--archive-muted);
  border-radius: 6px;
  margin: 0;
  display: grid;
  place-content: center;
  cursor: pointer;
}
.auto-advance input:checked {
  background: var(--archive-accent);
  border-color: var(--archive-accent);
}
.auto-advance input:checked::after {
  content: '';
  width: 11px;
  height: 6px;
  border-left: 1.5px solid var(--archive-header);
  border-bottom: 1.5px solid var(--archive-header);
  transform: rotate(-45deg) translateY(-1px);
}
.archive-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 36px;
  flex: 0 0 36px;
  padding: 0 8px;
  color: var(--archive-muted);
  font-size: 12px;
}
.archive-footer nav {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 100%;
}
.archive-footer .icon-command {
  position: relative;
  min-height: 32px;
  height: 32px;
  width: 40px;
}
.archive-footer .archive-icon {
  width: 16px;
  height: 16px;
}
.archive-footer .active {
  color: var(--archive-text);
}
.archive-footer .active::after {
  content: '';
  position: absolute;
  height: 3px;
  left: 13px;
  right: 13px;
  bottom: 0;
  border-radius: 3px;
  background: var(--archive-accent);
}
.footer-class {
  opacity: 0.65;
}
.detail-workspace,
.list-view {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.resource-explorer,
.plan-explorer {
  width: 240px;
  flex: 0 0 240px;
  padding: 10px;
  border-right: 1px solid var(--archive-border);
  overflow: auto;
}
.plan-explorer {
  width: 205px;
  flex-basis: 205px;
}
.plan-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  width: 100%;
  text-align: left;
  padding: 10px;
  gap: 4px;
  margin-top: 5px;
  background: transparent;
  border: 0;
  border-radius: 4px;
  color: var(--archive-text);
}
.plan-item small {
  color: var(--archive-muted);
  font-size: 12px;
}
.plan-item.active {
  background: var(--archive-selected);
  box-shadow: 3px 0 0 var(--archive-accent) inset;
}
.plan-item:hover {
  background: var(--archive-hover);
}
.detail-content,
.daily-editor {
  flex: 1;
  min-width: 0;
  overflow: auto;
  padding: 20px;
}
.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 15px;
}
.section-header h3,
.detail-content h3 {
  margin: 0;
  font-size: 20px;
  font-weight: 500;
}
.detail-content > p {
  color: var(--archive-muted);
}
.settings-card {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding: 15px 0;
  border-bottom: 1px solid var(--archive-border);
}
.left-section {
  flex: 1;
  min-width: 180px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.left-section strong {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 400;
}
.left-section small {
  color: var(--archive-muted);
}
.setting-control {
  width: 210px;
}
.control-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
.control-row :deep(.el-input-number) {
  width: 110px;
}
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 16px;
}
.toolbar :deep(.el-button + .el-button) {
  margin-left: 0;
}
.course-list {
  display: flex;
  flex-direction: column;
}
.course-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 5px;
  border-bottom: 1px solid var(--archive-border);
}
.course-row.selected {
  background: var(--archive-selected);
}
.course-row .el-select {
  flex: 1;
  min-width: 100px;
}
.course-time {
  display: flex;
  flex-direction: column;
  min-width: 95px;
}
.course-time small {
  color: var(--archive-muted);
  font-size: 12px;
}
.location-input {
  width: 95px;
}
.drag {
  color: var(--archive-muted);
  border: 0;
  background: transparent;
  padding: 7px 3px;
  cursor: grab;
  touch-action: none;
}
.time-row {
  display: grid;
  grid-template-columns: 30px minmax(90px, 1fr) 130px 140px 140px 65px;
  gap: 10px;
  padding: 12px 0;
  align-items: center;
  border-bottom: 1px solid var(--archive-border);
}
.time-row > .el-input,
.time-row > .el-select,
.time-row :deep(.el-date-editor) {
  width: 100%;
}
.time-extra {
  grid-column: 2 / -1;
  display: flex;
  align-items: center;
  gap: 14px;
}
.time-extra .el-select,
.time-extra .el-input {
  width: 220px;
}
.panel-empty,
.workspace-empty {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  min-height: 300px;
  color: var(--archive-muted);
}
.workspace-empty {
  flex: 1;
}
.panel-empty > .archive-icon,
.workspace-empty > .archive-icon {
  width: 48px;
  height: 48px;
}
.month-view {
  flex: 1;
  overflow: auto;
  padding: 12px 20px;
}
.month-view h3 {
  margin: 0 0 15px;
  font-weight: 400;
}
.calendar-grid {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
}
.calendar-heading {
  text-align: center;
  padding: 8px;
  color: var(--archive-muted);
}
.calendar-grid button {
  display: flex;
  align-items: flex-start;
  flex-direction: column;
  gap: 5px;
  min-height: 70px;
  padding: 9px;
  border: 1px solid var(--archive-border);
  background: transparent;
  color: var(--archive-text);
}
.calendar-grid button:hover {
  background: var(--archive-hover);
}
.calendar-grid button.active {
  box-shadow: 0 0 0 2px var(--archive-accent) inset;
}
.calendar-grid button.muted {
  color: var(--archive-muted);
  opacity: 0.5;
}
.calendar-grid small {
  font-size: 11px;
}
.month-hint {
  color: var(--archive-muted);
  font-size: 12px;
}
.create-hint {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
}
.editor-help p {
  margin-bottom: 18px;
  line-height: 1.8;
}
.transfer-menu {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 3px;
}
.transfer-menu .el-button {
  margin-left: 0;
  justify-content: flex-start;
}
.archive-editor :deep(.el-dialog) {
  max-width: calc(100vw - 32px);
}
.archive-editor :deep(.el-select) {
  --el-select-input-font-size: 14px;
}
.archive-editor :deep(.el-button--primary) {
  --el-button-text-color: var(--archive-header);
  --el-button-hover-text-color: var(--archive-header);
}
.spinning {
  animation: archive-spin calc(var(--ch-dur-slow, 320ms) * 3) linear infinite;
}
@keyframes archive-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (min-width: 1800px) {
  .archive-editor {
    font-size: calc(23px * var(--ch-font-scale, 1));
  }
  .archive-titlebar {
    height: 56px;
    flex-basis: 56px;
    font-size: 16px;
  }
  .archive-header {
    min-height: 96px;
    padding: 0 16px;
  }
  .archive-tabs {
    gap: 36px;
  }
  .archive-tabs button {
    font-size: 40px;
  }
  .archive-toolbar {
    min-height: 80px;
  }
  .week-navigation {
    min-height: 60px;
  }
  .week-navigation :deep(.el-date-editor) {
    width: 245px;
    height: 50px;
  }
  .week-navigation :deep(.el-input__inner),
  .week-picker select {
    font-size: 22px;
  }
  .icon-command {
    width: 60px;
  }
  .command {
    gap: 14px;
    padding: 10px 14px;
  }
  .command .archive-icon {
    width: 27px;
    height: 27px;
  }
  .schedule-grid thead th {
    height: 104px;
  }
  .day-heading {
    font-size: 20px;
  }
  .new-day-plan {
    min-height: 49px;
  }
  .subject-panel h3 {
    font-size: 27px;
  }
  .subject-palette button {
    height: 74px;
    font-size: 30px;
  }
  .auto-advance,
  .grid-empty p {
    font-size: 26px;
  }
  .auto-advance input {
    width: 32px;
    height: 32px;
  }
  .grid-empty svg {
    width: 104px;
    height: 104px;
    margin-bottom: 23px;
  }
  .grid-empty {
    padding-bottom: 20px;
  }
  .archive-footer {
    height: 54px;
    flex-basis: 54px;
  }
}
@media (max-width: 1150px) {
  .archive-summary,
  .archive-access,
  .archive-group {
    display: none;
  }
  .archive-tabs {
    gap: 20px;
  }
  .archive-header {
    min-height: 60px;
  }
  .archive-tabs button {
    font-size: 24px;
  }
  .schedule-workspace {
    grid-template-columns: minmax(0, 1fr) 270px;
  }
  .subject-panel {
    padding: 0 10px 10px;
  }
  .subject-palette {
    grid-template-columns: repeat(6, minmax(0, 1fr));
  }
  .auto-advance {
    font-size: 13px;
    gap: 7px;
  }
  .time-row {
    grid-template-columns: 25px minmax(90px, 1fr) 100px 110px 110px 65px;
  }
  .list-view {
    flex-direction: column;
  }
  .plan-explorer {
    width: 100%;
    flex: 0 0 155px;
    border-right: 0;
    border-bottom: 1px solid var(--archive-border);
  }
}
@media (max-width: 768px) {
  .archive-header {
    flex-wrap: wrap;
    gap: 0;
    padding: 0 10px;
  }
  .archive-tabs {
    height: 52px;
    gap: 24px;
  }
  .archive-tabs button {
    font-size: 23px;
    padding-bottom: 9px;
  }
  .archive-commands {
    justify-content: space-between;
    width: 100%;
    padding: 4px 0;
  }
  .archive-commands .command {
    padding: 6px 8px;
    gap: 6px;
    font-size: 13px;
  }
  .class-picker {
    padding: 0;
    gap: 4px;
  }
  .class-picker select {
    max-width: 140px;
    font-size: 13px;
  }
  .help-command,
  .archive-commands .command-separator,
  .optional-command,
  .draft-label {
    display: none;
  }
  .archive-toolbar {
    min-height: 42px;
  }
  .archive-toolbar .command {
    font-size: 13px;
    padding: 5px;
  }
  .schedule-workspace {
    display: flex;
    flex-direction: column;
  }
  .schedule-main {
    flex: 1;
  }
  .week-navigation {
    gap: 0;
  }
  .week-navigation :deep(.el-date-editor) {
    width: 145px;
  }
  .week-navigation :deep(.el-input__inner),
  .week-picker select {
    font-size: 14px;
  }
  .week-navigation .icon-command {
    width: 37px;
  }
  .week-scroll {
    overflow: auto;
  }
  .schedule-grid {
    min-width: 760px;
  }
  .grid-empty {
    width: 100%;
    min-height: 220px;
    padding: 20px;
  }
  .grid-empty p {
    font-size: 14px;
    max-width: 300px;
  }
  .subject-panel {
    flex: 0 0 auto;
    border-left: 0;
    border-top: 3px solid var(--archive-border);
    padding: 4px 10px 7px;
    max-height: 205px;
  }
  .subject-panel h3 {
    font-size: 14px;
    margin: 0 0 3px;
  }
  .subject-palette {
    grid-template-columns: repeat(10, minmax(0, 1fr));
  }
  .subject-palette button {
    height: 35px;
    font-size: 18px;
  }
  .auto-advance {
    padding: 6px 0 0;
    font-size: 12px;
  }
  .auto-advance input {
    width: 21px;
    height: 21px;
  }
  .selection-details {
    display: none;
  }
  .archive-footer {
    flex-basis: 32px;
    height: 32px;
    font-size: 11px;
  }
  .detail-workspace {
    flex-direction: column;
  }
  .resource-explorer {
    width: 100%;
    flex: 0 0 145px;
    border-right: 0;
    border-bottom: 1px solid var(--archive-border);
  }
  .detail-content,
  .daily-editor {
    padding: 12px;
  }
  .time-row {
    grid-template-columns: 20px minmax(80px, 1fr) 100px;
  }
  .time-extra {
    grid-column: 1 / -1;
    flex-wrap: wrap;
  }
  .course-row {
    gap: 7px;
    flex-wrap: wrap;
  }
  .course-time {
    min-width: 75px;
  }
  .plan-picker {
    width: 130px;
  }
  .week-navigation > .command {
    font-size: 0;
    padding: 4px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .spinning {
    animation: none;
  }
}
</style>

<style>
/* 弹窗与下拉会挂到 body，编辑器打开期间为其提供同一套颜色。 */
html.archive-editor-open {
  --archive-bg: #302827;
  --archive-control: #403a39;
  --archive-hover: #4a4342;
  --archive-border: #4a4241;
  --archive-text: #faf8f8;
  --archive-muted: #c7c0bf;
  --archive-accent: #48c3f6;
}
.archive-editor-open .el-popper,
.archive-editor-open .el-dialog,
.archive-editor-open .el-drawer,
.archive-editor-open .el-message-box {
  --el-color-primary: var(--archive-accent);
  --el-bg-color: var(--archive-bg);
  --el-bg-color-overlay: var(--archive-control);
  --el-fill-color-blank: var(--archive-control);
  --el-fill-color-light: var(--archive-hover);
  --el-text-color-primary: var(--archive-text);
  --el-text-color-regular: var(--archive-text);
  --el-text-color-secondary: var(--archive-muted);
  --el-text-color-placeholder: var(--archive-muted);
  --el-border-color: var(--archive-border);
  --el-border-color-light: var(--archive-border);
  --el-border-color-lighter: var(--archive-border);
  --el-border-radius-base: 5px;
  color-scheme: dark;
}
.archive-editor-open .archive-details .settings-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 0;
  border-bottom: 1px solid var(--archive-border);
}
.archive-editor-open .archive-details .left-section {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.archive-editor-open .archive-details .left-section strong {
  display: flex;
  align-items: center;
  gap: 8px;
}
.archive-editor-open .archive-details .left-section small {
  color: var(--archive-muted);
}
.archive-editor-open .archive-details .control-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.archive-editor-open .archive-details .el-input-number {
  width: 118px;
}
.archive-editor-open .archive-details .setting-control {
  width: 100%;
}
.archive-editor-open .archive-details .el-form + .el-button {
  margin-top: 18px;
}
.archive-editor-open .el-dialog {
  max-width: calc(100vw - 24px);
}
.archive-editor-open .el-drawer {
  max-width: 100vw;
}
</style>
