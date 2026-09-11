<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import { authApi } from '@/api';
import { useAuthStore } from '@/stores/auth';
import { useRealtimeStore } from '@/stores/realtime';
import { APP_TITLE } from '@/config';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const realtime = useRealtimeStore();

const menuItems = [
  { name: 'dashboard', title: '仪表盘', icon: 'Odometer' },
  { name: 'classes', title: '班级管理', icon: 'School' },
  { name: 'students', title: '学生管理', icon: 'User' },
  { name: 'schedules', title: '课表管理', icon: 'Calendar' },
  { name: 'homeworks', title: '作业发布', icon: 'Notebook' },
  { name: 'notifications', title: '通知发布', icon: 'Bell' },
  { name: 'grades', title: '成绩录入', icon: 'Trophy' },
];

const activeMenu = computed(() => `/${String(route.name ?? 'dashboard')}`);

const connectionText = computed(() => {
  if (realtime.connected) return '实时通道已连接';
  if (realtime.connecting) return '实时通道连接中';
  return '实时通道已断开';
});

const connectionType = computed(() =>
  realtime.connected ? 'success' : realtime.connecting ? 'warning' : 'danger',
);

function go(name: string): void {
  void router.push({ name });
}

async function handleLogout(): Promise<void> {
  await ElMessageBox.confirm('确认退出当前账号？', '退出登录', { type: 'warning' });
  await auth.logout();
  ElMessage.success('已退出登录');
  void router.push({ name: 'login' });
}

/* ------------------------------------------------------------ 修改密码 */
const passwordVisible = ref(false);
const passwordFormRef = ref<FormInstance>();
const passwordForm = reactive({ currentPassword: '', newPassword: '', confirmPassword: '' });
const passwordRules: FormRules = {
  currentPassword: [{ required: true, message: '请输入当前密码', trigger: 'blur' }],
  newPassword: [
    { required: true, message: '请输入新密码', trigger: 'blur' },
    { min: 6, message: '新密码至少 6 位', trigger: 'blur' },
  ],
  confirmPassword: [
    {
      validator: (_rule, value: string, callback: (error?: Error) => void) => {
        if (!value) callback(new Error('请再次输入新密码'));
        else if (value !== passwordForm.newPassword) callback(new Error('两次输入的密码不一致'));
        else callback();
      },
      trigger: 'blur',
    },
  ],
};

async function submitPassword(): Promise<void> {
  const valid = await passwordFormRef.value?.validate().catch(() => false);
  if (!valid) return;
  await authApi.changePassword({
    currentPassword: passwordForm.currentPassword,
    newPassword: passwordForm.newPassword,
  });
  passwordVisible.value = false;
  passwordForm.currentPassword = '';
  passwordForm.newPassword = '';
  passwordForm.confirmPassword = '';
  ElMessage.success('密码修改成功，请重新登录');
  await auth.logout();
  void router.push({ name: 'login' });
}
</script>

<template>
  <el-container class="layout">
    <el-aside width="210px" class="layout-aside">
      <div class="brand">
        <el-icon :size="22"><School /></el-icon>
        <span class="brand-text">班级小助手</span>
      </div>
      <el-menu :default-active="activeMenu" class="layout-menu" @select="go">
        <el-menu-item v-for="item in menuItems" :key="item.name" :index="`/${item.name}`">
          <el-icon><component :is="item.icon" /></el-icon>
          <span>{{ item.title }}</span>
        </el-menu-item>
      </el-menu>
    </el-aside>

    <el-container>
      <el-header class="layout-header">
        <div class="header-left">
          <span class="header-title">{{ APP_TITLE }}</span>
          <el-tag :type="connectionType" size="small" effect="light">
            <span class="header-conn">{{ connectionText }}</span>
          </el-tag>
          <el-tag v-if="realtime.eventCount > 0" size="small" type="info" effect="plain">
            已接收 {{ realtime.eventCount }} 条实时事件
          </el-tag>
        </div>

        <div class="header-right">
          <el-dropdown trigger="click">
            <span class="user-chip">
              <el-icon><UserFilled /></el-icon>
              {{ auth.displayName }}
              <el-tag size="small" type="info" effect="plain">{{ auth.roleLabel }}</el-tag>
              <el-icon><ArrowDown /></el-icon>
            </span>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item @click="passwordVisible = true">
                  <el-icon><Lock /></el-icon>
                  修改密码
                </el-dropdown-item>
                <el-dropdown-item divided @click="handleLogout">
                  <el-icon><SwitchButton /></el-icon>
                  退出登录
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </el-header>

      <el-main class="layout-main">
        <router-view v-slot="{ Component }">
          <component :is="Component" />
        </router-view>
      </el-main>
    </el-container>

    <el-dialog v-model="passwordVisible" title="修改密码" width="420px">
      <el-form ref="passwordFormRef" :model="passwordForm" :rules="passwordRules" label-width="90px">
        <el-form-item label="当前密码" prop="currentPassword">
          <el-input v-model="passwordForm.currentPassword" type="password" show-password />
        </el-form-item>
        <el-form-item label="新密码" prop="newPassword">
          <el-input v-model="passwordForm.newPassword" type="password" show-password />
        </el-form-item>
        <el-form-item label="确认密码" prop="confirmPassword">
          <el-input v-model="passwordForm.confirmPassword" type="password" show-password />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="passwordVisible = false">取消</el-button>
        <el-button type="primary" @click="submitPassword">确认修改</el-button>
      </template>
    </el-dialog>
  </el-container>
</template>

<style scoped>
.layout {
  height: 100vh;
}

.layout-aside {
  background: #1f2d3d;
  color: #fff;
  display: flex;
  flex-direction: column;
}

.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 56px;
  padding: 0 16px;
  color: #fff;
  font-weight: 600;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.brand-text {
  font-size: 16px;
}

.layout-menu {
  border-right: none;
  background: transparent;
  flex: 1;
  --el-menu-text-color: #cbd5e1;
  --el-menu-hover-bg-color: rgba(255, 255, 255, 0.08);
  --el-menu-active-color: #ffffff;
}

.layout-menu :deep(.el-menu-item.is-active) {
  background: #409eff;
  border-radius: 6px;
  margin: 0 8px;
}

.layout-menu :deep(.el-menu-item) {
  margin: 2px 8px;
  border-radius: 6px;
}

.layout-header {
  background: #fff;
  border-bottom: 1px solid var(--ch-border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.header-title {
  font-weight: 600;
}

.header-conn {
  margin-left: 4px;
}

.header-right {
  display: flex;
  align-items: center;
}

.user-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  outline: none;
}

.layout-main {
  background: var(--ch-bg);
  padding: 0;
  overflow-y: auto;
}
</style>
