<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import {
  SOCKET_EVENTS,
  formatDate,
  type ClassDetailDto,
  type ClassDto,
  type CourseDto,
  type StudentDto,
  type UserDto,
} from '@classhelper/shared';
import { classApi, courseApi, teacherApi } from '@/api';
import { useAuthStore } from '@/stores/auth';
import { useRealtimeStore } from '@/stores/realtime';
import { useResponsive } from '@/composables/useResponsive';

const auth = useAuthStore();
const realtime = useRealtimeStore();
const { isMobile } = useResponsive();

/** 仅管理员可管理班级（增删改）与人员分配 —— 与后端权限矩阵一致 */
const isAdmin = computed(() => auth.role === 'ADMIN');

/** 小屏下详情描述改为单列，避免文字被压成竖排 */
const detailColumns = computed(() => (isMobile.value ? 1 : 3));

const loading = ref(false);
const classes = ref<ClassDto[]>([]);
const keyword = ref('');

async function loadClasses(): Promise<void> {
  loading.value = true;
  try {
    classes.value = await classApi.list(keyword.value ? { keyword: keyword.value } : undefined);
  } finally {
    loading.value = false;
  }
}

/* ------------------------------------------------------------ 新建 / 编辑班级 */

const formVisible = ref(false);
const formRef = ref<FormInstance>();
const editingId = ref<string | null>(null);
const form = reactive({ name: '', grade: '' });
const rules: FormRules = {
  name: [{ required: true, message: '请输入班级名称', trigger: 'blur' }],
  grade: [{ required: true, message: '请输入年级', trigger: 'blur' }],
};

function openCreate(): void {
  editingId.value = null;
  form.name = '';
  form.grade = '';
  formVisible.value = true;
}

function openEdit(row: ClassDto): void {
  editingId.value = row.id;
  form.name = row.name;
  form.grade = row.grade;
  formVisible.value = true;
}

async function submitForm(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;

  if (editingId.value) {
    await classApi.update(editingId.value, { name: form.name, grade: form.grade });
    ElMessage.success('班级已更新');
  } else {
    await classApi.create({ name: form.name, grade: form.grade });
    ElMessage.success('班级创建成功');
  }
  formVisible.value = false;
  await loadClasses();
}

async function removeClass(row: ClassDto): Promise<void> {
  await ElMessageBox.confirm(
    `删除「${row.name}」将同时删除其课表、作业、通知与成绩，确认继续？`,
    '危险操作',
    { type: 'warning', confirmButtonText: '确认删除' },
  );
  await classApi.remove(row.id);
  ElMessage.success('班级已删除');
  await loadClasses();
}

/* ------------------------------------------------------------ 班级详情抽屉 */

const detailVisible = ref(false);
const detailLoading = ref(false);
const detail = ref<ClassDetailDto | null>(null);
const activeTab = ref('students');

async function openDetail(row: ClassDto): Promise<void> {
  detailVisible.value = true;
  detailLoading.value = true;
  activeTab.value = 'students';
  try {
    detail.value = await classApi.detail(row.id);
  } finally {
    detailLoading.value = false;
  }
}

async function refreshDetail(): Promise<void> {
  if (!detail.value) return;
  detailLoading.value = true;
  try {
    detail.value = await classApi.detail(detail.value.id);
  } finally {
    detailLoading.value = false;
  }
}

/* ------------------------------------------------------------ 学生 */

const studentFormVisible = ref(false);
const studentForm = reactive({ username: '', name: '', password: '' });
const studentRules: FormRules = {
  username: [{ required: true, message: '请输入学号/用户名', trigger: 'blur' }],
  name: [{ required: true, message: '请输入姓名', trigger: 'blur' }],
};

async function addStudent(): Promise<void> {
  if (!detail.value) return;
  if (!studentForm.username.trim() || !studentForm.name.trim()) {
    ElMessage.warning('请填写用户名和姓名');
    return;
  }
  const created = await classApi.addStudent(detail.value.id, {
    username: studentForm.username.trim(),
    name: studentForm.name.trim(),
    ...(studentForm.password ? { password: studentForm.password } : {}),
  });
  ElMessage.success(`已加入学生：${created.name}`);
  studentFormVisible.value = false;
  studentForm.username = '';
  studentForm.name = '';
  studentForm.password = '';
  await refreshDetail();
  await loadClasses();
}

async function removeStudent(row: StudentDto): Promise<void> {
  if (!detail.value) return;
  await ElMessageBox.confirm(`将「${row.name}」移出本班级？`, '确认', { type: 'warning' });
  await classApi.removeStudent(detail.value.id, row.id);
  ElMessage.success('已移出班级');
  await refreshDetail();
  await loadClasses();
}

