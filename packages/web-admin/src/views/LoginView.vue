<script setup lang="ts">
import { reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, type FormInstance, type FormRules } from 'element-plus';
import { useAuthStore } from '@/stores/auth';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

const formRef = ref<FormInstance>();
const form = reactive({ username: '', password: '' });
const rules: FormRules = {
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }],
};

const demoAccounts = [
  { role: '管理员', username: 'admin', password: 'admin123' },
  { role: '教师', username: 'teacher1', password: 'teacher123' },
  { role: '教师', username: 'teacher2', password: 'teacher123' },
];

function fill(username: string, password: string): void {
  form.username = username;
  form.password = password;
}

async function submit(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;

  try {
    await auth.login({ username: form.username.trim(), password: form.password });
    ElMessage.success(`欢迎回来，${auth.displayName}`);
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/dashboard';
    await router.replace(redirect);
  } catch {
    // 错误提示已由 axios 拦截器统一处理
  }
}
</script>

<template>
  <div class="login-page">
    <div class="login-card">
      <div class="login-brand">
        <el-icon :size="30" color="#409eff"><School /></el-icon>
        <div>
          <h1 class="login-title">班级小助手</h1>
          <p class="login-subtitle">Web 管理端 · 教师 / 管理员登录</p>
        </div>
      </div>

      <el-form ref="formRef" :model="form" :rules="rules" size="large" @submit.prevent="submit">
        <el-form-item prop="username">
          <el-input v-model="form.username" placeholder="用户名" :prefix-icon="'User'" clearable />
        </el-form-item>
        <el-form-item prop="password">
          <el-input
            v-model="form.password"
            type="password"
            placeholder="密码"
            :prefix-icon="'Lock'"
            show-password
            @keyup.enter="submit"
          />
        </el-form-item>
        <el-button type="primary" size="large" class="login-button" :loading="auth.loading" @click="submit">
          登录
        </el-button>
      </el-form>

      <el-divider>演示账号（点击填充）</el-divider>
      <div class="demo-list">
        <el-tag
          v-for="item in demoAccounts"
          :key="item.username"
          class="demo-tag"
          effect="plain"
          @click="fill(item.username, item.password)"
        >
          {{ item.role }}：{{ item.username }} / {{ item.password }}
        </el-tag>
      </div>
      <p class="login-tip">学生请使用班级小助手桌面客户端登录；种子数据见 README。</p>
    </div>
  </div>
</template>

<style scoped>
.login-page {
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #1f2d3d 0%, #3a5169 55%, #409eff 100%);
}

.login-card {
  width: 400px;
  background: #fff;
  border-radius: 14px;
  padding: 30px 28px 22px;
  box-shadow: 0 18px 40px rgba(15, 30, 50, 0.28);
}

.login-brand {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 22px;
}

.login-title {
  font-size: 20px;
  margin: 0;
}

.login-subtitle {
  margin: 4px 0 0;
  font-size: 13px;
  color: #909399;
}

.login-button {
  width: 100%;
}

.demo-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.demo-tag {
  cursor: pointer;
  justify-content: flex-start;
}

.login-tip {
  margin: 16px 0 0;
  font-size: 12px;
  color: #c0c4cc;
  line-height: 1.6;
}
</style>
