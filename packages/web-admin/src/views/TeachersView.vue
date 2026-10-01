<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import { ROLE_LABELS, formatDate, type UserDto } from '@classhelper/shared';
import { teacherApi } from '@/api';
import TableImportDialog from '@/components/TableImportDialog.vue';

/**
 * 教师管理（**仅管理员可见/可用**，与后端 `requireRole('ADMIN')` 对应）。
 *
 * 与「学生管理」保持同一套交互：单个录入 / 表格导入名单 / 编辑 / 修改密码 / 删除。
 * 学生端主体是班级账号，教师账号则决定"谁是班主任、谁能录课表与成绩"，
 * 属于系统级配置，所以录入权限只给管理员。
 */

const loading = ref(false);
const saving = ref(false);
const teachers = ref<UserDto[]>([]);
const keyword = ref('');

async function loadTeachers(): Promise<void> {
  loading.value = true;
  try {
    teachers.value = await teacherApi.list(keyword.value.trim() || undefined);
  } finally {
    loading.value = false;
  }
}

/* ------------------------------------------------------------ 录入 / 编辑 */

const formVisible = ref(false);
const formRef = ref<FormInstance>();
const editingId = ref<string | null>(null);
const form = reactive({ username: '', name: '', password: '', role: 'TEACHER' as 'TEACHER' | 'ADMIN' });
const rules: FormRules = {
  username: [
    { required: true, message: '请输入登录用户名', trigger: 'blur' },
    { min: 3, max: 32, message: '用户名 3~32 位', trigger: 'blur' },
    { pattern: /^[A-Za-z0-9_.-]+$/, message: '只能用字母、数字、下划线、点、短横线', trigger: 'blur' },
  ],
  name: [{ required: true, message: '请输入姓名', trigger: 'blur' }],
  password: [{ min: 6, message: '密码至少 6 位', trigger: 'blur' }],
};

function openCreate(): void {
  editingId.value = null;
  form.username = '';
  form.name = '';
  form.password = '';
  form.role = 'TEACHER';
  formVisible.value = true;
}

function openEdit(row: UserDto): void {
  editingId.value = row.id;
  form.username = row.username;
  form.name = row.name;
  form.password = '';
  form.role = row.role === 'ADMIN' ? 'ADMIN' : 'TEACHER';
  formVisible.value = true;
}

async function submitForm(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;

  saving.value = true;
  try {
    if (editingId.value) {
      await teacherApi.update(editingId.value, {
        username: form.username.trim(),
        name: form.name.trim(),
        role: form.role,
      });
      ElMessage.success('教师信息已更新');
    } else {
      await teacherApi.create({
        username: form.username.trim(),
        name: form.name.trim(),
        role: form.role,
        ...(form.password ? { password: form.password } : {}),
      });
      ElMessage.success(
        form.password ? '教师账号已创建' : '教师账号已创建（使用默认初始密码，请提醒本人尽快修改）',
      );
    }
    formVisible.value = false;
    await loadTeachers();
  } finally {
    saving.value = false;
  }
}

/**
 * 修改教师密码（管理员给教师改密）。
 *
 * 后端 `POST /teachers/:id/reset-password` 本来就接受可选的 `newPassword`（留空才用默认初始密码），
 * 但界面原先只发空请求、按钮还叫「重置密码」 —— 于是管理员**没有任何办法**把某个教师的密码改成
 * 指定值，只能重置成默认的 `DEFAULT_TEACHER_PASSWORD`（用户反馈："教师账号没有办法修改密码"，
 * 并且指着教师列表问"教师修改密码呢"）。
 * 因此这里把入口正名为「修改密码」：填了就设成填的值，留空才是"重置为默认初始密码"。
 */
