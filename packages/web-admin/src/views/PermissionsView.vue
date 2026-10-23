<script setup lang="ts">
import type { PermissionScope as ContractPermissionScope } from '@classhelper/shared';

/**
 * 权限组管理（对应需求「允许 admin 设置各用户权限，或创建权限组」）。
 *
 * 两个 Tab：
 * 1. **权限组**：新建 / 编辑 / 删除权限组（一组权限键），内置组只允许改、禁止删；
 * 2. **成员**：把管理员 / 教师账号分配到权限组（不选任何组 = 回到角色默认模板）。
 *
 * 权限规则本身**不在这里实现**（AGENTS.md 的现行工程约定）：本页只是把服务端
 * `GET /permissions/catalog` 给的目录、以及 `lib/permissions.ts` 的生效规则
 * 如实展示出来，真正的判定始终在服务端 —— 页面拿到的 `fromGroups` / `permissionCount`
 * 都是服务端算好的结果。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  ROLE_LABELS,
  type PermissionCatalogDto,
  type PermissionGroupDto,
  type PermissionKey,
  type PermissionMemberDto,
  type UserRole,
} from '@classhelper/shared';
import { permissionApi } from '@/api';
import { api } from '@/api/http';
import { useAuthStore } from '@/stores/auth';
import { useResponsive } from '@/composables/useResponsive';

const { isMobile } = useResponsive();
const auth = useAuthStore();

/** 当前 Tab：权限组 / 成员 */
const activeTab = ref<'groups' | 'members' | 'audit'>('groups');

const loading = ref(false);
/** 加载失败的中文提示（非空 = 页面顶部显示错误态 + 重试按钮） */
const loadError = ref('');
const groups = ref<PermissionGroupDto[]>([]);
const members = ref<PermissionMemberDto[]>([]);
const catalog = ref<PermissionCatalogDto | null>(null);

/** 当前账号的生效权限数（还没拉回来时用 null 表示"未知"，不显示 0） */
const myPermissionCount = computed(() => (auth.permissionsLoaded ? auth.permissions.length : null));

/** 权限键总数（弹窗标题里的分母） */
const catalogKeyCount = computed(() => catalog.value?.keys.length ?? 0);

/** 组 id → 组名（成员表把 groupIds 翻成名字） */
const groupNameMap = computed<Record<string, string>>(() => {
  const map: Record<string, string> = {};
  for (const group of groups.value) map[group.id] = group.name;
  return map;
});

function roleLabel(role: UserRole): string {
  return ROLE_LABELS[role];
}

/**
 * 从错误里取服务端的中文提示（取不到就退回 axios/浏览器的 message）。
 *
 * 注意 `http.ts` 的响应拦截器**已经**为带响应的错误弹过一次 `ElMessage.error`，
 * 所以这里只负责"拿文案"，不再自己弹一遍 —— 见 {@link toastError}。
 */
function errorMessage(error: unknown): string {
  const response = (error as { response?: { data?: { message?: string } } } | null)?.response;
  const serverMessage = response?.data?.message;
  if (serverMessage) return serverMessage;
  if (error instanceof Error && error.message) return error.message;
  return '请求失败';
}

/**
 * 补一次失败提示。
 *
 * 只给"压根没拿到响应"的那一类（断网、超时、被 CSP 拦掉）补提示：带响应的错误
 * 拦截器已经弹过，这里再弹一次就会在屏幕上叠两条一模一样的 toast。有响应的错误
 * 落到页面内的错误态（`loadError`）。
 */
function toastError(error: unknown): void {
  if (!(error as { response?: unknown } | null)?.response) ElMessage.error(errorMessage(error));
}

/**
 * 拉全部数据：权限组 + 成员 + 权限目录（目录只在首次拉，之后复用）。
 *
 * 一并刷新 `auth.ensurePermissions(true)`：顶栏那句"权限来自权限组 / 角色默认模板"
 * 必须是最新的（服务端每次请求实时算权限，改了立刻生效）。
 */
