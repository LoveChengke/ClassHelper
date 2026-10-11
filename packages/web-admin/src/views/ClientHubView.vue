<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  CLIENT_COMMAND_KINDS,
  CLIENT_COMMAND_LABELS,
  NOTIFICATION_PRIORITIES,
  PRIORITY_LABELS,
  SOCKET_EVENTS,
  relativeTime,
  type ClassDto,
  type ClassHelperStatusDto,
  type ClientCommandKind,
  type ClientDeviceDto,
  type IntegrationDeviceDto,
  type NotificationPriority,
} from '@classhelper/shared';
import { classApi, clientApi, clientReleaseApi, integrationApi } from '@/api';
import { useAuthStore } from '@/stores/auth';
import { useRealtimeStore } from '@/stores/realtime';

/**
 * 「客户端」——**把原来的「ClassHelper 联动」与「客户端设备」两页合成一页**。
 *
 * 为什么合并：这两页讲的是同一件事的两半 —— 同一个教室里，ClassIsland 插件负责大屏、
 * ClassHelper 桌面端负责灵动岛，老师要做的动作（下发课表、推送更新、看看这台机器还在不在线）
 * 也都跨两者。分成两页的结果是"要给一个班做一件事，得先想清楚该进哪一页"，
 * 批量操作更是无从下手（一页只有插件设备、一页只有桌面端）。
 *
 * 结构：
 *   1. **班级卡片**（一屏看全）：每张卡把该班两条链路的状态放在一起，可勾选；
 *   2. **批量动作**：勾几台就下发几台（课表 / 客户端更新）；
 *   3. **点卡片进详情**：该班的设备清单与逐台操作（签发令牌、重置、远控……）。
 *
 * 权限：入口要 `client:manage`（与旧的两页最基础的那个门禁一致），页内按钮再各自按
 * `device:manage` / `client:update-push` / `remote:control` 显示或禁用 —— 后端同样是这么拦的。
 */

const auth = useAuthStore();
const router = useRouter();
const realtime = useRealtimeStore();

const canManageDevices = computed(() => auth.can('device:manage'));
const canNotify = computed(() => auth.can('classisland:notify'));
const canPushUpdate = computed(() => auth.can('client:update-push'));
const canRemote = computed(() => auth.can('remote:control'));

const loading = ref(false);
const classes = ref<ClassDto[]>([]);
const integrations = ref<IntegrationDeviceDto[]>([]);
const clients = ref<ClientDeviceDto[]>([]);
const statuses = ref<ClassHelperStatusDto[]>([]);
/** 服务端已缓存的客户端安装包版本（批量下发更新时选目标版本） */
const releaseVersions = ref<string[]>([]);
const targetVersion = ref('');

/** 一张卡 = 一个班 */
interface ClassCard {
  classId: string;
  className: string;
  grade: string;
  /** 该班的 ClassIsland 插件设备（可能多台：讲台机 + 备用机） */
  devices: IntegrationDeviceDto[];
  /** 该班的 ClassHelper 桌面端 */
  clients: ClientDeviceDto[];
  /** 班级端在线状态（服务端 `classisland/status`） */
  status: ClassHelperStatusDto | null;
}

const cards = computed<ClassCard[]>(() =>
  classes.value.map((item) => {
    const status = statuses.value.find((entry) => entry.classId === item.id) ?? null;
    return {
      classId: item.id,
      className: item.name,
      grade: item.grade,
      devices: integrations.value.filter((entry) => entry.classId === item.id),
      clients: clients.value.filter((entry) => entry.classId === item.id),
      status,
    };
  }),
);

/** 勾选的班级（批量动作按班级走：一台机器都没有的班会跳过并说明原因） */
const selected = ref<string[]>([]);
const allSelected = computed({
  get: () => cards.value.length > 0 && selected.value.length === cards.value.length,
  set: (value: boolean) => {
    selected.value = value ? cards.value.map((item) => item.classId) : [];
  },
});

async function loadAll(): Promise<void> {
  loading.value = true;
  try {
    const [classList, deviceList, clientList, statusList, releases] = await Promise.all([
      classApi.list(),
      integrationApi.listDevices().catch(() => []),
      clientApi.devices().catch(() => []),
      integrationApi.classHelperStatus().catch(() => null),
      clientReleaseApi.list().catch(() => []),
    ]);
    classes.value = classList;
    integrations.value = deviceList;
    clients.value = clientList;
    statuses.value = statusList?.classes ?? [];
    releaseVersions.value = releases
      .map((item) => item.version)
      .filter((version, index, all) => version && all.indexOf(version) === index);
    if (!targetVersion.value && releaseVersions.value.length > 0) {
      targetVersion.value = releaseVersions.value[0] ?? '';
    }
  } finally {
    loading.value = false;
  }
}

