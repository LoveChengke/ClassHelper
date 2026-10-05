<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import type { UpdateInfo } from '@classhelper/shared';
import type { DesktopAppInfo } from '../../../types/desktop.js';
import { useAppStore } from '../../stores/app.js';

/**
 * 关于（ClassIsland 同款折叠卡片式）：
 * 应用信息（版本/运行时/常用链接/检查更新）→ 诊断信息（排查问题用）→ 鸣谢。
 * 所有外链走主进程 openExternal（只放行 http/https，见 main/ipc.ts 的白名单）。
 */
const appStore = useAppStore();

const appInfo = ref<DesktopAppInfo | null>(null);
/** 折叠面板默认展开第一项（应用信息），诊断信息默认收起 */
const expandedNames = ref(['app']);

/** 检查更新：结果由主进程直连 GitHub 得到（见 main/update.ts） */
const checking = ref(false);
const updateInfo = ref<UpdateInfo | null>(null);

const PROJECT_URL = 'https://github.com/LoveChengke/ClassHelper';
const ISSUES_URL = 'https://github.com/LoveChengke/ClassHelper/issues';

const collapseItems = [
  { name: 'app', title: '应用信息', icon: 'School' },
  { name: 'diagnostics', title: '查看诊断信息', icon: 'Warning' },
  { name: 'thanks', title: '鸣谢', icon: 'Pointer' },
];

async function openExternal(url: string): Promise<void> {
  if (window.desktop?.openExternal) {
    const handled = await window.desktop.openExternal(url);
    if (handled) return;
  }
  window.open(url, '_blank');
}

/**
 * 检查更新。
 *
 * @param force true = 用户主动点击（绕过主进程缓存）；false = 进页面时带出启动自动检查的结果
 */
async function checkUpdate(force: boolean): Promise<void> {
  if (!window.desktop?.checkForUpdates) return;
  checking.value = true;
  try {
    updateInfo.value = await window.desktop.checkForUpdates(force);
  } finally {
    checking.value = false;
  }
}

/** 忽略这个版本：写进配置，启动自动检查不再提示它 */
async function ignoreVersion(): Promise<void> {
  const version = updateInfo.value?.latestVersion;
  if (!version) return;
  await window.desktop?.ignoreUpdateVersion(version);
  ElMessage.success(`已忽略 v${version} 的更新提示`);
}