async function changePassword(row: UserDto): Promise<void> {
  const result = await ElMessageBox.prompt(
    '输入新密码即可直接为该账号设置密码；留空则重置为默认初始密码。',
    `修改「${row.name}」的密码`,
    {
      confirmButtonText: '确认修改',
      cancelButtonText: '取消',
      inputType: 'password',
      inputPlaceholder: '新密码（至少 6 位，留空 = 默认初始密码）',
      // 默认校验器不允许空输入，这里必须放行"留空"这一条路
      inputValidator: (value: string) => !value || value.length >= 6 || '新密码至少 6 位',
    },
  ).catch(() => null);
  if (!result) return;

  const newPassword = (result.value ?? '').trim();
  await teacherApi.resetPassword(row.id, newPassword || undefined);
  ElMessage.success(newPassword ? '教师密码已修改' : '密码已重置为默认初始密码');
}

async function removeTeacher(row: UserDto): Promise<void> {
  await ElMessageBox.confirm(
    `删除教师账号「${row.name}（${row.username}）」？` +
      '若 TA 还是班主任或持有课程，系统会拒绝删除，请先在班级管理里更换班主任。',
    '危险操作',
    { type: 'warning', confirmButtonText: '确认删除' },
  );
  await teacherApi.remove(row.id);
  ElMessage.success('教师账号已删除');
  await loadTeachers();
}

/* ------------------------------------------------------------ 导入名单 */

const importVisible = ref(false);

function roleLabel(role: string): string {
  return ROLE_LABELS[role as keyof typeof ROLE_LABELS] ?? role;
}

onMounted(loadTeachers);
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">教师管理</h2>
        <p class="page-subtitle">
          录入教师账号（单个录入或导入名单）、修改姓名与角色、修改密码（仅管理员可见）
        </p>
      </div>
      <div class="toolbar">
        <el-input
          v-model="keyword"
          placeholder="姓名 / 用户名"
          clearable
          style="width: 180px"
          @keyup.enter="loadTeachers"
          @clear="loadTeachers"
        />
        <el-button :icon="'Search'" @click="loadTeachers">查询</el-button>
        <el-button type="primary" :icon="'Plus'" @click="openCreate">新建教师</el-button>
        <el-button type="warning" :icon="'Document'" @click="importVisible = true">导入名单</el-button>
      </div>
    </div>

    <el-card shadow="never">
      <el-table v-loading="loading" :data="teachers" empty-text="还没有教师账号，点击右上角新建">
        <el-table-column prop="name" label="姓名" width="140" />
        <el-table-column prop="username" label="用户名" width="180" />
        <el-table-column label="角色" width="120">
          <template #default="{ row }">
            <el-tag :type="row.role === 'ADMIN' ? 'danger' : 'primary'" effect="plain" size="small">
              {{ roleLabel(row.role) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="创建时间" min-width="170">
          <template #default="{ row }">{{ formatDate(row.createdAt, true) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="220" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button link type="warning" @click="changePassword(row)">修改密码</el-button>
            <el-button link type="danger" @click="removeTeacher(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="formVisible" :title="editingId ? '编辑教师' : '新建教师'" width="460px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="90px">
        <el-form-item label="姓名" prop="name">
          <el-input v-model="form.name" placeholder="例如 张老师" />
        </el-form-item>
        <el-form-item label="用户名" prop="username">
          <el-input v-model="form.username" placeholder="登录用，例如 teacher3" />
        </el-form-item>
        <el-form-item v-if="!editingId" label="初始密码">
          <el-input v-model="form.password" type="password" show-password placeholder="留空使用默认密码" />
        </el-form-item>
        <el-form-item label="角色">
          <el-radio-group v-model="form.role">
            <el-radio value="TEACHER">教师</el-radio>
            <el-radio value="ADMIN">管理员</el-radio>
          </el-radio-group>
          <div class="text-muted" style="width: 100%">
            管理员可以管理班级、学生、教师与全部课表；普通教师仅能管理自己负责的班级。
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="formVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submitForm">保存</el-button>
      </template>
    </el-dialog>

    <!-- 导入教师名单：与班级无关，因此不需要选班级 -->
    <TableImportDialog v-model="importVisible" kind="teachers" @imported="loadTeachers" />
  </div>
</template>