async function loadAll(): Promise<void> {
  loading.value = true;
  loadError.value = '';
  try {
    const [groupList, memberList, catalogData] = await Promise.all([
      permissionApi.listGroups(),
      permissionApi.listMembers(),
      permissionApi.catalog(),
    ]);
    groups.value = groupList;
    members.value = memberList;
    catalog.value = catalogData;
    scopes.value = await api.get('/permissions/scopes');
    await loadAudits();
    await auth.ensurePermissions(true);
  } catch (error) {
    loadError.value = errorMessage(error);
    toastError(error);
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void loadAll();
});

/* -------------------------------------------------------------- 权限组：新建 / 编辑 */

/** 新建与编辑共用的弹窗状态（`id` 为空串 = 新建） */
const groupDialog = reactive({
  visible: false,
  id: '',
  name: '',
  description: '',
  scope: 'SELF_CLASS' as ContractPermissionScope,
  scopeValue: '',
  keys: [] as PermissionKey[],
  saving: false,
});

const isEditingGroup = computed(() => Boolean(groupDialog.id));
const groupDialogTitle = computed(() => (isEditingGroup.value ? '编辑权限组' : '新建权限组'));
const groupKeysLabel = computed(() => `权限键（已选 ${groupDialog.keys.length} / ${catalogKeyCount.value}）`);

function openCreateGroup(): void {
  groupDialog.id = '';
  groupDialog.name = '';
  groupDialog.description = '';
  groupDialog.scope = 'SELF_CLASS';
  groupDialog.scopeValue = '';
  groupDialog.keys = [];
  groupDialog.visible = true;
}

function openEditGroup(group: PermissionGroupDto): void {
  groupDialog.id = group.id;
  groupDialog.name = group.name;
  groupDialog.description = group.description;
  groupDialog.scope = group.scope ?? 'SELF_CLASS';
  groupDialog.scopeValue = group.scopeValue ?? '';
  // 复制一份：取消/关闭时不能污染表格里的数据
  groupDialog.keys = [...group.keys];
  groupDialog.visible = true;
}

/**
 * 该键"默认给哪些角色"（来自目录的 `defaultRoles`，与服务端
 * `lib/permissions.ts` 的角色默认模板同源）。空数组 = 谁都不默认给。
 */
function defaultRoleHint(key: PermissionKey): string {
  const roles = catalog.value?.defaultRoles[key] ?? [];
  if (roles.length === 0) return '默认不给任何角色';
  return `默认给：${roles.map((role) => ROLE_LABELS[role]).join('、')}`;
}

/**
 * 是否为"管理员不可被剥夺"的键（目录里的 `unremovable`）。
 *
 * **故意不禁用勾选框**：这两个键（`permission:manage` / `system:manage`）的真实语义是
 * "管理员账号永远保留"，而不是"权限组里不能勾" —— 把 `permission:manage` 授给一个权限组
 * 恰恰是本功能的正当用法（让某位老师帮忙管权限），禁掉等于让这条链路没法配。
 * 这里只打一个「高权限」标记提醒配置的人。
 */
function isHighPrivilege(key: PermissionKey): boolean {
  return (
    (catalog.value?.defaultRoles[key]?.length === 1 && catalog.value.defaultRoles[key][0] === 'ADMIN') ||
    (catalog.value?.unremovable.includes(key) ?? false)
  );
}

/** 分类勾选状态：全选 / 全不选 / 选了一部分（决定"全选-清空"按钮的文案） */
function categoryState(keys: PermissionKey[]): 'all' | 'none' | 'part' {
  const selected = keys.filter((key) => groupDialog.keys.includes(key)).length;
  if (selected === 0) return 'none';
  return selected === keys.length ? 'all' : 'part';
}

/** 整个分类一起勾 / 一起取消（40 个键一个个点太累） */
function toggleCategory(keys: PermissionKey[]): void {
  if (categoryState(keys) === 'all') {
    groupDialog.keys = groupDialog.keys.filter((key) => !keys.includes(key));
    return;
  }
  const merged = new Set<PermissionKey>(groupDialog.keys);
  for (const key of keys) merged.add(key);
  groupDialog.keys = Array.from(merged);
}

