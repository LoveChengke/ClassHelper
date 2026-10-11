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
        <img class="login-logo" src="/logo.png" alt="" width="44" height="44" />
        <div>
          <h1 class="login-title">ClassHelper</h1>
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
    </div>
  </div>
</template>

<style scoped>
.login-page {
  min-height: 100vh;
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: linear-gradient(135deg, #1f2d3d 0%, #3a5169 55%, #409eff 100%);
}

.login-card {
  width: 400px;
  max-width: 100%;
  background: #fff;
  border-radius: 14px;
  padding: 30px 28px 22px;
  box-shadow: 0 18px 40px rgba(15, 30, 50, 0.28);
  /*
   * 登录卡片**永远按浅色渲染**。
   *
   * 页面底色是刻意固定的深色渐变（AGENTS.md §5 第 46 条），卡片按设计就是"深底白卡"。
   * 但卡片的内部颜色原本会随 `html.dark` 变：Element Plus 的深色 css-vars 与 `--ch-*`
   * 是挂在 `<html>` 上的，照常继承进白卡片 —— 于是深色主题下出现"白卡片 + 深色输入框 +
   * 浅灰字"的黑白混搭（用户反馈的「登录页出现黑夜白天模式混合显示」）。
   * 这里把卡片范围内的语义色与关键 --el-* 变量钉回浅色值；原生控件也一并声明为 light。
   */
  color-scheme: light;
  --ch-surface: #ffffff;
  --ch-surface-alt: #f7f9fc;
  --ch-surface-sunken: #f2f3f5;
  --ch-surface-hover: #e6e8eb;
  --ch-border: #e6e8ef;
  --ch-text: #303133;
  --ch-text-secondary: #606266;
  --ch-text-muted: #909399;
  --ch-text-placeholder: #c0c4cc;
  --el-bg-color: #ffffff;
  --el-bg-color-overlay: #ffffff;
  --el-bg-color-page: #f2f4f8;
  --el-text-color-primary: #303133;
  --el-text-color-regular: #606266;
  --el-text-color-secondary: #909399;
  --el-text-color-placeholder: #c0c4cc;
  --el-text-color-disabled: #a8abb2;
  --el-fill-color-blank: #ffffff;
  --el-fill-color-light: #f2f3f5;
  --el-fill-color-lighter: #f5f7fa;
  --el-fill-color: #f2f3f5;
  --el-border-color: #e6e8ef;
  --el-border-color-light: #e6e8ef;
  --el-border-color-lighter: #e6e8ef;
  --el-color-primary: #409eff;
  /*
   * 入场用 PANEL 弹簧（beUI 的 center-morph-modal 观感：从略小、略高处落下来）。
   * 登录页是整个应用里最"一次性"、最值得给一点分量的一屏 ——
   * 它不像弹窗那样会被反复开关，慢一点不会变成等待。
   * keyframes 定义在 styles/index.css 的动效层里（全局，scoped 样式也能引用）。
   */
  animation: ch-panel-in var(--ch-spring-panel-dur) var(--ch-spring-panel) both;
}

@media (max-width: 768px) {
  .login-card {
    padding: 22px 18px 18px;
    border-radius: 12px;
  }

  .login-title {
    font-size: 18px;
  }

  .login-brand {
    margin-bottom: 16px;
  }
}

.login-brand {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 22px;
}

/* 品牌标：与应用图标同一份图（`public/logo.png`）。图自带圆角与透明边角，不要再加 border-radius。 */
.login-logo {
  flex: none;
  display: block;
}

.login-title {
  font-size: 20px;
  margin: 0;
}

.login-subtitle {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--ch-text-muted);
}

.login-button {
  width: 100%;
}
</style>
