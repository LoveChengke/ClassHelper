<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { DesktopAppInfo } from '../../../types/desktop.js';
import { useAppStore } from '../../stores/app.js';

/**
 * 关于（ClassIsland 同款折叠卡片式）：
 * 应用信息（版本/运行时/常用链接）→ 诊断信息（排查问题用）→ 鸣谢。
 * 所有外链走主进程 openExternal（只放行 http/https，见 main/ipc.ts 的白名单）。
 */
const appStore = useAppStore();

const appInfo = ref<DesktopAppInfo | null>(null);
/** 折叠面板默认展开第一项（应用信息），诊断信息默认收起 */
const expandedNames = ref(['app']);

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

onMounted(async () => {
  if (!window.desktop) return;
  appInfo.value = await window.desktop.getAppInfo().catch(() => null);
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
          <span class="about-extra">
            班级小助手 v{{ appInfo?.appVersion ?? '-' }}
          </span>
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
            <li><strong>ClassIsland</strong> —— 界面风格、设置页与「今天」时间轴的交互参考</li>
            <li><strong>WinIsland</strong> —— 灵动岛的窗口形态与弹簧动画参考</li>
            <li><strong>Vue / Element Plus / Prisma / Express / Socket.IO</strong> —— 本项目赖以构建的开源基石</li>
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