async function submitGroup(): Promise<void> {
  const name = groupDialog.name.trim();
  if (!name) {
    ElMessage.warning('请填写权限组名称');
    return;
  }
  // 先在前端拦一次重名（服务端也会 409），错误提示能更早出现
  if (groups.value.some((group) => group.id !== groupDialog.id && group.name === name)) {
    ElMessage.warning(`已存在名为「${name}」的权限组`);
    return;
  }
  await ElMessageBox.confirm(groupImpact.value, '权限变更影响预览', {
    type: 'warning',
    confirmButtonText: '确认保存',
  });
  groupDialog.saving = true;
  try {
    const payload = {
      name,
      description: groupDialog.description.trim(),
      scope: groupDialog.scope,
      scopeValue: groupDialog.scopeValue,
      // 传了就**整体替换**（服务端契约），所以这里始终带上完整勾选结果
      keys: [...groupDialog.keys],
    };
    if (isEditingGroup.value) {
      await permissionApi.updateGroup(groupDialog.id, payload);
      ElMessage.success('权限组已更新，组内成员立即生效');
    } else {
      await permissionApi.createGroup(payload);
      ElMessage.success('权限组已创建');
    }
    groupDialog.visible = false;
    await loadAll();
  } catch (error) {
    toastError(error);
  } finally {
    groupDialog.saving = false;
  }
}

async function removeGroup(group: PermissionGroupDto): Promise<void> {
  // 按钮已经 disabled，这里只是兜底（服务端也会 400）
  if (group.builtin) return;
  const memberHint =
    group.memberCount > 0
      ? `组内 ${group.memberCount} 名成员会回到角色默认权限（不会变成无权限）。`
      : '该组目前没有成员。';
  try {
    await ElMessageBox.confirm(`删除权限组「${group.name}」？${memberHint}`, '确认删除', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    });
  } catch {
    return; // 用户取消
  }
  try {
    await permissionApi.removeGroup(group.id);
    ElMessage.success('已删除');
    await loadAll();
  } catch (error) {
    toastError(error);
  }
}

/* -------------------------------------------------------------- 成员：分配权限组 */

const assignDialog = reactive({
  visible: false,
  member: null as PermissionMemberDto | null,
  groupIds: [] as string[],
  saving: false,
});

function openAssign(member: PermissionMemberDto): void {
  assignDialog.member = member;
  assignDialog.groupIds = member.groupIds.length
    ? [...member.groupIds]
    : groups.value.filter((g) => g.defaultRole === member.role).map((g) => g.id);
  assignDialog.visible = true;
}

/** 该成员角色"不选任何组"时会拿到多少项权限（目录里的 `roleDefaults`） */
const roleDefaultCount = computed(() => {
  const role = assignDialog.member?.role;
  if (!role || !catalog.value) return 0;
  return catalog.value.roleDefaults[role].length;
});

async function submitAssign(): Promise<void> {
  const member = assignDialog.member;
  if (!member) return;
  await ElMessageBox.confirm(assignmentImpact.value, '分组生效差异', {
    type: 'warning',
    confirmButtonText: '确认分配',
  });
  assignDialog.saving = true;
  try {
    // 空数组 = 回到角色默认模板（服务端契约）
    await permissionApi.assignGroups(member.id, { groupIds: [...assignDialog.groupIds] });
    ElMessage.success('已更新该成员的权限组，立即生效');
    assignDialog.visible = false;
    await loadAll();
  } catch (error) {
    toastError(error);
  } finally {
    assignDialog.saving = false;
  }
}
const scopes = ref<{ grades: string[]; divisions: { name: string; grades: string[] }[] }>({
  grades: [],
  divisions: [],
});
const selectedGrades = computed({
  get: () => groupDialog.scopeValue.split(',').filter(Boolean),
  set: (value: string[]) => {
    groupDialog.scopeValue = value.join(',');
  },
});
const memberSearch = ref(''),
  memberRole = ref('');
const filteredMembers = computed(() =>
  members.value.filter(
    (member) =>
      (!memberRole.value || member.role === memberRole.value) &&
      `${member.name} ${member.username}`.includes(memberSearch.value.trim()),
  ),
);
type Audit = {
  id: string;
  actorName: string;
  action: string;
  targetId: string;
  beforeJson: string;
  afterJson: string;
  createdAt: string;
};
const auditPage = ref(1),
  audit = ref<{ items: Audit[]; total: number }>({ items: [], total: 0 });
async function loadAudits() {
  audit.value = await api.get('/permissions/audit', { page: auditPage.value, pageSize: 30 });
}
const groupMembersVisible = ref(false),
  selectedGroupMembers = ref<PermissionMemberDto[]>([]);
