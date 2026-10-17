<script setup lang="ts">
/**
 * 客户端设备（对应需求「服务端显示各班 ClassHelper 版本，可选择/全部一键推送更新」+「远控，如一键关机」）。
 *
 * 三块内容：
 * 1. **设备表**：每台教室机器上报的版本、平台、在线状态、心跳、待执行命令与更新状态；
 * 2. **下发更新**：范围三选一（全部 / 按班级 / 选中的 N 台）+ 目标版本，可「清除服务端指定版本」；
 * 3. **下发指令**：关机 / 重启 / 注销 / 锁屏（教室那台机器上还会再弹一次确认框，用户点了才执行）。
 *
 * 几个必须写出来的事实（界面文案与注释都以服务端实现为准）：
 * - 客户端**每 30 秒**上报一次心跳（`CLIENT_HEARTBEAT_INTERVAL_MS`），本页也跟着自动刷新一次；
 * - 命令 **10 分钟**内有效（`CLIENT_COMMAND_EXPIRE_MS`），过期自动失效，
 *   所以"下发成功"不等于"已经执行"——它只是排进了队列；
 * - 更新先下载校验，再按服务端指定的立即 / 放学后 / 空闲五分钟策略安装。
 *
 * 权限：查看 `client:read`、删除 `client:manage`、更新 `client:update`、远控 `remote:control`。
 * 教师默认可以查看；删除、更新和远控默认只给管理员。无权限的按钮是
 * **禁用 + tooltip 说明**而不是直接隐藏：让老师知道"有这件事、需要权限"，而不是以为系统没有。
 */
import ReleaseProgress from '@/components/ReleaseProgress.vue';
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  CLIENT_COMMAND_EXPIRE_MS,
  CLIENT_COMMAND_KINDS,
  CLIENT_COMMAND_LABELS,
  CLIENT_HEARTBEAT_INTERVAL_MS,
  clientReleaseFileName,
  compareVersions,
  normalizeVersion,
  relativeTime,
  formatDate,
  type ClassDto,
  type ClientCommandKind,
  type ClientDeviceDto,
  type ClientPushResult,
  type ClientReleaseDto,
  type ClientTargetResult,
  type PermissionKey,
} from '@classhelper/shared';
import { classApi, clientApi, clientReleaseApi } from '@/api';
import { useAuthStore } from '@/stores/auth';
import { useResponsive } from '@/composables/useResponsive';
import type { TableInstance } from 'element-plus';

const { isMobile } = useResponsive();
const auth = useAuthStore();

/** 自动刷新间隔：跟客户端心跳同频，刷太快没有新数据 */
const AUTO_REFRESH_MS = CLIENT_HEARTBEAT_INTERVAL_MS;

function can(key: PermissionKey): boolean {
  return auth.can(key);
}

/**
 * 动作的中文名。
 *
 * 走一层函数而不是直接在模板里 `CLIENT_COMMAND_LABELS[row.pendingCommand.kind]`：
 * `el-table` 的插槽参数在模板里推断得比较松，索引那次访问会报 TS7053（隐式 any 不能用
 * 来索引 `Record<ClientCommandKind, string>`）。这里把类型收口在函数签名上。
 */
function commandLabel(kind: ClientCommandKind): string {
  return CLIENT_COMMAND_LABELS[kind];
}

/* -------------------------------------------------------------- 设备列表 */

const loading = ref(false);
/** 加载失败的中文提示（非空 = 页面顶部显示错误态 + 重试按钮） */
const loadError = ref('');
const devices = ref<ClientDeviceDto[]>([]);
const selectedDevices = ref<ClientDeviceDto[]>([]);
/** 班级筛选下拉的选项 */
const classes = ref<ClassDto[]>([]);
const classId = ref('');

/** 表格实例：删除后要让勾选与表格状态对齐 */
const tableRef = ref<TableInstance>();

/**
 * 让「3 分钟前」这类相对时间自己走起来。
 *
 * `relativeTime()` 是普通函数，不是响应式的 —— 不主动触发重算的话，
 * 页面开着不动时"刚刚"会一直停在"刚刚"。这里每 30 秒推一下，与自动刷新同频。
 */
const nowTick = ref(Date.now());

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
 * 拦截器已经弹过，这里再弹一次就会在屏幕上叠两条一模一样的 toast。
 */
function toastError(error: unknown): void {
  if (!(error as { response?: unknown } | null)?.response) ElMessage.error(errorMessage(error));
}

/** 拉设备列表；`silent` 用于自动刷新（不闪 loading、失败不弹错） */
async function loadDevices(silent = false): Promise<void> {
  if (!silent) loading.value = true;
  try {
    devices.value = await clientApi.devices(classId.value || undefined);
    loadError.value = '';
    // 刷新后把已经不存在的设备从勾选里摘掉，避免"选了 3 台，实际只下发 2 台"
    const alive = new Set(devices.value.map((device) => device.id));
    selectedDevices.value = selectedDevices.value.filter((device) => alive.has(device.id));
  } catch (error) {
    if (silent) return;
    loadError.value = errorMessage(error);
    toastError(error);
  } finally {
    if (!silent) loading.value = false;
  }
}

/** 自动刷新：页面在后台（`document.hidden`）时跳过，回来再补一次 */
function autoRefresh(): void {
  nowTick.value = Date.now();
  if (document.hidden) return;
  void loadDevices(true);
}

/** 从后台切回来立刻补一次，不用等下一个 30 秒 */
function onVisibilityChange(): void {
  if (!document.hidden) autoRefresh();
}

