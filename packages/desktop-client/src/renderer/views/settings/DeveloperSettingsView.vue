<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { formatDate, relativeTime, type UpdateInfo } from '@classhelper/shared';
import type { ClientAgentStatus, DesktopAppInfo } from '../../../types/desktop.js';
import { useAppStore } from '../../stores/app.js';
import { useUiStore } from '../../stores/ui.js';

/**
 * 开发者（需求 10）。
 *
 * 入口只在 `config.developerMode === true` 时出现在侧栏「设置」分组里（`ClientLayout.vue`），
 * 路由守卫也会把"关掉开关后仍停留在这个页面"的用户弹回「通用」。
 *
 * 本页的定位是**把排查问题时需要的现场集中到一处**，所以刻意不做成"可操作的调试台"：
 * 每一项都是只读状态 + 一两个既有桥上的动作，数据全部来自 `window.desktop.*`
 * 与既有 store，**不新增任何数据源、也不新增文件读写**。
 *
 * 几条取舍写在各区块的注释里，统一的原则是：
 * 「关于」页面向的是所有用户（干净、能截图给管理员），本页面向维护者（原始值、路径、内部开关）。
 */
const appStore = useAppStore();
const ui = useUiStore();

const loading = ref(false);
const appInfo = ref<DesktopAppInfo | null>(null);
const agent = ref<ClientAgentStatus | null>(null);

/* ------------------------------------------------------------ 版本与平台 */

/** 版本、运行时与两个关键路径（用户数据目录 / 配置文件），排查"配置写哪去了"必看 */
async function loadAppInfo(): Promise<void> {
  if (!window.desktop?.getAppInfo) return;
  appInfo.value = await window.desktop.getAppInfo().catch(() => null);
}

/** 一次性把本页的所有状态拉新（刷新按钮与首次进页面共用） */
async function loadAll(): Promise<void> {
  if (!window.desktop) return;
  loading.value = true;
  try {
    await loadAppInfo();
    await refreshAgent();
    await loadIgnoredVersion();
    await appStore.refreshCacheStats();
  } finally {
    loading.value = false;
  }
}

/* ------------------------------------------------------------ 设备与上报 */

/**
 * 服务端联动状态：设备尾号 / 最近上报 / 最近错误 / 目标版本 / 待安装版本 / 在线。
 *
 * 这一块与「通用」页的「服务端联动状态」是同一份数据 —— 有意保留的重叠：
 * 排查上报问题时人在「通用」页看现象、在「开发者」页看原因（最近错误原文 + 设备尾号），
 * 跳来跳去比重复几个字段更烦。
 */
const beating = ref(false);

const lastHeartbeatText = computed(() => {
  const value = agent.value?.lastHeartbeatAt;
  return value ? relativeTime(value) : '还没有上报过';
});

const lastErrorText = computed(() => agent.value?.lastError?.trim() || '无');

async function refreshAgent(): Promise<void> {
  if (!window.desktop?.getClientAgentStatus) return;
  agent.value = await window.desktop.getClientAgentStatus().catch(() => null);
}

async function beatNow(): Promise<void> {
  if (!window.desktop?.beatClientNow) return;
  beating.value = true;
  try {
    // 手动上报是"立刻打一次"，成功/失败都刷新状态，失败原因展示在「最近错误」里
    agent.value = await window.desktop.beatClientNow();
    if (agent.value?.lastError) ElMessage.warning(`上报未成功：${agent.value.lastError}`);
    else ElMessage.success('已向服务端上报本机状态');
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '上报失败，请检查网络与登录状态');
  } finally {
    beating.value = false;
  }
}

/* ------------------------------------------------------------ 日志 */

/**
 * 日志文件路径。
 *
 * 桥上没有"读日志内容"的接口（有意不加：日志是主进程的文件，给渲染进程一个读任意文件的
 * 入口在安全边界上没有必要），所以这里只**提示路径** + 一个「打开日志目录」。
 * 路径由用户数据目录拼出来：主进程的 logger 固定写在 `<userData>/logs/main.log`，
 * 单文件 1MB 轮转（写满即改名为 main.old.log），所以"日志丢了"通常是轮转覆盖，不是没写。
 */
const logPathText = computed(() => {
  const base = appInfo.value?.userDataPath;
  if (!base) return 'logs/main.log（用户数据目录下）';
  const sep = (appInfo.value?.platform ?? '').startsWith('win') ? '\\' : '/';
  return `${base}${sep}logs${sep}main.log`;
});