async function showMembers(group: PermissionGroupDto) {
  selectedGroupMembers.value = await api.get(`/permissions/groups/${group.id}/members`);
  groupMembersVisible.value = true;
}
function copyGroup(group: PermissionGroupDto) {
  openEditGroup(group);
  groupDialog.id = '';
  groupDialog.name = `${group.name}副本`;
}
function effectiveKeys(
  member: PermissionMemberDto,
  groupIds: string[],
  override?: { id: string; keys: PermissionKey[] },
) {
  const selected = groups.value.filter((group) =>
    groupIds.length ? groupIds.includes(group.id) : group.defaultRole === member.role,
  );
  return [
    ...new Set([
      ...selected.flatMap((group) => (group.id === override?.id ? override.keys : group.keys)),
      ...(member.role === 'ADMIN' ? (catalog.value?.unremovable ?? []) : []),
    ]),
  ];
}
function keyChanges(before: PermissionKey[], after: PermissionKey[]) {
  const labels = (keys: PermissionKey[]) =>
    keys.map((key) => catalog.value?.labels[key] ?? key).join('、') || '无';
  return `新增：${labels(after.filter((key) => !before.includes(key)))}；移除：${labels(before.filter((key) => !after.includes(key)))}`;
}
const groupImpact = computed(() => {
  const group = groups.value.find((group) => group.id === groupDialog.id);
  const affected = members.value.filter((member) =>
    member.groupIds.length ? member.groupIds.includes(groupDialog.id) : group?.defaultRole === member.role,
  );
  const added = new Set<PermissionKey>(),
    removed = new Set<PermissionKey>();
  for (const member of affected) {
    const next = effectiveKeys(member, member.groupIds, { id: groupDialog.id, keys: groupDialog.keys });
    next.filter((key) => !member.permissions.includes(key)).forEach((key) => added.add(key));
    member.permissions.filter((key) => !next.includes(key)).forEach((key) => removed.add(key));
  }
  const label = (keys: Set<PermissionKey>) =>
    [...keys].map((key) => catalog.value?.labels[key] ?? key).join('、') || '无';
  return `将影响 ${affected.length} 名成员。新增：${label(added)}；移除：${label(removed)}。范围按当前选择保存，可能改变成员可访问的班级。`;
});
const assignmentImpact = computed(() => {
  const member = assignDialog.member;
  if (!member) return '';
  const next = effectiveKeys(member, assignDialog.groupIds);
  const defaults = catalog.value?.roleDefaults[member.role] ?? [];
  return `对当前权限：${keyChanges(member.permissions, next)}。对角色默认模板：${keyChanges(defaults, next)}。所选组替代默认模板，如需保留请同时选择同角色默认组。`;
});
</script>

