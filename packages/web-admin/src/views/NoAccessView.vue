<script setup lang="ts">
import { useAuthStore } from '@/stores/auth';
import { useRouter } from 'vue-router';
const auth = useAuthStore();
const router = useRouter();
async function logout() {
  await auth.logout();
  await router.replace('/login');
}
</script>
<template>
  <el-result icon="info" title="暂无可访问的功能" sub-title="请联系管理员检查模板与分配范围。">
    <template #extra><el-button @click="logout">退出登录</el-button></template>
  </el-result>
</template>
