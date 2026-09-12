<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import { ROLE_LABELS, formatDate, type ClassDto, type StudentDto } from '@classhelper/shared';
import { classApi, studentApi } from '@/api';

const loading = ref(false);
const students = ref<StudentDto[]>([]);
const classes = ref<ClassDto[]>([]);
const filter = reactive({ classId: '', keyword: '' });

async function loadClasses(): Promise<void> {
  classes.value = await classApi.list();
}

async function loadStudents(): Promise<void> {
  loading.value = true;
  try {
    const params: { classId?: string; keyword?: string } = {};
    if (filter.classId) params.classId = filter.classId;
    if (filter.keyword.trim()) params.keyword = filter.keyword.trim();
    students.value = await studentApi.list(params);
  } finally {
    loading.value = false;
  }
}

/* ------------------------------------------------------------ 新建 / 编辑 */

const formVisible = ref(false);
const formRef = ref<FormInstance>();
const editingId = ref<string | null>(null);
const form = reactive({ username: '', name: '', password: '', classId: '' });
const rules: FormRules = {
  username: [
    { required: true, message: '请输入用户名', trigger: 'blur' },
    { min: 3, message: '用户名至少 3 位', trigger: 'blur' },
  ],
  name: [{ required: true, message: '请输入姓名', trigger: 'blur' }],
};

function openCreate(): void {
  editingId.value = null;
  form.username = '';
  form.name = '';
  form.password = '';
  form.classId = filter.classId;
  formVisible.value = true;
}

function openEdit(row: StudentDto): void {
  editingId.value = row.id;
  form.username = row.username;
  form.name = row.name;
  form.password = '';
  form.classId = row.classId ?? '';
  formVisible.value = true;
}

async function submitForm(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;

  if (editingId.value) {
    await studentApi.update(editingId.value, {
      username: form.username.trim(),
      name: form.name.trim(),
      classId: form.classId || null,
    });
    ElMessage.success('学生信息已更新');
  } else {
    await studentApi.create({
      username: form.username.trim(),
      name: form.name.trim(),
      classId: form.classId || null,
      ...(form.password ? { password: form.password } : {}),
    });
    ElMessage.success('学生账号创建成功');
  }
  formVisible.value = false;
  await loadStudents();
}

async function removeStudent(row: StudentDto): Promise<void> {
  await ElMessageBox.confirm(`删除学生「${row.name}」及其成绩、作业记录？`, '危险操作', {
    type: 'warning',
    confirmButtonText: '确认删除',
  });
  await studentApi.remove(row.id);
  ElMessage.success('学生已删除');
  await loadStudents();
}

async function resetPassword(row: StudentDto): Promise<void> {
  await ElMessageBox.confirm(`将「${row.name}」的密码重置为默认密码？`, '重置密码', { type: 'warning' });
  await studentApi.resetPassword(row.id);
  ElMessage.success('密码已重置为默认密码');
}

onMounted(async () => {
  await Promise.all([loadClasses(), loadStudents()]);
});
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">学生管理</h2>
        <p class="page-subtitle">学生账号、分班与密码重置（数据范围按班级权限收敛）</p>
      </div>
      <div class="toolbar">
        <el-select
          v-model="filter.classId"
          placeholder="全部班级"
          clearable
          style="width: 180px"
          @change="loadStudents"
        >
          <el-option v-for="item in classes" :key="item.id" :label="item.name" :value="item.id" />
        </el-select>
        <el-input
          v-model="filter.keyword"
          placeholder="姓名 / 用户名"
          clearable
          style="width: 180px"
          @keyup.enter="loadStudents"
          @clear="loadStudents"
        />
        <el-button :icon="'Search'" @click="loadStudents">查询</el-button>
        <el-button type="primary" :icon="'Plus'" @click="openCreate">新建学生</el-button>
      </div>
    </div>

    <el-card shadow="never" class="table-card">
      <el-table v-loading="loading" :data="students" empty-text="暂无学生数据">
        <el-table-column prop="username" label="用户名" width="140" />
        <el-table-column prop="name" label="姓名" width="120" />
        <el-table-column label="角色" width="90">
          <template #default="{ row }">{{ ROLE_LABELS[row.role as 'STUDENT'] ?? row.role }}</template>
        </el-table-column>
        <el-table-column label="班级" width="140">
          <template #default="{ row }">
            <el-tag v-if="row.className" size="small" effect="plain">{{ row.className }}</el-tag>
            <span v-else class="text-muted">未分班</span>
          </template>
        </el-table-column>
        <el-table-column label="年级" width="90">
          <template #default="{ row }">{{ row.grade ?? '-' }}</template>
        </el-table-column>
        <el-table-column label="创建时间" width="170">
          <template #default="{ row }">{{ formatDate(row.createdAt, true) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="220" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button link type="warning" @click="resetPassword(row)">重置密码</el-button>
            <el-button link type="danger" @click="removeStudent(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="formVisible" :title="editingId ? '编辑学生' : '新建学生'" width="460px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="90px">
        <el-form-item label="用户名" prop="username">
          <el-input v-model="form.username" :disabled="Boolean(editingId)" />
        </el-form-item>
        <el-form-item label="姓名" prop="name">
          <el-input v-model="form.name" />
        </el-form-item>
        <el-form-item v-if="!editingId" label="初始密码">
          <el-input v-model="form.password" placeholder="留空使用默认密码" />
        </el-form-item>
        <el-form-item label="班级">
          <el-select v-model="form.classId" placeholder="暂不分班" clearable style="width: 100%">
            <el-option v-for="item in classes" :key="item.id" :label="item.name" :value="item.id" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="formVisible = false">取消</el-button>
        <el-button type="primary" @click="submitForm">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>