<template>
  <div v-if="auth.can('permission:manage')" class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">权限组管理</h2>
        <p class="page-subtitle">
          分配的权限组会替代角色默认模板；如需保留默认权限，请同时选择同角色默认组。
        </p>
      </div>
    </div>

    <!--
      生效规则说明：这一句是页面的"图例"，两端的生效逻辑都按它来
      （服务端 lib/permissions.ts 的 loadEffectivePermissions）。
    -->
    <el-alert class="perm-banner" type="info" :closable="false" show-icon>
      <template #title>权限生效规则：有权限组时取各组的并集；没有任何组时使用角色默认模板。</template>
      <template #default>
        当前账号：{{ auth.roleLabel }}
        <template v-if="myPermissionCount !== null">· 生效权限 {{ myPermissionCount }} 项</template>
        · {{ auth.permissionsFromGroups ? '权限来自权限组' : '未分配权限组（走角色默认模板）' }}
      </template>
    </el-alert>

    <!-- 错误态：拦截器已经弹过一次 toast，这里给一个能重试的落点 -->
    <el-alert v-if="loadError" class="perm-banner" type="error" :closable="false" show-icon>
      <template #title>权限数据加载失败：{{ loadError }}</template>
      <template #default>
        <el-button link type="primary" @click="loadAll">重试</el-button>
      </template>
    </el-alert>

    <el-tabs v-model="activeTab">
      <!-- ------------------------------------------------ Tab 1：权限组 -->
      <el-tab-pane label="权限组" name="groups">
        <div class="toolbar tab-toolbar">
          <el-button type="primary" :icon="'Plus'" @click="openCreateGroup">新建权限组</el-button>
          <span class="text-muted">
            默认权限组可改名与调整权限，修改后对未分组账号立即生效；内置组不能删除。
          </span>
        </div>

        <el-card shadow="never" class="table-card">
          <el-table v-loading="loading" :data="groups" empty-text="暂无权限组">
            <el-table-column prop="name" label="名称" min-width="150" show-overflow-tooltip />
            <el-table-column label="描述" min-width="200" show-overflow-tooltip>
              <template #default="{ row }">
                <span v-if="row.description">{{ row.description }}</span>
                <span v-else class="text-muted">（无描述）</span>
              </template>
            </el-table-column>
            <el-table-column prop="scopeLabel" label="范围" min-width="170" />
            <el-table-column prop="updatedAt" label="更新时间" min-width="190" />
            <el-table-column label="权限数" width="90">
              <template #default="{ row }">{{ row.keys.length }}</template>
            </el-table-column>
            <el-table-column label="成员数" width="90">
              <template #default="{ row }">{{ row.memberCount }}</template>
            </el-table-column>
            <el-table-column label="类型" width="100">
              <template #default="{ row }">
                <el-tag size="small" effect="plain" :type="row.builtin ? 'info' : 'primary'">
                  {{
                    row.defaultRole ? `${roleLabel(row.defaultRole)}默认` : row.builtin ? '内置' : '自定义'
                  }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="230">
              <template #default="{ row }">
                <el-button link type="primary" @click="openEditGroup(row)">编辑</el-button>
                <el-button link @click="copyGroup(row)">复制</el-button>
                <el-button link @click="showMembers(row)">成员</el-button>
                <!-- 内置组禁止删除：按钮 disabled + tooltip 说明（disabled 元素不发光标事件，外面套一层 span） -->
                <el-tooltip :disabled="!row.builtin" content="内置权限组不能删除" placement="top">
                  <span>
                    <el-button link type="danger" :disabled="row.builtin" @click="removeGroup(row)">
                      删除
                    </el-button>
                  </span>
                </el-tooltip>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>

      <!-- ------------------------------------------------ Tab 2：成员 -->
      <el-tab-pane label="成员" name="members">
        <div class="toolbar">
          <el-input v-model="memberSearch" placeholder="搜索姓名或工号" clearable style="width: 220px" />
          <el-select v-model="memberRole" clearable placeholder="全部角色">
            <el-option value="ADMIN" label="管理员" />
            <el-option value="TEACHER" label="教师" />
          </el-select>
        </div>
        <div class="toolbar tab-toolbar">
          <span class="text-muted">
            只列出管理员与教师账号；管理员始终保留权限与系统管理入口，可调整默认组或分配其他权限组。
          </span>
        </div>

        <el-card shadow="never" class="table-card">
          <el-table v-loading="loading" :data="filteredMembers" empty-text="暂无成员">
            <el-table-column prop="name" label="姓名" min-width="120" show-overflow-tooltip />
            <el-table-column prop="username" label="用户名" min-width="120" show-overflow-tooltip />
            <el-table-column label="角色" width="130">
              <template #default="{ row }">{{ roleLabel(row.role) }}</template>
            </el-table-column>
            <el-table-column label="所属权限组" min-width="200">
              <template #default="{ row }">
                <template v-if="row.groupIds.length">
                  <el-tag
                    v-for="groupId in row.groupIds"
                    :key="groupId"
                    class="perm-tag"
                    size="small"
                    effect="plain"
                  >
                    {{ groupNameMap[groupId] ?? '（权限组已删除）' }}
                  </el-tag>
                </template>
                <span v-else class="text-muted">角色默认模板</span>
              </template>
            </el-table-column>
            <el-table-column label="数据范围" min-width="180">
              <template #default="{ row }">{{ row.scopeLabels.join('；') }}</template>
            </el-table-column>
            <el-table-column label="生效权限数" width="110">
              <template #default="{ row }">{{ row.permissionCount }}</template>
            </el-table-column>
            <el-table-column label="操作" width="130">
              <template #default="{ row }">
                <el-tooltip :disabled="true" content="管理员始终保留权限与系统管理入口" placement="top">
                  <span>
                    <el-button link type="primary" :disabled="false" @click="openAssign(row)">
                      分配权限组
                    </el-button>
                  </span>
                </el-tooltip>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>
      <el-tab-pane label="变更记录" name="audit">
        <el-table :data="audit.items">
          <el-table-column prop="createdAt" label="时间" min-width="190" />
          <el-table-column prop="actorName" label="操作人" min-width="120" />
          <el-table-column prop="action" label="操作" min-width="120" />
          <el-table-column prop="targetId" label="目标" min-width="180" />
          <el-table-column label="变更前后" min-width="300">
            <template #default="{ row }">
              <details>
                <summary>查看差异</summary>
                <pre>{{ row.beforeJson }}</pre>
                <pre>{{ row.afterJson }}</pre>
              </details>
            </template>
          </el-table-column>
        </el-table>
        <el-pagination
          v-model:current-page="auditPage"
          :page-size="30"
          :total="audit.total"
          layout="prev, pager, next"
          @current-change="loadAudits"
        />
      </el-tab-pane>
    </el-tabs>
    <el-drawer v-model="groupMembersVisible" title="生效成员" :size="isMobile ? '92%' : '560px'">
      <el-table :data="selectedGroupMembers">
        <el-table-column prop="name" label="姓名" />
        <el-table-column prop="username" label="工号" />
        <el-table-column prop="permissionCount" label="生效权限数" />
      </el-table>
    </el-drawer>

    <!-- ------------------------------------------------ 新建 / 编辑权限组 -->
    <el-dialog
      v-model="groupDialog.visible"
      :title="groupDialogTitle"
      :width="isMobile ? '92%' : '720px'"
      :close-on-click-modal="false"
    >
      <el-form label-position="top">
        <el-form-item label="名称" required>
          <el-input
            v-model="groupDialog.name"
            maxlength="30"
            show-word-limit
            placeholder="例如：教务协助、机房值班"
          />
        </el-form-item>
        <el-form-item label="数据范围">
          <el-select v-model="groupDialog.scope" @change="groupDialog.scopeValue = ''">
            <el-option label="关联班级" value="SELF_CLASS" />
            <el-option label="年级" value="GRADE" />
            <el-option label="部（多个年级）" value="DIVISION" />
            <el-option label="全校" value="ALL" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="groupDialog.scope === 'SELF_CLASS'" label="关联班级规则">
          <el-select v-model="groupDialog.scopeValue">
            <el-option label="班主任与任课班级" value="" />
            <el-option label="仅班主任班" value="HEAD" />
          </el-select>
        </el-form-item>
        <el-form-item v-else-if="groupDialog.scope === 'GRADE'" label="年级" required>
          <el-select v-model="groupDialog.scopeValue">
            <el-option v-for="grade in scopes.grades" :key="grade" :label="grade" :value="grade" />
          </el-select>
        </el-form-item>
        <el-form-item v-else-if="groupDialog.scope === 'DIVISION'" label="部范围（选择多个年级）" required>
          <el-select v-model="selectedGrades" multiple>
            <el-option v-for="grade in scopes.grades" :key="grade" :label="grade" :value="grade" />
          </el-select>
          <el-button
            v-for="division in scopes.divisions"
            :key="division.name"
            link
            @click="selectedGrades = division.grades"
          >
            {{ division.name }}
          </el-button>
        </el-form-item>
        <el-form-item label="描述">
          <el-input
            v-model="groupDialog.description"
            maxlength="100"
            placeholder="这个权限组是做什么的（可留空）"
          />
        </el-form-item>
        <el-form-item :label="groupKeysLabel">
          <div class="perm-picker">
            <div v-for="category in catalog?.categories ?? []" :key="category.title" class="perm-category">
              <div class="perm-category-head">
                <span class="perm-category-title">{{ category.title }}</span>
                <el-button link type="primary" size="small" @click="toggleCategory(category.keys)">
                  {{ categoryState(category.keys) === 'all' ? '清空' : '全选' }}
                </el-button>
              </div>
              <!-- 每个分类一个 checkbox-group，但共用同一个 keys 数组 -->
              <el-checkbox-group v-model="groupDialog.keys" class="perm-keys">
                <div v-for="key in category.keys" :key="key" class="perm-key">
                  <el-checkbox :value="key">
                    {{ catalog?.labels[key] ?? key }}
                    <el-tag
                      v-if="isHighPrivilege(key)"
                      class="perm-flag"
                      size="small"
                      type="warning"
                      effect="plain"
                    >
                      高权限
                    </el-tag>
                  </el-checkbox>
                  <span class="perm-hint">{{ defaultRoleHint(key) }}</span>
                </div>
              </el-checkbox-group>
            </div>
          </div>
          <p class="perm-note text-muted">
            保存时会整体替换该组的权限键（取消勾选 =
            收回这项权限）；不填任何键即收回组内权限；管理员始终保留权限与系统管理两个入口。
          </p>
        </el-form-item>
      </el-form>
      <el-alert :title="groupImpact" type="warning" :closable="false" />
      <template #footer>
        <el-button @click="groupDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="groupDialog.saving" @click="submitGroup">保存</el-button>
      </template>
    </el-dialog>

    <!-- ------------------------------------------------ 给成员分配权限组 -->
    <el-dialog
      v-model="assignDialog.visible"
      title="分配权限组"
      :width="isMobile ? '92%' : '520px'"
      :close-on-click-modal="false"
    >
      <template v-if="assignDialog.member">
        <p class="assign-member">
          {{ assignDialog.member.name }}（{{ assignDialog.member.username }} ·
          {{ roleLabel(assignDialog.member.role) }}）
        </p>
        <el-select
          v-model="assignDialog.groupIds"
          class="assign-select"
          multiple
          clearable
          filterable
          placeholder="不选任何组 = 使用角色默认模板"
        >
          <el-option
            v-for="group in groups"
            :key="group.id"
            :label="group.name"
            :value="group.id"
            :disabled="!!group.defaultRole && group.defaultRole !== assignDialog.member.role"
          >
            <span>{{ group.name }}</span>
            <span class="text-muted">（{{ group.keys.length }} 项权限）</span>
          </el-option>
        </el-select>
        <el-alert :title="assignmentImpact" type="warning" :closable="false" />
        <p class="assign-hint text-muted">
          不选任何组 = 使用角色默认模板（{{ roleLabel(assignDialog.member.role) }} 默认
          {{ roleDefaultCount }} 项权限）；选了组就取各组权限的并集。
        </p>
      </template>
      <template #footer>
        <el-button @click="assignDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="assignDialog.saving" @click="submitAssign">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
/* 顶部两条横幅（生效规则 / 错误态）：圆角与底都用设计令牌，不写死数值 */
.perm-banner {
  margin-bottom: 12px;
  border-radius: var(--ch-radius-sm);
}

.tab-toolbar {
  margin-bottom: 12px;
}

/* 权限键勾选区：两列铺开，自己内部滚动，避免弹窗比屏幕还高 */
.perm-picker {
  width: 100%;
  max-height: 320px;
  overflow-y: auto;
  padding: 4px 12px 12px;
  border: 1px solid var(--ch-border);
  border-radius: var(--ch-radius-md);
  background: var(--ch-surface-alt);
}

.perm-category + .perm-category {
  margin-top: 10px;
}

.perm-category-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 0 2px;
  border-bottom: 1px solid var(--ch-border);
}

.perm-category-title {
  font-size: 13px;
  font-weight: 600;
}

.perm-keys {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 2px 16px;
  padding-top: 6px;
}

.perm-key {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.perm-hint {
  color: var(--ch-text-muted);
  font-size: 11px;
  line-height: 1.4;
  padding-left: 24px;
}

.perm-flag {
  margin-left: 6px;
}

.perm-note {
  margin: 8px 0 0;
  font-size: 12px;
}

.perm-tag {
  margin-right: 6px;
}

.assign-member {
  margin: 0 0 10px;
  font-size: 13px;
}

.assign-select {
  width: 100%;
}

.assign-hint {
  margin: 10px 0 0;
  font-size: 12px;
  line-height: 1.5;
}

/* 小屏（≤768px）：勾选区改一列，说明文字与表格卡片同宽 */
@media (max-width: 768px) {
  .perm-keys {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
