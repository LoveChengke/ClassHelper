<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  HOMEWORK_PHRASE_DEFAULTS,
  HOMEWORK_PHRASE_MAX_COUNT,
  HOMEWORK_PHRASE_MAX_LENGTH,
  formatDate,
  relativeTime,
} from '@classhelper/shared';
import type { ClientAgentStatus } from '../../../types/desktop.js';
import { pingHealth, setApiBaseUrl } from '../../api/http.js';
import { normalizeServerUrl } from '../../config.js';
import { useAppStore } from '../../stores/app.js';
import { useAuthStore } from '../../stores/auth.js';
import { useNotificationStore } from '../../stores/notifications.js';
import { useOnboardingStore } from '../../stores/onboarding.js';
import { useRealtimeStore } from '../../stores/realtime.js';
import { useUiStore } from '../../stores/ui.js';

/**
 * 通用设置：服务器连接、离线缓存与作业录入短语。
 * （外观 / 灵动岛 / 提醒 / 账号 / 关于 各自是独立子页，见侧边栏「设置」分组。）
 */
const appStore = useAppStore();
const auth = useAuthStore();
const onboarding = useOnboardingStore();
const realtime = useRealtimeStore();
const notifications = useNotificationStore();
const ui = useUiStore();

const serverInput = ref(appStore.serverUrl);
const testing = ref(false);
const saving = ref(false);

const storeLabels: Record<string, string> = {
  profile: '登录资料',
  classes: '班级 / 学期',
  schedules: '课表',
  homeworks: '作业',
  notifications: '通知',
  grades: '成绩',
};

const cacheRows = computed(() =>
  appStore.cacheStoreStats.map((item) => ({
    label: storeLabels[item.store] ?? item.store,
    store: item.store,
    count: item.count,
    updatedAt: item.updatedAt ? formatDate(item.updatedAt, true) : '—',
  })),
);

async function saveServer(): Promise<void> {
  const normalized = normalizeServerUrl(serverInput.value);
  if (!normalized) {
    ElMessage.error('服务器地址格式不正确，例如 http://127.0.0.1:4000');
    return;
  }
  saving.value = true;
  try {
    await appStore.applyServerUrl(normalized);
    serverInput.value = normalized;
    ElMessage.success('服务器地址已保存');
    await testConnection();
    if (auth.token) realtime.connect(normalized, auth.token);
  } finally {
    saving.value = false;
  }
}

async function testConnection(): Promise<void> {
  testing.value = true;
  try {
    const result = await pingHealth();
    if (result.ok) ElMessage.success('服务器连接正常');
    else ElMessage.error('无法连接服务器，请检查地址与网络');
  } finally {
    testing.value = false;
  }
}

async function manualSync(): Promise<void> {
  setApiBaseUrl(appStore.serverUrl);
  await appStore.ping();
  if (appStore.offline) {
    ElMessage.warning('当前无法连接服务器，已保留缓存数据');
    return;
  }
  await notifications.load();
  appStore.markSynced();
  ElMessage.success('已同步最新数据');
}

async function clearCache(): Promise<void> {
  await ElMessageBox.confirm('清空后离线时将无法查看历史数据，确认继续？', '清空离线缓存', {
    type: 'warning',
  });
  await appStore.clearCache();
  ElMessage.success('离线缓存已清空');
}

/* ------------------------------------------------------------ 作业录入快捷短语 */

/**
 * 作业快捷短语：录作业时点一下就把词追加到标题/内容里（P、大本、背诵…）。
 *
 * 存在客户端本地配置（这台教室机器自己的习惯），不占用服务端字段；
 * 空数组是合法值 —— 老师把短语全删了就是"不想用快捷短语"。
 */
const phrases = ref<string[]>([...HOMEWORK_PHRASE_DEFAULTS]);
const phraseInput = ref('');
const savingPhrases = ref(false);

