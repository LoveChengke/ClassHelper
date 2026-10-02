<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  HOMEWORK_PHRASE_DEFAULTS,
  HOMEWORK_PHRASE_MAX_COUNT,
  HOMEWORK_PHRASE_MAX_LENGTH,
  formatDate,
} from '@classhelper/shared';
import { pingHealth, setApiBaseUrl } from '../../api/http.js';
import { normalizeServerUrl } from '../../config.js';
import { useAppStore } from '../../stores/app.js';
import { useAuthStore } from '../../stores/auth.js';
import { useNotificationStore } from '../../stores/notifications.js';
import { useOnboardingStore } from '../../stores/onboarding.js';
import { useRealtimeStore } from '../../stores/realtime.js';

/**
 * 通用设置：服务器连接、离线缓存与作业录入短语。
 * （外观 / 灵动岛 / 提醒 / 账号 / 关于 各自是独立子页，见侧边栏「设置」分组。）
 */
const appStore = useAppStore();
const auth = useAuthStore();
const onboarding = useOnboardingStore();
const realtime = useRealtimeStore();
const notifications = useNotificationStore();

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

onMounted(async () => {
  await appStore.refreshCacheStats();
  await loadPhrases();
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
</style>