/* ------------------------------------------------------------ 批量动作 */

const batchBusy = ref(false);

/** 批量下发课表：给每个勾选班级的**每一台** ClassIsland 设备置一次待办 */
async function batchMirrorSchedule(): Promise<void> {
  const picked = cards.value.filter((item) => selected.value.includes(item.classId));
  const devices = picked.flatMap((item) => item.devices.filter((device) => device.enabled));
  if (devices.length === 0) {
    ElMessage.warning('勾选的班级里没有可下发的 ClassIsland 设备（未接入或已停用）');
    return;
  }
  await ElMessageBox.confirm(
    `向 ${devices.length} 台设备下发课表？教室的课表会被 ClassHelper 的课表**强制替换**：` +
      '同一天同一单双周相位下冲突的旧课表会被**停用**（只停用、不删除，可在 ClassIsland 里重新启用）。',
    '下发课表到教室',
    { type: 'warning', confirmButtonText: '下发', cancelButtonText: '取消' },
  ).catch(() => 'cancel');
  batchBusy.value = true;
  try {
    const results = await Promise.allSettled(
      devices.map((device) => integrationApi.mirrorSchedule(device.id)),
    );
    const ok = results.filter((item) => item.status === 'fulfilled').length;
    ElMessage.success(`已向 ${ok}/${devices.length} 台设备下发，教室会在下一次心跳（约 1 分钟内）拉取`);
    await loadAll();
  } finally {
    batchBusy.value = false;
  }
}

/** 批量下发客户端更新：按班级下发，服务端会给这些班的每台桌面端置目标版本 */
async function batchPushUpdate(): Promise<void> {
  if (selected.value.length === 0) {
    ElMessage.warning('请先勾选班级');
    return;
  }
  const hint = targetVersion.value ? `目标版本 v${targetVersion.value}` : '服务端缓存的最新版本';
  await ElMessageBox.confirm(
    `向 ${selected.value.length} 个班的 ClassHelper 客户端下发更新（${hint}）？\n` +
      '客户端会在**不上课且主窗口隐藏满 5 分钟**后才安装，下载随时可能发生。',
    '下发客户端更新',
    { type: 'warning', confirmButtonText: '下发', cancelButtonText: '取消' },
  ).catch(() => 'cancel');
  batchBusy.value = true;
  try {
    const result = await clientApi.pushUpdate({
      classIds: selected.value,
      version: targetVersion.value || null,
    });
    ElMessage.success(`已下发：成功 ${result.succeeded} / 共 ${result.total} 台`);
    await loadAll();
  } finally {
    batchBusy.value = false;
  }
}

/* ------------------------------------------------------------ 详情抽屉 */

const detailVisible = ref(false);
const detailClassId = ref('');
const detail = computed(() => cards.value.find((item) => item.classId === detailClassId.value) ?? null);

function openDetail(classId: string): void {
  detailClassId.value = classId;
  detailVisible.value = true;
}

const createForm = reactive({ name: '' });
const creating = ref(false);

/** 为当前详情班级签发一台新的 ClassIsland 设备（令牌只在返回值里出现一次） */
async function createDevice(): Promise<void> {
  const current = detail.value;
  if (!current) return;
  creating.value = true;
  try {
    const created = await integrationApi.createDevice({
      classId: current.classId,
      name: createForm.name.trim() || undefined,
    });
    await ElMessageBox.alert(
      `设备令牌（只显示这一次，请立刻填进教室的 ClassIsland 插件设置里）：\n\n${created.token ?? ''}`,
      '设备令牌',
      { confirmButtonText: '我已保存' },
    ).catch(() => undefined);
    createForm.name = '';
    await loadAll();
  } finally {
    creating.value = false;
  }
}

async function toggleDevice(device: IntegrationDeviceDto): Promise<void> {
  await integrationApi.updateDevice(device.id, { enabled: !device.enabled });
  ElMessage.success(device.enabled ? '已停用该设备' : '已启用该设备');
  await loadAll();
}

