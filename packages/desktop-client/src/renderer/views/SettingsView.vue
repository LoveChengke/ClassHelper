<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  DEFAULT_ISLAND_APPEARANCE,
  ISLAND_APPEARANCE_RANGES as RANGES,
  ISLAND_POSITION_LABELS,
  ISLAND_STYLE_LABELS,
  ISLAND_STYLES,
  ISLAND_POSITIONS,
  formatDate,
  type IslandAppearance,
  type IslandPosition,
  type IslandStyle,
} from '@classhelper/shared';
import type { DesktopAppInfo } from '../../types/desktop.js';
import { pingHealth, setApiBaseUrl } from '../api/http.js';
import { normalizeServerUrl } from '../config.js';
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

/* ------------------------------------------------------------ 灵动岛个性化 */

const island = ref<IslandAppearance>({ ...DEFAULT_ISLAND_APPEARANCE });
const savingIsland = ref(false);

const positionOptions = ISLAND_POSITIONS.map((value) => ({
  value,
  label: ISLAND_POSITION_LABELS[value],
}));

const styleOptions = ISLAND_STYLES.map((value) => ({
  value,
  label: ISLAND_STYLE_LABELS[value],
}));

/** 读取当前生效的外观（主进程为单一事实来源） */
async function loadIslandAppearance(): Promise<void> {
  if (!window.desktop?.islandGetAppearance) return;
  island.value = await window.desktop.islandGetAppearance();
}

/**
 * 改动即生效：属性变化时先应用（实时预览），点"保存"再落盘。
 * 高度/宽度只影响窗口与卡片尺寸变量，内容用 flex + 溢出滚动承载，不会溢出或错乱。
 *
 * 注意：必须传**展开后的纯对象**。`island` 是 `ref`，它的 `.value` 在 Vue 里是响应式
 * Proxy，Proxy 过不了 IPC 的结构化克隆（`An object could not be cloned.`）——
 * 那正是"拖了滑块、数字在变、灵动岛却没反应"的原因。
 */
function applyIslandAppearance(patch: Partial<IslandAppearance> = {}): void {
  island.value = { ...island.value, ...patch };
  window.desktop?.islandSetAppearance({ ...island.value });
}

async function saveIslandAppearance(): Promise<void> {
  if (!window.desktop?.saveConfig) return;
  savingIsland.value = true;
  try {
    await window.desktop.saveConfig({ island: { ...island.value } });
    ElMessage.success('个性化设置已保存');
  } finally {
    savingIsland.value = false;
  }
}

async function resetIslandAppearance(): Promise<void> {
  await ElMessageBox.confirm('恢复灵动岛的默认外观？', '恢复默认', { type: 'warning' });
  applyIslandAppearance({ ...DEFAULT_ISLAND_APPEARANCE });
  await saveIslandAppearance();
}

/** 本地推一条测试通知，立刻确认外观效果（预览模式：直接展开、失焦不收起、30 秒后自动消失） */
function testIsland(): void {
  window.desktop?.islandPush?.({
    notification: {
      id: `appearance-test-${Date.now()}`,
      title: '灵动岛外观预览',
      content: '拖动滑块即可实时预览：高度、宽度、圆角、透明度、字号、主题色、位置与动画。',
      priority: 'NORMAL',
      createdAt: new Date().toISOString(),
      courseName: null,
      teacherName: '本地预览',
    },
    context: { inClass: false, currentPeriodEnd: null, preview: true },
  });
}

