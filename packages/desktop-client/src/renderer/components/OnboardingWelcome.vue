<script setup lang="ts">
import { FullScreenGuide, ONBOARDING_VERSION } from '@classhelper/ui';
import { useOnboardingStore } from '../stores/onboarding.js';
import { BRAND_LOGO_URL } from '../config.js';
const onboarding = useOnboardingStore();
const steps = [
  {
    id: 'server',
    title: '连接学校服务器',
    text: '填写管理员提供的服务器地址，测试连接后继续。',
    example: ['服务器地址', '测试连接', '连接成功'],
  },
  {
    id: 'login',
    title: '登录班级',
    text: '使用班级码和班级密码登录，这台设备将代表本班。',
    example: ['班级码', '班级密码', '登录'],
  },
  {
    id: 'teaching',
    title: '查看课表与作业',
    text: '从菜单切换页面，用日历查找记录；断网时可查看已缓存的内容。',
    example: ['今日课表', '作业看板', '日期下方的圆点 ·'],
  },
  {
    id: 'files',
    title: '接收通知与课件',
    text: '新内容自动同步，课件下载后由你选择如何打开。',
    example: ['班级通知', '课件传输进度', '打开所在文件夹'],
  },
  {
    id: 'island',
    title: '选择灵动岛模式',
    text: '经典模式自动呈现提醒；常驻模式先显示消息数量，由你展开查看。',
    example: ['经典模式', '自定义常驻模式', '设置 → 灵动岛'],
  },
  {
    id: 'settings',
    title: '准备好了',
    text: '在设置中调整外观和关怀模式，也可以随时重看引导。',
    example: ['通用设置', '外观', '使用引导'],
  },
];
async function finish(): Promise<void> {
  try {
    await window.desktop?.saveConfig({ onboardingDone: true, onboardingVersion: ONBOARDING_VERSION });
  } finally {
    onboarding.close();
  }
}
</script>
<template>
  <FullScreenGuide
    :model-value="onboarding.visible"
    :steps="steps"
    :brand-logo="BRAND_LOGO_URL"
    @finish="finish"
  />
</template>