onMounted(async () => {
  if (!window.desktop) return;
  appInfo.value = await window.desktop.getAppInfo().catch(() => null);
  // 带出启动自动检查的结果（命中主进程缓存，不会再发一次请求）
  void checkUpdate(false);
});
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">关于</h2>
        <p class="page-subtitle">版本、诊断信息与鸣谢</p>
      </div>
    </div>

    <el-collapse v-model="expandedNames" class="about-collapse">
      <!-- 应用信息 -->
      <el-collapse-item name="app">
        <template #title>
          <span class="about-title">
            <el-icon><School /></el-icon>
            {{ collapseItems[0].title }}
          </span>
          <span class="about-extra">班级小助手 v{{ appInfo?.appVersion ?? '-' }}</span>
        </template>
        <div class="about-section">
          <p class="about-copy">
            Copyright © 2025-2026 班级小助手
            <br />
            面向班级的课表 · 作业 · 通知 · 成绩信息工具（Web 管理端 + 桌面客户端 + 灵动岛）
          </p>
          <div class="about-links">
            <span class="about-links-label">常用链接</span>
            <el-button link type="primary" @click="openExternal(PROJECT_URL)">项目主页</el-button>
            <el-button link type="primary" @click="openExternal(ISSUES_URL)">问题反馈</el-button>
          </div>
          <el-descriptions :column="1" border size="small" class="mt-12">
            <el-descriptions-item label="应用版本">{{ appInfo?.appVersion ?? '-' }}</el-descriptions-item>
            <el-descriptions-item label="运行时">
              Electron {{ appInfo?.electron ?? '-' }} · Chromium {{ appInfo?.chrome ?? '-' }} · Node
              {{ appInfo?.node ?? '-' }}
            </el-descriptions-item>
            <el-descriptions-item label="平台">{{ appInfo?.platform ?? '-' }}</el-descriptions-item>
          </el-descriptions>

          <!-- 检查更新：直连 GitHub 看最新的 Release 是不是比本机新 -->
          <div class="about-update" data-test="update-check">
            <div class="about-update-head">
              <span class="about-update-label">检查更新</span>
              <el-button
                size="small"
                :loading="checking"
                data-test="update-check-button"
                @click="checkUpdate(true)"
              >
                检查更新
              </el-button>
            </div>
            <div class="about-update-body">
              <template v-if="checking">正在检查…</template>
              <template v-else-if="!updateInfo">尚未检查</template>
              <template v-else-if="!updateInfo.ok">
                <!-- 教室机器没有外网是常态，这里只是"查不到"，不是错误 -->
                <span class="about-update-muted">{{ updateInfo.error ?? '暂时无法检查更新' }}</span>
              </template>
              <template v-else-if="updateInfo.hasUpdate">
                <el-tag size="small" type="success" effect="light">
                  发现新版本 v{{ updateInfo.latestVersion }}
                </el-tag>
                <span class="about-update-muted">当前 v{{ updateInfo.currentVersion }}</span>
                <el-button
                  link
                  type="primary"
                  size="small"
                  data-test="update-download"
                  @click="openExternal(updateInfo.releaseUrl)"
                >
                  前往下载
                </el-button>
                <el-button link size="small" @click="ignoreVersion">忽略此版本</el-button>
              </template>
              <template v-else>
                <el-tag size="small" type="info" effect="plain">已是最新版本</el-tag>
                <span class="about-update-muted">
                  v{{ updateInfo.currentVersion }} · {{ updateInfo.latestVersion }}
                </span>
              </template>
            </div>
          </div>
        </div>
      </el-collapse-item>

      <!-- 诊断信息 -->
      <el-collapse-item name="diagnostics">
        <template #title>
          <span class="about-title">
            <el-icon><Warning /></el-icon>
            {{ collapseItems[1].title }}
          </span>
          <span class="about-extra">报障时请附带本页信息</span>
        </template>
        <div class="about-section">
          <el-descriptions :column="1" border size="small">
            <el-descriptions-item label="服务器地址">{{ appStore.serverUrl }}</el-descriptions-item>
            <el-descriptions-item label="连接状态">
              <el-tag size="small" :type="appStore.serverReachable ? 'success' : 'danger'">
                {{ appStore.serverReachable ? '服务器可达' : '离线（显示缓存数据）' }}
              </el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="最近同步">{{ appStore.lastSyncText }}</el-descriptions-item>
            <el-descriptions-item label="缓存条目">{{ appStore.cacheItemCount }} 条</el-descriptions-item>
            <el-descriptions-item label="数据目录">{{ appInfo?.userDataPath ?? '-' }}</el-descriptions-item>
            <el-descriptions-item label="配置文件">{{ appInfo?.configPath ?? '-' }}</el-descriptions-item>
          </el-descriptions>
        </div>
      </el-collapse-item>

      <!-- 鸣谢 -->
      <el-collapse-item name="thanks">
        <template #title>
          <span class="about-title">
            <el-icon><Pointer /></el-icon>
            {{ collapseItems[2].title }}
          </span>
        </template>
        <div class="about-section">
          <ul class="about-thanks">
            <li>
              <strong>ClassIsland</strong>
              —— 界面风格、设置页与「今天」时间轴的交互参考
            </li>
            <li>
              <strong>WinIsland</strong>
              —— 灵动岛的窗口形态与弹簧动画参考
            </li>
            <li>
              <strong>Vue / Element Plus / Prisma / Express / Socket.IO</strong>
              —— 本项目赖以构建的开源基石
            </li>
          </ul>
        </div>
      </el-collapse-item>
    </el-collapse>

    <p class="about-quote">谨以此应用，献给朝夕相伴的班级与同窗；愿时光流转，情谊常在。</p>
  </div>
</template>

<style scoped>
.about-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.about-extra {
  margin-left: auto;
  margin-right: 12px;
  font-size: 12px;
  font-weight: 400;
  color: var(--ch-text-tertiary);
}

.about-section {
  padding: 0 4px;
}

.about-copy {
  margin: 0 0 10px;
  line-height: 1.8;
  color: var(--ch-text-secondary);
  font-size: 12.5px;
}

.about-links {
  display: flex;
  align-items: center;
  gap: 4px;
}

.about-links-label {
  font-size: 12.5px;
  color: var(--ch-text-secondary);
  margin-right: 4px;
}

/* 检查更新：颜色一律走 --ch-* 变量（深色主题下不能写死浅色底/深色字） */
.about-update {
  margin-top: 12px;
  padding: 10px 12px;
  border: 1px solid var(--ch-border);
  border-radius: var(--ch-radius-card);
  background: var(--ch-layer-alt);
}

.about-update-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.about-update-label {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ch-text-secondary);
}

.about-update-body {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
  font-size: 12.5px;
  color: var(--ch-text);
}

.about-update-muted {
  color: var(--ch-text-tertiary);
}

.about-thanks {
  margin: 0;
  padding-left: 18px;
  line-height: 2;
  font-size: 12.5px;
  color: var(--ch-text-secondary);
}

.about-quote {
  margin: 18px 0 4px;
  text-align: center;
  font-size: 12px;
  color: var(--ch-text-tertiary);
}
</style>
