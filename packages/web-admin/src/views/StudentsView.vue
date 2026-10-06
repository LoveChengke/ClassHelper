<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import {
  CALL_QUICK_PHRASES,
  ROLE_LABELS,
  formatDate,
  type ClassDto,
  type StudentDto,
} from '@classhelper/shared';
import { callApi, classApi, studentApi } from '@/api';
import TableImportDialog from '@/components/TableImportDialog.vue';

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

/** 名单导入（表格）：需要先选定班级，避免导入到错误的班级 */
const importVisible = ref(false);
function openImport(): void {
  if (!filter.classId) {
    ElMessage.warning('请先选择要导入的班级');
    return;
  }
  importVisible.value = true;
}

const formVisible = ref(false);
const formRef = ref<FormInstance>();
const editingId = ref<string | null>(null);
/** 表单不再暴露「用户名」：新建时由前端自动生成学号式名单标识（见 autoCreateStudent） */
const form = reactive({ name: '', classId: '' });
const rules: FormRules = {
  name: [{ required: true, message: '请输入姓名', trigger: 'blur' }],
};

function openCreate(): void {
  editingId.value = null;
  form.name = '';
  form.classId = filter.classId;
  formVisible.value = true;
}

function openEdit(row: StudentDto): void {
  editingId.value = row.id;
  form.name = row.name;
  form.classId = row.classId ?? '';
  formVisible.value = true;
}

/**
 * 自动生成学生名单标识（学号式：student01、student02 …，与种子数据同风格）。
 *
 * 后端 `POST /api/students` 的 username 必填且全局唯一（教师/管理员账号同样占位），
 * 界面已按需求隐藏「用户名」输入，因此这里用「全量学生 + 递增序号」生成，
 * 并在服务端返回 409（唯一约束冲突）时换下一个序号重试；其它错误立即抛出，避免刷屏。
 * 学生没有密码、不能登录，username 仅作名单标识。
 */
function studentUsernameAt(index: number): string {
  return index < 100 ? `student${String(index).padStart(2, '0')}` : `student${index}`;
}

async function autoCreateStudent(): Promise<void> {
  const existing = new Set((await studentApi.list()).map((item) => item.username));
  let index = existing.size + 1;
  let lastError: unknown = new Error('自动生成名单标识失败');

  for (let attempt = 0; attempt < 20; attempt += 1) {
    let username = studentUsernameAt(index);
    while (existing.has(username)) {
      index += 1;
      username = studentUsernameAt(index);
    }
    try {
      await studentApi.create({
        username,
        name: form.name.trim(),
        classId: form.classId || null,
      });
      return;
    } catch (error) {
      const status = (error as { response?: { status?: number } }).response?.status;
      if (status !== 409) throw error;
      lastError = error;
      existing.add(username);
      index += 1;
    }
  }
  throw lastError;
}