/* ------------------------------------------------------------ 课程 */

const courseForm = reactive({ name: '' });

async function addCourse(): Promise<void> {
  if (!detail.value || !courseForm.name.trim()) {
    ElMessage.warning('请输入课程名称');
    return;
  }
  await courseApi.create({ name: courseForm.name.trim(), classId: detail.value.id });
  ElMessage.success('课程已添加');
  courseForm.name = '';
  await refreshDetail();
}

async function removeCourse(row: CourseDto): Promise<void> {
  await ElMessageBox.confirm(`删除课程「${row.name}」？相关课表与作业关联会被清除。`, '确认', {
    type: 'warning',
  });
  await courseApi.remove(row.id);
  ElMessage.success('课程已删除');
  await refreshDetail();
}

/* ------------------------------------------------------------ 协作教师 */

const teachers = ref<UserDto[]>([]);
const selectedTeacherId = ref<string>('');

async function loadTeachers(): Promise<void> {
  teachers.value = await teacherApi.list();
}

async function assignTeacher(): Promise<void> {
  if (!detail.value || !selectedTeacherId.value) {
    ElMessage.warning('请选择教师');
    return;
  }
  await classApi.assignTeacher(detail.value.id, selectedTeacherId.value);
  ElMessage.success('教师已分配');
  selectedTeacherId.value = '';
  await refreshDetail();
}

async function removeTeacher(teacherId: string): Promise<void> {
  if (!detail.value) return;
  await classApi.removeTeacher(detail.value.id, teacherId);
  ElMessage.success('已取消分配');
  await refreshDetail();
}

/* ------------------------------------------------------------ 实时刷新 */

function onClassChanged(): void {
  void loadClasses();
  if (detailVisible.value) void refreshDetail();
}

onMounted(async () => {
  await Promise.all([loadClasses(), loadTeachers()]);
  realtime.on(SOCKET_EVENTS.classUpdated, onClassChanged);
  realtime.on(SOCKET_EVENTS.notificationNew, onClassChanged);
  realtime.on(SOCKET_EVENTS.homeworkNew, onClassChanged);
});