async function loadClasses(): Promise<void> {
  try {
    classes.value = await classApi.list();
  } catch (error) {
    toastError(error);
  }
}

let refreshTimer: number | undefined;

onMounted(() => {
  void loadDevices();
  void loadClasses();
  void ensureReleases();
  refreshTimer = window.setInterval(autoRefresh, AUTO_REFRESH_MS);
  document.addEventListener('visibilitychange', onVisibilityChange);
});

onUnmounted(() => {
  if (refreshTimer !== undefined) window.clearInterval(refreshTimer);
  document.removeEventListener('visibilitychange', onVisibilityChange);
});

/* -------------------------------------------------------------- 设备表：派生状态 */

/** 安装包列表（同时供"目标版本"下拉、"可更新"标记与"安装包管理"用） */
const releases = ref<ClientReleaseDto[]>([]);
/** 是否已经从服务端拿到过安装包列表（用于避免重复请求） */
const releasesLoaded = ref(false);

/**
 * 服务端缓存里的最新版本（没缓存任何安装包时为 `''`）。
 *
 * "可更新"这一列以**服务端自己的缓存**为准，而不是 GitHub 上的最新版：
 * 服务端没缓存就下不下去，标出来只会让人白点一次。
 */
const latestCachedVersion = computed(() => releases.value[0]?.version ?? '');

async function ensureReleases(): Promise<void> {
  try {
    // 从新到旧排序：列表第一项就是"最新缓存版本"（`latestCachedVersion` 依赖它），
    // 目标版本下拉也直接用这个顺序
    releases.value = (await clientReleaseApi.list()).sort((a, b) => compareVersions(b.version, a.version));
    releasesLoaded.value = true;
  } catch (error) {
    releasesLoaded.value = false;
    throw error;
  }
}

/** 目标版本下拉的候选：按版本从新到旧，只列出文件真的在磁盘上的 */
const readyReleases = computed(() =>
  releases.value.filter((release) => release.fileReady).sort((a, b) => compareVersions(b.version, a.version)),
);

/** 有缓存版本、且该设备当前版本更低，才算"可更新" */
function isUpdatable(device: ClientDeviceDto): boolean {
  if (!latestCachedVersion.value) return false;
  return compareVersions(latestCachedVersion.value, device.clientVersion) > 0;
}

/** 选中的设备里能改名/删除的台数（表格勾选） */
const selectedCount = computed(() => selectedDevices.value.length);

function onSelectionChange(rows: ClientDeviceDto[]): void {
  selectedDevices.value = rows;
}

/** 班级列：没绑定班级的机器也要能看出来（否则会以为是某个班的） */
function classLabel(device: ClientDeviceDto): string {
  return device.className ?? '未绑定班级';
}

/** 「已指定 <版本>」：只显示版本号，避免与「已下载待安装」挤在一起 */
function targetVersionLabel(device: ClientDeviceDto): string {
  return normalizeVersion(device.updateTargetVersion) || device.updateTargetVersion;
}

/* -------------------------------------------------------------- 下发更新 */

const updateDialog = reactive({
  visible: false,
  /** 作用范围：全部设备 / 按班级 / 仅选中的设备 */
  scope: 'all' as 'all' | 'class' | 'selected',
  classIds: [] as string[],
  version: '',
  /** 清除服务端指定的版本（回到"不要求更新"） */
  clear: false,
  mode: 'after-school' as 'idle' | 'immediate' | 'after-school',
  afterSchoolTime: '17:00',
  submitting: false,
});

/** 弹窗标题带上台数，确认前就能看出会影响多少台 */
const updateScopeHint = computed(() => {
  if (updateDialog.clear) return '将清除下列范围设备的「指定版本」，已下载的包保留，但不再自动安装。';
  if (updateDialog.scope === 'all') return `全部 ${devices.value.length} 台设备`;
  if (updateDialog.scope === 'class') {
    return updateDialog.classIds.length
      ? `所选 ${updateDialog.classIds.length} 个班级的在线与离线设备`
      : '请选择班级';
  }
  return selectedCount.value ? `已勾选的 ${selectedCount.value} 台设备` : '请先在表格里勾选设备';
});

const updateSubmitDisabled = computed(() => {
  if (updateDialog.submitting) return true;
  // 一台设备都没有时先别提交：服务端会回 400「没有匹配到任何客户端设备」
  if (devices.value.length === 0) return true;
  if (updateDialog.scope === 'class' && updateDialog.classIds.length === 0) return true;
  if (updateDialog.scope === 'selected' && selectedCount.value === 0) return true;
  if (!updateDialog.clear && !updateDialog.version) return true;
  if (!updateDialog.clear && updateDialog.mode === 'after-school' && !updateDialog.afterSchoolTime)
    return true;
  return false;
});

function openUpdateDialog(): void {
  updateDialog.scope = 'all';
  updateDialog.classIds = classId.value ? [classId.value] : [];
  // 默认停在服务端缓存里最新的一版（服务端省略 version 时也是这个口径）
  updateDialog.version = readyReleases.value[0]?.version ?? '';
  updateDialog.clear = false;
  updateDialog.visible = true;
  void openReleasesIfNeeded();
}

/** 安装包列表还没拿到就先补一次（推送/管理都要用） */
async function openReleasesIfNeeded(): Promise<void> {
  if (releasesLoaded.value) return;
  try {
    await ensureReleases();
    if (!updateDialog.version) updateDialog.version = readyReleases.value[0]?.version ?? '';
  } catch (error) {
    // 拦截器已经为"有响应"的错误弹过一次，这里只补"连响应都没有"的那类
    toastError(error);
    updateDialog.version = '';
  }
}