async function openLogDir(): Promise<void> {
  if (!window.desktop?.openLogDir) return;
  const ok = await window.desktop.openLogDir();
  if (!ok) ElMessage.warning('打开日志目录失败，请按上面的路径手动前往');
}

/* ------------------------------------------------------------ 更新 */

/**
 * 更新检查。
 *
 * 「立即检查」走 `checkForUpdates(true)`：**强制绕过主进程那 30 分钟缓存**。
 * 这是本页与「关于」页的区别 —— 那边用户点检查也可能是缓存结果（省流量），
 * 这边维护者要的是"现在到底拿得到什么"，所以按钮默认就是强制的。
 */
const checking = ref(false);
const updateInfo = ref<UpdateInfo | null>(null);
const ignoredUpdateVersion = ref('');

async function checkUpdate(force: boolean): Promise<void> {
  if (!window.desktop?.checkForUpdates) return;
  checking.value = true;
  try {
    updateInfo.value = await window.desktop.checkForUpdates(force);
  } finally {
    checking.value = false;
  }
}

async function loadIgnoredVersion(): Promise<void> {
  if (!window.desktop?.getConfig) return;
  const stored = await window.desktop.getConfig().catch(() => null);
  ignoredUpdateVersion.value = stored?.ignoredUpdateVersion ?? '';
}

async function ignoreVersion(): Promise<void> {
  const version = updateInfo.value?.latestVersion;
  if (!version || !window.desktop?.ignoreUpdateVersion) return;
  await window.desktop.ignoreUpdateVersion(version);
  ignoredUpdateVersion.value = version;
  ElMessage.success(`已忽略 v${version}：启动时的自动检查不再提示它`);
}

/** 忽略是可逆的（排查线上"用户说不再提示"时经常要把它清掉），顺手给一个恢复入口 */
async function clearIgnoredVersion(): Promise<void> {
  if (!window.desktop?.saveConfig) return;
  const saved = await window.desktop.saveConfig({ ignoredUpdateVersion: '' });
  ignoredUpdateVersion.value = saved.ignoredUpdateVersion;
  ElMessage.success('已恢复该版本的更新提示');
}

/* ------------------------------------------------------------ 调试工具 */

const openingDevTools = ref(false);

/**
 * 打开 DevTools（主进程 detached 独立窗口）。
 * 冒烟验证模式下主进程会拒绝（多一个窗口会把自动化断言打乱），返回 false —— 这里如实提示。
 */
async function openDevTools(): Promise<void> {
  if (!window.desktop?.openDevTools) return;
  openingDevTools.value = true;
  try {
    const ok = await window.desktop.openDevTools();
    if (ok) ElMessage.success('已在独立窗口打开开发者工具');
    else ElMessage.warning('当前是冒烟验证模式，主进程不允许打开 DevTools');
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '打开开发者工具失败');
  } finally {
    openingDevTools.value = false;
  }
}

/* ------------------------------------------------------------ 离线缓存 */

/** 与「通用」页同一份缓存统计（这里再看一遍是为了"刷新/清空"不用跳页） */
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

async function clearCache(): Promise<void> {
  await ElMessageBox.confirm('清空后离线时将无法查看历史数据，确认继续？', '清空离线缓存', {
    type: 'warning',
  });
  await appStore.clearCache();
  ElMessage.success('离线缓存已清空');
}

