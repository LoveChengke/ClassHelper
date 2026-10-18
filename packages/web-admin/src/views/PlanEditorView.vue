<script setup lang="ts">
import type { ActiveClassPlanWeekDto as ContractActiveClassPlanWeekDto } from '@classhelper/shared';

import { computed, onMounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  TIME_POINT_TYPES,
  SUBJECT_CATALOG,
  type ClassPlanDto,
  type TimeLayoutDetailDto,
  type TimePointDto,
  type ClassDto,
  type CourseDto,
} from '@classhelper/shared';
import { api } from '@/api/http';
import { classApi, courseApi } from '@/api';
import { useAuthStore } from '@/stores/auth';
import ClassPlanImportDialog from '@/components/ClassPlanImportDialog.vue';
const auth = useAuthStore();
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
function gridEntry(day: number, point: TimePointDto) {
  const p = dayPlan(day);
  if (!p) return;
  const l = layouts.value.find((l) => l.id === p.timeLayoutId);
  const slot = l?.points.find(
    (s) => s.startTime === point.startTime && s.endTime === point.endTime && s.timeType === 'LESSON',
  );
  return p.entries.find((e) => e.timeLayoutItemId === slot?.id);
}
async function setGrid(day: number, point: TimePointDto, value: string | null) {
  const p = dayPlan(day);
  if (!p) return;
  const l = layouts.value.find((l) => l.id === p.timeLayoutId),
    slot = l?.points.find(
      (s) => s.startTime === point.startTime && s.endTime === point.endTime && s.timeType === 'LESSON',
    );
  if (!slot) return;
  let e = p.entries.find((e) => e.timeLayoutItemId === slot.id);
  if (!e) {
    e = {
      id: '',
      timeLayoutItemId: slot.id,
      courseId: null,
      isEnabled: true,
      isChangedClass: false,
      location: null,
    };
    p.entries.push(e);
  }
  e.courseId = value;
  await api.put(`/class-plans/${p.id}/entries`, { entries: p.entries });
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
  if (!classId.value) return;
  const maximum = classes.value.find((c) => c.id === classId.value)?.termWeeks || 60;
  if (week.value > maximum) {
    week.value = maximum;
    return;
  }
  const request = ++loadRequest,
    scope = { classId: classId.value, week: week.value };
  const [ls, ps, cs, gs, ss, active, selection] = await Promise.all([
    api.get<TimeLayoutDetailDto[]>('/time-layouts', { classId: scope.classId }),
    api.get<ClassPlanDto[]>('/class-plans', { classId: scope.classId }),
    courseApi.list(scope.classId),
    api.get<typeof groups.value>('/class-plan-groups', { classId: scope.classId }),
    api.get<typeof scheduled.value>('/schedules/scheduled', { classId: scope.classId }),
    api.get<ContractActiveClassPlanWeekDto>('/schedules/active-week', scope),
    api.get<{ selected?: string; temporary?: string; expireTime?: string }>('/class-plan-groups/selection', {
      classId: scope.classId,
    }),
  ]);
  if (request !== loadRequest) return;
  layouts.value = ls;
  plans.value = ps;
  courses.value = cs;
  groups.value = gs;
  scheduled.value = ss;
  activeWeek.value = active;
  for (const d of active.days)
    if (d.classPlan && !plans.value.some((p) => p.id === d.classPlan!.id)) plans.value.push(d.classPlan);
  selectedGroup.value = selection.selected || '';
  temporaryGroup.value = selection.temporary || '';
  if (!plans.value.some((p) => p.id === selectedPlan.value))
    selectedPlan.value = active.days.find((d) => d.classPlan)?.classPlan?.id || plans.value[0]?.id || '';
  if (!layouts.value.some((p) => p.id === selectedLayout.value))
    selectedLayout.value = plan.value?.timeLayoutId || layouts.value[0]?.id || '';
}
watch([classId, week], () => void load());
watch(selectedPlan, () => {
  selected.value = [];
  if (plan.value) selectedLayout.value = plan.value.timeLayoutId;
});
const quickLessonMinutes = ref(45),
  quickBreakMinutes = ref(10);
