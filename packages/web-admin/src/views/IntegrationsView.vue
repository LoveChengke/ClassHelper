<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import {
  CLASSISLAND_NOTIFICATION_CHANNEL_LABELS,
  CLASSISLAND_NOTIFICATION_DEFAULT_DURATION,
  CLASSISLAND_NOTIFICATION_MAX_DURATION,
  CLASSISLAND_TIME_STATE_LABELS,
  NOTIFICATION_PRIORITIES,
  PRIORITY_LABELS,
  SOCKET_EVENTS,
  formatDate,
  relativeTime,
  type ClassDto,
  type ClassIslandNotificationChannel,
  type ClassIslandStateEvent,
  type IntegrationDeviceDto,
  type NotificationPriority,
} from '@classhelper/shared';
import { classApi, integrationApi } from '@/api';
import { useResponsive } from '@/composables/useResponsive';
import { useRealtimeStore } from '@/stores/realtime';

/**
 * ClassIsland 联动页。
 *
 * 两块内容：
 * 1. **设备接入**：为每个班签发设备令牌（`chci_...`），老师把令牌填进教室机器的
 *    ClassIsland 插件设置，插件就会把该机课表/上课状态上报上来，并接收本页下发的提醒；
 * 2. **下发提醒**：把一条提醒推到该班的 ClassIsland 上全屏弹出（学生端通知中心同时留档）。
 *
 * 权限与后端对齐：本页只对 ADMIN / TEACHER 开放（路由 meta.roles），
 * 具体到"能不能管这个班"由后端 assertCanManageSchedule / assertCanPublishContent 判定。
 */

const realtime = useRealtimeStore();
const { isMobile } = useResponsive();

const loading = ref(false);
const classes = ref<ClassDto[]>([]);
const devices = ref<IntegrationDeviceDto[]>([]);
const filter = reactive({ classId: '' });

/** deviceId → 最近一次 socket 推送的实时状态（页面停留期间最新） */
const liveStates = ref<Record<string, ClassIslandStateEvent>>({});

/** 设备在线判定窗口：插件默认 60 秒上报一次，给到 3 分钟容差（网络抖动/息屏唤醒） */
const ONLINE_WINDOW_MS = 3 * 60 * 1000;
const nowTick = ref(Date.now());
let tickTimer: ReturnType<typeof setInterval> | null = null;

const filteredDevices = computed(() =>
  filter.classId ? devices.value.filter((item) => item.classId === filter.classId) : devices.value,
);

/** 当前选中班级下在线（最近有上报）的设备数 */
const onlineCount = computed(() => filteredDevices.value.filter((item) => isOnline(item)).length);

function isOnline(device: IntegrationDeviceDto): boolean {
  if (!device.lastSeenAt) return false;
  return nowTick.value - new Date(device.lastSeenAt).getTime() < ONLINE_WINDOW_MS;
}

/** 班级名（列表未加载完时退回 classId，避免出现空白） */
function classNameOf(classId: string): string {
  return classes.value.find((item) => item.id === classId)?.name ?? classId;
}

/** 该班的通知显示位置（由教室的 ClassHelper 客户端在设置页里选） */
function channelOf(classId: string): ClassIslandNotificationChannel {
  return classes.value.find((item) => item.id === classId)?.notificationChannel ?? 'both';
}

function channelLabelOf(classId: string): string {
  return CLASSISLAND_NOTIFICATION_CHANNEL_LABELS[channelOf(classId)] ?? '两端都弹';
}

/** 下发提醒弹窗里选中班级的显示位置：为 client 时提示"本次不会到 ClassIsland" */
const notifyChannel = computed(() => channelOf(notifyForm.classId));

/**
 * 一台设备当前展示用的状态。
 *
 * 优先用 socket 推来的实时值（页面停留期间的更新），没有就用设备记录里
 * 最后一次上报的快照 —— 这样"刚进页面"也能立刻看到教室在上什么课。
 */