async function loadPhrases(): Promise<void> {
  const config = await window.desktop?.getConfig?.();
  if (config?.homeworkPhrases) phrases.value = [...config.homeworkPhrases];
}

async function savePhrases(): Promise<void> {
  if (!window.desktop?.saveConfig) return;
  savingPhrases.value = true;
  try {
    const saved = await window.desktop.saveConfig({ homeworkPhrases: [...phrases.value] });
    phrases.value = [...saved.homeworkPhrases];
  } finally {
    savingPhrases.value = false;
  }
}

async function addPhrase(): Promise<void> {
  const value = phraseInput.value.trim().slice(0, HOMEWORK_PHRASE_MAX_LENGTH);
  if (!value) return;
  if (phrases.value.includes(value)) {
    ElMessage.warning('这条短语已经有了');
    return;
  }
  if (phrases.value.length >= HOMEWORK_PHRASE_MAX_COUNT) {
    ElMessage.warning(`最多 ${HOMEWORK_PHRASE_MAX_COUNT} 条快捷短语`);
    return;
  }
  phrases.value = [...phrases.value, value];
  phraseInput.value = '';
  await savePhrases();
  ElMessage.success('已添加');
}

async function removePhrase(value: string): Promise<void> {
  phrases.value = phrases.value.filter((item) => item !== value);
  await savePhrases();
}

async function resetPhrases(): Promise<void> {
  await ElMessageBox.confirm('恢复为默认快捷短语？', '恢复默认', { type: 'warning' });
  phrases.value = [...HOMEWORK_PHRASE_DEFAULTS];
  await savePhrases();
  ElMessage.success('已恢复默认');
}

/* ------------------------------------------------------------ 启动与更新 / 服务端联动 */

/**
 * 开机自启与自动更新。
 *
 * 开机自启的"是否生效"以**系统登录项**为准（新增的 `getAutoLaunch` 桥读的是
 * `app.getLoginItemSettings()`，不是配置文件里的值）—— 用户可能在任务管理器的「启动」页
 * 里手动禁用了它，这时候配置写着 true 也不该显示成已开启。
 */
const autoLaunch = ref(false);
const savingLaunch = ref(false);

/** 服务端联动状态（心跳上报 / 目标版本 / 待安装版本） */
const agent = ref<ClientAgentStatus | null>(null);
const agentLoading = ref(false);
/** 本机客户端版本（与服务端下发的目标版本对照着看） */
const appVersion = ref('—');

/** 最近上报时间的相对描述（没有上报过就显示占位符） */
const lastHeartbeatText = computed(() => {
  const value = agent.value?.lastHeartbeatAt;
  if (!value) return '还没有上报过';
  return relativeTime(value);
});

/** 服务端对本机版本的期望：空串表示"不需要更新" */
const updateTargetText = computed(() => {
  const target = agent.value?.updateTargetVersion ?? '';
  if (!target) return '无（保持当前版本）';
  return target;
});

const pendingUpdateText = computed(() => {
  const pending = agent.value?.pendingUpdateVersion ?? '';
  if (!pending) return '无';
  return `${pending}（已下载，空闲时自动安装）`;
});

const lastErrorText = computed(() => agent.value?.lastError?.trim() || '无');

async function loadLaunchSettings(): Promise<void> {
  if (!window.desktop?.getConfig) return;
  const config = await window.desktop.getConfig();
  autoLaunch.value = (await window.desktop.getAutoLaunch?.()) ?? config.autoLaunch === true;
  const info = await window.desktop.getAppInfo?.().catch(() => null);
  if (info?.appVersion) appVersion.value = info.appVersion;
}