onMounted(async () => {
  await loadAll();
  // 带出启动自动检查的结果（这次命中主进程缓存，不会真的再发一次请求）
  void checkUpdate(false);
});
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">开发者</h2>
        <p class="page-subtitle">版本与平台、设备上报、日志、更新与调试工具</p>
      </div>
      <el-button :loading="loading" data-test="dev-refresh" @click="loadAll">
        <el-icon><Refresh /></el-icon>
        刷新
      </el-button>
    </div>

    <el-alert
      class="mb-12"
      type="warning"
      :closable="false"
      show-icon
      title="仅供排查问题"
      description="这一页显示的是原始状态与内部路径，不需要给日常使用者看。关闭「通用 → 开发者模式」后它就会从侧栏消失。"
    />

    <el-row :gutter="12">
      <el-col :xs="24" :md="12">
        <!-- 版本与平台 -->
        <el-card shadow="never">
          <template #header><span>版本与平台</span></template>
          <el-descriptions :column="1" border size="small">
            <el-descriptions-item label="客户端版本">
              {{ appInfo?.appVersion ?? '—' }}
            </el-descriptions-item>
            <el-descriptions-item label="运行时">
              Electron {{ appInfo?.electron ?? '—' }} · Chromium {{ appInfo?.chrome ?? '—' }} · Node
              {{ appInfo?.node ?? '—' }}
            </el-descriptions-item>
            <el-descriptions-item label="平台">{{ appInfo?.platform ?? '—' }}</el-descriptions-item>
            <el-descriptions-item label="用户数据目录">
              <span class="mono">{{ appInfo?.userDataPath ?? '—' }}</span>
            </el-descriptions-item>
            <el-descriptions-item label="配置文件">
              <span class="mono">{{ appInfo?.configPath ?? '—' }}</span>
            </el-descriptions-item>
            <el-descriptions-item label="冒烟验证模式">
              <el-tag :type="appInfo?.smokeTest ? 'warning' : 'info'" size="small" effect="plain">
                {{ appInfo?.smokeTest ? '是（自动化验证中）' : '否' }}
              </el-tag>
            </el-descriptions-item>
          </el-descriptions>
        </el-card>

        <!-- 设备与上报 -->
        <el-card shadow="never" class="mt-12">
          <template #header><span>设备与上报</span></template>
          <el-descriptions :column="1" border size="small">
            <el-descriptions-item label="连接状态">
              <el-tag :type="agent?.online ? 'success' : 'info'" size="small">
                {{ agent?.online ? '在线（近期上报成功）' : '离线（等待上报）' }}
              </el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="设备标识尾号">
              <span class="mono">{{ agent?.deviceKeyTail || '—' }}</span>
            </el-descriptions-item>
            <el-descriptions-item label="最近上报">{{ lastHeartbeatText }}</el-descriptions-item>
            <el-descriptions-item label="服务端目标版本">
              {{ agent?.updateTargetVersion || '无（保持当前版本）' }}
            </el-descriptions-item>
            <el-descriptions-item label="待安装版本">
              {{ agent?.pendingUpdateVersion || '无' }}
            </el-descriptions-item>
            <el-descriptions-item label="最近错误">
              <span :class="{ 'text-danger': lastErrorText !== '无' }">{{ lastErrorText }}</span>
            </el-descriptions-item>
          </el-descriptions>
          <div class="toolbar mt-12">
            <el-button type="primary" :loading="beating" data-test="dev-beat-now" @click="beatNow">
              立即上报
            </el-button>
            <el-button :loading="loading" @click="loadAll">刷新状态</el-button>
          </div>
        </el-card>
      </el-col>

      <el-col :xs="24" :md="12">
        <!-- 日志 -->
        <el-card shadow="never">
          <template #header><span>日志</span></template>
          <el-descriptions :column="1" border size="small">
            <el-descriptions-item label="日志文件">
              <span class="mono">{{ logPathText }}</span>
            </el-descriptions-item>
            <el-descriptions-item label="日志级别">
              <el-tag :type="ui.developerMode ? 'success' : 'info'" size="small" effect="plain">
                {{ ui.developerMode ? 'debug（开发者模式）' : 'info' }}
              </el-tag>
            </el-descriptions-item>
          </el-descriptions>
          <p class="text-muted mt-12">
            单个日志文件 1MB 轮转：写满后改名为 main.old.log，新内容写进 main.log。
            所以"日志里找不到某次崩溃"多半是被轮转覆盖了，不是没写。
          </p>
          <!-- 不在这里用 <strong> 强调：中文整行的显示宽度是字符数的两倍，
               而 Vue 模板里夹了行内元素的长句会被 Prettier 折行并插入空格，
               渲染出来句子中间就多一个空格。要强调就单独起一行文字。 -->
          <p v-if="ui.developerMode" class="text-muted">
            debug 级日志已开启：级别在主进程启动时读取，改完开关后需重启客户端才生效。
          </p>
          <div class="toolbar mt-12">
            <el-button data-test="dev-open-log-dir" @click="openLogDir">打开日志目录</el-button>
          </div>
        </el-card>

        <!-- 更新 -->
        <el-card shadow="never" class="mt-12">
          <template #header><span>更新</span></template>
          <div class="toolbar">
            <el-button :loading="checking" data-test="dev-check-update" @click="checkUpdate(true)">
              强制检查更新
            </el-button>
            <span class="text-muted">绕过主进程 30 分钟缓存，直接问 GitHub</span>
          </div>
          <el-descriptions :column="1" border size="small" class="mt-12">
            <el-descriptions-item label="本次结果">
              <template v-if="checking">正在检查…</template>
              <template v-else-if="!updateInfo">尚未检查</template>
              <template v-else-if="!updateInfo.ok">
                <span class="text-muted">{{ updateInfo.error ?? '暂时无法检查更新' }}</span>
              </template>
              <template v-else-if="updateInfo.hasUpdate">
                <el-tag size="small" type="success" effect="light">
                  有新版本 v{{ updateInfo.latestVersion }}
                </el-tag>
                <span class="text-muted">当前 v{{ updateInfo.currentVersion }}</span>
              </template>
              <template v-else>
                <el-tag size="small" type="info" effect="plain">已是最新版本</el-tag>
                <span class="text-muted">v{{ updateInfo.currentVersion }}</span>
              </template>
            </el-descriptions-item>
            <el-descriptions-item label="检查时间">
              {{ updateInfo?.checkedAt ? formatDate(updateInfo.checkedAt, true) : '—' }}
            </el-descriptions-item>
            <el-descriptions-item label="已忽略的版本">
              <template v-if="ignoredUpdateVersion">
                <span class="mono">v{{ ignoredUpdateVersion }}</span>
                <el-button link type="primary" size="small" @click="clearIgnoredVersion">恢复提示</el-button>
              </template>
              <span v-else class="text-muted">无</span>
            </el-descriptions-item>
          </el-descriptions>
          <div class="toolbar mt-12">
            <el-button
              :disabled="!updateInfo?.latestVersion"
              data-test="dev-ignore-version"
              @click="ignoreVersion"
            >
              不再提示该版本
            </el-button>
            <span class="text-muted">写入配置后，启动时的自动检查会跳过它</span>
          </div>
        </el-card>

        <!-- 调试工具 -->
        <el-card shadow="never" class="mt-12">
          <template #header><span>调试工具</span></template>
          <div class="toolbar">
            <el-button :loading="openingDevTools" data-test="dev-open-devtools" @click="openDevTools">
              打开 DevTools
            </el-button>
            <span class="text-muted">独立窗口；冒烟验证模式下不允许打开</span>
          </div>
          <el-alert class="mt-12" type="info" :closable="false" show-icon title="灵动岛诊断（命令行）">
            <template #default>
              <p class="diag-copy">灵动岛开合"闪一下"这类问题要的是整屏逐帧取证，界面上给不出这个按钮。</p>
              <p class="diag-copy">跑冒烟时带上环境变量即可：</p>
              <p class="diag-copy mono">ELECTRON_SMOKE_ISLAND_DIAG=1 pnpm verify:desktop</p>
              <p class="diag-copy">它会在常规断言之外，对触摸/鼠标两种模式各跑一次收回动画的逐帧取证，</p>
              <p class="diag-copy">帧图与逐帧数据落在 `.cache/island-closing-frames/`。</p>
            </template>
          </el-alert>
        </el-card>

        <!-- 离线缓存 -->
        <el-card shadow="never" class="mt-12">
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
            <el-button @click="appStore.refreshCacheStats()">刷新统计</el-button>
            <el-button type="danger" plain @click="clearCache">清空缓存</el-button>
          </div>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<style scoped>
/*
 * 路径与版本号这类"要抄下来发给别人"的值统一用等宽字体（避免 0/O、1/l 看混），
 * 并单独放开文本选中 —— body 上关掉了整页选中（更像原生应用），
 * 但这一页的路径就是要让人复制的。
 *
 * 字体栈写死而不新建 `--ch-font-mono` 令牌：全局只有这一处在用，
 * 为它加一个主题令牌（还得在 html.dark 里镜像一份）不划算。
 */
.mono {
  font-family: 'Cascadia Mono', Consolas, 'Courier New', monospace;
  font-size: 12.5px;
  word-break: break-all;
  user-select: text;
}

.mb-12 {
  margin-bottom: 12px;
}

.text-danger {
  color: var(--el-color-danger);
}

.diag-copy {
  margin: 0 0 6px;
  line-height: 1.6;
}

.diag-copy:last-child {
  margin-bottom: 0;
}
</style>
