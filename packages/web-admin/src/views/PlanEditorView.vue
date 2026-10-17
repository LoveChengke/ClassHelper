<script setup lang="ts">
import type { ActiveClassPlanWeekDto as ContractActiveClassPlanWeekDto } from '@classhelper/shared';

import { computed, onMounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  TIME_POINT_TYPES,
  type ClassPlanDto,
  type TimeLayoutDetailDto,
  type TimePointDto,
  type ClassDto,
  type CourseDto,
} from '@classhelper/shared';
import { api } from '@/api/http';
import { classApi, courseApi } from '@/api';
import { useAuthStore } from '@/stores/auth';
import { useResponsive } from '@/composables/useResponsive';
const auth = useAuthStore();
const { isMobile } = useResponsive();
const canTime = computed(() => auth.permissions.includes('timetable:manage'));
const canWrite = computed(() => auth.permissions.includes('schedule:write'));
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
    api.get<ClassPlanDto[]>('/class-plans', scope),
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
function addPoint() {
  layout.value?.points.push({
    id: '',
    name: '',
    startTime: '08:00',
    endTime: '08:45',
    timeType: 'LESSON',
    position: layout.value.points.length,
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
      points: layout.value.points.map((p) => ({ ...p, id: p.id || undefined })),
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
  const { value } = await ElMessageBox.prompt('输入来源时间表 ID（见选择框）', '从另一份时间表导入');
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
  });
  await load();
  selectedPlan.value = p.id;
}
async function savePlan() {
  if (plan.value) {
    await api.put(`/class-plans/${plan.value.id}`, plan.value);
    await saveEntries();
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
async function batch() {
  const { value } = await ElMessageBox.prompt('输入科目名称（留空清空）', '批量排课');
  const c = courses.value.find((c) => c.name === value);
  if (value && !c) return ElMessage.warning('科目不在本班目录');
  for (const p of layout.value?.points ?? []) if (selected.value.includes(p.id)) assign(p, c?.id || null);
}
function paste() {
  if (!plan.value || !layout.value) return;
  const points = layout.value.points.filter((p) => p.timeType === 'LESSON');
  for (const [i, e] of copied.value.entries()) {
    const point = points[i];
    if (point) Object.assign(entry(point)!, { ...e, id: '', timeLayoutItemId: point.id });
  }
}
async function previousWeek() {
  if (!plan.value) return;
  const previous = await api.get<ClassPlanDto[]>('/class-plans', {
    classId: classId.value,
    week: Math.max(1, week.value - 1),
  });
  const p = previous.find(
    (p) =>
      p.weekday === plan.value!.weekday &&
      (p.weekCountDiv === 0 || ((week.value - 2) % p.weekCountDivTotal) + 1 === p.weekCountDiv),
  );
  if (p) {
    copied.value = p.entries;
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
  URL.revokeObjectURL(url);
}
async function importPlan(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const value = JSON.parse(await file.text());
  if (value.format === 'classhelper-class-plan') {
    await api.post('/class-plans/import', {
      plan: { ...value.plan, classId: classId.value },
      entries: value.plan.entries,
    });
  } else {
    await api.post('/imports/class-plan', { classId: classId.value, payload: value, mode: 'merge' });
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
  if (!canWrite.value) return;
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
        if (ea && eb) [ea.courseId, eb.courseId] = [eb.courseId, ea.courseId];
        void saveEntries();
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
</script>
<template>
  <div class="page-container">
    <h2>时间表与日课表编辑</h2>
    <div class="toolbar">
      <el-select v-model="classId" placeholder="班级">
        <el-option v-for="c in classes" :key="c.id" :value="c.id" :label="c.name" />
      </el-select>
      <el-button :disabled="week <= 1" @click="week--">上一周</el-button>
      <span>第 {{ week }} 周</span>
      <el-button :disabled="week >= (classes.find((c) => c.id === classId)?.termWeeks || 60)" @click="week++">
        下一周
      </el-button>
    </div>
    <el-tabs v-model="tab">
      <el-tab-pane label="日课表" name="plans">
        <div class="toolbar">
          <el-select v-model="selectedPlan" placeholder="选择日课表">
            <el-option
              v-for="p in plans"
              :key="p.id"
              :value="p.id"
              :label="`${p.name} · 星期${p.weekday || '任意'}`"
            />
          </el-select>
          <el-button :disabled="!canWrite" @click="newPlan">新日课表</el-button>
          <el-button :disabled="!plan || !canWrite" @click="clonePlan">克隆</el-button>
          <el-button :disabled="!plan" @click="exportPlan">导出</el-button>
          <label v-if="canWrite">
            导入 JSON
            <input type="file" accept="application/json" @change="importPlan" />
          </label>
        </div>
        <el-card class="table-card">
          <h3>星期 × 时间点</h3>
          <el-table :data="layout?.points.filter((p) => p.timeType === 'LESSON') || []">
            <el-table-column label="时间" width="140">
              <template #default="{ row }">{{ row.startTime }}–{{ row.endTime }}</template>
            </el-table-column>
            <el-table-column v-for="day in 7" :key="day" :label="`星期${day}`" min-width="140">
              <template #default="{ row }">
                <el-select
                  v-if="dayPlan(day)"
                  :model-value="gridEntry(day, row)?.courseId"
                  :disabled="!canWrite"
                  clearable
                  @change="setGrid(day, row, $event)"
                >
                  <el-option v-for="c in courses" :key="c.id" :label="c.name" :value="c.id" />
                </el-select>
                <el-button v-if="dayPlan(day)" link @click="selectedPlan = dayPlan(day)!.id">
                  编辑此日
                </el-button>
                <span v-else>未排课</span>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
        <el-card v-if="plan">
          <el-form :inline="!isMobile">
            <el-form-item label="名称"><el-input v-model="plan.name" /></el-form-item>
            <el-form-item label="星期（0 任意）">
              <el-input-number v-model="plan.weekday" :min="0" :max="7" />
            </el-form-item>
            <el-form-item label="轮换第几周（0 不轮换）">
              <el-input-number v-model="plan.weekCountDiv" :min="0" :max="9" />
            </el-form-item>
            <el-form-item label="共几周">
              <el-input-number v-model="plan.weekCountDivTotal" :min="1" :max="9" />
            </el-form-item>
            <el-form-item label="时间表">
              <el-select
                v-model="plan.timeLayoutId"
                @change="
                  selectedLayout = plan.timeLayoutId;
                  plan.entries = [];
                "
              >
                <el-option v-for="l in layouts" :key="l.id" :label="l.name" :value="l.id" />
              </el-select>
            </el-form-item>
            <el-form-item label="群组">
              <el-select v-model="plan.associatedGroup" clearable>
                <el-option v-for="g in groups" :key="g.id" :value="g.id" :label="g.name" />
              </el-select>
            </el-form-item>
            <el-switch v-model="plan.isEnabled" active-text="默认启用" />
          </el-form>
          <div class="toolbar" v-if="canWrite">
            <el-button @click="batch">多选批量</el-button>
            <el-button @click="copied = JSON.parse(JSON.stringify(plan.entries))">复制</el-button>
            <el-button @click="paste">粘贴</el-button>
            <el-button @click="previousWeek">复制自前一周同一天</el-button>
            <el-button @click="swap">换课</el-button>
            <el-button @click="schedule(false)">预定</el-button>
            <el-button @click="schedule(true)">临时层</el-button>
            <el-button type="primary" @click="savePlan">保存日课表</el-button>
          </div>
          <div class="table-card">
            <table class="editor-table">
              <thead>
                <tr>
                  <th>选择 / 拖动</th>
                  <th>时间点</th>
                  <th>科目</th>
                  <th>启用</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="p in layout?.points.filter((p) => p.timeType === 'LESSON')"
                  :key="p.id"
                  :data-point="p.id"
                >
                  <td>
                    <input type="checkbox" v-model="selected" :value="p.id" />
                    <button
                      class="drag"
                      @pointerdown="dragStart($event, p.id)"
                      @pointermove="dragMove"
                      @pointerup="dragEnd"
                      @pointercancel="dragEnd"
                    >
                      拖动
                    </button>
                  </td>
                  <td>{{ p.name }} {{ p.startTime }}–{{ p.endTime }}</td>
                  <td>
                    <el-select
                      :model-value="entry(p)?.courseId"
                      :disabled="!canWrite"
                      clearable
                      @change="assign(p, $event)"
                    >
                      <el-option v-for="c in courses" :key="c.id" :value="c.id" :label="c.name" />
                    </el-select>
                  </td>
                  <td>
                    <el-switch
                      v-if="entry(p)"
                      :model-value="entry(p)!.isEnabled"
                      @change="entry(p)!.isEnabled = Boolean($event)"
                    />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </el-card>
      </el-tab-pane>
      <el-tab-pane label="时间表" name="layouts">
        <div class="toolbar">
          <el-select v-model="selectedLayout">
            <el-option v-for="l in layouts" :key="l.id" :label="`${l.name} (${l.id})`" :value="l.id" />
          </el-select>
          <el-button :disabled="!canTime" @click="newLayout">新建</el-button>
          <el-button :disabled="!canTime || !layout" @click="cloneLayout">克隆</el-button>
          <el-button :disabled="!canTime || !layout" @click="importLayout">从另一份导入</el-button>
        </div>
        <el-card v-if="layout" class="table-card">
          <el-input v-model="layout.name" :disabled="!canTime" />
          <table class="editor-table">
            <thead>
              <tr>
                <th>排序</th>
                <th>名称 / 类型</th>
                <th>起止</th>
                <th>默认课 / 隐藏 / 课间名</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(p, i) in layout.points" :key="p.id || i" :data-point="p.id" :data-type="p.timeType">
                <td>
                  <button
                    class="drag"
                    @pointerdown="dragStart($event, p.id)"
                    @pointermove="dragMove"
                    @pointerup="dragEnd"
                  >
                    拖动
                  </button>
                </td>
                <td>
                  <el-input v-model="p.name" />
                  <el-select v-model="p.timeType">
                    <el-option v-for="t in TIME_POINT_TYPES" :key="t" :value="t" :label="types[t]" />
                  </el-select>
                </td>
                <td>
                  <el-time-select v-model="p.startTime" start="00:00" end="23:59" step="00:05" />
                  <el-time-select v-model="p.endTime" start="00:00" end="23:59" step="00:05" />
                </td>
                <td>
                  <el-select v-model="p.defaultClassId" clearable placeholder="默认科目">
                    <el-option v-for="c in courses" :key="c.id" :value="c.id" :label="c.name" />
                  </el-select>
                  <el-checkbox v-model="p.isHideDefault">默认隐藏</el-checkbox>
                  <el-input v-model="p.breakName" placeholder="课间名称" />
                  <el-input
                    v-if="p.timeType === 'ACTION'"
                    v-model="p.actionSet"
                    placeholder="行动 JSON（不执行）"
                  />
                </td>
                <td><el-button :disabled="!canTime" @click="layout.points.splice(i, 1)">删除</el-button></td>
              </tr>
            </tbody>
          </table>
          <el-button :disabled="!canTime" @click="addPoint">添加时间点</el-button>
          <el-button type="primary" :disabled="!canTime" @click="saveLayout">保存时间表</el-button>
        </el-card>
      </el-tab-pane>
      <el-tab-pane label="群组与科目" name="groups">
        <el-button :disabled="!canWrite" @click="newGroup">新群组</el-button>
        <div v-for="g in groups" :key="g.id" class="toolbar">
          <el-input v-model="g.name" />
          <el-checkbox v-model="g.isGlobal">全局组</el-checkbox>
          <el-checkbox v-model="g.isDefault">默认组</el-checkbox>
          <el-button @click="saveGroup(g)">保存</el-button>
          <el-button @click="deleteGroup(g.id)">删除</el-button>
        </div>
        <el-card>
          <h3>选定群组 / 临时群组</h3>
          <el-select v-model="selectedGroup" clearable placeholder="默认群组">
            <el-option v-for="g in groups" :key="g.id" :label="g.name" :value="g.id" />
          </el-select>
          <el-button @click="selectGroup(false)">切换群组</el-button>
          <el-select v-model="temporaryGroup" placeholder="临时群组">
            <el-option v-for="g in groups" :key="g.id" :label="g.name" :value="g.id" />
          </el-select>
          <el-date-picker
            v-model="expireTime"
            type="datetime"
            value-format="YYYY-MM-DDTHH:mm:ss"
            placeholder="临时群组过期时间"
          />
          <el-button :disabled="!temporaryGroup || !expireTime" @click="selectGroup(true)">
            启用临时群组
          </el-button>
          <h3>预定与临时层</h3>
          <el-table :data="scheduled">
            <el-table-column prop="date" label="日期" />
            <el-table-column prop="plan.name" label="课表" />
            <el-table-column label="操作">
              <template #default="{ row }">
                <el-button @click="cancelScheduled(row.id)">取消预定</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
        <el-table :data="courses">
          <el-table-column prop="name" label="科目" />
          <el-table-column prop="teacher.name" label="任课老师（在班级管理指定）" />
          <el-table-column label="简称">
            <template #default="{ row }">
              <el-input
                v-model="row.initial"
                :disabled="!canWrite"
                @change="api.patch(`/courses/${row.id}`, { initial: row.initial })"
              />
            </template>
          </el-table-column>
          <el-table-column label="户外">
            <template #default="{ row }">
              <el-switch
                v-model="row.isOutDoor"
                :disabled="!canWrite"
                @change="api.patch(`/courses/${row.id}`, { isOutDoor: row.isOutDoor })"
              />
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>
<style scoped>
.toolbar {
  display: flex;
  gap: var(--ch-space-3, 12px);
  flex-wrap: wrap;
  margin-block: var(--ch-space-3, 12px);
}
.editor-table {
  width: 100%;
  border-collapse: collapse;
  min-width: 640px;
}
.editor-table td,
.editor-table th {
  padding: var(--ch-space-2, 8px);
  border-bottom: 1px solid var(--ch-border);
  text-align: left;
}
.editor-table tr[data-type='BREAK'] {
  background: var(--ch-surface-soft);
}
.editor-table tr[data-type='ACTION'] {
  color: var(--ch-accent);
}
.drag {
  touch-action: none;
  cursor: grab;
  color: var(--ch-text);
  background: var(--ch-surface);
  border: 1px solid var(--ch-border);
  border-radius: var(--ch-radius-sm);
}
</style>
