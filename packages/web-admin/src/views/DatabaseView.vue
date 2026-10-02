<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox, type UploadFile, type UploadInstance } from 'element-plus';
import type { DatabaseBackupScheduleDto, DatabaseStatusDto, DatabaseSwitchJobDto } from '@classhelper/shared';
import { databaseApi } from '@/api';
import { useResponsive } from '@/composables/useResponsive';

/**
 * 数据库管理（仅管理员）：
 * - 状态卡：当前连接 / 版本 / 体积 / 各表行数
 * - 连接测试卡：任意目标库连通性（切换前的前置检查）
 * - 一键切换卡：SQLite ⇄ MySQL 迁移（异步任务轮询；完成后需重启服务端生效）
 * - 备份卡：手动/定时备份、恢复、删除、快照导出导入、数据库文件下载
 *
 * 恢复 / 导入 / 切换都是**整库覆盖**级危险操作，全部走 ElMessageBox 二次确认，
 * 切换还要求用户手输「确认迁移」防止误触。
 */

const { isMobile } = useResponsive();

const loading = ref(false);
const status = ref<DatabaseStatusDto | null>(null);

const isSqlite = computed(() => status.value?.provider === 'sqlite');

function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(value: string | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

async function reload(): Promise<void> {
  loading.value = true;
  try {
    status.value = await databaseApi.status();
  } finally {
    loading.value = false;
  }
}

/* ------------------------------------------------------------ 连接测试 */

const testForm = reactive({ provider: 'mysql' as 'sqlite' | 'mysql', url: '' });
const testing = ref(false);
const testResult = ref<{ ok: boolean; text: string } | null>(null);

async function runTest(): Promise<void> {
  if (!testForm.url.trim()) {
    ElMessage.warning('请先填写目标连接串');
    return;
  }
  testing.value = true;
  testResult.value = null;
  try {
    const result = await databaseApi.testConnection({ provider: testForm.provider, url: testForm.url.trim() });
    testResult.value = {
      ok: result.ok,
      text: result.ok
        ? `连接成功（${result.latencyMs ?? '-'}ms，版本 ${result.version ?? '-'}）${result.note ?? ''}`
        : `连接失败：${result.error ?? '未知原因'}`,
    };
  } finally {
    testing.value = false;
  }
}

/* ------------------------------------------------------------ 一键切换 */

const switchForm = reactive({ provider: 'mysql' as 'sqlite' | 'mysql', url: '', confirmText: '' });
const switchJob = ref<DatabaseSwitchJobDto | null>(null);
const switchPolling = ref(false);
let switchTimer: number | null = null;

/** 切换目标默认按「与当前相反」的 provider 预填 */
watch(
  () => status.value?.provider,
  (provider) => {
    if (provider === 'sqlite') switchForm.provider = 'mysql';
    if (provider === 'mysql') switchForm.provider = 'sqlite';
  },
  { immediate: true },
);

async function startSwitch(): Promise<void> {
  if (!status.value) return;
  if (switchForm.confirmText !== '确认迁移') {
    ElMessage.warning('请先在输入框中输入「确认迁移」');
    return;
  }
  const confirmed = await ElMessageBox.confirm(
    `将把当前${status.value.provider === 'sqlite' ? 'SQLite' : 'MySQL'}数据库的全部数据迁移到目标库，` +
      '目标库必须为空；完成后需要重启服务端才能生效。确定继续？',
    '一键切换数据库',
    { type: 'warning', confirmButtonText: '开始迁移', cancelButtonText: '取消' },
  ).catch(() => false);
  if (!confirmed) return;

  const created = await databaseApi.startSwitch({
    provider: switchForm.provider,
    url: switchForm.url.trim(),
  });
  switchForm.confirmText = '';
  switchJob.value = null;
  switchPolling.value = true;
  const poll = async (): Promise<void> => {
    const job = await databaseApi.getSwitchJob(created.jobId);
    switchJob.value = job;
    if (job && job.status !== 'running') {
      switchPolling.value = false;
      if (switchTimer) {
        window.clearTimeout(switchTimer);
        switchTimer = null;
      }
      await reload();
      if (job.status === 'done') ElMessage.success('迁移完成，请重启服务端使新数据库生效');
      else ElMessage.error(job.error ?? '迁移失败（已回滚，当前数据库未受影响）');
      return;
    }
    switchTimer = window.setTimeout(() => void poll(), 2000);
  };
  await poll();
}

onUnmounted(() => {
  if (switchTimer) window.clearTimeout(switchTimer);
});

/** el-step 的 status 取值：wait/process/finish/error/success */
function switchStepStatus(stepStatus: 'running' | 'done' | 'error'): 'process' | 'success' | 'error' {
  return stepStatus === 'done' ? 'success' : stepStatus === 'error' ? 'error' : 'process';
}

/* ------------------------------------------------------------ 备份 / 恢复 */

const backups = computed(() => status.value?.backups ?? []);

async function createBackup(): Promise<void> {
  await databaseApi.createBackup();
  ElMessage.success('备份已创建');
  await reload();
}

async function restoreBackup(name: string): Promise<void> {
  const confirmed = await ElMessageBox.confirm(
    '恢复会用备份内容覆盖当前数据库的全部数据（恢复点之后新增的数据将丢失）。确定继续？',
    '从备份恢复',
    { type: 'warning', confirmButtonText: '恢复', cancelButtonText: '取消' },
  ).catch(() => false);
  if (!confirmed) return;
  await databaseApi.restoreBackup(name);
  ElMessage.success('已从备份恢复');
  await reload();
}

async function deleteBackup(name: string): Promise<void> {
  const confirmed = await ElMessageBox.confirm(`确定删除备份 ${name}？`, '删除备份', {
    type: 'warning',
    confirmButtonText: '删除',
    cancelButtonText: '取消',
  }).catch(() => false);
  if (!confirmed) return;
  await databaseApi.deleteBackup(name);
  ElMessage.success('备份已删除');
  await reload();
}

/* ------------------------------------------------------------ 导出 / 导入 */

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function exportSnapshot(): Promise<void> {
  const blob = await databaseApi.downloadSnapshot();
  saveBlob(blob, `classhelper-snapshot-${new Date().toISOString().slice(0, 10)}.json`);
}

async function exportSqliteFile(): Promise<void> {
  const blob = await databaseApi.downloadSqliteFile();
  saveBlob(blob, 'classhelper.db');
}

const importUploadRef = ref<UploadInstance>();
const importing = ref(false);

/** 二进制 → base64（分块转换，避免大文件把 String.fromCharCode 的调用栈撑爆） */
function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunks: string[] = [];
  const step = 0x8000;
  for (let index = 0; index < bytes.length; index += step) {
    chunks.push(String.fromCharCode(...bytes.subarray(index, index + step)));
  }
  return btoa(chunks.join(''));
}