function scopePayload(): { deviceIds?: string[]; classIds?: string[]; all?: boolean } {
  if (updateDialog.scope === 'selected') {
    return { deviceIds: selectedDevices.value.map((device) => device.id) };
  }
  if (updateDialog.scope === 'class') return { classIds: [...updateDialog.classIds] };
  return { all: true };
}

/** 提交前的二次确认：把"客户端什么时候才装"讲清楚，这是最容易误解的一步 */
async function submitUpdate(): Promise<void> {
  if (updateSubmitDisabled.value) return;
  const payload = scopePayload();
  const version = updateDialog.clear ? '' : updateDialog.version;

  const detail = updateDialog.clear
    ? '清除后这些设备不再被要求升级（已经下载好的包保留，但取消自动安装）。'
    : `目标版本：v${normalizeVersion(version)}。\n\n` +
      (updateDialog.mode === 'immediate'
        ? '下载并校验完成后立即安装并重启客户端。'
        : updateDialog.mode === 'after-school'
          ? `等待今天放学后安装：不早于 ${updateDialog.afterSchoolTime}，且不早于本班最后一节课结束。`
          : '等待不上课且窗口隐藏满 5 分钟后安装。');

  try {
    await ElMessageBox.confirm(detail, updateDialog.clear ? '确认清除更新指定' : '确认推送更新', {
      type: 'warning',
      confirmButtonText: updateDialog.clear ? '清除指定' : '推送',
      cancelButtonText: '取消',
      // 文案里有换行，交给 white-space 渲染
      customClass: 'ch-confirm-multiline',
    });
  } catch {
    return; // 用户取消
  }

  updateDialog.submitting = true;
  try {
    const result = await clientApi.pushUpdate({
      ...payload,
      version: updateDialog.clear ? null : version,
      clear: updateDialog.clear,
      mode: updateDialog.mode,
      afterSchoolTime: updateDialog.afterSchoolTime,
    });
    updateDialog.visible = false;
    reportPushResult(updateDialog.clear ? '清除更新指定' : `推送更新 v${normalizeVersion(version)}`, result);
    await loadDevices(true);
  } catch (error) {
    toastError(error);
  } finally {
    updateDialog.submitting = false;
  }
}

/* -------------------------------------------------------------- 下发指令 */

const commandDialog = reactive({
  visible: false,
  kind: 'shutdown' as ClientCommandKind,
  note: '',
  submitting: false,
});

/** 命令有效期文案（10 分钟），常量一改这里跟着变 */
const commandExpireText = computed(() => `${Math.round(CLIENT_COMMAND_EXPIRE_MS / 60000)} 分钟`);

/** 关机 / 重启是不可逆动作，确认按钮走红色危险样式 */
const isDestructiveCommand = computed(
  () => commandDialog.kind === 'shutdown' || commandDialog.kind === 'restart',
);

function openCommandDialog(): void {
  if (canRemoteControlDisabled.value || selectedCount.value === 0) return;
  commandDialog.kind = 'shutdown';
  commandDialog.note = '';
  commandDialog.visible = true;
}

/**
 * 「下发指令」按钮为什么不可用。
 *
 * 三种情况要分开说：没有权限 / 没勾设备 / 勾了但设备已不在列表里 ——
 * 只把按钮置灰、不说原因，用户只会以为按钮坏了。
 */
const commandDisabledReason = computed(() => {
  if (!can('remote:control')) return '当前账号没有「远控客户端电脑」权限（remote:control），请联系管理员分配';
  if (selectedCount.value === 0) return '请先在表格里勾选要下发的设备';
  return '';
});
const canRemoteControlDisabled = computed(() => commandDisabledReason.value !== '');

/** 确认文案：把"机器上还会弹确认框""10 分钟内有效"两条硬事实写进去 */
async function submitCommand(): Promise<void> {
  if (canRemoteControlDisabled.value) return;
  const label = CLIENT_COMMAND_LABELS[commandDialog.kind];
  const targets = selectedDevices.value;
  const note = commandDialog.note.trim();
  // 服务端 zod 是 max(80)，这里先拦一次，省一次往返
  if (note.length > 80) {
    ElMessage.warning('备注最多 80 个字');
    return;
  }

  const detail =
    `将对 ${targets.length} 台设备下发「${label}」：\n` +
    `${targets
      .slice(0, 8)
      .map((device) => `· ${device.name}（${classLabel(device)}）`)
      .join('\n')}${targets.length > 8 ? `\n· …等共 ${targets.length} 台` : ''}\n\n` +
    `目标机器收到后立即执行，不再等待教室确认；命令 ${commandExpireText.value}内有效，过期自动失效。` +
    (note ? `\n备注：${note}` : '');

  try {
    await ElMessageBox.confirm(detail, `确认下发「${label}」`, {
      type: 'warning',
      confirmButtonText: `下发${label}`,
      cancelButtonText: '取消',
      // 关机 / 重启是不可逆动作，按钮走危险色语义
      ...(isDestructiveCommand.value ? { confirmButtonClass: 'el-button--danger' } : {}),
      customClass: 'ch-confirm-multiline',
    });
  } catch {
    return; // 用户取消
  }

  commandDialog.submitting = true;
  try {
    const result = await clientApi.commands({
      deviceIds: targets.map((device) => device.id),
      kind: commandDialog.kind,
      note: note || undefined,
    });
    commandDialog.visible = false;
    reportPushResult(`下发「${label}」`, result);
    await loadDevices(true);
  } catch (error) {
    toastError(error);
  } finally {
    commandDialog.submitting = false;
  }
}