async function allowMirror(device: IntegrationDeviceDto): Promise<void> {
  await integrationApi.updateDevice(device.id, {
    mirrorScheduleToClassIsland: !device.mirrorScheduleToClassIsland,
  });
  ElMessage.success(device.mirrorScheduleToClassIsland ? '已禁止向该设备下发课表' : '已允许向该设备下发课表');
  await loadAll();
}

async function mirrorOne(device: IntegrationDeviceDto): Promise<void> {
  await ElMessageBox.confirm(
    `把 ClassHelper 的课表下发到「${device.name}」？教室里同一天同一单双周相位下冲突的旧课表会被停用。`,
    '下发课表',
    { type: 'warning', confirmButtonText: '下发', cancelButtonText: '取消' },
  ).catch(() => 'cancel');
  const result = await integrationApi.mirrorSchedule(device.id);
  ElMessage.success(result.nextHeartbeatHint);
  await loadAll();
}

async function pullOne(device: IntegrationDeviceDto): Promise<void> {
  await ElMessageBox.confirm(
    `从「${device.name}」获取课表？教室机器的课表会**合并进本班课表**，可能覆盖老师手排的课。`,
    '从教室机器获取课表',
    { type: 'warning', confirmButtonText: '获取', cancelButtonText: '取消' },
  ).catch(() => 'cancel');
  const result = await integrationApi.requestSchedule(device.id);
  ElMessage.success(result.nextHeartbeatHint);
  await loadAll();
}

async function resetToken(device: IntegrationDeviceDto): Promise<void> {
  await ElMessageBox.confirm(
    `重置「${device.name}」的令牌？旧令牌会立刻失效，教室的插件需要重新填写。`,
    '重置令牌',
    { type: 'warning', confirmButtonText: '重置', cancelButtonText: '取消' },
  ).catch(() => 'cancel');
  const result = await integrationApi.resetToken(device.id);
  await ElMessageBox.alert(`新令牌（只显示这一次）：\n\n${result.token ?? ''}`, '设备令牌', {
    confirmButtonText: '我已保存',
  }).catch(() => undefined);
  await loadAll();
}