onUnmounted(() => {
  realtime.off(SOCKET_EVENTS.classUpdated, onClassChanged);
  realtime.off(SOCKET_EVENTS.notificationNew, onClassChanged);
  realtime.off(SOCKET_EVENTS.homeworkNew, onClassChanged);
});
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">班级管理</h2>
        <p class="page-subtitle">教师只能看到并管理自己创建或被分配的班级</p>
      </div>
      <div class="toolbar">
        <el-input
          v-model="keyword"
          placeholder="搜索班级名称 / 年级"
          clearable
          style="width: 220px"
          @keyup.enter="loadClasses"
          @clear="loadClasses"
        />
        <el-button :icon="'Search'" @click="loadClasses">查询</el-button>
        <el-button v-if="isAdmin" type="primary" :icon="'Plus'" @click="openCreate">新建班级</el-button>
      </div>
    </div>

    <el-card shadow="never" class="table-card">
      <el-table v-loading="loading" :data="classes" empty-text="暂无班级，点击右上角新建">
        <el-table-column prop="name" label="班级" min-width="140" />
        <el-table-column prop="grade" label="年级" width="100" />
        <el-table-column label="班主任" width="140">
          <template #default="{ row }">{{ row.teacher?.name ?? '-' }}</template>
        </el-table-column>
        <el-table-column label="学生" width="80">
          <template #default="{ row }">{{ row.studentCount ?? 0 }}</template>
        </el-table-column>
        <el-table-column label="课程" width="80">
          <template #default="{ row }">{{ row.courseCount ?? 0 }}</template>
        </el-table-column>
        <el-table-column label="作业" width="80">
          <template #default="{ row }">{{ row.homeworkCount ?? 0 }}</template>
        </el-table-column>
        <el-table-column label="通知" width="80">
          <template #default="{ row }">{{ row.notificationCount ?? 0 }}</template>
        </el-table-column>
        <el-table-column label="创建时间" width="170">
          <template #default="{ row }">{{ formatDate(row.createdAt, true) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="230" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openDetail(row)">详情</el-button>
            <el-button v-if="isAdmin" link type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button v-if="isAdmin" link type="danger" @click="removeClass(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 新建 / 编辑 -->
    <el-dialog v-model="formVisible" :title="editingId ? '编辑班级' : '新建班级'" width="420px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="80px">
        <el-form-item label="班级名称" prop="name">
          <el-input v-model="form.name" placeholder="例如 高一(1)班" />
        </el-form-item>
        <el-form-item label="年级" prop="grade">
          <el-input v-model="form.grade" placeholder="例如 高一" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="formVisible = false">取消</el-button>
        <el-button type="primary" @click="submitForm">保存</el-button>
      </template>
    </el-dialog>

    <!-- 班级详情 -->
    <el-drawer v-model="detailVisible" size="60%" :title="detail ? `${detail.name} · 详情` : '班级详情'">
      <div v-loading="detailLoading">
        <el-descriptions v-if="detail" :column="detailColumns" border size="small">
          <el-descriptions-item label="年级">{{ detail.grade }}</el-descriptions-item>
          <el-descriptions-item label="班主任">{{ detail.teacher?.name ?? '-' }}</el-descriptions-item>
          <el-descriptions-item label="学生数">{{ detail.students.length }}</el-descriptions-item>
        </el-descriptions>

        <el-tabs v-model="activeTab" class="mt-12">
          <el-tab-pane label="学生名单" name="students">
            <div class="toolbar mt-12">
              <el-button type="primary" size="small" :icon="'Plus'" @click="studentFormVisible = true">
                添加学生
              </el-button>
              <span class="text-muted">共 {{ detail?.students.length ?? 0 }} 人</span>
            </div>
            <el-table :data="detail?.students ?? []" size="small" class="mt-12" empty-text="暂无学生">
              <el-table-column prop="username" label="用户名" width="140" />
              <el-table-column prop="name" label="姓名" width="120" />
              <el-table-column label="加入时间" width="180">
                <template #default="{ row }">{{ formatDate(row.createdAt, true) }}</template>
              </el-table-column>
              <el-table-column label="操作" width="90">
                <template #default="{ row }">
                  <el-button link type="danger" @click="removeStudent(row)">移出</el-button>
                </template>
              </el-table-column>
            </el-table>
          </el-tab-pane>

          <el-tab-pane label="课程" name="courses">
            <el-table :data="detail?.courses ?? []" size="small" class="mt-12" empty-text="暂无课程">
              <el-table-column prop="name" label="课程" min-width="140" />
              <el-table-column label="任课教师" width="140">
                <template #default="{ row }">{{ row.teacher?.name ?? '-' }}</template>
              </el-table-column>
              <el-table-column label="操作" width="90">
                <template #default="{ row }">
                  <el-button link type="danger" @click="removeCourse(row)">删除</el-button>
                </template>
              </el-table-column>
            </el-table>
            <el-input
              v-model="courseForm.name"
              placeholder="输入课程名称后回车快速添加"
              class="mt-12"
              @keyup.enter="addCourse"
            />
          </el-tab-pane>

          <el-tab-pane label="协作教师" name="teachers">
            <el-table :data="detail?.teachers ?? []" size="small" class="mt-12" empty-text="暂无协作教师">
              <el-table-column prop="name" label="姓名" width="140" />
              <el-table-column prop="username" label="用户名" width="140" />
              <el-table-column label="操作" width="110">
                <template #default="{ row }">
                  <el-button link type="danger" @click="removeTeacher(row.id)">取消分配</el-button>
                </template>
              </el-table-column>
            </el-table>
            <div class="toolbar mt-12">
              <el-select v-model="selectedTeacherId" placeholder="选择教师" style="width: 220px" filterable>
                <el-option
                  v-for="item in teachers"
                  :key="item.id"
                  :label="`${item.name}（${item.username}）`"
                  :value="item.id"
                />
              </el-select>
              <el-button type="primary" @click="assignTeacher">分配</el-button>
            </div>
          </el-tab-pane>
        </el-tabs>
      </div>
    </el-drawer>

    <!-- 添加学生 -->
    <el-dialog v-model="studentFormVisible" title="添加学生到本班" width="440px">
      <el-form :model="studentForm" :rules="studentRules" label-width="90px">
        <el-form-item label="用户名" prop="username">
          <el-input v-model="studentForm.username" placeholder="学号或登录名，已存在则直接转入本班" />
        </el-form-item>
        <el-form-item label="姓名" prop="name">
          <el-input v-model="studentForm.name" />
        </el-form-item>
        <el-form-item label="初始密码">
          <el-input v-model="studentForm.password" placeholder="留空则使用默认密码" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="studentFormVisible = false">取消</el-button>
        <el-button type="primary" @click="addStudent">确认添加</el-button>
      </template>
    </el-dialog>
  </div>
</template>