/* -------------------------------------------------------------- 批量结果 */

/**
 * 批量结果弹窗。
 *
 * 不用 `ElMessage.success` 一句话带过的原因：`ClientPushResult` 里带着**逐台**的成功/失败
 * 与原因（`DEVICE_NOT_FOUND` 这类），只报"成功 5 台失败 1 台"的话，用户还得自己去表格里
 * 找是哪一台没成。这里把失败明细摊开，成功台数用 toast 报一句即可。
 */
const resultDialog = reactive({
  visible: false,
  title: '',
  summary: '' as string,
  failures: [] as ClientTargetResult[],
});

function reportPushResult(action: string, result: ClientPushResult): void {
  const failures = result.results.filter((item) => !item.ok);
  const summary = `${action}：共 ${result.total} 台，成功 ${result.succeeded} 台，失败 ${result.failed} 台`;

  if (result.failed === 0) {
    ElMessage.success(summary);
    return;
  }
  ElMessage.warning(summary);
  resultDialog.title = `${action}结果`;
  resultDialog.summary = summary;
  resultDialog.failures = failures;
  resultDialog.visible = true;
}

/** 失败原因：服务端给的中文 message 优先，其次 code，最后兜一句 */
function failureReason(item: ClientTargetResult): string {
  return item.message || item.code || '服务端未给出原因';
}

function failureDeviceName(item: ClientTargetResult): string {
  return item.deviceName || '（设备已不存在）';
}

/* -------------------------------------------------------------- 单个设备操作 */

function removeDevice(device: ClientDeviceDto): void {
  void (async () => {
    try {
      await ElMessageBox.confirm(
        `移除设备「${device.name}」（${classLabel(device)}）？\n` +
          '只删除服务端这条上报记录，不会影响那台机器本身；它下次心跳上报时会被重新登记。',
        '确认移除',
        { type: 'warning', confirmButtonText: '移除', cancelButtonText: '取消' },
      );
    } catch {
      return; // 用户取消
    }
    try {
      await clientApi.removeDevice(device.id);
      ElMessage.success('已移除该设备记录');
      tableRef.value?.clearSelection();
      await loadDevices(true);
    } catch (error) {
      toastError(error);
    }
  })();
}

/* -------------------------------------------------------------- 安装包管理 */

const releasesDrawer = reactive({
  visible: false,
  /** 从 GitHub 拉取的版本号 */
  fetchVersion: '',
  fetching: false,
  /** 登记本地文件的版本号与可选文件名 */
  registerVersion: '',
  registerFileName: '',
  registering: false,
});

/** 人类可读的文件大小（服务端给的是字节） */
function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const mb = bytes / 1024 / 1024;
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/** 版本号只允许 `1.2.3` 这类数字点号形式（与 `normalizeVersion` 的口径一致） */
function isVersionLike(value: string): boolean {
  return /^\d+(\.\d+)*$/.test(value);
}

/** 从输入框里取出干净的版本号：去掉开头的 v、去掉空白 */
function cleanVersionInput(value: string): string {
  return value.trim().replace(/^v/i, '');
}

/** sha256 只显示前 12 位，完整值放 tooltip */
function shortSha(sha: string): string {
  return sha ? `${sha.slice(0, 12)}…` : '—';
}

async function openReleasesDrawer(): Promise<void> {
  releasesDrawer.visible = true;
  try {
    await ensureReleases();
    if (!updateDialog.version) updateDialog.version = readyReleases.value[0]?.version ?? '';
  } catch (error) {
    toastError(error);
  }
}

/**
 * 让服务端从 GitHub 下载安装包。
 *
 * 请求期间必须转圈并禁用按钮：服务端自己允许下 10 分钟（`FETCH_TIMEOUT_MS`），
 * 这段时间里点第二下只会再来一次 100MB 的下载。`clientReleaseApi.fetch` 也把超时放宽到同一上限。
 */
async function fetchRelease(): Promise<void> {
  const version = cleanVersionInput(releasesDrawer.fetchVersion);
  if (!version) {
    ElMessage.warning('请填写要拉取的版本号，例如 1.2.0');
    return;
  }
  if (!isVersionLike(version)) {
    ElMessage.warning('版本号只填数字与点号，例如 1.2.0（不用带前面的 v）');
    return;
  }
  releasesDrawer.fetching = true;
  try {
    const release = await clientReleaseApi.fetch(version);
    ElMessage.success(`已下载并登记 v${normalizeVersion(release.version)}（${formatSize(release.size)}）`);
    releasesDrawer.fetchVersion = '';
    await ensureReleases();
    if (!updateDialog.version) updateDialog.version = readyReleases.value[0]?.version ?? '';
  } catch (error) {
    // 服务端把"GitHub 上没有这个版本 / 下载失败"都做成了 400 + 中文说明，拦截器已经弹过一次
    toastError(error);
  } finally {
    releasesDrawer.fetching = false;
  }
}