async function removeDevice(device: IntegrationDeviceDto): Promise<void> {
  await ElMessageBox.confirm(
    `删除「${device.name}」？删除后它无法再上报课表或接收提醒（历史提醒记录保留）。`,
    '删除设备',
    { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
  ).catch(() => 'cancel');
  await integrationApi.removeDevice(device.id);
  ElMessage.success('设备已删除');
  await loadAll();
}

async function pushUpdateToClass(): Promise<void> {
  const current = detail.value;
  if (!current) return;
  const result = await clientApi.pushUpdate({
    classIds: [current.classId],
    version: targetVersion.value || null,
  });
  ElMessage.success(`已下发：成功 ${result.succeeded} / 共 ${result.total} 台`);
  await loadAll();
}

async function sendCommand(kind: ClientCommandKind): Promise<void> {
  const current = detail.value;
  if (!current || current.clients.length === 0) return;
  const label = CLIENT_COMMAND_LABELS[kind];
  await ElMessageBox.confirm(
    `向「${current.className}」的 ${current.clients.length} 台机器下发「${label}」？\n` +
      '机器上会弹出**默认选中「取消」**的对话框，60 秒未确认按取消处理。',
    `下发${label}`,
    { type: 'warning', confirmButtonText: `确认${label}`, cancelButtonText: '取消' },
  ).catch(() => 'cancel');
  const result = await clientApi.commands({
    deviceIds: current.clients.map((item) => item.id),
    kind,
    note: `由 ${auth.user?.name ?? '管理员'} 下达`,
  });
  ElMessage.success(`已下发：成功 ${result.succeeded} / 共 ${result.total} 台`);
  await loadAll();
}

async function removeClient(device: ClientDeviceDto): Promise<void> {
  await ElMessageBox.confirm(
    `移除「${device.name}」的设备记录？只删记录，不影响那台机器本身（它下次心跳会重新登记）。`,
    '移除设备记录',
    { type: 'warning', confirmButtonText: '移除', cancelButtonText: '取消' },
  ).catch(() => 'cancel');
  await clientApi.removeDevice(device.id);
  ElMessage.success('已移除');
  await loadAll();
}

/* ------------------------------------------------------------ 下发提醒（教室大屏全屏弹出）
 *
 * 这一块是从「ClassIsland 联动」页搬过来的 —— 两页合并时不能只搬设备管理：
 * 「向教室下发提醒」是老师日常要用的入口（权限 `classisland:notify` 默认给教师），
 * 只留设备清单的话，教师会平白少一个功能。
 */

const notifyVisible = ref(false);
const notifySending = ref(false);
const notifyForm = reactive({
  classId: '',
  title: '',
  content: '',
  durationSeconds: 8,
  speech: false,
  priority: 'NORMAL' as NotificationPriority,
});

function openNotify(classId: string): void {
  notifyForm.classId = classId;
  notifyForm.title = '';
  notifyForm.content = '';
  notifyForm.durationSeconds = 8;
  notifyForm.speech = false;
  notifyForm.priority = 'NORMAL';
  notifyVisible.value = true;
}

async function submitNotify(): Promise<void> {
  if (!notifyForm.title.trim()) {
    ElMessage.warning('请填写标题');
    return;
  }
  notifySending.value = true;
  try {
    const result = await integrationApi.notify({
      classId: notifyForm.classId,
      title: notifyForm.title.trim(),
      content: notifyForm.content,
      durationSeconds: notifyForm.durationSeconds,
      speech: notifyForm.speech,
      priority: notifyForm.priority,
    });
    if (result.skipped === 'channel-client') {
      ElMessage.warning('该班教室选择了「只在 ClassHelper 客户端显示」，本次没有推到 ClassIsland');
    } else {
      ElMessage.success(`已下发到 ${result.delivered}/${result.targetCount} 台教室设备`);
    }
    notifyVisible.value = false;
    await loadAll();
  } finally {
    notifySending.value = false;
  }
}

/* ------------------------------------------------------------ 生命周期 */

function refresh(): void {
  void loadAll();
}

onMounted(() => {
  void loadAll();
  // 设备在线状态、客户端版本都是"心跳推进"的，跟着实时事件刷新即可
  realtime.on(SOCKET_EVENTS.classislandState, refresh);
  realtime.on(SOCKET_EVENTS.classUpdated, refresh);
});

onUnmounted(() => {
  realtime.off(SOCKET_EVENTS.classislandState, refresh);
  realtime.off(SOCKET_EVENTS.classUpdated, refresh);
});
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">客户端</h2>
        <p class="page-subtitle">
          一个班的两条链路：ClassIsland 插件（教室大屏）与 ClassHelper 客户端（灵动岛）。
          勾选班级可批量下发课表 / 更新，点卡片进详情做逐台操作
        </p>
      </div>
      <div class="toolbar">
        <el-select
          v-if="canPushUpdate"
          v-model="targetVersion"
          placeholder="最新版本"
          clearable
          style="width: 150px"
        >
          <el-option v-for="item in releaseVersions" :key="item" :label="`v${item}`" :value="item" />
        </el-select>
        <el-button
          v-if="canManageDevices"
          type="warning"
          :icon="'Upload'"
          :loading="batchBusy"
          :disabled="selected.length === 0"
          @click="batchMirrorSchedule"
        >
          批量下发课表
        </el-button>
        <el-button
          v-if="canPushUpdate"
          type="primary"
          :icon="'Refresh'"
          :loading="batchBusy"
          :disabled="selected.length === 0"
          @click="batchPushUpdate"
        >
          批量下发更新
        </el-button>
        <el-button :icon="'Refresh'" :loading="loading" @click="loadAll">刷新</el-button>
      </div>
    </div>

    <el-alert type="info" :closable="false" show-icon style="margin-bottom: 12px">
      <template #title>课表的两个方向都是「按需」的</template>
      <template #default>
        <b>下发课表</b>：把 ClassHelper 排好的课表写进教室，并停用同一天同一单双周相位下冲突的旧课表（只停用、不删除）。
        <b>获取课表</b>：把教室机器里启用的课表合并进本班课表。两个动作都只在你点按钮时发生 ——
        教室与这里不会互相自动覆盖。
      </template>
    </el-alert>

    <div class="select-bar">
      <el-checkbox v-model="allSelected" :indeterminate="selected.length > 0 && !allSelected">
        全选（{{ selected.length }}/{{ cards.length }}）
      </el-checkbox>
    </div>

    <div v-loading="loading" class="card-grid">
      <div v-for="card in cards" :key="card.classId" class="class-card">
        <div class="card-head">
          <el-checkbox v-model="selected" :value="card.classId" />
          <span class="card-title">{{ card.className }}</span>
          <el-tag size="small" effect="plain">{{ card.grade }}</el-tag>
          <el-tag
            size="small"
            :type="card.status?.online || card.clients.some((item) => item.online) ? 'success' : 'info'"
            effect="plain"
          >
            {{ card.status?.online || card.clients.some((item) => item.online) ? '在线' : '离线' }}
          </el-tag>
        </div>

        <div class="card-row">
          <span class="row-label">ClassIsland</span>
          <template v-if="card.devices.length > 0">
            <span class="row-value">
              {{ card.devices.length }} 台 ·
              {{ card.devices.some((item) => item.online) ? '在线' : '离线' }} ·
              {{ card.devices[0]?.currentSubject ?? '当前无课' }}
            </span>
          </template>
          <span v-else class="row-value muted">未接入</span>
        </div>

        <div class="card-row">
          <span class="row-label">客户端</span>
          <template v-if="card.clients.length > 0">
            <span class="row-value">
              {{ card.clients.length }} 台 ·
              {{ card.clients.some((item) => item.online) ? '在线' : '离线' }} ·
              v{{ card.clients[0]?.clientVersion ?? '?' }}
            </span>
          </template>
          <span v-else class="row-value muted">还没有机器上报</span>
        </div>

        <div class="card-foot">
          <el-button link type="primary" @click="openDetail(card.classId)">详情</el-button>
        </div>
      </div>

      <el-empty v-if="!loading && cards.length === 0" description="还没有班级" />
    </div>

    <!-- 详情：该班的两条链路与逐台操作 -->
    <el-drawer v-model="detailVisible" :title="detail ? `${detail.className} · 详情` : '详情'" size="60%">
      <template v-if="detail">
        <div class="detail-section">
          <div class="section-head">
            <span>ClassIsland 教室端（{{ detail.devices.length }} 台）</span>
            <div v-if="canManageDevices || canNotify" class="section-actions">
              <el-button v-if="canNotify" size="small" type="primary" @click="openNotify(detail.classId)">
                下发提醒
              </el-button>
              <el-input v-model="createForm.name" placeholder="设备名（默认取机器名）" size="small" style="width: 180px" />
              <el-button size="small" type="primary" :loading="creating" @click="createDevice">
                新增设备
              </el-button>
            </div>
          </div>
          <el-table :data="detail.devices" size="small" empty-text="该班还没有 ClassIsland 设备">
            <el-table-column prop="name" label="设备" min-width="140" />
            <el-table-column label="状态" width="90">
              <template #default="{ row }">
                <el-tag size="small" :type="row.online ? 'success' : 'info'" effect="plain">
                  {{ row.online ? '在线' : '离线' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="版本" width="130">
              <template #default="{ row }">CI {{ row.classIslandVersion ?? '-' }} / 插件 {{ row.pluginVersion ?? '-' }}</template>
            </el-table-column>
            <el-table-column label="最后心跳" width="120">
              <template #default="{ row }">{{ row.lastHeartbeatAt ? relativeTime(row.lastHeartbeatAt) : '从未' }}</template>
            </el-table-column>
            <el-table-column label="允许下发" width="90">
              <template #default="{ row }">
                <el-switch
                  :model-value="row.mirrorScheduleToClassIsland"
                  :disabled="!canManageDevices"
                  size="small"
                  @update:model-value="() => allowMirror(row)"
                />
              </template>
            </el-table-column>
            <el-table-column label="操作" width="260" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" :disabled="!canManageDevices" @click="mirrorOne(row)">下发课表</el-button>
                <el-button link type="warning" :disabled="!canManageDevices" @click="pullOne(row)">获取课表</el-button>
                <el-button link :disabled="!canManageDevices" @click="toggleDevice(row)">
                  {{ row.enabled ? '停用' : '启用' }}
                </el-button>
                <el-button link :disabled="!canManageDevices" @click="resetToken(row)">重置令牌</el-button>
                <el-button link type="danger" :disabled="!canManageDevices" @click="removeDevice(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>

        <div class="detail-section">
          <div class="section-head">
            <span>ClassHelper 客户端（{{ detail.clients.length }} 台）</span>
            <div v-if="canPushUpdate" class="section-actions">
              <el-button size="small" type="primary" :loading="batchBusy" @click="pushUpdateToClass">
                给本班下发更新
              </el-button>
            </div>
          </div>
          <el-table :data="detail.clients" size="small" empty-text="该班还没有客户端上报过">
            <el-table-column prop="name" label="设备" min-width="140" />
            <el-table-column label="状态" width="90">
              <template #default="{ row }">
                <el-tag size="small" :type="row.online ? 'success' : 'info'" effect="plain">
                  {{ row.online ? '在线' : '离线' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="版本" width="110">
              <template #default="{ row }">
                v{{ row.clientVersion }}
                <el-tag v-if="row.updateTargetVersion" size="small" type="warning" effect="plain">
                  → v{{ row.updateTargetVersion }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="最后心跳" width="120">
              <template #default="{ row }">
                {{ row.lastHeartbeatAt ? relativeTime(row.lastHeartbeatAt) : '从未' }}
              </template>
            </el-table-column>
            <el-table-column prop="stateNote" label="状态说明" min-width="140" />
            <el-table-column label="操作" width="90" fixed="right">
              <template #default="{ row }">
                <el-button link type="danger" :disabled="!canManageDevices" @click="removeClient(row)">
                  移除
                </el-button>
              </template>
            </el-table-column>
          </el-table>

          <div v-if="canRemote" class="remote-bar">
            <span class="row-label">远程控制</span>
            <el-button
              v-for="kind in CLIENT_COMMAND_KINDS"
              :key="kind"
              size="small"
              :disabled="detail.clients.length === 0"
              @click="sendCommand(kind)"
            >
              {{ CLIENT_COMMAND_LABELS[kind] }}
            </el-button>
          </div>
        </div>

        <!--
          两页旧版入口：合并过来的是**常用动作**，还有两处没搬 ——
          「提醒下发 / 联动步骤说明」与「客户端安装包缓存管理」（不先把包拉下来就没有版本可下发）。
          路由还留着（侧栏已隐藏），别的地方找不到它们，就在这里给一条路。
        -->
        <div class="detail-section legacy-links">
          <el-button link type="primary" @click="router.push('/integrations')">
            提醒下发与联动步骤 →
          </el-button>
          <el-button link type="primary" @click="router.push('/client-devices')">
            安装包与设备记录 →
          </el-button>
        </div>
      </template>
    </el-drawer>

    <!-- 下发提醒到教室大屏（ClassIsland 全屏弹出）——从「ClassIsland 联动」页搬过来 -->
    <el-dialog v-model="notifyVisible" title="下发提醒到 ClassIsland" width="520px">
      <el-form label-width="96px">
        <el-form-item label="目标班级">
          <el-input :model-value="cards.find((item) => item.classId === notifyForm.classId)?.className" disabled />
        </el-form-item>
        <el-form-item label="标题">
          <el-input v-model="notifyForm.title" maxlength="60" show-word-limit placeholder="例如：放学前交作业" />
        </el-form-item>
        <el-form-item label="内容">
          <el-input v-model="notifyForm.content" type="textarea" :rows="3" maxlength="500" show-word-limit />
        </el-form-item>
        <el-form-item label="显示时长">
          <el-input-number v-model="notifyForm.durationSeconds" :min="1" :max="120" /> 秒
        </el-form-item>
        <el-form-item label="优先级">
          <el-select v-model="notifyForm.priority" style="width: 160px">
            <el-option
              v-for="item in NOTIFICATION_PRIORITIES"
              :key="item"
              :label="PRIORITY_LABELS[item]"
              :value="item"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="语音朗读">
          <el-switch v-model="notifyForm.speech" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="notifyVisible = false">取消</el-button>
        <el-button type="primary" :loading="notifySending" @click="submitNotify">立即下发</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.select-bar {
  margin-bottom: 8px;
}

.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 12px;
  min-height: 120px;
}

.class-card {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--ch-radius-lg);
  padding: 12px 14px;
  background: var(--ch-surface);
}

.card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.card-title {
  font-weight: 600;
}

.card-row {
  display: flex;
  gap: 8px;
  font-size: var(--el-font-size-small);
  line-height: 1.8;
}

.row-label {
  flex: 0 0 76px;
  color: var(--el-text-color-secondary);
}

.row-value.muted {
  color: var(--el-text-color-placeholder);
}

.card-foot {
  margin-top: 8px;
  text-align: right;
}

.detail-section + .detail-section {
  margin-top: 20px;
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
  font-weight: 600;
}

.section-actions {
  display: flex;
  gap: 8px;
}

.remote-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}
</style>