async function toggleAutoLaunch(value: string | number | boolean): Promise<void> {
  if (!window.desktop?.setAutoLaunch) return;
  const wanted = value === true;
  autoLaunch.value = wanted;
  savingLaunch.value = true;
  try {
    const effective = await window.desktop.setAutoLaunch(wanted);
    // 以系统实际生效值为准：写注册表失败时会与用户点的不一致，必须回显真实状态
    autoLaunch.value = effective;
    if (effective !== wanted) ElMessage.warning('系统未接受开机自启设置，请检查任务管理器里的启动项');
    else ElMessage.success(wanted ? '已开启开机自启' : '已关闭开机自启');
  } catch (error) {
    autoLaunch.value = !wanted;
    ElMessage.error(error instanceof Error ? error.message : '设置开机自启失败');
  } finally {
    savingLaunch.value = false;
  }
}

/* ------------------------------------------------------------ 开发者模式 */

/**
 * 开发者模式（需求 10）：显示调试页面与详细日志，仅排查问题时打开。
 *
 * 打开后侧栏「设置」分组里**立刻**多出「开发者」页（`ClientLayout.vue` 读的是同一个
 * ui store 状态），下次启动时主进程会把日志级别调到 debug。
 */
const savingDeveloperMode = ref(false);

async function toggleDeveloperMode(value: string | number | boolean): Promise<void> {
  const wanted = value === true;
  savingDeveloperMode.value = true;
  try {
    await ui.setDeveloperMode(wanted);
    ElMessage.success(wanted ? '已开启开发者模式：侧栏出现「开发者」页' : '已关闭开发者模式');
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存开发者模式设置失败');
  } finally {
    savingDeveloperMode.value = false;
  }
}

async function refreshAgentStatus(): Promise<void> {
  if (!window.desktop?.getClientAgentStatus) return;
  agentLoading.value = true;
  try {
    agent.value = await window.desktop.getClientAgentStatus();
  } finally {
    agentLoading.value = false;
  }
}

async function beatNow(): Promise<void> {
  if (!window.desktop?.beatClientNow) return;
  agentLoading.value = true;
  try {
    // 手动上报是"立刻打一次"，成功/失败都刷新状态，失败原因展示在「最近错误」里
    agent.value = await window.desktop.beatClientNow();
    if (agent.value?.lastError) ElMessage.warning(`上报未成功：${agent.value.lastError}`);
    else ElMessage.success('已向服务端上报本机状态');
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '上报失败，请检查网络与登录状态');
  } finally {
    agentLoading.value = false;
  }
}

async function openLogDir(): Promise<void> {
  if (!window.desktop?.openLogDir) return;
  const ok = await window.desktop.openLogDir();
  if (!ok) ElMessage.warning('打开日志目录失败，可在「关于」页复制诊断信息');
}

/** 状态里的相对时间要跟着走，否则挂着的页面会一直显示"刚刚" */
let statusTimer: ReturnType<typeof setInterval> | null = null;

onMounted(async () => {
  await appStore.refreshCacheStats();
  await loadPhrases();
  await loadLaunchSettings();
  await refreshAgentStatus();
  statusTimer = setInterval(() => {
    void refreshAgentStatus();
  }, 30_000);
});

