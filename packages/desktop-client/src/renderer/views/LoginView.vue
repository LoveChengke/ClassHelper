<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, type FormInstance, type FormRules } from 'element-plus';
import { pingHealth, setApiBaseUrl } from '../api/http.js';
import { useAppStore } from '../stores/app.js';
import { useAuthStore } from '../stores/auth.js';
import { useRealtimeStore } from '../stores/realtime.js';
import { DEFAULT_SERVER, normalizeServerUrl } from '../config.js';

const router = useRouter();
const appStore = useAppStore();
const auth = useAuthStore();
const realtime = useRealtimeStore();

const formRef = ref<FormInstance>();
const form = reactive({ serverUrl: DEFAULT_SERVER, code: '', password: '' });
const testing = ref(false);
const testResult = ref<'ok' | 'fail' | null>(null);

const rules: FormRules = {
  serverUrl: [
    {
      validator: (_rule, value: string, callback: (error?: Error) => void) => {
        if (!value?.trim()) callback(new Error('请输入服务器地址'));
        else if (!normalizeServerUrl(value)) callback(new Error('地址格式应为 http://主机:端口'));
        else callback();
      },
      trigger: 'blur',
    },
  ],
  code: [{ required: true, message: '请输入班级码', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }],
};

onMounted(async () => {
  // 主进程已保存过服务器地址/上次用户名则预填
  if (window.desktop) {
    const config = await window.desktop.getConfig();
    if (config.serverUrl) form.serverUrl = config.serverUrl;
    if (config.username) form.code = config.username;
  }
});

async function testConnection(): Promise<void> {
  const normalized = normalizeServerUrl(form.serverUrl);
  if (!normalized) {
    ElMessage.warning('请先填写正确的服务器地址');
    return;
  }
  testing.value = true;
  testResult.value = null;
  try {
    setApiBaseUrl(normalized);
    const result = await pingHealth();
    testResult.value = result.ok ? 'ok' : 'fail';
    if (result.ok) ElMessage.success('服务器连接正常');
    else ElMessage.error('无法连接服务器，请检查地址与网络');
  } finally {
    testing.value = false;
  }
}

async function submit(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;

  try {
    await auth.login(form.serverUrl, form.code.trim(), form.password);
    await appStore.init(form.serverUrl);
    // 登录后对齐"通知显示位置"：这台机器上次选的是弹 ClassHelper 还是弹 ClassIsland
    await appStore.loadNotificationChannel(auth.classId);
    if (auth.token) realtime.connect(appStore.serverUrl, auth.token);
    ElMessage.success(`已进入 ${auth.displayName}`);
    await router.replace('/schedule');
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '登录失败');
  }
}

/** 已保存登录态但服务器不可达时，允许用缓存数据离线进入 */
async function enterOffline(): Promise<void> {
  if (!auth.isAuthenticated) return;
  await appStore.init(appStore.serverUrl);
  ElMessage.warning('已进入离线模式，仅显示上次同步的数据');
  await router.replace('/schedule');
}
</script>

<template>
  <div class="login-page">
    <div class="login-card">
      <div class="login-head">
        <el-icon :size="30" color="#409eff"><School /></el-icon>
        <div>
          <h1 class="login-title">班级小助手</h1>
          <p class="login-sub">班级客户端 · 以班级账号登录，实时接收课表、作业、通知与成绩</p>
        </div>
      </div>

      <el-form ref="formRef" :model="form" :rules="rules" label-position="top" @submit.prevent="submit">
        <el-form-item label="服务器地址" prop="serverUrl">
          <el-input v-model="form.serverUrl" placeholder="http://127.0.0.1:4000" clearable>
            <template #prefix>
              <el-icon><Link /></el-icon>
            </template>
          </el-input>
        </el-form-item>

        <el-form-item label="班级码" prop="code">
          <el-input v-model="form.code" placeholder="请输入班级码" clearable @keyup.enter="submit">
            <template #prefix>
              <el-icon><School /></el-icon>
            </template>
          </el-input>
        </el-form-item>

        <el-form-item label="班级密码" prop="password">
          <el-input
            v-model="form.password"
            type="password"
            placeholder="班级密码"
            show-password
            @keyup.enter="submit"
          >
            <template #prefix>
              <el-icon><Lock /></el-icon>
            </template>
          </el-input>
        </el-form-item>

        <div class="login-actions">
          <el-button :loading="testing" @click="testConnection">测试连接</el-button>
          <el-button type="primary" :loading="auth.loading" @click="submit">登录</el-button>
        </div>

        <el-alert
          v-if="testResult === 'ok'"
          class="mt-12"
          type="success"
          :closable="false"
          title="服务器可达，可以登录"
        />
        <el-alert
          v-if="testResult === 'fail'"
          class="mt-12"
          type="error"
          :closable="false"
          title="无法连接服务器"
          description="请确认后端已启动（pnpm dev:server）、地址与端口正确、防火墙未拦截。"
        />
      </el-form>

      <el-divider v-if="auth.isAuthenticated">或</el-divider>
      <el-button v-if="auth.isAuthenticated" class="offline-button" @click="enterOffline">
        <el-icon><Connection /></el-icon>
        离线进入（使用本地缓存数据）
      </el-button>

      <p class="login-tip">
        班级码与班级密码由管理员在 Web 管理端「班级管理 → 班级账号」中设置或重置。
        <br />
        登录后本机即代表整个班级：作业完成、通知已读都会按全班记录。
      </p>
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
  width: 420px;
  background: #fff;
  border-radius: 14px;
  padding: 28px 26px 20px;
  box-shadow: 0 18px 40px rgba(15, 30, 50, 0.28);
}

.login-head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 18px;
}

.login-title {
  margin: 0;
  font-size: 20px;
}

.login-sub {
  margin: 4px 0 0;
  font-size: 12px;
  color: #909399;
}

.login-actions {
  display: flex;
  gap: 10px;
}

.login-actions .el-button {
  flex: 1;
}

.offline-button {
  width: 100%;
}

.login-tip {
  margin: 16px 0 0;
  font-size: 12px;
  line-height: 1.7;
  color: #c0c4cc;
}
</style>