/** 读文件为 base64 后整库导入（覆盖现有数据） */
async function handleImportFile(file: File): Promise<void> {
  const confirmed = await ElMessageBox.confirm(
    '导入会用快照内容覆盖当前数据库的全部数据。确定继续？',
    '导入快照',
    { type: 'warning', confirmButtonText: '导入', cancelButtonText: '取消' },
  ).catch(() => false);
  if (!confirmed) return;
  importing.value = true;
  try {
    await databaseApi.importSnapshot(bufferToBase64(await file.arrayBuffer()));
    ElMessage.success('快照已导入');
    await reload();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '导入失败');
  } finally {
    importing.value = false;
    importUploadRef.value?.clearFiles();
  }
}

function onImportChange(uploadFile: UploadFile): void {
  if (uploadFile.raw) void handleImportFile(uploadFile.raw);
}

/* ------------------------------------------------------------ 定时备份 */

const scheduleForm = reactive<DatabaseBackupScheduleDto>({
  enabled: false,
  intervalHours: 24,
  keepCount: 7,
  lastAutoBackupAt: null,
});
const scheduleSaving = ref(false);

async function saveSchedule(): Promise<void> {
  scheduleSaving.value = true;
  try {
    const saved = await databaseApi.saveSchedule({
      enabled: scheduleForm.enabled,
      intervalHours: Number(scheduleForm.intervalHours),
      keepCount: Number(scheduleForm.keepCount),
      lastAutoBackupAt: null,
    });
    Object.assign(scheduleForm, saved);
    ElMessage.success('定时备份配置已保存');
    await reload();
  } finally {
    scheduleSaving.value = false;
  }
}

