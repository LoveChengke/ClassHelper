<script setup lang="ts">
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useAuthStore } from '../../stores/auth.js';
import { useRealtimeStore } from '../../stores/realtime.js';

/**
 * 账号设置：本机登录的班级账号信息 + 退出登录。
 * 班级密码由管理员在 Web 管理端维护（本机按用户要求不提供改密入口）。
 */
const router = useRouter();
const auth = useAuthStore();
const realtime = useRealtimeStore();

async function logout(): Promise<void> {
  await ElMessageBox.confirm('确认退出当前账号？', '退出登录', { type: 'warning' });
  realtime.disconnect();
  await auth.logout();
  ElMessage.success('已退出登录');
  await router.replace('/login');
}
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">账号</h2>
        <p class="page-subtitle">本机登录的班级账号</p>
      </div>
    </div>

    <el-card shadow="never">
      <template #header><span>账号信息</span></template>
      <el-descriptions :column="1" border size="small">
        <el-descriptions-item label="姓名">{{ auth.user?.name ?? '-' }}</el-descriptions-item>
        <el-descriptions-item :label="auth.isClassSession ? '班级码' : '用户名'">
          {{ auth.user?.username ?? '-' }}
        </el-descriptions-item>
        <el-descriptions-item label="登录方式">
          {{ auth.isClassSession ? '班级账号（本机代表全班）' : '班级账号' }}
        </el-descriptions-item>
        <el-descriptions-item label="班级">{{ auth.user?.className ?? '未分班' }}</el-descriptions-item>
        <el-descriptions-item label="年级">{{ auth.user?.grade ?? '-' }}</el-descriptions-item>
      </el-descriptions>
      <div class="toolbar mt-16">
        <el-button type="danger" plain @click="logout">退出登录</el-button>
      </div>
      <div class="text-muted mt-12">
        班级密码由管理员在 Web 管理端「班级管理 → 修改班级账号」中设置；本机退出后用班级码 +
        班级密码重新登录。
      </div>
    </el-card>
  </div>
</template>
