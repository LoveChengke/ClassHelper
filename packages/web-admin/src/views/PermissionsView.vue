<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  PERMISSION_META,
  PERMISSION_LABELS,
  PERMISSION_SCOPES,
  parsePermissionScope,
  type PermissionKey,
  type PermissionScope,
  type PermissionAssignment,
  type PermissionCatalogDto,
  type PermissionMemberDto,
  type PermissionGroupDto,
  type EffectivePermissionsDto,
} from '@classhelper/shared';
import { permissionApi } from '@/api';
import { api } from '@/api/http';
import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();
const tab = ref('members');
const loading = ref(false);
const error = ref('');
const groups = ref<PermissionGroupDto[]>([]);
const members = ref<PermissionMemberDto[]>([]);
const catalog = ref<PermissionCatalogDto>();
const grades = ref<string[]>([]);
const audits = ref<
  {
    id: string;
    actorName: string;
    action: string;
    targetType: string;
    beforeJson: string;
    afterJson: string;
    createdAt: string;
  }[]
>([]);
const page = ref(1),
  total = ref(0);
async function loadAudits() {
  const data = await api.get<{ items: typeof audits.value; total: number }>('/permissions/audit', {
    page: page.value,
    pageSize: 20,
  });
  audits.value = data.items;
  total.value = data.total;
}
async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [g, m, c, s] = await Promise.all([
      permissionApi.listGroups(),
      permissionApi.listMembers(),
      permissionApi.catalog(),
      api.get<{ grades: string[] }>('/permissions/scopes'),
    ]);
    groups.value = g;
    members.value = m;
    catalog.value = c;
    grades.value = s.grades;
    await Promise.all([loadAudits(), auth.ensurePermissions(true)]);
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载失败';
  } finally {
    loading.value = false;
  }
}
onMounted(load);
const selected = ref<PermissionMemberDto>();
const assigning = ref(false),
  saving = ref(false);
const assignments = ref<PermissionAssignment[]>([]);
const before = ref<EffectivePermissionsDto>(),
  preview = ref<EffectivePermissionsDto>();
const previewBusy = ref(false),
  previewError = ref('');