onMounted(async () => {
  await reload();
  const schedule = status.value?.schedule;
  if (schedule) {
    Object.assign(scheduleForm, {
      enabled: schedule.enabled,
      intervalHours: schedule.intervalHours,
      keepCount: schedule.keepCount,
      lastAutoBackupAt: schedule.lastAutoBackupAt,
    });
  }
});
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">数据库管理</h2>
        <p class="page-subtitle">连接状态、备份恢复、导入导出与一键切换（仅管理员可见）</p>
      </div>
      <div class="toolbar">
        <el-button icon="Refresh" :loading="loading" @click="reload">刷新</el-button>
      </div>
    </div>

    <!-- 当前状态 -->
    <el-card shadow="never" class="section-card">
      <template #header><span>当前数据库</span></template>
      <el-descriptions :column="isMobile ? 1 : 2" size="small" border>
        <el-descriptions-item label="类型">
          <el-tag size="small" :type="isSqlite ? 'success' : 'primary'">
            {{ isSqlite ? 'SQLite' : 'MySQL' }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="连接状态">
          <el-tag size="small" :type="status?.connected ? 'success' : 'danger'">
            {{ status?.connected ? `已连接 · ${status.latencyMs ?? '-'}ms` : '未连接' }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="数据库版本">{{ status?.version ?? '—' }}</el-descriptions-item>
        <el-descriptions-item label="数据体积">{{ formatBytes(status?.sizeBytes) }}</el-descriptions-item>
        <el-descriptions-item label="连接串">{{ status?.databaseUrlMasked ?? '—' }}</el-descriptions-item>
        <el-descriptions-item label="备份目录">{{ status?.backupDir ?? '—' }}</el-descriptions-item>
        <el-descriptions-item v-if="isSqlite" label="数据文件" :span="isMobile ? 1 : 2">
          {{ status?.sqliteFilePath ?? '—' }}
        </el-descriptions-item>
      </el-descriptions>
    </el-card>

    <!-- 各表行数 + 备份列表 -->
    <el-row :gutter="12" class="mt-12">
      <el-col :xs="24" :md="12">
        <el-card shadow="never" class="table-card">
          <template #header><span>各表行数</span></template>
          <el-table :data="status?.tables ?? []" size="small" max-height="360">
            <el-table-column prop="name" label="表" min-width="140" />
            <el-table-column label="行数" width="100">
              <template #default="{ row }">
                <el-tag v-if="row.count >= 0" size="small" type="info" effect="plain">{{ row.count }}</el-tag>
                <el-tag v-else size="small" type="danger">异常</el-tag>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
      <el-col :xs="24" :md="12">
        <el-card shadow="never" class="table-card">
          <template #header>
            <div class="card-header-row">
              <span>备份</span>
              <el-button size="small" type="primary" plain @click="createBackup">立即备份</el-button>
            </div>
          </template>
          <el-table :data="backups" size="small" max-height="300" empty-text="暂无备份">
            <el-table-column label="文件" min-width="200">
              <template #default="{ row }">{{ row.name }}</template>
            </el-table-column>
            <el-table-column label="类型" width="80">
              <template #default="{ row }">
                <el-tag size="small" :type="row.kind === 'manual' ? 'primary' : 'info'">
                  {{ row.kind === 'manual' ? '手动' : '定时' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="大小" width="90">
              <template #default="{ row }">{{ formatBytes(row.sizeBytes) }}</template>
            </el-table-column>
            <el-table-column label="时间" width="150">
              <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
            </el-table-column>
            <el-table-column label="操作" width="120" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" size="small" @click="restoreBackup(row.name)">恢复</el-button>
                <el-button link type="danger" size="small" @click="deleteBackup(row.name)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>

          <el-divider />
          <el-form label-width="96px" size="small" class="schedule-form">
            <el-form-item label="定时备份">
              <el-switch v-model="scheduleForm.enabled" />
            </el-form-item>
            <el-form-item label="间隔（小时）">
              <el-input-number v-model="scheduleForm.intervalHours" :min="1" :max="720" :step="1" />
              <span class="form-hint">到点自动备份（服务端运行期间生效）</span>
            </el-form-item>
            <el-form-item label="保留份数">
              <el-input-number v-model="scheduleForm.keepCount" :min="1" :max="100" :step="1" />
              <span class="form-hint">超出后自动删最旧的定时备份</span>
            </el-form-item>
            <el-form-item label="上次备份">
              <span class="form-hint">{{ formatTime(scheduleForm.lastAutoBackupAt) }}</span>
            </el-form-item>
            <el-form-item>
              <el-button type="primary" size="small" :loading="scheduleSaving" @click="saveSchedule">
                保存定时配置
              </el-button>
            </el-form-item>
          </el-form>
        </el-card>
      </el-col>
    </el-row>

    <!-- 连接测试 / 导入导出 -->
    <el-row :gutter="12" class="mt-12">
      <el-col :xs="24" :md="12">
        <el-card shadow="never">
          <template #header><span>连接测试（任意目标库）</span></template>
          <el-form label-position="top" size="small">
            <el-form-item label="目标类型">
              <el-radio-group v-model="testForm.provider">
                <el-radio-button value="sqlite">SQLite</el-radio-button>
                <el-radio-button value="mysql">MySQL</el-radio-button>
              </el-radio-group>
            </el-form-item>
            <el-form-item label="连接串">
              <el-input
                v-model="testForm.url"
                :placeholder="
                  testForm.provider === 'sqlite'
                    ? 'file:./data/target.db'
                    : 'mysql://user:password@host:3306/classhelper'
                "
                clearable
              />
            </el-form-item>
            <el-button type="primary" :loading="testing" @click="runTest">测试连接</el-button>
            <el-alert
              v-if="testResult"
              class="mt-12"
              :type="testResult.ok ? 'success' : 'error'"
              :closable="false"
              :title="testResult.text"
            />
          </el-form>
        </el-card>
      </el-col>
      <el-col :xs="24" :md="12">
        <el-card shadow="never">
          <template #header><span>导入 / 导出</span></template>
          <p class="card-hint">
            快照为 JSON 格式（含全部 14 张表数据），可在 SQLite 与 MySQL 之间互相恢复；
            「数据库文件」仅 SQLite 提供整文件下载。
          </p>
          <div class="toolbar-row">
            <el-button @click="exportSnapshot">下载快照 JSON</el-button>
            <el-button v-if="isSqlite" @click="exportSqliteFile">下载数据库文件</el-button>
            <el-upload
              ref="importUploadRef"
              :auto-upload="false"
              :show-file-list="false"
              :on-change="onImportChange"
              accept=".json,application/json"
            >
              <el-button type="warning" plain :loading="importing">导入快照（覆盖现有数据）</el-button>
            </el-upload>
          </div>
          <el-alert
            class="mt-12"
            type="info"
            :closable="false"
            title="导入会整库覆盖当前数据"
            description="建议先「立即备份」再导入；.json.gz 压缩备份请先解压为 .json 再导入。"
          />
        </el-card>
      </el-col>
    </el-row>

    <!-- 一键切换 -->
    <el-card shadow="never" class="mt-12 section-card">
      <template #header><span>一键切换数据库（SQLite ⇄ MySQL）</span></template>
      <el-alert
        class="mb-12"
        type="warning"
        :closable="false"
        title="切换会自动：备份当前库 → 建目标库表结构 → 迁移全部数据 → 改写 .env"
        description="目标库必须为空；完成后需重启服务端（安装版运行 restart.cmd，开发模式重跑 pnpm dev:server）才会连到新库。中途失败会自动回滚，当前数据库不受影响。"
      />
      <el-form label-position="top" size="small" class="switch-form">
        <el-row :gutter="12">
          <el-col :xs="24" :md="6">
            <el-form-item label="目标类型">
              <el-radio-group v-model="switchForm.provider">
                <el-radio-button value="sqlite">SQLite</el-radio-button>
                <el-radio-button value="mysql">MySQL</el-radio-button>
              </el-radio-group>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :md="12">
            <el-form-item label="目标连接串（库必须为空）">
              <el-input
                v-model="switchForm.url"
                :placeholder="
                  switchForm.provider === 'sqlite'
                    ? 'file:./data/classhelper-target.db'
                    : 'mysql://user:password@host:3306/classhelper'
                "
                clearable
              />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :md="6">
            <el-form-item label="输入「确认迁移」启用按钮">
              <el-input v-model="switchForm.confirmText" placeholder="确认迁移" clearable />
            </el-form-item>
          </el-col>
        </el-row>
        <el-button
          type="danger"
          :disabled="switchForm.confirmText !== '确认迁移' || switchPolling"
          @click="startSwitch"
        >
          开始迁移
        </el-button>
      </el-form>

      <!-- 任务进度 -->
      <template v-if="switchJob">
        <el-descriptions class="mt-12" :column="isMobile ? 1 : 2" size="small" border>
          <el-descriptions-item label="任务状态">
            <el-tag
              size="small"
              :type="
                switchJob.status === 'done' ? 'success' : switchJob.status === 'error' ? 'danger' : 'warning'
              "
            >
              {{ switchJob.status === 'done' ? '已完成' : switchJob.status === 'error' ? '失败' : '进行中' }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="目标">
            {{ switchJob.target.provider }} · {{ switchJob.target.url }}
          </el-descriptions-item>
        </el-descriptions>
        <el-steps class="mt-12" direction="vertical" :space="44">
          <el-step
            v-for="step in switchJob.steps"
            :key="step.name"
            :title="step.name"
            :status="switchStepStatus(step.status)"
            :description="step.detail"
          />
        </el-steps>
        <el-alert
          v-if="switchJob.status === 'done'"
          class="mt-12"
          type="success"
          :closable="false"
          title="迁移完成：请立即重启服务端（restart.cmd 或重跑 pnpm dev:server），重启后刷新本页将显示新数据库"
        />
        <el-alert
          v-if="switchJob.status === 'error'"
          class="mt-12"
          type="error"
          :closable="false"
          :title="`迁移失败：${switchJob.error ?? '未知原因'}`"
          description="已自动回滚，当前数据库与 .env 未被修改。"
        />
      </template>
    </el-card>
  </div>
</template>

<style scoped>
.section-card {
  margin-bottom: 2px;
}

.card-header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.schedule-form {
  margin-top: 4px;
}

.form-hint {
  margin-left: 8px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.card-hint {
  margin: 0 0 10px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--el-text-color-secondary);
}

.toolbar-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.switch-form {
  margin-top: 2px;
}
</style>