async function registerRelease(): Promise<void> {
  const version = cleanVersionInput(releasesDrawer.registerVersion);
  if (!version) {
    ElMessage.warning('请填写要登记的版本号');
    return;
  }
  if (!isVersionLike(version)) {
    ElMessage.warning('版本号只填数字与点号，例如 1.2.0（不用带前面的 v）');
    return;
  }
  releasesDrawer.registering = true;
  try {
    const release = await clientReleaseApi.register({
      version,
      ...(releasesDrawer.registerFileName.trim() ? { fileName: releasesDrawer.registerFileName.trim() } : {}),
    });
    ElMessage.success(`已登记 v${normalizeVersion(release.version)}（${release.fileName}）`);
    releasesDrawer.registerVersion = '';
    releasesDrawer.registerFileName = '';
    await ensureReleases();
    if (!updateDialog.version) updateDialog.version = readyReleases.value[0]?.version ?? '';
  } catch (error) {
    toastError(error);
  } finally {
    releasesDrawer.registering = false;
  }
}

function removeRelease(release: ClientReleaseDto): void {
  void (async () => {
    try {
      await ElMessageBox.confirm(
        `删除 v${normalizeVersion(release.version)} 的安装包缓存？\n` +
          '会同时删掉磁盘上的文件；已经推送到客户端的更新会变成"服务端缺少安装包"。',
        '确认删除安装包',
        { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
      );
    } catch {
      return; // 用户取消
    }
    try {
      await clientReleaseApi.remove(release.version);
      ElMessage.success('已删除该安装包');
      await ensureReleases();
    } catch (error) {
      toastError(error);
    }
  })();
}

/** 把某个缓存版本当作更新目标：打开下发弹窗并预选好（只改目标，不代表已经推送） */
function useReleaseAsTarget(release: ClientReleaseDto): void {
  releasesDrawer.visible = false;
  releasesDrawer.fetchVersion = '';
  updateDialog.scope = 'all';
  updateDialog.classIds = classId.value ? [classId.value] : [];
  updateDialog.version = release.version;
  updateDialog.clear = false;
  updateDialog.visible = true;
}

/** 页面里"有权限但设备/安装包为空"的各种入口提示 */
const deviceEmptyText = computed(() =>
  classId.value
    ? '该班级还没有客户端上报过（客户端每 30 秒上报一次心跳）'
    : '还没有客户端上报过（客户端每 30 秒上报一次心跳）',
);
</script>

<template>
  <div class="page">
    <ReleaseProgress v-if="can('client:update')" />
    <div class="page-header">
      <div>
        <h2 class="page-title">客户端设备</h2>
        <p class="page-subtitle">
          教室里每台 ClassHelper 班级端都会上报自己的版本与状态；这里可以看版本、统一推送更新，也可以下发关机
          / 重启等远控指令。
        </p>
      </div>
    </div>

    <!-- 错误态：拦截器已经弹过一次 toast，这里给一个能重试的落点 -->
    <el-alert v-if="loadError" class="client-banner" type="error" :closable="false" show-icon>
      <template #title>设备列表加载失败：{{ loadError }}</template>
      <template #default>
        <el-button link type="primary" @click="loadDevices()">重试</el-button>
      </template>
    </el-alert>

    <div class="toolbar">
      <el-select
        v-model="classId"
        class="client-class-filter"
        clearable
        placeholder="全部班级"
        @change="loadDevices()"
      >
        <el-option v-for="item in classes" :key="item.id" :label="item.name" :value="item.id" />
      </el-select>

      <el-button :icon="'Refresh'" :loading="loading" @click="loadDevices()">刷新</el-button>

      <!-- 自动刷新说明：把"什么时候不刷"也写出来，否则会被当成刷新失灵 -->
      <span class="text-muted client-refresh-hint">
        每 {{ AUTO_REFRESH_MS / 1000 }} 秒自动刷新一次；页面切到后台时暂停，切回来立刻刷新。
      </span>

      <div class="client-actions">
        <el-tooltip
          :disabled="can('client:update')"
          content="当前账号没有「向客户端统一下发更新」权限（client:update）"
          placement="top"
        >
          <span>
            <el-button
              type="primary"
              :icon="'Upload'"
              :disabled="!can('client:update')"
              @click="openUpdateDialog"
            >
              一键推送更新
            </el-button>
          </span>
        </el-tooltip>

        <el-tooltip :disabled="!commandDisabledReason" :content="commandDisabledReason" placement="top">
          <span>
            <el-button :icon="'SwitchButton'" :disabled="canRemoteControlDisabled" @click="openCommandDialog">
              下发指令
            </el-button>
          </span>
        </el-tooltip>

        <el-tooltip
          :disabled="can('client:update')"
          content="当前账号没有「管理安装包」权限（client:update）"
          placement="top"
        >
          <span>
            <el-button :icon="'FolderOpened'" :disabled="!can('client:update')" @click="openReleasesDrawer">
              安装包管理
            </el-button>
          </span>
        </el-tooltip>
      </div>
    </div>

    <el-card shadow="never" class="table-card">
      <div v-if="selectedCount > 0" class="client-selection-bar">
        已勾选 {{ selectedCount }} 台设备
        <el-button link type="primary" @click="tableRef?.clearSelection()">取消勾选</el-button>
        <span class="text-muted">「下发指令」与「推送更新」都可以只作用于这些设备。</span>
      </div>

      <el-table
        ref="tableRef"
        v-loading="loading"
        :data="devices"
        row-key="id"
        @selection-change="onSelectionChange"
      >
        <el-table-column type="selection" width="46" reserve-selection />

        <el-table-column label="班级" min-width="130" show-overflow-tooltip>
          <template #default="{ row }">
            <span v-if="row.className">{{ row.className }}</span>
            <span v-else class="text-muted">未绑定班级</span>
          </template>
        </el-table-column>

        <el-table-column prop="name" label="设备名" min-width="150" show-overflow-tooltip />

        <el-table-column label="客户端版本" min-width="140">
          <template #default="{ row }">
            <span>{{ normalizeVersion(row.clientVersion) || '未知' }}</span>
            <!-- 与服务端缓存里的最新版比对；服务端没缓存安装包就不标（标了也推不动） -->
            <el-tag v-if="isUpdatable(row)" class="client-tag" size="small" type="warning" effect="plain">
              可更新
            </el-tag>
          </template>
        </el-table-column>

        <el-table-column label="平台" width="90">
          <template #default="{ row }">
            <span>{{ row.platform || '—' }}</span>
          </template>
        </el-table-column>

        <el-table-column label="状态" min-width="170">
          <template #default="{ row }">
            <el-tag size="small" :type="row.online ? 'success' : 'info'" effect="plain">
              {{ row.online ? '在线' : '离线' }}
            </el-tag>
            <div v-if="row.stateNote" class="client-sub text-muted">{{ row.stateNote }}</div>
            <div v-if="row.lastIp" class="client-sub text-muted">{{ row.lastIp }}</div>
          </template>
        </el-table-column>

        <el-table-column label="最近心跳" min-width="120">
          <template #default="{ row }">
            <span v-if="row.lastHeartbeatAt">{{ relativeTime(row.lastHeartbeatAt, new Date(nowTick)) }}</span>
            <span v-else class="text-muted">从未上报</span>
          </template>
        </el-table-column>

        <el-table-column label="待执行命令" min-width="170">
          <template #default="{ row }">
            <template v-if="row.pendingCommand">
              <el-tag size="small" type="warning" effect="plain">
                {{ commandLabel(row.pendingCommand.kind) }}
              </el-tag>
              <!-- payload 是服务端拼好的「动作（备注）」，直接展示即可 -->
              <div v-if="row.pendingCommand.payload" class="client-sub text-muted">
                {{ row.pendingCommand.payload }}
              </div>
              <div class="client-sub text-muted">等待设备接收并执行</div>
            </template>
            <span v-else class="text-muted">—</span>
          </template>
        </el-table-column>

        <el-table-column label="安装时机" min-width="170">
          <template #default="{ row }">
            {{
              row.updateTargetVersion
                ? { immediate: '立即更新', 'after-school': '放学后更新', idle: '空闲时更新' }[
                    row.updateMode as 'immediate' | 'after-school' | 'idle'
                  ]
                : '—'
            }}
            <div v-if="row.updateNotBefore" class="text-muted">
              {{ formatDate(row.updateNotBefore, true) }}
            </div>
          </template>
        </el-table-column>
        <el-table-column label="最近指令" min-width="200">
          <template #default="{ row }">
            <template v-if="row.lastCommand">
              {{ commandLabel(row.lastCommand.kind) }}：{{
                row.lastCommand.result ||
                (row.lastCommand.expiresAt && Date.parse(row.lastCommand.expiresAt) < Date.now()
                  ? '已过期（设备未回执）'
                  : '等待设备接收并回执')
              }}
            </template>
            <span v-else>—</span>
          </template>
        </el-table-column>
        <el-table-column label="更新" min-width="150">
          <template #default="{ row }">
            <template v-if="row.pendingVersion">
              <el-tag class="client-tag" size="small" type="success" effect="plain">
                已下载待安装 v{{ normalizeVersion(row.pendingVersion) }}
              </el-tag>
            </template>
            <template v-if="row.updateTargetVersion">
              <el-tag class="client-tag" size="small" type="primary" effect="plain">
                已指定 v{{ targetVersionLabel(row) }}
              </el-tag>
            </template>
            <span v-if="!row.pendingVersion && !row.updateTargetVersion" class="text-muted">—</span>
          </template>
        </el-table-column>

        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-tooltip :disabled="!commandDisabledReason" :content="commandDisabledReason" placement="top">
              <span>
                <el-button
                  link
                  type="primary"
                  :disabled="canRemoteControlDisabled"
                  @click="
                    () => {
                      selectedDevices = [row];
                      openCommandDialog();
                    }
                  "
                >
                  下发指令
                </el-button>
              </span>
            </el-tooltip>
            <el-tooltip
              :disabled="can('client:manage')"
              content="当前账号没有「管理客户端设备」权限（client:manage）"
              placement="top"
            >
              <span>
                <el-button link type="danger" :disabled="!can('client:manage')" @click="removeDevice(row)">
                  删除
                </el-button>
              </span>
            </el-tooltip>
          </template>
        </el-table-column>

        <template #empty>
          <el-empty :description="deviceEmptyText" />
        </template>
      </el-table>
    </el-card>

    <!-- ------------------------------------------------ 下发更新 -->
    <el-dialog
      v-model="updateDialog.visible"
      title="推送客户端更新"
      :width="isMobile ? '92%' : '560px'"
      :close-on-click-modal="false"
    >
      <el-form label-position="top">
        <el-form-item label="作用范围">
          <el-radio-group v-model="updateDialog.scope">
            <el-radio value="all">全部设备</el-radio>
            <el-radio value="class">按班级</el-radio>
            <el-radio value="selected" :disabled="selectedCount === 0">
              仅选中的 {{ selectedCount }} 台
            </el-radio>
          </el-radio-group>
        </el-form-item>

        <el-form-item v-if="updateDialog.scope === 'class'" label="选择班级">
          <el-select v-model="updateDialog.classIds" class="client-full" multiple placeholder="可多选">
            <el-option v-for="item in classes" :key="item.id" :label="item.name" :value="item.id" />
          </el-select>
        </el-form-item>

        <el-form-item label="清除服务端指定的版本">
          <el-switch v-model="updateDialog.clear" />
          <span class="text-muted client-switch-hint">
            打开后不再要求这批设备升级（已经下载好的包保留，但取消自动安装）。
          </span>
        </el-form-item>

        <el-form-item v-if="!updateDialog.clear" label="安装时机">
          <el-radio-group v-model="updateDialog.mode">
            <el-radio value="immediate">立即更新</el-radio>
            <el-radio value="after-school">放学后更新</el-radio>
            <el-radio value="idle">空闲时更新</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="!updateDialog.clear && updateDialog.mode === 'after-school'" label="最早安装时间">
          <el-time-select
            v-model="updateDialog.afterSchoolTime"
            start="00:00"
            end="23:45"
            step="00:15"
            :clearable="false"
          />
          <span class="text-muted">
            按服务器今天的日期；若课表结束更晚，等待最后一节课结束。离线设备上线后补执行。
          </span>
        </el-form-item>
        <el-form-item v-if="!updateDialog.clear" label="目标版本">
          <el-select
            v-model="updateDialog.version"
            class="client-full"
            clearable
            placeholder="选择已就绪的安装包版本"
          >
            <el-option
              v-for="release in readyReleases"
              :key="release.version"
              :label="`v${normalizeVersion(release.version)}（${formatSize(release.size)}）`"
              :value="release.version"
            />
          </el-select>
          <p v-if="readyReleases.length === 0" class="client-note text-muted">
            服务端还没有可用的安装包，请先去「安装包管理」从 GitHub
            拉取一份（由服务器代替教室下载，教室机器不需要外网）。
          </p>
          <p class="client-note text-muted">
            客户端会先下载并校验，再按所选时机安装；立即更新会重启客户端，请先确认课堂使用情况。
          </p>
        </el-form-item>

        <el-alert class="client-banner" type="info" :closable="false" :title="updateScopeHint" />
      </el-form>
      <template #footer>
        <el-button @click="updateDialog.visible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="updateDialog.submitting"
          :disabled="updateSubmitDisabled"
          @click="submitUpdate"
        >
          {{ updateDialog.clear ? '清除指定' : '推送' }}
        </el-button>
      </template>
    </el-dialog>

    <!-- ------------------------------------------------ 下发指令 -->
    <el-dialog
      v-model="commandDialog.visible"
      title="下发远控指令"
      :width="isMobile ? '92%' : '520px'"
      :close-on-click-modal="false"
    >
      <el-form label-position="top">
        <el-form-item label="动作">
          <el-select v-model="commandDialog.kind" class="client-full">
            <el-option
              v-for="kind in CLIENT_COMMAND_KINDS"
              :key="kind"
              :label="CLIENT_COMMAND_LABELS[kind]"
              :value="kind"
            />
          </el-select>
        </el-form-item>

        <el-form-item :label="`备注（选填，最多 80 字）`">
          <el-input
            v-model="commandDialog.note"
            type="textarea"
            :rows="2"
            maxlength="80"
            show-word-limit
            placeholder="例如：考试结束请关机"
          />
        </el-form-item>

        <el-form-item label="目标设备">
          <div class="client-target-list">
            <el-tag
              v-for="device in selectedDevices"
              :key="device.id"
              class="client-tag"
              size="small"
              effect="plain"
            >
              {{ device.name }}
            </el-tag>
            <span v-if="selectedDevices.length === 0" class="text-muted">未勾选设备</span>
          </div>
        </el-form-item>
      </el-form>

      <el-alert
        class="client-banner"
        type="warning"
        :closable="false"
        show-icon
        title="目标机器收到后立即执行，不再等待教室确认"
      >
        <template #default>
          命令 {{ commandExpireText }}内有效，过期自动失效（机器离线几天后开机也不会突然关机）。
        </template>
      </el-alert>

      <template #footer>
        <el-button @click="commandDialog.visible = false">取消</el-button>
        <el-button
          :type="isDestructiveCommand ? 'danger' : 'primary'"
          :loading="commandDialog.submitting"
          @click="submitCommand"
        >
          确认下发
        </el-button>
      </template>
    </el-dialog>

    <!-- ------------------------------------------------ 批量结果明细 -->
    <el-dialog v-model="resultDialog.visible" :title="resultDialog.title" :width="isMobile ? '92%' : '640px'">
      <el-alert
        class="client-banner"
        type="warning"
        :closable="false"
        show-icon
        :title="resultDialog.summary"
      />
      <el-table :data="resultDialog.failures" max-height="320" empty-text="没有失败项">
        <el-table-column label="设备" min-width="160">
          <template #default="{ row }">{{ failureDeviceName(row) }}</template>
        </el-table-column>
        <el-table-column label="失败原因" min-width="240">
          <template #default="{ row }">{{ failureReason(row) }}</template>
        </el-table-column>
      </el-table>
      <template #footer>
        <el-button type="primary" @click="resultDialog.visible = false">知道了</el-button>
      </template>
    </el-dialog>

    <!-- ------------------------------------------------ 安装包管理 -->
    <el-drawer v-model="releasesDrawer.visible" :size="isMobile ? '94%' : '720px'" title="客户端安装包管理">
      <p class="client-note text-muted">
        安装包缓存在服务端上。教室机器常常没有外网，因此由服务器替教室从 GitHub 下载；
        客户端更新时也是从本服务器下载，教室机器不需要外网。
      </p>

      <div class="client-release-forms">
        <div class="client-release-form">
          <div class="client-release-form-title">从 GitHub 拉取</div>
          <el-input
            v-model="releasesDrawer.fetchVersion"
            placeholder="版本号，例如 1.2.0"
            :disabled="releasesDrawer.fetching"
            @keyup.enter="fetchRelease"
          />
          <el-button
            type="primary"
            class="client-release-submit"
            :icon="'Upload'"
            :loading="releasesDrawer.fetching"
            :disabled="!can('client:update')"
            @click="fetchRelease"
          >
            拉取并登记
          </el-button>
          <p class="client-note text-muted">
            由服务器代为下载
            {{
              releasesDrawer.fetchVersion.trim()
                ? clientReleaseFileName(releasesDrawer.fetchVersion)
                : '安装包'
            }}
            ，可能要几分钟；期间按钮会一直转圈，请不要重复点击。
          </p>
        </div>

        <div class="client-release-form">
          <div class="client-release-form-title">登记本地文件</div>
          <el-input
            v-model="releasesDrawer.registerVersion"
            placeholder="版本号，例如 1.2.0"
            :disabled="releasesDrawer.registering"
          />
          <el-input
            v-model="releasesDrawer.registerFileName"
            class="client-release-file"
            placeholder="文件名（留空按发布约定推导）"
            :disabled="releasesDrawer.registering"
          />
          <el-button
            class="client-release-submit"
            :icon="'FolderAdd'"
            :loading="releasesDrawer.registering"
            :disabled="!can('client:update')"
            @click="registerRelease"
          >
            登记
          </el-button>
          <p class="client-note text-muted">
            手工放进服务器的 data/client-releases/&lt;版本&gt;/ 目录后再登记；服务端会自己算大小与 sha256。
          </p>
        </div>
      </div>

      <el-card shadow="never" class="table-card">
        <el-table v-loading="releasesDrawer.fetching" :data="releases" empty-text="还没有缓存任何安装包">
          <el-table-column label="版本" width="100">
            <template #default="{ row }">v{{ normalizeVersion(row.version) }}</template>
          </el-table-column>
          <el-table-column prop="fileName" label="文件名" min-width="230" show-overflow-tooltip />
          <el-table-column label="大小" width="100">
            <template #default="{ row }">{{ formatSize(row.size) }}</template>
          </el-table-column>
          <el-table-column label="sha256" width="150">
            <template #default="{ row }">
              <el-tooltip :content="row.sha256 || '未计算'" placement="top">
                <span class="client-sha">{{ shortSha(row.sha256) }}</span>
              </el-tooltip>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag size="small" :type="row.fileReady ? 'success' : 'danger'" effect="plain">
                {{ row.fileReady ? '已就绪' : '文件缺失' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="170" fixed="right">
            <template #default="{ row }">
              <el-button
                link
                type="primary"
                :disabled="!row.fileReady || !can('client:update')"
                @click="useReleaseAsTarget(row)"
              >
                设为更新目标
              </el-button>
              <el-button link type="danger" :disabled="!can('client:update')" @click="removeRelease(row)">
                删除
              </el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-card>
    </el-drawer>
  </div>
</template>

<style scoped>
/* 顶部横幅 / 弹窗内提示：圆角与底都走设计令牌，不写死数值（AGENTS.md §5 第 11 条） */
.client-banner {
  margin-bottom: 12px;
  border-radius: var(--ch-radius-sm);
}

.client-class-filter {
  width: 180px;
}

/* 自动刷新说明：桌面端跟在按钮后面，小屏自己换行（见下方媒体查询） */
.client-refresh-hint {
  font-size: 12px;
  line-height: 1.5;
}

/* 主操作按钮组：桌面端推到右侧，小屏铺满一行 */
.client-actions {
  display: flex;
  gap: 8px;
  margin-left: auto;
}

.client-selection-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 6px 2px 10px;
  font-size: 13px;
}

/* 表格里的次级说明（状态备注 / IP / 等待确认） */
.client-sub {
  margin-top: 2px;
  font-size: 12px;
  line-height: 1.4;
  word-break: break-all;
}

.client-tag {
  margin: 0 6px 2px 0;
}

.client-full {
  width: 100%;
}

.client-switch-hint {
  margin-left: 10px;
  font-size: 12px;
  line-height: 1.5;
}

.client-note {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.6;
}

.client-release-forms {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 12px;
}

.client-release-form {
  padding: 12px;
  border: 1px solid var(--ch-border);
  border-radius: var(--ch-radius-md);
  background: var(--ch-surface-alt);
}

.client-release-form-title {
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 600;
}

.client-release-file {
  margin-top: 8px;
}

.client-release-submit {
  margin-top: 8px;
  width: 100%;
}

.client-sha {
  font-family: var(--ch-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px;
}

.client-target-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  max-height: 120px;
  overflow-y: auto;
  padding: 4px 10px;
  border: 1px solid var(--ch-border);
  border-radius: var(--ch-radius-md);
  background: var(--ch-surface-alt);
  width: 100%;
}

/* 小屏 ≤768px：工具栏铺满、按钮各占一行、安装包表单改单列 */
@media (max-width: 768px) {
  .client-class-filter {
    width: 100%;
  }

  .client-actions {
    margin-left: 0;
    width: 100%;
    flex-direction: column;
  }

  .client-actions :deep(.el-button) {
    width: 100%;
    margin-left: 0;
  }

  .client-release-forms {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