async function submitForm(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;

  if (editingId.value) {
    // 用户名不再由界面维护：编辑只改姓名与班级
    await studentApi.update(editingId.value, {
      name: form.name.trim(),
      classId: form.classId || null,
    });
    ElMessage.success('学生信息已更新');
  } else {
    try {
      await autoCreateStudent();
      ElMessage.success('学生已创建（名单标识已自动生成）');
    } catch {
      // 接口层已弹出服务端原因，这里补充可执行的兜底建议
      ElMessage.error('创建失败：可稍后重试，或用「导入名单」在表格里显式指定用户名');
      return;
    }
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

onMounted(async () => {
  await Promise.all([loadClasses(), loadStudents()]);
});

/* ------------------------------------------------------------ 叫人 */

const callVisible = ref(false);
const callSending = ref(false);
const callTarget = ref<StudentDto | null>(null);
const callForm = reactive({ quickPhrase: '', message: '', urgent: false });

function openCall(row: StudentDto): void {
  callTarget.value = row;
  callForm.quickPhrase = CALL_QUICK_PHRASES[0] ?? '';
  callForm.message = '';
  callForm.urgent = false;
  callVisible.value = true;
}

function pickPhrase(phrase: string): void {
  callForm.quickPhrase = callForm.quickPhrase === phrase ? '' : phrase;
}

async function submitCall(): Promise<void> {
  const target = callTarget.value;
  if (!target) return;
  if (!target.classId) {
    ElMessage.warning('该学生还没有分班，无法叫人');
    return;
  }
  if (!callForm.message.trim() && !callForm.quickPhrase.trim()) {
    ElMessage.warning('请选择快捷短语或填写自定义消息');
    return;
  }

  callSending.value = true;
  try {
    const created = await callApi.create({
      classId: target.classId,
      studentId: target.id,
      urgent: callForm.urgent,
      ...(callForm.message.trim() ? { message: callForm.message.trim() } : {}),
      ...(callForm.quickPhrase.trim() ? { quickPhrase: callForm.quickPhrase.trim() } : {}),
    });
    ElMessage.success(`已${callForm.urgent ? '紧急' : ''}通知 ${target.name}：${created.title}`);
    callVisible.value = false;
  } finally {
    callSending.value = false;
  }
}
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">学生管理</h2>
        <p class="page-subtitle">学生名单、分班与叫人（学生端统一用班级账号登录，学生本身没有密码）</p>
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
          placeholder="姓名"
          clearable
          style="width: 180px"
          @keyup.enter="loadStudents"
          @clear="loadStudents"
        />
        <el-button :icon="'Search'" @click="loadStudents">查询</el-button>
        <el-button type="primary" :icon="'Plus'" @click="openCreate">新建学生</el-button>
        <el-button type="warning" :icon="'Document'" @click="openImport">导入名单</el-button>
      </div>
    </div>

    <el-card shadow="never" class="table-card">
      <el-table v-loading="loading" :data="students" empty-text="暂无学生数据">
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
        <el-table-column label="操作" width="280" fixed="right">
          <template #default="{ row }">
            <el-button link type="success" @click="openCall(row)">叫人</el-button>
            <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button link type="danger" @click="removeStudent(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 叫人：选中学生 + 快捷短语/自定义消息 → 学生端灵动岛立即弹出 -->
    <el-dialog v-model="callVisible" title="叫人" width="480px">
      <el-alert
        v-if="callTarget"
        :title="`请 ${callTarget.name} 同学找老师`"
        type="success"
        :closable="false"
        class="call-alert"
      >
        <template #default>
          发送后学生端桌面会浮出「请 {{ callTarget.name }} 同学找 XXX 老师」；
          <b>紧急</b>
          叫人无视上课时段立即展开，
          <b>普通</b>
          叫人课间先显示胶囊、上课时段只排队。
        </template>
      </el-alert>

      <div class="call-section">
        <div class="call-label">快捷短语（点击选择，再点一次取消）</div>
        <div class="call-phrases">
          <el-tag
            v-for="phrase in CALL_QUICK_PHRASES"
            :key="phrase"
            class="call-phrase"
            :effect="callForm.quickPhrase === phrase ? 'dark' : 'plain'"
            :type="callForm.quickPhrase === phrase ? 'success' : 'info'"
            @click="pickPhrase(phrase)"
          >
            {{ phrase }}
          </el-tag>
        </div>
      </div>

      <div class="call-section">
        <div class="call-label">级别（默认普通：不打断课堂）</div>
        <el-radio-group v-model="callForm.urgent">
          <el-radio-button :value="false">普通</el-radio-button>
          <el-radio-button :value="true">紧急</el-radio-button>
        </el-radio-group>
      </div>

      <div class="call-section">
        <div class="call-label">自定义消息（可选，优先于快捷短语）</div>
        <el-input
          v-model="callForm.message"
          type="textarea"
          :rows="3"
          maxlength="200"
          show-word-limit
          placeholder="例如：带上昨天的数学作业到办公室"
        />
      </div>

      <template #footer>
        <el-button @click="callVisible = false">取消</el-button>
        <el-button type="primary" :loading="callSending" @click="submitCall">发送叫人</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="formVisible" :title="editingId ? '编辑学生' : '新建学生'" width="460px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="90px">
        <el-form-item label="姓名" prop="name">
          <el-input v-model="form.name" />
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

    <!-- 学生名单导入（xlsx/xls/csv，仅管理员可见；后端同样强校验权限） -->
    <TableImportDialog
      v-model="importVisible"
      kind="students"
      :class-id="filter.classId"
      @imported="loadStudents"
    />
  </div>
</template>

<style scoped>
.call-alert {
  margin-bottom: 12px;
}

.call-section {
  margin-bottom: 14px;
}

.call-label {
  font-size: 13px;
  color: var(--ch-text-secondary);
  margin-bottom: 8px;
}

.call-phrases {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.call-phrase {
  cursor: pointer;
  user-select: none;
}
</style>