onBeforeUnmount(() => {
  if (statusTimer !== null) {
    clearInterval(statusTimer);
    statusTimer = null;
  }
});
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">通用</h2>
        <p class="page-subtitle">服务器连接、离线缓存与作业录入</p>
      </div>
      <!-- 重看初次启动引导（首启时由 App.vue 自动弹出过一次） -->
      <el-button @click="onboarding.open()">
        <el-icon><Guide /></el-icon>
        使用引导
      </el-button>
    </div>

    <el-row :gutter="12">
      <el-col :xs="24" :md="12">
        <el-card shadow="never">
          <template #header><span>服务器连接</span></template>
          <el-form label-position="top">
            <el-form-item label="服务器地址">
              <el-input v-model="serverInput" placeholder="http://127.0.0.1:4000">
                <template #prefix>
                  <el-icon><Link /></el-icon>
                </template>
              </el-input>
            </el-form-item>
          </el-form>
          <div class="toolbar">
            <el-button type="primary" :loading="saving" @click="saveServer">保存并测试</el-button>
            <el-button :loading="testing" @click="testConnection">测试连接</el-button>
            <el-button @click="manualSync">立即同步</el-button>
          </div>

          <el-descriptions class="mt-16" :column="1" border size="small">
            <el-descriptions-item label="当前状态">
              <el-tag :type="appStore.serverReachable ? 'success' : 'danger'" size="small">
                {{ appStore.serverReachable ? '服务器可达' : '离线（显示缓存数据）' }}
              </el-tag>
              <el-tag class="ml-8" :type="realtime.connected ? 'success' : 'info'" size="small">
                {{ realtime.statusText }}
              </el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="最近同步">{{ appStore.lastSyncText }}</el-descriptions-item>
            <el-descriptions-item label="实时事件数">{{ realtime.eventCount }} 条</el-descriptions-item>
          </el-descriptions>
        </el-card>

        <el-card shadow="never" class="mt-12">
          <template #header><span>作业录入</span></template>
          <p class="text-muted">
            在教室电脑上录作业时，点一下短语就会追加到标题 / 内容里（例如 P、大本、背诵）。 最多
            {{ HOMEWORK_PHRASE_MAX_COUNT }} 条、每条
            {{ HOMEWORK_PHRASE_MAX_LENGTH }} 字；全部删掉即不在录入页显示。
          </p>
          <div class="phrase-row">
            <el-tag
              v-for="item in phrases"
              :key="item"
              closable
              type="info"
              effect="plain"
              @close="removePhrase(item)"
            >
              {{ item }}
            </el-tag>
            <span v-if="phrases.length === 0" class="text-muted">（已清空）</span>
          </div>
          <div class="toolbar mt-12">
            <el-input
              v-model="phraseInput"
              placeholder="新增短语，如 大本"
              style="width: 200px"
              :maxlength="HOMEWORK_PHRASE_MAX_LENGTH"
              @keyup.enter="addPhrase"
            />
            <el-button type="primary" :loading="savingPhrases" @click="addPhrase">添加</el-button>
            <el-button @click="resetPhrases">恢复默认</el-button>
          </div>
        </el-card>

        <el-card shadow="never" class="mt-12">
          <template #header><span>启动与更新</span></template>
          <div class="switch-row">
            <div class="switch-main">
              <span>开机自启</span>
              <p class="text-muted">登录 Windows 后自动启动 ClassHelper；教室机器建议打开。</p>
            </div>
            <el-switch
              :model-value="autoLaunch"
              :loading="savingLaunch"
              @update:model-value="toggleAutoLaunch"
            />
          </div>
          <div class="switch-row">
            <div class="switch-main">
              <span>自动更新</span>
              <p class="text-muted">
                安装只在
                <strong>不上课且窗口已隐藏 5 分钟后</strong>
                进行，下载随时可能发生。
              </p>
              <!--
                这里**刻意没有开关**（需求：「客户端无权选择是否要自动更新」）。
                教室机器是统一的投放终端，版本一致性由管理员在服务端「客户端设备」页决定；
                留一个本地开关只会让"为什么这台还没升"变成无解的排查题。
                客户端配置里的 `autoUpdate` 仍然照读（`autoUpdate !== false` 才自动装），
                因为服务端下发的是一台机器的目标版本，不是"允许不允许更新"。
              -->
              <p class="text-muted">更新由管理员在服务端统一推送，教室机器不提供本地开关。</p>
            </div>
          </div>
          <div class="toolbar mt-12">
            <el-button @click="openLogDir">打开日志目录</el-button>
            <span class="text-muted">日志文件 main.log，排查问题时可发给管理员</span>
          </div>
        </el-card>

        <el-card shadow="never" class="mt-12">
          <template #header><span>显示与调试</span></template>
          <!--
            关怀模式**只保留在 Web 管理端**（需求：「客户端无需关怀模式」）。
            客户端是投在教室大屏上的固定界面，字号由「外观」页的看板/岛设置管，
            再来一套全站放大只会和那些设置互相打架，所以这里不再提供开关。
            `stores/ui.ts` 与 `styles/index.css` 里的那套管道暂时保留（配置里还有这个字段，
            删掉会让老 config.json 反序列化时多一条归一化分支），但界面上不再暴露。
          -->
          <div class="switch-row">
            <div class="switch-main">
              <span>开发者模式</span>
              <p class="text-muted">显示调试页面与详细日志，仅排查问题时打开。</p>
              <p v-if="ui.developerMode" class="text-muted">
                debug 级日志已开启；侧栏「设置 → 开发者」可查看版本、设备上报、更新检查、日志目录与 DevTools。
              </p>
            </div>
            <el-switch
              :model-value="ui.developerMode"
              :loading="savingDeveloperMode"
              data-test="developer-mode-switch"
              @update:model-value="toggleDeveloperMode"
            />
          </div>
        </el-card>
      </el-col>

      <el-col :xs="24" :md="12">
        <el-card shadow="never">
          <template #header><span>离线缓存（IndexedDB）</span></template>
          <el-table :data="cacheRows" size="small" empty-text="暂无缓存数据">
            <el-table-column prop="label" label="数据类型" width="130" />
            <el-table-column label="条目数" width="90">
              <template #default="{ row }">{{ row.count }}</template>
            </el-table-column>
            <el-table-column label="最近更新" min-width="150">
              <template #default="{ row }">{{ row.updatedAt }}</template>
            </el-table-column>
          </el-table>
          <div class="toolbar mt-12">
            <el-button :icon="'Refresh'" @click="appStore.refreshCacheStats()">刷新统计</el-button>
            <el-button type="danger" plain @click="clearCache">清空缓存</el-button>
          </div>
          <el-alert
            class="mt-12"
            type="info"
            :closable="false"
            show-icon
            title="离线可用"
            description="断网后课表、作业、通知、成绩都会从本地缓存读取；恢复网络后自动向服务器同步最新数据。"
          />
        </el-card>

        <el-card shadow="never" class="mt-12">
          <template #header><span>服务端联动状态</span></template>
          <p class="text-muted">
            本机每 30 秒向服务端上报一次状态（是否在上课、当前版本、已下载的更新），
            服务端据此下发统一更新与远控命令。本机标识尾号用于在服务端设备列表里核对这台电脑。
          </p>
          <el-descriptions class="mt-12" :column="1" border size="small">
            <el-descriptions-item label="连接状态">
              <el-tag :type="agent?.online ? 'success' : 'info'" size="small">
                {{ agent?.online ? '已连接（近期上报成功）' : '未连接（等待上报）' }}
              </el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="本机版本">
              {{ appVersion }}
            </el-descriptions-item>
            <el-descriptions-item label="设备标识尾号">
              {{ agent?.deviceKeyTail || '—' }}
            </el-descriptions-item>
            <el-descriptions-item label="最近上报">{{ lastHeartbeatText }}</el-descriptions-item>
            <el-descriptions-item label="服务端目标版本">{{ updateTargetText }}</el-descriptions-item>
            <el-descriptions-item label="已下载待安装">{{ pendingUpdateText }}</el-descriptions-item>
            <el-descriptions-item label="最近错误">{{ lastErrorText }}</el-descriptions-item>
          </el-descriptions>
          <div class="toolbar mt-12">
            <el-button type="primary" :loading="agentLoading" @click="beatNow">立即上报</el-button>
            <el-button :loading="agentLoading" @click="refreshAgentStatus">刷新状态</el-button>
          </div>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<style scoped>
.phrase-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}

.ml-8 {
  margin-left: 8px;
}

/* 开关行：左说明右开关，说明长时自动换行（「自动更新」的提示是两行） */
.switch-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 8px 0;
}

.switch-row + .switch-row {
  border-top: 1px solid var(--ch-border);
}

.switch-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.switch-main p {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
}
</style>