function liveOf(device: IntegrationDeviceDto): {
  subject: string | null;
  nextSubject: string | null;
  timeState: string | null;
  period: string;
  classPlanLoaded: boolean;
} {
  const live = liveStates.value[device.id];
  const subject = live?.subject ?? device.currentSubject ?? null;
  const nextSubject = live?.nextSubject ?? device.nextSubject ?? null;
  const timeState = live?.timeState ?? device.currentTimeState ?? null;
  const start = live?.periodStart ?? device.currentPeriodStart ?? null;
  const end = live?.periodEnd ?? device.currentPeriodEnd ?? null;
  return {
    subject,
    nextSubject,
    timeState,
    period: start && end ? `${start} - ${end}` : '—',
    classPlanLoaded: live?.classPlanLoaded ?? device.classPlanLoaded,
  };
}

/** 实时状态的中文说明（映射表来自 shared，三端共用一份口径） */
function timeStateLabel(timeState: string | null): string {
  if (!timeState) return '未知';
  return CLASSISLAND_TIME_STATE_LABELS[timeState] ?? timeState;
}

/* ------------------------------------------------------------------ 数据加载 */

async function loadClasses(): Promise<void> {
  classes.value = await classApi.list();
  if (!filter.classId && classes.value.length > 0) filter.classId = classes.value[0]?.id ?? '';
}

async function loadDevices(): Promise<void> {
  devices.value = await integrationApi.listDevices(filter.classId || undefined);
}

async function reload(): Promise<void> {
  loading.value = true;
  try {
    await loadClasses();
    await loadDevices();
  } finally {
    loading.value = false;
  }
}

function onClassChange(): void {
  // 切班级要重新拉一次：设备列表按班级过滤，缓存下来的旧列表会串班
  void loadDevices();
}

/* ------------------------------------------------------------------ 设备管理 */

const createVisible = ref(false);
const createRef = ref<FormInstance>();
const createForm = reactive<{
  classId: string;
  name: string;
  syncScheduleToServer: boolean;
  mirrorScheduleToClassIsland: boolean;
}>({
  classId: '',
  name: '',
  syncScheduleToServer: true,
  mirrorScheduleToClassIsland: false,
});

const createRules: FormRules = {
  classId: [{ required: true, message: '请选择班级', trigger: 'change' }],
};

/** 一次性令牌弹窗：明文只在创建/重置接口返回一次，必须让老师当场复制走 */
const tokenVisible = ref(false);
const tokenValue = ref('');
const tokenHint = ref('');

function openCreate(): void {
  createForm.classId = filter.classId || classes.value[0]?.id || '';
  createForm.name = '';
  createForm.syncScheduleToServer = true;
  createForm.mirrorScheduleToClassIsland = false;
  createVisible.value = true;
}

async function submitCreate(): Promise<void> {
  const valid = await createRef.value?.validate().catch(() => false);
  if (!valid) return;

  const result = await integrationApi.createDevice({
    classId: createForm.classId,
    name: createForm.name.trim() || undefined,
    syncScheduleToServer: createForm.syncScheduleToServer,
    mirrorScheduleToClassIsland: createForm.mirrorScheduleToClassIsland,
  });
  createVisible.value = false;
  showToken(result.token, `设备「${result.device.name}」`);
  ElMessage.success('设备已创建，请把令牌填入教室机器的插件设置');
  await loadDevices();
}

function showToken(token: string, hint: string): void {
  tokenValue.value = token;
  tokenHint.value = hint;
  tokenVisible.value = true;
}

async function copyToken(): Promise<void> {
  try {
    await navigator.clipboard.writeText(tokenValue.value);
    ElMessage.success('令牌已复制');
  } catch {
    // 非 HTTPS / 浏览器拒绝剪贴板权限时的兜底：提示老师手动全选复制
    ElMessage.warning('浏览器拒绝了剪贴板访问，请手动选中复制');
  }
}