function addMinutes(time: string, minutes: number): string {
  const [hour, minute] = time.split(':').map(Number);
  const total = ((hour ?? 0) * 60 + (minute ?? 0) + minutes) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
function addPoint(type: 'LESSON' | 'BREAK' = 'LESSON') {
  if (!layout.value) return;
  const points = layout.value.points;
  const previous = points[points.length - 1];
  // 与 CsesWebEditor 的快速时长一致：从上一时段结束处继续排，课程和课间共用输入。
  const minutes = type === 'BREAK' ? quickBreakMinutes.value : quickLessonMinutes.value;
  let startTime = previous?.endTime || '08:00';
  let endTime = addMinutes(startTime, minutes);
  // 上一时段已经排到午夜：跨天的结束时间不合法，新时段从当天零点开始。
  if (endTime <= startTime) {
    startTime = '00:00';
    endTime = addMinutes(startTime, minutes);
  }
  const lessonCount = points.filter((point) => point.timeType === 'LESSON').length;
  points.push({
    id: `draft-${crypto.randomUUID()}`,
    name: type === 'LESSON' ? `第 ${lessonCount + 1} 节` : '课间',
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
  const { value } = await ElMessageBox.prompt('输入时间表名称', '新时间表');
  const result = await api.post<TimeLayoutDetailDto>('/time-layouts', {
    name: value,
    classId: null,
    points: [],
  });
  selectedLayout.value = result.id;
  await load();
}
async function saveLayout() {
  if (layout.value) {
    await api.put(`/time-layouts/${layout.value.id}`, {
      ...layout.value,
      points: layout.value.points.map((p) => ({
        ...p,
        id: p.id.startsWith('draft-') ? undefined : p.id || undefined,
      })),
    });
    await load();
    ElMessage.success('时间表已保存，所有引用课表同步生效');
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
async function newPlan() {
  if (!layout.value) {
    ElMessage.warning('请先选择时间表');
    return;
  }
  const { value } = await ElMessageBox.prompt('课表名称', '新日课表');
  const p = await api.post<ClassPlanDto>('/class-plans', {
    name: value,
    classId: classId.value,
    timeLayoutId: layout.value.id,
    weekday: 1,
    weekCountDiv: 0,
    weekCountDivTotal: 4,
    weekEnd: classes.value.find((c) => c.id === classId.value)?.termWeeks || 30,
  });
  await load();
  selectedPlan.value = p.id;
}
async function savePlan() {
  if (plan.value) {
    await api.put(`/class-plans/${plan.value.id}`, plan.value);
    await saveEntries();
    await load();
  }
}
async function saveEntries() {
  if (plan.value) {
    await api.put(`/class-plans/${plan.value.id}/entries`, { entries: plan.value.entries });
    ElMessage.success('整张日课表已保存');
  }
}
function entry(point: TimePointDto) {
  if (!plan.value) return;
  let e = plan.value.entries.find((e) => e.timeLayoutItemId === point.id);
  if (!e) {
    e = {
      id: '',
      timeLayoutItemId: point.id,
      courseId: null,
      isEnabled: true,
      isChangedClass: false,
      location: null,
    };
    plan.value.entries.push(e);
  }
  return e;
}
function assign(point: TimePointDto, value: string | null) {
  const e = entry(point);
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
    if (point) Object.assign(entry(point)!, { ...e, id: '', timeLayoutItemId: point.id });
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
  if (!file) return;
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
        const ea = entry(a),
          eb = entry(b);
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
  classes.value = await classApi.list();
  classId.value = classes.value[0]?.id || '';
});

const sourceLayout = ref('');watch(tab, (value) => {
  if (value === 'plans' && plan.value) selectedLayout.value = plan.value.timeLayoutId;
});
const missingSubjects = computed(() =>
  SUBJECT_CATALOG.filter((name) => !courses.value.some((c) => c.name === name)),
);
async function addSubject(name: string) {
  const created = await courseApi.create({ classId: classId.value, name });
  courses.value.push(created);
  ElMessage.success('科目已添加');
}
const lessonPoints = computed(() => layout.value?.points.filter((p) => p.timeType === 'LESSON') || []);
const currentPoint = computed(() => lessonPoints.value.find((p) => p.id === activePoint.value));
const visiblePlans = computed(() => plans.value.filter((p) => p.name.includes(search.value)));
const visibleLayouts = computed(() => layouts.value.filter((p) => p.name.includes(search.value)));
const tabs = [
  { id: 'plans', name: '课程表' },
  { id: 'layouts', name: '时间表' },
  { id: 'subjects', name: '科目' },
  { id: 'groups', name: '群组与预定' },
  { id: 'preview', name: '整周预览' },
  { id: 'source', name: '文件预览' },
];
function quickAssign(courseId: string) {
  const point = currentPoint.value || lessonPoints.value.find((p) => !entry(p)?.courseId);
  if (!point) return void ElMessage.info('请在时间表中添加课时，或先选择要替换的课程');
  assign(point, courseId);
  const next = lessonPoints.value[lessonPoints.value.indexOf(point) + 1];
  activePoint.value = next?.id || '';
}
async function deleteSelected() {
  const item = tab.value === 'layouts' ? layout.value : plan.value;
  if (!item) return;
  await ElMessageBox.confirm(`删除「${item.name}」？被课表引用的时间表不能删除。`, '删除', {
    type: 'warning',
  });
  await api.delete(`/${tab.value === 'layouts' ? 'time-layouts' : 'class-plans'}/${item.id}`);
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
</script>
<template>
  <div class="page archive-editor">
    <header class="page-header">
      <div>
        <h2 class="page-title">课表档案</h2>
        <p>在一个工作区管理课程表、时间表与科目。</p>
      </div>
      <div class="toolbar">
        <el-select v-model="classId" aria-label="选择班级" placeholder="选择班级">
          <el-option v-for="c in classes" :key="c.id" :value="c.id" :label="c.name" />
        </el-select>
        <el-button :disabled="!canWrite" @click="importVisible = true">导入档案</el-button>
        <el-button :disabled="!classId" @click="exportArchive">导出完整档案</el-button>
        <el-button @click="load">刷新</el-button>
      </div>
    </header>
    <el-empty v-if="!classId" description="暂无可管理的班级" />
    <div v-else class="editor-workspace">
      <aside class="explorer">
        <h3>档案管理</h3>
        <nav class="editor-nav" aria-label="档案编辑导航">
          <button
            v-for="item in tabs"
            :key="item.id"
            :class="{ active: tab === item.id }"
            @click="
              tab = item.id;
              search = '';
            "
          >
            {{ item.name }}
          </button>
        </nav>
        <el-input
          v-if="tab === 'plans' || tab === 'layouts'"
          v-model="search"
          clearable
          placeholder="搜索名称"
        />
        <div v-if="tab === 'plans'" class="explorer-list">
          <button
            v-for="p in visiblePlans"
            :key="p.id"
            :class="{ active: selectedPlan === p.id }"
            @click="
              selectedPlan = p.id;
              activePoint = '';
            "
          >
            <strong>{{ p.name }}</strong>
            <small>
              {{ p.weekday ? `星期${'一二三四五六日'[p.weekday - 1]}` : '任意星期' }} ·
              {{ p.weekCountDiv ? `${p.weekCountDivTotal} 周轮换 / 第 ${p.weekCountDiv} 周` : '每周'
              }}{{ p.isOverlay ? ' · 临时层' : '' }}
            </small>
          </button>
          <el-button :disabled="!canWrite || !layout" @click="newPlan">＋ 新建课程表</el-button>
          <el-button
            :disabled="!canTime"
            @click="
              tab = 'layouts';
              newLayout();
            "
          >
            ＋ 新建时间表
          </el-button>
        </div>
        <div v-else-if="tab === 'layouts'" class="explorer-list">
          <button
            v-for="l in visibleLayouts"
            :key="l.id"
            :class="{ active: selectedLayout === l.id }"
            @click="selectedLayout = l.id"
          >
            <strong>{{ l.name }}</strong>
            <small>{{ l.classId ? '班级时间表' : '全校时间表' }}</small>
          </button>
          <el-button :disabled="!canTime" @click="newLayout">＋ 新建时间表</el-button>
        </div>
        <div v-else-if="tab === 'subjects'" class="explorer-list">
          <div v-for="c in courses" :key="c.id" class="subject-label">
            {{ c.name }}
            <small>{{ c.teacher?.name }}</small>
          </div>
        </div>
      </aside>
      <main class="editor-area">
        <template v-if="tab === 'plans'">
          <header class="section-header">
            <h3>课表编辑</h3>
            <el-button v-if="plan" type="primary" :disabled="!canWrite" @click="savePlan">保存课表</el-button>
          </header>
          <el-empty v-if="!plan" description="先创建时间表，再添加课程表" />
          <template v-else>
            <el-form :disabled="!canWrite" label-position="top">
              <div class="settings-card">
                <div class="left-section">
                  <strong><el-icon><Document /></el-icon>课表名称</strong>
                  <small>便于区分每天和不同轮换周的课程计划</small>
                </div>
                <el-input v-model="plan.name" class="setting-control" />
              </div>
              <div class="settings-card">
                <div class="left-section">
                  <strong><el-icon><Calendar /></el-icon>启用星期</strong>
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
                  <strong><el-icon><Refresh /></el-icon>轮周设定</strong>
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
                  <strong><el-icon><Calendar /></el-icon>生效周次</strong>
                  <small>只在指定教学周区间使用</small>
                </div>
                <div class="control-row">
                  <el-input-number v-model="plan.weekStart" :min="1" :max="plan.weekEnd" />
                  <span>至</span>
                  <el-input-number
                    v-model="plan.weekEnd"
                    :min="plan.weekStart"
                    :max="classes.find((c) => c.id === classId)?.termWeeks || 60"
                  />
                </div>
              </div>
              <div class="settings-card">
                <div class="left-section">
                  <strong><el-icon><Notebook /></el-icon>时间表模板</strong>
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
                  <strong><el-icon><Setting /></el-icon>启用与群组</strong>
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
            <div class="editor-layout">
              <section class="course-list" aria-label="课程时段">
                <div
                  v-for="p in lessonPoints"
                  :key="p.id"
                  :data-point="p.id"
                  class="course-row"
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
                    :model-value="entry(p)?.isEnabled"
                    :disabled="!canWrite"
                    aria-label="启用课程"
                    @change="entry(p)!.isEnabled = Boolean($event)"
                  />
                  <el-input
                    :model-value="entry(p)?.location || ''"
                    :disabled="!canWrite"
                    placeholder="教室"
                    class="location-input"
                    @update:model-value="entry(p)!.location = $event"
                  />
                </div>
                <el-empty v-if="!lessonPoints.length" description="时间表还没有上课时间点" />
              </section>
              <aside class="quick-add-panel">
                <h3>快速添加课程</h3>
                <p>点击科目填入选中的课时，完成后自动选择下一节。</p>
                <div class="subject-grid">
                  <el-button
                    v-for="c in courses"
                    :key="c.id"
                    :disabled="!canWrite"
                    @click="quickAssign(c.id)"
                  >
                    {{ c.name }}
                  </el-button>
                </div>
              </aside>
            </div>
            <div class="toolbar">
              <el-button :disabled="!canWrite" @click="batch">批量排课</el-button>
              <el-button @click="copyPlan">复制课程</el-button>
              <el-button :disabled="!canWrite || !copied.length" @click="paste">粘贴课程</el-button>
              <el-button :disabled="!canWrite" @click="previousWeek">复制上一周</el-button>
              <el-button :disabled="!canWrite" @click="clonePlan">克隆课表</el-button>
              <el-button @click="exportPlan">导出课表</el-button>
              <el-button :disabled="!canWrite" @click="fileInput?.click()">导入 JSON</el-button>
              <input ref="fileInput" hidden type="file" accept=".json" @change="importPlan" />
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
        </template>
        <template v-else-if="tab === 'layouts'">
          <header class="section-header">
            <h3>时间表编辑</h3>
            <el-button type="primary" :disabled="!canTime || !layout" @click="saveLayout">
              保存时间表
            </el-button>
          </header>
          <el-empty v-if="!layout" description="新建一份时间表开始编辑" />
          <template v-else>
            <div class="settings-card">
              <div class="left-section">
                <strong><el-icon><Document /></el-icon>时间表名称</strong>
                <small>保存后会同步到所有引用此表的课表</small>
              </div>
              <el-input v-model="layout.name" :disabled="!canTime" class="setting-control" />
            </div>
            <div class="settings-card">
              <div class="left-section">
                <strong><el-icon><Odometer /></el-icon>快速时长</strong>
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
              <el-button :disabled="!canTime" @click="cloneLayout">克隆时间表</el-button>
              <el-button :disabled="!canTime" type="danger" plain @click="deleteSelected">
                删除时间表
              </el-button>
            </div>
            <div class="settings-card">
              <div class="left-section">
                <strong><el-icon><Upload /></el-icon>从已有时间表导入</strong>
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
        <template v-else-if="tab === 'preview'">
          <header class="section-header">
            <h3>整周课表预览</h3>
            <div class="toolbar">
              <el-button :disabled="week <= 1" @click="week--">上一周</el-button>
              <strong>第 {{ week }} 周</strong>
              <el-button
                :disabled="week >= (classes.find((c) => c.id === classId)?.termWeeks || 60)"
                @click="week++"
              >
                下一周
              </el-button>
            </div>
          </header>
          <el-select v-model="selectedLayout" class="setting-control" placeholder="选择时间轴">
            <el-option v-for="l in layouts" :key="l.id" :value="l.id" :label="l.name" />
          </el-select>
          <el-table :data="lessonPoints" class="week-grid">
            <el-table-column label="时间" width="140">
              <template #default="{ row }">{{ row.startTime }}–{{ row.endTime }}</template>
            </el-table-column>
            <el-table-column
              v-for="day in 7"
              :key="day"
              :label="`星期${'一二三四五六日'[day - 1]}`"
              min-width="150"
            >
              <template #default="{ row }">
                <el-select
                  v-if="dayPlan(day)"
                  :model-value="gridEntry(day, row)?.courseId"
                  :disabled="!canWrite"
                  clearable
                  @change="setGrid(day, row, $event || null)"
                >
                  <el-option v-for="c in courses" :key="c.id" :label="c.name" :value="c.id" />
                </el-select>
                <el-button
                  v-if="dayPlan(day)"
                  link
                  @click="
                    selectedPlan = dayPlan(day)!.id;
                    tab = 'plans';
                  "
                >
                  编辑此日
                </el-button>
                <span v-else>未排课</span>
              </template>
            </el-table-column>
          </el-table>
        </template>
        <template v-else>
          <h3>文件预览</h3>
          <p>当前档案包含的时间点、课表和科目信息。</p>
          <el-input :model-value="sourceText" type="textarea" :rows="24" readonly />
        </template>
      </main>
    </div>
    <ClassPlanImportDialog
      v-model="importVisible"
      :class-id="classId"
      :class-name="classes.find((c) => c.id === classId)?.name"
      @imported="load"
    />
  </div>
</template>
<style scoped>
.archive-editor {
  min-width: 0;
}
.page-header,
.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
h3 {
  margin: 0 0 16px;
}
p,
small {
  color: var(--el-text-color-secondary);
  line-height: 1.5;
}
.toolbar,
.control-row,
.time-extra {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.toolbar {
  margin-block: 14px;
}
.toolbar > .el-select {
  width: 210px;
}
.toolbar :deep(.el-button + .el-button),
.subject-grid :deep(.el-button + .el-button),
.explorer-list :deep(.el-button + .el-button) {
  margin-left: 0;
}
.editor-workspace {
  display: grid;
  grid-template-columns: 250px minmax(0, 1fr);
  min-height: 640px;
  border: 1px solid var(--ch-border);
  border-radius: 12px;
  overflow: hidden;
  background: var(--ch-surface);
}
.explorer {
  padding: 20px 12px;
  background: var(--ch-surface-alt);
  border-right: 1px solid var(--ch-border);
  min-width: 0;
}
.editor-nav {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px;
  margin-bottom: 16px;
}
.editor-nav button,
.explorer-list > button {
  border: 1px solid transparent;
  background: transparent;
  color: var(--ch-text);
  text-align: left;
  border-radius: 6px;
  padding: 10px;
  font: inherit;
  cursor: pointer;
}
.editor-nav button.active,
.explorer-list > button.active {
  background: var(--el-color-primary-light-9);
  border-color: var(--el-color-primary-light-7);
  color: var(--el-color-primary);
}
.explorer-list {
  display: grid;
  gap: 6px;
  margin-top: 12px;
}
.explorer-list > button {
  width: 100%;
  white-space: normal;
  overflow-wrap: anywhere;
}
.explorer-list small,
.subject-label small {
  display: block;
  margin-top: 5px;
  font-size: 12px;
}
.subject-label {
  padding: 10px;
}
.editor-area {
  padding: 24px;
  min-width: 0;
  overflow-x: auto;
}
.settings-card {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 14px;
  padding: 16px;
  border: 1px solid var(--ch-border);
  border-radius: 6px;
  background: var(--ch-surface);
  margin-bottom: 8px;
}
.left-section {
  flex: 1 1 190px;
  min-width: 0;
  display: grid;
  gap: 6px;
}
.left-section strong {
  display: flex;
  align-items: center;
  gap: 8px;
}
.left-section .el-icon {
  color: var(--el-color-primary);
  flex-shrink: 0;
}
.setting-control {
  width: 230px;
  max-width: 100%;
}
.editor-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 210px;
  gap: 18px;
  margin-top: 24px;
}
.course-list {
  min-width: 0;
  display: grid;
  align-content: start;
  gap: 8px;
  max-height: clamp(280px, 52vh, 540px);
  overflow-y: auto;
  padding-right: 4px;
}
.course-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 12px;
  border: 1px solid var(--ch-border);
  border-radius: 6px;
  cursor: pointer;
}
.course-row.selected {
  border-color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
}
.course-time {
  min-width: 110px;
  display: grid;
  gap: 5px;
}
.course-row .el-select {
  flex: 1 1 130px;
}
.location-input {
  width: 110px;
}
.quick-add-panel {
  padding: 16px;
  background: var(--ch-surface-alt);
  border-radius: 6px;
}
.subject-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.subject-grid .el-button {
  white-space: normal;
  height: auto;
  min-height: 36px;
}
.time-rows {
  display: grid;
  gap: 8px;
  margin-top: 20px;
}
.time-row {
  display: grid;
  grid-template-columns: 32px minmax(120px, 1fr) 150px 140px 140px auto;
  gap: 12px;
  align-items: center;
  padding: 14px;
  border: 1px solid var(--ch-border);
  border-radius: 6px;
}
.time-row :deep(.el-date-editor) {
  width: 100%;
  min-width: 0;
}
.time-extra {
  grid-column: 2 / -1;
}
.time-extra .el-select,
.time-extra .el-input {
  width: 210px;
}
.drag {
  touch-action: none;
  cursor: grab;
  border: 1px solid var(--ch-border);
  border-radius: 5px;
  background: var(--ch-surface);
  color: var(--ch-text);
  padding: 8px;
}
.week-grid {
  margin-top: 20px;
}
@media (max-width: 1250px) {
  .editor-layout {
    grid-template-columns: minmax(0, 1fr);
  }
  .subject-grid {
    grid-template-columns: repeat(auto-fit, minmax(90px, 1fr));
  }
  .time-row {
    grid-template-columns: 32px minmax(100px, 1fr) 140px;
  }
  .time-extra {
    grid-column: 1 / -1;
  }
}
@media (max-width: 760px) {
  .editor-workspace {
    grid-template-columns: minmax(0, 1fr);
  }
  .explorer {
    border-right: 0;
    border-bottom: 1px solid var(--ch-border);
  }
  .explorer-list {
    max-height: 200px;
    overflow-y: auto;
  }
  .editor-nav {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .editor-area {
    padding: 14px;
  }
  .settings-card .setting-control,
  .settings-card > .el-input {
    width: 100%;
  }
  .control-row {
    width: 100%;
  }
  .control-row :deep(.el-input-number) {
    width: 120px;
  }
}
</style>
