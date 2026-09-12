<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { PRIORITY_LABELS, formatDate, type IslandState } from '@classhelper/shared';
import type { DesktopAppInfo } from '../../types/desktop.js';
import { pingHealth, setApiBaseUrl } from '../api/http.js';
import { normalizeServerUrl } from '../config.js';
import { getIslandClassContext } from '../island/bridge.js';
import { useAppStore } from '../stores/app.js';
import { useAuthStore } from '../stores/auth.js';
import { useNotificationStore } from '../stores/notifications.js';
import { useRealtimeStore } from '../stores/realtime.js';

const router = useRouter();
const appStore = useAppStore();
const auth = useAuthStore();
const realtime = useRealtimeStore();
const notifications = useNotificationStore();

const serverInput = ref(appStore.serverUrl);
const testing = ref(false);
const saving = ref(false);
const appInfo = ref<DesktopAppInfo | null>(null);

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

async function loadAppInfo(): Promise<void> {
  if (!window.desktop) return;
  appInfo.value = await window.desktop.getAppInfo();
}

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

async function logout(): Promise<void> {
  await ElMessageBox.confirm('确认退出当前账号？', '退出登录', { type: 'warning' });
  realtime.disconnect();
  await auth.logout();
  ElMessage.success('已退出登录');
  await router.replace('/login');
}

/* ------------------------------------------------------------ 灵动岛自检 */

const islandState = ref<IslandState | null>(null);
const islandClassContext = ref(getIslandClassContext());
let islandTimer: ReturnType<typeof setInterval> | null = null;

/** 主进程侧灵动岛状态（隐藏/胶囊/详情 + 待发条数 + 是否上课） */
async function refreshIslandState(): Promise<void> {
  islandClassContext.value = getIslandClassContext();
  if (!window.desktop?.islandGetState) return;
  islandState.value = await window.desktop.islandGetState();
}

const islandModeLabel = computed(() => {
  switch (islandState.value?.mode) {
    case 'pill':
      return '新消息胶囊';
    case 'expanded':
      return '展开详情';
    case 'hidden':
      return '隐藏（无通知时不显示）';
    default:
      return '未知';
  }
});

const islandHint = computed(() => {
  const state = islandState.value;
  if (!state) return '灵动岛尚未就绪';
  if (islandClassContext.value.inClass) {
    return state.active?.priority === 'URGENT'
      ? '上课中：正在显示紧急通知'
      : '上课中：通知会暂存，下课后自动弹出（紧急通知除外）';
  }
  if (state.queued.length > 0) return `有 ${state.queued.length} 条通知待查看`;
  return '收到通知时会在这里浮出胶囊';
});

/** 本地推一条测试通知，立刻确认灵动岛能出现（走主进程，不依赖服务器） */
function testIsland(): void {
  if (!window.desktop?.islandPush) {
    ElMessage.error('当前环境不支持灵动岛');
    return;
  }
  window.desktop.islandPush({
    notification: {
      id: `local-test-${Date.now()}`,
      title: '灵动岛自检通知',
      content: '如果你看到这条胶囊/卡片，说明灵动岛工作正常；点击它可以展开查看详情。',
      priority: 'NORMAL',
      createdAt: new Date().toISOString(),
      courseName: null,
      teacherName: '本地自检',
    },
    context: islandClassContext.value,
  });
  void refreshIslandState();
}

onMounted(async () => {
  await loadAppInfo();
  await appStore.refreshCacheStats();
  await refreshIslandState();
  islandTimer = setInterval(() => void refreshIslandState(), 2000);
});

onUnmounted(() => {
  if (islandTimer) clearInterval(islandTimer);
  islandTimer = null;
});
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">设置</h2>
        <p class="page-subtitle">服务器连接、账号信息与离线缓存管理</p>
      </div>
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
          <template #header>
            <span>灵动岛（桌面通知浮窗）</span>
          </template>
          <el-descriptions :column="1" border size="small">
            <el-descriptions-item label="当前形态">
              <el-tag :type="islandState?.mode === 'hidden' ? 'info' : 'success'" size="small">
                {{ islandModeLabel }}
              </el-tag>
              <el-tag class="ml-8" :type="islandClassContext.inClass ? 'warning' : 'success'" size="small">
                {{ islandClassContext.inClass ? '上课中（普通通知暂存）' : '非上课时段' }}
              </el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="窗口可见">
              {{ islandState ? (islandState.mode === 'hidden' ? '否（无通知时隐藏）' : '是') : '-' }}
            </el-descriptions-item>
            <el-descriptions-item label="待查看通知">
              {{ islandState?.queued.length ?? 0 }} 条
              <template v-if="islandState?.active">
                · 当前：{{ islandState.active.title }}（{{ PRIORITY_LABELS[islandState.active.priority] }}）
              </template>
            </el-descriptions-item>
            <el-descriptions-item label="说明">{{ islandHint }}</el-descriptions-item>
          </el-descriptions>
          <div class="toolbar mt-12">
            <el-button type="primary" @click="testIsland">测试灵动岛</el-button>
            <el-button @click="refreshIslandState">刷新状态</el-button>
          </div>
        </el-card>

        <el-card shadow="never" class="mt-12">
          <template #header><span>账号信息</span></template>
          <el-descriptions :column="1" border size="small">
            <el-descriptions-item label="姓名">{{ auth.user?.name ?? '-' }}</el-descriptions-item>
            <el-descriptions-item label="用户名">{{ auth.user?.username ?? '-' }}</el-descriptions-item>
            <el-descriptions-item label="班级">{{ auth.user?.className ?? '未分班' }}</el-descriptions-item>
            <el-descriptions-item label="年级">{{ auth.user?.grade ?? '-' }}</el-descriptions-item>
          </el-descriptions>
          <el-button class="mt-16" type="danger" plain @click="logout">退出登录</el-button>
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
          <template #header><span>客户端信息</span></template>
          <el-descriptions :column="1" border size="small">
            <el-descriptions-item label="应用版本">{{ appInfo?.appVersion ?? '-' }}</el-descriptions-item>
            <el-descriptions-item label="Electron">{{ appInfo?.electron ?? '-' }}</el-descriptions-item>
            <el-descriptions-item label="Chromium">{{ appInfo?.chrome ?? '-' }}</el-descriptions-item>
            <el-descriptions-item label="Node.js">{{ appInfo?.node ?? '-' }}</el-descriptions-item>
            <el-descriptions-item label="平台">{{ appInfo?.platform ?? '-' }}</el-descriptions-item>
            <el-descriptions-item label="数据目录">{{ appInfo?.userDataPath ?? '-' }}</el-descriptions-item>
          </el-descriptions>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<style scoped>
.ml-8 {
  margin-left: 8px;
}
</style>