async function toggleEnabled(device: IntegrationDeviceDto): Promise<void> {
  const next = !device.enabled;
  await integrationApi.updateDevice(device.id, { enabled: next });
  ElMessage.success(next ? '设备已启用' : '设备已停用（插件上报与下发会被拒绝）');
  await loadDevices();
}

async function toggleMirror(device: IntegrationDeviceDto): Promise<void> {
  const next = !device.mirrorScheduleToClassIsland;
  await integrationApi.updateDevice(device.id, { mirrorScheduleToClassIsland: next });
  ElMessage.success(next ? '已开启：插件会把本班课表镜像回 ClassIsland' : '已关闭课表镜像');
  await loadDevices();
}

async function resetToken(device: IntegrationDeviceDto): Promise<void> {
  const confirmed = await ElMessageBox.confirm(
    `重置后「${device.name}」的旧令牌立即失效，教室机器需要重新填写新令牌。确定继续？`,
    '重置设备令牌',
    { type: 'warning', confirmButtonText: '重置令牌', cancelButtonText: '取消' },
  ).catch(() => false);
  if (!confirmed) return;

  const result = await integrationApi.resetToken(device.id);
  showToken(result.token, `设备「${result.device.name}」`);
  await loadDevices();
}

async function removeDevice(device: IntegrationDeviceDto): Promise<void> {
  const confirmed = await ElMessageBox.confirm(
    `删除后「${device.name}」将无法再上报课表或接收提醒（历史提醒记录保留）。确定删除？`,
    '删除设备',
    { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
  ).catch(() => false);
  if (!confirmed) return;

  await integrationApi.removeDevice(device.id);
  ElMessage.success('设备已删除');
  await loadDevices();
}

/* ------------------------------------------------------------------ 下发提醒 */

const notifyVisible = ref(false);
const notifyRef = ref<FormInstance>();
const notifyForm = reactive<{
  classId: string;
  title: string;
  content: string;
  durationSeconds: number;
  speech: boolean;
  speechContent: string;
  saveToNotifications: boolean;
  priority: NotificationPriority;
}>({
  classId: '',
  title: '',
  content: '',
  durationSeconds: CLASSISLAND_NOTIFICATION_DEFAULT_DURATION,
  speech: false,
  speechContent: '',
  saveToNotifications: true,
  priority: 'NORMAL',
});

const notifyRules: FormRules = {
  classId: [{ required: true, message: '请选择目标班级', trigger: 'change' }],
  title: [{ required: true, message: '请输入提醒标题', trigger: 'blur' }],
  content: [{ required: true, message: '请输入提醒内容', trigger: 'blur' }],
};

const submitting = ref(false);

function openNotify(): void {
  notifyForm.classId = filter.classId || classes.value[0]?.id || '';
  notifyForm.title = '';
  notifyForm.content = '';
  notifyForm.durationSeconds = CLASSISLAND_NOTIFICATION_DEFAULT_DURATION;
  notifyForm.speech = false;
  notifyForm.speechContent = '';
  notifyForm.saveToNotifications = true;
  notifyForm.priority = 'NORMAL';
  notifyVisible.value = true;
}

async function submitNotify(): Promise<void> {
  const valid = await notifyRef.value?.validate().catch(() => false);
  if (!valid) return;

  submitting.value = true;
  try {
    const result = await integrationApi.notify({
      classId: notifyForm.classId,
      title: notifyForm.title.trim(),
      content: notifyForm.content.trim(),
      durationSeconds: notifyForm.durationSeconds,
      speech: notifyForm.speech,
      speechContent: notifyForm.speechContent.trim() || undefined,
      saveToNotifications: notifyForm.saveToNotifications,
      priority: notifyForm.priority,
    });

    // 先看服务端给的"为什么没送"：教室选了「只在 ClassHelper 客户端显示」时也是
    // targetCount=0，但原因与"没有接入设备"完全不同，提示错了会把老师引去查设备。
    if (result.skipped === 'channel-client') {
      ElMessage.warning(
        '提醒已保存到通知中心，但该班教室已设置为「只在 ClassHelper 客户端显示」，本次未推送到 ClassIsland',
      );
    } else if (result.targetCount === 0) {
      ElMessage.warning('提醒已保存，但该班级还没有已接入的 ClassIsland 设备');
    } else {
      ElMessage.success(`已下发到 ${result.delivered}/${result.targetCount} 台 ClassIsland 设备`);
    }
    notifyVisible.value = false;
  } finally {
    submitting.value = false;
  }
}

/* ------------------------------------------------------------------ 实时通道 */

function handleState(payload: unknown): void {
  const state = payload as ClassIslandStateEvent;
  if (!state?.deviceId) return;
  liveStates.value = { ...liveStates.value, [state.deviceId]: state };
}

onMounted(async () => {
  await reload().catch(() => undefined);
  realtime.on(SOCKET_EVENTS.classislandState, handleState);
  // 在线状态是"距今多久"的判断，需要定时重算，否则页面开着时间不会变
  tickTimer = setInterval(() => {
    nowTick.value = Date.now();
  }, 30_000);
});

onUnmounted(() => {
  realtime.off(SOCKET_EVENTS.classislandState, handleState);
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
});
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">ClassIsland 联动</h2>
        <p class="page-subtitle">
          教室机器装上「班级小助手联动」插件后：课表与上课状态会自动上报到这里，这里下发的提醒会在 ClassIsland
          上全屏弹出
        </p>
      </div>
      <div class="toolbar">
        <el-select
          v-model="filter.classId"
          placeholder="全部班级"
          clearable
          style="width: 170px"
          @change="onClassChange"
        >
          <el-option v-for="item in classes" :key="item.id" :label="item.name" :value="item.id" />
        </el-select>
        <el-tag v-if="filteredDevices.length > 0" :type="onlineCount > 0 ? 'success' : 'info'" effect="light">
          在线 {{ onlineCount }} / {{ filteredDevices.length }}
        </el-tag>
        <el-button :icon="'Refresh'" :loading="loading" @click="reload">刷新</el-button>
        <el-button :icon="'Bell'" type="warning" @click="openNotify">下发提醒</el-button>
        <el-button :icon="'Plus'" type="primary" @click="openCreate">接入新设备</el-button>
      </div>
    </div>

    <el-alert
      v-if="filteredDevices.length === 0"
      type="info"
      show-icon
      :closable="false"
      title="还没有接入 ClassIsland 设备"
      description="在教室机器的 ClassIsland 上安装「班级小助手联动」插件并启用，然后点右上角「接入新设备」生成设备令牌，填入插件的「设置 → 班级小助手联动」即可。"
    />

    <template v-else>
      <div class="device-grid">
        <el-card v-for="device in filteredDevices" :key="device.id" shadow="never">
          <div class="device-head">
            <div>
              <div class="device-name">{{ device.name }}</div>
              <div class="device-sub">{{ classNameOf(device.classId) }}</div>
            </div>
            <el-tag :type="isOnline(device) ? 'success' : 'info'" effect="light">
              {{ isOnline(device) ? '在线' : '离线' }}
            </el-tag>
          </div>
          <el-descriptions :column="1" size="small" border>
            <el-descriptions-item label="当前状态">
              {{ timeStateLabel(liveOf(device).timeState) }}
            </el-descriptions-item>
            <el-descriptions-item label="正在上">
              {{ liveOf(device).subject ?? (liveOf(device).classPlanLoaded ? '空课' : '未加载课表') }}
            </el-descriptions-item>
            <el-descriptions-item label="下一节">
              {{ liveOf(device).nextSubject ?? '—' }}
            </el-descriptions-item>
            <el-descriptions-item label="当前节次">
              {{ liveOf(device).period }}
            </el-descriptions-item>
            <el-descriptions-item label="最后上报">
              {{ device.lastSeenAt ? relativeTime(device.lastSeenAt) : '从未上报' }}
            </el-descriptions-item>
            <el-descriptions-item label="提醒显示">
              {{ channelLabelOf(device.classId) }}
            </el-descriptions-item>
          </el-descriptions>
        </el-card>
      </div>

      <el-card shadow="never" class="table-card">
        <el-table v-loading="loading" :data="filteredDevices" empty-text="暂无联动设备">
          <el-table-column label="设备" min-width="180">
            <template #default="{ row }">
              <div>{{ row.name }}</div>
              <div class="cell-sub">{{ classNameOf(row.classId) }}</div>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="110">
            <template #default="{ row }">
              <el-tag :type="row.enabled ? 'success' : 'danger'" effect="light">
                {{ row.enabled ? '已接入' : '已停用' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="版本" width="170">
            <template #default="{ row }">
              <div class="cell-sub">插件 {{ row.pluginVersion ?? '—' }}</div>
              <div class="cell-sub">ClassIsland {{ row.classIslandVersion ?? '—' }}</div>
            </template>
          </el-table-column>
          <el-table-column label="回传课表" width="110">
            <template #default="{ row }">
              <el-tag :type="row.syncScheduleToServer ? 'success' : 'info'" effect="plain">
                {{ row.syncScheduleToServer ? '允许' : '禁止' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="镜像课表" width="110">
            <template #default="{ row }">
              <el-tag :type="row.mirrorScheduleToClassIsland ? 'success' : 'info'" effect="plain">
                {{ row.mirrorScheduleToClassIsland ? '开启' : '关闭' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="tokenHint" label="令牌" width="150" />
          <el-table-column label="最后上报" width="140">
            <template #default="{ row }">
              {{ row.lastSeenAt ? relativeTime(row.lastSeenAt) : '从未' }}
            </template>
          </el-table-column>
          <el-table-column label="创建时间" width="170">
            <template #default="{ row }">{{ formatDate(row.createdAt) }}</template>
          </el-table-column>
          <el-table-column label="操作" width="290" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" @click="toggleEnabled(row)">
                {{ row.enabled ? '停用' : '启用' }}
              </el-button>
              <el-button link type="primary" @click="toggleMirror(row)">
                {{ row.mirrorScheduleToClassIsland ? '关镜像' : '开镜像' }}
              </el-button>
              <el-button link type="warning" @click="resetToken(row)">重置令牌</el-button>
              <el-button link type="danger" @click="removeDevice(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-card>
    </template>

    <!-- 接入新设备 -->
    <el-dialog
      v-model="createVisible"
      title="接入新设备"
      :width="isMobile ? '92%' : '520px'"
      destroy-on-close
    >
      <el-form ref="createRef" :model="createForm" :rules="createRules" label-width="110px">
        <el-form-item label="班级" prop="classId">
          <el-select v-model="createForm.classId" placeholder="选择班级" style="width: 100%">
            <el-option v-for="item in classes" :key="item.id" :label="item.name" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="设备名称">
          <el-input v-model="createForm.name" placeholder="留空则用「班级名 + ClassIsland 设备」" />
        </el-form-item>
        <el-form-item label="回传课表">
          <el-switch v-model="createForm.syncScheduleToServer" />
          <span class="form-hint">允许插件把 ClassIsland 的课表同步到本系统</span>
        </el-form-item>
        <el-form-item label="镜像课表">
          <el-switch v-model="createForm.mirrorScheduleToClassIsland" />
          <span class="form-hint">允许把本班课表写回 ClassIsland（新建档案课表，不改老师原有课表）</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" @click="submitCreate">生成设备令牌</el-button>
      </template>
    </el-dialog>

    <!-- 一次性令牌 -->
    <el-dialog v-model="tokenVisible" title="设备令牌（只显示这一次）" :width="isMobile ? '92%' : '560px'">
      <el-alert
        type="warning"
        show-icon
        :closable="false"
        title="请立即复制并填入插件设置"
        description="服务端只保存令牌的哈希，关闭本窗口后无法再查看明文；只能重置（旧令牌立即失效）。"
      />
      <el-input v-model="tokenValue" readonly type="textarea" :rows="3" class="token-box" />
      <p class="form-hint">{{ tokenHint }} 的令牌</p>
      <template #footer>
        <el-button @click="tokenVisible = false">关闭</el-button>
        <el-button type="primary" :icon="'CopyDocument'" @click="copyToken">复制令牌</el-button>
      </template>
    </el-dialog>

    <!-- 下发提醒 -->
    <el-dialog
      v-model="notifyVisible"
      title="下发提醒到 ClassIsland"
      :width="isMobile ? '92%' : '600px'"
      destroy-on-close
    >
      <el-alert
        v-if="notifyChannel === 'client'"
        type="info"
        show-icon
        :closable="false"
        class="notify-channel-alert"
        title="该班教室已设置为「只在 ClassHelper 客户端显示」"
        description="本次提醒不会推送到 ClassIsland。如需改变，请在教室机器的 ClassHelper 客户端「设置 → 通知显示位置」里调整。"
      />
      <el-form ref="notifyRef" :model="notifyForm" :rules="notifyRules" label-width="110px">
        <el-form-item label="目标班级" prop="classId">
          <el-select v-model="notifyForm.classId" placeholder="选择班级" style="width: 100%">
            <el-option v-for="item in classes" :key="item.id" :label="item.name" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="标题" prop="title">
          <el-input
            v-model="notifyForm.title"
            maxlength="120"
            show-word-limit
            placeholder="例如：交作业提醒"
          />
        </el-form-item>
        <el-form-item label="内容" prop="content">
          <el-input
            v-model="notifyForm.content"
            type="textarea"
            :rows="3"
            maxlength="2000"
            show-word-limit
            placeholder="会显示在 ClassIsland 的提醒正文里"
          />
        </el-form-item>
        <el-form-item label="显示时长">
          <el-input-number
            v-model="notifyForm.durationSeconds"
            :min="1"
            :max="CLASSISLAND_NOTIFICATION_MAX_DURATION"
            :step="1"
          />
          <span class="form-hint">秒（1 ~ {{ CLASSISLAND_NOTIFICATION_MAX_DURATION }}）</span>
        </el-form-item>
        <el-form-item label="优先级">
          <el-select v-model="notifyForm.priority" style="width: 100%">
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
          <span class="form-hint">按教室机器的 ClassIsland 语音设置朗读</span>
        </el-form-item>
        <el-form-item v-if="notifyForm.speech" label="朗读内容">
          <el-input
            v-model="notifyForm.speechContent"
            maxlength="500"
            placeholder="留空则朗读「标题 + 内容」"
          />
        </el-form-item>
        <el-form-item label="同步通知中心">
          <el-switch v-model="notifyForm.saveToNotifications" />
          <span class="form-hint">同时在班级通知中心留一条（学生端也能事后查看）</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="notifyVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitNotify">立即下发</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.device-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 14px;
  margin-bottom: 16px;
}

.device-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}

.device-name {
  font-weight: 600;
}

.device-sub,
.cell-sub {
  opacity: 0.65;
  font-size: 12px;
}

.form-hint {
  margin-left: 10px;
  opacity: 0.65;
  font-size: 12px;
}

.token-box {
  margin-top: 12px;
}

.notify-channel-alert {
  margin-bottom: 12px;
}

/* 手机小屏：卡片内的描述表在窄屏下会自动换行，这里只把间距收紧 */
@media (max-width: 768px) {
  .device-grid {
    grid-template-columns: 1fr;
  }
}
</style>