let generation = 0;
async function updatePreview() {
  if (!selected.value || !assigning.value) return;
  const request = ++generation;
  previewBusy.value = true;
  previewError.value = '';
  preview.value = undefined;
  try {
    const result = await api.get<EffectivePermissionsDto>(
      `/permissions/users/${selected.value.id}/effective`,
      { assignments: JSON.stringify(assignments.value) },
    );
    if (request === generation) preview.value = result;
  } catch {
    if (request === generation) previewError.value = '范围无效，请选择模板及具体年级后重试';
  } finally {
    if (request === generation) previewBusy.value = false;
  }
}
let previewTimer: ReturnType<typeof setTimeout>;
watch(
  assignments,
  () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => void updatePreview(), 200);
  },
  { deep: true },
);
async function openMember(member: PermissionMemberDto) {
  selected.value = member;
  // 空分配保持空数组；不会把隐式默认模板转换成显式分配。
  assignments.value = member.assignments.map(({ groupId, scope, scopeValue }) => ({
    groupId,
    scope,
    scopeValue,
  }));
  const current = await api.get<EffectivePermissionsDto>(`/permissions/users/${member.id}/effective`);
  if (selected.value?.id !== member.id) return;
  before.value = current;
  assigning.value = true;
  await updatePreview();
}
function addAssignment() {
  const g = groups.value[0];
  if (g) assignments.value.push({ groupId: g.id, scope: g.defaultScope, scopeValue: g.defaultScopeValue });
}
function changeTemplate(row: PermissionAssignment) {
  const g = groups.value.find((g) => g.id === row.groupId);
  if (g) {
    row.scope = g.defaultScope;
    row.scopeValue = g.defaultScopeValue;
  }
}
const added = computed(
  () => preview.value?.permissions.filter((k) => !before.value?.permissions.includes(k)) ?? [],
);
const removed = computed(
  () => before.value?.permissions.filter((k) => !preview.value?.permissions.includes(k)) ?? [],
);
async function saveAssignments() {
  await updatePreview();
  if (!preview.value || !selected.value) return;
  try {
    await ElMessageBox.confirm(
      `将保存 ${selected.value.name} 的模板与范围。新增 ${added.value.length} 项能力，移除 ${removed.value.length} 项能力。请核对下方每项能力的实际合并范围和班级。`,
      '确认权限影响',
      { type: 'warning' },
    );
    saving.value = true;
    await permissionApi.assignGroups(selected.value.id, { assignments: assignments.value });
    assigning.value = false;
    await load();
    ElMessage.success('分配已保存');
  } catch {
    /* 用户取消或请求失败时保留草稿；HTTP 层显示服务端错误。 */
  } finally {
    saving.value = false;
  }
}
const editing = ref(false);
const form = reactive({
  id: '',
  name: '',
  description: '',
  scope: 'TEACHING' as PermissionScope,
  scopeValue: '',
  keys: [] as PermissionKey[],
});
function edit(group?: PermissionGroupDto, copy = false) {
  Object.assign(form, {
    id: copy ? '' : (group?.id ?? ''),
    name: copy ? `${group?.name} 副本` : (group?.name ?? ''),
    description: group?.description ?? '',
    scope: group?.defaultScope ?? 'TEACHING',
    scopeValue: group?.defaultScopeValue ?? '',
    keys: [...(group?.keys ?? [])],
  });
  editing.value = true;
}
const defaultTemplate = computed(() => groups.value.find((g) => g.id === form.id)?.defaultRole === 'TEACHER');
const baselineKeys = computed(() => groups.value.find((g) => g.id === form.id)?.keys ?? []);
const templateAdded = computed(() => form.keys.filter((k) => !baselineKeys.value.includes(k)));
const templateRemoved = computed(() => baselineKeys.value.filter((k) => !form.keys.includes(k)));
const affectedMembers = computed(() =>
  members.value.filter(
    (m) => !m.fixed && (m.groupIds.includes(form.id) || (defaultTemplate.value && !m.assignments.length)),
  ),
);
const categories = computed(
  () =>
    catalog.value?.categories
      .map((c) => ({ ...c, keys: c.keys.filter((k) => PERMISSION_META[k].kind !== 'admin') }))
      .filter((c) => c.keys.length) ?? [],
);
async function saveTemplate() {
  if (!form.name.trim()) {
    ElMessage.warning('请输入模板名称');
    return;
  }
  try {
    parsePermissionScope(form.scope, form.scopeValue, grades.value);
    await ElMessageBox.confirm(
      `将影响 ${affectedMembers.value.length} 位成员，新增 ${templateAdded.value.length} 项能力、移除 ${templateRemoved.value.length} 项能力。建议范围只用于新分配预填，不改变已有分配范围。`,
      '保存模板',
      { type: 'warning' },
    );
    saving.value = true;
    const payload = {
      name: form.name,
      description: form.description,
      scope: form.scope,
      scopeValue: form.scopeValue,
      keys: form.keys,
    };
    if (form.id) await permissionApi.updateGroup(form.id, payload);
    else await permissionApi.createGroup(payload);
    editing.value = false;
    await load();
  } catch (e) {
    if (e instanceof Error) ElMessage.warning(e.message);
  } finally {
    saving.value = false;
  }
}
async function remove(group: PermissionGroupDto) {
  try {
    await ElMessageBox.confirm(
      `删除「${group.name}」后，失去最后一条分配的成员将恢复教师默认模板。`,
      '删除模板',
      { type: 'warning' },
    );
    await permissionApi.removeGroup(group.id);
    await load();
  } catch {
    /* 取消保留现状 */
  }
}
const scopeNames: Record<PermissionScope, string> = {
  TEACHING: '班主任与任课班级',
  HEAD: '仅班主任班',
  GRADE: '指定年级',
  DIVISION: '指定多个年级',
  ALL: '全校',
};
function auditText(raw: string): string {
  try {
    const labels: Record<string, string> = {
      groupId: '模板',
      groupIds: '模板集合',
      scope: '范围',
      scopeValue: '年级',
      keys: '能力',
      permissions: '生效能力',
      assignments: '分配',
      name: '名称',
      description: '说明',
      teacherId: '班主任',
      code: '班级码',
      passwordChanged: '密码已更换',
      termWeeks: '教学周数',
      termStartDate: '开学日期',
      role: '账号角色',
      enrollmentYear: '届别',
      classIndex: '班号',
    };
    function translate(value: unknown): unknown {
      if (Array.isArray(value)) return value.map(translate);
      if (value && typeof value === 'object')
        return Object.fromEntries(
          Object.entries(value).map(([key, item]) => [labels[key] ?? key, translate(item)]),
        );
      if (typeof value === 'string')
        return (
          PERMISSION_LABELS[value as PermissionKey] ??
          scopeNames[value as PermissionScope] ??
          groups.value.find((g) => g.id === value)?.name ??
          value
        );
      return value;
    }
    return JSON.stringify(translate(JSON.parse(raw)), null, 2);
  } catch {
    return raw;
  }
}
const actions: Record<string, string> = {
  create: '新建模板',
  update: '修改模板',
  delete: '删除模板',
  assign: '替换成员分配',
  'class-account': '修改班级账号',
  'class-settings': '修改班级学期设置',
  'class-create': '创建班级',
  'class-update': '修改班级资料',
  'class-delete': '删除班级',
  'class-head': '更换班主任',
  'class-subjects': '分配任课老师',
  'teacher-create': '创建教师账号',
  'teacher-update': '修改教师账号',
  'teacher-password': '重置教师密码',
  'teacher-delete': '删除教师账号',
};
</script>