onMounted(async () => {
  await loadAppInfo();
  await appStore.refreshCacheStats();
  await loadIslandAppearance();
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
            <span>灵动岛 · 个性化</span>
          </template>
          <el-form label-width="96px" label-position="left">
            <el-form-item :label="`高度 ${island.height}px`">
              <el-slider
                :model-value="island.height"
                :min="RANGES.height.min"
                :max="RANGES.height.max"
                :step="1"
                @input="(value: number) => applyIslandAppearance({ height: value })"
              />
            </el-form-item>
            <el-form-item :label="`宽度 ${island.width}px`">
              <el-slider
                :model-value="island.width"
                :min="RANGES.width.min"
                :max="RANGES.width.max"
                :step="2"
                @input="(value: number) => applyIslandAppearance({ width: value })"
              />
            </el-form-item>
            <el-form-item :label="`圆角 ${island.radius}px`">
              <el-slider
                :model-value="island.radius"
                :min="RANGES.radius.min"
                :max="RANGES.radius.max"
                :step="1"
                @input="(value: number) => applyIslandAppearance({ radius: value })"
              />
            </el-form-item>
            <el-form-item :label="`不透明度 ${Math.round(island.opacity * 100)}%`">
              <el-slider
                :model-value="island.opacity"
                :min="RANGES.opacity.min"
                :max="RANGES.opacity.max"
                :step="0.05"
                @input="(value: number) => applyIslandAppearance({ opacity: value })"
              />
            </el-form-item>
            <el-form-item :label="`字号 ${island.fontSize}px`">
              <el-slider
                :model-value="island.fontSize"
                :min="RANGES.fontSize.min"
                :max="RANGES.fontSize.max"
                :step="1"
                @input="(value: number) => applyIslandAppearance({ fontSize: value })"
              />
            </el-form-item>
            <el-form-item :label="`动画速度 ${island.speed.toFixed(1)}x`">
              <el-slider
                :model-value="island.speed"
                :min="RANGES.speed.min"
                :max="RANGES.speed.max"
                :step="0.1"
                @input="(value: number) => applyIslandAppearance({ speed: value })"
              />
            </el-form-item>
            <el-form-item label="主题色">
              <el-color-picker
                :model-value="island.accent"
                @change="(value: string | null) => applyIslandAppearance({ accent: value ?? '#0a84ff' })"
              />
              <span class="text-muted ml-8">用于高亮、按钮与进度条</span>
            </el-form-item>
            <el-form-item label="视觉风格">
              <el-select
                :model-value="island.style"
                style="width: 180px"
                @change="(value: IslandStyle) => applyIslandAppearance({ style: value })"
              >
                <el-option
                  v-for="item in styleOptions"
                  :key="item.value"
                  :label="item.label"
                  :value="item.value"
                />
              </el-select>
              <span class="text-muted ml-8">纯黑 / 毛玻璃（亚克力）/ 主题色渐变</span>
            </el-form-item>
            <el-form-item label="显示位置">
              <el-select
                :model-value="island.position"
                style="width: 180px"
                @change="(value: IslandPosition) => applyIslandAppearance({ position: value })"
              >
                <el-option
                  v-for="item in positionOptions"
                  :key="item.value"
                  :label="item.label"
                  :value="item.value"
                />
              </el-select>
            </el-form-item>
            <el-form-item label="动画">
              <el-switch
                :model-value="island.animations"
                @change="
                  (value: boolean | string | number) => applyIslandAppearance({ animations: Boolean(value) })
                "
              />
              <span class="text-muted ml-8">关闭后展开/收起为瞬时生效</span>
            </el-form-item>
            <el-form-item label="始终置顶">
              <el-switch
                :model-value="island.alwaysOnTop"
                @change="
                  (value: boolean | string | number) => applyIslandAppearance({ alwaysOnTop: Boolean(value) })
                "
              />
            </el-form-item>
            <el-form-item label="空闲细缝">
              <el-switch
                :model-value="island.idleSliver"
                @change="
                  (value: boolean | string | number) => applyIslandAppearance({ idleSliver: Boolean(value) })
                "
              />
              <span class="text-muted ml-8">参考 WinIsland：没有消息时保留一条细缝（关闭则完全隐藏）</span>
            </el-form-item>
          </el-form>
          <div class="toolbar">
            <el-button type="primary" :loading="savingIsland" @click="saveIslandAppearance">
              保存设置
            </el-button>
            <el-button @click="testIsland">预览效果</el-button>
            <el-button @click="resetIslandAppearance">恢复默认</el-button>
          </div>
          <el-alert
            class="mt-12"
            type="info"
            :closable="false"
            title="拖动滑块即为实时预览；保存后写入本地配置，重启客户端仍然生效"
          />
        </el-card>
        <el-card shadow="never" class="mt-12">
          <template #header><span>账号信息</span></template>
          <el-descriptions :column="1" border size="small">
            <el-descriptions-item label="姓名">{{ auth.user?.name ?? '-' }}</el-descriptions-item>
            <el-descriptions-item :label="auth.isClassSession ? '班级码' : '用户名'">
              {{ auth.user?.username ?? '-' }}
            </el-descriptions-item>
            <el-descriptions-item label="登录方式">
              {{ auth.isClassSession ? '班级账号（本机代表全班）' : '个人学生账号' }}
            </el-descriptions-item>
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
