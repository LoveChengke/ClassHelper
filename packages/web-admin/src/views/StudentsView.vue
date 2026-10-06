<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import {
  CALL_QUICK_PHRASES,
  STUDENT_GENDERS,
  STUDENT_GENDER_LABELS,
  STUDENT_STATUSES,
  STUDENT_STATUS_LABELS,
  STUDENT_STATUS_TAG_TYPES,
  formatDate,
  type ClassDto,
  type StudentDto,
  type StudentStatus,
  type StudentTransferDto,
} from '@classhelper/shared';
import { callApi, classApi, studentApi } from '@/api';
import TableImportDialog from '@/components/TableImportDialog.vue';

const loading = ref(false);
const students = ref<StudentDto[]>([]);
const classes = ref<ClassDto[]>([]);
const filter = reactive({ classId: '', keyword: '', status: '' as '' | StudentStatus });
/** 表格勾选（批量调班 / 批量转出用） */
const selection = ref<StudentDto[]>([]);

const classOptions = computed(() => classes.value);

async function loadClasses(): Promise<void> {
  classes.value = await classApi.list();
}

async function loadStudents(): Promise<void> {
  loading.value = true;
  try {
    const params: { classId?: string; keyword?: string; status?: StudentStatus } = {};
    if (filter.classId) params.classId = filter.classId;
    if (filter.keyword.trim()) params.keyword = filter.keyword.trim();
    if (filter.status) params.status = filter.status;
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
/** 学号是学生的唯一标识与查询键，必须由管理员显式填写（不再自动生成） */
const form = reactive({
  studentNo: '',
  name: '',
  classId: '',
  gender: '' as '' | 'MALE' | 'FEMALE',
  guardianPhone: '',
});
const rules: FormRules = {
  studentNo: [{ required: true, message: '请输入学号', trigger: 'blur' }],
  name: [{ required: true, message: '请输入姓名', trigger: 'blur' }],
};

function openCreate(): void {
  editingId.value = null;
  form.studentNo = '';
  form.name = '';
  form.classId = filter.classId;
  form.gender = '';
  form.guardianPhone = '';
  formVisible.value = true;
}

function openEdit(row: StudentDto): void {
  editingId.value = row.id;
  form.studentNo = row.studentNo;
  form.name = row.name;
  form.classId = row.classId ?? '';
  form.gender = row.gender;
  form.guardianPhone = row.guardianPhone;
  formVisible.value = true;
}

async function submitForm(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;

  const payload = {
    studentNo: form.studentNo.trim(),
    name: form.name.trim(),
    classId: form.classId || null,
    gender: form.gender,
    guardianPhone: form.guardianPhone.trim(),
  };

  if (editingId.value) {
    await studentApi.update(editingId.value, payload);
    ElMessage.success('学生信息已更新');
  } else {
    await studentApi.create(payload);
    ElMessage.success('学生已加入名单');
  }
  formVisible.value = false;
  await loadStudents();
}

async function removeStudent(row: StudentDto): Promise<void> {
  await ElMessageBox.confirm(`删除学生「${row.name}（${row.studentNo}）」及其成绩、作业记录？`, '危险操作', {
    type: 'warning',
    confirmButtonText: '确认删除',
  });
  await studentApi.remove(row.id);
  ElMessage.success('学生已删除');
  await loadStudents();
}

/* ------------------------------------------------------------ 调班 / 转出 */
// 规则（需求「管理员调班」）：只改学生当前班级，**学号不变**、不创建账号；
// 原班级/新班级/操作人/时间记入历史；历史作业与成绩保留原归属。

const transferVisible = ref(false);
const transferSaving = ref(false);
const transferTargets = ref<StudentDto[]>([]);
const transferForm = reactive({ toClassId: '', note: '' });

function openTransfer(rows: StudentDto[]): void {
  if (rows.length === 0) {
    ElMessage.warning('请先勾选要调动的学生');
    return;
  }
  transferTargets.value = rows;
  transferForm.toClassId = '';
  transferForm.note = '';
  transferVisible.value = true;
}

async function submitTransfer(): Promise<void> {
  transferSaving.value = true;
  try {
    const result = await studentApi.transfer(
      transferTargets.value.map((item) => item.id),
      transferForm.toClassId || null,
      transferForm.note.trim() || undefined,
    );
    ElMessage.success(`已调动 ${result.moved} 名学生（学号不变，历史可查）`);
    transferVisible.value = false;
    await loadStudents();
  } finally {
    transferSaving.value = false;
  }
}

async function transferOut(rows: StudentDto[]): Promise<void> {
  if (rows.length === 0) {
    ElMessage.warning('请先勾选要办理转出的学生');
    return;
  }
  const names = rows.map((item) => item.name).join('、');
  const { value } = await ElMessageBox.prompt(
    `将 ${rows.length} 名学生（${names}）标记为「已转出」。\n` +
      '转出表示学籍离开本校：班级归属与历史成绩、作业都会保留，只是不再计入在读名单。',
    '办理学生转出',
    { inputPlaceholder: '转出去向 / 原因（可选）', inputValue: '', confirmButtonText: '确认转出' },
  );
  const result = await studentApi.transferOut(
    rows.map((item) => item.id),
    (value ?? '').trim() || undefined,
  );
  ElMessage.success(`已办理 ${result.transferred} 名学生转出`);
  await loadStudents();
}

/* ------------------------------------------------------------ 调班历史 */

const historyVisible = ref(false);
const historyLoading = ref(false);
const historyRows = ref<StudentTransferDto[]>([]);
const historyTarget = ref<StudentDto | null>(null);

async function openHistory(row: StudentDto): Promise<void> {
  historyTarget.value = row;
  historyVisible.value = true;
  historyLoading.value = true;
  try {
    const result = await studentApi.transfersOf(row.id);
    historyRows.value = result.items;
  } finally {
    historyLoading.value = false;
  }
}

const TRANSFER_MODE_LABELS: Record<string, string> = {
  single: '单个调班',
  batch: '批量调班',
  'transfer-out': '转出',
};

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
        <p class="page-subtitle">
          学生是班级名单里的记录：<b>没有个人账号、不能登录</b>，学号是唯一标识；教室机器用班级码 + 班级密码登录
        </p>
      </div>
      <div class="toolbar">
        <el-select
          v-model="filter.classId"
          placeholder="全部班级"
          clearable
          style="width: 170px"
          @change="loadStudents"
        >
          <el-option v-for="item in classOptions" :key="item.id" :label="item.name" :value="item.id" />
        </el-select>
        <el-select
          v-model="filter.status"
          placeholder="全部状态"
          clearable
          style="width: 130px"
          @change="loadStudents"
        >
          <el-option
            v-for="status in STUDENT_STATUSES"
            :key="status"
            :label="STUDENT_STATUS_LABELS[status]"
            :value="status"
          />
        </el-select>
        <el-input
          v-model="filter.keyword"
          placeholder="学号 / 姓名"
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
      <template #header>
        <div class="card-header">
          <span>共 {{ students.length }} 名学生</span>
          <div class="toolbar">
            <el-button
              type="primary"
              plain
              :icon="'Switch'"
              :disabled="selection.length === 0"
              @click="openTransfer(selection)"
            >
              批量调班<span v-if="selection.length">（{{ selection.length }}）</span>
            </el-button>
            <el-button
              type="danger"
              plain
              :icon="'Right'"
              :disabled="selection.length === 0"
              @click="transferOut(selection)"
            >
              批量转出<span v-if="selection.length">（{{ selection.length }}）</span>
            </el-button>
          </div>
        </div>
      </template>
      <el-table
        v-loading="loading"
        :data="students"
        empty-text="暂无学生数据"
        @selection-change="(rows: StudentDto[]) => (selection = rows)"
      >
        <el-table-column type="selection" width="46" />
        <el-table-column prop="studentNo" label="学号" width="130" />
        <el-table-column prop="name" label="姓名" width="110" />
        <el-table-column label="性别" width="80">
          <template #default="{ row }">{{ STUDENT_GENDER_LABELS[row.gender as '' | 'MALE' | 'FEMALE'] }}</template>
        </el-table-column>
        <el-table-column label="班级" width="140">
          <template #default="{ row }">
            <el-tag v-if="row.className" size="small" effect="plain">{{ row.className }}</el-tag>
            <span v-else class="text-muted">未分班</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="STUDENT_STATUS_TAG_TYPES[row.status as StudentStatus]">
              {{ STUDENT_STATUS_LABELS[row.status as StudentStatus] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="guardianPhone" label="家长手机号" width="140">
          <template #default="{ row }">{{ row.guardianPhone || '-' }}</template>
        </el-table-column>
        <el-table-column label="创建时间" width="170">
          <template #default="{ row }">{{ formatDate(row.createdAt, true) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="330" fixed="right">
          <template #default="{ row }">
            <el-button link type="success" @click="openCall(row)">叫人</el-button>
            <el-button link type="primary" @click="openTransfer([row])">调班</el-button>
            <el-button link @click="openHistory(row)">调班历史</el-button>
            <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button link type="danger" @click="removeStudent(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 调班：只改当前班级，学号不变、历史作业与成绩保留原归属 -->
    <el-dialog v-model="transferVisible" title="调班" width="480px">
      <el-alert type="info" :closable="false" class="call-alert">
        调班只改学生**当前班级**：学号不变、不创建账号；原班级 / 新班级 / 操作人 / 时间会记入调班历史，
        该生已有的成绩与作业仍留在原班级。
      </el-alert>
      <el-form label-width="90px">
        <el-form-item label="学生">
          <span>{{ transferTargets.length }} 名（{{ transferTargets.map((s) => s.name).join('、') }}）</span>
        </el-form-item>
        <el-form-item label="调入班级">
          <el-select v-model="transferForm.toClassId" placeholder="留空 = 移出班级（未分班）" clearable style="width: 100%">
            <el-option v-for="item in classOptions" :key="item.id" :label="item.name" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="transferForm.note" maxlength="200" placeholder="例如：按分班考试成绩调整（可选）" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="transferVisible = false">取消</el-button>
        <el-button type="primary" :loading="transferSaving" @click="submitTransfer">确认调动</el-button>
      </template>
    </el-dialog>

    <!-- 调班历史 -->
    <el-drawer v-model="historyVisible" :title="`调班历史 — ${historyTarget?.name ?? ''}`" size="640px">
      <el-table v-loading="historyLoading" :data="historyRows" empty-text="该生还没有调班记录">
        <el-table-column label="时间" width="160">
          <template #default="{ row }">{{ formatDate(row.createdAt, true) }}</template>
        </el-table-column>
        <el-table-column label="方式" width="100">
          <template #default="{ row }">{{ TRANSFER_MODE_LABELS[row.mode] ?? row.mode }}</template>
        </el-table-column>
        <el-table-column label="原班级" width="130">
          <template #default="{ row }">{{ row.fromClassName || '未分班' }}</template>
        </el-table-column>
        <el-table-column label="新班级" width="130">
          <template #default="{ row }">{{ row.toClassName || '未分班' }}</template>
        </el-table-column>
        <el-table-column prop="operatorName" label="操作人" width="100" />
        <el-table-column prop="note" label="备注" show-overflow-tooltip />
      </el-table>
    </el-drawer>

    <!-- 叫人：选中学生 + 快捷短语/自定义消息 → 教室机器立即弹出 -->
    <el-dialog v-model="callVisible" title="叫人" width="480px">
      <el-alert
        v-if="callTarget"
        :title="`请 ${callTarget.name} 同学找老师`"
        type="success"
        :closable="false"
        class="call-alert"
      >
        <template #default>
          发送后教室的 ClassHelper 班级端会浮出「请 {{ callTarget.name }} 同学找 XXX 老师」；
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

    <el-dialog v-model="formVisible" :title="editingId ? '编辑学生' : '新建学生'" width="480px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="100px">
        <el-form-item label="学号" prop="studentNo">
          <el-input v-model="form.studentNo" placeholder="学生的唯一标识，如 202601" />
        </el-form-item>
        <el-form-item label="姓名" prop="name">
          <el-input v-model="form.name" />
        </el-form-item>
        <el-form-item label="性别">
          <el-select v-model="form.gender" placeholder="未填" clearable style="width: 100%">
            <el-option
              v-for="gender in STUDENT_GENDERS.filter((g) => g !== '')"
              :key="gender"
              :label="STUDENT_GENDER_LABELS[gender]"
              :value="gender"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="家长手机号">
          <el-input v-model="form.guardianPhone" placeholder="可选" />
        </el-form-item>
        <el-form-item label="班级">
          <el-select v-model="form.classId" placeholder="暂不分班" clearable style="width: 100%">
            <el-option v-for="item in classOptions" :key="item.id" :label="item.name" :value="item.id" />
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
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

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