<template>
  <div v-loading="loading" class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">权限与范围</h2>
        <p class="page-subtitle">模板授予能力，分配限定范围，业务关系由系统独立校验。</p>
      </div>
      <el-button @click="load">刷新</el-button>
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <el-tabs v-model="tab">
      <el-tab-pane label="成员与范围" name="members">
        <el-table :data="members" stripe>
          <el-table-column prop="name" label="成员" />
          <el-table-column prop="username" label="工号" />
          <el-table-column label="模板与分配范围" min-width="280">
            <template #default="{ row }">
              <span v-if="row.fixed">固定全部权限，不可分配</span>
              <span v-else-if="!row.assignments.length">教师默认模板 · 固定任教班级</span>
              <div v-for="(a, i) in row.assignments" :key="i">{{ a.groupName }} · {{ a.scopeLabel }}</div>
            </template>
          </el-table-column>
          <el-table-column prop="permissionCount" label="生效能力数" width="120" />
          <el-table-column label="操作" width="140">
            <template #default="{ row }">
              <el-button link :disabled="row.fixed" @click="openMember(row)">分配与预览</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>
      <el-tab-pane label="岗位模板" name="groups">
        <div class="toolbar">
          <el-button type="primary" @click="edit()">新建模板</el-button>
          <el-dropdown
            @command="
              (id: string) =>
                edit(
                  groups.find((g) => g.id === id),
                  true,
                )
            "
          >
            <el-button>从内置模板复制</el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item
                  v-for="g in groups.filter((g) => g.builtin && !g.defaultRole)"
                  :key="g.id"
                  :command="g.id"
                >
                  {{ g.name }}
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
        <el-table :data="groups">
          <el-table-column prop="name" label="模板" />
          <el-table-column prop="description" label="说明" />
          <el-table-column label="新分配建议范围">
            <template #default="{ row }">
              {{ row.defaultScopeLabel }}
              <p v-for="warning in row.warnings" :key="warning" class="risk">{{ warning }}</p>
            </template>
          </el-table-column>
          <el-table-column label="操作">
            <template #default="{ row }">
              <el-button link @click="edit(row)">编辑</el-button>
              <el-button link @click="edit(row, true)">复制</el-button>
              <el-button link type="danger" :disabled="row.builtin" @click="remove(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>
      <el-tab-pane label="授权审计" name="audit">
        <el-table :data="audits">
          <el-table-column prop="actorName" label="操作人" width="110" />
          <el-table-column label="动作" width="150">
            <template #default="{ row }">{{ actions[row.action] ?? row.action }}</template>
          </el-table-column>
          <el-table-column label="变更前">
            <template #default="{ row }">
              <pre>{{ auditText(row.beforeJson) }}</pre>
            </template>
          </el-table-column>
          <el-table-column label="变更后">
            <template #default="{ row }">
              <pre>{{ auditText(row.afterJson) }}</pre>
            </template>
          </el-table-column>
        </el-table>
        <el-pagination
          v-model:current-page="page"
          :total="total"
          :page-size="20"
          layout="prev,pager,next,total"
          @current-change="loadAudits"
        />
      </el-tab-pane>
    </el-tabs>
    <el-dialog v-model="assigning" :title="`${selected?.name ?? ''} · 模板与范围`" width="min(1000px,95vw)">
      <el-alert title="不选模板表示恢复默认模板；不会自动勾选默认组。" type="info" :closable="false" />
      <div v-for="(row, i) in assignments" :key="i" class="assignment">
        <el-select v-model="row.groupId" @change="changeTemplate(row)">
          <el-option v-for="g in groups" :key="g.id" :label="g.name" :value="g.id" />
        </el-select>
        <el-select v-model="row.scope" @change="row.scopeValue = ''">
          <el-option v-for="s in PERMISSION_SCOPES" :key="s" :label="scopeNames[s]" :value="s" />
        </el-select>
        <el-select v-if="row.scope === 'GRADE'" v-model="row.scopeValue" placeholder="选择年级">
          <el-option v-for="g in grades" :key="g" :value="g" :label="g" />
        </el-select>
        <el-select
          v-if="row.scope === 'DIVISION'"
          :model-value="row.scopeValue.split(',').filter(Boolean)"
          multiple
          placeholder="选择部包含的年级"
          @update:model-value="(v: string[]) => (row.scopeValue = v.join(','))"
        >
          <el-option v-for="g in grades" :key="g" :value="g" :label="g" />
        </el-select>
        <el-button type="danger" link @click="assignments.splice(i, 1)">移除</el-button>
      </div>
      <el-button @click="addAssignment">添加模板分配</el-button>
      <p>
        新增：{{ added.map((k) => PERMISSION_LABELS[k]).join('、') || '无' }}；移除：{{
          removed.map((k) => PERMISSION_LABELS[k]).join('、') || '无'
        }}
      </p>
      <el-alert v-if="previewError" :title="previewError" type="error" :closable="false" />
      <el-alert
        v-for="conflict in preview?.conflicts"
        :key="conflict"
        :title="conflict"
        type="warning"
        :closable="false"
      />
      <el-table v-loading="previewBusy" :data="preview?.entries ?? []" max-height="350">
        <el-table-column label="能力" min-width="240">
          <template #default="{ row }">
            {{ PERMISSION_LABELS[row.key as PermissionKey] }}
            <el-tag
              v-if="PERMISSION_META[row.key as PermissionKey].risk === 'high'"
              type="danger"
              size="small"
            >
              高风险
            </el-tag>
            <p v-if="preview?.headOnlyKeys.includes(row.key)" class="risk">仅班主任班生效，与范围无关</p>
          </template>
        </el-table-column>
        <el-table-column label="实际合并范围">
          <template #default="{ row }">
            {{
              PERMISSION_META[row.key as PermissionKey].kind === 'org'
                ? '组织只读 · 不限班级'
                : row.scopes.join(' ∪ ')
            }}
          </template>
        </el-table-column>
        <el-table-column label="可管理 / 可查看的班级" min-width="240">
          <template #default="{ row }">
            <span v-if="PERMISSION_META[row.key as PermissionKey].kind === 'org'">不限班级</span>
            <span v-else>
              {{ row.classes.map((c: { name: string }) => c.name).join('、') || '无' }}（{{
                row.classCount
              }}）
            </span>
          </template>
        </el-table-column>
      </el-table>
      <template #footer>
        <el-button @click="assigning = false">取消</el-button>
        <el-button
          type="primary"
          :loading="saving"
          :disabled="previewBusy || !preview"
          @click="saveAssignments"
        >
          核对影响并保存
        </el-button>
      </template>
    </el-dialog>
    <el-dialog v-model="editing" title="岗位模板" width="min(850px,95vw)">
      <el-form label-width="140px">
        <el-form-item label="名称"><el-input v-model="form.name" maxlength="40" /></el-form-item>
        <el-form-item label="说明"><el-input v-model="form.description" maxlength="200" /></el-form-item>
        <el-form-item label="新分配建议范围">
          <el-select v-model="form.scope" :disabled="defaultTemplate" @change="form.scopeValue = ''">
            <el-option v-for="s in PERMISSION_SCOPES" :key="s" :value="s" :label="scopeNames[s]" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="form.scope === 'GRADE' || form.scope === 'DIVISION'" label="年级（逗号分隔）">
          <el-input v-model="form.scopeValue" :placeholder="grades.join('、')" />
        </el-form-item>
      </el-form>
      <el-alert
        title="建议范围仅用于新分配预填；管理员专用能力不可装入教师模板。"
        type="info"
        :closable="false"
      />
      <p>影响成员：{{ affectedMembers.map((m) => m.name).join('、') || '无' }}。</p>
      <p>
        新增能力：{{ templateAdded.map((k) => PERMISSION_LABELS[k]).join('、') || '无' }}；移除能力：{{
          templateRemoved.map((k) => PERMISSION_LABELS[k]).join('、') || '无'
        }}。
      </p>
      <el-checkbox-group v-model="form.keys">
        <section v-for="c in categories" :key="c.title">
          <h4>{{ c.title }}</h4>
          <div v-for="key in c.keys" :key="key" class="capability">
            <el-checkbox :value="key">{{ PERMISSION_LABELS[key] }}</el-checkbox>
            <el-tag v-if="PERMISSION_META[key].kind === 'org'" size="small">不限班级</el-tag>
            <el-tag v-if="PERMISSION_META[key].risk === 'high'" type="danger" size="small">高风险</el-tag>
            <small v-if="PERMISSION_META[key].relation === 'head'" class="risk">
              仅班主任班生效，与分配范围无关
            </small>
          </div>
        </section>
      </el-checkbox-group>
      <template #footer>
        <el-button @click="editing = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveTemplate">保存模板</el-button>
      </template>
    </el-dialog>
  </div>
</template>
<style scoped>
.assignment {
  display: flex;
  gap: 12px;
  margin: 16px 0;
  flex-wrap: wrap;
}
.assignment .el-select {
  width: 210px;
}
.capability {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.risk {
  color: var(--el-color-danger);
  font-size: 12px;
}
pre {
  white-space: pre-wrap;
  max-height: 180px;
  overflow: auto;
  font-size: 12px;
}
.toolbar {
  margin: 16px 0;
}
</style>
